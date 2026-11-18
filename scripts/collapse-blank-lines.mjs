#!/usr/bin/env node
/**
 * `node scripts/collapse-blank-lines.mjs [--root <dir>]` — collapse every run of blank lines in the tracked .js, .mjs and .ts sources to one.
 *
 * ## What it is for
 *
 * The lint `testing/standalone/no-source-has-two-blank-lines-in-a-row.test.js` refuses two blank lines in a row; this is its fixer, so a file it
 * names is repaired with one command and not by hand. Both read the rule from `testing/_shared/blank-line-runs.mjs`, so a line the lint refuses is a
 * line this removes, and a blank line inside a template literal (content, not layout) is left alone. Each file keeps its own line ending.
 *
 * Files come from `git ls-files` (never the filesystem), and a file is rewritten only when it changes. Prints each file it changed and the count;
 * exits 0 when it ran, 2 on a command line it does not read or a failed listing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint, readFlags } from './_shared/script-cli.mjs';
import { blankLineSources, collapseBlankLines, surplusBlankLines } from '../testing/_shared/blank-line-runs.mjs';

/**
 * Collapse the runs in every covered tracked file of `root`.
 * @param {string} root the checkout
 * @param {number} floor the fewest covered files that means the listing worked
 * @returns {{ file: string, removed: number }[]} the files changed, with the lines each lost
 */
export function collapseTracked(root, floor) {
  const changed = [];
  for (const file of blankLineSources({ root, floor })) {
    const text = readFileSync(join(root, file), 'utf8');
    const removed = surplusBlankLines(file, text).length;
    if (removed === 0) continue;
    writeFileSync(join(root, file), collapseBlankLines(file, text));
    changed.push({ file, removed });
  }
  return changed;
}

if (isEntryPoint(import.meta.url)) {
  const { values, stray } = readFlags(process.argv.slice(2), ['--root']);
  if (stray.length > 0) {
    console.error('usage: node scripts/collapse-blank-lines.mjs [--root <dir>]');
    process.exit(2);
  }
  const given = values['--root'];
  const root = given ? resolve(given) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    // This repository holds thousands of sources, so a listing far under that is broken; a named checkout (a scratch one) holds what it holds.
    const changed = collapseTracked(root, given ? 1 : 100);
    for (const { file, removed } of changed) console.log(`${file}  -${removed}`);
    console.log(`collapse-blank-lines: ${changed.length} file(s) changed, ${changed.reduce((n, c) => n + c.removed, 0)} blank line(s) removed`);
  } catch (e) {
    console.error(`collapse-blank-lines: ${e.message}`);
    process.exit(2);
  }
}
