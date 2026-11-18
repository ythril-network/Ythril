/**
 * The Convert act and the read of a run's status answer alike on every door that runs them (Q-746, bundle-284 design r5 sections 2.3, 5.2 "an act
 * gets 409", 5.4; amendments A1 and A2: owner, 2026-11-18, "yes, as always data that arrives on my instance is mine to manage").
 *
 * ## The rule
 *
 * Start (`POST /api/spaces/:id/schema-convert`, MCP `space_schema_convert`) and status (`GET /api/spaces/:id/schema-convert`, MCP
 * `space_schema_conversion`) are one act module, `spaces/schema-convert-acts.ts`, which the route and the tool only put on the wire. So, for the
 * act itself, the router's handler and the tool's handler (called directly: nothing is mounted or registered until the wiring slice):
 *
 * - the same parameters are accepted and the same refusals answered, with the same status and body: no `types`, more than
 *   `SCHEMA_CONVERT_TYPES_MAX` of them, an unknown kind, an unknown key (there is no opt-in parameter), a bad step (400 `bad_conversion_step`
 *   with its `step` index, and no run started), an unknown space;
 * - a run that is unfinished refuses an explicit start with 409 `schema_convert_running`;
 * - the rights are decided INSIDE the act, so a later mounting cannot forget them: start needs `knowledge: admin` and the space's admin right (a
 *   read-only token, a token with `knowledge: admin` that does not administer the space, and one that administers another space are all refused
 *   and leave no run), status needs `knowledge: read`;
 * - the run the start made rewrites every copy of its type this instance holds, whoever last wrote it (a row written here, one a peer delivered, one
 *   whose author left the network), and leaves a fork row untouched;
 * - status answers the run's counts, and a space with no run in a stable shape (`{ state: 'none' }`), and writes nothing.
 *
 * Seen red on a91e522e: `server/dist/spaces/schema-convert-acts.js` does not exist (no act, no router, no tool).
 *
 * Run: node --test testing/standalone/a-schema-convert-door-answers-alike-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openConvertDoor, CONVERT_META, SEEDED_AT } from './_schema-convert.mjs';
import { moduleOrNull } from './_b81c-door.mjs';
import { RECORD_PARTS } from './_space-snapshot.mjs';
import { waitForValue } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();

/** The space every refusal is asked of: it never has a run, so a refusal that started one is seen. */
const REFUSE = 'scv-refuse';
/** The spaces one door each converts: the same records, so the same answers. */
const VIA_ACT = 'scv-act';
const VIA_ROUTE = 'scv-route';
const VIA_TOOL = 'scv-tool';
/** A space whose run is unfinished (a run document the test wrote, leased far ahead so nothing sweeps it). */
const BUSY = 'scv-busy';
/** A space with no record: a start with the most types a start takes completes at once. */
const MAXED = 'scv-max';
const ALL = [REFUSE, VIA_ACT, VIA_ROUTE, VIA_TOOL, BUSY, MAXED];

const RENAME = { op: 'renameProperty', kind: 'entity', type: 'person', from: 'nick', to: 'alias' };
/** The schema the conversion leads to: `nick` is gone, `alias` is declared. */
const AFTER = structuredClone(CONVERT_META);
AFTER.typeSchemas.entity.person.propertySchemas = { age: { type: 'number' }, alias: { type: 'string' } };
const PERSON = [{ kind: 'entity', type: 'person' }];
const OLD_FP = 'd'.repeat(64);

const ZERO_COUNTS = { stamped: 0, rewritten: 0, unconverted: 0, moved: 0, edgesRestamped: 0 };

describe('the Convert act and the status of a run answer alike on every door (real MongoDB)', { skip }, () => {
  let door, run, acts, router, tools, rights, SPACE_AREAS, max;

  before(async () => {
    door = await openConvertDoor({ name: 'b284doors', spaces: ALL, metaOf: () => AFTER });
    run = await door.runModule();
    acts = await moduleOrNull('spaces/schema-convert-acts.js');
    assert.ok(acts && typeof acts.schemaConvertStartAct === 'function',
      'server/src/spaces/schema-convert-acts.ts (schemaConvertStartAct) is not built: no act starts a conversion of the records of named types');
    const routes = await moduleOrNull('api/spaces-schema-convert.js');
    assert.ok(routes?.spaceSchemaConvertRouter,
      'server/src/api/spaces-schema-convert.ts (spaceSchemaConvertRouter) is not built: no route starts or reads a conversion');
    router = routes.spaceSchemaConvertRouter;
    const toolModule = await moduleOrNull('mcp/tools/schema-convert.js');
    assert.ok(toolModule?.space_schema_convertTool && toolModule?.space_schema_conversionTool,
      'server/src/mcp/tools/schema-convert.ts (space_schema_convertTool, space_schema_conversionTool) is not built: no tool starts or reads a conversion');
    tools = { start: toolModule.space_schema_convertTool, status: toolModule.space_schema_conversionTool };
    ({ SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js'));
    max = run.SCHEMA_CONVERT_TYPES_MAX;

    // The caller each case asks as. A space administrator holds every area of the space; the others are built from the server's own area list.
    const rung = (r) => Object.fromEntries(SPACE_AREAS.map(a => [a, r]));
    rights = {
      spaceAdmin: { perSpace: {}, floor: {}, spaceAdmin: { floor: true, spaces: [] } },
      adminOfOne: { perSpace: {}, floor: {}, spaceAdmin: { floor: false, spaces: [REFUSE] } },
      // Holds the knowledge rung everywhere (so the rung is not what refuses it) and administers a space that is not this one.
      adminOfAnother: { perSpace: {}, floor: { knowledge: 'admin' }, spaceAdmin: { floor: false, spaces: ['another-space'] } },
      knowledgeAdminOnly: { perSpace: {}, floor: { knowledge: 'admin' } },
      readOnly: { perSpace: {}, floor: { ...rung('none'), knowledge: 'read' } },
      filesOnly: { perSpace: {}, floor: { ...rung('none'), files: 'admin' } },
      none: null,
    };
  });
  after(async () => { run?.stopSchemaConvertWatcher(); await door?.close(); });

  // ── The three doors, normalised to one answer ────────────────────────────────────────────────────────────────────────────────────

  /** `{ status, body }` of an answer: `'ok'` for any success (the tool does not carry a status), the HTTP status of a refusal. */
  const answer = (status, body) => ({ status: typeof status === 'number' && status < 300 ? 'ok' : status, body });

  const caller = (r) => ({ rights: r });
  const viaAct = {
    name: 'the act',
    start: async (space, args, r) => { const a = await acts.schemaConvertStartAct(space, args, caller(r)); return answer(a.status, a.body); },
    status: async (space, r) => { const a = await acts.schemaConvertStatusAct(space, caller(r)); return answer(a.status, a.body); },
  };

  /** The final handler of one route of the (unmounted) router: past every middleware, which the wiring slice and the route tests of that slice own. */
  const routeHandler = (method, path) => {
    const layer = router.stack.find(l => l.route?.path === path && l.route.methods?.[method]);
    assert.ok(layer, `${method.toUpperCase()} ${path} is not on the router`);
    return layer.route.stack.at(-1).handle;
  };
  async function request(method, space, body, r) {
    const res = {
      statusCode: 200, body: undefined,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
      setHeader() { return this; },
    };
    const req = { params: { id: space }, query: {}, body, headers: {}, ip: '127.0.0.1', authToken: { id: 'scv-token', name: 'scv-token', rights: r }, get: () => undefined };
    await routeHandler(method, '/:id/schema-convert')(req, res);
    return answer(res.statusCode, res.body);
  }
  const viaRoute = {
    name: 'the route',
    start: (space, args, r) => request('post', space, args, r),
    status: (space, r) => request('get', space, undefined, r),
  };

  const toolContext = (tool, space, args, r) => ({
    args: { space, ...args }, callSpace: space, callSpaces: [space], name: tool.name, transport: 'mcp', cfg: {}, accessibleSpaces: [], accessibleSpaceIds: [space],
    ...(r ? { rights: r } : {}), viewReads: new Map(), rateKey: 'scv',
  });
  async function callTool(tool, space, args, r) {
    try {
      const out = await tool.handle(toolContext(tool, space, args, r));
      assert.ok(out.structuredContent, 'a tool answered without structuredContent');
      assert.equal(out.content[0].text, JSON.stringify(out.structuredContent), 'the tool answers the same body in content and in structuredContent');
      return answer(200, out.structuredContent);
    } catch (err) {
      assert.ok(err && typeof err.status === 'number' && err.body, `the tool threw what is not a refusal with a status and a body: ${err?.stack ?? err}`);
      return answer(err.status, { ...err.body });
    }
  }
  const viaTool = {
    name: 'the tool',
    start: (space, args, r) => callTool(tools.start, space, args, r),
    status: (space, r) => callTool(tools.status, space, {}, r),
  };
  const doors = [viaAct, viaRoute, viaTool];

  /** Ask every door the same thing; every answer must be the one the first door gave. Returns it. */
  async function alike(ask, what) {
    const answers = [];
    for (const d of doors) answers.push(await ask(d));
    for (let i = 1; i < answers.length; i++) assert.deepEqual(answers[i], answers[0], `${what}: ${doors[i].name} answered otherwise than ${doors[0].name}`);
    return answers[0];
  }

  // ── What a test reads of the store ───────────────────────────────────────────────────────────────────────────────────────────────

  const parts = [...RECORD_PARTS];
  /** Everything the conversion could write in `space`: every record collection, the run document, the items, the version counter. */
  async function stateOf(space) {
    const out = {};
    for (const p of parts) out[p] = await door.coll(space, p).find({}).sort({ _id: 1 }).toArray();
    out.run = await door.runDoc(space);
    out.items = await door.itemRows(space);
    out.counter = await door.counter(space);
    return structuredClone(out);
  }
  const noRun = async (space, what) => assert.equal(await door.runDoc(space), null, `${what}: a run was started`);
  const completed = (space) => waitForValue(async () => { const d = await door.runDoc(space); return d?.state === 'complete' ? d : null; },
    30_000, 100, undefined, { what: `the run of ${space} to complete` });

  const seedPeople = (space) => door.seed(space, 'entities', [
    { _id: 'here', name: 'Here', type: 'person', properties: { nick: 'h' } },
    { _id: 'peer', name: 'Peer', type: 'person', properties: { nick: 'p' }, deliveredBy: 'peer-a', author: { instanceId: 'peer-a', instanceLabel: 'A' } },
    { _id: 'gone', name: 'Gone', type: 'person', properties: { nick: 'g' }, deliveredBy: 'departed', author: { instanceId: 'departed', instanceLabel: 'D' } },
    { _id: 'fork-of-here', forkOf: 'here', name: 'Here (theirs)', type: 'person', properties: { nick: 'fork' }, deliveredBy: 'peer-a',
      author: { instanceId: 'peer-a', instanceLabel: 'A' } },
    { _id: 'converted', name: 'Converted', type: 'person', properties: { alias: 'c' }, deliveredBy: 'peer-a',
      author: { instanceId: 'peer-a', instanceLabel: 'A' }, schemaFingerprint: OLD_FP },
  ]);

  // ── Refusals, alike ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

  describe('a request refused is refused alike by the act, the route and the tool, and starts nothing', () => {
    const manyTypes = (n) => Array.from({ length: n }, (_, i) => ({ kind: 'entity', type: `t${i}` }));
    const cases = [
      ['no `types`', {}, 400, 'bad_convert_types'],
      ['an empty `types`', { types: [] }, 400, 'bad_convert_types'],
      ['`types` that is not a list', { types: 'person' }, 400, 'bad_convert_types'],
      ['a type with an unknown kind', { types: [{ kind: 'person', type: 'person' }] }, 400, 'bad_convert_types'],
      ['a type with no name', { types: [{ kind: 'entity', type: '' }] }, 400, 'bad_convert_types'],
      ['the run\'s own marker for a whole kind, sent as a type name', { types: [{ kind: 'entity', type: '*' }] }, 400, 'bad_convert_types'],
      ['a type entry with a key of its own',{ types: [{ kind: 'entity', type: 'person', all: true }] }, 400, 'bad_convert_types'],
      ['one type more than the most a start takes', { types: manyTypes(51) }, 400, 'too_many_convert_types'],
      ['a key the start has no parameter for (there is no take-over option)', { types: PERSON, takeOver: true }, 400, 'bad_convert_request'],
      ['`steps` that is not a list', { types: PERSON, steps: RENAME }, 400, 'bad_convert_request'],
      ['a step the schema now cannot honour (its new name is not declared)', { types: PERSON, steps: [RENAME, { ...RENAME, to: 'handle' }] }, 400, 'bad_conversion_step', 1],
      ['a rename of a property the schema still declares', { types: PERSON, steps: [{ ...RENAME, from: 'age' }] }, 400, 'bad_conversion_step', 0],
      ['a step that is not a step', { types: PERSON, steps: [RENAME, { op: 'explode' }] }, 400, 'bad_conversion_step', 1],
    ];
    for (const [what, body, status, code, step] of cases) {
      it(`${what}: ${status} ${code}${step === undefined ? '' : ` naming step ${step}`}`, async () => {
        const before = await stateOf(REFUSE);
        const got = await alike(d => d.start(REFUSE, body, rights.spaceAdmin), what);
        assert.equal(got.status, status, JSON.stringify(got));
        assert.equal(got.body.code, code, JSON.stringify(got));
        if (step !== undefined) assert.equal(got.body.step, step, `the refusal does not name the step: ${JSON.stringify(got)}`);
        assert.equal(typeof got.body.error, 'string');
        assert.deepEqual(await stateOf(REFUSE), before, `${what}: a refused start wrote something`);
        await noRun(REFUSE, what);
      });
    }

    it('too many steps name the first step past the bound, and the exact number of types is taken', async () => {
      const steps = Array.from({ length: 51 }, (_, i) => ({ ...RENAME, from: `n${i}`, to: `a${i}` }));
      const got = await alike(d => d.start(REFUSE, { types: PERSON, steps }, rights.spaceAdmin), 'too many steps');
      assert.deepEqual([got.status, got.body.code, got.body.step], [400, 'bad_conversion_step', 50], JSON.stringify(got).slice(0, 300));
      await noRun(REFUSE, 'too many steps');
      // The most types a start takes is taken: the act, which the doors share, starts a run (nothing to convert, so it completes at once).
      const started = await acts.schemaConvertStartAct(MAXED, { types: manyTypes(max) }, caller(rights.spaceAdmin));
      assert.equal(started.status < 300, true, JSON.stringify(started));
      assert.equal(started.body.types.length, max);
      await completed(MAXED);
    });

    it('a space that is not configured is answered as an unknown space on every door, before the body is read', async () => {
      const got = await alike(d => d.start('no-such-space', { types: [] }, rights.spaceAdmin), 'an unknown space');
      assert.equal(got.status, 404, JSON.stringify(got));
      assert.match(got.body.error, /no-such-space/);
      const read = await alike(d => d.status('no-such-space', rights.spaceAdmin), 'an unknown space (status)');
      assert.equal(read.status, 404, JSON.stringify(read));
    });
  });

  // ── Rights, decided inside the act ───────────────────────────────────────────────────────────────────────────────────────────────

  describe('the rights are decided inside the act', () => {
    const start = { types: PERSON, steps: [RENAME] };

    for (const [who, r, code] of [
      ['a read-only token (knowledge: read)', 'readOnly', 'knowledge_rung'],
      ['a token holding no knowledge right', 'filesOnly', 'knowledge_rung'],
      ['no rights at all', 'none', 'knowledge_rung'],
      ['a token with knowledge: admin that does not administer the space', 'knowledgeAdminOnly', 'space_admin_required'],
      ['the administrator of another space', 'adminOfAnother', 'space_admin_required'],
    ]) {
      it(`start refuses ${who}: 403 ${code}, and starts nothing`, async () => {
        const before = await stateOf(REFUSE);
        const got = await alike(d => d.start(REFUSE, start, rights[r]), who);
        assert.equal(got.status, 403, JSON.stringify(got));
        assert.equal(got.body.code, code, JSON.stringify(got));
        assert.deepEqual(await stateOf(REFUSE), before, 'a refused start wrote something');
        await noRun(REFUSE, who);
      });
    }

    it('the rights are judged before the body: a caller who may not start is told so, not what is wrong with its request', async () => {
      const got = await alike(d => d.start(REFUSE, { nonsense: 1 }, rights.readOnly), 'a bad body from a read-only token');
      assert.deepEqual([got.status, got.body.code], [403, 'knowledge_rung'], JSON.stringify(got));
    });

    for (const [who, r] of [
      ['knowledge: read', 'readOnly'], ['knowledge: admin without the space\'s admin right', 'knowledgeAdminOnly'],
      ['the space\'s administrator', 'spaceAdmin'], ['the administrator of this one space', 'adminOfOne'],
    ]) {
      it(`status allows ${who}, and a space with no run answers { state: 'none' }`, async () => {
        const got = await alike(d => d.status(REFUSE, rights[r]), who);
        assert.deepEqual(got, { status: 'ok', body: { state: 'none' } });
      });
    }

    for (const [who, r] of [['a token holding no knowledge right', 'filesOnly'], ['no rights at all', 'none']]) {
      it(`status refuses ${who}: 403 knowledge_rung`, async () => {
        const got = await alike(d => d.status(REFUSE, rights[r]), who);
        assert.equal(got.status, 403, JSON.stringify(got));
        assert.equal(got.body.code, 'knowledge_rung');
      });
    }

    it('the administrator of exactly this space may start, and the administrator of another space may not (checked on the act, which no mounting can skip)', async () => {
      const other = await acts.schemaConvertStartAct(MAXED, { types: PERSON }, caller(rights.adminOfOne));
      assert.equal(other.status, 403, `the administrator of ANOTHER space started a conversion here: ${JSON.stringify(other)}`);
      // The last case of this space: an allowed start leaves a run, and the refusals above asked a space that has none.
      const own = await acts.schemaConvertStartAct(REFUSE, { types: [{ kind: 'entity', type: 'nothing-of-this-name' }] }, caller(rights.adminOfOne));
      assert.ok(own.status < 300, JSON.stringify(own));
      await completed(REFUSE);
    });
  });

  // ── A run that is unfinished ─────────────────────────────────────────────────────────────────────────────────────────────────────

  describe('a run that is unfinished', () => {
    const busyRun = () => ({
      _id: 'run', toFp: 'f'.repeat(64), types: [{ kind: 'entity', type: 'person', done: false }], steps: [], splitDeclared: {}, stepsRefused: [],
      sources: [{ kind: 'act', at: SEEDED_AT }], owed: false, syncedFirst: { asked: 0, answered: 0 }, startedAt: SEEDED_AT, cursor: null,
      counts: { ...ZERO_COUNTS, stamped: 7 }, state: 'running', failures: 0, sweepLeaseAt: Date.now() + 3_600_000, generation: 1,
    });

    it('refuses an explicit start with 409 schema_convert_running on every door, and leaves the run as it was', async () => {
      await seedPeople(BUSY);
      await door.mongo.col(door.spaceCollection(BUSY, 'schemaConvertRun')).insertOne(busyRun());
      const before = await stateOf(BUSY);
      const got = await alike(d => d.start(BUSY, { types: PERSON, steps: [RENAME] }, rights.spaceAdmin), 'a start while a run is unfinished');
      assert.equal(got.status, 409, JSON.stringify(got));
      assert.equal(got.body.code, 'schema_convert_running');
      assert.deepEqual(await stateOf(BUSY), before, 'a refused start wrote something');
    });

    it('is read by status as it stands: its state, counts and what is left, alike on every door, and the read writes nothing', async () => {
      const before = await stateOf(BUSY);
      const got = await alike(d => d.status(BUSY, rights.readOnly), 'the status of a running run');
      assert.equal(got.status, 'ok', JSON.stringify(got));
      assert.equal(got.body.state, 'running');
      assert.deepEqual(got.body.counts, { ...ZERO_COUNTS, stamped: 7 });
      // The records of the type that are not forks and do not carry the run's target stamp: the three rows to rewrite and the converted copy.
      assert.equal(got.body.left, 4, 'what is left is not the records of the unfinished type the run has still to read');
      assert.deepEqual(got.body.types, [{ kind: 'entity', type: 'person', done: false }]);
      assert.deepEqual(await stateOf(BUSY), before, 'reading the status wrote something');
    });
  });

  // ── A start that is accepted ─────────────────────────────────────────────────────────────────────────────────────────────────────

  describe('a start that is accepted', () => {
    const spaces = [[viaAct, VIA_ACT], [viaRoute, VIA_ROUTE], [viaTool, VIA_TOOL]];
    const started = new Map();

    it('is answered with the types and the target fingerprint, the same on every door; the run it made is the act\'s', async () => {
      for (const [d, space] of spaces) await seedPeople(space);
      const toFp = door.fp(VIA_ACT);
      const answers = [];
      for (const [d, space] of spaces) {
        const got = await d.start(space, { types: PERSON, steps: [RENAME] }, rights.spaceAdmin);
        answers.push(got);
        started.set(space, got);
        assert.equal(got.status, 'ok', `${d.name}: ${JSON.stringify(got)}`);
      }
      for (const a of answers) assert.deepEqual(a, answers[0]);
      assert.deepEqual(answers[0].body, { state: 'started', toFp, types: PERSON, steps: 1 });
      for (const [, space] of spaces) {
        const doc = await door.runDoc(space);
        assert.equal(doc.toFp, toFp);
        assert.deepEqual(doc.sources.map(s => s.kind), ['act'], 'the run does not say an act started it');
      }
    });

    it('rewrites every copy of its type held here, whoever last wrote it, on every door; a fork is untouched and a converted copy is stamped quietly', async () => {
      for (const [, space] of spaces) {
        const done = await completed(space);
        const toFp = door.fp(space);
        for (const [id, nick] of [['here', 'h'], ['peer', 'p'], ['gone', 'g']]) {
          const row = await door.coll(space, 'entities').findOne({ _id: id });
          assert.deepEqual(row.properties, { alias: nick }, `${space}/${id}: the copy held here was not rewritten`);
          assert.equal(row.schemaFingerprint, toFp, `${space}/${id}: the rewrite carries no stamp`);
          assert.ok(row.seq > 100, `${space}/${id}: a rewrite is a new version`);
        }
        const fork = await door.coll(space, 'entities').findOne({ _id: 'fork-of-here' });
        assert.deepEqual(fork.properties, { nick: 'fork' }, `${space}: a fork row was rewritten`);
        assert.equal(fork.schemaFingerprint, undefined, `${space}: a fork row was stamped`);
        const converted = await door.coll(space, 'entities').findOne({ _id: 'converted' });
        assert.equal(converted.schemaFingerprint, toFp);
        assert.equal(converted.updatedAt, SEEDED_AT, `${space}: a copy that already had the steps' result was rewritten`);
        assert.deepEqual(done.counts, { ...ZERO_COUNTS, rewritten: 3, stamped: 1 }, space);
        assert.deepEqual(await door.itemRows(space), []);
      }
    });

    it('is read by status on every door, alike, as the run left it; the read writes nothing', async () => {
      for (const [, space] of spaces) {
        const before = await stateOf(space);
        const got = await alike(d => d.status(space, rights.readOnly), `the status of ${space}`);
        assert.equal(got.status, 'ok', JSON.stringify(got));
        const body = got.body;
        assert.equal(body.state, 'complete');
        assert.equal(body.toFp, door.fp(space));
        assert.deepEqual(body.types, [{ kind: 'entity', type: 'person', done: true }]);
        assert.deepEqual(body.steps, [RENAME]);
        assert.deepEqual(body.stepsRefused, []);
        assert.deepEqual(body.sources.map(s => s.kind), ['act']);
        assert.deepEqual(body.syncedFirst, { asked: 0, answered: 0 });
        assert.deepEqual(body.counts, { ...ZERO_COUNTS, rewritten: 3, stamped: 1 });
        assert.equal(body.left, 0);
        assert.equal(body.failures, 0);
        assert.deepEqual(await stateOf(space), before, `reading the status of ${space} wrote something`);
      }
    });

    it('a start after a complete run is a new run on every door (the 409 is for an unfinished one only)', async () => {
      for (const d of doors) {
        const again = await d.start(VIA_ACT, { types: PERSON }, rights.spaceAdmin);
        assert.deepEqual(again, { status: 'ok', body: { state: 'started', toFp: door.fp(VIA_ACT), types: PERSON, steps: 0 } }, d.name);
        await completed(VIA_ACT);
      }
    });
  });
});
