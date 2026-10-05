import LZString from 'lz-string';

/**
 * The text of an Excalidraw drawing (`.excalidraw.md`), as the Excalidraw
 * community plugin reads and writes it — and nothing more.
 *
 * Read from obsidian-excalidraw-plugin 2.28.1 (`ExcalidrawData.loadData`,
 * `generateMDBase`, `excalidrawMarkdownParsing.ts`, `sceneDataUtils.ts`). A
 * drawing file is:
 *
 *     <head: frontmatter and any Markdown the user wrote above the data>
 *     [%%]                        ← here when the data section is commented out
 *     # Excalidraw Data
 *
 *     ## Text Elements
 *     <raw text> ^<8-char id>     ← one per text element, each followed by \n\n
 *
 *     ## Element Links            ← only if any
 *     <id>: <link>
 *
 *     ## Embedded Files           ← only if any
 *     <fileId>: [[path]] | $$latex$$ | url
 *
 *     %%                          ← here otherwise
 *     ## Drawing
 *     ```compressed-json          ← or ```json
 *     <scene>
 *     ```
 *     %%
 *
 * The scene is `JSON.stringify(scene, null, "\t")`, and when compressed it is
 * `LZString.compressToBase64` cut into 256-character lines each followed by a
 * blank line. Deleted elements are kept in it, as tombstones.
 *
 * **Strict on purpose.** Anything this cannot account for — a section it does
 * not know, a line it cannot place, a payload that does not decode — is
 * `ok: false`, which keeps the document as it was and backs the file up before
 * anything is written over it (SAFE-A13). A parser that guessed would turn a
 * file it misread into a merge that deletes what it did not see.
 */

/** The Excalidraw plugin release this module was read against. */
export const EXCALIDRAW_READ_AGAINST = '2.28.1';

/** An element of the scene. Only the fields the merge reads are named. */
export type SceneElement = {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
} & Record<string, unknown>;

/** A drawing file, taken apart. */
export interface ExcalidrawFile {
  /** Everything before the data section: frontmatter and the user's own Markdown. */
  head: string;
  /** The data section is wrapped in `%%` from its heading (plugin setting). */
  commentedOut: boolean;
  /** A `^_dummy!_` entry opens the text elements (plugin setting). */
  dummy: boolean;
  /** `## Text Elements`, in file order: id → the raw text written there. */
  texts: Array<[string, string]>;
  /** `## Element Links`, in file order. */
  links: Array<[string, string]>;
  /** `## Embedded Files`, in file order: file id → what the line says. */
  embedded: Array<[string, string]>;
  /** The scene was written compressed. */
  compressed: boolean;
  /** The scene JSON: `type`, `version`, `source`, `elements`, `appState`, `files`, and anything else, verbatim. */
  scene: Record<string, unknown> & { elements: SceneElement[] };
}

export type ParseResult = { ok: true; file: ExcalidrawFile } | { ok: false; error: string };

const DRAWING = /\n##? Drawing\n```(compressed-json|json)\n([\s\S]*?)\n?```\n%%[ \t\r\n]*$/;
const DATA_HEADING = /(^|\n)(%%\n+)?# Excalidraw Data\n\n?## Text Elements(?:\n|$)/;
const BLOCK_REF = /\s\^(.{8})[\n]+/g;
/** `" ^12345678\n\n".length`: how far the plugin steps past a block reference. */
const BLOCK_REF_LEN = 12;
const DUMMY_ID = '_dummy!_';

/** The plugin's `compress`: base64 LZ-string in 256-character lines, each followed by a blank line. */
export function compressScene(json: string): string {
  const compressed = LZString.compressToBase64(json);
  let out = '';
  for (let i = 0; i < compressed.length; i += 256) out += `${compressed.slice(i, i + 256)}\n\n`;
  return out.trim();
}

/** The plugin's `decompress`, or null when it does not decode. */
export function decompressScene(payload: string): string | null {
  const out = LZString.decompressFromBase64(payload.replace(/[\n\r]/g, ''));
  return out ? out : null;
}

/** Why an element cannot be keyed without guessing, or null. */
function elementProblem(el: unknown): string | null {
  if (typeof el !== 'object' || el === null || Array.isArray(el)) return 'an element is not an object';
  const e = el as Record<string, unknown>;
  if (typeof e.id !== 'string' || e.id === '') return 'an element has no id';
  // The document keys revisions as `id \0 version \0 nonce`; an id holding a
  // NUL or the \u0001 that marks internal fields would be split wrongly.
  if (e.id.includes('\u0000') || e.id.includes('\u0001')) return `element "${e.id}" has an id with a control character`;
  if (typeof e.type !== 'string') return `element "${e.id}" has no type`;
  if (!Number.isInteger(e.version)) return `element "${e.id}" has no whole-number version`;
  if (!Number.isInteger(e.versionNonce)) return `element "${e.id}" has no whole-number versionNonce`;
  return null;
}

/** Entries of a `key: value` section, or null if a line does not fit. */
function keyedLines(body: string, key: RegExp): Array<[string, string]> | null {
  const out: Array<[string, string]> = [];
  for (const line of body.split('\n')) {
    if (line.trim() === '') continue;
    const m = key.exec(line);
    if (!m) return null;
    out.push([m[1], m[2]]);
  }
  return out;
}

export function parseExcalidraw(text: string): ParseResult {
  const src = text.replace(/\r\n/g, '\n');
  const drawing = DRAWING.exec(src);
  if (!drawing) return { ok: false, error: 'no "## Drawing" block in the form this version writes' };
  const compressed = drawing[1] === 'compressed-json';
  const json = compressed ? decompressScene(drawing[2]) : drawing[2];
  if (json === null) return { ok: false, error: 'the compressed scene does not decompress' };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return { ok: false, error: `the scene is not JSON: ${String(err)}` };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'the scene is not an object' };
  const scene = raw as Record<string, unknown>;
  if (scene.type !== 'excalidraw') return { ok: false, error: `the scene's type is ${JSON.stringify(scene.type)}` };
  if (!Array.isArray(scene.elements)) return { ok: false, error: 'the scene has no elements array' };
  for (const el of scene.elements) {
    const why = elementProblem(el);
    if (why) return { ok: false, error: why };
  }

  const before = src.slice(0, drawing.index);
  const heading = DATA_HEADING.exec(before);
  if (!heading) {
    // A new drawing, as the plugin creates it (`getBlankDrawing`): the
    // frontmatter and its notice, then `## Drawing` and a closing `%%` with
    // no opening one, and no data sections at all — they appear on its first
    // save. Read as a drawing with nothing in them. Anything else without
    // the heading is not a form this version knows.
    if (/(^|\n)%%[ \t]*(\n|$)/.test(before) || /(^|\n)#{1,2} (Excalidraw Data|Text Elements|Element Links|Embedded Files)\b/.test(before)) {
      return { ok: false, error: 'no "# Excalidraw Data" / "## Text Elements" heading' };
    }
    return {
      ok: true,
      file: {
        head: before, commentedOut: false, dummy: false, texts: [], links: [], embedded: [],
        compressed, scene: scene as ExcalidrawFile['scene'],
      },
    };
  }
  const headEnd = heading.index + heading[1].length;
  const head = before.slice(0, headEnd);
  const commentedOut = heading[2] !== undefined;
  let body = before.slice(headEnd + heading[0].length - heading[1].length);
  if (!commentedOut) {
    // `%%` opens the hidden part just before the drawing instead.
    const close = /(^|\n)%%\n*$/.exec(body);
    if (!close) return { ok: false, error: 'no "%%" before "## Drawing"' };
    body = body.slice(0, close.index + close[1].length);
  } else if (/(^|\n)%%\n*$/.test(body)) {
    return { ok: false, error: 'a second "%%" in a commented-out data section' };
  }

  const linksAt = body.indexOf('## Element Links\n');
  const filesAt = body.indexOf('## Embedded Files\n');
  if (linksAt !== -1 && filesAt !== -1 && filesAt < linksAt) return { ok: false, error: 'sections out of order' };
  const textEnd = linksAt !== -1 ? linksAt : filesAt !== -1 ? filesAt : body.length;
  const textBody = body.slice(0, textEnd);
  const linksBody = linksAt === -1 ? '' : body.slice(linksAt + 17, filesAt !== -1 ? filesAt : body.length);
  const filesBody = filesAt === -1 ? '' : body.slice(filesAt + 18);
  if (/(^|\n)#/.test(linksBody) || /(^|\n)#/.test(filesBody)) return { ok: false, error: 'an unknown section in the data' };

  const texts: Array<[string, string]> = [];
  let dummy = false;
  let position = 0;
  for (const m of textBody.matchAll(BLOCK_REF)) {
    const id = m[1];
    const raw = textBody.slice(position, m.index);
    position = (m.index ?? 0) + BLOCK_REF_LEN;
    if (id === DUMMY_ID && raw.trim() === '') {
      dummy = true;
      continue;
    }
    texts.push([id, raw.replace(/^\n+/, '')]);
  }
  if (textBody.slice(position).trim() !== '') return { ok: false, error: 'text in "## Text Elements" with no block reference' };

  const links = keyedLines(linksBody, /^(.{8}):\s*(.*)$/);
  if (!links) return { ok: false, error: 'a line in "## Element Links" is not "id: link"' };
  const embedded = keyedLines(filesBody, /^([^:\s][^:]*): (.*)$/);
  if (!embedded) return { ok: false, error: 'a line in "## Embedded Files" is not "id: file"' };

  return {
    ok: true,
    file: {
      head,
      commentedOut,
      dummy,
      texts,
      links,
      embedded,
      compressed,
      scene: scene as ExcalidrawFile['scene'],
    },
  };
}

/** The keys the plugin writes at the top of the scene, in its order. */
const SCENE_LEAD = ['type', 'version', 'source', 'elements', 'appState', 'files'];

export function serialiseExcalidraw(file: ExcalidrawFile): string {
  let out = file.head;
  out += file.commentedOut ? '%%\n' : '';
  out += '# Excalidraw Data\n\n## Text Elements\n';
  if (file.dummy) out += `\n^${DUMMY_ID}\n\n`;
  for (const [id, raw] of file.texts) out += `${raw} ^${id}\n\n`;
  if (file.links.length > 0) {
    out += '## Element Links\n';
    for (const [id, link] of file.links) out += `${id}: ${link}\n\n`;
  }
  if (file.embedded.length > 0) {
    out += '## Embedded Files\n';
    for (const [id, value] of file.embedded) out += `${id}: ${value}\n\n`;
  }
  const scene: Record<string, unknown> = {};
  for (const k of SCENE_LEAD) if (k in file.scene) scene[k] = file.scene[k];
  for (const k of Object.keys(file.scene)) if (!SCENE_LEAD.includes(k)) scene[k] = file.scene[k];
  const json = JSON.stringify(scene, null, '\t');
  out += file.commentedOut ? '' : '%%\n';
  out += file.compressed
    ? `## Drawing\n\`\`\`compressed-json\n${compressScene(json)}\n\`\`\`\n%%`
    : `## Drawing\n\`\`\`json\n${json}\n\`\`\`\n%%`;
  return out;
}
