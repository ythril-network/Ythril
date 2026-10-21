/**
 * Every test, spec and test helper that names a proxy symbol is classified, and each classification has happened (Q-531, bundle-100).
 *
 * ## The rule
 *
 * Q-531 makes a proxy a personal view, outside `config.spaces`; the symbols that encoded the old rule (`proxyFor`, `isProxy`,
 * `concreteSpaces`, `memberSpaces*`, `targetSpace`, `resolveWriteTarget`) are retired or deleted. The tests that name them are
 * DERIVED here, never listed, and each must carry a row in `testing/_shared/proxy-test-classification.mjs`:
 *
 * 1. every tracked file under `testing/` and every client spec that names a proxy symbol has a row (a new one is classified before it lands);
 * 2. a `delete` row's file no longer exists;
 * 3. a `rewrite` row's file no longer has the content it had when it was classified (its `base` hash);
 * 4. an `unaffected` row's file still exists (a row for a file that went is stale and is removed with it).
 *
 * Rules 2 and 3 are red until the implementation's hand edits land: that is the list doing its job, not a defect in it.
 *
 * A `rewrite` is NOT required to stop naming the symbol: a rewritten test may name `proxyFor` because it asserts the field is refused by
 * name (plan rev 3). The rewrite is proved by the content change; what it says is the reviewer's to read against `why`.
 *
 * ## The floor, and why it is not a count
 *
 * The first version asserted `flipSet().length >= 40`. That counts files that STILL name a symbol, so every correct rewrite lowered it
 * and the implementation turned it red. The floor now holds the classification instead (`floorFindings`): the flip set derived at
 * `CLASSIFIED_AT` out of git's tree must have a row each (the list keeps its rows), every `rewrite`/`delete` row must be in that set,
 * and today's scan must find every `unaffected` file. A broken scan on either side leaves rows the other side cannot account for.
 *
 * ## Seen red
 *
 * At 18e8d598: rules 2 and 3 name every delete and rewrite row. Rule 1 seen red by removing a row from a scratch copy of the list
 * (the run reports that file as unclassified), then restored by hand. The floor, at the merge of the b100 halves: renaming the
 * `proxy-questions.mjs` row's file reported `row dropped` and `underived row`; un-naming the symbol in `_oversize-files.mjs` reported
 * `unaffected row not found by today's scan`; adding `targetSpace` to `absent-input.mjs` reported `unclassified`. All put back by hand.
 *
 * Run: node --test testing/standalone/every-proxy-test-is-classified.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { trackedSources, REPO_ROOT, isTestFile } from './_sources.mjs';
import { requireInput } from '../_shared/absent-input.mjs';
import { PROXY_TEST_CLASSIFICATION, proxySymbolPattern, FLIP_SET_ROOTS, CLASSIFIED_AT } from '../_shared/proxy-test-classification.mjs';

/** The list and this gate define the symbols; they are not subjects of it. */
const DEFINERS = new Set(['testing/_shared/proxy-test-classification.mjs', 'testing/standalone/every-proxy-test-is-classified.test.js']);

/** A test file anywhere under the roots, or a test helper (any tracked script) under `testing/`. */
const isSubject = (f) => isTestFile(f) || (f.startsWith('testing/') && /\.(?:m|c)?js$/.test(f));

const contentHash = (f) => createHash('sha256').update(readFileSync(join(REPO_ROOT, f), 'utf8').replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);

const SUBJECT_EXT = ['.js', '.mjs', '.cjs', '.ts'];
const SCAN_FLOOR = 500;
const isScanned = (f) => SUBJECT_EXT.some(e => f.endsWith(e)) && !f.endsWith('.d.ts') && isSubject(f) && !DEFINERS.has(f);

/** The derived flip set: tracked subjects whose text names a proxy symbol. */
export function flipSet() {
  const files = trackedSources(FLIP_SET_ROOTS, { ext: SUBJECT_EXT, floor: SCAN_FLOOR }).filter(isScanned);
  return files.filter(f => proxySymbolPattern().test(readFileSync(join(REPO_ROOT, f), 'utf8')));
}

const git = (...args) => execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

/** Whether `ref` can be read from this checkout (a shallow clone cannot). */
const refPresent = (ref) => { try { git('cat-file', '-e', `${ref}^{commit}`); return true; } catch { return false; } };

/**
 * The flip set as it was at `ref`: the same subjects and the same pattern, read out of git's tree rather than the disk. The listing
 * carries the same floor as today's scan. Candidates are narrowed by a fixed-string `git grep` (portable, one process) and each is then
 * judged by the one pattern, so `\b` means what it means today.
 */
export function flipSetAt(ref) {
  const listed = git('ls-tree', '-r', '--name-only', ref, '--', ...FLIP_SET_ROOTS).split('\n').filter(Boolean).filter(isScanned);
  if (listed.length < SCAN_FLOOR) throw new Error(`only ${listed.length} subject(s) listed at ${ref}; the historical scan is broken`);
  const stems = ['proxyFor', 'isProxy', 'concreteSpace', 'memberSpaces', 'targetSpace', 'resolveWriteTarget'];
  let hits = '';
  try { hits = git('grep', '-l', '-F', ...stems.flatMap(s => ['-e', s]), ref, '--', ...FLIP_SET_ROOTS); } catch (e) { if (e.status !== 1) throw e; }
  const candidates = new Set(hits.split('\n').filter(Boolean).map(l => l.slice(ref.length + 1)));
  return listed.filter(f => candidates.has(f) && proxySymbolPattern().test(git('show', `${ref}:${f}`)));
}

/**
 * The floor, derived rather than counted. A count of files that STILL name a symbol falls with every correct rewrite, so it cannot be
 * the floor. What cannot fall is the classification itself: the flip set at `CLASSIFIED_AT` is fixed history, and the list must keep a
 * row for every file in it (the list keeps its rows); every `rewrite` and `delete` row must have been in it (a row the history does not
 * know was never derived, or the historical scan is broken); and today's scan must still find every `unaffected` file (an
 * `unaffected` file that no longer names a symbol is a stale row, or today's scan is broken). Each half checks the other.
 */
export function floorFindings(rows, historical, derived) {
  const out = [];
  if (historical.length === 0) out.push(`the flip set at ${CLASSIFIED_AT} is empty; the historical scan is broken`);
  const byFile = new Map(rows.map(r => [r.file, r]));
  const then = new Set(historical);
  const now = new Set(derived);
  for (const f of historical) if (!byFile.has(f)) out.push(`row dropped: ${f} named a proxy symbol at ${CLASSIFIED_AT} and has no row`);
  for (const r of rows) {
    if ((r.verdict === 'rewrite' || r.verdict === 'delete') && !then.has(r.file)) out.push(`underived row: ${r.file} is a ${r.verdict} row but did not name a proxy symbol at ${CLASSIFIED_AT}`);
    if (r.verdict === 'unaffected' && existsSync(join(REPO_ROOT, r.file)) && !now.has(r.file)) out.push(`unaffected row not found by today's scan: ${r.file} (no longer names a symbol, or the scan is broken)`);
  }
  return out;
}

/** What each row still owes; `rows` and `derived` are parameters so a scratch copy can be judged by the same code. */
export function classificationFindings(rows, derived) {
  const out = [];
  const byFile = new Map(rows.map(r => [r.file, r]));
  for (const f of derived) if (!byFile.has(f)) out.push(`unclassified: ${f} names a proxy symbol and has no row`);
  for (const r of rows) {
    if (!['rewrite', 'delete', 'unaffected'].includes(r.verdict) || !r.why) { out.push(`malformed row: ${r.file}`); continue; }
    const there = existsSync(join(REPO_ROOT, r.file));
    if (r.verdict === 'delete' && there) out.push(`delete owed: ${r.file} still exists (${r.why})`);
    if (r.verdict === 'rewrite' && !there) out.push(`rewrite row for a file that went: ${r.file}; make the row a delete`);
    if (r.verdict === 'rewrite' && there && contentHash(r.file) === r.base) out.push(`rewrite owed: ${r.file} is unchanged since it was classified (${r.why})`);
    if (r.verdict === 'unaffected' && !there) out.push(`stale row: ${r.file} is gone; remove its row`);
  }
  return out;
}

describe('every proxy test is classified, and each classification has happened (Q-531)', () => {
  it('the list keeps a row for the whole flip set it was classified from, and today\'s scan finds every unaffected file (floor)', (t) => {
    if (!requireInput(t, refPresent(CLASSIFIED_AT), `the classification commit ${CLASSIFIED_AT} is not in this checkout`,
      'Check out with full history (fetch-depth: 0): the floor is the flip set as it was classified.')) return;
    const findings = floorFindings(PROXY_TEST_CLASSIFICATION, flipSetAt(CLASSIFIED_AT), flipSet());
    assert.deepEqual(findings, [], `the floor does not hold:\n  ${findings.join('\n  ')}`);
  });

  it('every file naming a proxy symbol has a row, every delete is done and every rewrite has changed its file', () => {
    const findings = classificationFindings(PROXY_TEST_CLASSIFICATION, flipSet());
    assert.deepEqual(findings, [], `the flip set owes ${findings.length} hand edit(s):\n  ${findings.join('\n  ')}`);
  });
});
