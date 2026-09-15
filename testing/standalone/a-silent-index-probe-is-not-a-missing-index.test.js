/**
 * An instance that answers nothing about its search indexes must not be told it has none.
 *
 * ## The report (`Q-11`)
 *
 * The canary operator's vector-index panel declared **fifteen spaces missing an index** while recall against
 * those exact spaces returned correctly ranked results with real cosine scores — and `similar`, which is
 * pure vector with no lexical channel, worked too. The vectors existed and were being searched.
 *
 * `listSearchIndexes` is the Atlas Search API. On a self-hosted replica set running `$vectorSearch` natively
 * there is no `mongot` behind it, so the call SUCCEEDS and returns an empty list. No error to catch,
 * `listingFailed` stays false, every status is null, and a null status is read as `missing`.
 *
 * ## Why this is severe rather than untidy
 *
 * Every drifted row carries a **Rebuild** button. They measured a 79-file re-ingest on that host: embedding
 * calls went from 80 ms to 2–9 seconds and stayed there for forty minutes, starving the reranker completely.
 * Fifteen spaces is hours of degradation, on a false positive, one click per row.
 *
 * A destructive action offered on the strength of a check that cannot tell "absent" from "unanswerable" is
 * the shape this fix is about. `missing` claims knowledge the probe does not have.
 *
 * ## What is asserted here, and what deliberately is not
 *
 * `deriveLiveIndexState` is unchanged and still reads a null status as `missing` — a single space with no
 * index among many that have them is a real missing index, and must keep reporting as one. What changes is
 * the conclusion drawn from TOTAL silence, which is why these cases are about the whole instance rather than
 * one space.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveLiveIndexState, isDrifted } from '../../server/dist/api/pipeline-status.js';

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server/src/api/pipeline-status.ts'), 'utf8');

test('one space with a null status is still a missing index', () => {
  // The behaviour that must NOT change. A real absence has to keep reporting, or fixing the false positive
  // would hide the true one — which is the same trade the optional-index carve-out was careful about.
  assert.equal(deriveLiveIndexState([{ collection: 'memories', indexName: 'x', status: null }], false), 'missing');
  assert.equal(isDrifted('ready', 'missing'), true);
});

test('a listing that THREW is already unknown, and unknown never drifts', () => {
  assert.equal(deriveLiveIndexState([{ collection: 'memories', indexName: 'x', status: null }], true), 'unknown');
  assert.equal(isDrifted('ready', 'unknown'), false,
    'an unanswerable probe must not flag drift, or the red badge means "we could not tell"');
});

test('total silence across the instance is reported as unknown, not missing', () => {
  /*
   * Asserted against the source rather than by standing up a Mongo without mongot: the condition is the
   * whole point and it is one expression. A behavioural test here would need a deployment we do not have in
   * this suite, and the integration suite's Mongo DOES answer the API — so the case that matters could not
   * be exercised there either.
   */
  assert.match(source, /const anyIndexSeen = out\.some\(s => s\.collections\.some\(c => c\.status !== null\)\)/,
    'the instance-wide check is gone; every space would be declared missing again on a native deployment');
  assert.match(source, /if \(out\.length > 0 && !anyIndexSeen\)/,
    'the guard must require at least one space, or an instance with no spaces reports a fault it does not have');

  const guard = source.slice(source.indexOf('const anyIndexSeen'));
  assert.match(guard.slice(0, 700), /live: 'unknown' as const, drifted: false/,
    'silence must produce unknown and clear the drift flag, not merely add a message beside a red row');
  assert.match(guard.slice(0, 900), /unavailable:/,
    'the operator has to be told the probe did not answer, or an all-unknown panel reads as a fault');
});

test('the explanation names the recall check, because that is what settles it', () => {
  // The operator's question is "are my vectors there". The answer that costs nothing and is decisive is a
  // recall — which is exactly how the canary established the alarm was false.
  const guard = source.slice(source.indexOf('const anyIndexSeen'));
  assert.match(guard.slice(0, 900), /[Rr]ecall/,
    'the message must point at the thing that answers the question, not only say the probe failed');
});
