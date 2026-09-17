/**
 * Integration tests: background duplicate scanner + per-space action rules
 *
 * Covers:
 *  - flag (default): scan records reviewable candidates with summaries + score
 *  - list + status filter (open / dismissed / all)
 *  - dismiss: candidate leaves the open list, appears under dismissed
 *  - manual re-rate: POST /:id/reopen brings a dismissed pair back onto the open list
 *  - content-gated resurface: a real content edit re-opens a dismissed pair (a bare re-write would
 *    not — that branch is exhaustively covered by testing/standalone/dupe-dismissed-sticky.test.js,
 *    since the public API cannot re-embed without also changing content)
 *  - automerge rule: a lossless entity pair is merged; candidate marked resolved
 *  - merge via API: POST /:id/merge merges an open entity candidate
 *
 * Entities are created via the brain API so they are embedded + $vectorSearch
 * visible; each pair uses a distinct topic so only intra-pair matches are found.
 *
 * Run: node --test testing/integration/dupe-scanner.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, waitForIndexed as waitForRecallable, waitForSimilarityIndex } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `dupescan-${RUN}`;
const SPACE_MERGE = `dupescan-merge-${RUN}`;
const SPACE_INSERT = `dupescan-insert-${RUN}`;

let tokenA;
let embeddingAvailable = false;

function token() { return tokenA; }

async function ensureReindexed(baseUrl, tok) {
  const { body } = await get(baseUrl, tok, '/api/spaces');
  for (const space of body?.spaces ?? []) {
    const { body: st } = await get(baseUrl, tok, `/api/brain/spaces/${space.id}/reindex-status`);
    if (st?.needsReindex) await post(baseUrl, tok, `/api/brain/spaces/${space.id}/reindex`, {});
  }
}

async function raw(method, urlPath, body) {
  const r = await fetch(`${INSTANCES.a}${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* no body */ }
  return { status: r.status, body: parsed };
}

async function createEntity(space, name, description) {
  const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${space}/entities`, { name, type: 'service', description, tags: [], waitForEmbedding: true });
  return r.status === 201 ? r.body._id : null;
}

/**
 * Wait for $vectorSearch to see these entities. Shared poll, shared deadline.
 *
 * This was the FIFTH copy, and the one a grep for the others' error message could never find — it said
 * "Timed out indexing:" instead of "Timed out waiting for indexing of:". It was caught by a gate that matches the
 * SHAPE of the poll rather than any of its names.
 */
/**
 * Wait until `$vectorSearch` can see the pair — NOT until `recall` can find them.
 *
 * The recall-based poll stopped answering this question at 5.0: every recall also scans the newest records
 * straight from the collection, so it returns as soon as a record is WRITTEN. Duplicate detection has no
 * such scan — it searches the index — so the old wait became a green light that means nothing here, and
 * the symptom was a scan finding no candidate pairs in a fixture that had "finished waiting".
 *
 * A pair is the right unit for this file anyway: every case needs BOTH records visible to the index, which
 * is exactly what a similarity search proves.
 */
const waitForIndexed = (space, ids, timeoutMs) =>
  waitForSimilarityIndex(INSTANCES.a, token(), space, ids[0], 'entity', ids[1], timeoutMs);

async function scan(space) {
  return raw('POST', `/api/duplicates/scan?space=${space}`);
}
async function listDupes(space, status = 'open') {
  const r = await raw('GET', `/api/duplicates?space=${space}&status=${status}`);
  return r.body?.duplicates ?? [];
}

// Fixed ids captured at setup
const ids = {};

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  for (const [id, label] of [[SPACE, `Dupe Scan ${RUN}`], [SPACE_MERGE, `Dupe Merge ${RUN}`], [SPACE_INSERT, `Dupe Insert ${RUN}`]]) {
    const r = await post(INSTANCES.a, token(), '/api/spaces', { id, label });
    assert.equal(r.status, 201, `create space ${id}: ${JSON.stringify(r.body)}`);
  }
  await ensureReindexed(INSTANCES.a, token());

  // Pair V (vault) and pair T (telemetry) in SPACE — distinct topics.
  ids.v1 = await createEntity(SPACE, `Vault Secret Service ${RUN}`, 'Vault secret storage service handling authentication token scoping and rotation on a schedule');
  ids.v2 = await createEntity(SPACE, `Vault Secrets Service ${RUN}`, 'Vault secret storage service handling authentication token scoping and rotation on a fixed schedule');
  ids.t1 = await createEntity(SPACE, `Telemetry Aggregator ${RUN}`, 'Telemetry aggregation pipeline collecting metrics from many downstream collectors continuously');
  ids.t2 = await createEntity(SPACE, `Telemetry Aggregation ${RUN}`, 'Telemetry aggregation pipeline collecting metrics from many downstream collectors non-stop');
  embeddingAvailable = !!(ids.v1 && ids.v2 && ids.t1 && ids.t2);

  // Pair M (merge) in SPACE_MERGE for the automerge rule.
  ids.m1 = await createEntity(SPACE_MERGE, `Billing Ledger ${RUN}`, 'Billing ledger service recording invoices and payment reconciliation for customer accounts');
  ids.m2 = await createEntity(SPACE_MERGE, `Billing Ledgers ${RUN}`, 'Billing ledger service recording invoices and payment reconciliation for customer accounts daily');

  if (embeddingAvailable) {
    await waitForIndexed(SPACE, [ids.v1, ids.v2, ids.t1, ids.t2]);
    await waitForIndexed(SPACE_MERGE, [ids.m1, ids.m2]);
  }
});

after(async () => {
  for (const space of [SPACE, SPACE_MERGE, SPACE_INSERT]) {
    await fetch(`${INSTANCES.a}/api/spaces/${space}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) }).catch(() => {});
  }
});

describe('Duplicate scanner — flag + review', () => {
  it('scan records candidate pairs with summaries and score', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    const s = await scan(SPACE);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const open = await listDupes(SPACE, 'open');
    // Expect the V pair and the T pair (2 distinct-topic candidates).
    assert.ok(open.length >= 2, `expected >=2 candidates, got ${open.length}`);
    const v = open.find(c => [c.aId, c.bId].sort().join() === [ids.v1, ids.v2].sort().join());
    assert.ok(v, 'vault pair recorded');
    assert.equal(v.type, 'entity');
    assert.equal(v.status, 'open');
    assert.ok(v.score >= 0.9, `score present (${v.score})`);
    assert.ok(v.aSummary && v.bSummary, 'both summaries present');
  });

  it('every candidate answers the same-or-opposite question, never with a bare absence', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    // The reported harm: a reversal of opinion arriving labelled as redundancy, and an automated pass merging
    // it. So the payload must always say what is KNOWN about the pair disagreeing — and crucially must
    // distinguish "checked and clean" from "nobody looked", because those license opposite actions.
    const open = await listDupes(SPACE, 'open');
    assert.ok(open.length > 0, 'need at least one candidate to inspect');
    for (const c of open) {
      assert.ok(c.contradiction, `every candidate must carry a contradiction signal: ${JSON.stringify(c)}`);
      assert.equal(typeof c.contradiction.checked, 'boolean');
      if (c.contradiction.checked === false) {
        assert.ok(['no-judge-configured', 'never-scanned'].includes(c.contradiction.reason),
          `unknown not-checked reason: ${JSON.stringify(c.contradiction)}`);
      } else {
        assert.equal(typeof c.contradiction.found, 'boolean');
        if (c.contradiction.found) {
          assert.ok(['structured-field', 'nli'].includes(c.contradiction.basis));
          assert.equal(typeof c.contradiction.confidence, 'number');
        }
      }
      // The cue is present only when true — never `false` on every pair, which would train readers to skip it.
      if ('negationAsymmetry' in c) assert.equal(c.negationAsymmetry, true);
    }
  });

  it('dismiss removes a pair from the open list', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    const open = await listDupes(SPACE, 'open');
    const v = open.find(c => [c.aId, c.bId].sort().join() === [ids.v1, ids.v2].sort().join());
    const d = await raw('POST', `/api/duplicates/${encodeURIComponent(v.id)}/dismiss`);
    assert.equal(d.status, 200, JSON.stringify(d.body));
    const openAfter = await listDupes(SPACE, 'open');
    assert.ok(!openAfter.some(c => c.id === v.id), 'dismissed pair not in open list');
    const dismissed = await listDupes(SPACE, 'dismissed');
    assert.ok(dismissed.some(c => c.id === v.id), 'dismissed pair in dismissed list');
  });

  it('manual re-rate (POST /:id/reopen) brings a dismissed pair back to the open list', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    // The V pair is dismissed from the previous test.
    const dismissed = await listDupes(SPACE, 'dismissed');
    const v = dismissed.find(c => [c.aId, c.bId].sort().join() === [ids.v1, ids.v2].sort().join());
    assert.ok(v, 'the V pair is on the dismissed list before re-rate');
    const r = await raw('POST', `/api/duplicates/${encodeURIComponent(v.id)}/reopen`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'open');
    const open = await listDupes(SPACE, 'open');
    assert.ok(open.some(c => c.id === v.id), 're-rated pair is back on the open list');
    const dismissedAfter = await listDupes(SPACE, 'dismissed');
    assert.ok(!dismissedAfter.some(c => c.id === v.id), 're-rated pair left the dismissed list');
    // Re-rating a pair that is not dismissed is a no-op 404 (it only lifts a dismissal).
    const again = await raw('POST', `/api/duplicates/${encodeURIComponent(v.id)}/reopen`);
    assert.equal(again.status, 404, 'reopen on an already-open pair is a 404');
  });

  it('a real content edit resurfaces a dismissed pair on the next scan', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    // Dismiss the V pair afresh (it is open again after the re-rate above), capturing its content
    // fingerprint...
    let open = await listDupes(SPACE, 'open');
    const v = open.find(c => [c.aId, c.bId].sort().join() === [ids.v1, ids.v2].sort().join());
    assert.ok(v, 'V pair is open before we dismiss it');
    assert.equal((await raw('POST', `/api/duplicates/${encodeURIComponent(v.id)}/dismiss`)).status, 200);
    // ...then MATERIALLY change V1's content. A bare re-write (re-embed/re-sync) would leave the
    // content hash unchanged and stay dismissed; this edit changes the embedded text, so the pair must
    // come back for review.
    const u = await raw('PATCH', `/api/brain/spaces/${SPACE}/entities/${ids.v1}`, { description: 'Vault secret storage service handling authentication token scoping and rotation on a nightly schedule now' });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    await scan(SPACE);
    open = await listDupes(SPACE, 'open');
    assert.ok(
      open.some(c => [c.aId, c.bId].sort().join() === [ids.v1, ids.v2].sort().join()),
      'the content-edited pair is back on the open list',
    );
  });

  it('merge via API merges an open entity candidate', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    const open = await listDupes(SPACE, 'open');
    const tPair = open.find(c => [c.aId, c.bId].sort().join() === [ids.t1, ids.t2].sort().join());
    assert.ok(tPair, 'telemetry pair present');
    const m = await raw('POST', `/api/duplicates/${encodeURIComponent(tPair.id)}/merge`);
    assert.equal(m.status, 200, JSON.stringify(m.body));
    assert.equal(m.body.status, 'merged');
    // One of the two entities is now gone.
    const e1 = await raw('GET', `/api/brain/spaces/${SPACE}/entities/${ids.t1}`);
    const e2 = await raw('GET', `/api/brain/spaces/${SPACE}/entities/${ids.t2}`);
    assert.ok((e1.status === 404) !== (e2.status === 404), 'exactly one telemetry entity survives');
    const all = await listDupes(SPACE, 'all');
    const resolved = all.find(c => c.id === tPair.id);
    assert.equal(resolved?.status, 'resolved');
  });
});

describe('Duplicate scanner — real-time (on insert)', () => {
  it('evaluates rules at insert time when dupeRulesOnInsert is enabled', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    // Enable real-time evaluation with a flag rule (no /scan will be called).
    const patch = await raw('PATCH', `/api/spaces/${SPACE_INSERT}`, { dupeRulesOnInsert: true, dupeRules: [{ minScore: 0.85, action: 'flag' }] });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));

    const i1 = await createEntity(SPACE_INSERT, `Support Ticket Router ${RUN}`, 'Support ticket routing service assigning incoming tickets to on-call engineers by topic');
    assert.ok(i1, 'first entity created');
    /*
     * `i1` must be visible to the INDEX before `i2` is written, and proving that needs a THIRD record.
     *
     * Insert-time evaluation runs `evalOneRecord` → `findSimilar`, which searches `$vectorSearch` and has
     * no fresh-write scan of its own. So the hook fires once, at i2's insert, and finds nothing if i1 has
     * not been ingested yet — which is exactly what happened when the recall-based poll stopped proving
     * indexing (every recall now also reads the newest records straight from the collection, so it returns
     * as soon as a record is WRITTEN).
     *
     * A similarity search proves it, and a similarity search needs a seed that is not the record under
     * test: the self-match is excluded. Hence the probe — written first, used only as a vantage point.
     * Its own indexing does not matter, because its vector is read from the collection.
     */
    const probe = await createEntity(SPACE_INSERT, `Index Probe ${RUN}`,
      'Support ticket routing service assigning incoming tickets to queues');
    assert.ok(probe, 'index probe created');
    await waitForSimilarityIndex(INSTANCES.a, token(), SPACE_INSERT, probe, 'entity', i1);

    // Insert a near-duplicate; the fire-and-forget insert-time hook should record it.
    const i2 = await createEntity(SPACE_INSERT, `Support Ticket Routing ${RUN}`, 'Support ticket routing service assigning incoming tickets to on-call engineers based on topic');
    assert.ok(i2, 'second entity created');

    // Poll (the hook is async/fire-and-forget) — but crucially we never call /scan.
    const deadline = Date.now() + 20_000;
    let found = null;
    while (Date.now() < deadline && !found) {
      const open = await listDupes(SPACE_INSERT, 'open');
      found = open.find(c => [c.aId, c.bId].sort().join() === [i1, i2].sort().join());
      if (!found) await new Promise(r => setTimeout(r, 500));
    }
    assert.ok(found, 'insert-time evaluation recorded the candidate without a scan');
    assert.equal(found.status, 'open');
  });
});

describe('Duplicate scanner — automerge rule', () => {
  it('a lossless entity pair is auto-merged by the rule', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    // Set an automerge rule on the merge space.
    const patch = await raw('PATCH', `/api/spaces/${SPACE_MERGE}`, { dupeRules: [{ minScore: 0.85, action: 'automerge' }] });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));

    const s = await scan(SPACE_MERGE);
    assert.equal(s.status, 200, JSON.stringify(s.body));

    // Exactly one billing entity should survive the auto-merge.
    const e1 = await raw('GET', `/api/brain/spaces/${SPACE_MERGE}/entities/${ids.m1}`);
    const e2 = await raw('GET', `/api/brain/spaces/${SPACE_MERGE}/entities/${ids.m2}`);
    assert.ok((e1.status === 404) !== (e2.status === 404), 'exactly one billing entity survives auto-merge');

    const all = await listDupes(SPACE_MERGE, 'all');
    const merged = all.find(c => [c.aId, c.bId].sort().join() === [ids.m1, ids.m2].sort().join());
    assert.ok(merged, 'automerge candidate recorded');
    assert.equal(merged.status, 'resolved');
    assert.equal(merged.resolution, 'merged');
  });
});
