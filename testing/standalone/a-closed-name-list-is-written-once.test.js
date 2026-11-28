/**
 * A closed list of names is written in one file, and every other reader imports it.
 *
 * ## The defect
 *
 * The embed queue's three job statuses were written out three times: in the jobs page's filter, in the queue's count and in the
 * `ythril_embed_jobs` metric (bundle-41's diff pass). The rights rungs were written twice (`auth/space-rights.ts` and
 * `config/rights-shape.ts`), and so were the leaked-rows repair's kept reasons (the registry seeds them, the repair counts them).
 * Each copy agreed with the others by hand only: a fourth status, rung or reason added to one list reaches nothing that reads
 * another, and a metric series, a filter or a check then silently leaves it out.
 *
 * ## The rule, over the whole set
 *
 * Every literal array of three or more plain string names marked `as const` in the server's code roots appears in at most ONE
 * file. The set is derived from the tracked sources (comments stripped, so a docblock quoting a list is not one); a floor says
 * the scan found the lists it is about. Two files that spell one list for two different questions are a row of the allowlist
 * beside this file, with the reason and a review date; the count of rows is reported.
 *
 * Run: node --test testing/standalone/a-closed-name-list-is-written-once.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readTrackedSources, SERVER_CODE_ROOTS } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const ALLOW = JSON.parse(readFileSync(new URL('./a-closed-name-list-is-written-once.allow.json', import.meta.url), 'utf8')).entries;

/** Every `['a', 'b', 'c'] as const` (three or more single-quoted names) in `src`, normalised to its names joined by commas. */
export function closedNameLists(src) {
  const out = [];
  // Built fresh on every call: a shared global regex keeps its lastIndex between callers.
  const re = /\[\s*((?:'[A-Za-z0-9_.:-]+'\s*,\s*){2,}'[A-Za-z0-9_.:-]+')\s*,?\s*\]\s*as\s+const\b/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(m[1].split(',').map(s => s.trim().slice(1, -1)).join(','));
  return out;
}

describe('a closed list of names is written once', () => {
  const files = readTrackedSources(SERVER_CODE_ROOTS);
  const where = new Map();
  for (const { file, text } of files) {
    for (const list of new Set(closedNameLists(stripComments(text)))) {
      if (!where.has(list)) where.set(list, []);
      where.get(list).push(file);
    }
  }

  it('finds the lists it is about (floor)', () => {
    assert.ok(where.size >= 20, `only ${where.size} closed name lists found under ${SERVER_CODE_ROOTS.join(', ')}: re-anchor the scan`);
  });

  it('each list stands in one file, or in the files its allowlist row names', () => {
    const allowed = new Map(ALLOW.map(e => [e.list, new Set(e.files)]));
    const repeated = [...where].filter(([list, inFiles]) => inFiles.length > 1
      && !(allowed.has(list) && inFiles.every(f => allowed.get(list).has(f))));
    assert.deepEqual(repeated.map(([list, inFiles]) => `[${list}] in ${inFiles.join(' and ')}`), [],
      'write the list once and import it where it is read; two different questions that share a spelling go in the allowlist with a reason');
  });

  it('every allowlist row has a reason, a review date not passed, and still names a repeat', () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const e of ALLOW) {
      assert.ok(typeof e.reason === 'string' && e.reason.length > 20, `[${e.list}]: no reason`);
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(e.reviewBy ?? '') && e.reviewBy >= today, `[${e.list}] is past its review date (${e.reviewBy})`);
      assert.ok((where.get(e.list) ?? []).length > 1, `[${e.list}] is no longer repeated: remove its row`);
    }
    console.log(`allowlist rows: ${ALLOW.length}`);
  });

  it('the scan finds a planted copy of a list the repository holds', () => {
    const [list] = [...where.keys()];
    const planted = `export const COPY = [${list.split(',').map(n => `'${n}'`).join(', ')}] as const;`;
    assert.deepEqual(closedNameLists(planted), [list]);
  });
});
