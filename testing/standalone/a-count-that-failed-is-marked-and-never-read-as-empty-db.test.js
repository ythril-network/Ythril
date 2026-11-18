/**
 * A space whose count failed is marked `countsIncomplete` on `GET /api/spaces?counts=true` and on MCP `list_spaces`, and is never answered as an
 * empty space (bundle-38, Q-332).
 *
 * ## The defect it prevents
 *
 * The listing counted each space inside a `Promise.allSettled` and skipped a rejected count. REST then listed the space with no `counts` and said
 * nothing, so a client could not tell "the count failed" from "the count was not asked for"; MCP `list_spaces` answered
 * `{ facts: 0, entities: 0, edges: 0, chrono: 0 }` for it, which is what an empty space answers, and an agent that reads the counts to decide
 * whether a space is worth a recall left a space full of records alone.
 *
 * ## What is held
 *
 * With one space's facts collection made a view whose reads fail (`withCollectionAsView` with a pipeline that throws, a count that really fails
 * in the store, no stub), both doors answer 200 and list every space, name the failed space in `countsIncomplete` at the top level beside the
 * list (MCP: the structured half, whose list is `spaces`), give the failed space NO `counts` key, and still count the others. The failure is logged
 * and does not fail the listing. With every count succeeding the key is absent on both doors, and without `?counts=true` REST asks for no count
 * and so reports no failure.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-count-that-failed-is-marked-and-never-read-as-empty-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { withCollectionAsView } from './_write-faults.mjs';
import { logLinesDuring } from './_log-lines.mjs';
import { listenApp } from '../_shared/in-process-app.mjs';

const skip = await mongoSkipReason();
for (const k of ['SKIP_GLOBAL_RATE_LIMIT', 'SKIP_AUTH_RATE_LIMIT', 'SKIP_SYNC_RATE_LIMIT']) process.env[k] = 'true';
process.env['YTHRIL_RATE_LIMIT_PER_MINUTE'] ??= '1000000';

const BAD = 'qcount-bad';
const GOOD = 'qcount-good';
const OLD = '2026-01-01T00:00:00.000Z';
/** A pipeline that throws for the one source document below: the stage reads a string as an integer. A real failing count, in the store itself. */
const THROWING_READ = [{ $match: { $expr: { $gte: [{ $toInt: '$f' }, 0] } } }];

let door, server, base, adminKey, callTool, ADMIN;

const fact = (space, i, extra = {}) => ({ _id: `${space}-f${i}`, spaceId: space, fact: `fact ${i}`, tags: [], seq: i, pos: i, posAtSeq: i, createdAt: OLD, updatedAt: OLD, ...extra });

async function restList(query = '?counts=true') {
  const r = await fetch(`${base}/api/spaces${query}`, { headers: { authorization: `Bearer ${adminKey}` } });
  return { status: r.status, body: await r.json() };
}
async function mcpList() {
  const out = await callTool({
    name: 'list_spaces', args: {},
    caller: { rights: ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' },
  });
  assert.notEqual(out.result.isError, true, JSON.stringify(out.result));
  return { structured: out.result.structuredContent, text: JSON.parse(out.result.content.map(c => c.text).join('')) };
}
const entryOf = (spaces, id) => spaces.find(s => s.id === id);
/** Runs `fn` while every read of the BAD space's facts collection throws in the store. */
const whileCountFails = (fn) => withCollectionAsView(door.mongo.getDb(), `${BAD}_facts`, `${BAD}_facts_src`, fn, { pipeline: THROWING_READ });

describe('a space whose count failed is marked, not read as empty (real MongoDB)', { skip }, () => {
  before(async () => {
    door = await openPushDoor({
      suite: 'qcount',
      spaces: [
        { id: BAD, label: BAD, folders: [], meta: { suppressEmbeddings: true } },
        { id: GOOD, label: GOOD, folders: [], meta: { suppressEmbeddings: true } },
      ],
    });
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    const tokens = await import('../../server/dist/auth/tokens.js');
    adminKey = (await tokens.createToken({ name: 'qcount-admin', admin: true })).plaintext;
    server = await listenApp();
    base = server.url;
    await door.coll(GOOD, 'facts').insertMany([fact(GOOD, 1), fact(GOOD, 2)]);
    await door.coll(GOOD, 'entities').insertOne({ _id: 'e1', spaceId: GOOD, name: 'E', type: 'concept', tags: [], properties: {}, seq: 1, pos: 1, posAtSeq: 1, createdAt: OLD, updatedAt: OLD });
    await door.mongo.getDb().collection(`${BAD}_facts_src`).insertOne({ _id: 'bad', spaceId: BAD, f: 'not a number' });
  });
  after(async () => {
    await server?.close();
    await door?.close();
  });

  describe('with one space\'s count failing in the store', () => {
    it('GET /api/spaces?counts=true lists every space, names the failed one in countsIncomplete and gives it no counts', async () => {
      await whileCountFails(async () => {
        const { lines, result } = await logLinesDuring(() => restList());
        assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 200));
        assert.deepEqual(result.body.countsIncomplete, [BAD], `countsIncomplete ${JSON.stringify(result.body.countsIncomplete)}`);
        const bad = entryOf(result.body.spaces, BAD);
        assert.ok(bad, 'the listing left out the space whose count failed');
        assert.equal(Object.hasOwn(bad, 'counts'), false, `the failed space carries counts ${JSON.stringify(bad.counts)}`);
        assert.deepEqual(entryOf(result.body.spaces, GOOD)?.counts, { facts: 2, entities: 1, edges: 0, chrono: 0 }, 'the other space was not counted');
        assert.ok(lines.some(l => l.includes('Counting records failed') && l.includes(BAD)), `the failed count was not logged: ${lines.slice(0, 5).join(' | ')}`);
        // The same space still failing on the next listing is not news: the line is said once, not once per call.
        const again = await logLinesDuring(() => restList());
        assert.deepEqual(again.result.body.countsIncomplete, [BAD], 'the second listing no longer names the failed space');
        assert.equal(again.lines.filter(l => l.includes('Counting records failed')).length, 0, 'a second listing of the same failed space logged the failure again');
      });
    });

    it('MCP list_spaces names the failed space in countsIncomplete beside spaces, and answers no zeros for it', async () => {
      // A listing where every count succeeds clears what was said, so the failure below is logged as news.
      assert.equal((await restList()).body.countsIncomplete, undefined, 'the listing still names a failed space after the store recovered');
      await whileCountFails(async () => {
        const { lines, result } = await logLinesDuring(() => mcpList());
        assert.deepEqual(result.structured.countsIncomplete, [BAD], `countsIncomplete ${JSON.stringify(result.structured.countsIncomplete)}`);
        const bad = entryOf(result.structured.spaces, BAD);
        assert.ok(bad, 'the listing left out the space whose count failed');
        assert.equal(Object.hasOwn(bad, 'counts'), false, `the failed space is answered counts ${JSON.stringify(bad.counts)}: a space that holds three facts reads as an empty one`);
        assert.deepEqual(entryOf(result.structured.spaces, GOOD)?.counts, { facts: 2, entities: 1, edges: 0, chrono: 0 }, 'the other space was not counted');
        assert.ok(lines.some(l => l.includes('Counting records failed') && l.includes(BAD)), `the failed count was not logged: ${lines.slice(0, 5).join(' | ')}`);
      });
    });

    it('the text half of MCP list_spaces is still the bare array, and its failed space carries no counts either', async () => {
      await whileCountFails(async () => {
        const { text } = await mcpList();
        assert.ok(Array.isArray(text), 'the text half is no longer the bare array every client indexes');
        assert.equal(Object.hasOwn(entryOf(text, BAD), 'counts'), false);
      });
    });

    it('REST without ?counts=true asks for no count, so it reports no failure', async () => {
      await whileCountFails(async () => {
        const { status, body } = await restList('');
        assert.equal(status, 200);
        assert.equal(Object.hasOwn(body, 'countsIncomplete'), false);
        assert.equal(Object.hasOwn(entryOf(body.spaces, BAD), 'counts'), false);
      });
    });
  });

  describe('with every count succeeding', () => {
    // The view of the cases above is put back as an empty collection; the records the space holds are what a caller would miss if it were answered as empty.
    before(async () => { await door.coll(BAD, 'facts').insertMany([fact(BAD, 1), fact(BAD, 2), fact(BAD, 3)]); });
    it('GET /api/spaces?counts=true has no countsIncomplete key, and every space carries its counts', async () => {
      const { status, body } = await restList();
      assert.equal(status, 200);
      assert.equal(Object.hasOwn(body, 'countsIncomplete'), false, `countsIncomplete ${JSON.stringify(body.countsIncomplete)} on a listing whose counts all succeeded`);
      assert.deepEqual(entryOf(body.spaces, BAD)?.counts, { facts: 3, entities: 0, edges: 0, chrono: 0 });
      assert.deepEqual(entryOf(body.spaces, GOOD)?.counts, { facts: 2, entities: 1, edges: 0, chrono: 0 });
    });

    it('MCP list_spaces has no countsIncomplete key, and every space carries its counts', async () => {
      const { structured } = await mcpList();
      assert.equal(Object.hasOwn(structured, 'countsIncomplete'), false, `countsIncomplete ${JSON.stringify(structured.countsIncomplete)} on a listing whose counts all succeeded`);
      assert.deepEqual(entryOf(structured.spaces, BAD)?.counts, { facts: 3, entities: 0, edges: 0, chrono: 0 });
      assert.deepEqual(entryOf(structured.spaces, GOOD)?.counts, { facts: 2, entities: 1, edges: 0, chrono: 0 });
    });
  });
});
