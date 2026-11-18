/**
 * The records a schema conversion could not convert are listed and dismissed by one act, and the REST router's handlers and the MCP tools
 * answer exactly what the act answers (Q-919, bundle-284 design r5 sections 2.3 and 6, slice 4).
 *
 * ## The rule
 *
 * `list` (`GET /api/spaces/:id/schema-convert/items`, MCP `list_unconverted`) pages the items a run wrote, newest first, narrowed by `kind`,
 * `type` and `status` (`open` by default, or `dismissed`), and answers the counts of open and dismissed items of the whole space. Each row
 * is the stored item (no internal staleness hash) with a `record` part naming the record, absent when the record is gone, and no row ever
 * carries a property VALUE: a violation names a field and a reason. `dismiss` (`POST .../items/:itemId/dismiss`, MCP `dismiss_unconverted`)
 * keeps the item as `dismissed`; a run that meets the same record version toward the same target does not open it again. Rights are the
 * act's own, so a door that mounts it cannot forget them: list needs `knowledge: read`, dismiss needs `knowledge: write`.
 *
 * ## Why the three doors are driven
 *
 * The act, the router's handler (past rate limit and auth, as a token reaches it) and the tool's handler (past the dispatcher) are called
 * with the same parameters and compared whole: a parameter one door reads and another drops, or a refusal worded twice, fails here.
 *
 * ## What was wrong
 *
 * Nothing lists or dismisses the items slice 2 writes: a record a conversion could not convert is a row nobody can read.
 *
 * Seen red on a91e522e: the act module, the router and the tools are not built.
 *
 * ## The mounted part (slice 6)
 *
 * The cases above call the router's last handler and the tool's handler themselves, so they hold while `app.ts` mounts no router and the tool
 * list offers no tool. The last part asks the way a client does, with a token: the application on loopback (rate limit, authentication,
 * rights guard, router stack) and `POST /mcp` (`tools/list`, `tools/call` through the registry), and compares the answers with the act asked
 * as the same caller. A mutating tool is not offered to a token that cannot write; a refusal carries its own code on both doors; a bulk
 * dismiss through either door dismisses exactly the set the list shows. Seen red on 8ca143bb: the three routes answer 404 (no router is
 * mounted) and `tools/list` offers none of the three tools.
 *
 * Run: node --test testing/standalone/the-unconverted-doors-answer-alike-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openConvertDoor, CONVERT_META } from './_schema-convert.mjs';
import { moduleOrNull } from './_b81c-door.mjs';
import { waitForValue } from '../_shared/wait-for.mjs';
import { openMountedDoor } from './_mounted-door.mjs';

const skip = await mongoSkipReason();
const S = 'unconv';
const OTHER = 'unconvother';
/** The distinctive text every offending value carries: no answer of any door may hold it. */
const SECRET = 'ZEBRA-4711';
const META = structuredClone(CONVERT_META);
META.typeSchemas.entity.org = { propertySchemas: { size: { type: 'number' } } };

const ALL_AREAS = ['knowledge', 'files', 'schema', 'dataQuality', 'networks'];
/** A token's rights holding `knowledge: <rung>` on `S` and nothing else. */
const knowledgeRung = (rung) => ({
  instanceAdmin: false, createSpaces: false, floor: null,
  perSpace: { [S]: Object.fromEntries(ALL_AREAS.map(a => [a, a === 'knowledge' ? rung : 'none'])) },
});
const READER = knowledgeRung('read');
const WRITER = knowledgeRung('write');
const NO_KNOWLEDGE = { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [S]: Object.fromEntries(ALL_AREAS.map(a => [a, a === 'knowledge' ? 'none' : 'admin'])) } };
const ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(ALL_AREAS.map(a => [a, 'admin'])) };

/** The page fields that state the door's own byte budget: the one thing the two transports answer differently. */
const BUDGET_KEYS = ['budgetChars', 'budgetBytes', 'charsReturned', 'bytesReturned'];
const withoutBudget = (body) => { const b = structuredClone(body); for (const k of BUDGET_KEYS) delete b[k]; return b; };

describe('the unconverted doors answer alike (real MongoDB)', { skip }, () => {
  let door, convert, getConfig;
  /** recordId -> item id, as the run wrote them. */
  const itemOf = {};
  const modules = {};

  const need = (what, name, file, symbol) => {
    const m = modules[name];
    assert.ok(m && m[symbol], `server/src/${file} (${symbol}) is not built: ${what}`);
    return m;
  };
  const acts = () => need('nothing lists or dismisses the items a conversion run wrote', 'acts', 'spaces/unconverted-acts.ts', 'listUnconvertedAct');
  const router = () => need('the unconverted-record routes have no router', 'router', 'api/spaces-unconverted.ts', 'spaceUnconvertedRouter').spaceUnconvertedRouter;
  const tools = () => need('the unconverted-record tools do not exist', 'tools', 'mcp/tools/unconverted.ts', 'list_unconvertedTool');
  const shownAct = () => need('no act dismisses every open item a filter lists', 'acts', 'spaces/unconverted-acts.ts', 'dismissShownUnconvertedAct');
  const shownTool = () => need('the bulk dismiss tool does not exist', 'tools', 'mcp/tools/unconverted.ts', 'dismiss_unconverted_shownTool').dismiss_unconverted_shownTool;

  /** One call through the act, as the door `transport` runs it. */
  async function viaAct(op, args, rights, transport) {
    const m = acts();
    const params = Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'space'));
    const r = op === 'list' ? await m.listUnconvertedAct(args.space ?? S, params, { rights, transport })
      : op === 'shown' ? await shownAct().dismissShownUnconvertedAct(args.space ?? S, params, { rights, transport })
        : await m.dismissUnconvertedAct(args.space ?? S, args.itemId, { rights, transport });
    return 'error' in r ? { status: r.status, body: { error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.detail ?? {}) } } : { status: r.status, body: r.body };
  }

  /** One call through the router's own handler, past the guards, with the query as a client sends it (strings). */
  async function viaRest(op, args, rights) {
    const [method, route] = op === 'list' ? ['get', '/:id/schema-convert/items']
      : op === 'shown' ? ['post', '/:id/schema-convert/items/dismiss'] : ['post', '/:id/schema-convert/items/:itemId/dismiss'];
    const layer = router().stack.find(l => l.route?.path === route && l.route.methods[method]);
    assert.ok(layer, `no ${method.toUpperCase()} ${route} on the unconverted router`);
    const { space, itemId, ...query } = args;
    const req = {
      method: method.toUpperCase(), path: route, body: op === 'shown' ? query : {}, headers: {}, get: () => undefined, authToken: rights ? { rights } : {},
      params: { id: space ?? S, ...(itemId !== undefined ? { itemId } : {}) },
      query: op === 'list' ? Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])) : {},
    };
    const res = {
      code: 200, body: undefined, sent: false, headers: {},
      status(c) { this.code = c; return this; },
      setHeader(n, v) { this.headers[n.toLowerCase()] = v; return this; },
      json(b) { this.body = b; this.sent = true; return this; },
    };
    await layer.route.stack.at(-1).handle(req, res);
    assert.ok(res.sent, `${method.toUpperCase()} ${route} settled without answering`);
    return { status: res.code, body: res.body };
  }

  /** One call through the tool's handler, past the dispatcher; a refusal is the thrown `ToolRefusal`. */
  async function viaTool(op, args, rights) {
    const t = tools();
    const tool = op === 'list' ? t.list_unconvertedTool : op === 'shown' ? shownTool() : t.dismiss_unconvertedTool;
    const space = args.space ?? S;
    const ctx = {
      args: { space, ...args }, callSpace: space, callSpaces: [space], name: tool.name, transport: 'mcp', cfg: getConfig(),
      accessibleSpaces: [], accessibleSpaceIds: [S, OTHER], rights, viewReads: new Map(), rateKey: 'test',
    };
    try {
      const out = await tool.handle(ctx);
      return { status: 200, body: out.structuredContent, text: (out.content ?? []).map(c => c.text ?? '').join('\n') };
    } catch (err) {
      if (err?.name !== 'ToolRefusal') throw err;
      return { status: err.status, body: { ...err.body }, text: err.message };
    }
  }

  /**
   * The same call through the act (both transports), the router and the tool, compared whole: REST with the act as the REST door runs it, the
   * tool with the act as the tool door runs it, and the two doors with each other once the byte budget each states is set aside.
   */
  async function alike(op, args, rights = ADMIN) {
    const actRest = await viaAct(op, args, rights, 'rest');
    const actMcp = await viaAct(op, args, rights, 'mcp');
    const rest = await viaRest(op, args, rights);
    const tool = await viaTool(op, args, rights);
    assert.deepEqual(rest, actRest, `${op} ${JSON.stringify(args)}: the router answered something else than the act`);
    assert.deepEqual({ status: tool.status, body: tool.body }, actMcp, `${op} ${JSON.stringify(args)}: the tool answered something else than the act`);
    assert.equal(rest.status, tool.status, `${op} ${JSON.stringify(args)}: the doors answered different statuses`);
    assert.deepEqual(withoutBudget(rest.body), withoutBudget(tool.body), `${op} ${JSON.stringify(args)}: the doors answered different bodies`);
    return { status: rest.status, body: rest.body, tool };
  }

  const ids = (answer) => answer.body.items.map(r => r.recordId);

  /** Run the conversion of the three kinds again toward the same target and wait for its end. */
  async function runAgain() {
    const before = await door.runDoc(S);
    const started = await convert.startSchemaConvertRun({
      spaceId: S, types: ['entity', 'fact', 'chrono'].map(kind => ({ kind, type: '*' })), steps: [], source: { kind: 'act' },
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    return await waitForValue(async () => { const d = await door.runDoc(S); return d && d.state !== 'running' && d.startedAt !== before?.startedAt ? d : null; },
      20_000, 100, undefined, { what: 'the second run to end' });
  }

  before(async () => {
    door = await openConvertDoor({ name: 'b284unconv', spaces: [S, OTHER], metaOf: () => META });
    convert = await door.runModule();
    ({ getConfig } = await import('../../server/dist/config/loader.js'));
    modules.acts = await moduleOrNull('spaces/unconverted-acts.js');
    modules.router = await moduleOrNull('api/spaces-unconverted.js');
    modules.tools = await moduleOrNull('mcp/tools/unconverted.js');

    await door.seed(S, 'entities', [
      { _id: 'p1', name: 'Ann', type: 'person', properties: { age: `${SECRET}-ann` } },
      { _id: 'p2', name: 'Bob', type: 'person', properties: { age: `${SECRET}-bob` } },
      { _id: 'p3', name: 'Cy', type: 'person', properties: { age: 3 } },
      { _id: 'o1', name: 'Acme', type: 'org', properties: { size: `${SECRET}-acme` } },
    ]);
    await door.seed(S, 'facts', [{ _id: 'f1', fact: 'The sky is green', type: 'claim', properties: { confidence: `${SECRET}-fact` } }]);
    await door.seed(S, 'chrono', [{ _id: 'c1', title: 'Launch', type: 'event', startsAt: '2026-02-01T00:00:00.000Z', properties: { priority: `${SECRET}-chrono` } }]);
    const started = await convert.startSchemaConvertRun({
      spaceId: S, types: ['entity', 'fact', 'chrono'].map(kind => ({ kind, type: '*' })), steps: [], source: { kind: 'act' },
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    const done = await waitForValue(async () => { const d = await door.runDoc(S); return d && d.state !== 'running' ? d : null; },
      20_000, 100, undefined, { what: 'the run to end' });
    assert.equal(done.state, 'complete', `the fixture run did not complete: ${JSON.stringify(done)}`);

    // The newest item is c1, then f1, o1, p2, p1: the run writes them in one millisecond, so the order is set here, not left to a tie.
    const rows = await door.itemRows(S);
    assert.deepEqual(rows.map(r => r.recordId).sort(), ['c1', 'f1', 'o1', 'p1', 'p2'], 'the fixture must leave five items (p3 conforms and is stamped)');
    for (const [i, recordId] of ['p1', 'p2', 'o1', 'f1', 'c1'].entries()) {
      const row = rows.find(r => r.recordId === recordId);
      itemOf[recordId] = row._id;
      await door.mongo.col(door.spaceCollection(S, 'schemaConvertItems')).updateOne({ _id: row._id }, { $set: { detectedAt: `2026-03-0${i + 1}T00:00:00.000Z` } });
    }
  });
  after(async () => { convert?.stopSchemaConvertWatcher(); await door?.close(); });

  it('the act module, the router file and the tool file are built', () => {
    acts(); router(); tools();
    for (const name of ['list_unconvertedTool', 'dismiss_unconvertedTool']) assert.ok(tools()[name], `mcp/tools/unconverted.ts does not export ${name}`);
    assert.ok(acts().dismissUnconvertedAct, 'spaces/unconverted-acts.ts does not export dismissUnconvertedAct');
  });

  it('lists the open items newest first, each row the stored item with the record named, and the counts of open and dismissed', async () => {
    const a = await alike('list', {});
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual(ids(a), ['c1', 'f1', 'o1', 'p2', 'p1']);
    assert.deepEqual(a.body.counts, { open: 5, dismissed: 0 });
    assert.equal(a.body.total, 5);
    assert.equal(a.body.count, 5);
    assert.equal(a.body.truncated, false);
    const p1 = a.body.items.find(r => r.recordId === 'p1');
    assert.deepEqual(Object.keys(p1).sort(),
      ['detectedAt', 'fromFp', 'itemId', 'kind', 'proposed', 'reason', 'record', 'recordId', 'seq', 'status', 'toFp', 'type', 'violations'].sort(),
      'a row is the stored item (its id as itemId, no internal staleness hash) and the record part');
    assert.equal(p1.itemId, itemOf.p1);
    assert.equal(p1.status, 'open');
    assert.equal(p1.reason, 'not_conforming');
    assert.equal(p1.toFp, door.fp(S));
    assert.deepEqual(p1.violations.map(v => v.field), ['properties.age']);
    assert.deepEqual(p1.proposed, { set: [], unset: [] });
    for (const t of [await viaTool('list', {}, ADMIN)]) assert.match(t.text, /5 open/, 'the tool says in words how many are open');
  });

  it('filters by kind, type and status; the counts stay those of the whole space', async () => {
    const byKind = await alike('list', { kind: 'entity' });
    assert.deepEqual(ids(byKind), ['o1', 'p2', 'p1']);
    assert.deepEqual((await alike('list', { type: 'person' })).body.items.map(r => r.recordId), ['p2', 'p1']);
    assert.deepEqual(ids(await alike('list', { kind: 'fact', type: 'claim' })), ['f1']);
    const none = await alike('list', { kind: 'chrono', type: 'person' });
    assert.deepEqual([none.body.items, none.body.total], [[], 0]);
    assert.deepEqual(none.body.counts, { open: 5, dismissed: 0 }, 'a filter narrows the page, not the counts');
    assert.deepEqual(ids(await alike('list', { status: 'open' })), ['c1', 'f1', 'o1', 'p2', 'p1']);
    const dismissed = await alike('list', { status: 'dismissed' });
    assert.deepEqual([dismissed.body.items, dismissed.body.total], [[], 0]);
    assert.deepEqual(ids(await alike('list', { kind: '', type: '', status: '' })), ['c1', 'f1', 'o1', 'p2', 'p1'], 'an empty filter is no filter, as on the other lists');
  });

  it('refuses a malformed parameter by its own code, in the same words on every door', async () => {
    const refused = async (args, code) => {
      const a = await alike('list', args);
      assert.equal(a.status, 400, `${JSON.stringify(args)}: ${JSON.stringify(a.body)}`);
      assert.equal(a.body.code, code, `${JSON.stringify(args)}`);
      assert.equal(typeof a.body.error, 'string');
      assert.match(a.tool.text, new RegExp(code), 'the tool names the code in its text');
    };
    await refused({ kind: 'file' }, 'unconverted_bad_kind');
    await refused({ status: 'all' }, 'unconverted_bad_status');
    await refused({ type: 'x'.repeat(201) }, 'unconverted_bad_type');
    for (const skip of [-1, 'abc']) await refused({ skip }, 'unconverted_bad_paging');
    for (const limit of [0, 'abc']) await refused({ limit }, 'unconverted_bad_paging');
  });

  it('pages: limit and skip, the fields every list answers, and the pages together are the list', async () => {
    const first = await alike('list', { limit: 2 });
    assert.deepEqual(ids(first), ['c1', 'f1']);
    assert.deepEqual([first.body.count, first.body.total, first.body.limit, first.body.skip, first.body.truncated, first.body.nextSkip], [2, 5, 2, 0, true, 2]);
    const second = await alike('list', { limit: 2, skip: 2 });
    assert.deepEqual(ids(second), ['o1', 'p2']);
    assert.equal(second.body.nextSkip, 4);
    const last = await alike('list', { limit: 2, skip: 4 });
    assert.deepEqual(ids(last), ['p1']);
    assert.deepEqual([last.body.truncated, 'nextSkip' in last.body], [false, false]);
    assert.deepEqual([...ids(first), ...ids(second), ...ids(last)], ids(await alike('list', {})), 'the pages together are the whole list, none twice');
    const beyond = await alike('list', { skip: 10 });
    assert.deepEqual([beyond.body.items, beyond.body.total], [[], 5]);
  });

  it('names the record on each row with its own summary, the one the duplicate list gives', async () => {
    const rows = Object.fromEntries((await alike('list', {})).body.items.map(r => [r.recordId, r]));
    assert.deepEqual(rows.p1.record, { summary: 'Ann (person)' });
    assert.deepEqual(rows.o1.record, { summary: 'Acme (org)' });
    assert.deepEqual(rows.f1.record, { summary: 'The sky is green' });
    assert.deepEqual(rows.c1.record, { summary: 'Launch' });
  });

  it('carries no property value in any answer: the offending text is in the records and in no door\'s list', async () => {
    assert.equal((await door.coll(S, 'entities').findOne({ _id: 'p1' })).properties.age, `${SECRET}-ann`, 'the fixture record holds the offending value');
    assert.ok(!JSON.stringify(await door.itemRows(S)).includes(SECRET), 'the stored items hold a value (slice 2 writes names only)');
    const seen = [];
    for (const args of [{}, { kind: 'entity' }, { type: 'person' }, { kind: 'fact' }, { kind: 'chrono' }, { status: 'dismissed' }, { limit: 1, skip: 1 }]) {
      const a = await alike('list', args);
      seen.push(JSON.stringify(a.body), a.tool.text);
    }
    for (const text of seen) assert.ok(!text.includes(SECRET), `an answer carries an offending value: ${text.slice(0, 300)}`);
  });

  it('a list writes nothing: the items, the run and the records are as they were', async () => {
    const state = async () => JSON.stringify({
      items: await door.itemRows(S), run: await door.runDoc(S),
      entities: await door.coll(S, 'entities').find({}).sort({ _id: 1 }).toArray(),
      facts: await door.coll(S, 'facts').find({}).toArray(), chrono: await door.coll(S, 'chrono').find({}).toArray(),
    });
    const before = await state();
    for (const args of [{}, { status: 'dismissed' }, { kind: 'edge' }, { limit: 1, skip: 2 }]) await alike('list', args);
    await alike('list', { space: OTHER });
    assert.equal(await state(), before, 'a list changed a row');
  });

  it('asks the rights inside the act: list needs knowledge read, dismiss needs knowledge write', async () => {
    for (const [name, rights] of [['a reader', READER], ['a writer', WRITER], ['an instance admin', ADMIN]]) {
      assert.equal((await alike('list', {}, rights)).status, 200, `${name} may list`);
    }
    for (const [name, rights] of [['a token with no knowledge rung', NO_KNOWLEDGE], ['a token with no matrix', null]]) {
      const a = await alike('list', {}, rights);
      assert.equal(a.status, 403, `${name} may not list: ${JSON.stringify(a.body)}`);
      assert.equal(a.body.code, 'unconverted_rung');
      assert.match(a.body.error, /knowledge/);
    }
    for (const [name, rights] of [['a read-only token', READER], ['a token with no knowledge rung', NO_KNOWLEDGE], ['a token with no matrix', null]]) {
      const a = await alike('dismiss', { itemId: itemOf.p1 }, rights);
      assert.equal(a.status, 403, `${name} may not dismiss: ${JSON.stringify(a.body)}`);
      assert.equal(a.body.code, 'unconverted_rung');
    }
    assert.equal((await door.itemRows(S)).filter(r => r.status === 'dismissed').length, 0, 'a refused dismiss changed an item');
    const rights = await alike('dismiss', { itemId: 'no-such-item' }, READER);
    assert.equal(rights.status, 403, 'the rung is asked before the item is looked up');
  });

  it('answers a space that does not exist as unknown, and an item of another space as not found', async () => {
    for (const op of ['list', 'dismiss']) {
      const a = await alike(op, { space: 'nosuch', itemId: itemOf.p1 });
      assert.equal(a.status, 404, `${op}: ${JSON.stringify(a.body)}`);
      assert.match(a.body.error, /nosuch/);
    }
    const empty = await alike('list', { space: OTHER });
    assert.deepEqual([empty.status, empty.body.items, empty.body.counts], [200, [], { open: 0, dismissed: 0 }]);
    const foreign = await alike('dismiss', { space: OTHER, itemId: itemOf.p1 });
    assert.deepEqual([foreign.status, foreign.body.code], [404, 'unconverted_item_not_found']);
    assert.equal((await door.itemRows(S)).find(r => r._id === itemOf.p1).status, 'open');
  });

  it('refuses an unknown or malformed item id by a named code, in the same words on every door', async () => {
    const unknown = await alike('dismiss', { itemId: 'no-such-item' });
    assert.deepEqual([unknown.status, unknown.body.code], [404, 'unconverted_item_not_found']);
    assert.match(unknown.body.error, /no-such-item/);
    assert.match(unknown.tool.text, /unconverted_item_not_found/);
    for (const itemId of ['', 123, 'x'.repeat(201)]) {
      const a = await alike('dismiss', { itemId });
      assert.deepEqual([a.status, a.body.code], [400, 'unconverted_bad_item_id'], `itemId ${JSON.stringify(itemId)}: ${JSON.stringify(a.body)}`);
    }
  });

  it('dismisses an item through each door: it stays, dismissed, the record unchanged, and stops being listed as open', async () => {
    const recordBefore = JSON.stringify(await door.coll(S, 'entities').findOne({ _id: 'p1' }));
    const rowBefore = (await door.itemRows(S)).find(r => r._id === itemOf.p1);
    const viaTheAct = await viaAct('dismiss', { itemId: itemOf.p1 }, WRITER, 'rest');
    assert.equal(viaTheAct.status, 200, JSON.stringify(viaTheAct.body));
    assert.equal(viaTheAct.body.item.itemId, itemOf.p1);
    assert.equal(viaTheAct.body.item.status, 'dismissed');
    const viaTheRoute = await viaRest('dismiss', { itemId: itemOf.p2 }, WRITER);
    assert.equal(viaTheRoute.status, 200, JSON.stringify(viaTheRoute.body));
    assert.equal(viaTheRoute.body.item.status, 'dismissed');
    const viaTheTool = await viaTool('dismiss', { itemId: itemOf.o1 }, WRITER);
    assert.equal(viaTheTool.status, 200, JSON.stringify(viaTheTool.body));
    assert.equal(viaTheTool.body.item.status, 'dismissed');
    assert.match(viaTheTool.text, /dismissed/);

    const rowAfter = (await door.itemRows(S)).find(r => r._id === itemOf.p1);
    assert.deepEqual({ ...rowAfter, status: 'open' }, rowBefore, 'a dismiss changed more than the status');
    assert.equal(rowAfter.status, 'dismissed');
    assert.equal(JSON.stringify(await door.coll(S, 'entities').findOne({ _id: 'p1' })), recordBefore, 'a dismiss changed the record');

    const open = await alike('list', {});
    assert.deepEqual(ids(open), ['c1', 'f1']);
    assert.deepEqual(open.body.counts, { open: 2, dismissed: 3 });
    const gone = await alike('list', { status: 'dismissed' });
    assert.deepEqual(ids(gone), ['o1', 'p2', 'p1'], 'the dismissed list is newest first too');
    assert.deepEqual(gone.body.items.map(r => r.status), ['dismissed', 'dismissed', 'dismissed']);
    assert.deepEqual(gone.body.counts, { open: 2, dismissed: 3 });
    const again = await alike('dismiss', { itemId: itemOf.p1 }, WRITER);
    assert.deepEqual([again.status, again.body.item.status], [200, 'dismissed'], 'dismissing a dismissed item leaves it dismissed');
  });

  it('does not open a dismissed item again when a run meets the same record version toward the same target', async () => {
    // Dismissed here, through the act, so this test stands on its own (a dismiss of a dismissed item changes nothing).
    for (const recordId of ['p1', 'p2', 'o1']) {
      const done = await viaAct('dismiss', { itemId: itemOf[recordId] }, WRITER, 'rest');
      assert.equal(done.status, 200, JSON.stringify(done.body));
    }
    const dismissedBefore = (await door.itemRows(S)).filter(r => r.status === 'dismissed');
    assert.deepEqual(dismissedBefore.map(r => r.recordId).sort(), ['o1', 'p1', 'p2']);
    const before = JSON.stringify((await door.itemRows(S)).sort((a, b) => a._id.localeCompare(b._id)));

    const second = await runAgain();
    assert.equal(second.state, 'complete');
    assert.equal(JSON.stringify((await door.itemRows(S)).sort((a, b) => a._id.localeCompare(b._id))), before,
      'the second run rewrote an item for a record version it already listed (dismissed ones stay dismissed, open ones are kept)');

    // The control: the same run does write an item for a record whose item is gone, so the run above was able to re-add.
    await door.mongo.col(door.spaceCollection(S, 'schemaConvertItems')).deleteOne({ _id: itemOf.c1 });
    const third = await runAgain();
    assert.equal(third.state, 'complete');
    const rows = await door.itemRows(S);
    assert.equal(rows.find(r => r._id === itemOf.c1)?.status, 'open', 'a run does not write the item of a record that has none: the control of this test is void');
    for (const r of dismissedBefore) assert.equal(rows.find(x => x._id === r._id)?.status, 'dismissed', `${r.recordId} was opened again`);
    assert.deepEqual(ids(await alike('list', { status: 'dismissed' })), ['o1', 'p2', 'p1']);
    assert.deepEqual((await alike('list', {})).body.counts, { open: 2, dismissed: 3 });
  });

  it('leaves a row whose record is gone listed, without a record part, until the watcher\'s tick removes it', async () => {
    for (const recordId of ['p1', 'p2', 'o1']) assert.equal((await viaAct('dismiss', { itemId: itemOf[recordId] }, WRITER, 'rest')).status, 200);
    await door.coll(S, 'entities').deleteOne({ _id: 'p2' });
    const a = await alike('list', { status: 'dismissed' });
    assert.deepEqual(ids(a), ['o1', 'p2', 'p1']);
    const rows = Object.fromEntries(a.body.items.map(r => [r.recordId, r]));
    assert.equal('record' in rows.p2, false, 'a deleted record is named by a record part');
    assert.deepEqual(rows.p1.record, { summary: 'Ann (person)' });
    assert.deepEqual(rows.o1.record, { summary: 'Acme (org)' });
  });

  // ---- slice 4b: the bulk dismiss, the reason filter, the summary in the budget ----
  const itemsCol = (space) => door.mongo.col(door.spaceCollection(space, 'schemaConvertItems'));
  const statusMap = async () => Object.fromEntries((await itemsCol(S).find({}).toArray()).map(r => [r.recordId, r.status]));
  /** Put the named items of S into the named status (the fixture of one test: no door writes it). */
  async function arrange(states) {
    for (const [recordId, status] of Object.entries(states)) await itemsCol(S).updateOne({ _id: itemOf[recordId] }, { $set: { status } });
  }
  const ALL_OPEN = { p1: 'open', p2: 'open', o1: 'open', f1: 'open', c1: 'open' };

  it('lists by reason: the same question the bulk dismiss asks, refused by its own code when it is not a reason class', async () => {
    await itemsCol(S).updateOne({ _id: itemOf.f1 }, { $set: { reason: 'no_case_matched' } });
    await arrange(ALL_OPEN);
    assert.deepEqual(ids(await alike('list', { reason: 'no_case_matched' })), ['f1']);
    assert.deepEqual(ids(await alike('list', { reason: 'not_conforming' })), ['c1', 'o1', 'p2', 'p1']);
    assert.deepEqual(ids(await alike('list', { kind: 'entity', reason: 'no_case_matched' })), []);
    assert.deepEqual(ids(await alike('list', { reason: '' })), ['c1', 'f1', 'o1', 'p2', 'p1'], 'an empty reason is no filter');
    const bad = await alike('list', { reason: 'no_such_reason' });
    assert.deepEqual([bad.status, bad.body.code], [400, 'unconverted_bad_reason']);
    assert.match(bad.tool.text, /unconverted_bad_reason/);
  });

  it('dismisses exactly the open items its filter lists, through each door, and no other: a second type and a dismissed item are untouched', async () => {
    await arrange({ ...ALL_OPEN, p1: 'dismissed' });
    const shown = async (filter) => (await alike('list', filter)).body.total;

    // The act: one type of one kind.
    const one = await viaAct('shown', { kind: 'entity', type: 'org', expect: await shown({ kind: 'entity', type: 'org' }) }, WRITER, 'rest');
    assert.deepEqual([one.status, one.body], [200, { dismissed: 1 }]);
    assert.deepEqual(await statusMap(), { p1: 'dismissed', p2: 'open', o1: 'dismissed', f1: 'open', c1: 'open' });

    // The router: one reason (another type's item, and the dismissed one, are not it).
    const route = await viaRest('shown', { reason: 'no_case_matched', expect: await shown({ reason: 'no_case_matched' }) }, WRITER);
    assert.deepEqual([route.status, route.body], [200, { dismissed: 1 }]);
    assert.deepEqual(await statusMap(), { p1: 'dismissed', p2: 'open', o1: 'dismissed', f1: 'dismissed', c1: 'open' });

    // The tool: one kind; the dismissed entity items are not counted in what it was shown.
    const entities = await shown({ kind: 'entity' });
    assert.equal(entities, 1, 'the list of a kind counts its open items only');
    const tool = await viaTool('shown', { kind: 'entity', expect: entities }, WRITER);
    assert.deepEqual([tool.status, tool.body], [200, { dismissed: 1 }]);
    assert.match(tool.text, /1/);
    assert.deepEqual(await statusMap(), { p1: 'dismissed', p2: 'dismissed', o1: 'dismissed', f1: 'dismissed', c1: 'open' });

    // No filter: every open item is the set the list shows.
    const every = await viaAct('shown', { expect: await shown({}) }, WRITER, 'mcp');
    assert.deepEqual([every.status, every.body], [200, { dismissed: 1 }]);
    assert.deepEqual(Object.values(await statusMap()), ['dismissed', 'dismissed', 'dismissed', 'dismissed', 'dismissed']);
    assert.deepEqual((await alike('list', { status: 'dismissed' })).body.counts, { open: 0, dismissed: 5 });
    const nothing = await alike('shown', { expect: 0 });
    assert.deepEqual([nothing.status, nothing.body], [200, { dismissed: 0 }], 'nothing open: nothing to dismiss, and it says so');
  });

  it('takes the set the list shows for a filter: the list\'s count and the bulk dismiss are one question', async () => {
    await arrange(ALL_OPEN);
    for (const filter of [{ reason: 'not_conforming' }, { kind: 'entity', reason: 'not_conforming' }, { type: 'person' }, { kind: 'chrono' }]) {
      const listed = await alike('list', filter);
      const refused = await alike('shown', { ...filter, expect: listed.body.total + 1 });
      assert.deepEqual([refused.status, refused.body.code, refused.body.current], [409, 'unconverted_changed', listed.body.total], JSON.stringify(filter));
    }
    const before = await statusMap();
    const filter = { reason: 'not_conforming' };
    const listed = ids(await alike('list', filter));
    const done = await viaAct('shown', { ...filter, expect: listed.length }, WRITER, 'rest');
    assert.deepEqual([done.status, done.body.dismissed], [200, listed.length]);
    const after = await statusMap();
    for (const recordId of Object.keys(before)) {
      assert.equal(after[recordId], listed.includes(recordId) ? 'dismissed' : before[recordId], `${recordId}: dismissed unless the list did not show it`);
    }
    assert.deepEqual(ids(await alike('list', { ...filter, status: 'dismissed' })).sort(), [...listed].sort());
  });

  it('refuses a wrong expect, writing nothing and answering the current number; expect is required', async () => {
    await arrange(ALL_OPEN);
    const state = JSON.stringify(await itemsCol(S).find({}).sort({ _id: 1 }).toArray());
    for (const expect of [2, 4, 0]) {
      const a = await alike('shown', { kind: 'entity', expect });
      assert.deepEqual([a.status, a.body.code, a.body.current], [409, 'unconverted_changed', 3], `expect ${expect}`);
      assert.match(a.body.error, /3/);
      assert.match(a.tool.text, /unconverted_changed/);
    }
    for (const expect of [undefined, '3', -1, 1.5, null]) {
      const a = await alike('shown', { kind: 'entity', ...(expect === undefined ? {} : { expect }) });
      assert.deepEqual([a.status, a.body.code], [400, 'unconverted_bad_expect'], `expect ${JSON.stringify(expect)}: ${JSON.stringify(a.body)}`);
    }
    assert.deepEqual([(await alike('shown', { kind: 'file', expect: 0 })).body.code, (await alike('shown', { reason: 'nope', expect: 0 })).body.code,
      (await alike('shown', { type: 'x'.repeat(201), expect: 0 })).body.code], ['unconverted_bad_kind', 'unconverted_bad_reason', 'unconverted_bad_type']);
    const none = await alike('shown', { kind: 'edge', expect: 0 });
    assert.deepEqual([none.status, none.body], [200, { dismissed: 0 }]);
    assert.equal(JSON.stringify(await itemsCol(S).find({}).sort({ _id: 1 }).toArray()), state, 'a refused bulk dismiss wrote');
  });

  it('asks knowledge write inside the act for the bulk dismiss, before it judges the parameters', async () => {
    await arrange(ALL_OPEN);
    for (const [name, rights] of [['a read-only token', READER], ['a token with no knowledge rung', NO_KNOWLEDGE], ['a token with no matrix', null]]) {
      const a = await alike('shown', { expect: 5 }, rights);
      assert.deepEqual([a.status, a.body.code], [403, 'unconverted_rung'], `${name}: ${JSON.stringify(a.body)}`);
      assert.deepEqual([(await alike('shown', {}, rights)).status], [403], `${name}: the rung is asked before expect`);
    }
    assert.deepEqual(Object.values(await statusMap()), ['open', 'open', 'open', 'open', 'open'], 'a refused call dismissed an item');
    assert.equal((await alike('shown', { space: 'nosuch', expect: 0 })).status, 404);
  });

  it('refuses a filter that matches more than one call may dismiss, by a named code, and a narrowed filter then passes', async () => {
    const { UNCONVERTED_DISMISS_MAX: MAX } = await import('../../server/dist/brain/schema-convert-items.js');
    assert.ok(Number.isInteger(MAX) && MAX > 0, 'brain/schema-convert-items.ts does not export UNCONVERTED_DISMISS_MAX');
    const docs = Array.from({ length: MAX + 1 }, (_, i) => ({
      _id: `bulk${i}`, kind: 'entity', recordId: `bulk${i}`, type: i < 3 ? 'small' : 'bulk', seq: 1, fromFp: null, toFp: 'f'.repeat(64), typeDefinition: 't',
      reason: 'not_conforming', violations: [], proposed: { set: [], unset: [] }, status: 'open', detectedAt: '2026-03-10T00:00:00.000Z',
    }));
    await itemsCol(OTHER).insertMany(docs);
    try {
      const over = await alike('shown', { space: OTHER, expect: MAX + 1 });
      assert.deepEqual([over.status, over.body.code, over.body.max], [400, 'unconverted_too_many', MAX]);
      assert.match(over.body.error, /narrow/i, 'the refusal says to narrow the filter');
      assert.equal(await itemsCol(OTHER).countDocuments({ status: 'open' }), MAX + 1, 'a refused call dismissed an item');
      const done = await viaAct('shown', { space: OTHER, type: 'small', expect: 3 }, ADMIN, 'rest');
      assert.deepEqual([done.status, done.body], [200, { dismissed: 3 }]);
      assert.equal(await itemsCol(OTHER).countDocuments({ status: 'dismissed' }), 3);
    } finally {
      await itemsCol(OTHER).deleteMany({});
    }
  });

  it('counts the record summary in the byte budget it reports, on both doors', async () => {
    await arrange(ALL_OPEN);
    const before = await alike('list', { kind: 'fact' });
    const short = before.body.items[0].record.summary;
    const text = 'The sky is green because of a long and winding explanation that goes on. '.repeat(4);
    await door.coll(S, 'facts').updateOne({ _id: 'f1' }, { $set: { fact: text } });
    try {
      const after = await alike('list', { kind: 'fact' });
      const long = after.body.items[0].record.summary;
      const added = long.length - short.length;
      assert.ok(added >= 50, `the fixture must lengthen the summary (${short.length} to ${long.length} characters)`);
      for (const key of ['charsReturned', 'bytesReturned']) {
        assert.ok(after.body[key] - before.body[key] >= added, `${key} did not grow by the ${added} characters of summary the rows now carry (${before.body[key]} to ${after.body[key]})`);
      }
    } finally {
      await door.coll(S, 'facts').updateOne({ _id: 'f1' }, { $set: { fact: 'The sky is green' } });
    }
  });

  it('declares the same parameters on the tools as the routes read, says in words what an unconverted record is, and mounts three routes', async () => {
    const schemas = { requiredSpace: { type: 'string' }, optionalSpace: { type: 'string' } };
    const list = tools().list_unconvertedTool;
    const dismiss = tools().dismiss_unconvertedTool;
    const listSchema = list.inputSchema(schemas);
    assert.deepEqual(Object.keys(listSchema.properties).sort(), ['kind', 'limit', 'reason', 'skip', 'space', 'status', 'type']);
    assert.deepEqual(listSchema.required, ['space']);
    assert.equal(listSchema.additionalProperties, false);
    // The tool states the enums the act's schema holds (slice 6b: a caller reads the real bounds, and the bounds gate compares them), and still leaves
    // the refusal to the act: the dispatcher's own check is skipped, so a wrong value answers the act's code on both doors (asserted on the refusals above).
    const { KNOWLEDGE_TYPES } = await import('../../server/dist/config/types-knowledge.js');
    assert.deepEqual(listSchema.properties.kind.enum, [...KNOWLEDGE_TYPES], 'kind does not declare the knowledge kinds the act parses with');
    assert.deepEqual(listSchema.properties.status.enum, ['open', 'dismissed'], 'status does not declare the statuses the act parses with');
    for (const t of [list, dismiss, tools().dismiss_unconverted_shownTool]) {
      assert.equal(t.skipSchemaValidation, true, `${t.name}: the dispatcher would refuse a declared bound in its own words, before the act's code`);
    }
    const dismissSchema = dismiss.inputSchema(schemas);
    assert.deepEqual(Object.keys(dismissSchema.properties).sort(), ['itemId', 'space']);
    assert.deepEqual(dismissSchema.required.sort(), ['itemId', 'space']);
    assert.equal(dismissSchema.additionalProperties, false);
    assert.equal(list.mutating === true, false);
    assert.equal(dismiss.mutating, true);
    assert.deepEqual([list.spaceRequired, dismiss.spaceRequired], [true, true]);

    for (const [name, tool] of [['list_unconverted', list], ['dismiss_unconverted', dismiss]]) {
      assert.equal(tool.name, name);
      assert.match(tool.description, /schema changed/i, `${name} does not say the schema changed`);
      assert.match(tool.description, /left as it is/i, `${name} does not say the record was left as it is`);
    }
    assert.match(list.description, /edit the record/i);
    assert.match(list.description, /convert again/i);
    assert.match(dismiss.description, /stops listing/i);
    assert.match(dismiss.description, /record is unchanged/i);
    for (const [name, p] of Object.entries({ ...listSchema.properties, ...dismissSchema.properties })) {
      if (name === 'space') continue;
      assert.ok(typeof p.description === 'string' && p.description.length > 20, `${name} is declared without a description`);
    }

    const routes = router().stack.filter(l => l.route).map(l => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`).sort();
    assert.deepEqual(routes, ['GET /:id/schema-convert/items', 'POST /:id/schema-convert/items/:itemId/dismiss', 'POST /:id/schema-convert/items/dismiss']);

    const shownTool = tools().dismiss_unconverted_shownTool;
    const shownSchema = shownTool.inputSchema(schemas);
    assert.deepEqual(Object.keys(shownSchema.properties).sort(), ['expect', 'kind', 'reason', 'space', 'type']);
    assert.deepEqual(shownSchema.required.sort(), ['expect', 'space']);
    assert.equal(shownSchema.additionalProperties, false);
    assert.equal(shownTool.mutating, true);
    assert.equal(shownTool.name, 'dismiss_unconverted_shown');
    assert.match(shownTool.description, /records (themselves )?are (not changed|unchanged)/i, 'does not say the records are not changed');
    assert.match(shownTool.description, /stay listed|still listed|listed under dismissed/i, 'does not say the items stay listed as dismissed');
    assert.match(shownTool.description, /expect/, 'does not say what expect is for');
    assert.ok(typeof shownSchema.properties.expect.description === 'string' && shownSchema.properties.expect.description.length > 20);
    assert.ok('reason' in listSchema.properties && listSchema.properties.reason.description.length > 20, 'list_unconverted declares no reason filter');
  });

  // ── The MOUNTED application and the REGISTERED tools (slice 6) ───────────────────────────────────────────────────────────────────

  describe('through the mounted application and the registered tools', () => {
    let mounted;
    const who = {};
    const base = (space = S) => `/api/spaces/${space}/schema-convert/items`;
    const query = (args) => {
      const q = new URLSearchParams(Object.entries(args).map(([k, v]) => [k, String(v)])).toString();
      return q ? `?${q}` : '';
    };
    const stateOfItems = async () => JSON.stringify(await itemsCol(S).find({}).sort({ _id: 1 }).toArray());

    before(async () => {
      mounted = await openMountedDoor();
      who.admin = await mounted.mint('unconv-admin', 'admin');
      who.reader = await mounted.mint('unconv-reader', READER);
      who.writer = await mounted.mint('unconv-writer', WRITER);
      who.noKnowledge = await mounted.mint('unconv-none', NO_KNOWLEDGE);
      // The cases above leave the space as they need it (a deleted record, an item the watcher then removed): put the five records and their five
      // items back, so every case below starts from the fixture it states.
      if (!await door.coll(S, 'entities').findOne({ _id: 'p2' })) {
        await door.seed(S, 'entities', [{ _id: 'p2', name: 'Bob', type: 'person', properties: { age: `${SECRET}-bob` } }]);
      }
      await runAgain();
      for (const row of await door.itemRows(S)) itemOf[row.recordId] = row._id;
      assert.deepEqual(Object.keys(itemOf).sort(), ['c1', 'f1', 'o1', 'p1', 'p2'], 'the fixture does not hold the five items');
    });
    after(async () => { await mounted?.close(); });

    it('mounts the list route and registers the three tools: a reader is offered the list and not the two that dismiss, a writer all three', async () => {
      await arrange(ALL_OPEN);
      const list = await mounted.rest(who.reader.key, 'GET', base());
      assert.equal(list.status, 200, `GET ${base()} is not served: no router is mounted for it (${JSON.stringify(list).slice(0, 200)})`);
      const mutating = ['dismiss_unconverted', 'dismiss_unconverted_shown'];
      const readerNames = await mounted.toolNames(who.reader.key);
      assert.ok(readerNames.includes('list_unconverted'), 'tools/list does not offer list_unconverted to a reader: the tool is not registered');
      for (const name of mutating) assert.ok(!readerNames.includes(name), `tools/list offers ${name} to a token that holds no write rung`);
      const writerNames = await mounted.toolNames(who.writer.key);
      for (const name of ['list_unconverted', ...mutating]) assert.ok(writerNames.includes(name), `tools/list does not offer ${name} to a writer: the tool is not registered`);
    });

    it('lists as the act does, on the mounted route and through the registered tool: every filter, every page, the same rows and counts', async () => {
      await arrange(ALL_OPEN);
      for (const args of [{}, { kind: 'entity' }, { type: 'person' }, { kind: 'fact', type: 'claim' }, { status: 'dismissed' }, { reason: 'not_conforming' },
        { limit: 2 }, { limit: 2, skip: 2 }, { skip: 10 }, { kind: '', type: '', status: '' }]) {
        const expected = await viaAct('list', args, who.reader.rights, 'rest');
        assert.equal(expected.status, 200, JSON.stringify(expected));
        const route = await mounted.rest(who.reader.key, 'GET', `${base()}${query(args)}`);
        assert.deepEqual(route, expected, `${JSON.stringify(args)}: the mounted route answered otherwise than the act`);
        const tool = await mounted.mcp(who.reader.key, 'list_unconverted', { space: S, ...args });
        assert.equal(tool.isError, false, `${JSON.stringify(args)}: ${tool.text}`);
        assert.deepEqual(withoutBudget(tool.body), withoutBudget(expected.body), `${JSON.stringify(args)}: the registered tool answered otherwise than the act`);
      }
    });

    it('refuses a malformed list by its own code on the mounted route and the tool, and a token without the rung by 403', async () => {
      for (const [args, code] of [[{ kind: 'file' }, 'unconverted_bad_kind'], [{ status: 'all' }, 'unconverted_bad_status'], [{ reason: 'nope' }, 'unconverted_bad_reason'],
        [{ skip: -1 }, 'unconverted_bad_paging'], [{ skip: 'abc' }, 'unconverted_bad_paging'], [{ limit: 0 }, 'unconverted_bad_paging'],
        [{ limit: 'abc' }, 'unconverted_bad_paging']]) {
        const expected = await viaAct('list', args, who.reader.rights, 'rest');
        const route = await mounted.rest(who.reader.key, 'GET', `${base()}${query(args)}`);
        assert.deepEqual(route, expected, `${JSON.stringify(args)}: the mounted route answered otherwise than the act`);
        assert.equal(route.body.code, code);
        const tool = await mounted.mcp(who.reader.key, 'list_unconverted', { space: S, ...args });
        assert.deepEqual([tool.isError, tool.body?.code], [true, code], `${JSON.stringify(args)}: ${tool.text}`);
      }
      const route = await mounted.rest(who.noKnowledge.key, 'GET', base());
      assert.equal(route.status, 403, JSON.stringify(route));
      assert.equal((await mounted.mcp(who.noKnowledge.key, 'list_unconverted', { space: S })).isError, true);
    });

    it('a list through the mounted route and the tool writes nothing', async () => {
      await arrange(ALL_OPEN);
      const before = await stateOfItems();
      for (const key of [who.reader.key, who.admin.key]) {
        await mounted.rest(key, 'GET', base());
        await mounted.mcp(key, 'list_unconverted', { space: S });
      }
      assert.equal(await stateOfItems(), before, 'a list changed an item');
    });

    it('dismisses one item through the mounted route and through the registered tool, as the act does; a reader is refused on the route and the tool is not offered', async () => {
      await arrange(ALL_OPEN);
      const refused = await mounted.rest(who.reader.key, 'POST', `${base()}/${itemOf.p1}/dismiss`);
      assert.equal(refused.status, 403, `a reader dismissed: ${JSON.stringify(refused)}`);
      const hidden = await mounted.mcp(who.reader.key, 'dismiss_unconverted', { space: S, itemId: itemOf.p1 });
      assert.equal(hidden.isError, true, 'a reader dismissed through the tool');
      assert.deepEqual(await statusMap(), { p1: 'open', p2: 'open', o1: 'open', f1: 'open', c1: 'open' }, 'a refused dismiss changed an item');

      const route = await mounted.rest(who.writer.key, 'POST', `${base()}/${itemOf.p1}/dismiss`);
      const expected = await viaAct('dismiss', { itemId: itemOf.p1 }, who.writer.rights, 'rest');
      assert.deepEqual(route, expected, 'the mounted route answered otherwise than the act');
      assert.equal(route.status, 200, JSON.stringify(route));
      assert.equal(route.body.item.status, 'dismissed');
      const tool = await mounted.mcp(who.writer.key, 'dismiss_unconverted', { space: S, itemId: itemOf.p2 });
      assert.deepEqual([tool.isError, tool.body.item.status, tool.body.item.recordId], [false, 'dismissed', 'p2'], JSON.stringify(tool));
      assert.deepEqual(await statusMap(), { p1: 'dismissed', p2: 'dismissed', o1: 'open', f1: 'open', c1: 'open' });

      const unknown = await mounted.rest(who.writer.key, 'POST', `${base()}/no-such-item/dismiss`);
      assert.deepEqual([unknown.status, unknown.body.code], [404, 'unconverted_item_not_found']);
      const toolUnknown = await mounted.mcp(who.writer.key, 'dismiss_unconverted', { space: S, itemId: 'no-such-item' });
      assert.deepEqual([toolUnknown.isError, toolUnknown.body?.code], [true, 'unconverted_item_not_found']);
    });

    it('refuses a malformed item id or a malformed expect by the act\'s own code through the registered tool, as the mounted route does: the dispatcher words none of them', async () => {
      await arrange(ALL_OPEN);
      const before = await stateOfItems();
      for (const itemId of ['', 123, 'x'.repeat(201)]) {
        const expected = await viaAct('dismiss', { itemId }, who.writer.rights, 'mcp');
        assert.deepEqual([expected.status, expected.body.code], [400, 'unconverted_bad_item_id'], JSON.stringify(expected));
        const tool = await mounted.mcp(who.writer.key, 'dismiss_unconverted', { space: S, itemId });
        assert.deepEqual([tool.isError, tool.body?.code, tool.body?.error], [true, 'unconverted_bad_item_id', expected.body.error], `itemId ${JSON.stringify(itemId).slice(0, 20)}: ${tool.text}`);
      }
      for (const expect of [undefined, '3', -1, 1.5, null]) {
        const given = { kind: 'entity', ...(expect === undefined ? {} : { expect }) };
        const expected = await viaAct('shown', given, who.writer.rights, 'mcp');
        assert.deepEqual([expected.status, expected.body.code], [400, 'unconverted_bad_expect'], JSON.stringify(expected));
        const route = await mounted.rest(who.writer.key, 'POST', `${base()}/dismiss`, given);
        assert.deepEqual(route, expected, `expect ${JSON.stringify(expect)}: the mounted route answered otherwise than the act`);
        const tool = await mounted.mcp(who.writer.key, 'dismiss_unconverted_shown', { space: S, ...given });
        assert.deepEqual([tool.isError, tool.body?.code, tool.body?.error], [true, 'unconverted_bad_expect', expected.body.error], `expect ${JSON.stringify(expect)}: ${tool.text}`);
      }
      assert.equal(await stateOfItems(), before, 'a refused dismissal wrote an item');
    });

    it('dismisses every open item a filter lists through the mounted route and the registered tool, exactly the set the list shows, and refuses a wrong count', async () => {
      await arrange(ALL_OPEN);
      const before = await stateOfItems();
      for (const expect of [4, 6]) {
        const wrong = await mounted.rest(who.writer.key, 'POST', `${base()}/dismiss`, { expect });
        assert.deepEqual([wrong.status, wrong.body.code, wrong.body.current], [409, 'unconverted_changed', 5], JSON.stringify(wrong));
        const toolWrong = await mounted.mcp(who.writer.key, 'dismiss_unconverted_shown', { space: S, expect });
        assert.deepEqual([toolWrong.isError, toolWrong.body?.code, toolWrong.body?.current], [true, 'unconverted_changed', 5]);
      }
      const reader = await mounted.rest(who.reader.key, 'POST', `${base()}/dismiss`, { expect: 5 });
      assert.equal(reader.status, 403, `a reader dismissed every open item: ${JSON.stringify(reader)}`);
      assert.equal(await stateOfItems(), before, 'a refused bulk dismiss wrote an item');

      const listed = (await mounted.rest(who.reader.key, 'GET', `${base()}${query({ kind: 'entity' })}`)).body.total;
      assert.equal(listed, 3);
      const route = await mounted.rest(who.writer.key, 'POST', `${base()}/dismiss`, { kind: 'entity', expect: listed });
      assert.deepEqual(route, { status: 200, body: { dismissed: 3 } }, JSON.stringify(route));
      assert.deepEqual(await statusMap(), { p1: 'dismissed', p2: 'dismissed', o1: 'dismissed', f1: 'open', c1: 'open' });
      const tool = await mounted.mcp(who.writer.key, 'dismiss_unconverted_shown', { space: S, expect: 2 });
      assert.deepEqual([tool.isError, tool.body], [false, { dismissed: 2 }], JSON.stringify(tool));
      assert.deepEqual(Object.values(await statusMap()), ['dismissed', 'dismissed', 'dismissed', 'dismissed', 'dismissed']);
      const none = await mounted.rest(who.writer.key, 'POST', `${base()}/dismiss`, { expect: 0 });
      assert.deepEqual([none.status, none.body], [200, { dismissed: 0 }]);
      const missing = await mounted.rest(who.writer.key, 'POST', `${base()}/dismiss`, {});
      assert.deepEqual([missing.status, missing.body.code], [400, 'unconverted_bad_expect']);
    });
  });
});
