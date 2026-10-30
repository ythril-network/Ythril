/**
 * Every Brain list defaults to LANDING order, on REST and on MCP, and the cross-space merge orders by it without ever answering it
 * (bundle-81 test 15; design rev 8 section 6a, vet decision 20; section 2, decision 11).
 *
 * ## The question a list answers
 *
 * "What landed here most recently", not "which version is newest". A record a peer delivered an hour ago at an old version is the
 * one an operator wants to see first after a sync; a list ordered by version buries it. Rev 7 moved two lists and left the other
 * three on their own defaults (`createdAt: -1`, natural order, `seq`), so a user guide sentence about "the default order" was true
 * for one tab of four. Now one constant, `LANDING_ORDER = {pos: -1, _id: -1}` exported from `brain/query.ts`, is every list's default:
 * `_id` alone breaks the legacy band's ties, which is what lets the `(pos,_id)` index serve it.
 *
 * ## The rule, over the whole set it governs
 *
 * - The collections are DERIVED (`BRAIN_COLLECTIONS`, with a floor), and every one is read through the shared `filter` tool, by MCP and
 *   by the generic REST door `POST /api/filter`, and the four that have a list function (facts, chrono, entities, edges) are read
 *   through it too, because the REST list routes take their default from the list function and never their own.
 * - The fixture makes landing order differ from EVERY other default: version (`seq`), `updatedAt`, `createdAt`, insertion order and
 *   `_id`. A pre-upgrade row (position in the legacy band, the newest version and dates) sits among rows that landed later at older
 *   versions, as a peer's delivery does. The expected order is stated as ids, identity by identity.
 * - A tie in position is broken by `_id`, descending; a row with no position (a carry in progress) sorts LAST.
 * - A record CREATED after the upgrade, through the real write tools, is listed first, above a pre-upgrade row whose version and dates
 *   are far above anything the create is stamped with.
 * - Across spaces, where two spaces' positions order the rows differently from their `updatedAt`, the merged answer is in position
 *   order, and no answer of any door carries `pos`, `posAtSeq` or `writtenHere`.
 *
 * The MCP schema's sentence about the default order, and `compareQueryOrder`, are held in the last case.
 *
 * Run: node --test testing/standalone/every-brain-list-defaults-to-landing-order-db.test.js  (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { build } from './_push-door.mjs';
import { handlerFor, fakeRes } from './_vote-round-instance.mjs';

const skip = await mongoSkipReason();
const A = 'b81lo-a';
const B = 'b81lo-b';
const CONFIG_PATH = path.join(os.tmpdir(), `ythril-b81-landing-${process.pid}.json`);
process.env['CONFIG_PATH'] = CONFIG_PATH;

/** A position in the clock band (microseconds since 1970, about 1.79e15), above everything in the legacy band. */
const CLOCK = 1_790_000_000_000_000;
const NEWEST = '2099-01-01T00:00:00.000Z';
const OLD = '2020-01-01T00:00:00.000Z';
const WITHHELD = ['pos', 'posAtSeq', 'writtenHere'];

/** One row of each collection, from the push door's builders; a collection with no builder here is a failure, not a skip. */
const BUILDERS = {
  facts: (s, id, seq, x) => build.fact(s, id, seq, x),
  entities: (s, id, seq, x) => build.entity(s, id, seq, x),
  edges: (s, id, seq, x) => build.edge(s, id, seq, x),
  chrono: (s, id, seq, x) => build.chrono(s, id, seq, x),
  links: (s, id, seq, x) => build.link(s, id, seq, x),
  files: (s, id, seq, x) => build.filemeta(s, id, seq, x),
};

describe('every Brain list defaults to landing order', { skip }, () => {
  let mongo; let query; let callTool; let toolsRouter; let rights; let COLLECTIONS; let lists;

  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'b81-landing', instanceLabel: 'b81', tokens: [], networks: [],
      spaces: [{ id: A, label: A, folders: [] }, { id: B, label: B, folders: [] }],
    }, null, 2), { mode: 0o600 });
    mongo = await openTestMongo('b81tD_landing');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    query = await import('../../server/dist/brain/query.js');
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    ({ toolsRouter } = await import('../../server/dist/api/tools.js'));
    const { BRAIN_COLLECTIONS } = await import('../../server/dist/config/types-knowledge.js');
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    rights = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    COLLECTIONS = [...BRAIN_COLLECTIONS];
    assert.ok(COLLECTIONS.length >= 5, `only ${COLLECTIONS.length} brain collections derived`);
    const missing = COLLECTIONS.filter(c => !BUILDERS[c]);
    assert.deepEqual(missing, [], `a brain collection this test has no row builder for: ${missing.join(', ')}`);
    // The four lists with a function of their own: the REST list routes call these and pass no default of theirs.
    const [facts, chrono, entities, edges] = await Promise.all([
      import('../../server/dist/brain/fact.js'), import('../../server/dist/brain/chrono.js'),
      import('../../server/dist/brain/entities.js'), import('../../server/dist/brain/list-edges.js'),
    ]);
    lists = {
      facts: (s) => facts.listFacts(s, {}, 100, 0), chrono: (s) => chrono.listChrono(s, {}, 100, 0),
      entities: (s) => entities.listEntities(s, {}, 100, 0), edges: (s) => edges.listEdges(s, {}, 100, 0),
    };
  });
  after(async () => { await closeTestMongo(); try { fs.unlinkSync(CONFIG_PATH); } catch { /* best effort */ } });

  beforeEach(async () => {
    for (const s of [A, B]) for (const c of COLLECTIONS) await mongo.col(`${s}_${c}`).deleteMany({});
  });

  let serial = 0;
  const caller = (transport) => { const id = `b81d-${++serial}`; return { rights, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport, tokenId: id, tokenLabel: id }; };
  /** `filter` through MCP and through the generic REST door: the rows of each answer. */
  const doors = {
    MCP: async (args) => {
      const out = await callTool({ name: 'filter', args, caller: caller('mcp') });
      assert.ok(!out.result.isError, `filter refused: ${(out.result.content ?? []).map(c => c.text).join(' ').slice(0, 200)}`);
      return out.result.structuredContent.results;
    },
    REST: async (args) => {
      const res = { ...fakeRes(), end() { this.sent = true; return this; }, setHeader() { return this; }, set() { return this; }, send(b) { this.body = b; this.sent = true; return this; } };
      await handlerFor(toolsRouter, 'post', '/:tool')({ method: 'POST', params: { tool: 'filter' }, body: args, query: {}, authToken: { rights }, ip: '127.0.0.1', headers: {}, get: () => undefined }, res);
      assert.ok(res.code < 400, `POST /api/filter answered ${res.code}: ${JSON.stringify(res.body).slice(0, 200)}`);
      return res.body.data.results;
    },
  };
  const ids = (rows) => rows.map(r => String(r._id));
  const noWithheld = (what, rows) => {
    for (const r of rows) for (const f of WITHHELD) assert.equal(f in r, false, `${what}: a row carries ${f}, which no answer may hand a caller`);
  };

  /**
   * Insertion order is [pre-a, post-1, none, pre-z, post-2]; versions, `updatedAt` and `createdAt` all put the pre-upgrade rows first;
   * landing order is post-2, post-1, pre-z, pre-a (the two pre rows tie in position, `_id` descending), then the row with no position.
   */
  async function seedLanding(space, coll) {
    const mk = BUILDERS[coll];
    const late = { createdAt: OLD, updatedAt: OLD };
    await mongo.col(`${space}_${coll}`).insertMany([
      mk(space, `${coll}-pre-a`, 1_000_000, { createdAt: NEWEST, updatedAt: NEWEST, pos: 100, posAtSeq: 1_000_000 }),
      mk(space, `${coll}-post-1`, 3, { ...late, pos: CLOCK + 1, posAtSeq: 3, writtenHere: false }),
      mk(space, `${coll}-none`, 2_000_000, { createdAt: NEWEST, updatedAt: NEWEST }),
      mk(space, `${coll}-pre-z`, 1_000_000, { createdAt: NEWEST, updatedAt: NEWEST, pos: 100, posAtSeq: 1_000_000 }),
      mk(space, `${coll}-post-2`, 4, { ...late, pos: CLOCK + 2, posAtSeq: 4, writtenHere: false }),
    ]);
    return [`${coll}-post-2`, `${coll}-post-1`, `${coll}-pre-z`, `${coll}-pre-a`, `${coll}-none`];
  }

  it('LANDING_ORDER is {pos: -1, _id: -1}, and the comparator the cross-space merge uses reads the same constant', () => {
    assert.deepEqual(query.LANDING_ORDER, { pos: -1, _id: -1 }, 'brain/query.ts exports no LANDING_ORDER, or exports another one');
    const rows = [{ _id: 'a', pos: 5 }, { _id: 'c', pos: 9 }, { _id: 'b', pos: 5 }, { _id: 'n' }];
    assert.deepEqual([...rows].sort(query.compareQueryOrder).map(r => r._id), ['c', 'b', 'a', 'n']);
  });

  for (const door of ['MCP', 'REST']) {
    it(`${door}: filter with no sort lists every collection in landing order, a tie by _id descending, a row with no position last`, async () => {
      for (const coll of COLLECTIONS) {
        const expected = await seedLanding(A, coll);
        const rows = await doors[door]({ space: A, collection: coll, limit: 50 });
        assert.deepEqual(ids(rows), expected, `${door} ${coll}: not in landing order`);
        noWithheld(`${door} ${coll}`, rows);
      }
    });
  }

  it('the four list functions the REST list routes call take the same default, and keep a row with no position last', async () => {
    for (const [coll, list] of Object.entries(lists)) {
      const expected = await seedLanding(A, coll);
      const got = ids(await list(A));
      assert.deepEqual(got, expected, `${coll}: the list function's own default is not landing order`);
    }
    assert.equal(Object.keys(lists).length, 4);
  });

  it('a record created after the upgrade is listed above a pre-upgrade row with a far newer version and date, on both doors', async () => {
    const created = {};
    const save = async (name, args) => {
      const out = await callTool({ name, args: { space: A, ...args }, caller: caller('mcp') });
      assert.ok(!out.result.isError, `${name} refused: ${(out.result.content ?? []).map(c => c.text).join(' ').slice(0, 300)}`);
      return out.result.structuredContent;
    };
    // The pre-upgrade rows: position in the legacy band, version and dates above anything a create is stamped with.
    for (const coll of ['facts', 'entities', 'chrono']) {
      await mongo.col(`${A}_${coll}`).insertOne(BUILDERS[coll](A, `${coll}-pre`, 1_000_000_000, { createdAt: NEWEST, updatedAt: NEWEST, pos: 100, posAtSeq: 1_000_000_000 }));
    }
    created.facts = await save('save_fact', { fact: 'a fact created after the upgrade', checkDuplicates: false, checkContradictions: false });
    created.entities = await save('save_entity', { name: 'created after the upgrade', type: 'thing', checkDuplicates: false, checkContradictions: false });
    created.chrono = await save('save_chrono', { title: 'created after the upgrade', type: 'event', startsAt: '2026-10-01T00:00:00.000Z', checkDuplicates: false, checkContradictions: false });
    await save('save_entity', { name: 'second end', type: 'thing', checkDuplicates: false, checkContradictions: false });
    // The id of each entity, read back by name rather than from an answer shape the plan does not fix.
    const entityId = async (name) => ids(await doors.MCP({ space: A, collection: 'entities', filter: { name }, limit: 1 }))[0];
    const [e1, e2] = [await entityId('created after the upgrade'), await entityId('second end')];
    assert.ok(e1 && e2, 'the entities just saved cannot be read back by name');
    await mongo.col(`${A}_edges`).insertOne(BUILDERS.edges(A, 'edges-pre', 1_000_000_000, { from: 'x', to: 'y', createdAt: NEWEST, updatedAt: NEWEST, pos: 100, posAtSeq: 1_000_000_000 }));
    created.edges = await save('save_edge', { from: e1, to: e2, label: 'relates to' });
    for (const door of ['MCP', 'REST']) {
      for (const coll of ['facts', 'entities', 'chrono', 'edges']) {
        const rows = await doors[door]({ space: A, collection: coll, limit: 50 });
        assert.ok(rows.length >= 2, `${door} ${coll}: fewer than two rows, so nothing is above anything`);
        assert.equal(String(rows[0]._id).endsWith('-pre'), false, `${door} ${coll}: the pre-upgrade row is listed first, above the record created after it (${ids(rows).join(', ')})`);
        assert.ok(ids(rows).indexOf(`${coll}-pre`) > 0, `${door} ${coll}: the pre-upgrade row is not below the created record`);
      }
    }
    for (const coll of ['facts', 'entities', 'chrono', 'edges']) {
      const got = ids(await lists[coll](A));
      assert.equal(got[0].endsWith('-pre'), false, `${coll}: the list function lists the pre-upgrade row above the record created after it`);
    }
  });

  it('across spaces the merge orders by position, whatever the spaces\' updatedAt order, and answers no position', async () => {
    for (const coll of COLLECTIONS) {
      const mk = BUILDERS[coll];
      // A's row landed LAST but was written OLD; B's rows landed earlier and were written NEW: position and updatedAt disagree.
      await mongo.col(`${A}_${coll}`).insertMany([
        mk(A, `${coll}-a-late`, 5, { createdAt: OLD, updatedAt: OLD, pos: CLOCK + 900, posAtSeq: 5 }),
        mk(A, `${coll}-a-early`, 6, { createdAt: OLD, updatedAt: OLD, pos: CLOCK + 100, posAtSeq: 6 }),
      ]);
      await mongo.col(`${B}_${coll}`).insertMany([
        mk(B, `${coll}-b-mid`, 7, { createdAt: NEWEST, updatedAt: NEWEST, pos: CLOCK + 500, posAtSeq: 7 }),
        mk(B, `${coll}-b-first`, 8, { createdAt: NEWEST, updatedAt: NEWEST, pos: CLOCK + 50, posAtSeq: 8 }),
      ]);
      const expected = [`${coll}-a-late`, `${coll}-b-mid`, `${coll}-a-early`, `${coll}-b-first`];
      for (const door of Object.keys(doors)) {
        const rows = await doors[door]({ space: [A, B], collection: coll, limit: 50 });
        assert.deepEqual(ids(rows), expected, `${door} ${coll}: the merged list is not in position order`);
        noWithheld(`${door} ${coll} (merged)`, rows);
        // And a page of it: the merge reads position for the order and strips it before the answer.
        const page = await doors[door]({ space: [A, B], collection: coll, limit: 2, skip: 1 });
        assert.deepEqual(ids(page), expected.slice(1, 3), `${door} ${coll}: a page of the merge is not the same slice of the order`);
        noWithheld(`${door} ${coll} (merged page)`, page);
      }
    }
  });

  it('the schema says what the order is, as a guarantee, and not as a list of keys', async () => {
    const { TOOLS_BY_NAME } = await import('../../server/dist/mcp/tools/index.js');
    const schema = JSON.stringify(TOOLS_BY_NAME.get('filter').inputSchema({ optionalSpace: {}, space: {}, requiredSpace: {} }))
      + TOOLS_BY_NAME.get('filter').description;
    assert.ok(/landed|landing/i.test(schema), 'the filter tool\'s description does not say the default order is landing order');
    assert.ok(!/seq\/updatedAt\/createdAt descending/.test(schema), 'the filter tool\'s description still names the old key list');
  });
});
