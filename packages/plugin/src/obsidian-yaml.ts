import { parse, stringify } from 'yaml';

/**
 * YAML read and written exactly as Obsidian reads and writes it.
 *
 * Obsidian bundles eemeli/yaml 2.9.1 and wraps it in two helpers. In
 * 1.13.7's `app.js`, `yL` is `parse(text, null, {})` and `bL` is
 * `stringify(value, null, OBSIDIAN_YAML_OPTIONS)`. `processFrontMatter`,
 * `stringifyYaml` and the Bases view all go through `bL`. Using the same
 * library at the same version with the same options is what makes a line we
 * write byte-identical to the line Obsidian would write. Anything else is
 * churn: Obsidian rewrites the block on its next save, and that rewrite
 * arrives here looking like an edit.
 *
 * One module for every caller, so there is one formatter in the plugin. Two
 * copies of these three options drifting apart would mean two notions of
 * "unchanged".
 */

/** The Obsidian version these were read against. */
export const OBSIDIAN_YAML_READ_AGAINST = '1.13.7';

/** `bL`'s options in 1.13.7. Library defaults otherwise: two-space indent, `indentSeq`. */
export const OBSIDIAN_YAML_OPTIONS = { nullStr: '', lineWidth: 0, aliasDuplicateObjects: false } as const;

/** Parse as Obsidian does. Throws on what Obsidian would reject, duplicate keys included. */
export function parseObsidianYaml(text: string): unknown {
  // `yL` is `parse(text, null, {})`: no reviver, default options.
  return parse(text, {});
}

/** Serialise as Obsidian does. Ends with a newline, as Obsidian's output does. */
export function stringifyObsidianYaml(value: unknown): string {
  return stringify(value, null, OBSIDIAN_YAML_OPTIONS);
}
