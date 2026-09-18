import { log } from './logger';

/**
 * What this device has learned about its own limits, kept across a crash.
 *
 * ## Why this is not settings
 *
 * The thing being recorded is *that we died*, so it has to be on disk **before**
 * the dangerous work begins and it has to survive a process being killed
 * outright — no unload handler, no flush, no warning. That rules out most of
 * the obvious places:
 *
 * - `saveData()` shares data.json with everything else, so a torn write would
 *   take the folder keys and mappings with it.
 * - `app.saveLocalStorage` is synchronous, which is not the same as durable:
 *   WebKit may hold it in memory and flush later, and "later" does not happen
 *   when jetsam kills the process.
 * - An **awaited file write** does survive. Once the write resolves the bytes
 *   are in the OS page cache, and killing a process does not empty that. Only
 *   losing power would.
 *
 * So this is its own small file, written whole and moved into place with a
 * rename, which is the same discipline the server uses for blobs: a crash
 * during the write leaves the previous state intact rather than a half-parsed
 * one.
 *
 * ## Why it is keyed by device
 *
 * The file lives in the vault, so a vault synced through Dropbox or iCloud
 * carries it to other machines. What it records — "this device could not open
 * that file" — is true of one device and false of the next. Keying by the
 * device id minted in Stage 0 means a synced copy is inert on every device but
 * the one that wrote it.
 */

/** Nothing below this is plausibly a memory kill, so it teaches us nothing. */
const LEARNING_FLOOR_BYTES = 16 * 1024 * 1024;

/** Learn conservatively: the next ceiling sits below what actually failed. */
const SHRINK_FACTOR = 0.8;

export interface AttemptRecord {
  folderId: string;
  relativePath: string;
  bytes: number;
  startedAt: number;
}

export interface SkippedRecord {
  bytes: number;
  /** How many times opening this attachment has killed the app. */
  failures: number;
  /** True when the user chose to skip rather than the app having crashed. */
  declined: boolean;
  at: number;
}

export interface DeviceState {
  /** Largest attachment this device is willing to open without asking. */
  budgetBytes: number;
  /** Set while a large transfer is in flight; a survivor means we died doing it. */
  attempt: AttemptRecord | null;
  /** Keyed by `folderId/relativePath`. */
  skipped: Record<string, SkippedRecord>;
}

const emptyState = (budget: number): DeviceState => ({
  budgetBytes: budget,
  attempt: null,
  skipped: {},
});

export interface StateFile {
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
}

export class DeviceStateStore {
  private io: StateFile;
  private path: string;
  private deviceId: string;
  private state: DeviceState;
  /** Serialises writes; two saves racing would lose one of them. */
  private chain: Promise<void> = Promise.resolve();

  private constructor(io: StateFile, path: string, deviceId: string, state: DeviceState) {
    this.io = io;
    this.path = path;
    this.deviceId = deviceId;
    this.state = state;
  }

  static async open(
    io: StateFile,
    path: string,
    deviceId: string,
    defaultBudget: number,
  ): Promise<DeviceStateStore> {
    let all: Record<string, DeviceState> = {};
    try {
      if (await io.exists(path)) all = JSON.parse(await io.read(path)) as Record<string, DeviceState>;
    } catch (err) {
      // A corrupt file costs this device its learning and nothing else, so it
      // is started over rather than treated as fatal.
      log.warn('Device state unreadable; starting fresh', { error: String(err) });
      all = {};
    }
    const mine = all[deviceId];
    const state: DeviceState = {
      budgetBytes: typeof mine?.budgetBytes === 'number' && mine.budgetBytes > 0
        ? mine.budgetBytes : defaultBudget,
      attempt: mine?.attempt ?? null,
      skipped: mine?.skipped ?? {},
    };
    return new DeviceStateStore(io, path, deviceId, state);
  }

  get budgetBytes(): number {
    return this.state.budgetBytes;
  }

  /**
   * Whatever was in flight when the app last stopped.
   *
   * Non-null means the app did not shut down cleanly during that transfer,
   * because a clean shutdown clears it. That is evidence rather than proof —
   * a force-quit looks identical — which is why acting on it is bounded by
   * `LEARNING_FLOOR_BYTES` and why the result is always recoverable by the user.
   */
  get unfinishedAttempt(): AttemptRecord | null {
    return this.state.attempt;
  }

  key(folderId: string, relativePath: string): string {
    return `${folderId}/${relativePath}`;
  }

  isSkipped(folderId: string, relativePath: string): boolean {
    return this.state.skipped[this.key(folderId, relativePath)] !== undefined;
  }

  skippedEntries(): Array<[string, SkippedRecord]> {
    return Object.entries(this.state.skipped);
  }

  /** Record what we are about to attempt, and do not return until it is on disk. */
  async beginAttempt(folderId: string, relativePath: string, bytes: number): Promise<void> {
    this.state.attempt = { folderId, relativePath, bytes, startedAt: Date.now() };
    await this.save();
  }

  /**
   * The attempt finished — successfully, or with an error we caught.
   *
   * Either way the app is still running, so it was not killed, and the
   * breadcrumb must go before it is mistaken for a crash next launch.
   */
  async endAttempt(): Promise<void> {
    if (!this.state.attempt) return;
    this.state.attempt = null;
    await this.save();
  }

  /**
   * Turn a surviving breadcrumb into a lower ceiling and a skipped file.
   *
   * Only for attempts big enough to plausibly be a memory kill. Below that a
   * crash says nothing about size, and shrinking the budget on unrelated
   * failures would slowly refuse everything.
   */
  async learnFromCrash(attempt: AttemptRecord): Promise<boolean> {
    this.state.attempt = null;
    if (attempt.bytes < LEARNING_FLOOR_BYTES) {
      await this.save();
      return false;
    }

    const key = this.key(attempt.folderId, attempt.relativePath);
    const prior = this.state.skipped[key];
    this.state.skipped[key] = {
      bytes: attempt.bytes,
      failures: (prior?.failures ?? 0) + 1,
      declined: false,
      at: Date.now(),
    };
    this.state.budgetBytes = Math.max(
      LEARNING_FLOOR_BYTES,
      Math.min(this.state.budgetBytes, Math.floor(attempt.bytes * SHRINK_FACTOR)),
    );
    await this.save();
    log.warn('Lowered this device attachment budget after a crash', {
      failedBytes: attempt.bytes, budgetBytes: this.state.budgetBytes,
    });
    return true;
  }

  /**
   * This device opened an attachment of this size and lived.
   *
   * The budget learns in both directions, and this is the upward one. Without
   * it a user who agrees to a large file is asked about it again on every
   * launch, because consenting is not evidence — surviving is. Agreeing to
   * something that then crashes must not raise the ceiling.
   */
  async recordSuccess(bytes: number): Promise<void> {
    if (bytes <= this.state.budgetBytes) return;
    this.state.budgetBytes = bytes;
    await this.save();
  }

  /** The user was asked and said no. Distinct from a crash: nothing is learned. */
  async decline(folderId: string, relativePath: string, bytes: number): Promise<void> {
    this.state.skipped[this.key(folderId, relativePath)] = {
      bytes, failures: 0, declined: true, at: Date.now(),
    };
    await this.save();
  }

  /**
   * Forget a decision so the attachment is tried again.
   *
   * Raises the budget back above the file if it had been lowered below it —
   * otherwise "retry" would silently ask again every time, which is not a retry.
   */
  async retry(folderId: string, relativePath: string): Promise<void> {
    const key = this.key(folderId, relativePath);
    const record = this.state.skipped[key];
    delete this.state.skipped[key];
    if (record && record.bytes > this.state.budgetBytes) {
      this.state.budgetBytes = record.bytes;
    }
    await this.save();
  }

  /** Written whole, then renamed into place, so a crash cannot tear it. */
  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.state);
    this.chain = this.chain.then(async () => {
      let all: Record<string, unknown> = {};
      try {
        if (await this.io.exists(this.path)) {
          all = JSON.parse(await this.io.read(this.path)) as Record<string, unknown>;
        }
      } catch {
        all = {};
      }
      all[this.deviceId] = JSON.parse(snapshot) as unknown;

      const tmp = `${this.path}.tmp`;
      await this.io.write(tmp, JSON.stringify(all));
      if (await this.io.exists(this.path)) await this.io.remove(this.path);
      await this.io.rename(tmp, this.path);
    }).catch((err) => {
      // Losing the record costs this device its learning; it must never take
      // down the operation it was recording.
      log.error('Could not persist device state', { error: String(err) });
    });
    return this.chain;
  }
}

export { LEARNING_FLOOR_BYTES, SHRINK_FACTOR, emptyState };
