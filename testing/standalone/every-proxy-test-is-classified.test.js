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
 * ## Seen red
 *
 * At 18e8d598: rules 2 and 3 name every delete and rewrite row. Rule 1 seen red by removing a row from a scratch copy of the list
 * (the run reports that file as unclassified), then restored by hand.
 *
 * Run: node --test testing/standalone/every-proxy-test-is-classified.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { trackedSources, REPO_ROOT, isTestFile } from './_sources.mjs';
import { PROXY_TEST_CLASSIFICATION, proxySymbolPattern, FLIP_SET_ROOTS } from '../_shared/proxy-test-classification.mjs';

/** The list and this gate define the symbols; they are not subjects of it. */
const DEFINERS = new Set(['testing/_shared/proxy-test-classification.mjs', 'testing/standalone/every-proxy-test-is-classified.test.js']);

/** A test file anywhere under the roots, or a test helper (any tracked script) under `testing/`. */
const isSubject = (f) => isTestFile(f) || (f.startsWith('testing/') && /\.(?:m|c)?js$/.test(f));

const contentHash = (f) => createHash('sha256').update(readFileSync(join(REPO_ROOT, f), 'utf8').replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);

/** The derived flip set: tracked subjects whose text names a proxy symbol. */
export function flipSet() {
  const files = trackedSources(FLIP_SET_ROOTS, { ext: ['.js', '.mjs', '.cjs', '.ts'], floor: 500 })
    .filter(f => isSubject(f) && !DEFINERS.has(f));
  return files.filter(f => proxySymbolPattern().test(readFileSync(join(REPO_ROOT, f), 'utf8')));
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
  it('the derived flip set is not empty (floor), so the rest concludes about something', () => {
    const set = flipSet();
    assert.ok(set.length >= 40, `only ${set.length} file(s) name a proxy symbol; the scan is broken, not the tests`);
  });

  it('every file naming a proxy symbol has a row, every delete is done and every rewrite has changed its file', () => {
    const findings = classificationFindings(PROXY_TEST_CLASSIFICATION, flipSet());
    assert.deepEqual(findings, [], `the flip set owes ${findings.length} hand edit(s):\n  ${findings.join('\n  ')}`);
  });
});
