/**
 * A withheld field is never answered on any door, for any projection, and no predicate can read it (`Q-446`, `Q-357`).
 *
 * ## The rule, asked of the real store on every door
 *
 * `NEVER_RETURNED_FIELDS` — the vector, `deliveredBy` and the write guard — is what no read returns. Before Q-446:
 *  - `filter` (REST and MCP: one handler) handed the store `withoutWriteGuard(mergeEmbeddingExclusion(projection))`,
 *    which never named `deliveredBy`, so EVERY filter answer carried the peer that delivered each record, and
 *    `{embedding: 1}` became `{}` — the store's "every field";
 *  - `{_id: 1}` read as an exclusion of nothing, so it answered every field on filter, recall, similar and
 *    graph_traverse while the integration guide promised ids only;
 *  - a predicate on a withheld field answered, so its value could be read one bit at a time.
 *
 * Each door is driven as its caller drives it: the REST route's own handler (the generic tool door for `filter`,
 * `POST /api/brain/recall`, `/similar`, `/spaces/:spaceId/traverse`) and MCP's `callTool`. The doors are DERIVED
 * from one table below and every case runs over all of them; the withheld set is read from the build with a floor.
 *
 * Fixture: one space, three entities joined by two stored edges, every record holding every withheld field — a
 * vector, a `deliveredBy` peer id, and a write-guard marker — inserted as a synced record would hold them.
 *
 * Run: a Mongo the harness accepts (`npm run test:up`), then
 *      node --test testing/standalone/a-withheld-field-is-never-answered-on-any-door-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { unitAt, queryAxis, startStubEmbedder, createSpaceCollections, insertAll, waitUntilServing } from './_vector-harness.mjs';
import { routeHandler, viaRest as restDoor, viaMcp as mcpDoor } from '../_shared/route-and-tool-doors.mjs';

const skip = await mongoSkipReason();

const DIMS = 8;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-q446-doors-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
process.env['YTHRIL_HYBRID_SEARCH'] = 'off';
for (const k of ['SKIP_GLOBAL_RATE_LIMIT', 'SKIP_AUTH_RATE_LIMIT']) process.env[k] = 'true';

const S = 'q446w';
const OLD = new Date(Date.now() - 3_600_000).toISOString();
const PEER = 'peer-instance-that-delivered-it';
const ID = { a: 'aaaaaaaa-0000-4000-8000-000000446001', b: 'aaaaaaaa-0000-4000-8000-000000446002', c: 'aaaaaaaa-0000-4000-8000-000000446003' };
const EDGE = { ab: 'aaaaaaaa-0000-4000-8000-000000446101', bc: 'aaaaaaaa-0000-4000-8000-000000446102' };

let mongo, stub, callTool, ADMIN, WITHHELD, handlers;

/** Every withheld field, holding a value a leak would carry. Read from the build in `before`. */
const withheldValues = (id) => Object.fromEntries(WITHHELD.map(f =>
  [f, f === 'embedding' ? null : f === 'deliveredBy' ? PEER : `withheld-${f}-${id}`]));

const entity = (id, name, deg) => ({
  _id: id, spaceId: S, name, type: 'service', tags: ['q446'], description: `the ${name} service`,
  properties: { status: 'open' }, seq: 1, createdAt: OLD, updatedAt: OLD,
  author: { instanceId: 'q446', instanceLabel: 'q446' },
  ...withheldValues(id), embedding: unitAt(deg, DIMS), embeddingModel: 'stub',
});
const edge = (id, from, to, label, deg) => ({
  _id: id, spaceId: S, from, to, label, description: `${label} edge`, tags: [], properties: {}, seq: 1,
  createdAt: OLD, updatedAt: OLD, author: { instanceId: 'q446', instanceLabel: 'q446' },
  ...withheldValues(id), embedding: unitAt(deg, DIMS), embeddingModel: 'stub',
});

/** Both doors, driven as admin through the shared drivers. */
const viaRest = (handler, body, params = {}) => restDoor(handler, body, { rights: ADMIN, params });
const viaMcp = (name, args) => mcpDoor(callTool, name, args, { rights: ADMIN });

/** The doors, per capability. A case runs over every door its capability has. */
const DOORS = {
  filter: [
    ['REST POST /api/filter', (a) => viaRest(handlers.tool, a, { tool: 'filter' })],
    ['MCP filter', (a) => viaMcp('filter', a)],
  ],
  recall: [
    ['REST POST /api/brain/recall', (a) => viaRest(handlers.recall, a)],
    ['MCP recall', (a) => viaMcp('recall', a)],
  ],
  similar: [
    ['REST POST /api/brain/similar', (a) => viaRest(handlers.similar, a)],
    ['MCP similar', (a) => viaMcp('similar', a)],
  ],
  graph_traverse: [
    ['REST POST /api/brain/spaces/:spaceId/traverse', (a) => viaRest(handlers.traverse, a, { spaceId: S })],
    ['MCP graph_traverse', (a) => viaMcp('graph_traverse', a)],
  ],
};

/** The request each capability is asked, with a projection (or none) spliced in. */
const ASK = {
  filter: (p) => ({ space: S, collection: 'entities', filter: {}, limit: 50, ...p }),
  recall: (p) => ({ space: S, query: 'Q', topK: 3, types: ['entity'], maxChars: 2_000_000, ...p }),
  recallGraph: (p) => ({ space: S, query: 'Q', topK: 3, types: ['entity'], traverse: 1, maxChars: 2_000_000, ...p }),
  similar: (p) => ({ space: S, entryId: ID.a, entryType: 'entity', targetTypes: ['entity'], topK: 3, maxChars: 2_000_000, ...p }),
  graph_traverse: (p) => ({ space: S, startId: ID.a, direction: 'outbound', maxDepth: 3, ...p }),
};

/** Every place in an answer that holds a withheld key, as `path.key`. The whole answer is walked: a leak anywhere counts. */
function leaksIn(v, at = '$', out = []) {
  if (Array.isArray(v)) v.forEach((x, i) => leaksIn(x, `${at}[${i}]`, out));
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (WITHHELD.includes(k)) out.push(`${at}.${k}`);
      leaksIn(x, `${at}.${k}`, out);
    }
  }
  return out;
}

const rowsOf = (cap, body) => cap === 'graph_traverse'
  ? null
  : (Array.isArray(body) ? body : body?.results ?? []);

describe('a withheld field is never answered on any door', { skip }, () => {
  before(async () => {
    stub = await startStubEmbedder(() => queryAxis(DIMS));
    fs.mkdirSync(process.env['DATA_ROOT'], { recursive: true });
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify(
      { instanceId: 'q446-doors', instanceLabel: 'test', tokens: [], networks: [], spaces: [{ id: S, label: S, folders: [], completeLinkage: true }] },
      null, 2), { mode: 0o600 });
    mongo = await openTestMongo('q446doors');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    ({ NEVER_RETURNED_FIELDS: WITHHELD } = await import('../../server/dist/brain/recall-shape.js'));
    const presence = await import('../../server/dist/spaces/search-index-presence.js');
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    const { searchRouter } = await import('../../server/dist/api/brain/search.js');
    const { toolsRouter } = await import('../../server/dist/api/tools.js');
    handlers = {
      tool: routeHandler(toolsRouter, '/:tool'),
      recall: routeHandler(searchRouter, '/recall'),
      similar: routeHandler(searchRouter, '/similar'),
      traverse: routeHandler(searchRouter, '/spaces/:spaceId/traverse'),
    };

    await createSpaceCollections(mongo, S);
    await insertAll(mongo, `${S}_entities`, [entity(ID.a, 'alpha', 10), entity(ID.b, 'beta', 20), entity(ID.c, 'gamma', 30)]);
    await insertAll(mongo, `${S}_edges`, [edge(EDGE.ab, ID.a, ID.b, 'depends_on', 40), edge(EDGE.bc, ID.b, ID.c, 'triggers', 50)]);
    await presence.reconcileSpaceSearchIndexes(S, { waitForReady: true });
    await waitUntilServing(mongo, `${S}_entities`, `${S}_entities_embedding`, { dims: DIMS, n: 3 });
    await mongo.checkVectorSearchAvailability();
  });

  after(async () => {
    await closeTestMongo();
    await stub?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('fixture check: the withheld set has a floor and every stored record holds every member of it', async () => {
    assert.ok(WITHHELD.length >= 3, `NEVER_RETURNED_FIELDS holds ${WITHHELD.length}`);
    for (const coll of ['entities', 'edges']) {
      for (const doc of await mongo.col(`${S}_${coll}`).find({}).toArray()) {
        const missing = WITHHELD.filter(f => doc[f] === undefined || doc[f] === null);
        assert.deepEqual(missing, [], `${coll} ${doc._id} lacks ${missing.join(', ')}: a leak of it could not be seen`);
      }
    }
  });

  it('control: every door answers the fixture (so an empty answer cannot pass a leak check)', async () => {
    const wrong = [];
    for (const [cap, ask] of [['filter', ASK.filter], ['recall', ASK.recall], ['similar', ASK.similar], ['graph_traverse', ASK.graph_traverse]]) {
      for (const [door, call] of DOORS[cap]) {
        const a = await call(ask({}));
        if (a.failed) { wrong.push(`${door}: ${a.error.slice(0, 200)}`); continue; }
        const n = cap === 'graph_traverse' ? (a.body?.nodes?.length ?? 0) : rowsOf(cap, a.body).length;
        if (n < 2) wrong.push(`${door}: ${n} rows`);
      }
    }
    assert.deepEqual(wrong, []);
  });

  /** Projections the rule is asked over, per withheld field, absent included. */
  const projections = () => [
    ['absent', {}],
    ['{_id:0}', { projection: { _id: 0 } }],
    ['{description:0}', { projection: { description: 0 } }],
    ['{name:1}', { projection: { name: 1 } }],
    ...WITHHELD.flatMap(f => [
      [`{${f}:1}`, { projection: { [f]: 1 } }],
      [`{_id:0,${f}:1}`, { projection: { _id: 0, [f]: 1 } }],
      [`{${f}:1,name:1}`, { projection: { [f]: 1, name: 1 } }],
      [`{'${f}.x':1}`, { projection: { [`${f}.x`]: 1 } }],
    ]),
  ];

  for (const cap of ['filter', 'recall', 'recallGraph', 'similar', 'graph_traverse']) {
    it(`${cap}: no withheld field anywhere in the answer, on either door, for any projection (absent included)`, async () => {
      const doors = DOORS[cap === 'recallGraph' ? 'recall' : cap];
      const wrong = [];
      for (const [door, call] of doors) {
        for (const [label, extra] of projections()) {
          for (const diag of [false, true]) {
            const a = await call(ASK[cap]({ ...extra, ...(diag ? { includeDiagnostics: true } : {}) }));
            if (a.failed) { wrong.push(`${door} ${label}${diag ? ' +diagnostics' : ''}: failed: ${a.error.slice(0, 160)}`); continue; }
            const l = leaksIn(a.body);
            if (l.length) wrong.push(`${door} ${label}${diag ? ' +diagnostics' : ''}: ${[...new Set(l.map(p => p.split('.').at(-1)))].join(', ')} at ${l.slice(0, 2).join(', ')}`);
          }
        }
      }
      assert.deepEqual(wrong, [], 'a withheld field reached an answer');
    });
  }

  it('recall: a _graph hop carries no withheld field with no projection (stripDiag is not the only thing standing there)', async () => {
    for (const [door, call] of DOORS.recall) {
      const a = await call(ASK.recallGraph({}));
      assert.equal(a.failed, false, `${door}: ${a.error}`);
      const hops = (a.body.results ?? []).flatMap(r => r._graph ?? []);
      assert.ok(hops.length >= 1, `${door}: the fixture produced no _graph hop, so this proves nothing`);
      assert.deepEqual(leaksIn(hops), [], `${door}: a hop carried a withheld field`);
    }
  });

  it('filter: {embedding:1}, {_id:0, embedding:1} and {_id:1} answer exactly {_id} per row, on both doors', async () => {
    const wrong = [];
    for (const [door, call] of DOORS.filter) {
      for (const p of [{ embedding: 1 }, { _id: 0, embedding: 1 }, { _id: 1 }, { _id: true }, ...WITHHELD.map(f => ({ [f]: 1 }))]) {
        const a = await call(ASK.filter({ projection: p }));
        if (a.failed) { wrong.push(`${door} ${JSON.stringify(p)}: failed: ${a.error}`); continue; }
        const rows = rowsOf('filter', a.body);
        if (rows.length !== 3) wrong.push(`${door} ${JSON.stringify(p)}: ${rows.length} rows`);
        const shapes = [...new Set(rows.map(r => JSON.stringify(Object.keys(r).sort())))];
        if (shapes.length !== 1 || shapes[0] !== '["_id"]') wrong.push(`${door} ${JSON.stringify(p)}: rows are ${shapes.join(' | ')}`);
      }
    }
    assert.deepEqual(wrong, []);
  });

  it('filter: {_id:0} answers every stored field but _id and the withheld ones (with diagnostics on, nothing else is held back)', async () => {
    const stored = await mongo.col(`${S}_entities`).find({}).toArray();
    const want = (doc) => Object.keys(doc).filter(k => k !== '_id' && !WITHHELD.includes(k)).sort();
    const wrong = [];
    for (const [door, call] of DOORS.filter) {
      const a = await call(ASK.filter({ projection: { _id: 0 }, includeDiagnostics: true }));
      if (a.failed) { wrong.push(`${door}: failed: ${a.error}`); continue; }
      for (const row of rowsOf('filter', a.body)) {
        const doc = stored.find(d => d.name === row.name);
        if (!doc) { wrong.push(`${door}: a row matches no stored record: ${JSON.stringify(row).slice(0, 120)}`); continue; }
        const got = Object.keys(row).sort();
        if (JSON.stringify(got) !== JSON.stringify(want(doc))) wrong.push(`${door} ${row.name}: ${JSON.stringify(got)} where the rule gives ${JSON.stringify(want(doc))}`);
      }
    }
    assert.deepEqual(wrong, []);
  });

  for (const cap of ['recall', 'similar']) {
    it(`${cap}: {_id:1} makes each record exactly {_id}; score, spaceId and type stay on the hit`, async () => {
      const wrong = [];
      for (const [door, call] of DOORS[cap]) {
        for (const p of [{ _id: 1 }, { embedding: 1 }, { _id: 0, embedding: 1 }]) {
          const a = await call(ASK[cap]({ projection: p }));
          if (a.failed) { wrong.push(`${door} ${JSON.stringify(p)}: failed: ${a.error.slice(0, 160)}`); continue; }
          const hits = a.body.results ?? [];
          if (hits.length < 2) wrong.push(`${door} ${JSON.stringify(p)}: ${hits.length} hits`);
          for (const h of hits) {
            if (JSON.stringify(Object.keys(h.record ?? {}).sort()) !== '["_id"]') wrong.push(`${door} ${JSON.stringify(p)}: record is ${JSON.stringify(Object.keys(h.record ?? {}).sort())}`);
            for (const k of ['score', 'spaceId', 'type']) if (h[k] === undefined) wrong.push(`${door} ${JSON.stringify(p)}: the hit lost ${k}`);
          }
        }
      }
      assert.deepEqual([...new Set(wrong)], []);
    });
  }

  it("recall's _graph: {_id:1} makes every hop's node and edge exactly {_id} (edges keep their direction only if projected)", async () => {
    const wrong = [];
    for (const [door, call] of DOORS.recall) {
      const a = await call(ASK.recallGraph({ projection: { _id: 1 } }));
      if (a.failed) { wrong.push(`${door}: failed: ${a.error.slice(0, 160)}`); continue; }
      const hops = (a.body.results ?? []).flatMap(r => r._graph ?? []);
      if (hops.length < 1) wrong.push(`${door}: no hop`);
      for (const h of hops) {
        if (JSON.stringify(Object.keys(h.node ?? {}).sort()) !== '["_id"]') wrong.push(`${door}: hop node is ${JSON.stringify(Object.keys(h.node ?? {}).sort())}`);
        for (const e of h.edges ?? []) if (JSON.stringify(Object.keys(e).sort()) !== '["_id"]') wrong.push(`${door}: hop edge is ${JSON.stringify(Object.keys(e).sort())}`);
      }
    }
    assert.deepEqual([...new Set(wrong)], []);
  });

  it('graph_traverse: {_id:1} is the lean answer — a node {_id, depth[, kind]}, an edge {_id, from, to, label}', async () => {
    const wrong = [];
    for (const [door, call] of DOORS.graph_traverse) {
      for (const p of [{ _id: 1 }, { embedding: 1 }, { _id: 0, embedding: 1 }]) {
        const a = await call(ASK.graph_traverse({ projection: p }));
        if (a.failed) { wrong.push(`${door} ${JSON.stringify(p)}: failed: ${a.error.slice(0, 160)}`); continue; }
        const nodes = a.body.nodes ?? [];
        const edges = a.body.edges ?? [];
        if (nodes.length < 2 || edges.length < 1) wrong.push(`${door} ${JSON.stringify(p)}: ${nodes.length} nodes, ${edges.length} edges`);
        for (const n of nodes) {
          const extra = Object.keys(n).filter(k => !['_id', 'depth', 'kind'].includes(k));
          if (extra.length) wrong.push(`${door} ${JSON.stringify(p)}: a node carries ${extra.sort().join(', ')}`);
        }
        for (const e of edges) {
          const extra = Object.keys(e).filter(k => !['_id', 'from', 'to', 'label'].includes(k));
          if (extra.length) wrong.push(`${door} ${JSON.stringify(p)}: an edge carries ${extra.sort().join(', ')}`);
        }
      }
    }
    assert.deepEqual([...new Set(wrong)], []);
  });

  describe('a predicate cannot read a withheld field (item 5)', () => {
    /** Raw MongoDB predicates naming a withheld field directly — refused on filter and on recall's raw grammar. */
    const rawRefused = () => WITHHELD.flatMap(f => [
      { [f]: f === 'deliveredBy' ? PEER : 'x' },
      { [f]: { $size: DIMS } },
      { $or: [{ name: 'nobody' }, { [f]: { $ne: null } }] },
      { $expr: { $eq: [`$${f}`, PEER] } },
    ]);

    for (const cap of ['filter', 'recall']) {
      it(`${cap}: a raw predicate naming a withheld field is refused 400 on both doors, in the same words`, async () => {
        const wrong = [];
        for (const filter of rawRefused()) {
          const answers = [];
          for (const [door, call] of DOORS[cap]) {
            const a = await call(ASK[cap]({ filter }));
            answers.push(a);
            if (!a.failed) wrong.push(`${door} ${JSON.stringify(filter)}: answered (${rowsOf(cap, a.body).length} rows)`);
            else if (door.startsWith('REST') && a.status !== 400) wrong.push(`${door} ${JSON.stringify(filter)}: ${a.status}, not 400: ${a.error.slice(0, 120)}`);
          }
          if (answers.every(a => a.failed) && answers[0].error !== answers[1].error) wrong.push(`${cap} ${JSON.stringify(filter)}: two messages`);
        }
        assert.deepEqual(wrong, []);
      });
    }

    it("recall: the operator-object grammar refuses a withheld field too, with the raw grammar's message", async () => {
      const wrong = [];
      for (const f of WITHHELD) {
        for (const [door, call] of DOORS.recall) {
          const expr = await call(ASK.recall({ filter: { [f]: { eq: 'x' } } }));
          const raw = await call(ASK.recall({ filter: { [f]: { $eq: 'x' } } }));
          if (!expr.failed) wrong.push(`${door} {${f}: {eq}}: answered`);
          else if (door.startsWith('REST') && expr.status !== 400) wrong.push(`${door} {${f}: {eq}}: ${expr.status}`);
          if (expr.failed && raw.failed && expr.error !== raw.error) wrong.push(`${door} ${f}: the grammars word it differently`);
        }
      }
      assert.deepEqual(wrong, []);
    });

    it('$exists at field position still answers (R10), in both grammars, on both doors', async () => {
      const wrong = [];
      for (const f of WITHHELD) {
        for (const [door, call] of DOORS.filter) {
          const a = await call(ASK.filter({ filter: { [f]: { $exists: true } } }));
          if (a.failed || rowsOf('filter', a.body).length !== 3) wrong.push(`${door} {${f}: {$exists: true}}: ${a.failed ? a.error : rowsOf('filter', a.body).length + ' rows'}`);
        }
        for (const [door, call] of DOORS.recall) {
          for (const filter of [{ [f]: { $exists: true } }, { [f]: { exists: true } }]) {
            const a = await call(ASK.recall({ filter }));
            if (a.failed || (a.body.results ?? []).length < 1) wrong.push(`${door} ${JSON.stringify(filter)}: ${a.failed ? a.error.slice(0, 120) : 'no hit'}`);
          }
        }
      }
      assert.deepEqual(wrong, []);
    });

    it('a field that only shares a prefix (embeddingModel) is not refused', async () => {
      for (const [door, call] of [...DOORS.filter, ...DOORS.recall]) {
        const a = await call(door.includes('filter') ? ASK.filter({ filter: { embeddingModel: 'stub' } }) : ASK.recall({ filter: { embeddingModel: 'stub' } }));
        assert.equal(a.failed, false, `${door}: ${a.error}`);
      }
    });
  });

  it('write answers withhold every withheld field (R11): save_entity over a synced record and update_entity, both doors', async () => {
    const { entitiesRouter } = await import('../../server/dist/api/brain/entities.js').catch(() => ({}));
    const wrong = [];
    const saved = await viaMcp('save_entity', { space: S, name: 'alpha', type: 'service', description: 'rewritten by a local write' });
    if (saved.failed) wrong.push(`MCP save_entity: ${saved.error}`); else wrong.push(...leaksIn(saved.body).map(p => `MCP save_entity ${p}`));
    const updated = await viaMcp('update_entity', { space: S, id: ID.b, description: 'updated by a local write' });
    if (updated.failed) wrong.push(`MCP update_entity: ${updated.error}`); else wrong.push(...leaksIn(updated.body).map(p => `MCP update_entity ${p}`));
    const viaTool = await viaRest(handlers.tool, { space: S, id: ID.c, description: 'updated on the REST tool door' }, { tool: 'update_entity' });
    if (viaTool.failed) wrong.push(`REST POST /api/update_entity: ${viaTool.error}`); else wrong.push(...leaksIn(viaTool.body).map(p => `REST update_entity ${p}`));
    if (entitiesRouter) {
      const post = await viaRest(routeHandler(entitiesRouter, '/spaces/:spaceId/entities'), { name: 'gamma', type: 'service', description: 'rewritten on the REST path route' }, { spaceId: S });
      if (post.failed) wrong.push(`REST POST entities: ${post.error}`); else wrong.push(...leaksIn(post.body).map(p => `REST POST entities ${p}`));
    }
    assert.deepEqual(wrong, []);
    // The stored records still hold what arrived: the answer withholds, the write does not erase.
    const a = await mongo.col(`${S}_entities`).findOne({ _id: ID.a });
    assert.equal(a.deliveredBy, PEER, 'the fixture lost its deliveredBy, so the answer above could not have carried it');
  });
});
