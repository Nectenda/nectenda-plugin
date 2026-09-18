#!/usr/bin/env node
/**
 * Confirm that a released `main.js` was built from the published source.
 *
 * This is the script that makes the licence argument mean something. Nectenda's
 * central claim is that the server cannot read your notes, and the answer to
 * "why should I believe you" is "read the code that encrypts them". That answer
 * is only worth anything if the file you can read is the file that runs. The
 * bundle being unminified gets you most of the way; this closes the gap by
 * rebuilding from source and comparing byte for byte.
 *
 *   node scripts/verify-build.mjs --built path/to/downloaded/main.js
 *   node scripts/verify-build.mjs --built main.js --source /path/to/checkout
 *
 * Run inside a clone of the public plugin repository, or point `--source` at
 * one. It builds with that checkout's own toolchain and compares.
 *
 * A mismatch is not automatically sinister — a different pnpm or esbuild
 * version will move bytes without changing behaviour — so the failure output
 * says where the difference is rather than merely that there is one.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

const BUILT = flag('--built');
const SOURCE = flag('--source') ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function die(message, hint) {
  console.error(`\n  ✗ ${message}`);
  if (hint) console.error(`    ${hint}`);
  process.exit(1);
}

if (!BUILT) die('Pass --built <path to the main.js you want to check>.');
const builtPath = path.resolve(BUILT);
if (!existsSync(builtPath)) die(`No such file: ${builtPath}`);

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const theirs = readFileSync(builtPath);

console.log('\n=== verify build ===\n');
console.log(`  checking  ${builtPath}`);
console.log(`  source    ${SOURCE}`);
console.log(`  sha256    ${sha(theirs)}\n`);

console.log('  building from source…');
execFileSync('pnpm', ['install', '--frozen-lockfile'], { cwd: SOURCE, stdio: 'inherit' });
execFileSync('pnpm', ['build'], { cwd: SOURCE, stdio: 'inherit' });

const rebuiltPath = path.join(SOURCE, 'packages/plugin/main.js');
if (!existsSync(rebuiltPath)) die('The build produced no packages/plugin/main.js.');
const ours = readFileSync(rebuiltPath);

if (sha(ours) === sha(theirs)) {
  console.log(`\n  ✓ identical — ${theirs.length} bytes, sha256 ${sha(theirs)}`);
  console.log('    The file you installed is the source you can read.\n');
  process.exit(0);
}

// Locate the first difference rather than just reporting inequality: a banner
// or version string differing is a very different finding from the crypto
// differing, and "they don't match" does not distinguish them.
const min = Math.min(ours.length, theirs.length);
let at = 0;
while (at < min && ours[at] === theirs[at]) at++;

const context = (buf) => JSON.stringify(buf.subarray(Math.max(0, at - 40), at + 60).toString('utf8'));
console.error('\n  ✗ the rebuilt bundle differs from the one supplied.\n');
console.error(`    rebuilt   ${ours.length} bytes, sha256 ${sha(ours)}`);
console.error(`    supplied  ${theirs.length} bytes, sha256 ${sha(theirs)}`);
console.error(`    first differ at byte ${at}\n`);
console.error(`    rebuilt:  ${context(ours)}`);
console.error(`    supplied: ${context(theirs)}\n`);
console.error('    A differing toolchain moves bytes without changing behaviour.');
console.error('    Compare the pnpm and esbuild versions before concluding anything.\n');
process.exit(1);
