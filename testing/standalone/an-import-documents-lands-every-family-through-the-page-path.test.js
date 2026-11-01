/**
 * `importDocuments` lands every family through the one page entry, `importPage`, so the existing import tests exercise the path the door's pages take
 * (bundle-40 slice b, `Q-267`; plan 2R3 "Tests named").
 *
 * ## The rule, and why it is a source gate and not a spy
 *
 * The door lands a body in pages (`importPage(space, family, docs, acc)`); the 18 existing import tests call `importDocuments` with one object. If
 * `importDocuments` kept a landing path of its own, those tests would go on passing while testing a path the door no longer takes: the failure that
 * reads as coverage. The rule: in `server/src/api/admin-import.ts`
 *
 *  1. `importPage` is defined (the page entry exists), and
 *  2. the arrival writer (`writeArrivals`) is called ONLY inside `importPage` (one landing site), and
 *  3. `importPage` is called from the import's own driver (`importInto`), which `importDocuments` calls.
 *
 * A spy cannot do this: ES module exports cannot be replaced from outside, and a counter inside the product for a test is code the product must carry.
 * The gate reads the call sites with comments blanked (`_strip-comments.mjs`: offsets stay the original source's) and resolves each call to its
 * outermost function by name (`_source-helpers.mjs`), so a comment that names `importPage`, or a call written in a nested closure, is neither a pass nor a
 * miss. Its truth table is exercised on written samples first: a gate that cannot fail on the wrong shape says nothing about the real file.
 *
 * ## Red on the base
 *
 * On 6c64a7112 `importInto` calls `writeArrivals` itself and there is no `importPage`: rules 1 and 2 fail.
 *
 * Run: `node --test testing/standalone/an-import-documents-lands-every-family-through-the-page-path.test.js`
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';
import { outermostFunctionAt } from './_source-helpers.mjs';

/** The functions (by outermost name) that contain a call of `name(` in `raw`; comments blanked, definitions skipped. */
function callersOf(file, raw, name) {
  const blanked = blankComments(raw);
  const out = [];
  for (const m of blanked.matchAll(new RegExp(`(?<![.\\w$])${name}\\s*\\(`, 'g'))) {
    if (/function\s+$/.test(blanked.slice(Math.max(0, m.index - 12), m.index))) continue;
    out.push(outermostFunctionAt(file, raw, m.index)?.name ?? null);
  }
  return out;
}

/** What is wrong with a source's landing path, as sentences; empty when it routes every family through `importPage`. */
function pagePathProblems(file, raw) {
  const blanked = blankComments(raw);
  const problems = [];
  if (!/(?:export\s+)?(?:async\s+)?function\s+importPage\s*[(<]/.test(blanked)) problems.push('no `importPage` function is defined: the import has no page entry');
  const writes = callersOf(file, raw, 'writeArrivals');
  if (writes.length === 0) problems.push('`writeArrivals` is never called: nothing lands');
  const outside = writes.filter(fn => fn !== 'importPage');
  if (outside.length > 0) problems.push(`\`writeArrivals\` is called from ${[...new Set(outside)].map(f => `\`${f}\``).join(', ')}, not only from \`importPage\``);
  if (!callersOf(file, raw, 'importPage').includes('importInto')) problems.push('`importInto` does not call `importPage`');
  if (!callersOf(file, raw, 'importInto').includes('importDocuments')) problems.push('`importDocuments` does not call `importInto`');
  return problems;
}

const GOOD = `
export async function importPage(space, family, docs, acc) { return writeArrivals(space, family, 'x', docs, { restore: true }); }
async function importInto(space, payload) { for (const t of TYPES) await importPage(space, t, payload[t], {}); }
export async function importDocuments(space, payload) { return importInto(space, payload); }
`;

describe('importDocuments lands every family through the page path', () => {
  it('the gate\'s truth table: the right shape passes, each wrong one is named', () => {
    assert.deepEqual(pagePathProblems('good.ts', GOOD), []);
    assert.match(pagePathProblems('a.ts', GOOD.replace('export async function importPage', 'async function landPage').replace('await importPage', 'await landPage')).join('\n'), /no `importPage`/);
    assert.match(pagePathProblems('b.ts', GOOD.replace('await importPage(space, t, payload[t], {});', "await writeArrivals(space, t, 'x', payload[t], {});")).join('\n'), /called from `importInto`/);
    assert.match(pagePathProblems('c.ts', GOOD.replace('return importInto(space, payload);', 'return {};')).join('\n'), /`importDocuments` does not call `importInto`/);
    // A comment that names the page path is not the page path.
    const commented = GOOD.replace('await importPage(space, t, payload[t], {});', "// importPage(space, t, payload[t], {})\n  await writeArrivals(space, t, 'x', payload[t], {});");
    assert.match(pagePathProblems('d.ts', commented).join('\n'), /`importInto` does not call `importPage`/);
  });

  it('server/src/api/admin-import.ts routes every family through importPage, and is the only place it lands one', () => {
    const files = trackedSources('server/src', { untracked: true, floor: 100 }).filter(f => f.replace(/\\/g, '/').endsWith('api/admin-import.ts'));
    assert.equal(files.length, 1, `expected one server/src/api/admin-import.ts, found ${JSON.stringify(files)}: the import moved, re-anchor this gate`);
    const raw = fs.readFileSync(path.isAbsolute(files[0]) ? files[0] : path.join(REPO_ROOT, files[0]), 'utf8');
    assert.deepEqual(pagePathProblems(files[0], raw), [], 'importDocuments (and so the 18 tests that call it) does not take the path the door\'s pages take');
  });
});
