/**
 * The contract of `POST /api/brain/spaces/:spaceId/reindex` — characterization, ahead of an extraction.
 *
 * ## Why this lands before the code moves
 *
 * **This paragraph is kept in the past tense on purpose, because the extraction it describes HAS SINCE HAPPENED**
 * and the file still earns its place as the net that made it safe. It read *"`reindex` is the last row of
 * `REST_ONLY_CAPABILITIES`"* — the list is now EMPTY, the re-embedding loop lives in `brain/reindex.ts`, and
 * `reindexTool` calls it. A docblock describing a future that arrived is the same defect as a stale sentence in a
 * schema description: nobody reports a capability they were told did not exist.
 *
 * `reindex` WAS the last row. It was the one capability that could not be given a tool by wrapping something,
 * because there was nothing to wrap: the re-embedding work was written INLINE in the route handler as five
 * near-identical batch loops — memories, entities, edges, chrono, files — each with its own projection, its own
 * `*EmbedText` builder and its own per-record error tolerance. Their own workaround measured the gap: they
 * reindexed 14 spaces plus 5 personal ones by curl in a shell loop, because the agent that planned their embedder
 * migration could not run it.
 *
 * So the loop had to come out, and that was a refactor of code with weak coverage. This is the net under it,
 * landed against the unmoved route for the reason the two earlier pairs had: a characterization test written in
 * the same commit as the change it guards cannot show which behaviour it was describing. **It goes on running
 * against the extracted code**, which is the whole point of writing it first.
 *
 * ## What is pinned at RUNTIME, and the one thing that cannot be
 *
 * Pinned here: the four answers (`404`, `400` on a proxy, `409` while running, `200 started`), that the response
 * arrives BEFORE the work, that the job guard is released afterwards, and — the part that matters most — that all
 * five collections actually come out with an embedding.
 *
 * **What the API cannot observe is WHICH TEXT was embedded.** The reindex loop writes `embedding` and
 * `embeddingModel` and deliberately does not write `matchedText`, so there is no way from outside to tell
 * `edgeEmbedText(from, label, to, …)` from `edgeEmbedText(label, from, to, …)` — both produce a vector. That is
 * exactly what an extraction of five similar loops is most likely to get wrong, and it is why
 * `reindex-embeds-the-same-text.test.js` exists beside this file as a source-level gate. Two checks because there
 * are two failure modes, and neither can see the other's.
 *
 * Run: node --test testing/integration/reindex-contract.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, delWithBody, waitFor } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `reindex-${RUN}`;
const MEMBER = `reindex-member-${RUN}`;
const PROXY = `reindex-proxy-${RUN}`;

let token;
const created = [];

async function makeSpace(id, body = {}) {
  const r = await post(INSTANCES.a, token, '/api/spaces', { id, label: id, ...body });
  assert.equal(r.status, 201, `space create failed: ${JSON.stringify(r.body)}`);
  created.push(id);
}

const reindex = (id) => post(INSTANCES.a, token, `/api/brain/spaces/${id}/reindex`, {});
const status = (id) => get(INSTANCES.a, token, `/api/brain/spaces/${id}/reindex-status`);

/** One record of every kind that the loop has a branch for. */
async function seedOneOfEach(id) {
  const mem = await post(INSTANCES.a, token, `/api/brain/spaces/${id}/memories`,
    { fact: `Reindex fact ${RUN}`, tags: ['reindex'] });
  assert.equal(mem.status, 201, JSON.stringify(mem.body));

  const from = await post(INSTANCES.a, token, `/api/brain/spaces/${id}/entities`, { name: `From-${RUN}`, type: 'concept' });
  const to = await post(INSTANCES.a, token, `/api/brain/spaces/${id}/entities`, { name: `To-${RUN}`, type: 'concept' });
  assert.equal(from.status, 201, JSON.stringify(from.body));

  const edge = await post(INSTANCES.a, token, `/api/brain/spaces/${id}/edges`,
    { from: from.body._id, to: to.body._id, label: `relates-${RUN}` });
  assert.equal(edge.status, 201, JSON.stringify(edge.body));

  const chrono = await post(INSTANCES.a, token, `/api/brain/spaces/${id}/chrono`,
    { title: `Reindex event ${RUN}`, type: 'event', startsAt: new Date().toISOString() });
  assert.equal(chrono.status, 201, JSON.stringify(chrono.body));

  // The path is a QUERY parameter, not a body field — `POST /api/files/:spaceId?path=…`.
  const fileUrl = `${INSTANCES.a}/api/files/${id}?path=${encodeURIComponent(`reindex-${RUN}.txt`)}`;
  const file = await fetch(fileUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ content: `Reindex file body ${RUN}`, encoding: 'utf8' }),
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  // 202: the write lands and the embedding is queued (`embeddingStatus: 'pending'`), which is precisely why a file
  // is worth seeding here — its vector arrives on a different path from the record.
  assert.ok([200, 201, 202].includes(file.status), `file write failed: ${file.status} ${JSON.stringify(file.body)}`);

  return { memoryId: mem.body._id, entityId: from.body._id, edgeId: edge.body._id, chronoId: chrono.body._id };
}

/** Records of one kind that carry an embedding, read through the query API rather than the database. */
async function embeddedCount(id, collection) {
  // `embedding` is always excluded from a query projection, so presence is asked about with $exists in the FILTER —
  // the one way to observe it from outside without reaching into Mongo.
  const r = await post(INSTANCES.a, token, '/api/brain/filter', { space: id, ...({ collection, filter: { embedding: { $exists: true } }, limit: 100 }) });
  assert.equal(r.status, 200, `query failed: ${JSON.stringify(r.body)}`);
  return r.body.count ?? (r.body.results ?? []).length;
}

before(async () => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  await makeSpace(SPACE);
  await makeSpace(MEMBER);
  await makeSpace(PROXY, { proxyFor: [MEMBER] });
});

after(async () => {
  for (const id of created.reverse()) {
    await delWithBody(INSTANCES.a, token, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
  }
});

describe('reindex — the four answers', () => {
  it('404 for a space that does not exist', async () => {
    const r = await reindex(`no-such-space-${RUN}`);
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.match(r.body.error, /not found/i);
  });

  it('400 for a PROXY space, naming its members in both the message and a field', async () => {
    // It used to answer `200 started` and then re-embed the members — which the caller was ALSO reindexing
    // individually, because they are in the same space list, so everything under the proxy was embedded twice. The
    // remedy is in the response because `GET /api/spaces` gives a caller nothing to branch on.
    const r = await reindex(PROXY);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /proxy space/i);
    assert.match(r.body.error, new RegExp(MEMBER), 'the message must NAME the members to reindex instead');
    assert.deepEqual(r.body.proxyFor, [MEMBER], 'and carry them as a field, so a client need not parse prose');
  });

  it('404 and a needsReindex flag on the status route', async () => {
    const missing = await status(`no-such-space-${RUN}`);
    assert.equal(missing.status, 404);

    const ok = await status(SPACE);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.spaceId, SPACE);
    assert.equal(typeof ok.body.needsReindex, 'boolean', 'the flag is what a caller polls; it must be a boolean');
  });
});

describe('reindex — it answers BEFORE it works, and releases its guard', () => {
  it('200 started, with a zeroed count, because the work has not happened yet', async () => {
    // The counts in this response are always 0/0 and deliberately so: the job starts on the next turn so headers
    // flush immediately. An extraction that awaited the work here would still answer 200 and would turn a
    // multi-minute job into a request timeout — which is why the SHAPE of this response is pinned, not just its code.
    await seedOneOfEach(SPACE);
    const r = await reindex(SPACE);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'started');
    assert.equal(r.body.spaceId, SPACE);
    assert.equal(r.body.reindexed, 0, 'the response is sent before the work, so its counters are zero');
    assert.equal(r.body.errors, 0);
  });

  it('accepts a SECOND reindex once the first has finished — the guard is released', async () => {
    // The `finally` that clears `reindexJobRunning`. If an extraction moved the work behind a function that throws
    // before reaching its own try/finally, the process would refuse every reindex from then on with 409 and only a
    // restart would clear it. Nothing else in the suite would notice.
    //
    // This kicks its OWN reindex rather than relying on the test above having run one. A guard test that passes
    // because nothing was ever running is the shape this whole file exists to avoid — it would report the guard
    // released without a guard ever having been taken.
    const first = await reindex(SPACE);
    assert.ok([200, 409].includes(first.status), `unexpected: ${first.status} ${JSON.stringify(first.body)}`);

    const second = await waitFor(async () => (await reindex(SPACE)).status === 200, 180_000, 1_000,
      'a second reindex kept answering 409, so the job guard was never released');
    assert.ok(second, 'a second reindex must eventually be accepted');
  });
});

describe('reindex — what the API can actually attribute to it', () => {
  it('leaves every collection embedded, in all five branches', async () => {
    // **What this does and does not prove.** A normally-written record already carries an embedding, so this cannot
    // show that the reindex is what produced one — the operation is idempotent by design. What it does show is that
    // a reindex over records of every kind leaves them all embedded: no branch throws, and none clears a vector it
    // fails to replace. Dropping a loop in the extraction would not fail this; dropping a loop that half-writes
    // would.
    //
    // The assertion that a branch used the RIGHT text is not observable here at all — the loop does not store
    // `matchedText` — and lives in `standalone/reindex-embeds-the-same-text.test.js`. Stated here so the pair is
    // read as one net rather than this file being mistaken for the whole of it.
    const seeded = { memories: 1, entities: 2, edges: 1, chrono: 1, files: 1 };

    await reindex(SPACE);
    for (const [collection, atLeast] of Object.entries(seeded)) {
      const got = await waitFor(async () => (await embeddedCount(SPACE, collection)) >= atLeast, 180_000, 2_000,
        `${collection}: fewer than ${atLeast} embedded record(s) after a reindex — a branch cleared or lost a vector`);
      assert.ok(got, `${collection} must have at least ${atLeast} embedded record(s) after a reindex`);
    }
  });

  it('does NOT bump seq or updatedAt — a re-embed is not a write', async () => {
    // This one IS attributable, and it is the property an extraction is most likely to break: the loop writes the
    // embedding fields with a direct `$set`, deliberately not through the record update path. Routing it through
    // `updateMemory`/`updateEntity` for tidiness would look correct and would bump `seq` on every record in the
    // space — which is a sync-visible change on every peer, for a local re-embed that changed no content. On the
    // reporting operator's instance that is 19 spaces of churn.
    const before = await post(INSTANCES.a, token, '/api/brain/filter', { space: SPACE, ...({ collection: 'memories', filter: {}, projection: { _id: 1, seq: 1, updatedAt: 1 }, limit: 20 }) });
    assert.equal(before.status, 200, JSON.stringify(before.body));
    const snapshot = new Map((before.body.results ?? []).map(r => [r._id, `${r.seq}|${r.updatedAt}`]));
    assert.ok(snapshot.size > 0, 'nothing to compare — the space has no memories');

    await reindex(SPACE);
    // Give the job time to have touched them; the assertion is about what did NOT change, so waiting longer is safe.
    await waitFor(async () => (await status(SPACE)).status === 200, 10_000, 1_000);
    await new Promise(r => setTimeout(r, 5_000));

    const after = await post(INSTANCES.a, token, '/api/brain/filter', { space: SPACE, ...({ collection: 'memories', filter: {}, projection: { _id: 1, seq: 1, updatedAt: 1 }, limit: 20 }) });
    for (const r of after.body.results ?? []) {
      const was = snapshot.get(r._id);
      if (!was) continue;
      assert.equal(`${r.seq}|${r.updatedAt}`, was,
        `memory ${r._id} had its seq/updatedAt changed by a reindex — that is a write, and it syncs`);
    }
  });
});
