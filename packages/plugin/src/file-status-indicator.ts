import type { FolderMapping } from './folder-mapping';
import type { DocSyncState } from './multiplexed-provider';
import type { TrackedDoc } from './content-sync';
import { describeStatus, fileSyncStatus, type FileSyncStatus } from './sync-status';
import type { TimerHandle } from './timers';
import { kindOf } from './blob-policy';

/** Everything the per-file icons read. Live reads, never cached state. */
export interface FileStatusDeps {
  mappings(): FolderMapping[];
  /** Every document the content engine holds, placed or not. */
  trackedDocs(): TrackedDoc[];
  /** The provider's view of one document; null when not subscribed. */
  docSyncState(docName: string): DocSyncState | null;
  /** The setting. Off means no icon anywhere. */
  enabled(): boolean;
}

export interface FileStatusView {
  status: FileSyncStatus;
  label: string;
}

/**
 * Which files get an icon, and which one, for one read of the engine's state.
 *
 * Only `.md` files inside a shared folder: those are the files `ContentSync`
 * owns. Attachments sync through a different engine with no per-file state to
 * report yet, and a note outside every shared folder is not Nectenda's to
 * describe. A Markdown file in a shared folder with no document is `untracked`
 * rather than skipped, because "this note is not syncing" is the answer the
 * icon exists to give.
 */
export function buildStatusIndex(deps: Pick<FileStatusDeps, 'mappings' | 'trackedDocs' | 'docSyncState'>): (path: string) => FileStatusView | null {
  const roots = deps.mappings().map((m) => m.localPath);
  const byPath = new Map<string, TrackedDoc>();
  for (const d of deps.trackedDocs()) byPath.set(d.localPath, d);
  return (path: string) => {
    if (!path.endsWith('.md')) return null;
    if (!roots.some((r) => path.startsWith(`${r}/`))) return null;
    const doc = byPath.get(path);
    const state = doc?.placed ? deps.docSyncState(doc.docName) : null;
    const status = fileSyncStatus(state, doc?.hasSyncedOnce ?? false);
    return { status, label: describeStatus(status, state) };
  };
}

/**
 * What a shared file's mark in a Bases view says: the explorer's status for a
 * note, the same status for a canvas or base from its own document, and
 * `attachment` for anything else in a shared folder. Attachments sync through
 * the blob engine, which has no per-file state yet, so their mark says only
 * "shared" — calling one confirmed would be a claim nothing has checked.
 */
export type EntryStatus = FileSyncStatus | 'attachment';

export function buildEntryStatus(
  deps: Pick<FileStatusDeps, 'mappings' | 'trackedDocs' | 'docSyncState'> & {
    /** The document a connected canvas or base is bound to; null when it has none yet. */
    structuredDocName(path: string): string | null;
  },
): (path: string) => EntryStatus | null {
  const notes = buildStatusIndex(deps);
  const roots = deps.mappings().map((m) => m.localPath);
  return (path: string) => {
    if (!roots.some((r) => path.startsWith(`${r}/`))) return null;
    switch (kindOf(path)) {
      case 'text': return notes(path)?.status ?? null;
      case 'structured': {
        const docName = deps.structuredDocName(path);
        return fileSyncStatus(docName ? deps.docSyncState(docName) : null);
      }
      case 'blob': return 'attachment';
      default: return null;
    }
  };
}

const ICON_CLASS = 'nectenda-file-status';
const STATUS_CLASSES: Record<FileSyncStatus, string> = {
  confirmed: 'nectenda-file-confirmed',
  sending: 'nectenda-file-sending',
  offline: 'nectenda-file-offline',
  untracked: 'nectenda-file-untracked',
  error: 'nectenda-file-error',
};

/**
 * A small status mark on each note in a shared folder, in the file explorer.
 *
 * Same approach as `FolderIndicator`: a MutationObserver re-applies after the
 * explorer re-renders. The mark is a child element rather than a class and a
 * label on the row itself, because the row's own tooltip and attributes are
 * Obsidian's.
 *
 * Idempotent on purpose. The observer sees this class's own insertions, so an
 * apply that always wrote would trigger the next one forever; one that writes
 * only what differs settles after one pass.
 */
export class FileStatusIndicator {
  private observer: MutationObserver | null = null;
  private timer: TimerHandle | null = null;
  private running = false;

  constructor(private deps: FileStatusDeps, private debounceMs = 250) {}

  private observed: Element | null = null;

  start(): void {
    this.running = true;
    this.observer = new MutationObserver(() => this.refresh());
    this.apply();
  }

  /**
   * The explorer may not exist yet when sync starts — before the layout is
   * ready — and can be closed and reopened, which replaces its container. So
   * the observer is (re)attached on every apply rather than once at start.
   */
  private observeExplorer(): void {
    const explorer = document.querySelector('.nav-files-container');
    if (!this.observer || !explorer || explorer === this.observed) return;
    this.observer.disconnect();
    this.observer.observe(explorer, { childList: true, subtree: true });
    this.observed = explorer;
  }

  stop(): void {
    this.running = false;
    this.observer?.disconnect();
    this.observer = null;
    this.observed = null;
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = null;
    this.clear();
  }

  /**
   * Coalesced: the provider reports on every keystroke, and redrawing the
   * explorer that often is work nobody can see.
   */
  refresh(): void {
    // After stop, a late redraw would put back every mark stop just removed.
    if (!this.running || this.timer) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.apply();
    }, this.debounceMs);
  }

  /** Synchronous, for teardown and tests. */
  apply(): void {
    this.observeExplorer();
    if (!this.deps.enabled()) {
      this.clear();
      return;
    }
    const statusOf = buildStatusIndex(this.deps);
    // Typed as HTMLElement so `createSpan` is available below: Obsidian's
    // helpers are augmented onto HTMLElement, and a bare querySelectorAll
    // yields Element. That typing is the only reason this file used
    // `document.createElement` where header-status.ts already used createSpan.
    for (const title of Array.from(document.querySelectorAll<HTMLElement>('.nav-file-title'))) {
      const path = title.getAttribute('data-path');
      const view = path ? statusOf(path) : null;
      const existing = title.querySelector(`.${ICON_CLASS}`);
      if (!view) {
        existing?.remove();
        continue;
      }
      const wanted = `${ICON_CLASS} ${STATUS_CLASSES[view.status]}`;
      let icon = existing;
      if (!icon) icon = title.createSpan();
      // Written only when it differs, deliberately: this runs from a
      // MutationObserver over the file explorer, and an unconditional write
      // would retrigger it forever.
      if (icon.getAttribute('class') !== wanted) icon.setAttribute('class', wanted);
      if (icon.getAttribute('aria-label') !== view.label) icon.setAttribute('aria-label', view.label);
    }
  }

  private clear(): void {
    for (const el of Array.from(document.querySelectorAll(`.${ICON_CLASS}`))) el.remove();
  }
}
