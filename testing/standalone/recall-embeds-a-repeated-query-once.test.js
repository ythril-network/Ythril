/**
 * Recall embeds a repeated query once: the query vector is kept per (text, model), bounded in entries and in time, and recall's phases are
 * named in its Server-Timing (bundle-378, Q-976 S2, contract row 5).
 *
 * ## The rule
 *
 * A recall's fixed cost is mostly the query's embedding: one model call per request, for a text an agent or a type-ahead often sends again.
 * The vector of a text is the same for as long as the model and its task prefix are, so `embedQuery` keeps it per (prepared text, model,
 * endpoint) and reuses it. What the cache must not do:
 *
 * - **Answer another model's vector.** Ranking one model's vectors against another's returns plausible results in the wrong order. The key
 *   holds the model and the endpoint; a vector from another key is never reused.
 * - **Grow without bound, or keep a vector for ever.** At most `max` entries (the least recently used goes first) and each lives `ttlMs`.
 * - **Keep a failure.** A model call that failed is asked again next time.
 * - **Reach rights.** The cache holds vectors only, keyed by text and model: it imports nothing that names a space or a caller, so every
 *   hit still runs the same searches and the same rights filter as a miss.
 *
 * ## Seen red
 *
 * On d97660409 there is no `server/dist/brain/query-embedding-cache.js`, recall embeds every query (`await embed(query, 'query')`), and
 * its Server-Timing names no phase of its own.
 *
 * Run: npm run build:server, then node --test testing/standalone/recall-embeds-a-repeated-query-once.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const MODULE = 'server/dist/brain/query-embedding-cache.js';
const strip = s => s.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

async function cacheModule() {
  assert.ok(existsSync(MODULE), `there is no query embedding cache (${MODULE})`);
  return import(`../../${MODULE}`);
}

/** A model call that counts itself and answers a vector naming its text and model. */
function counted() {
  const calls = [];
  const compute = (text, model) => async () => { calls.push(`${model}:${text}`); return { vector: [text.length, model.length], model, dimensions: 2 }; };
  return { calls, compute };
}

describe('recall embeds a repeated query once', () => {
  it('a repeated text with the same model reuses the vector; another text or model does not', async () => {
    const { QueryEmbeddingCache } = await cacheModule();
    const cache = new QueryEmbeddingCache({ max: 10, ttlMs: 60_000 });
    const { calls, compute } = counted();
    const key = (text, model) => ({ input: text, model, endpoint: 'local' });
    const a = await cache.get(key('alpha', 'm1'), compute('alpha', 'm1'));
    const again = await cache.get(key('alpha', 'm1'), compute('alpha', 'm1'));
    assert.deepEqual(again, a, 'the kept vector is the one computed');
    assert.deepEqual(calls, ['m1:alpha'], 'the repeated text was embedded once');
    await cache.get(key('alpha', 'm2'), compute('alpha', 'm2'));
    await cache.get(key('beta', 'm1'), compute('beta', 'm1'));
    await cache.get({ input: 'alpha', model: 'm1', endpoint: 'http://other' }, compute('alpha', 'm1'));
    assert.deepEqual(calls, ['m1:alpha', 'm2:alpha', 'm1:beta', 'm1:alpha'], 'another model, text or endpoint is embedded again');
  });

  it('is bounded in entries and in time, and keeps no failure', async () => {
    const { QueryEmbeddingCache } = await cacheModule();
    let now = 1_000;
    const cache = new QueryEmbeddingCache({ max: 2, ttlMs: 500, now: () => now });
    const { calls, compute } = counted();
    const key = (text) => ({ input: text, model: 'm', endpoint: 'local' });
    await cache.get(key('a'), compute('a', 'm'));
    await cache.get(key('b'), compute('b', 'm'));
    await cache.get(key('a'), compute('a', 'm'));
    await cache.get(key('c'), compute('c', 'm'));
    assert.ok(cache.size() <= 2, `the cache holds at most its bound: ${cache.size()}`);
    await cache.get(key('b'), compute('b', 'm'));
    assert.deepEqual(calls, ['m:a', 'm:b', 'm:c', 'm:b'], 'the least recently used entry went first');
    now += 501;
    await cache.get(key('b'), compute('b', 'm'));
    assert.deepEqual(calls.slice(-1), ['m:b'], 'an entry past its time is embedded again');
    assert.equal(calls.length, 5);
    await assert.rejects(cache.get(key('x'), async () => { throw new Error('model down'); }), /model down/);
    await cache.get(key('x'), compute('x', 'm'));
    assert.deepEqual(calls.slice(-1), ['m:x'], 'a failed model call is asked again');
  });

  it('holds vectors only: it names no space and no caller, so rights filter every hit as every miss', () => {
    const src = strip(readFileSync('server/src/brain/query-embedding-cache.ts', 'utf8'));
    const imports = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1]);
    assert.deepEqual(imports.filter(p => /auth|rights|space|token|view/.test(p)), [], `the cache imports nothing of spaces or callers: ${imports.join(', ')}`);
  });

  it('recall embeds its query through the cache and names its phases', () => {
    const recall = strip(readFileSync('server/src/brain/recall.ts', 'utf8'));
    assert.doesNotMatch(recall, /await embed\(query, 'query'\)/, 'recall still embeds every query itself');
    assert.match(recall, /embedQuery\(query\)/, 'recall embeds its query through the cache');
    const timer = strip(readFileSync('server/src/http/phase-timer.ts', 'utf8'));
    for (const phase of ['embed', 'search', 'hydrate', 'rerank']) {
      assert.match(timer, new RegExp(`'${phase}'`), `the phase list names recall's ${phase}`);
      assert.match(recall, new RegExp(`timePhase\\('${phase}'`), `recall times its ${phase} phase`);
    }
  });
});
