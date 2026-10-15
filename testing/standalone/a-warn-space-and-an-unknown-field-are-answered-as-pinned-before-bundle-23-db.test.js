/**
 * What each write door says in a `warn` space, to an unknown top-level field, and to a property key the type does not declare — a
 * CHARACTERIZATION of the answers BEFORE bundle-23 (`Q-93`, `Q-315`, `Q-320`), green on base 85c4c564 and expected to be EDITED by
 * bundle-23 where it changes them.
 *
 * ## Why this file exists before the change
 *
 * Bundle-23 changes three answers at once and each is only reviewable against a record of today's: a `warn` space's output is
 * unified into one `warnings` shape on every door (`Q-315`); an unknown top-level field gets ONE rule on REST and MCP (`Q-320`);
 * and an undeclared property key becomes a violation (`Q-93`). Every expectation is a literal: derived from the server it would
 * compare the new code with itself.
 *
 * ## What it pins
 *
 * **Warn output, per door.** A write that breaks the schema in a `warn` space LANDS, and each door says so its own way:
 *  - REST create (`201`) and PATCH (`200`) answer the record with a `warnings` array of `{ field, value, reason }`;
 *  - the MCP create tools print a `⚠️ Schema: <field> — <reason>` line; `save_edge` also carries the rows as `violations` in
 *    its structured content, `save_entity` and `save_fact` carry none, and `save_chrono` has no structured content at all;
 *  - the MCP UPDATE tools say NOTHING under `warn` (no line, no rows) — the record is stored with the violation.
 *
 * **An unknown top-level field, per door.**
 *  - REST single-record writes ACCEPT it and answer a `warnings` row `{ field, value, reason: 'unknown field — ignored. This route
 *    accepts: <the route's keys>' }`; the record is stored without it;
 *  - the MCP record tools REFUSE it: `400`, `Error: Invalid arguments for '<tool>': (arguments): unexpected property '<key>'`;
 *  - bulk refuses an unknown TOP-LEVEL key on both doors (`400`, the allowed list — and the MCP list also names `space` and
 *    `targetSpace`), and IGNORES an unknown key on an ITEM on both, silently.
 *
 * **An undeclared property key, per door.** In a strict space a key the type's `propertySchemas` does not declare is ACCEPTED today
 * on every door that stores a record — REST create and PATCH, the MCP create tools, bulk — with no warning, and stored. This is the
 * answer `Q-93` flips: the pins here are the "before" of that diff.
 *
 * ## MCP pins fail rather than skip
 *
 * `mongoSkipReason()` skips on a laptop and THROWS under CI, so a runner without the test Mongo fails this file. The MCP half runs
 * through `callTool`, the dispatch the MCP transport calls; it needs no session of its own.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-warn-space-and-an-unknown-field-are-answered-as-pinned-before-bundle-23-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPinDoors, spaceOf, KINDS } from './_schema-refusal-pins.mjs';

const skip = await mongoSkipReason();
const STRICT = spaceOf('strict');
const WARN = spaceOf('warn');
const START = '2026-10-01T00:00:00.000Z';
const UNDECLARED = 'zzNotDeclared';

const NUMBER_GOT_STRING = "expected type 'number', got 'string'";
const PRIORITY = 'must be one of: low, high';

/** One violating write per kind: what it sends, the warning row it earns in a `warn` space, and the field it breaks. */
const violating = (ids) => ({
  entity: {
    create: { name: 'Ann', type: 'person', properties: { age: 'old' } }, update: { id: ids.person1, properties: { age: 'old' } },
    row: { field: 'properties.age', value: 'old', reason: NUMBER_GOT_STRING },
    create_tool: 'save_entity', update_tool: 'update_entity',
  },
  fact: {
    create: { fact: 'the sky is blue', type: 'claim', properties: { confidence: 'high' } }, update: { id: ids.fact, properties: { confidence: 'high' } },
    row: { field: 'properties.confidence', value: 'high', reason: NUMBER_GOT_STRING },
    create_tool: 'save_fact', update_tool: 'update_fact',
  },
  chrono: {
    create: { title: 'Launch', type: 'event', startsAt: START, properties: { priority: 'urgent' } }, update: { id: ids.chrono, properties: { priority: 'urgent' } },
    row: { field: 'properties.priority', value: 'urgent', reason: PRIORITY },
    create_tool: 'save_chrono', update_tool: 'update_chrono',
  },
  edge: {
    create: { from: ids.person1, to: ids.person2, label: 'knows', properties: { since: 'long ago' } }, update: { id: ids.edge, properties: { since: 'long ago' } },
    row: { field: 'properties.since', value: 'long ago', reason: NUMBER_GOT_STRING },
    create_tool: 'save_edge', update_tool: 'update_edge',
  },
});

/** A VALID write per kind (nothing the schema refuses), to which a case adds the one thing it asks about. */
const valid = (ids) => ({
  entity: { create: { name: 'Org Two', type: 'org' }, update: { id: ids.org, description: 'edited' } },
  fact: { create: { fact: 'a plain fact' }, update: { id: ids.fact, description: 'edited' } },
  chrono: { create: { title: 'Plain', type: 'event', startsAt: START }, update: { id: ids.chrono, description: 'edited' } },
  edge: { create: { from: ids.person1, to: ids.person2, label: 'knows', properties: { since: 1 } }, update: { id: ids.edge, description: 'edited' } },
});

/** The keys a route says it accepts, per kind and verb — the text a REST single-record write answers for an unknown field. */
const ACCEPTS = {
  entity: {
    create: 'checkContradictions, checkDuplicates, description, dupeThreshold, edges, id, linkChronos, linkEntities, linkFacts, linkFiles, name, properties, superseded, suppressEmbeddings, tags, ttlDays, type, waitForEmbedding',
    update: 'checkContradictions, checkDuplicates, deleteFields, description, dupeThreshold, edges, linkChronos, linkEntities, linkFacts, linkFiles, name, properties, superseded, suppressEmbeddings, tags, ttlDays, type, waitForEmbedding',
  },
  fact: {
    create: 'checkContradictions, checkDuplicates, description, dupeThreshold, edges, fact, id, linkChronos, linkEntities, linkFacts, linkFiles, properties, superseded, suppressEmbeddings, tags, ttlDays, type, waitForEmbedding',
    update: 'checkContradictions, checkDuplicates, deleteFields, description, dupeThreshold, edges, fact, linkChronos, linkEntities, linkFacts, linkFiles, properties, superseded, suppressEmbeddings, tags, ttlDays, type, waitForEmbedding',
  },
  chrono: {
    create: 'checkContradictions, checkDuplicates, confidence, description, dupeThreshold, edges, endsAt, id, linkChronos, linkEntities, linkFacts, linkFiles, properties, recurrence, startsAt, status, superseded, suppressEmbeddings, tags, title, ttlDays, type, waitForEmbedding',
    update: 'checkContradictions, checkDuplicates, confidence, deleteFields, description, dupeThreshold, edges, endsAt, linkChronos, linkEntities, linkFacts, linkFiles, properties, recurrence, startsAt, status, superseded, suppressEmbeddings, tags, title, ttlDays, type, waitForEmbedding',
  },
  edge: {
    create: 'checkContradictions, checkDuplicates, description, dupeThreshold, from, fromKind, label, properties, superseded, suppressEmbeddings, tags, to, toKind, ttlDays, type, waitForEmbedding, weight',
    update: 'checkContradictions, checkDuplicates, deleteFields, description, dupeThreshold, fromKind, label, properties, superseded, suppressEmbeddings, tags, toKind, ttlDays, type, waitForEmbedding, weight',
  },
};

/** What the MCP create tools print under `warn` after the sentence of the write: one line per violation. */
const warnLine = (row) => `⚠️ Schema: ${row.field} — ${row.reason}`;

let pins, ids, warnIds;

describe('a warn space, an unknown field and an undeclared key, as every write door answers them before bundle-23', { skip }, () => {
  before(async () => { pins = await openPinDoors({ suite: 'pinwarnunknown' }); });
  after(async () => { await pins?.close(); });
  beforeEach(async () => { ids = await pins.seed(STRICT); warnIds = await pins.seed(WARN); });

  it('every kind has a case in each table below (a floor)', () => {
    for (const table of [violating(ids), valid(ids), ACCEPTS]) assert.deepEqual(Object.keys(table).sort(), [...KINDS].sort());
  });

  describe('warn output', () => {
    describe('REST create answers 201 with a `warnings` row, and the record lands', () => {
      for (const kind of KINDS) {
        it(kind, async () => {
          const c = violating(warnIds)[kind];
          const out = await pins.rest(kind, 'create', WARN, { body: c.create });
          assert.equal(out.status, 201, JSON.stringify(out.body));
          assert.deepEqual(out.body.warnings, [c.row]);
          assert.equal(out.body.error, undefined);
          assert.ok((await pins.stored(WARN, kind)).some(d => d._id === out.body._id), 'the warned write did not land');
        });
      }
      it('an edge whose end has the wrong type warns on the endpoint field', async () => {
        const out = await pins.rest('edge', 'create', WARN, { body: { from: warnIds.person1, to: warnIds.person2, label: 'employs' } });
        assert.equal(out.status, 201, JSON.stringify(out.body));
        assert.deepEqual(out.body.warnings, [{ field: 'fromType', value: 'person', reason: "'employs' declares its from endpoint as one of: org" }]);
      });
    });

    describe('REST PATCH answers 200 with a `warnings` row, and the edit lands', () => {
      for (const kind of KINDS) {
        it(kind, async () => {
          const c = violating(warnIds)[kind];
          const { id, ...patch } = c.update;
          const out = await pins.rest(kind, 'update', WARN, { id, body: patch });
          assert.equal(out.status, 200, JSON.stringify(out.body));
          assert.deepEqual(out.body.warnings, [c.row]);
        });
      }
    });

    describe('the MCP create tools print one `⚠️ Schema:` line after the sentence of the write', () => {
      for (const kind of KINDS) {
        it(violating({})[kind].create_tool, async () => {
          const c = violating(warnIds)[kind];
          const out = await pins.call(c.create_tool, { space: WARN, ...c.create });
          assert.equal(out.status, 200, out.text);
          assert.equal(out.isError, false);
          const lines = out.text.split('\n');
          assert.equal(lines.length, 2, out.text);
          assert.equal(lines[1], warnLine(c.row));
        });
      }

      it('and where they put the rows: save_edge carries `violations`; save_entity and save_fact carry none; save_chrono has no structured content', async () => {
        const saw = {};
        for (const kind of KINDS) {
          const c = violating(warnIds)[kind];
          const out = await pins.call(c.create_tool, { space: WARN, ...c.create });
          saw[c.create_tool] = { warnings: out.structured?.warnings, violations: out.structured?.violations, structured: out.structured !== undefined };
        }
        assert.deepEqual(saw, {
          save_entity: { warnings: undefined, violations: undefined, structured: true },
          save_fact: { warnings: undefined, violations: undefined, structured: true },
          save_chrono: { warnings: undefined, violations: undefined, structured: false },
          save_edge: { warnings: undefined, violations: [violating(warnIds).edge.row], structured: true },
        });
      });
    });

    describe('the MCP update tools say nothing of the violation under warn, and the edit lands', () => {
      for (const kind of KINDS) {
        it(violating({})[kind].update_tool, async () => {
          const c = violating(warnIds)[kind];
          const out = await pins.call(c.update_tool, { space: WARN, ...c.update });
          assert.equal(out.status, 200, out.text);
          assert.equal(out.isError, false);
          assert.doesNotMatch(out.text, /Schema|⚠/, `an update tool printed the warning: ${out.text}`);
          assert.equal(out.structured?.warnings, undefined);
          assert.equal(out.structured?.violations, undefined);
        });
      }
    });
  });

  describe('an unknown top-level field', () => {
    describe('REST create and PATCH accept it, answer a `warnings` row, and store the record without it', () => {
      for (const kind of KINDS) {
        it(kind, async () => {
          const v = valid(ids)[kind];
          const created = await pins.rest(kind, 'create', STRICT, { body: { ...v.create, bogus: 1 } });
          assert.equal(created.status, 201, JSON.stringify(created.body));
          assert.deepEqual(created.body.warnings, [{ field: 'bogus', value: 1, reason: `unknown field — ignored. This route accepts: ${ACCEPTS[kind].create}` }]);
          assert.equal((await pins.stored(STRICT, kind)).find(d => d._id === created.body._id).bogus, undefined, 'the unknown field was stored');

          const { id, ...patch } = v.update;
          const updated = await pins.rest(kind, 'update', STRICT, { id, body: { ...patch, bogus: 1 } });
          assert.equal(updated.status, 200, JSON.stringify(updated.body));
          assert.deepEqual(updated.body.warnings, [{ field: 'bogus', value: 1, reason: `unknown field — ignored. This route accepts: ${ACCEPTS[kind].update}` }]);
        });
      }
    });

    describe('the MCP record tools refuse it with 400, and store nothing', () => {
      for (const kind of KINDS) {
        it(kind, async () => {
          const v = valid(ids)[kind];
          const c = violating({})[kind];
          const before_ = await pins.stored(STRICT, kind);
          const create = await pins.call(c.create_tool, { space: STRICT, ...v.create, bogus: 1 });
          assert.deepEqual([create.status, create.isError, create.text],
            [400, true, `Error: Invalid arguments for '${c.create_tool}': (arguments): unexpected property 'bogus'`]);
          const update = await pins.call(c.update_tool, { space: STRICT, ...v.update, bogus: 1 });
          assert.deepEqual([update.status, update.isError, update.text],
            [400, true, `Error: Invalid arguments for '${c.update_tool}': (arguments): unexpected property 'bogus'`]);
          assert.deepEqual(await pins.stored(STRICT, kind), before_);
        });
      }
    });

    describe('bulk', () => {
      it('an unknown TOP-LEVEL key is refused 400 on both doors, each naming its own allowed list', async () => {
        const body = { entities: [{ name: 'Org Three', type: 'org' }], bogus: 1 };
        const rest = await pins.bulkRest(STRICT, body);
        assert.deepEqual([rest.status, rest.body], [400, { error: 'Unknown field(s): bogus. Allowed: facts, entities, edges, chrono', unrecognized_keys: ['bogus'] }]);
        const mcp = await pins.call('save_bulk', { space: STRICT, ...body });
        assert.deepEqual([mcp.status, mcp.isError, mcp.text], [400, true, 'Error: Unknown field(s): bogus. Allowed: facts, entities, edges, chrono, space, targetSpace']);
        assert.equal((await pins.stored(STRICT, 'entity')).some(d => d.name === 'Org Three'), false, 'a refused bulk stored an item');
      });

      it('an unknown key on an ITEM is ignored silently on both doors: the item is stored, no error row, no warning', async () => {
        const rest = await pins.bulkRest(STRICT, { entities: [{ name: 'Item Rest', type: 'org', bogus: 1 }] });
        assert.equal(rest.status, 207, JSON.stringify(rest.body));
        assert.deepEqual(rest.body.errors, []);
        const mcp = await pins.call('save_bulk', { space: STRICT, entities: [{ name: 'Item Mcp', type: 'org', bogus: 1 }] });
        assert.equal(mcp.isError, false, mcp.text);
        assert.deepEqual(mcp.structured.errors, []);
        const stored = await pins.stored(STRICT, 'entity');
        for (const name of ['Item Rest', 'Item Mcp']) {
          const d = stored.find(e => e.name === name);
          assert.ok(d, `${name} was not stored`);
          assert.equal(d.bogus, undefined);
        }
      });
    });
  });

  describe('an undeclared property key is ACCEPTED on every door today, in a strict and a warn space alike, with no warning', () => {
    /** The write each kind takes with `UNDECLARED` added to a type that declares other properties (a write the schema otherwise accepts). */
    const withKey = (ids_) => ({
      entity: { create: { name: 'Ann', type: 'person', properties: { age: 3, [UNDECLARED]: 1 } }, update: { id: ids_.person1, properties: { [UNDECLARED]: 1 } } },
      fact: { create: { fact: 'a claim', type: 'claim', properties: { confidence: 2, [UNDECLARED]: 1 } }, update: { id: ids_.fact, properties: { [UNDECLARED]: 1 } } },
      chrono: { create: { title: 'Launch', type: 'event', startsAt: START, properties: { priority: 'low', [UNDECLARED]: 1 } }, update: { id: ids_.chrono, properties: { [UNDECLARED]: 1 } } },
      edge: { create: { from: ids_.person1, to: ids_.person2, label: 'knows', properties: { since: 3, [UNDECLARED]: 1 } }, update: { id: ids_.edge, properties: { [UNDECLARED]: 1 } } },
    });
    const carries = (doc) => doc?.properties?.[UNDECLARED] === 1;

    for (const space of [STRICT, WARN]) {
      for (const kind of KINDS) {
        it(`${space}: ${kind} — REST create, REST PATCH and the MCP create tool store the key`, async () => {
          const ids_ = space === STRICT ? ids : warnIds;
          const w = withKey(ids_)[kind];
          const c = violating(ids_)[kind];

          const created = await pins.rest(kind, 'create', space, { body: w.create });
          assert.equal(created.status, 201, JSON.stringify(created.body));
          assert.equal(created.body.warnings, undefined, 'an undeclared key was warned about');
          assert.ok(carries(await pins.door.coll(space, { entity: 'entities', fact: 'facts', chrono: 'chrono', edge: 'edges' }[kind]).findOne({ _id: created.body._id })));

          const { id, ...patch } = w.update;
          const patched = await pins.rest(kind, 'update', space, { id, body: patch });
          assert.equal(patched.status, 200, JSON.stringify(patched.body));
          assert.equal(patched.body.warnings, undefined);
          assert.ok(carries((await pins.stored(space, kind)).find(d => d._id === id)));

          // A different name, so the tool's own "an entity with this name already exists" line is not mistaken for a schema warning.
          const viaTool = await pins.call(c.create_tool, { space, ...w.create, ...(kind === 'entity' ? { name: 'Ann by tool' } : {}) });
          assert.equal(viaTool.isError, false, viaTool.text);
          assert.doesNotMatch(viaTool.text, /Schema:/, `an undeclared key was warned about: ${viaTool.text}`);
        });
      }
    }

    it('bulk stores it too, on both doors, with no error row', async () => {
      const rest = await pins.bulkRest(STRICT, { entities: [{ name: 'Bulk Rest', type: 'person', properties: { age: 3, [UNDECLARED]: 1 } }] });
      assert.deepEqual([rest.status, rest.body.errors], [207, []]);
      const mcp = await pins.call('save_bulk', { space: STRICT, entities: [{ name: 'Bulk Mcp', type: 'person', properties: { age: 3, [UNDECLARED]: 1 } }] });
      assert.deepEqual([mcp.isError, mcp.structured.errors], [false, []]);
      const stored = await pins.stored(STRICT, 'entity');
      assert.ok(carries(stored.find(d => d.name === 'Bulk Rest')) && carries(stored.find(d => d.name === 'Bulk Mcp')));
    });
  });
});
