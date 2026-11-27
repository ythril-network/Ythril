/**
 * A recall's query vector is kept for the caller who asked, never shown to another, and is counted (bundle-378, Q-976, fix round A: R3, L3.1,
 * L2.2, L3.4).
 *
 * ## The rule
 *
 * The query vector of a text is kept so a repeated query costs no model call (`brain/query-embedding-cache.ts`). A hit is visible: the
 * `embed` phase of `Server-Timing` (and the model call itself) is cheap or absent. A cache shared by every caller therefore tells any caller
 * whether anyone recalled that exact text in the last ten minutes. So:
 *
 *  1. the same caller's repeated text is embedded once; another caller's identical text is embedded again (a miss for them, as if nobody had
 *     asked it);
 *  2. a call with no caller identity shares nothing, so each of its calls embeds;
 *  3. a kept vector never replaces the rights filter: a caller whose rights narrowed since its first recall gets none of the records it may
 *     no longer read on the next recall of the same text (a hit);
 *  4. every lookup is counted, `ythril_cache_lookups_total{cache="query_vector",result}`, and the entries held are a gauge,
 *     `ythril_cache_entries{cache="query_vector"}`.
 *
 * ## Seen red
 *
 * On f91569511 the cache is keyed by text, model and endpoint only, so case 1's second caller is a hit (one embedder request, not two), a
 * call with no identity is a hit too, and neither metric exists. Case 3 holds on f91569511 as well: it guards the rights filter against a
 * cache that is later changed to keep results.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-recall-keeps-a-query-vector-for-its-caller-alone-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRecallCaller, adminRights, readerOf } from './_recall-caller.mjs';

const skip = await mongoSkipReason();
const S = 'qvc-open';
const T = 'qvc-closed';
const RECORDS = { [S]: [{ id: 'qvc-s-one', deg: 10, text: 'gear lever' }], [T]: [{ id: 'qvc-t-one', deg: 20, text: 'bolt washer' }] };

let r, admin;

/** How many requests the embedder has seen for `text`. */
const asked = (text) => r.embedder.inputs.filter(i => i.includes(text)).length;

describe('a recall keeps a query vector for its caller alone', { skip }, () => {
  before(async () => {
    r = await openRecallCaller({ suite: 'qvc', spaces: RECORDS });
    admin = await adminRights();
  });
  after(async () => { await r?.close(); });

  it('the same caller\'s repeated text is embedded once; another caller\'s identical text is embedded again', async () => {
    const text = 'qvc-first-probe-text';
    assert.equal((await r.recallAs('tok-a', admin, { query: text })).failed, false);
    assert.equal(asked(text), 1, 'the first recall embeds its text');
    assert.equal((await r.recallAs('tok-a', admin, { query: text })).failed, false);
    assert.equal(asked(text), 1, 'the same caller\'s repeated text was embedded again: nothing is kept');
    assert.equal((await r.recallAs('tok-b', admin, { query: text })).failed, false);
    assert.equal(asked(text), 2, 'another caller\'s identical text was answered from the first caller\'s vector: its embed phase tells it that text was recalled');
    assert.equal((await r.recallAs('tok-b', admin, { query: text })).failed, false);
    assert.equal(asked(text), 2, 'the second caller\'s own repeat was embedded again');
  });

  it('a call with no caller identity shares nothing: each of its calls embeds', async () => {
    const text = 'qvc-anonymous-probe-text';
    await r.recallAs(null, admin, { query: text });
    await r.recallAs(null, admin, { query: text });
    assert.equal(asked(text), 2, 'a call with no identity was served a vector kept for someone else');
  });

  it('a kept vector still meets the rights filter: a caller whose rights narrowed gets none of the records it may no longer read', async () => {
    const text = 'qvc-rights-probe-text';
    const wide = await r.recallAs('tok-r', admin, { query: text });
    assert.equal(wide.failed, false, wide.text.slice(0, 300));
    assert.ok(wide.text.includes('qvc-s-one') && wide.text.includes('qvc-t-one'), `the control recall answers both spaces' records: ${wide.text.slice(0, 300)}`);
    assert.equal(asked(text), 1);
    const narrow = await r.recallAs('tok-r', readerOf(S), { query: text });
    assert.equal(narrow.failed, false, narrow.text.slice(0, 300));
    assert.equal(asked(text), 1, 'the narrowed recall did not reuse the kept vector, so it proves nothing about the filter');
    assert.ok(narrow.text.includes('qvc-s-one'), 'the narrowed caller lost the record it may still read');
    assert.ok(!narrow.text.includes('qvc-t-one'), `a kept vector let the narrowed caller read a record of a space it may not: ${narrow.text.slice(0, 300)}`);
  });

  it('every lookup is counted by result, and the entries held are a gauge', async () => {
    const text = 'qvc-metric-probe-text';
    const lookups = async (result) => await r.metric('ythril_cache_lookups_total', { cache: 'query_vector', result });
    const hits0 = await lookups('hit');
    const misses0 = await lookups('miss');
    assert.notEqual(hits0, null, 'ythril_cache_lookups_total{cache="query_vector",result="hit"} is not declared');
    assert.notEqual(misses0, null, 'ythril_cache_lookups_total{cache="query_vector",result="miss"} is not declared');
    const entries0 = await r.metric('ythril_cache_entries', { cache: 'query_vector' });
    assert.notEqual(entries0, null, 'ythril_cache_entries{cache="query_vector"} is not declared');
    await r.recallAs('tok-m', admin, { query: text });
    await r.recallAs('tok-m', admin, { query: text });
    await r.recallAs('tok-m', admin, { query: text });
    assert.equal(await lookups('miss'), misses0 + 1, 'the first recall of a text is one miss');
    assert.equal(await lookups('hit'), hits0 + 2, 'its two repeats are two hits');
    assert.equal(await r.metric('ythril_cache_entries', { cache: 'query_vector' }), entries0 + 1, 'the entry the miss kept is counted');
  });
});
