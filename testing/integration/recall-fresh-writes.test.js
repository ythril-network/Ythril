/**
 * Integration: a plain `recall` finds a record the vector index has not ingested yet.
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
 * ## It was `includeFreshWrites: true`, and it is no parameter at all now
 *
 * The flag was removed at 5.0 and the scan runs on every recall. Measured before removing it: a plain
 * recall answered `count: 0` for THREE seconds after a write, then found the record; always scanning costs
 * 159–167 ms against 91–101 ms on a space with 220 records inside the window, and nothing at all on a quiet
 * one. Owner: *"if checking the parameter takes >10ms remove the parameter and just always do it."*
 *
 * **So this file's subject changed shape and the assertions had to be rewritten rather than edited.** The
 * old pair — plain recall misses it, the flag finds it — cannot be expressed any more: there is only one
 * recall. What remains is the half that matters to a caller: write, search immediately, find it.
 *
 * ## Why there is no negative half
 *
 * There is nothing left to compare against. The old negative assertion was already tolerant — it diagnosed
 * rather than failed when the index had kept up, because demanding to lose a race with mongot is a flake.
 * With no flag, the honest test is the guarantee itself, and it does not race: the scan reads the
 * collection, which always has the record.
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

/**
 * The record inside a hit.
 *
 * A recall hit is `{score, spaceId, type, record: {...}}` on both doors since 5.0 — the ranking beside the
 * record rather than mixed into it. `POST /api/brain/recall` returned one FLAT object until the route
 * collapsed onto the shared tool module, so a test reading `r._id` is reading the shape that used to exist.
 */
const rec = (hit) => hit.record ?? {};

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

describe('recall reaches past the vector index without being asked to', () => {
  it('finds a record written a moment ago', async (t) => {
    if (!ready) return t.skip('embedding unavailable');
    // A phrase with no semantic neighbourhood, so only this record can match it.
    const phrase = `quokka lantern brine cassette ${RUN}`;
    const w = await P(`/api/brain/spaces/${SPACE}/facts`,
      { fact: `The ${phrase} protocol was ratified.`, tags: [], waitForEmbedding: true });
    assert.equal(w.status, 201, JSON.stringify(w.body));

    // Immediately — no wait, no parameter. That is the whole point.
    const r = await recall({ query: phrase, topK: 20, types: ['fact'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok((r.body.results ?? []).some(x => rec(x)._id === w.body._id),
      `a recall issued immediately after the write must return it: `
      + JSON.stringify(r.body.results?.map(x => rec(x)._id)));
  });

  it('a fresh hit is shaped exactly like an indexed one', async (t) => {
    if (!ready) return t.skip('embedding unavailable');
    // If a caller can tell which channel found a record, the scan stops being "search harder" and becomes a
    // second result type to handle.
    const phrase = `zither pumice halyard ${RUN}`;
    const w = await P(`/api/brain/spaces/${SPACE}/facts`,
      { fact: `A ${phrase} was recorded.`, tags: ['fresh-shape'], waitForEmbedding: true });
    const fresh = await recall({ query: phrase, topK: 20, types: ['fact'] });
    const hit = (fresh.body.results ?? []).find(r => rec(r)._id === w.body._id);
    assert.ok(hit, `the record must be found: ${JSON.stringify(fresh.body.results)}`);
    assert.equal(typeof hit.score, 'number', 'carries a score');
    assert.equal(hit.type, 'fact', 'carries its type');
    assert.equal(typeof rec(hit).fact, 'string', 'carries its per-type content field');
    assert.ok(Array.isArray(rec(hit).tags) && rec(hit).tags.includes('fresh-shape'), 'carries its tags');
  });

  it('and it honours the FILTER, which is what made the scan safe to run always', async (t) => {
    if (!ready) return t.skip('embedding unavailable');
    /*
     * The defect making the scan unconditional exposed, and the reason this case exists rather than a note.
     *
     * The scan adds records the vector index has not ingested. It added them UNFILTERED — survivable while
     * a caller had to opt in with `includeFreshWrites`, and a silent wrong answer the moment it ran on
     * every recall: a filtered search came back with a record that does not match the filter, at 200.
     *
     * Asserted with a filter that matches NOTHING, against a record written a moment ago so it can only
     * have come from the scan. A filter that matches everything would pass either way.
     */
    const phrase = `marmoset trellis obsidian ${RUN}`;
    const w = await P(`/api/brain/spaces/${SPACE}/facts`,
      { fact: `The ${phrase} clause was struck.`, tags: [], type: 'note', waitForEmbedding: true });
    assert.equal(w.status, 201, JSON.stringify(w.body));

    const matching = await recall({ query: phrase, topK: 20, types: ['fact'], filter: { type: 'note' } });
    assert.ok((matching.body.results ?? []).some(x => rec(x)._id === w.body._id),
      'a filter the record satisfies must still find it through the scan');

    const nothing = await recall({
      query: phrase, topK: 20, types: ['fact'], filter: { type: 'NOT-A-REAL-TYPE' },
    });
    assert.equal(nothing.status, 200, JSON.stringify(nothing.body));
    assert.ok(!(nothing.body.results ?? []).some(x => rec(x)._id === w.body._id),
      `the scan returned a record the filter excludes: ${JSON.stringify(nothing.body.results).slice(0, 300)}`);
  });

  it('the old flag is REFUSED rather than ignored', async (t) => {
    if (!ready) return t.skip('embedding unavailable');
    /*
     * The migration half, and the reason it is a test rather than a line in the release notes.
     *
     * A caller still sending `includeFreshWrites: true` is asking for behaviour they now get anyway, so
     * accepting and ignoring it would be harmless — and that is exactly the habit this codebase keeps
     * paying for. A 400 naming the field tells them to delete it; silence leaves a parameter in their code
     * that means nothing, until the day they read it and believe it.
     */
    const r = await recall({ query: 'probe', includeFreshWrites: true });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /includeFreshWrites/, 'the refusal must name the field so it can be deleted');
  });
});
