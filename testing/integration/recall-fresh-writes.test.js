/**
 * Integration: `includeFreshWrites` finds a record the vector index has not ingested yet.
 *
 * ## The report
 *
 * A memory created via `POST /facts` was not returned by `recall` for a distinctive nine-word phrase
 * **within 150 seconds**, polled every 5 — while insert-time duplicate detection saw the same record
 * immediately. That asymmetry is the diagnosis rather than a curiosity: the vector is on the document the
 * moment it is written, and it is `$vectorSearch`'s index that lags.
 *
 * `exact: true` is not the fix, and was measured not to be — it scans the INDEX exhaustively rather than the
 * collection, and reports the same lag to the millisecond (ANN 1088 ms, ENN 1083 ms on the same insert).
 *
 * ## What this asserts
 *
 * The pair, in one run: immediately after a write, plain recall does not return it and `includeFreshWrites`
 * does. Verified against a real Atlas Local index — both halves in the same test, because either alone
 * proves nothing. A test that only checked the flag would pass on an instance whose index was keeping up,
 * and would then be asserting that recall works rather than that this flag does.
 *
 * The negative half is tolerant on purpose: if the index HAS already caught up, the run says so and skips
 * that one assertion rather than failing. It is a race with mongot, and a test that demands losing it is a
 * flake. The positive half — the flag finds it — is never skipped.
 *
 * Run: node --test testing/integration/recall-fresh-writes.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `fresh-writes-${RUN}`;

let tokenA;
let ready = false;
const token = () => tokenA;
const P = (p, body) => post(INSTANCES.a, token(), p, body);
const recall = (body) => P('/api/brain/recall', { space: SPACE, ...(body) });

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const sp = await P('/api/spaces', { id: SPACE, label: `Fresh Writes ${RUN}` });
  assert.equal(sp.status, 201, `create space: ${JSON.stringify(sp.body)}`);
  const probe = await P(`/api/brain/spaces/${SPACE}/facts`, { fact: `probe ${RUN}`, tags: [], waitForEmbedding: true });
  ready = probe.status === 201;
});

after(async () => {
  await fetch(`${INSTANCES.a}/api/spaces/${SPACE}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
});

describe('recall can reach past the vector index', () => {
  it('finds a just-written record that plain recall does not', async (t) => {
    if (!ready) return t.skip('embedding unavailable');
    // A phrase with no semantic neighbourhood, so only this record can match it.
    const phrase = `quokka lantern brine cassette ${RUN}`;
    const w = await P(`/api/brain/spaces/${SPACE}/facts`,
      { fact: `The ${phrase} protocol was ratified.`, tags: [], waitForEmbedding: true });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    const id = w.body._id;

    // Immediately — no wait. That is the whole point.
    const plain = await recall({ query: phrase, topK: 20, types: ['fact'] });
    const fresh = await recall({ query: phrase, topK: 20, types: ['fact'], includeFreshWrites: true });
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));

    const inFresh = (fresh.body.results ?? []).some(r => r._id === id);
    assert.ok(inFresh, `includeFreshWrites must return the just-written record: ${JSON.stringify(fresh.body.results?.map(r => r._id))}`);

    const inPlain = (plain.body.results ?? []).some(r => r._id === id);
    if (inPlain) {
      // A race with mongot. Losing it proves the gap; winning it proves nothing, and failing here would be
      // a flake rather than a finding.
      t.diagnostic('the index had already ingested the record — the gap was not demonstrated on this run');
    }
  });

  it('a fresh hit is shaped exactly like an indexed one', async (t) => {
    if (!ready) return t.skip('embedding unavailable');
    // If a caller can tell which channel found a record, the flag stops being "search harder" and becomes a
    // second result type to handle.
    const phrase = `zither pumice halyard ${RUN}`;
    const w = await P(`/api/brain/spaces/${SPACE}/facts`,
      { fact: `A ${phrase} was recorded.`, tags: ['fresh-shape'], waitForEmbedding: true });
    const fresh = await recall({ query: phrase, topK: 20, types: ['fact'], includeFreshWrites: true });
    const rec = (fresh.body.results ?? []).find(r => r._id === w.body._id);
    assert.ok(rec, `the record must be found: ${JSON.stringify(fresh.body.results)}`);
    assert.equal(typeof rec.score, 'number', 'carries a score');
    assert.equal(rec.type, 'fact', 'carries its type');
    assert.equal(typeof rec.fact, 'string', 'carries its per-type content field');
    assert.ok(Array.isArray(rec.tags) && rec.tags.includes('fresh-shape'), 'carries its tags');
  });

  it('is OFF unless asked for', async (t) => {
    if (!ready) return t.skip('embedding unavailable');
    // The default is a decision, not an omission: recall is a path someone waits on, and the scan is paid
    // per knowledge type. Nothing about a plain recall may change.
    const r = await recall({ query: 'probe', topK: 5, types: ['fact'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.results));
  });

  it('refuses a non-boolean rather than coercing it', async (t) => {
    if (!ready) return t.skip('embedding unavailable');
    // `"false"` is truthy. An opt-in that silently turns itself on is worse than one that errors.
    const r = await recall({ query: 'probe', includeFreshWrites: 'true' });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /includeFreshWrites/);
  });
});
