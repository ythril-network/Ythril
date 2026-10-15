/**
 * What every record-write door answers when a strict space's schema refuses the write — a CHARACTERIZATION of the answers
 * BEFORE bundle-23 (`Q-93`, `Q-315`), green on base 85c4c564 and expected to be EDITED by bundle-23 where it changes them.
 *
 * ## Why this file exists before the change
 *
 * Bundle-23 deliberately changes how the write doors answer a schema refusal (one refusal body from one mapping, `Q-315`;
 * undeclared property keys refused, `Q-93`). A change to an answer is only reviewable against a record of the answer taken BEFORE
 * the code that produced it is gone, and a diff to a pin is exactly the reviewed, visible form of "this answer changed". Every
 * expectation below is a literal for that reason: derived from the server, it would compare the new code with itself.
 *
 * ## What it pins, per door
 *
 *  - **REST create: `400`** with the whole refusal body — `{ error: 'schema_violation', message, introduced, preExisting, violations }` —
 *    for each record kind. The facts create is its own case (the route that once built a body of its own). An edge refused by an
 *    END's type answers the same body with the endpoint field (`fromType`), not a property field.
 *  - **REST PATCH: `422`**, the same body, for each kind.
 *  - **MCP create tools** (`save_entity`, `save_fact`, `save_chrono`, `save_edge`): status `422`, `isError`, the structured body
 *    beside the text, and the text is `Error: schema_violation: <message>` on all four. Until bundle-23 `save_chrono` answered
 *    `Error: schema_violation` and dropped the sentence; its own catch went, so the common path's text is the one it answers now.
 *  - **MCP update tools**: the same status, body and text as the create tools that carry the sentence.
 *  - **`POST /api/<tool>`** (`transport: 'rest'` of the same dispatch): the identical status, text and body as MCP.
 *  - **Nothing is stored** by a refused write, read from the store whole before and after.
 *
 * ## MCP pins fail rather than skip
 *
 * `mongoSkipReason()` skips on a laptop and THROWS under CI, so a runner without the test Mongo fails this file instead of
 * reporting a green nothing. The MCP half needs no session of its own: it runs through `callTool`, the dispatch the MCP transport
 * calls.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-record-write-answers-a-schema-refusal-as-pinned-before-bundle-23-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPinDoors, spaceOf, KINDS } from './_schema-refusal-pins.mjs';

const skip = await mongoSkipReason();
const STRICT = spaceOf('strict');
const START = '2026-10-01T00:00:00.000Z';

/** The refusal body a write that introduces ONE violation answers, as literals. */
const refusal = (field, value, reason) => ({
  error: 'schema_violation',
  message: `The change violates this space's schema: ${field}.`,
  introduced: [{ field, value, reason }],
  preExisting: [],
  violations: [{ field, value, reason }],
});
const NUMBER_GOT_STRING = "expected type 'number', got 'string'";
const PRIORITY = 'must be one of: low, high';

/**
 * One refused write per kind, per verb: the arguments each door takes, and the refusal body every door answers for it.
 * `ids` are the seeded records, so an update names a real one.
 */
const cases = (ids) => ({
  entity: {
    create: { name: 'Ann', type: 'person', properties: { age: 'old' } },
    update: { properties: { age: 'old' } }, id: ids.person1,
    body: refusal('properties.age', 'old', NUMBER_GOT_STRING),
    create_tool: 'save_entity', update_tool: 'update_entity',
  },
  fact: {
    create: { fact: 'the sky is blue', type: 'claim', properties: { confidence: 'high' } },
    update: { properties: { confidence: 'high' } }, id: ids.fact,
    body: refusal('properties.confidence', 'high', NUMBER_GOT_STRING),
    create_tool: 'save_fact', update_tool: 'update_fact',
  },
  chrono: {
    create: { title: 'Launch', type: 'event', startsAt: START, properties: { priority: 'urgent' } },
    update: { properties: { priority: 'urgent' } }, id: ids.chrono,
    body: refusal('properties.priority', 'urgent', PRIORITY),
    create_tool: 'save_chrono', update_tool: 'update_chrono',
  },
  edge: {
    create: { from: ids.person1, to: ids.person2, label: 'knows', properties: { since: 'long ago' } },
    update: { properties: { since: 'long ago' } }, id: ids.edge,
    body: refusal('properties.since', 'long ago', NUMBER_GOT_STRING),
    create_tool: 'save_edge', update_tool: 'update_edge',
  },
});

let pins, ids;

describe('a strict space\'s schema refusal, as every record-write door answers it before bundle-23', { skip }, () => {
  before(async () => { pins = await openPinDoors({ suite: 'pinrefusal' }); });
  after(async () => { await pins?.close(); });
  beforeEach(async () => { ids = await pins.seed(STRICT); });

  it('the fixture reaches a REST route and a tool for every record kind (a floor)', () => {
    assert.deepEqual([...KINDS].sort(), ['chrono', 'edge', 'entity', 'fact']);
    assert.deepEqual(Object.keys(cases({})).sort(), [...KINDS].sort());
  });

  describe('REST create answers 400 with the whole refusal body, and stores nothing', () => {
    for (const kind of KINDS) {
      it(kind, async () => {
        const c = cases(ids)[kind];
        const before_ = await pins.stored(STRICT, kind);
        const out = await pins.rest(kind, 'create', STRICT, { body: c.create });
        assert.equal(out.status, 400, JSON.stringify(out.body));
        assert.deepEqual(out.body, c.body);
        assert.deepEqual(await pins.stored(STRICT, kind), before_, `a refused ${kind} create stored something`);
      });
    }

    it('an edge refused by the TYPE of its end answers the same body on the endpoint field, not a property field', async () => {
      const before_ = await pins.stored(STRICT, 'edge');
      const out = await pins.rest('edge', 'create', STRICT, { body: { from: ids.person1, to: ids.person2, label: 'employs' } });
      assert.equal(out.status, 400, JSON.stringify(out.body));
      assert.deepEqual(out.body, refusal('fromType', 'person', "'employs' declares its from endpoint as one of: org"));
      assert.deepEqual(await pins.stored(STRICT, 'edge'), before_);
    });
  });

  describe('REST PATCH answers 422 with the same body, and stores nothing', () => {
    for (const kind of KINDS) {
      it(kind, async () => {
        const c = cases(ids)[kind];
        const before_ = await pins.stored(STRICT, kind);
        const out = await pins.rest(kind, 'update', STRICT, { id: c.id, body: c.update });
        assert.equal(out.status, 422, JSON.stringify(out.body));
        assert.deepEqual(out.body, c.body);
        assert.deepEqual(await pins.stored(STRICT, kind), before_, `a refused ${kind} update stored something`);
      });
    }
  });

  describe('the MCP create tools answer 422, isError and the structured body, and one text', () => {
    /** The text of each create tool's refusal: the common MCP mapping's `Error: schema_violation: <message>`. */
    // bundle-23: r4.1 Q-315 (MCP own catches in chrono.ts go; call-tool classifies every tool once) — was `Error: schema_violation` for save_chrono
    const TEXT = (c) => `Error: schema_violation: ${c.body.message}`;
    for (const kind of KINDS) {
      it(`${cases({})[kind].create_tool}`, async () => {
        const c = cases(ids)[kind];
        const before_ = await pins.stored(STRICT, kind);
        const out = await pins.call(c.create_tool, { space: STRICT, ...c.create });
        assert.equal(out.status, 422, out.text);
        assert.equal(out.isError, true);
        assert.deepEqual(out.structured, c.body);
        assert.equal(out.text, TEXT(c));
        assert.deepEqual(await pins.stored(STRICT, kind), before_, `a refused ${c.create_tool} stored something`);
      });
    }

    it('save_edge refused by the type of its end carries the endpoint field in the structured body', async () => {
      const out = await pins.call('save_edge', { space: STRICT, from: ids.person1, to: ids.person2, label: 'employs' });
      const want = refusal('fromType', 'person', "'employs' declares its from endpoint as one of: org");
      assert.equal(out.status, 422, out.text);
      assert.deepEqual(out.structured, want);
      assert.equal(out.text, `Error: schema_violation: ${want.message}`);
    });
  });

  describe('the MCP update tools answer 422, isError, the structured body and `Error: schema_violation: <message>`', () => {
    for (const kind of KINDS) {
      it(`${cases({})[kind].update_tool}`, async () => {
        const c = cases(ids)[kind];
        const before_ = await pins.stored(STRICT, kind);
        const out = await pins.call(c.update_tool, { space: STRICT, id: c.id, ...c.update });
        assert.equal(out.status, 422, out.text);
        assert.equal(out.isError, true);
        assert.deepEqual(out.structured, c.body);
        assert.equal(out.text, `Error: schema_violation: ${c.body.message}`);
        assert.deepEqual(await pins.stored(STRICT, kind), before_, `a refused ${c.update_tool} stored something`);
      });
    }
  });

  describe('POST /api/<tool> is the same dispatch: the identical status, text and body as the MCP door', () => {
    for (const kind of KINDS) {
      it(kind, async () => {
        const c = cases(ids)[kind];
        for (const [tool, args] of [[c.create_tool, c.create], [c.update_tool, { id: c.id, ...c.update }]]) {
          const mcp = await pins.call(tool, { space: STRICT, ...args }, { transport: 'mcp' });
          const rest = await pins.call(tool, { space: STRICT, ...args }, { transport: 'rest' });
          assert.equal(rest.status, 422, `${tool}: ${rest.text}`);
          assert.deepEqual([rest.status, rest.text, rest.structured], [mcp.status, mcp.text, mcp.structured], `${tool}: the two transports answered differently`);
        }
      });
    }
  });

  it('the REST status split is a create 400 against an update 422, and the tool dispatch is 422 for both', async () => {
    const c = cases(ids).entity;
    const create = await pins.rest('entity', 'create', STRICT, { body: c.create });
    const update = await pins.rest('entity', 'update', STRICT, { id: c.id, body: c.update });
    const tool = await pins.call('save_entity', { space: STRICT, ...c.create });
    assert.deepEqual([create.status, update.status, tool.status], [400, 422, 422]);
  });
});
