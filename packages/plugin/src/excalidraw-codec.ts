import type * as Y from 'yjs';
import type { StructuredCodec } from './structured-formats';
import { parseExcalidraw, serialiseExcalidraw, type ExcalidrawFile, type SceneElement } from './excalidraw-format';
import {
  applyExcalidraw, DEFAULT_LAYOUT, isAnotherDrawing, meaningOf, readExcalidraw, ROOT_APP_STATE, ROOT_REVS, ROOT_SCENE,
  SHARED_APP_STATE, SHARED_SCENE_KEYS, settleExcalidraw, sharedScene, type ExcalidrawValue, type SettleReport,
} from './excalidraw-model';
import { derivedNonce } from './excalidraw-merge';
import { CANVAS_PRESENCE_PAD_BYTES } from './presence-seal';

/**
 * Excalidraw drawings (`.excalidraw.md`) as a structured format (NEC-41): the
 * file boundary around excalidraw-model.ts.
 *
 * **The Markdown sections are folded into the scene, as the plugin folds them.**
 * When the Excalidraw plugin loads a drawing, the text written in `## Text
 * Elements` replaces the scene's text, and a link in `## Element Links`
 * replaces the scene's link — without the element's version changing. Under a
 * version rule an edit made there, in Markdown mode, would then never win. So
 * a section that disagrees with its element is read here as an edit of that
 * element, with the version raised; the nonce is derived from what was written,
 * so every vault reading the same file writes the same version.
 *
 * **On the way out the sections are derived from the scene**, never kept
 * separately: two copies of one text, merged separately, could disagree, and
 * the plugin would then load the section's over the scene's.
 */

/** Fold a file's Markdown sections into its elements, as the plugin does on load. */
function fold(file: ExcalidrawFile): SceneElement[] {
  const texts = new Map(file.texts);
  const links = new Map(file.links);
  return file.scene.elements.map((el) => {
    let next = el;
    const raw = texts.get(el.id);
    if (raw !== undefined && el.type === 'text' && el.rawText !== raw) {
      next = { ...next, rawText: raw };
      // Plain text reads the same everywhere; text holding a link is re-parsed
      // by the plugin on load, so only the raw form is set.
      if (el.originalText === el.rawText) next = { ...next, originalText: raw, text: raw };
    }
    const link = links.get(el.id);
    if (link !== undefined && next.link !== link) next = { ...next, link };
    if (next !== el) {
      next = {
        ...next,
        version: el.version + 1,
        versionNonce: derivedNonce(`${el.id}\u0000${el.version}\u0000${String(next.rawText)}\u0000${String(next.link)}`),
      };
    }
    return next;
  });
}

/** Text elements whose section entry names no element: the plugin drops them on its next save. */
function orphanTexts(file: ExcalidrawFile): string[] {
  const ids = new Set(file.scene.elements.map((e) => e.id));
  return file.texts.filter(([id]) => !ids.has(id)).map(([id]) => id);
}

/** The blank lines Excalidraw for Obsidian 2.28.1 leaves under the note, for a vault with none on disk. */
const DEFAULT_HEAD_GAP = '\n\n\n';

function toValue(file: ExcalidrawFile): ExcalidrawValue {
  const { elements: _e, appState, files, source, ...rest } = file.scene;
  const scene = sharedScene(rest);
  const sceneExtra = Object.fromEntries(Object.entries(rest).filter(([k]) => !SHARED_SCENE_KEYS.includes(k)));
  const embedded: Record<string, string> = {};
  for (const [k, v] of file.embedded) embedded[k] = v;
  const head = file.head.replace(/\n+$/, '');
  return {
    head,
    elements: fold(file),
    appState: typeof appState === 'object' && appState !== null ? { ...(appState as Record<string, unknown>) } : {},
    files: typeof files === 'object' && files !== null ? { ...(files as Record<string, unknown>) } : {},
    embedded,
    scene,
    layout: {
      compressed: file.compressed, commentedOut: file.commentedOut, dummy: file.dummy,
      ...(source === undefined ? {} : { source }),
      headGap: file.head.slice(head.length),
      sceneExtra,
    },
  };
}

function toFile(v: ExcalidrawValue): ExcalidrawFile {
  const live = v.elements.filter((e) => !e.isDeleted);
  const texts: Array<[string, string]> = [];
  for (const e of live) {
    if (e.type !== 'text') continue;
    const raw = typeof e.rawText === 'string' ? e.rawText : typeof e.originalText === 'string' ? e.originalText : typeof e.text === 'string' ? e.text : '';
    texts.push([e.id, raw]);
  }
  const links: Array<[string, string]> = [];
  for (const e of live) if (typeof e.link === 'string' && e.link !== '') links.push([e.id, e.link]);
  return {
    head: v.head.replace(/\n+$/, '') + (v.layout.headGap ?? DEFAULT_HEAD_GAP),
    commentedOut: v.layout.commentedOut,
    dummy: v.layout.dummy,
    texts,
    links,
    embedded: Object.keys(v.embedded).sort().map((k) => [k, v.embedded[k]]),
    compressed: v.layout.compressed,
    scene: {
      ...(v.layout.sceneExtra ?? {}),
      ...sharedScene(v.scene),
      ...(v.layout.source === undefined ? {} : { source: v.layout.source }),
      elements: v.elements, appState: v.appState, files: v.files,
    },
  };
}

/** The user name a kept copy's label gives, set by the plugin once it knows it. */
let keptBy = 'someone';
export function setKeptBy(name: string): void {
  keptBy = name || 'someone';
}

export const excalidrawCodec: StructuredCodec = {
  format: 'excalidraw',
  version: 1,
  viewType: 'excalidraw',
  fromText: true,
  // A drawing's presence — pointer, viewport, a selection of element ids — is
  // the size of a canvas one, and sealed in the same bucket so length does not
  // say which (presence-seal.ts, CRYPTO-113).
  presencePadBytes: CANVAS_PRESENCE_PAD_BYTES,

  parse(text) {
    const parsed = parseExcalidraw(text);
    if (!parsed.ok) return parsed;
    return { ok: true, value: toValue(parsed.file) };
  },

  apply(ydoc, value, base) {
    applyExcalidraw(ydoc, value as ExcalidrawValue, base as ExcalidrawValue | null);
  },

  read(ydoc) {
    return readExcalidraw(ydoc);
  },

  serialise(value) {
    return serialiseExcalidraw(toFile(value as ExcalidrawValue));
  },

  equal(a, b) {
    return meaningOf(a as ExcalidrawValue) === meaningOf(b as ExcalidrawValue);
  },

  withLocal(docValue, diskValue) {
    const doc = docValue as ExcalidrawValue;
    const disk = diskValue as ExcalidrawValue | null;
    const appState: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(disk?.appState ?? {})) if (!SHARED_APP_STATE.has(k)) appState[k] = v;
    for (const [k, v] of Object.entries(doc.appState)) if (SHARED_APP_STATE.has(k)) appState[k] = v;
    // `files` too is this vault's own: what its plugin wrote (applyExcalidraw).
    return { ...doc, appState, files: disk?.files ?? {}, layout: disk?.layout ?? { ...DEFAULT_LAYOUT } };
  },

  presentationOnly(root) {
    // An overwritten revision key held the same element by construction (the
    // key is its id, version and nonce); what differs is only the merge's own
    // note of what it was built on. Background and grid are view settings;
    // the scene's type and version are Excalidraw's, the same in every vault.
    return root === ROOT_REVS || root === ROOT_APP_STATE || root === ROOT_SCENE;
  },

  mergeOnClash(value, base) {
    // The elements: an older version is refused, and a lost edit is kept
    // beside the original (SAFE-A27). The note above merges as text, which a
    // lagging record could revert, so it — with the settings and links — stays
    // as the document has it, and the file's is in the backup.
    const v = value as ExcalidrawValue;
    const b = base as ExcalidrawValue;
    return { ...b, elements: v.elements };
  },

  foreign(value, ydoc) {
    return isAnotherDrawing((value as ExcalidrawValue).elements, ydoc);
  },

  dropsOnRewrite(text) {
    const parsed = parseExcalidraw(text);
    return parsed.ok && orphanTexts(parsed.file).length > 0;
  },

  settle(ydoc: Y.Doc, isOurs: (root: string, key: string) => boolean): SettleReport {
    return settleExcalidraw(ydoc, (key) => isOurs(ROOT_REVS, key), keptBy);
  },
};
