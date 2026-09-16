/**
 * The readiness probe sends a query the backend can actually answer.
 *
 * ## What shipped, and what it cost
 *
 * #585 replaced a lifecycle-field read with "ask the index whether it serves" — the right instinct. The
 * query it asked with was a **zero vector**, and a zero vector cannot be scored against a cosine index:
 *
 *     Executor error … caused by :: Cosine similarity cannot be calculated against a zero vector.
 *
 * Verified locally against Atlas Local, not inferred. So the probe threw every time, on every backend. It
 * was never backend-specific: where `status`/`queryable` exist the cheap path returns first and the probe is
 * never reached, which is exactly why our own testing never saw it. The one fleet that DID reach it got a
 * permanent, deterministic failure reported as "not ready yet" — 600 s per index, 65 indexes, spaces marked
 * failed while `recall` answered the same index at 0.913, and readiness-probe timeouts that restarted pods.
 *
 * ## Why the existing test did not catch it
 *
 * `index-ready-poll.test.js` asserted the probe "asks the question recall asks": that it is a `$vectorSearch`
 * against the index by name, and cheap. All three were true of a query that could never succeed. A regex over
 * source cannot know that cosine similarity is undefined at the origin — so this file asserts the VALUE.
 *
 * Run: node --test testing/standalone/probe-query-validity.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let probeQueryVector, PROBE_NUM_CANDIDATES, PERMANENT_PROBE_ERRORS;

describe('the probe query vector', () => {
  before(async () => {
    ({ probeQueryVector, PROBE_NUM_CANDIDATES, PERMANENT_PROBE_ERRORS } =
      await import('../../server/dist/spaces/vector-index.js'));
  });

  it('is NOT the zero vector — the defect, asserted as a value', () => {
    for (const dims of [768, 1536, 384, 3072]) {
      const v = probeQueryVector(dims);
      assert.equal(v.length, dims, `width must match the configured dimensions (${dims})`);
      assert.ok(v.some(x => x !== 0), 'a zero vector cannot be scored under cosine similarity');
    }
  });

  it('has a non-zero magnitude, which is the property that actually matters', () => {
    // Not "contains a 1" — the requirement is that the vector has a direction. Stated as the norm so a
    // future change to which component is set still satisfies it honestly.
    const v = probeQueryVector(768);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    assert.ok(norm > 0, 'the probe vector must have a direction to be scoreable');
  });

  it('keeps numCandidates >= limit, the documented contract', () => {
    // The probe uses limit 1. numCandidates was 1 — legal but on the boundary, for no benefit.
    assert.ok(PROBE_NUM_CANDIDATES >= 1);
    assert.ok(PROBE_NUM_CANDIDATES >= 10, 'a little headroom costs nothing at limit 1');
  });
});

describe('a rejected query is not an unready index', () => {
  before(async () => {
    ({ PERMANENT_PROBE_ERRORS } = await import('../../server/dist/spaces/vector-index.js'));
  });

  const classify = msg => PERMANENT_PROBE_ERRORS.some(re => re.test(msg));

  it('classifies the exact error this bug produced as PERMANENT', () => {
    // Verbatim from mongot via Atlas Local. If this ever stops matching, the poller goes back to waiting
    // 600 s per index for something that cannot happen.
    assert.equal(classify(
      'Executor error during aggregate command on namespace: ythril.places_edges :: caused by :: '
      + 'Cosine similarity cannot be calculated against a zero vector.'), true);
  });

  it('classifies the other ways a backend refuses the REQUEST', () => {
    for (const msg of [
      'Invalid $vectorSearch: numCandidates must be greater than or equal to limit',
      'queryVector has 768 dimensions but the index expects 1536',
      '$vectorSearch is not allowed in this atlas tier',
      'Unrecognized pipeline stage name: $vectorSearch',
    ]) {
      assert.equal(classify(msg), true, msg);
    }
  });

  it('does NOT classify a still-building or transient error as permanent', () => {
    // These are the cases where waiting is exactly right. Getting this wrong in the other direction means
    // declaring an index usable while it is still being built.
    for (const msg of [
      'PlanExecutor error during aggregation :: caused by :: index not found',
      'Index with name general_facts_embedding is currently building',
      'connection 42 to 10.1.2.3:27017 timed out',
      'operation exceeded time limit',
    ]) {
      assert.equal(classify(msg), false, msg);
    }
  });
});
