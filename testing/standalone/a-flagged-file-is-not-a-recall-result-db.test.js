/**
 * A soft-deleted file's row is never a RECALL or SIMILAR result, and a recall still fills `topK` from the live rows (bundle-89, Q-418).
 *
 * ## The rule
 *
 * With `softDeleteFileMeta` on, a deleted file's row stays in `<space>_files` flagged `deletedAt`. A flagged row is not a
 * result. Recall's file branch (`recallByType`, which `similar` shares) never asked: a flagged row that still holds its
 * vector is ranked like a live one, and a deleted file came back as a hit.
 *
 * ## The Q-102 lesson this fixture is sized by
 *
 * A "not flagged" predicate applied AFTER the nearest-neighbour window silently drops live rows when flagged rows
 * crowd the window (`a-filtered-recall-never-misses-a-match-db.test.js`). So the fixture puts MORE flagged rows, all
 * nearer to the query than every live row, than EITHER window the file branch can use, and the window sizes are read
 * from the code that counts them (`annCandidates` / `perTypeFetch` for the plain path, `stageOneWindow` for the
 * predicate path), never written down here. A post-filter behind topK then returns none of the live rows and the case
 * is red for the stated reason; a native filter, or a completion from the collection, is green.
 *
 * ## What is asserted, by identity
 *
 * - topK = the number of live rows, recalled on BOTH doors (the REST route's own handler and MCP's `callTool`), the
 *   answer is exactly the live ids: every live row present, no flagged id.
 * - `similar` (`targetTypes: ['file']`) answers alike on both doors.
 * - The live set includes a CHUNK row (it carries `parentFileId` and no flag): a fix that borrowed `LIVE_FILE_ROW`
 *   (top-level only) would make every chunk invisible, which is what the plan's second, any-tier predicate exists to
 *   prevent. The chunk must stay returned.
 * - control: with a topK larger than the flagged crowd the live rows are all in the answer, so the index serves them
 *   and the red above is about the flagged rows and not about reachability.
 *
 * Run: a Mongo the harness accepts, then
 *      node --test testing/standalone/a-flagged-file-is-not-a-recall-result-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import {
  unitAt, queryAxis, startStubEmbedder, createSpaceCollections, insertAll, waitUntilServing,
} from './_vector-harness.mjs';

const skip = await mongoSkipReason();

const DIMS = 8;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b89e2c-recall-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
process.env['YTHRIL_HYBRID_SEARCH'] = 'off';
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'e2rec';
/** An hour old: outside the fresh-write window, so only the INDEX can supply these rows. */
const OLD = new Date(Date.now() - 3_600_000).toISOString();
const SOURCE = 'bbbbbbbb-0000-4000-8000-0000000e2001';
const CHUNK_ID = 'bbbbbbbb-0000-4000-8000-0000000e2002';

let mongo, stub, callTool, ADMIN, recallHandler, similarHandler;
/** The live ids (every one a row the answer must hold) and the flagged ids (none may be). */
const live = [];
const flagged = [];

const fileRow = (id, deg, extra = {}) => ({
  _id: id, spaceId: S, path: id, sizeBytes: 10, tags: [], description: `file ${id}`,
  embedding: unitAt(deg, DIMS), embeddingModel: 'stub', matchedText: `text of ${id}`,
  seq: 1, createdAt: OLD, updatedAt: OLD, ...extra,
});

/** The REST route's own handler for `POST <path>`, past rate limit and auth. */
function restHandler(router, routePath) {
  const layer = router.stack.find(l => l.route?.path === routePath && l.route.methods.post);
  assert.ok(layer, `no POST ${routePath} on the search router — re-anchor this test`);
  return layer.route.stack.at(-1).handle;
}

async function viaRest(handler, body) {
  const req = { method: 'POST', params: {}, query: {}, body, ip: '127.0.0.1', get: () => undefined, headers: {},
    authToken: { id: 't', name: 'test', rights: ADMIN } };
  const res = { code: 200, body: undefined, headersSent: false,
    status(c) { this.code = c; return this; }, setHeader() { return this; },
    json(b) { this.body = b; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; } };
  await handler(req, res);
  return { status: res.code, body: res.body };
}

async function viaMcp(name, args) {
  const out = await callTool({ name, args,
    caller: { rights: ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' } });
  const text = (out.result.content ?? []).map(c => c.text ?? '').join('\n');
  return { status: out.status, body: out.result.isError ? { error: text } : JSON.parse(text) };
}

const idsOf = (answer) => (answer.body?.results ?? []).map(r => String(r.record?._id ?? r._id));

const DOORS = [
  ['REST POST /api/brain/recall', (args) => viaRest(recallHandler, args)],
  ['MCP recall', (args) => viaMcp('recall', args)],
];
const SIMILAR_DOORS = [
  ['REST POST /api/brain/similar', (args) => viaRest(similarHandler, args)],
  ['MCP similar', (args) => viaMcp('similar', args)],
];

describe('a flagged file is not a recall or similar result', { skip }, () => {
  before(async () => {
    stub = await startStubEmbedder(() => queryAxis(DIMS));
    fs.mkdirSync(process.env['DATA_ROOT'], { recursive: true });
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify(
      { instanceId: 'b89e2c-recall', instanceLabel: 'test', tokens: [], networks: [], softDeleteFileMeta: true,
        spaces: [{ id: S, label: S, folders: [] }] }, null, 2), { mode: 0o600 });
    mongo = await openTestMongo('b89e2crecall');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    const presence = await import('../../server/dist/spaces/search-index-presence.js');
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    const { searchRouter } = await import('../../server/dist/api/brain/search.js');
    recallHandler = restHandler(searchRouter, '/recall');
    similarHandler = restHandler(searchRouter, '/similar');

    // The windows are READ from the code that counts them — a fixture sized off a copy of the number is the pitfall.
    const { perTypeFetch, annCandidates } = await import('../../server/dist/brain/search-bounds.js');
    const { stageOneWindow } = await import('../../server/dist/brain/predicate-recall.js');

    // Live: three top-level files and one CHUNK of the first (a chunk carries parentFileId and never the flag).
    const liveRows = [
      fileRow('live-a.md', 45), fileRow('live-b.md', 55), fileRow('live-c.md', 65),
      fileRow(CHUNK_ID, 75, { path: 'live-a.md', parentFileId: 'live-a.md', chunkIndex: 0, content: 'a chunk of live-a' }),
    ];
    live.push(...liveRows.map(r => r._id));
    const topK = liveRows.length;
    // The widest window a file-branch recall for `topK` can score: the plain path's candidates (recall over-fetches
    // 1.5x, similar by one) and the predicate path's stage-one window.
    const plain = Math.max(annCandidates(perTypeFetch(topK, 1.5)).numCandidates, annCandidates(topK + 1).numCandidates);
    const crowd = Math.max(plain, stageOneWindow(topK)) + 50;
    // Flagged: nearer than every live row (1-30 degrees), still holding their vectors — the rows a field instance has.
    const flaggedRows = Array.from({ length: crowd }, (_, i) =>
      fileRow(`gone-${String(i).padStart(5, '0')}.md`, 1 + (29 * i) / crowd, { deletedAt: OLD, seq: i + 10 }));
    flagged.push(...flaggedRows.map(r => r._id));

    await createSpaceCollections(mongo, S);
    await insertAll(mongo, `${S}_files`, [...liveRows, ...flaggedRows]);
    // The `similar` source: an entity at the query axis, with its vector stored.
    await mongo.col(`${S}_entities`).insertOne({ _id: SOURCE, spaceId: S, name: 'source', type: 'thing', tags: [], properties: {},
      embedding: unitAt(0, DIMS), embeddingModel: 'stub', seq: 1, createdAt: OLD, updatedAt: OLD });
    await presence.reconcileSpaceSearchIndexes(S, { waitForReady: true });
    await waitUntilServing(mongo, `${S}_files`, `${S}_files_embedding`, { dims: DIMS, n: liveRows.length + flaggedRows.length });
    await mongo.checkVectorSearchAvailability();
  });

  after(async () => {
    await closeTestMongo();
    await stub?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('fixture check: the flagged crowd is wider than every window a file-branch search scores', async () => {
    const { perTypeFetch, annCandidates } = await import('../../server/dist/brain/search-bounds.js');
    const { stageOneWindow } = await import('../../server/dist/brain/predicate-recall.js');
    const topK = live.length;
    const widest = Math.max(annCandidates(perTypeFetch(topK, 1.5)).numCandidates, stageOneWindow(topK));
    assert.ok(flagged.length > widest, `${flagged.length} flagged rows against a window of ${widest}: a post-filter could not be caught`);
    assert.equal(await mongo.col(`${S}_files`).countDocuments({ deletedAt: { $exists: true } }), flagged.length);
  });

  for (const [door, ask] of DOORS) {
    it(`control (${door}): with a topK past the crowd every live row is reachable`, async () => {
      const answer = await ask({ space: S, query: 'Q', topK: flagged.length + live.length + 10, types: ['file'], maxChars: 5_000_000 });
      assert.equal(answer.status, 200, JSON.stringify(answer.body).slice(0, 300));
      const got = new Set(idsOf(answer));
      const missing = live.filter(id => !got.has(id));
      assert.deepEqual(missing, [], `the index does not serve [${missing.join(', ')}] even with room — the red cases would be about reachability`);
    });

    it(`${door}: topK = the live rows answers exactly the live rows, a chunk included, and no flagged id`, async () => {
      const answer = await ask({ space: S, query: 'Q', topK: live.length, types: ['file'] });
      assert.equal(answer.status, 200, JSON.stringify(answer.body).slice(0, 300));
      const got = idsOf(answer);
      const flaggedGot = got.filter(id => id.startsWith('gone-'));
      assert.deepEqual(flaggedGot, [], `${flaggedGot.length} soft-deleted file row(s) came back as results (first: ${flaggedGot.slice(0, 3).join(', ')})`);
      assert.deepEqual([...got].sort(), [...live].sort(),
        `got [${got.slice(0, 8).join(', ')}]: topK must be filled from every LIVE row whatever its rank behind the `
        + `${flagged.length} nearer flagged rows — a flag applied after the window drops live rows, and one borrowed from `
        + 'the top-level-only predicate drops the chunk');
    });
  }

  for (const [door, ask] of SIMILAR_DOORS) {
    it(`${door}: similar to an entity over files answers the live rows and no flagged id`, async () => {
      const answer = await ask({ space: S, entryId: SOURCE, entryType: 'entity', targetTypes: ['file'], topK: live.length });
      assert.equal(answer.status, 200, JSON.stringify(answer.body).slice(0, 300));
      const got = idsOf(answer);
      const flaggedGot = got.filter(id => id.startsWith('gone-'));
      assert.deepEqual(flaggedGot, [], `${flaggedGot.length} soft-deleted file row(s) came back as similar results (first: ${flaggedGot.slice(0, 3).join(', ')})`);
      assert.deepEqual([...got].sort(), [...live].sort(),
        `got [${got.slice(0, 8).join(', ')}]: similar shares recall's file branch and must fill topK from the live rows`);
    });
  }
});
