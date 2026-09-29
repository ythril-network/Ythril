/**
 * A vector search never asks for more results than it searches, and a recall's per-type work is bounded in one
 * module (`Q-103`).
 *
 * `topK` has no ceiling (owner, P-34). Recall passed a per-type K as the ANN stage's `limit` while `numCandidates`
 * stopped at 1000 — so any K above 1000 broke the index's own rule, `limit <= numCandidates`, and the recall answered
 * a 500 labelled retryable, which it was not. A `minPerType` floor above 1000 was a second route to it.
 *
 * Run: node --test testing/standalone/an-ann-stage-never-asks-for-more-than-it-searches.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const bounds = await import('../../server/dist/brain/search-bounds.js');
const fn = (name) => {
  assert.equal(typeof bounds[name], 'function', `${name} does not exist — the rule it carries has no home`);
  return bounds[name];
};
const INDEX_MAX = 10000;

describe('the vector stage is sized so the index accepts it', () => {
  it('limit <= numCandidates <= the index maximum, for every limit the per-type bound allows', () => {
    const size = fn('annCandidates');
    for (const k of [1, 2, 10, 66, 67, 100, 666, 667, 999, 1000, 1001, 1500, bounds.MAX_PER_TYPE_CANDIDATES]) {
      const s = size(k);
      assert.equal(s.limit, k, `the limit for ${k} was changed — that would be a hidden topK ceiling`);
      assert.ok(s.limit <= s.numCandidates, `k=${k}: limit ${s.limit} > numCandidates ${s.numCandidates}`);
      assert.ok(s.numCandidates <= INDEX_MAX, `k=${k}: numCandidates ${s.numCandidates} above the index maximum`);
    }
  });

  it('keeps the 15x oversampling up to 1000 candidates, as before', () => {
    const size = fn('annCandidates');
    assert.equal(size(10).numCandidates, 150);
    assert.equal(size(100).numCandidates, 1000);
    assert.equal(size(1500).numCandidates, 1500, 'above 1000 the candidates follow the limit');
  });
});

describe('the per-type work', () => {
  it('a fetch never passes the per-type bound, and never loses the over-fetch below it', () => {
    const fetch = fn('perTypeFetch');
    assert.equal(fetch(10, 1.5), 15);
    assert.equal(fetch(100000, 1.5), bounds.MAX_PER_TYPE_CANDIDATES);
  });

  it('a minPerType floor is clamped to topK and to the per-type bound', () => {
    const floor = fn('floorFetch');
    assert.equal(floor(5, 10), 5);
    assert.equal(floor(50, 10), 10, 'the guide promises a floor is clamped to topK');
    assert.equal(floor(5000, 100000), bounds.MAX_PER_TYPE_CANDIDATES, 'a large floor was a second route to the 500');
  });

  it('recall reads its bound from here, not from a copy', async () => {
    const recall = await import('../../server/dist/brain/recall.js');
    assert.equal(recall.MAX_PER_TYPE_CANDIDATES, bounds.MAX_PER_TYPE_CANDIDATES);
  });
});

describe('every real vector search is sized by annCandidates', () => {
  // The two capability probes ask for one or ten records with a fixed candidate count on purpose — they answer
  // "does this backend search at all", not a caller's question.
  const PROBES = new Map([
    ['server/src/db/mongo.ts', 'the $vectorSearch capability probe at startup'],
    ['server/src/spaces/vector-index.ts', 'the per-index readiness probe'],
  ]);
  const sources = trackedSources('server/src').filter(f => f.endsWith('.ts'));
  const sizesBySearch = sources.filter(f => /\$vectorSearch/.test(stripComments(readFileSync(f, 'utf8'))));

  it('the searches are found, or the rule is about nothing', () => {
    assert.ok(sizesBySearch.length >= 3, `only ${sizesBySearch.length} file(s) run a $vectorSearch — the scan is wrong`);
    for (const f of PROBES.keys()) assert.ok(sizesBySearch.includes(f), `${f} no longer runs a probe — drop it from PROBES`);
  });

  it('outside the probes, no $vectorSearch writes numCandidates by hand', () => {
    const offenders = sizesBySearch.filter(f => !PROBES.has(f))
      .filter(f => /numCandidates\s*:/.test(stripComments(readFileSync(f, 'utf8'))));
    assert.deepEqual(offenders, [], 'these size a $vectorSearch by hand; spread annCandidates(limit) instead');
  });
});
