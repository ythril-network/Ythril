/**
 * The query vector cache keeps no query text, keeps each caller's vectors apart, and drops an expired entry when the next one is kept
 * (bundle-378, Q-976, fix round A: R3, L2.1, L3.2).
 *
 * ## The rule
 *
 * A recall's `query` has no bound but the 10 MB body limit, and the cache held up to a thousand entries keyed by the whole prepared text:
 * about 10 GB of query text kept for ten minutes, and past that, because an entry's time was read only when it was asked for again. So:
 *
 *  1. an entry's key holds a hash, never the text: a megabyte of query text leaves keys of a few dozen characters;
 *  2. the caller is in the key: one text asked by two callers is two entries, two model calls, and a call in flight for one caller is never
 *     joined by another;
 *  3. an entry past its time is gone once any other entry is kept, not only when it is asked for again;
 *  4. what was already guaranteed still holds: a model, an endpoint or a text apart is a miss, the bound drops the least recently used,
 *     a failure is not kept, and a handed-out vector is a copy.
 *
 * ## Seen red
 *
 * On f91569511 the key is `JSON.stringify([endpoint, model, input])`: case 1 finds the megabyte of text in the key, case 2 gives the
 * second caller the first one's vector, and case 3 still holds all three expired entries after a fourth is kept.
 *
 * Run: npm run build:server, then node --test testing/standalone/the-query-vector-cache-keeps-no-query-text.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const MODULE = '../../server/dist/brain/query-embedding-cache.js';

/** A model call that logs each text it embeds and answers a vector naming it. */
function counted() {
  const calls = [];
  const compute = (text) => async () => { calls.push(text); return { vector: [text.length], model: 'm', dimensions: 1 }; };
  return { calls, compute };
}

const key = (caller, input, extra = {}) => ({ caller, input, model: 'm', endpoint: 'local', ...extra });

describe('the query vector cache keeps no query text', () => {
  it('a megabyte of query text leaves keys of a few dozen characters, none holding a word of it', async () => {
    const { QueryEmbeddingCache } = await import(MODULE);
    const cache = new QueryEmbeddingCache({ max: 10, ttlMs: 60_000 });
    const { compute } = counted();
    const text = 'zq-private-words '.repeat(70_000);
    await cache.get(key('caller-1', text), compute(text));
    const keys = cache._keys();
    assert.equal(keys.length, 1, 'the cache holds the one entry it was given');
    assert.ok(keys[0].length <= 128, `the key is ${keys[0].length} characters long, so it holds the text`);
    assert.ok(!keys[0].includes('zq-private-words'), 'the key holds the query text');
    assert.ok(!keys[0].includes('caller-1'), 'the key holds the caller id in the clear');
  });

  it('one text asked by two callers is two entries and two model calls, in flight or kept', async () => {
    const { QueryEmbeddingCache } = await import(MODULE);
    const cache = new QueryEmbeddingCache({ max: 10, ttlMs: 60_000 });
    const { calls, compute } = counted();
    await cache.get(key('a', 'alpha'), compute('alpha'));
    await cache.get(key('a', 'alpha'), compute('alpha'));
    assert.deepEqual(calls, ['alpha'], 'the same caller\'s repeat was embedded again');
    await cache.get(key('b', 'alpha'), compute('alpha'));
    assert.deepEqual(calls, ['alpha', 'alpha'], 'a second caller was handed the first caller\'s vector');
    assert.equal(cache.size(), 2);
    // Both callers ask at once, before any answer: each has its own call.
    const slow = (text) => () => new Promise(resolve => setTimeout(() => { calls.push(text); resolve({ vector: [1], model: 'm', dimensions: 1 }); }, 20));
    const before = calls.length;
    await Promise.all([cache.get(key('c', 'beta'), slow('beta')), cache.get(key('d', 'beta'), slow('beta')), cache.get(key('c', 'beta'), slow('beta'))]);
    assert.equal(calls.length - before, 2, 'two callers asking at once shared one model call, or one caller\'s two asks made two');
  });

  it('an entry past its time is gone once another entry is kept', async () => {
    const { QueryEmbeddingCache } = await import(MODULE);
    let now = 1_000;
    const cache = new QueryEmbeddingCache({ max: 10, ttlMs: 500, now: () => now });
    const { compute } = counted();
    for (const t of ['a', 'b', 'c']) await cache.get(key('x', t), compute(t));
    assert.equal(cache.size(), 3);
    now += 501;
    await cache.get(key('x', 'd'), compute('d'));
    assert.equal(cache.size(), 1, `the three expired entries stayed after a fourth was kept: ${cache.size()} held`);
  });

  it('a model, an endpoint or a text apart is a miss; the bound drops the least recently used; a failure is not kept; a handed-out vector is a copy', async () => {
    const { QueryEmbeddingCache } = await import(MODULE);
    const cache = new QueryEmbeddingCache({ max: 2, ttlMs: 60_000 });
    const { calls, compute } = counted();
    await cache.get(key('a', 'alpha'), compute('alpha'));
    await cache.get(key('a', 'alpha', { model: 'm2' }), compute('alpha-m2'));
    await cache.get(key('a', 'alpha', { endpoint: 'http://other' }), compute('alpha-other'));
    assert.deepEqual(calls, ['alpha', 'alpha-m2', 'alpha-other'], 'another model or endpoint reused the vector of the first');
    assert.ok(cache.size() <= 2, `the cache holds ${cache.size()} entries past its bound of 2`);
    await assert.rejects(cache.get(key('a', 'x'), async () => { throw new Error('model down'); }), /model down/);
    await cache.get(key('a', 'x'), compute('x'));
    assert.equal(calls.at(-1), 'x', 'a failed model call was kept');
    const first = await cache.get(key('a', 'x'), compute('x'));
    first.vector.push(99);
    assert.deepEqual((await cache.get(key('a', 'x'), compute('x'))).vector, [1], 'a caller that changed its vector changed it for the next recall');
  });
});
