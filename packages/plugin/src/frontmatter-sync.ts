import * as Y from 'yjs';
import { digest } from 'lib0/hash/sha256';
import { projectFrontmatter, readFrontmatter, rebuildFrontmatter, sameValue, type Reading } from './frontmatter-block';
import { SEED_CLIENT_ID_BASE } from './seed-update';
import { madeOnTopOf } from './structured-sync';
import { log } from './logger';

/**
 * A note's properties, merged per property rather than per character.
 *
 * A note's document holds its whole file in `Y.Text('content')`, frontmatter
 * included, and that does not change: the editor binding maps CodeMirror onto
 * it one to one, seeds hash it, and older clients read nothing else. Character
 * merging is right for prose and wrong for a property. Two vaults setting
 * `status` to `doing` and to `done` at once get `doingdone`, which parses and
 * is a value nobody chose. Two adding one key at once get it twice, which does
 * not parse, and Obsidian then shows no properties at all.
 *
 * So the document gains a second root, `Y.Map('frontmatter')`: property name to
 * value. **The text still holds the file. The map decides what the properties
 * are.**
 *
 * ## One direction at a time
 *
 * Two roots that each write the other is how this goes wrong. Another
 * implementation of this design had a deleted field written back from its map,
 * two vaults repairing at once doubled a line, and a block grew without bound.
 * So every transaction moves information one way, decided by where it came
 * from:
 *
 * - **A local edit** (the editor, our own read of a changed file, Obsidian's
 *   `processFrontMatter`) is *captured*: the properties it changed go to the
 *   map, in the same synchronous turn, so both leave in one provider flush.
 *   Only when the block parses; someone mid-typing is left alone. Capture
 *   never writes text.
 * - **A remote change** is *reconciled*. A client that writes the map writes
 *   text and map together and prunes the map as it removes, so once one has
 *   touched the note the map is right, keys and values both, and the text is
 *   *projected* to say exactly what the map says. Properties no such client
 *   touched were changed by an older client, which edits the text alone; for
 *   those the text is right, and the map *adopts* it. Projection never writes
 *   the map.
 *
 * A projection makes the text equal the map, so the capture its own
 * transaction would trigger finds nothing to write.
 *
 * ## Why projections settle
 *
 * Every vault that receives a change may project it, and two projecting at
 * once from different states can cross: the merge holds both of their writes.
 * What makes that settle is that **what** a projection writes depends on
 * nothing but the document. It is computed from the text and the map alone,
 * and authored under an identity derived from the edit itself
 * (`deriveProjectionClientId`). Two vaults holding the same document that both
 * project make the same edit as the same struct, and Yjs keeps one.
 *
 * **Whether** a vault projects, adopts or prunes does depend on what it has
 * seen (`touched`, `agreed`, and the remembered closing delimiter), so vaults
 * can act differently for a round. That is safe as long as nothing they
 * remember can change the content of an edit, only whether it is made: an
 * earlier version remembered where the delimiters were and let that decide
 * what was rewritten, and two vaults rewrote each other's projections
 * indefinitely. This is defended by test, a three-vault property test over
 * random edits, deliveries and client ids, not by proof.
 *
 * ## Gated on sync
 *
 * Projection, adoption and the first fill of an empty map need the document to
 * have synced, and to be synced now. A vault catching up holds text that has not
 * met everyone else's yet, and acting on it is how a reconnecting vault
 * reverts other people's edits.
 *
 * ## A value that loses
 *
 * Two vaults writing one property at once keep one value, chosen by Yjs and
 * reported to nobody. The vault whose value lost keeps a conflict copy of the
 * note holding it (SAFE-A14, applied to properties). No property is exempt: a
 * Kanban lane is a property, and the copy is a note carrying the other lane, so
 * it shows up on the board where people are looking. A rewrite that replaces
 * text the map does not hold (a comment, a value an older client wrote at the
 * same moment, half a value someone was typing) backs the note up first.
 */

export const FRONTMATTER_ROOT = 'frontmatter';
export const FRONTMATTER_META_ROOT = 'frontmatterMeta';
/** What this build writes. A document stamped newer is left alone. */
export const FRONTMATTER_VERSION = 1;

/** A projection. Sent like local work. */
export const PROJECTION_ORIGIN = 'frontmatter-projection';
/** Map writes from capture, adoption and fill. Sent like local work. */
export const CAPTURE_ORIGIN = 'frontmatter-capture';
/** What the provider tags a remote update with. */
const REMOTE_ORIGIN = 'remote';

/** What a note's frontmatter needs from the sync around it. */
export interface FrontmatterHost {
  docName: string;
  /** For messages. */
  relativePath: string;
  /** The document has synced at least once, and is synced now. */
  isSynced(): boolean;
  /** Keep `text` beside the note as a conflict copy. */
  keepConflictCopy(text: string): void;
  /** Keep `text` in the backups folder before it is rewritten. */
  backup(text: string, reason: string): void;
  /** Tell the user something. */
  notify(message: string): void;
  /** Client ids this vault has written the map under before. */
  loadClients?(): Promise<number[]>;
  /** Replace that record with `ids`. Rejects when it could not be written. */
  saveClients?(ids: number[]): Promise<void>;
}

type Values = Record<string, unknown>;

/**
 * A map value a remote update discarded without having seen it, taken down in
 * the transaction that discarded it. Yjs collects a deleted entry's content
 * once the transaction ends, so the value has to be read then, even when
 * whether it was ours can only be decided later.
 */
interface LostCandidate {
  key: string;
  client: number;
  value: unknown;
}

/** The note's properties as Obsidian would read them, or null when it would read none. */
function valuesOf(reading: Reading): Values | null {
  // `stranded` is not `none`: the properties are all there, behind characters
  // typed or left in front of the opening `---`. Read as "every property
  // removed", one typed character emptied the map and a concurrent change
  // then wrote the empty set over everyone's properties.
  if (reading.kind === 'none') return {};
  if (reading.kind === 'read') return reading.values;
  return null;
}

/**
 * The keys of `type` a transaction changed, or undefined if it did not change
 * `type`. `Transaction.changed` is keyed by the abstract type, which neither
 * `Y.Text` nor `Y.Map` is assignable to without a cast; asking by identity
 * needs none.
 */
function changedIn(tr: Y.Transaction, type: object): Set<string | null> | undefined {
  return (tr.changed as Map<object, Set<string | null>>).get(type);
}

/** Whether `values` says exactly what `wanted` says: the same keys, equal values. */
function agrees(values: Values, wanted: ReadonlyMap<string, unknown>): boolean {
  const keys = Object.keys(values);
  return keys.length === wanted.size && keys.every((k) => wanted.has(k) && sameValue(values[k], wanted.get(k)));
}

/** Whether two sets of properties have the same names. */
function sameKeys(values: Values, wanted: ReadonlyMap<string, unknown>): boolean {
  const keys = Object.keys(values);
  return keys.length === wanted.size && keys.every((k) => wanted.has(k));
}

/**
 * The identity a projection gets in any vault: derived from the edit itself
 * (the characters it removes, the characters either side of where it writes,
 * and what it writes), so two vaults making the same edit author the same
 * struct and Yjs keeps one.
 *
 * Not from the document's state vector, which is what the first version used.
 * That made the same edit from two different states two structs, and the text
 * held the value twice.
 */
export function deriveProjectionClientId(docName: string, signature: string): number {
  const hash = digest(new TextEncoder().encode(`${docName}\u0000frontmatter\u0000${signature}`));
  let n = 0;
  for (let i = 0; i < 6; i++) n = n * 256 + hash[i];
  return SEED_CLIENT_ID_BASE + n;
}

/** The Yjs identity of each visible character of `ytext` in `[from, to)`, as `client:clock`. */
function charIds(ytext: Y.Text, from: number, to: number): string[] {
  const ids: string[] = [];
  let index = 0;
  for (let item = ytext._start; item && index < to; item = item.right) {
    if (item.deleted || !item.countable) continue;
    for (let k = 0; k < item.length && index < to; k++, index++) {
      if (index >= from) ids.push(`${item.id.client}:${item.id.clock + k}`);
    }
  }
  return ids;
}

/**
 * The edit turning `before` into `after`, as one replaced run: the common
 * start and end are left alone, so characters nobody changed keep their ids
 * and concurrent edits around them still merge.
 */
function oneHunk(before: string, after: string): { at: number; remove: number; insert: string } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start && end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) end++;
  return { at: start, remove: before.length - start - end, insert: after.slice(start, after.length - end) };
}

export class FrontmatterSync {
  private readonly map: Y.Map<unknown>;
  private readonly meta: Y.Map<unknown>;
  /**
   * Per property, the value text and map last agreed on here. Used only to
   * tell an older client's edit (the text moved, the map did not) from a text
   * merge the map is settling; never to decide what a projection writes.
   */
  private readonly agreed = new Map<string, unknown>();
  /** The properties as the text last parsed, so a capture writes only what changed. */
  private lastValues: Values | null = null;
  private readonly ourClients = new Set<number>();
  private readonly recordedClients = new Set<number>();
  /**
   * Whether the ids this vault wrote under in earlier sessions are known yet.
   * Until they are, a discarded value cannot be told to be ours, so it waits
   * in `pendingLost` rather than being judged against half a history. When
   * they cannot be read at all, every discarded value is kept: a stray copy
   * is clutter, a missed one is someone's edit.
   */
  private history: 'loading' | 'loaded' | 'unreadable' = 'loading';
  private historyLoaded: Promise<void> = Promise.resolve();
  private pendingLost: LostCandidate[] = [];
  /** Saves of the id record, one after another, so two never interleave. */
  private saving: Promise<void> = Promise.resolve();
  private noticeShown = false;
  /**
   * Properties a map-writing client changed in remote updates not yet
   * reconciled, its value kept or not. Gathered across a catch-up, so a vault
   * that was offline knows which merged values the map settles.
   */
  private readonly touched = new Set<string>();
  /**
   * The characters that were the block's closing `---` when it last read, by
   * identity. Decides only whether a block whose delimiter a merge has glued
   * text onto can be rebuilt, never what the rebuild writes: a vault that does
   * not know them refuses, and one that does writes what any vault would.
   */
  private closing: Y.RelativePosition | null = null;
  /** A projection from another vault arrived since the last reconcile. */
  private projectionArrived = false;
  /** A map-writing client wrote since the last reconcile, whether or not any value changed here. */
  private mapWriterActed = false;
  private readonly onTransaction = (tr: Y.Transaction): void => this.handle(tr);
  private attached = false;

  constructor(
    private readonly ydoc: Y.Doc,
    private readonly ytext: Y.Text,
    private readonly host: FrontmatterHost,
  ) {
    this.map = ydoc.getMap(FRONTMATTER_ROOT);
    this.meta = ydoc.getMap(FRONTMATTER_META_ROOT);
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.ydoc.on('afterTransaction', this.onTransaction);
    this.rebase();
    if (this.history === 'loading') this.historyLoaded = this.loadHistory();
  }

  /**
   * Read which ids this vault wrote the map under before, then judge whatever
   * was discarded while that was being read.
   *
   * The observer is already attached, and the note already subscribed, when
   * this starts, so a remote update can land first. Judged then, a value from
   * an earlier session would read as someone else's and be dropped with no
   * copy, which is why it waits instead.
   */
  private async loadHistory(): Promise<void> {
    if (!this.host.loadClients) {
      this.history = 'loaded';
      return;
    }
    try {
      const ids = await this.host.loadClients();
      for (const id of ids) { this.ourClients.add(id); this.recordedClients.add(id); }
      this.history = 'loaded';
    } catch (err) {
      log.warn('Could not read which property edits were made here — keeping every discarded value as a conflict copy', {
        path: this.host.relativePath, error: String(err),
      });
      this.history = 'unreadable';
    }
    const pending = this.pendingLost;
    this.pendingLost = [];
    // Caught here, not left to reject `historyLoaded`: every save of the id
    // record waits on that promise, and one rejection would stop them all.
    try {
      this.keepIfOurs(pending);
    } catch (err) {
      log.error('Could not keep a discarded property value as a conflict copy', {
        path: this.host.relativePath, properties: pending.map((c) => c.key), error: String(err),
      });
    }
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.ydoc.off('afterTransaction', this.onTransaction);
  }

  /**
   * Bring the map in line once the document is synced: fill an empty map,
   * adopt or project what moved while it was catching up. Called by the host
   * whenever the provider reports the document synced.
   */
  onSynced(): void {
    if (!this.attached || !this.host.isSynced()) return;
    this.reconcile();
  }

  private handle(tr: Y.Transaction): void {
    const textChanged = changedIn(tr, this.ytext) !== undefined;
    const mapChanged = changedIn(tr, this.map) !== undefined || changedIn(tr, this.meta) !== undefined;
    if (!textChanged && !mapChanged) return;
    if (tr.origin === CAPTURE_ORIGIN) return;
    if (tr.origin === PROJECTION_ORIGIN) {
      this.rebase();
      return;
    }
    if (tr.local) {
      if (textChanged) this.capture();
      return;
    }
    if (tr.origin === REMOTE_ORIGIN) {
      if (mapChanged) this.keepLostValues(tr);
      for (const key of changedIn(tr, this.map) ?? []) {
        if (key !== null) this.touched.add(key);
      }
      if (changedIn(tr, this.meta)?.has('wrote')) this.mapWriterActed = true;
      for (const [client, clock] of tr.afterState) {
        if (client >= SEED_CLIENT_ID_BASE && (tr.beforeState.get(client) ?? 0) < clock) this.projectionArrived = true;
      }
      if (this.host.isSynced()) this.reconcile();
    }
    // Whatever arrived from elsewhere (a remote change, a restore from
    // IndexedDB, a seed) is nobody's edit here. Read it as the new base, so the
    // next capture writes only what is typed after it.
    this.rebase();
  }

  /** Remember what the text says now and where text and map agree, changing neither. */
  private rebase(): void {
    const reading = readFrontmatter(this.ytext.toString());
    this.rememberClosing(reading);
    const values = valuesOf(reading);
    if (values === null) return;
    this.lastValues = values;
    for (const [key, value] of Object.entries(values)) {
      if (this.map.has(key) && sameValue(this.map.get(key), value)) this.agreed.set(key, value);
    }
  }

  private rememberClosing(reading: Reading): void {
    if (reading.kind === 'read') this.closing = Y.createRelativePositionFromTypeIndex(this.ytext, reading.block.to);
  }

  /** Where the remembered closing `---` is now, if its characters still exist. */
  private knownClosingAt(): number | undefined {
    if (!this.closing?.item) return undefined;
    const item = Y.getItem(this.ydoc.store, this.closing.item);
    if (!(item instanceof Y.Item) || item.deleted) return undefined;
    const abs: Y.AbsolutePosition | null = Y.createAbsolutePositionFromRelativePosition(this.closing, this.ydoc);
    return abs?.index;
  }

  private newerVersion(): boolean {
    const v = this.meta.get('version');
    return typeof v === 'number' && v > FRONTMATTER_VERSION;
  }

  /** The capture of a local edit: what changed in the text goes to the map. */
  private capture(): void {
    if (this.newerVersion()) return;
    const reading = readFrontmatter(this.ytext.toString());
    this.rememberClosing(reading);
    const values = valuesOf(reading);
    // Mid-typing, or a block nobody can read: nothing to say about any
    // property yet. The last good reading stays the base for the next one.
    if (values === null) return;
    // No good reading yet (the note did not parse when this attached): the
    // map is the base, so the first fix is written rather than ignored and
    // then reverted by the next projection.
    const before = this.lastValues ?? Object.fromEntries(this.map.entries());
    this.lastValues = values;

    const set: Values = {};
    const removed: string[] = [];
    for (const [key, value] of Object.entries(values)) {
      if (key in before && sameValue(before[key], value)) continue;
      if (this.map.has(key) && sameValue(this.map.get(key), value)) continue;
      set[key] = value;
    }
    for (const key of Object.keys(before)) {
      if (!(key in values) && this.map.has(key)) removed.push(key);
    }
    if (Object.keys(set).length === 0 && removed.length === 0) return;
    this.writeMap(set, removed);
  }

  private writeMap(set: Values, removed: string[]): void {
    this.ydoc.transact(() => {
      if (!this.meta.has('version')) this.meta.set('version', FRONTMATTER_VERSION);
      // Stamped on every write, so a vault receiving it knows a map-writing
      // client acted even when the write changes nothing there: removing a
      // value that had already lost to a concurrent one is a no-op on arrival,
      // and its text edit would otherwise read as an older client's.
      this.meta.set('wrote', this.ydoc.clientID);
      for (const [key, value] of Object.entries(set)) this.map.set(key, value);
      for (const key of removed) this.map.delete(key);
    }, CAPTURE_ORIGIN);
    for (const [key, value] of Object.entries(set)) this.agreed.set(key, value);
    for (const key of removed) this.agreed.delete(key);
    this.recordOurClient();
  }

  /**
   * Remember the id this vault writes the map under. Read on every write
   * rather than once: Yjs replaces a document's id itself when it finds it in
   * use elsewhere, and writes under the new one are just as much this vault's.
   */
  private recordOurClient(): void {
    const id = this.ydoc.clientID;
    this.ourClients.add(id);
    if (this.recordedClients.has(id)) return;
    const save = this.host.saveClients?.bind(this.host);
    if (!save) return;
    this.recordedClients.add(id);
    this.saving = this.saving.then(() => this.saveHistory(id, save));
  }

  /**
   * Write the record of our ids, with `id` in it.
   *
   * Only after the earlier sessions' ids have been read: the record is
   * replaced whole, so a save made before then would hold this session's id
   * alone and erase every earlier one. A record that could not be read is
   * read again first, and left alone if it still cannot be, for the same
   * reason. A save that does not happen forgets `id`, so the next write
   * tries again.
   */
  private async saveHistory(id: number, save: (ids: number[]) => Promise<void>): Promise<void> {
    await this.historyLoaded;
    if (this.history === 'unreadable') {
      try {
        const ids = await this.host.loadClients?.() ?? [];
        for (const known of ids) { this.ourClients.add(known); this.recordedClients.add(known); }
        this.history = 'loaded';
      } catch (err) {
        this.recordedClients.delete(id);
        log.warn('Could not record that this vault edited a note\'s properties: its earlier record cannot be read', {
          path: this.host.relativePath, error: String(err),
        });
        return;
      }
    }
    try {
      await save([...this.ourClients]);
    } catch (err) {
      this.recordedClients.delete(id);
      log.warn('Could not record that this vault edited a note\'s properties', {
        path: this.host.relativePath, error: String(err),
      });
    }
  }

  /**
   * A remote update that overwrote a value this vault wrote, without having
   * seen it, keeps this vault's version as a conflict copy.
   *
   * Decided by what the winning value was written on top of, which travels
   * with it, never by the update's delete set (see `madeOnTopOf`). An equal
   * value lost nothing: two vaults filling one map from one file.
   *
   * Every discarded value is taken down here, whoever wrote it; whether it
   * was ours is decided in `keepIfOurs`, which may have to wait for the
   * history to load.
   */
  private keepLostValues(tr: Y.Transaction): void {
    const candidates: LostCandidate[] = [];
    Y.iterateDeletedStructs(tr, tr.deleteSet, (struct) => {
      if (!(struct instanceof Y.Item)) return;
      if (struct.parent !== (this.map as unknown) || struct.parentSub === null) return;
      const successor = struct.right;
      if (!successor || madeOnTopOf(this.ydoc, successor, struct)) return;
      const content: unknown[] = struct.content.getContent();
      // Already collected by whoever sent it: a value that lost elsewhere and
      // reached this vault with no content. Never ours (this vault's own
      // entries arrive here with theirs), and there is nothing to keep.
      if (content.length === 0) return;
      const value = content[content.length - 1];
      if (sameValue(value, this.map.get(struct.parentSub))) return;
      candidates.push({ key: struct.parentSub, client: struct.id.client, value });
    });
    if (candidates.length === 0) return;
    if (this.history === 'loading') {
      // What is already known to be ours is kept now; only the rest waits, so
      // a read that never finishes cannot hold back this session's copies.
      this.pendingLost.push(...candidates.filter((c) => !this.ourClients.has(c.client)));
      this.keepIfOurs(candidates.filter((c) => this.ourClients.has(c.client)));
      return;
    }
    this.keepIfOurs(candidates);
  }

  /**
   * Keep as a conflict copy the discarded values this vault wrote: those under
   * one of its ids, or all of them when which ids are its own cannot be read.
   *
   * The copy is the note as it reads now with those values put back, so one
   * judged late, after the history loaded, holds whatever else has changed
   * since. That is still the note with this vault's value in it.
   */
  private keepIfOurs(candidates: LostCandidate[]): void {
    const lost = new Map<string, unknown>();
    for (const c of candidates) {
      if (this.history === 'unreadable' || this.ourClients.has(c.client)) lost.set(c.key, c.value);
    }
    if (lost.size === 0) return;

    const text = this.ytext.toString();
    const wanted = new Map<string, unknown>(this.map.entries());
    for (const [key, value] of lost) wanted.set(key, value);
    const projected = projectFrontmatter(text, wanted);
    const rebuilt = projected.kind === 'projected' ? null : rebuildFrontmatter(text, wanted);
    const copy = projected.kind === 'projected' ? projected.text : rebuilt?.kind === 'rebuilt' ? rebuilt.text : text;
    log.warn('A property was changed in two places at once — kept this vault\'s value as a conflict copy', {
      path: this.host.relativePath, properties: [...lost.keys()],
    });
    this.host.keepConflictCopy(copy);
  }

  /** Bring text and map together after a remote change. */
  private reconcile(): void {
    if (this.newerVersion()) return;
    const text = this.ytext.toString();
    const reading = readFrontmatter(text);
    const values = valuesOf(reading);

    if (this.map.size === 0 && !this.meta.has('version')) {
      // Never filled. The text is everyone's agreed starting point now.
      if (values !== null && Object.keys(values).length > 0) this.writeMap(values, []);
      return;
    }

    const touched = new Set(this.touched);
    this.touched.clear();
    const enforce = touched.size > 0 || this.projectionArrived || this.mapWriterActed;
    this.projectionArrived = false;
    this.mapWriterActed = false;

    // What older clients changed in the text, the map takes: properties no
    // map-writing client touched. A value the text holds that the map lacks
    // (a map-writing client's removal would be in `touched`), or one whose map
    // value nobody moved since text and map last agreed, is adopted. When the
    // block as a whole does not parse, from the lines of each property that
    // read on their own, so an older client's new property survives a merge
    // that broke some other line. A property the text no longer has, that no
    // map-writing client touched, was removed by an older client, and is
    // removed from the map too; only from a block that reads, never from one
    // that does not.
    const own = values ?? this.readableEntries(reading);
    const adopt: Values = {};
    for (const [key, value] of Object.entries(own)) {
      if (touched.has(key)) continue;
      if (this.map.has(key) && sameValue(this.map.get(key), value)) continue;
      if (!this.map.has(key) || !this.mapMoved(key)) adopt[key] = value;
    }
    const prune = values === null ? [] : [...this.map.keys()].filter((key) => !(key in values) && !touched.has(key));
    if (prune.some((key) => this.mapMoved(key))) {
      this.host.backup(text, 'A property removed in one place had been changed in another — backed up before removing it');
    }
    if (Object.keys(adopt).length > 0 || prune.length > 0) this.writeMap(adopt, prune);
    if (!enforce) return;

    const wanted = new Map<string, unknown>(this.map.entries());
    if (values !== null && agrees(values, wanted)) {
      for (const [k, v] of wanted) this.agreed.set(k, v);
      return;
    }

    // Key by key when the text reads and holds the same properties: only the
    // lines of properties whose values differ are rewritten, so formatting
    // nobody changed is kept. Otherwise the whole block, as Obsidian writes it.
    let next: string;
    let reason: string;
    const projection = values !== null && sameKeys(values, wanted) ? projectFrontmatter(text, wanted) : null;
    if (projection?.kind === 'projected') {
      next = projection.text;
      reason = projection.droppedComment
        ? 'Rewrote a property whose lines held a comment — backed up first'
        : this.textHeldOtherValue(values ?? {}, wanted) ? 'A property was changed here and elsewhere at once — backed up before settling it' : '';
    } else {
      const rebuilt = rebuildFrontmatter(text, wanted, this.knownClosingAt());
      if (rebuilt.kind === 'refused') {
        this.noticeOnce(rebuilt.reason);
        return;
      }
      next = rebuilt.text;
      reason = 'Properties edited in two places at once could not be merged line by line — backed up, then rewritten from the merged values';
      log.warn('Rebuilt a note\'s properties from the merged values', { path: this.host.relativePath });
    }
    if (next === text) return;
    if (reason) this.host.backup(text, reason);
    this.applyProjection(text, next);
  }

  /** Each property whose lines read on their own and appear once, from a block that does not parse whole. */
  private readableEntries(reading: Reading): Values {
    if (reading.kind !== 'read') return {};
    const count = new Map<string, number>();
    for (const e of reading.entries) count.set(e.key, (count.get(e.key) ?? 0) + 1);
    const out: Values = {};
    for (const e of reading.entries) if (e.ok && count.get(e.key) === 1) out[e.key] = e.value;
    return out;
  }

  /** Whether the map's value for `key` changed since text and map last agreed here. */
  private mapMoved(key: string): boolean {
    return !this.agreed.has(key) || !sameValue(this.agreed.get(key), this.map.get(key));
  }

  /**
   * Whether the text holds, for some property, a value that is neither the map's
   * nor the one last agreed: an older client's concurrent edit, perhaps, which
   * only a backup keeps.
   */
  private textHeldOtherValue(values: Values, wanted: ReadonlyMap<string, unknown>): boolean {
    return Object.entries(values).some(([k, v]) =>
      wanted.has(k) && !sameValue(v, wanted.get(k)) && !(this.agreed.has(k) && sameValue(v, this.agreed.get(k))));
  }

  private noticeOnce(reason: string): void {
    if (this.noticeShown) return;
    this.noticeShown = true;
    log.warn('Left a note\'s properties as they are: they cannot be merged safely', { path: this.host.relativePath, reason });
    this.host.notify(
      `Nectenda: the properties of "${this.host.relativePath}" were edited in two places at once ` +
      'and could not be merged safely. They are left as they are; please check them.',
    );
  }

  /**
   * Rewrite the text under the identity any vault making this same edit would
   * use, so the same edit made in several vaults is kept once.
   */
  private applyProjection(before: string, after: string): void {
    const hunk = oneHunk(before, after);
    const signature = JSON.stringify({
      left: charIds(this.ytext, hunk.at - 1, hunk.at),
      removed: charIds(this.ytext, hunk.at, hunk.at + hunk.remove),
      right: charIds(this.ytext, hunk.at + hunk.remove, hunk.at + hunk.remove + 1),
      insert: hunk.insert,
    });
    const stateVector = Y.encodeStateVector(this.ydoc);
    const known = Y.decodeStateVector(stateVector);
    // An identity already in the document belongs to an earlier edit with the
    // same signature: a pure insertion into a gap where the same text was
    // inserted before and later removed, typically. Never author a second
    // struct under one id, which is how two vaults disagree while claiming to
    // agree. Salt it instead, the same way in every vault, so the edit is
    // still one struct wherever it is made.
    let clientId = deriveProjectionClientId(this.host.docName, signature);
    for (let salt = 1; known.has(clientId); salt++) {
      clientId = deriveProjectionClientId(this.host.docName, `${signature}\u0000${salt}`);
    }

    const scratch = new Y.Doc();
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(this.ydoc));
    scratch.clientID = clientId;
    const text = scratch.getText(this.ytextName());
    scratch.transact(() => {
      if (hunk.remove > 0) text.delete(hunk.at, hunk.remove);
      if (hunk.insert) text.insert(hunk.at, hunk.insert);
    });
    const update = Y.encodeStateAsUpdate(scratch, stateVector);
    scratch.destroy();
    Y.applyUpdate(this.ydoc, update, PROJECTION_ORIGIN);
  }

  private ytextName(): string {
    for (const [name, type] of this.ydoc.share) if (type === (this.ytext as unknown)) return name;
    return 'content';
  }
}
