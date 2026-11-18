/**
 * A schema save that declares a conversion step the schema cannot honour is refused WHOLE, on both doors, before anything is written
 * (`Q-745`, bundle-284 design 2.2 and 1.5).
 *
 * ## What it prevents
 *
 * `convertRecords` is checked against the schema before the edit and the schema after it (`conversionStepIssues`). A save that stored the
 * schema and then found a step wrong would leave the space with the new schema and no conversion, and a networked save would already have
 * opened a round carrying the bad step to every member. So the check is part of PLANNING a save, after the merge (the schema the edit leaves
 * is what a step is held to) and before the plan is returned (the ORDER contract of `planSpaceMetaUpdate`): a bad step answers `400
 * bad_conversion_step` with the index of the step, and the space's meta is the version it was.
 *
 * ## What holds
 *
 * - `PATCH /api/spaces/:id` and `schema_update` answer a step the schema cannot honour with `400 bad_conversion_step` and the step's index;
 *   so does a step that is not a step (a parse failure under `convertRecords`, said by the same code and the index of the step);
 * - nothing is written: the meta, its version and the space's other fields are exactly what they were;
 * - `convertRecords` without a `meta` is `400 convert_needs_meta`, because there is no schema to hold a step to;
 * - `convertRecords` is never stored in the space or merged into its meta;
 * - the order of the refusals: the precondition answers before the steps, and a meta that cannot be stored answers before them;
 * - the plan and the outcome carry the checked steps and the changed types, for the run a later slice starts from them;
 * - on a networked space the round carries the steps, and the proposer's cast signs them (`csig`); a round with no steps carries no key.
 *
 * Run: node --test testing/standalone/a-bad-conversion-step-refuses-the-whole-save-db.test.js
 * (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir, callRoute } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';
import { SELF, P1 } from './_vote-round-sites.mjs';
import { REDOS_PATTERN } from './_invalid-schema-fixtures.mjs';

const dir = tempInstanceDir('ythril-bad-step-');
const skip = await mongoSkipReason();
const SPACE = 'people';
const NET = '11111111-1111-4111-8111-111111111111';
const RIGHTS = { instanceAdmin: true, perSpace: {} };
const string = { type: 'string' };

const PERSON_BEFORE = { propertySchemas: { fullName: string, status: { type: 'string', enum: ['a', 'b'] } } };
const PERSON_AFTER = { propertySchemas: { name: string, status: { type: 'string', enum: ['x', 'y'] } } };
const STEPS = {
  steps: [
    { op: 'renameProperty', kind: 'entity', type: 'Person', from: 'fullName', to: 'name' },
    { op: 'mapEnum', kind: 'entity', type: 'Person', property: 'status', values: { a: 'x', b: 'y' } },
  ],
};
const BAD_ENUM = { steps: [STEPS.steps[0], { ...STEPS.steps[1], values: { a: 'x', b: 'not-in-the-schema' } }] };
const EDIT = { typeSchemas: { entity: { Person: PERSON_AFTER } } };

describe('a bad conversion step refuses the whole save', { skip }, () => {
  let inst;
  let doors;
  let meta;
  before(async () => {
    await openTestMongo('bad_conversion_step');
    inst = await bootSchemaInstance(dir, {
      spaces: [
        { id: SPACE, label: 'People', folders: [], meta: { typeSchemas: { entity: { Person: PERSON_BEFORE } } } },
        { id: 'general', label: 'General', builtIn: true, folders: [] },
      ],
    });
    const { spacesRouter } = await import('../../server/dist/api/spaces.js');
    const tools = await import('../../server/dist/mcp/tools/spaces.js');
    const mcpCtx = (args) => ({ callSpace: SPACE, callSpaces: [SPACE], accessibleSpaceIds: [SPACE], viewReads: new Map(), args: { space: SPACE, ...args }, rights: RIGHTS });
    doors = {
      rest: async (body) => { const r = await callRoute(spacesRouter, 'patch', '/:id', { params: { id: SPACE }, body, authToken: { rights: RIGHTS } }); return { status: r.code, body: r.body }; },
      mcp: async (args) => {
        const r = await tools.schema_updateTool.handle(mcpCtx(args));
        const text = (r.content ?? []).map(c => c.text ?? '').join('\n');
        const m = /Error \((\d{3})\)/.exec(text);
        return { status: r.isError ? Number(m?.[1] ?? 500) : 200, text, body: r.structuredContent };
      },
    };
    meta = await import('../../server/dist/spaces/meta-update.js');
  });
  after(async () => { inst?.close(); await closeTestMongo(); });

  const held = () => ({ meta: inst.heldMeta(SPACE), space: structuredClone(inst.loader.getConfig().spaces.find(s => s.id === SPACE)) });
  const version = () => inst.heldMeta(SPACE).version ?? 0;
  /** The body each door is sent for the same save: REST takes `{ meta, convertRecords }`, the tool takes the meta fields beside `convertRecords`. */
  const save = { rest: (convertRecords) => ({ meta: EDIT, convertRecords }), mcp: (convertRecords) => ({ ...EDIT, convertRecords }) };

  for (const door of ['rest', 'mcp']) {
    describe(`through ${door === 'rest' ? 'PATCH /api/spaces/:id' : 'MCP schema_update'}`, () => {
      it('a step the schema after the edit cannot honour answers 400 bad_conversion_step with its index and writes nothing', async () => {
        inst.reset();
        const before = held();
        const a = await doors[door](save[door](BAD_ENUM));
        assert.equal(a.status, 400, JSON.stringify(a.body ?? a.text));
        assert.equal(a.body.code, 'bad_conversion_step', JSON.stringify(a.body));
        assert.equal(a.body.step, 1, 'the second step is the one the schema cannot honour');
        assert.match(a.body.error ?? a.text, /not-in-the-schema/);
        assert.deepEqual(held(), before, 'a refused save changed the space');
        assert.equal(version(), before.meta.version ?? 0, 'the meta version moved');
      });

      it('a step the schema BEFORE the edit cannot honour is refused too (it names a property the type never declared)', async () => {
        inst.reset();
        const before = held();
        const ghost = { steps: [{ ...STEPS.steps[0], from: 'ghost' }] };
        const a = await doors[door](save[door](ghost));
        assert.equal(a.status, 400);
        assert.equal(a.body.code, 'bad_conversion_step');
        assert.equal(a.body.step, 0);
        assert.deepEqual(held(), before);
      });

      it('an old name the edit still declares is refused: a rename moves a name out of the schema', async () => {
        inst.reset();
        const before = held();
        const both = { typeSchemas: { entity: { Person: { propertySchemas: { ...PERSON_AFTER.propertySchemas, fullName: string } } } } };
        const body = door === 'rest' ? { meta: both, convertRecords: { steps: [STEPS.steps[0]] } } : { ...both, convertRecords: { steps: [STEPS.steps[0]] } };
        const a = await doors[door](body);
        assert.equal(a.status, 400);
        assert.equal(a.body.code, 'bad_conversion_step');
        assert.equal(a.body.step, 0);
        assert.deepEqual(held(), before);
      });

      it('a step that is not a step answers the same code with the index of that step', async () => {
        inst.reset();
        const before = held();
        const a = await doors[door](save[door]({ steps: [STEPS.steps[0], { op: 'dropEverything', kind: 'entity' }] }));
        assert.equal(a.status, 400);
        assert.equal(a.body.code, 'bad_conversion_step', JSON.stringify(a.body));
        assert.equal(a.body.step, 1);
        assert.deepEqual(held(), before);
      });

      it('more steps than the bound answers the same code at the first step past it', async () => {
        inst.reset();
        const before = held();
        const many = { steps: Array.from({ length: 51 }, () => STEPS.steps[0]) };
        const a = await doors[door](save[door](many));
        assert.equal(a.status, 400);
        assert.equal(a.body.code, 'bad_conversion_step', JSON.stringify(a.body));
        assert.equal(a.body.step, 50);
        assert.deepEqual(held(), before);
      });

      it('convertRecords without a meta is 400 convert_needs_meta and nothing is applied, the label included', async () => {
        inst.reset();
        const before = held();
        const body = door === 'rest' ? { label: 'Renamed', convertRecords: {} } : { convertRecords: {} };
        const a = await doors[door](body);
        assert.equal(a.status, 400, JSON.stringify(a.body ?? a.text));
        assert.equal(a.body.code, 'convert_needs_meta', JSON.stringify(a.body));
        assert.deepEqual(held(), before);
      });

      it('a save whose steps hold is accepted, the schema is stored, and convertRecords is stored nowhere', async () => {
        inst.reset();
        const v = version();
        const a = await doors[door](save[door](STEPS));
        assert.equal(a.status, 200, JSON.stringify(a.body ?? a.text));
        assert.equal(version(), v + 1, 'the accepted save did not store the schema');
        assert.ok(inst.heldTypes(SPACE).entity.Person.propertySchemas.name, 'the edit was not stored');
        const stored = JSON.stringify(inst.loader.getConfig().spaces.find(s => s.id === SPACE));
        assert.ok(!/convertRecords/.test(stored), 'convertRecords was stored in the space or its meta');
        assert.ok(!/renameProperty/.test(stored), 'a step was stored in the space or its meta');
      });

      it('`convertRecords: {}` (stamp what conforms, rewrite nothing) is accepted and checks nothing', async () => {
        inst.reset();
        const a = await doors[door](save[door]({}));
        assert.equal(a.status, 200, JSON.stringify(a.body ?? a.text));
      });
    });
  }

  /*
   * Through the real MCP dispatcher (`callTool`), not the handler: the dispatcher validates the arguments against the tool's input schema BEFORE
   * the handler runs, so a step that is not a step, or one past the bound, answered the validator's generic words there while REST answered
   * `bad_conversion_step` with the step (lens sweep S5). The same body, the same answer, on both doors.
   */
  describe('through the MCP dispatcher (tools/call), as REST answers it', () => {
    const viaDispatcher = async (convertRecords) => {
      const { callTool } = await import('../../server/dist/mcp/call-tool.js');
      const out = await callTool({ name: 'schema_update', args: { space: SPACE, ...EDIT, convertRecords },
        caller: { rights: { ...RIGHTS, floor: {}, spaceAdmin: { floor: true, spaces: [] } }, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 'b284-s5', tokenLabel: 'b284-s5' } });
      return { status: out.status, structured: out.result?.structuredContent, text: (out.result?.content ?? []).map(c => c.text ?? '').join('\n') };
    };

    it('a step that is not a step answers 400 bad_conversion_step with the index of that step', async () => {
      inst.reset();
      const before = held();
      const a = await viaDispatcher({ steps: [STEPS.steps[0], { op: 'dropEverything', kind: 'entity' }] });
      // The tool's sentence names the status REST answers; the dispatcher's own status for a refused call is its audit's (422 for any tool refusal).
      assert.match(a.text, /^Error \(400\)/, a.text);
      assert.equal(a.structured?.code, 'bad_conversion_step', `the dispatcher answered: ${a.text}`);
      assert.equal(a.structured.step, 1);
      assert.deepEqual(held(), before);
    });

    it('more steps than the bound answers the same code at the first step past it', async () => {
      inst.reset();
      const a = await viaDispatcher({ steps: Array.from({ length: 51 }, () => STEPS.steps[0]) });
      // The tool's sentence names the status REST answers; the dispatcher's own status for a refused call is its audit's (422 for any tool refusal).
      assert.match(a.text, /^Error \(400\)/, a.text);
      assert.equal(a.structured?.code, 'bad_conversion_step', `the dispatcher answered: ${a.text}`);
      assert.equal(a.structured.step, 50);
    });
  });

  describe('the order of the refusals (the planner\'s contract)', () => {
    const plan = (body, ifMatch) => meta.planSpaceMetaUpdate({ spaceId: SPACE, space: inst.loader.getConfig().spaces.find(s => s.id === SPACE), body, ifMatch });

    it('a stale precondition answers before a bad step', () => {
      inst.reset();
      const d = plan({ meta: EDIT, convertRecords: BAD_ENUM }, String(version() + 9));
      assert.equal(d.ok, false);
      assert.equal(d.refusal.status, 412);
    });

    it('a meta the store would not accept answers before the steps are held to it', () => {
      inst.reset();
      const d = plan({ meta: { typeSchemas: { entity: { Person: { namingPattern: REDOS_PATTERN, propertySchemas: PERSON_AFTER.propertySchemas } } } }, convertRecords: BAD_ENUM });
      assert.equal(d.ok, false);
      assert.notEqual(d.refusal.body.code, 'bad_conversion_step', 'the steps were checked against a schema that was never stored');
    });

    it('the steps are held to the schema the edit LEAVES: a type the edit does not name still counts', () => {
      inst.reset();
      // The edit changes `Other` only; the steps name `Person`, whose definition the merge keeps as it was. `fullName` is declared before and after: still declared.
      const d = plan({ meta: { typeSchemas: { entity: { Other: { propertySchemas: { x: string } } } } }, convertRecords: { steps: [STEPS.steps[0]] } });
      assert.equal(d.ok, false);
      assert.equal(d.refusal.body.code, 'bad_conversion_step');
      assert.equal(d.refusal.body.step, 0);
    });

    it('the plan carries the steps it checked, and carries none for a save that named none', () => {
      inst.reset();
      const d = plan({ meta: EDIT, convertRecords: STEPS });
      assert.equal(d.ok, true, JSON.stringify(d));
      assert.deepEqual(d.plan.convertRecords, STEPS);
      assert.deepEqual(d.plan.changedTypes, ['entity:Person']);
      const none = plan({ meta: EDIT });
      assert.equal(none.ok, true);
      assert.equal(none.plan.convertRecords, undefined);
    });

    it('a refusal is a decision and writes nothing, as every refusal of the planner', () => {
      inst.reset();
      const before = held();
      assert.equal(plan({ meta: EDIT, convertRecords: BAD_ENUM }).ok, false);
      assert.deepEqual(held(), before);
    });
  });

  describe('the outcome of an applied save carries the checked steps and the changed types for the run a later slice starts', () => {
    it('applied: the steps, the changed types and the types a replace dropped', async () => {
      inst.reset();
      const space = inst.loader.getConfig().spaces.find(s => s.id === SPACE);
      const d = meta.planSpaceMetaUpdate({ spaceId: SPACE, space, body: { meta: EDIT, convertRecords: STEPS }, ifMatch: undefined });
      assert.equal(d.ok, true);
      const out = await meta.applySpaceMetaUpdate(d.plan);
      assert.equal(out.outcome, 'applied');
      assert.deepEqual(out.convert, { convertRecords: STEPS, changedTypes: ['entity:Person'], droppedTypes: [] });
    });

    it('a save that named no steps carries no convert', async () => {
      inst.reset();
      const space = inst.loader.getConfig().spaces.find(s => s.id === SPACE);
      const d = meta.planSpaceMetaUpdate({ spaceId: SPACE, space, body: { meta: EDIT }, ifMatch: undefined });
      const out = await meta.applySpaceMetaUpdate(d.plan);
      assert.equal(out.outcome, 'applied');
      assert.equal('convert' in out, false);
    });
  });

  describe('on a networked space the round carries the steps and the proposer signs them', () => {
    const member = (instanceId) => ({ instanceId, label: 'peer', url: 'https://peer.example', tokenHash: 'h', direction: 'both' });
    const network = () => ({
      id: NET, label: 'Net', type: 'closed', origin: 'created', syncSchedule: '', spaces: [SPACE], votingDeadlineHours: 24,
      createdAt: '2026-01-01T00:00:00.000Z', members: [member(P1)], pendingRounds: [],
    });
    const open = async (body) => {
      inst.reset();
      const cfg = inst.loader.getConfig();
      cfg.networks.splice(0, cfg.networks.length, network());
      const space = cfg.spaces.find(s => s.id === SPACE);
      const d = meta.planSpaceMetaUpdate({ spaceId: SPACE, space, body, ifMatch: undefined });
      assert.equal(d.ok, true, JSON.stringify(d));
      const out = await meta.applySpaceMetaUpdate(d.plan);
      return { out, round: inst.loader.getConfig().networks[0].pendingRounds[0], net: inst.loader.getConfig().networks[0] };
    };

    it('the round holds convertRecords beside its changed types, the proposer\'s cast carries csig, and the outcome carries the steps', async () => {
      const signing = await import('../../server/dist/util/signing.js');
      signing.ensureInstanceKeypair();
      const { out, round, net } = await open({ meta: EDIT, convertRecords: STEPS });
      assert.equal(out.outcome, 'vote_pending');
      assert.deepEqual(round.convertRecords, STEPS);
      assert.deepEqual(round.changedTypes, ['entity:Person']);
      const cast = round.votes.find(v => v.instanceId === SELF);
      assert.ok(cast?.csig, `the proposer's cast has no csig: ${JSON.stringify(round.votes)}`);
      assert.equal(signing.convertRecordsSignedByProposer(net, round), true);
      assert.deepEqual(out.convert, { convertRecords: STEPS, changedTypes: ['entity:Person'], droppedTypes: [] });
    });

    it('a save with no steps opens a round with no convertRecords key and a cast with no csig', async () => {
      const { round } = await open({ meta: EDIT });
      assert.equal('convertRecords' in round, false);
      assert.equal('csig' in round.votes.find(v => v.instanceId === SELF), false);
    });

    it('a bad step on a networked space opens no round at all', async () => {
      inst.reset();
      const cfg = inst.loader.getConfig();
      cfg.networks.splice(0, cfg.networks.length, network());
      const space = cfg.spaces.find(s => s.id === SPACE);
      const d = meta.planSpaceMetaUpdate({ spaceId: SPACE, space, body: { meta: EDIT, convertRecords: BAD_ENUM }, ifMatch: undefined });
      assert.equal(d.ok, false);
      assert.equal(d.refusal.body.code, 'bad_conversion_step');
      assert.equal(cfg.networks[0].pendingRounds.length, 0);
    });
  });
});
