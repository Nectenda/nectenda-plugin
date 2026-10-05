import * as Y from 'yjs';
import { mergeTextEdit } from './text-merge';
import { applyWholeValues, canonical, normaliseJson, SEP } from './structured-records';
import { contentOf, derivedId, fateOf, INTERNAL, keptCopy, stripInternal, winnerOf } from './excalidraw-merge';
import type { SceneElement } from './excalidraw-format';
import { log } from './logger';

/**
 * An Excalidraw drawing as a Y.Doc (NEC-41), independent of how it reaches the
 * screen: the file comes in through excalidraw-codec.ts, an open view through
 * excalidraw-live.ts, and both through `applyExcalidraw`.
 *
 * **One entry per version of an element, not one per element.** Two vaults
 * writing the same element under one key would leave one of the two to Yjs,
 * which keeps whichever client id sorts last and discards the other without a
 * trace — so the version rule (excalidraw-merge.ts) could never run, and the
 * loser could never be kept. Keyed by `id \0 version \0 versionNonce`, two
 * concurrent edits are two keys, both present, and reading picks the winner.
 * The key is the version's identity: Excalidraw draws a fresh nonce on every
 * change, so one key never holds two different elements.
 *
 * Each entry carries, besides the element, what its author built it on:
 * `\u0001base` (that version's `[version, versionNonce]`) and
 * `\u0001baseContent` (its content). That is how a version that lost is told
 * apart from one that was only superseded, and how a lost move is told from a
 * lost edit (`fateOf`).
 *
 * **Old versions are removed** — by the author of the next version, who has
 * seen it, and by `settleExcalidraw` for a version that lost. Never anyone
 * else's losing version: only its author keeps it, so a version is kept once,
 * not once per vault.
 *
 * **Deleting is a version too.** Excalidraw deletes by writing the element with
 * `isDeleted: true` and a higher version, so a concurrent edit with a higher
 * version brings it back by the same rule. No element is ever removed, or read
 * as deleted, for being absent from a save (SAFE-A18): Excalidraw for Obsidian
 * leaves a deleted element out of the file, but so does a release that does
 * not know an element's type, and so does a view that never loaded it. A
 * save's deletes come from the open view that made it, which still holds them
 * (`withViewDeletes` in excalidraw-live.ts).
 *
 * Other roots, all flat:
 * - `head` (Y.Text): the note above the data — frontmatter and the user's own
 *   Markdown — merged as text.
 * - `appState`: the shared view settings only (background, grid). The rest is
 *   each vault's own and stays on its disk (SAFE-A21, `withLocal`).
 * - `files`, `embedded`: image data and `## Embedded Files` lines, by file id.
 * - `scene`: the scene's other top-level keys — `type`, `version`, `source`,
 *   and whatever a newer Excalidraw adds — verbatim.
 */

export const ROOT_REVS = 'revs';
export const ROOT_HEAD = 'head';
export const ROOT_APP_STATE = 'appState';
export const ROOT_FILES = 'files';
export const ROOT_EMBEDDED = 'embedded';
export const ROOT_SCENE = 'scene';

const BASE = `${INTERNAL}base`;
const BASE_CONTENT = `${INTERNAL}baseContent`;
/** Where the element sat in the file when written, for elements with no z-order index. */
const AT = `${INTERNAL}at`;

/** View settings everyone sees the same; the rest of `appState` is each vault's own. */
export const SHARED_APP_STATE = new Set(['viewBackgroundColor', 'gridSize', 'gridStep', 'gridModeEnabled']);

/** A drawing, as the merge sees it. */
export interface ExcalidrawValue {
  head: string;
  /** The standing version of every element, deleted ones included, in z-order. */
  elements: SceneElement[];
  /** The shared app-state keys, or on disk all of them. */
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
  embedded: Record<string, string>;
  /** The scene's top-level keys other than `elements`, `appState` and `files`. */
  scene: Record<string, unknown>;
  /** How this vault's plugin writes the file. Never shared. */
  layout: {
    compressed: boolean; commentedOut: boolean; dummy: boolean;
    /**
     * The scene's `source`: the plugin build that wrote the file, which each
     * version stamps with its own. Shared, two vaults on different releases
     * would rewrite it on every save and never agree.
     */
    source?: unknown;
    /**
     * The blank lines between the note above the drawing and its data, which
     * plugin releases write differently (2.27.3 one fewer than 2.28.1). Shared,
     * each release would put back its own on every save.
     */
    headGap?: string;
    /**
     * The scene's top-level keys other than its type and version (and the
     * elements, settings, files and source, kept elsewhere): each vault's
     * own, from its own file. Only `type` and `version` are shared, so a key
     * one plugin release adds and another lacks cannot be rewritten by each
     * in turn.
     */
    sceneExtra?: Record<string, unknown>;
  };
}

/** The scene's top-level keys every vault shares. */
export const SHARED_SCENE_KEYS: readonly string[] = ['type', 'version'];

/** Only the shared top-level keys of a scene. */
export function sharedScene(scene: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of SHARED_SCENE_KEYS) if (k in scene) out[k] = scene[k];
  return out;
}

export const DEFAULT_LAYOUT: ExcalidrawValue['layout'] = { compressed: true, commentedOut: false, dummy: false };

/**
 * The key of one version of an element: its id, version and nonce, and a hash
 * of the whole element. The nonce is random, so two vaults rarely draw the
 * same one for the same version — but rarely is not never, and two different
 * elements under one key would leave one of them to Yjs, gone without a
 * trace. With the hash, the same version written twice is one key and two
 * different ones are two.
 */
export function revKey(el: SceneElement): string {
  return `${el.id}${SEP}${el.version}${SEP}${el.versionNonce}${SEP}${derivedId(canonical(stripInternal(el)))}`;
}

/** The element id a revision key belongs to. */
export function idOfKey(key: string): string {
  return key.slice(0, key.indexOf(SEP));
}

export type Revision = SceneElement & Record<string, unknown>;

/** Every version the document holds, grouped by element id. */
export function revisionsById(ydoc: Y.Doc): Map<string, Array<{ key: string; rev: Revision }>> {
  const out = new Map<string, Array<{ key: string; rev: Revision }>>();
  ydoc.getMap<unknown>(ROOT_REVS).forEach((value, key) => {
    if (typeof value !== 'object' || value === null) return;
    const id = idOfKey(key);
    if (!id) return;
    let list = out.get(id);
    if (!list) {
      list = [];
      out.set(id, list);
    }
    list.push({ key, rev: value as Revision });
  });
  return out;
}

/** What a revision says its author built it on: `[version, versionNonce]`, or null. */
export function baseOf(rev: Revision): [number, number] | null {
  const b = rev[BASE];
  return Array.isArray(b) && typeof b[0] === 'number' && typeof b[1] === 'number' ? [b[0], b[1]] : null;
}

/** The content of the version a revision was built on, or null for a new element. */
export function baseContentOf(rev: Revision): string | null {
  const c = rev[BASE_CONTENT];
  return typeof c === 'string' ? c : null;
}

/** Z-order: the element's fractional index, then where it sat in the file, then its id. */
function zOrder(a: Revision, b: Revision): number {
  const ia = typeof a.index === 'string' ? a.index : '';
  const ib = typeof b.index === 'string' ? b.index : '';
  if (ia !== ib) return ia < ib ? -1 : 1;
  const pa = typeof a[AT] === 'number' ? (a[AT]) : 0;
  const pb = typeof b[AT] === 'number' ? (b[AT]) : 0;
  if (pa !== pb) return pa - pb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The drawing the document holds now. Layout is the default; `withLocal` puts this vault's back. */
export function readExcalidraw(ydoc: Y.Doc): ExcalidrawValue {
  const winners: Revision[] = [];
  for (const list of revisionsById(ydoc).values()) winners.push(winnerOf(list.map((r) => r.rev)));
  winners.sort(zOrder);
  const plain = (name: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const root = ydoc.getMap<unknown>(name);
    for (const k of [...root.keys()].sort()) out[k] = root.get(k);
    return out;
  };
  const embedded: Record<string, string> = {};
  for (const [k, v] of Object.entries(plain(ROOT_EMBEDDED))) if (typeof v === 'string') embedded[k] = v;
  return {
    head: ydoc.getText(ROOT_HEAD).toString(),
    elements: winners.map((w) => stripInternal(w)),
    appState: plain(ROOT_APP_STATE),
    // Each vault's own (see applyExcalidraw): never read from the document.
    files: {},
    embedded,
    scene: plain(ROOT_SCENE),
    layout: { ...DEFAULT_LAYOUT },
  };
}

function sharedAppState(appState: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(appState)) if (SHARED_APP_STATE.has(k)) out[k] = v;
  return out;
}

/**
 * Whether `elements` — a view's scene, or a save — are another drawing's, not
 * this document's: some live, none of them ever in this document, while this
 * document has live elements of its own. Obsidian reuses a drawing's view for
 * another file, and the view takes the new path before its scene is replaced;
 * a scene or save read in that moment is the old drawing under the new path.
 * By the document alone, never the file: anything saved in that moment puts
 * the old drawing's ids in the file, and a check that trusted the file was
 * defeated by the save it should have stopped (found in review). A view of
 * this drawing shares at least one element with it, however many it adds.
 * An empty document cannot tell, and says no.
 */
export function isAnotherDrawing(elements: readonly SceneElement[], ydoc: Y.Doc): boolean {
  const live = elements.filter((e) => e.isDeleted !== true);
  if (live.length === 0) return false;
  const revs = revisionsById(ydoc);
  let docHasLive = false;
  for (const list of revs.values()) {
    if (winnerOf(list.map((r) => r.rev)).isDeleted !== true) {
      docHasLive = true;
      break;
    }
  }
  // Any of its elements counts, deleted ones too: a user who deleted every
  // shape this drawing had still holds them, deleted, in the scene.
  return docHasLive && !elements.some((e) => revs.has(e.id));
}

/**
 * Bring an edit into the document, as a minimal diff from `base`.
 *
 * `base` is the drawing as the editor last saw it — for a file, what disk and
 * document last agreed on — or null for the first fill. An element whose
 * version is the base's is unchanged and written nowhere: the document may
 * hold a newer version from someone else, and writing the base's back would be
 * reverting it. An element the edit no longer has is left alone: Excalidraw
 * deletes by version, never by leaving an element out.
 *
 * Call inside a transaction; the caller owns the origin.
 */
export function applyExcalidraw(ydoc: Y.Doc, value: ExcalidrawValue, base: ExcalidrawValue | null): void {
  const revs = ydoc.getMap<unknown>(ROOT_REVS);
  const baseById = new Map((base?.elements ?? []).map((e) => [e.id, e]));
  const refusedStale: Array<{ id: string; version: number; base: number }> = [];
  value.elements.forEach((input, at) => {
    const el = normaliseJson(stripInternal(input)) as SceneElement;
    const was = baseById.get(el.id);
    if (was && was.version === el.version && was.versionNonce === el.versionNonce) return;
    // Older than what it was read against: not an edit, since Excalidraw
    // versions only rise (an undo raises them too). A file older than the
    // record (version control, a restore, another sync tool) or a stale save
    // would otherwise revert the element in every vault, and nothing would
    // keep the newer version: superseded revisions are removed below, not
    // settled.
    if (was && el.version < was.version) {
      refusedStale.push({ id: el.id, version: el.version, base: was.version });
      return;
    }
    const key = revKey(el);
    if (!revs.has(key)) {
      const rev: Record<string, unknown> = { ...el, [AT]: at };
      if (was) {
        rev[BASE] = [was.version, was.versionNonce];
        rev[BASE_CONTENT] = contentOf(was);
      }
      revs.set(key, rev);
    }
    // The version this one was made on is superseded, by someone who saw it,
    // and only by a higher one. One with the same number and another nonce is
    // a rival, not a successor: both stay, and settle decides (SAFE-A27).
    if (was && el.version > was.version) {
      const old = revKey(normaliseJson(stripInternal(was)) as SceneElement);
      if (old !== key && revs.has(old)) revs.delete(old);
    }
  });
  if (refusedStale.length > 0) {
    log.info('Refused element versions older than the ones they were read against; the newer stand', {
      count: refusedStale.length, first: refusedStale.slice(0, 5),
    });
  }

  const head = ydoc.getText(ROOT_HEAD);
  if (base) {
    if (base.head !== value.head) mergeTextEdit(ydoc, head, base.head, value.head);
  } else if (head.toString() !== value.head) {
    mergeTextEdit(ydoc, head, head.toString(), value.head);
  }

  applyWholeValues(ydoc.getMap<unknown>(ROOT_APP_STATE), sharedAppState(value.appState), base ? sharedAppState(base.appState) : null);
  // Not `files`: in a drawing of Excalidraw for Obsidian an image is a link
  // under "## Embedded Files" and an attachment that syncs as itself, and the
  // scene's `files` is written empty. What Excalidraw holds there at run time
  // is each image's bytes, loaded from the vault — never shared. A document
  // written before this was decided may still hold some; nothing reads them.
  applyWholeValues(ydoc.getMap<unknown>(ROOT_EMBEDDED), value.embedded, base?.embedded ?? null);
  applyWholeValues(ydoc.getMap<unknown>(ROOT_SCENE), sharedScene(value.scene), base ? sharedScene(base.scene) : null);
}

/** Meaning, not layout: what two vaults must agree on for the file to say the same. */
export function meaningOf(v: ExcalidrawValue): string {
  // An element is the same element when its id, version and nonce are, as
  // Excalidraw itself decides it (reconcileElements, and applyExcalidraw
  // above). Not field by field: Excalidraw fills in defaults as it loads a
  // drawing — `restore` — without raising the version, so an open drawing
  // never equals its own file field by field until its next save, and a view
  // that "shows something else" cannot be bound live (found in the user's
  // vaults: 7 elements, every version equal, refused for half a minute).
  //
  // And a deleted element says nothing: deleted and absent show the same. The
  // plugin drops a deleted image from its scene, while the file and the
  // document keep its tombstone, so counted, a drawing whose image was
  // replaced never equalled its own file again (found in the user's vaults).
  // A tombstone still differs from the live element it replaced.
  const elements = [...v.elements]
    .filter((e) => e.isDeleted !== true)
    .map((e) => [e.id, e.version, e.versionNonce])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return canonical({
    head: v.head.replace(/\n+$/, ''),
    elements,
    appState: sharedAppState(v.appState),
    embedded: v.embedded,
    // Only the shared keys: the rest is each vault's own (layout), though a
    // document filled before that was decided may still hold some.
    scene: sharedScene(v.scene),
  });
}

/** Which element ids a transaction touched, for a view to redraw. */
export interface ExcalidrawChange {
  ids: Set<string>;
  /** Anything but elements changed: head, settings, files. */
  other: boolean;
  /** Which other roots, by name, with the keys changed, for the log. */
  roots: string[];
  /** Which other roots, by name. */
  names: Set<string>;
}

/** Report what each transaction changed. Returns the unsubscribe. */
export function observeExcalidraw(ydoc: Y.Doc, cb: (change: ExcalidrawChange, tr: Y.Transaction) => void): () => void {
  const handler = (tr: Y.Transaction): void => {
    const change: ExcalidrawChange = { ids: new Set(), other: false, roots: [], names: new Set() };
    for (const [type, keys] of tr.changed) {
      if (type === ydoc.share.get(ROOT_REVS)) {
        for (const k of keys) if (k) change.ids.add(idOfKey(k));
      } else {
        change.other = true;
        let name = '?';
        for (const [n, t] of ydoc.share) if (t === type) name = n;
        change.names.add(name);
        change.roots.push(`${name}:${[...keys].filter((k) => k !== null).slice(0, 5).join(',')}`);
      }
    }
    if (change.ids.size || change.other) cb(change, tr);
  };
  ydoc.on('afterTransaction', handler);
  return () => ydoc.off('afterTransaction', handler);
}

/** What `settleExcalidraw` did, for the log and the tests. */
export interface SettleReport {
  /** Versions of this vault's that lost content, kept in the drawing beside the original, labelled. */
  kept: Array<{ id: string; why: string; copy: string; label: string }>;
  /** Versions of this vault's that lost nothing worth keeping, converged and logged. */
  converged: Array<{ id: string; why: string; lost: SceneElement }>;
  /** Superseded versions removed. */
  pruned: number;
}

/**
 * Settle every element that has more than one version (SAFE-A27).
 *
 * A version that the standing one was built on is superseded and removed, by
 * whoever sees it. A version that lost a race is decided only by the vault that
 * wrote it — `isOurs(key)` — so it is kept, or converged, exactly once:
 *
 * - it lost writing (`fateOf` says keep): a copy of it goes back into the
 *   drawing beside the original, grouped with an outline and a label naming
 *   `who` and when;
 * - it lost only its position or size, or it was a delete that lost to an
 *   edit: it is reported, for the log, and nothing is added.
 *
 * Either way the losing version is then removed, so the next settle does not
 * meet it again. The copy's ids are derived from the losing version's key, so
 * settling the same loser twice writes the same elements, not a second copy.
 *
 * Call inside a transaction; the caller owns the origin.
 */
export function settleExcalidraw(ydoc: Y.Doc, isOurs: (key: string) => boolean, who: string): SettleReport {
  const report: SettleReport = { kept: [], converged: [], pruned: 0 };
  const revs = ydoc.getMap<unknown>(ROOT_REVS);
  // Losing versions left for the vault that wrote them: if that vault does
  // not recognise them as its own, nobody keeps them, so say which.
  const leftToAuthor: string[] = [];
  for (const [id, list] of revisionsById(ydoc)) {
    if (list.length < 2) continue;
    const winner = winnerOf(list.map((r) => r.rev));
    const wBase = baseOf(winner);
    for (const { key, rev } of list) {
      if (rev === winner) continue;
      // Superseded only by a higher version made on it. A recorded base of the
      // same number is false — two versions of one number are rivals — and,
      // trusted, it removed an edit with no copy kept.
      if (wBase && winner.version > rev.version && wBase[0] === rev.version && wBase[1] === rev.versionNonce) {
        revs.delete(key);
        report.pruned++;
        continue;
      }
      if (!isOurs(key)) {
        leftToAuthor.push(`${id}@${rev.version}`);
        continue;
      }
      const loser = stripInternal(rev);
      const standing = stripInternal(winner);
      const fate = fateOf(loser, standing, baseContentOf(rev));
      if (fate.kind === 'keep') {
        const current = readExcalidraw(ydoc).elements.filter((e) => !e.isDeleted);
        let top: string | null = null;
        for (const e of current) if (typeof e.index === 'string' && (top === null || e.index > top)) top = e.index;
        const kept = keptCopy(loser, standing, current, key, who, top);
        const [, copy, caption] = kept;
        for (const el of kept) {
          const k = revKey(el);
          if (!revs.has(k)) revs.set(k, { ...el });
        }
        report.kept.push({ id, why: fate.why, copy: copy.id, label: caption.id });
      } else {
        report.converged.push({ id, why: fate.why, lost: loser });
      }
      revs.delete(key);
    }
  }
  if (leftToAuthor.length > 0) log.debug('Losing element versions left for the vault that wrote them', { versions: leftToAuthor.slice(0, 8) });
  return report;
}
