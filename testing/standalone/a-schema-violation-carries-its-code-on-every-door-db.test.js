/**
 * Every door that answers a schema violation answers its `code` and `params` beside its `reason`, REST and MCP alike (Q-943).
 *
 * ## What it prevents
 *
 * The code is given to a row where the validator raises it; a door that projects a row onto the fields it knew (`{ field, reason }`), or
 * a bulk warning said as a sentence only, drops it on the way out, and a screen behind that door shows prose again. The pure test
 * (`every-schema-violation-carries-a-code-and-its-params`) holds the validator; this holds the doors, each asked through the handler or
 * the dispatch production runs (`_schema-refusal-pins.mjs`), and each pair of doors compared row for row.
 *
 * ## The doors, each with its row
 *
 *  - **A refused record write**: `POST /entities` (400), `save_entity` on MCP and on `POST /api/save_entity`: `introduced` rows with
 *    `code: 'type'`, alike on the three.
 *  - **An edge refused by its end's type**: `POST /edges`, `save_edge`: `code: 'endpoint_type'`.
 *  - **A warn space's warnings**: `POST /chrono` (201) and `save_chrono`: `warnings` rows with `code: 'enum'`.
 *  - **A batch**: a refused item's `violation.introduced` rows, and a warned item's row, which carries the violation as `warning`
 *    beside its published `reason` sentence: `POST /bulk` and `save_bulk` alike.
 *  - **The dry run of a sample**: `POST /api/spaces/:id/validate-schema` and `schema_validate`.
 *  - **The unconverted list**: `GET /api/spaces/:id/schema-convert/items` and `list_unconverted` on both transports: an item written by the
 *    item writer keeps the code; an item stored before codes (text only) is listed as it is, without one.
 *
 * Seen red on d7a18d17c: no row carries a code, and a bulk warning row has no `warning`.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-schema-violation-carries-its-code-on-every-door-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPinDoors, spaceOf } from './_schema-refusal-pins.mjs';

const skip = await mongoSkipReason();
const STRICT = spaceOf('strict');
const WARN = spaceOf('warn');
const START = '2026-10-01T00:00:00.000Z';

const AGE_ROW = { field: 'properties.age', value: 'x', reason: "expected type 'number', got 'string'", code: 'type', params: { type: 'number', got: 'string' } };
const PRIORITY_ROW = { field: 'properties.priority', value: 'mid', reason: 'must be one of: low, high', code: 'enum', params: { allowedValues: ['low', 'high'] } };

describe('a schema violation carries its code on every door', { skip }, () => {
  let pins;
  let ids;
  before(async () => { pins = await openPinDoors({ suite: 'violation-code-doors' }); });
  after(async () => { await pins?.close(); });

  describe('a refused record write', () => {
    before(async () => { ids = await pins.seed(STRICT); });

    it('REST, MCP and POST /api/<tool> answer the same row with its code', async () => {
      const body = { name: 'Bad Age', type: 'person', properties: { age: 'x' } };
      const rest = await pins.rest('entity', 'create', STRICT, { body });
      assert.equal(rest.status, 400, JSON.stringify(rest.body));
      assert.deepEqual(rest.body.introduced, [AGE_ROW]);
      for (const transport of ['mcp', 'rest']) {
        const tool = await pins.call('save_entity', { space: STRICT, ...body }, { transport });
        assert.equal(tool.isError, true, tool.text);
        assert.deepEqual(tool.structured.introduced, [AGE_ROW], `save_entity on ${transport}`);
      }
    });

    it('an edge refused by its end\'s type names the rule by code, on both doors', async () => {
      const body = { from: ids.person1, to: ids.person2, label: 'employs' };
      const row = { field: 'fromType', value: 'person', reason: "'employs' declares its from endpoint as one of: org", code: 'endpoint_type',
        params: { label: 'employs', end: 'from', allowedValues: ['org'] } };
      const rest = await pins.rest('edge', 'create', STRICT, { body });
      assert.equal(rest.status, 400, JSON.stringify(rest.body));
      assert.deepEqual(rest.body.introduced, [row]);
      const tool = await pins.call('save_edge', { space: STRICT, ...body });
      assert.deepEqual(tool.structured.introduced, [row]);
    });
  });

  describe('a warn space\'s warnings', () => {
    before(async () => { await pins.seed(WARN); });

    it('REST and MCP answer the same warning row with its code', async () => {
      const body = { title: 'Launch', type: 'event', startsAt: START, properties: { priority: 'mid' } };
      const rest = await pins.rest('chrono', 'create', WARN, { body });
      assert.equal(rest.status, 201, JSON.stringify(rest.body));
      assert.deepEqual(rest.body.warnings, [PRIORITY_ROW]);
      const tool = await pins.call('save_chrono', { space: WARN, ...body, title: 'Launch two' });
      assert.deepEqual(tool.structured.warnings, [PRIORITY_ROW]);
    });
  });

  describe('a batch', () => {
    it('a refused item carries its rows with their codes, on POST /bulk and save_bulk', async () => {
      await pins.seed(STRICT);
      const entities = [{ name: 'Bad Age', type: 'person', properties: { age: 'x' } }];
      const rest = await pins.bulkRest(STRICT, { entities });
      assert.deepEqual(rest.body.errors?.[0]?.violation?.introduced, [AGE_ROW], JSON.stringify(rest.body));
      const tool = await pins.call('save_bulk', { space: STRICT, entities });
      assert.deepEqual(tool.structured.errors?.[0]?.violation?.introduced, [AGE_ROW], JSON.stringify(tool.structured));
    });

    it('a warned item carries its row as `warning` beside the sentence, on POST /bulk and save_bulk', async () => {
      await pins.seed(WARN);
      const chrono = (title) => [{ title, type: 'event', startsAt: START, properties: { priority: 'mid' } }];
      const rest = await pins.bulkRest(WARN, { chrono: chrono('Batch one') });
      const row = rest.body.errors?.find(e => e.reason?.startsWith('schema_warning:'));
      assert.ok(row, JSON.stringify(rest.body));
      assert.equal(row.reason, 'schema_warning: properties.priority — must be one of: low, high');
      assert.deepEqual(row.warning, PRIORITY_ROW);
      const tool = await pins.call('save_bulk', { space: WARN, chrono: chrono('Batch two') });
      assert.deepEqual(tool.structured.errors?.find(e => e.reason?.startsWith('schema_warning:'))?.warning, PRIORITY_ROW, JSON.stringify(tool.structured));
    });
  });

  describe('the dry run of a sample', () => {
    it('the route and the tool answer the same rows with their codes', async () => {
      const sample = { kind: 'entity', record: { name: 'Sample', type: 'person', properties: { age: 'x' } } };
      const { spacesRouter } = await import('../../server/dist/api/spaces.js');
      const rest = await pins.door.request(pins.door.routeHandler(spacesRouter, 'post', '/:id/validate-schema'), { params: { id: STRICT }, body: { sample } });
      assert.equal(rest.status, 200, JSON.stringify(rest.body));
      assert.deepEqual(rest.body.violations, [{ collection: 'entities', violations: [AGE_ROW] }]);
      for (const transport of ['mcp', 'rest']) {
        const tool = await pins.call('schema_validate', { space: STRICT, sample }, { transport });
        assert.deepEqual(tool.structured.violations, [{ collection: 'entities', violations: [AGE_ROW] }], `schema_validate on ${transport}`);
      }
    });
  });

  describe('the unconverted list', () => {
    it('an item written now keeps its codes, and one stored before codes is listed as it is, on every door', async () => {
      await pins.seed(STRICT);
      const { recordUnconvertedItem } = await import('../../server/dist/brain/schema-convert-items.js');
      const { schemaViolation } = await import('../../server/dist/spaces/schema-violation-codes.js').catch(() => ({}));
      assert.equal(typeof schemaViolation, 'function', 'spaces/schema-violation-codes.ts exports no schemaViolation');
      const fresh = { _id: randomUUID(), name: 'Fresh', type: 'person', seq: 1 };
      const violation = schemaViolation('type', { type: 'number', got: 'string' }, 'properties.age', 'x');
      assert.equal(await recordUnconvertedItem(STRICT, { kind: 'entity', record: fresh, toFp: 'f'.repeat(64), reason: 'not_conforming', violations: [violation] }, undefined), 'written');
      const oldId = randomUUID();
      // The item store's own collection (`spaceCollection(space, 'schemaConvertItems')`), written raw as an older release stored it.
      await pins.door.coll(STRICT, 'schema_convert_items').insertOne({
        _id: `old-${oldId}`, kind: 'entity', recordId: oldId, type: 'person', seq: 1, fromFp: null, toFp: 'f'.repeat(64), typeDefinition: 'd',
        reason: 'not_conforming', violations: [{ field: 'properties.age', reason: "expected type 'number', got 'string'" }],
        proposed: { set: [], unset: [] }, status: 'open', detectedAt: '2026-01-01T00:00:00.000Z',
      });
      const want = {
        [fresh._id]: [{ field: 'properties.age', reason: "expected type 'number', got 'string'", code: 'type', params: { type: 'number', got: 'string' } }],
        [oldId]: [{ field: 'properties.age', reason: "expected type 'number', got 'string'" }],
      };
      const byRecord = (items) => Object.fromEntries((items ?? []).map(i => [i.recordId, i.violations]));
      const { spaceUnconvertedRouter } = await import('../../server/dist/api/spaces-unconverted.js');
      const rest = await pins.door.request(pins.door.routeHandler(spaceUnconvertedRouter, 'get', '/:id/schema-convert/items'), { params: { id: STRICT } });
      assert.equal(rest.status, 200, JSON.stringify(rest.body));
      assert.deepEqual(byRecord(rest.body.items), want);
      for (const transport of ['mcp', 'rest']) {
        const tool = await pins.call('list_unconverted', { space: STRICT }, { transport });
        assert.deepEqual(byRecord(tool.structured?.items), want, `list_unconverted on ${transport}: ${tool.text.slice(0, 300)}`);
      }
    });
  });
});
