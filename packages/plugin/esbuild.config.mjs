import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";
import { readFileSync } from "node:fs";

// The version travels with every request the plugin makes, so the server can
// refuse a build too old to talk to. Read from manifest.json and substituted
// as a literal rather than imported, so the number is written down once and
// the bundle does not carry the manifest.
const manifestVersion = JSON.parse(readFileSync("manifest.json", "utf8")).version;

// This banner is not decoration: it is how the shipped bundle satisfies
// PolyForm Shield's Notices clause. Anyone who receives a copy of the software
// must also receive the terms (or their URL) and every plain-text line
// beginning with `Required Notice:`. main.js is the copy users receive, so both
// have to travel inside it. Keep the Required Notice line byte-identical to the
// one in packages/plugin/LICENSE.
const banner = `/*
Nectenda — end-to-end encrypted collaborative editing for Obsidian.

Source-available under the PolyForm Shield License 1.0.0.
https://polyformproject.org/licenses/shield/1.0.0

Required Notice: Copyright (c) 2026 Nerchure Ltd (https://nectenda.com)

This bundle is deliberately NOT minified. Nectenda's central claim is that the
server cannot read your notes, and the only way to check that claim is to read
the code that does the encrypting — which is this file, on your own disk, and
is exactly what runs. Shipping it minified would have cost 300KB less and made
the claim something you had to take on trust instead.

The licence asks one thing of you: do not use this to build a competing
product. Reading it, auditing it, building it yourself and comparing the result
to this file are all expressly permitted — that is what it is published for.

What to look for, and what the server can and cannot see:
https://github.com/Nectenda/nectenda-plugin/blob/main/docs/security-model.md
*/
`;

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  banner: {
    js: banner,
  },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtinModules,
  ],
  define: {
    __PLUGIN_VERSION__: JSON.stringify(manifestVersion),
  },
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  // Never minified, in production either. See the banner above: an auditable
  // client is the substitute for publishing the server, so the shipped file has
  // to be one a person can actually read. 214KB -> 526KB, which is nothing
  // beside the attachments this plugin moves.
  minify: false,
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
