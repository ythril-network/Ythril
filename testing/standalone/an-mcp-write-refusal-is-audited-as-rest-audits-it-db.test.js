/**
 * `callTool` audits a write tool's refusal whichever way the refusal arrives — a schema refusal included — as the REST
 * middleware records every response of a mutating route (`Q-315`, R5-3, R6-13).
 *
 * ## The finding
 *
 * A REST write that is refused leaves an audit row under its operation with the status it answered. An MCP tool that
 * answered a refusal by RETURNING a result (`isError`) was recorded at 422; one that THREW was recorded only when it was an
 * ACT (`mcpActOperation`), so the same refusal left a row or not by how the tool happened to say it. `save_entity` and
 * `save_chrono` caught their own `SchemaViolationError` and returned a result, so they were audited; the update tools,
 * `save_fact` and `save_edge` threw it to `callTool`, so they were not. Removing the two own catches (the Q-315 change)
 * would take their rows away too unless `callTool` writes the row for every audited write tool's refusal — which is also
 * the rule an operator reading the trail needs: who tried to write what, and was it refused.
 *
 * ## What is held
 *
 *  - **Every audited record-write tool's schema refusal is a row**: operation as `MCP_TOOL_OPERATIONS` names it, status
 *    422, the path `http:<tool>`, the space and the caller — exactly one row per refused call.
 *  - **The set is derived**, from `MCP_TOOL_OPERATIONS` (every tool whose operation is a record create or update), and
 *    must equal the drivers below: a tool added next year without a refusing case here fails the derivation.
 *  - **Other refusal statuses are rows too**, as REST's are: a refused `graph_merge` (400) and an update of a record that does
 *    not exist (404), both THROWN by the handler; and a call the dispatcher refuses on its arguments (400).
 *  - **A refusal changes nothing and is audited as a refusal**: its row carries no `changes` (a refused edit changed nothing
 *    and its intended values would claim one), as the REST row does.
 *
 * ## Seen red
 *
 * On 85c4c564 the tools that throw (`update_entity`, `update_fact`, `update_edge`, `update_chrono`, `save_fact`, `save_edge`) leave no
 * row for a refused write, and nor does a thrown merge refusal or a not-found update.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/an-mcp-write-refusal-is-audited-as-rest-audits-it-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { waitForValue, holdsWithin } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();

const SPACE = 'refusalaudit';
const META = {
  validationMode: 'strict',
  typeSchemas: {
    entity: { person: { propertySchemas: { age: { type: 'number', required: true } } } },
    chrono: { event: { propertySchemas: { priority: { type: 'string', enum: ['low', 'high'] } } } },
    fact: { claim: { propertySchemas: { confidence: { type: 'number', required: true } } } },
    edge: { knows: { propertySchemas: { since: { type: 'number', required: true } } } },
  },
};
const AUTHOR = { instanceId: 'refusalaudit-receiver', instanceLabel: 'Receiver' };
const T0 = '2026-09-01T00:00:00.000Z';
const RECORD_WRITE_OPERATION = /^(entity|fact|edge|chrono)\.(create|update)$/;

let door, MCP_TOOL_OPERATIONS, edgeIdFor, bumpSeq;

/** The stored records an update is aimed at, one per kind, each valid under the schema. */
const IDS = { entity: randomUUID(), fact: randomUUID(), chrono: randomUUID(), edgeFrom: randomUUID(), edgeTo: randomUUID() };
async function seed() {
  const base = { spaceId: SPACE, tags: [], author: AUTHOR, createdAt: T0, updatedAt: T0 };
  await door.coll(SPACE, 'entities').insertMany([
    { ...base, _id: IDS.entity, name: 'Stored', type: 'person', properties: { age: 5 }, seq: 1 },
    { ...base, _id: IDS.edgeFrom, name: 'From', type: 'person', properties: { age: 1 }, seq: 2 },
    { ...base, _id: IDS.edgeTo, name: 'To', type: 'person', properties: { age: 2 }, seq: 3 },
  ]);
  await door.coll(SPACE, 'facts').insertOne({ ...base, _id: IDS.fact, fact: 'stored fact', type: 'claim', properties: { confidence: 1 }, seq: 4 });
  await door.coll(SPACE, 'chrono').insertOne({ ...base, _id: IDS.chrono, title: 'Stored', type: 'event', startsAt: '2026-10-01T00:00:00.000Z', properties: {}, seq: 5 });
  await door.coll(SPACE, 'edges').insertOne({ ...base, _id: edgeIdFor(IDS.edgeFrom, IDS.edgeTo, 'knows'), from: IDS.edgeFrom, to: IDS.edgeTo,
    label: 'knows', properties: { since: 1 }, seq: 6 });
  await bumpSeq(SPACE, 6);
}

/** One schema-refused call per audited record-write tool. */
const REFUSED = {
  save_entity: () => ({ name: 'Ann', type: 'person', properties: { age: 'old' } }),
  update_entity: () => ({ id: IDS.entity, properties: { age: 'old' } }),
  save_fact: () => ({ fact: 'a claim', type: 'claim', properties: { confidence: 'high' } }),
  update_fact: () => ({ id: IDS.fact, properties: { confidence: 'high' } }),
  save_edge: () => ({ from: IDS.edgeFrom, to: IDS.edgeTo, label: 'knows', properties: { since: 'long ago' } }),
  update_edge: () => ({ id: edgeIdFor(IDS.edgeFrom, IDS.edgeTo, 'knows'), properties: { since: 'long ago' } }),
  save_chrono: () => ({ title: 'Launch', type: 'event', startsAt: '2026-10-01T00:00:00.000Z', properties: { priority: 'urgent' } }),
  update_chrono: () => ({ id: IDS.chrono, properties: { priority: 'urgent' } }),
};

const rowsOf = (tokenId) => door.mongo.getDb().collection('audit_log').find({ tokenId }).toArray();
/** The rows a call left, once at least one has landed (the writer is fire-and-forget, so the row arrives after the answer). */
const rowsAfter = async (tokenId) => waitForValue(async () => { const r = await rowsOf(tokenId); return r.length > 0 ? r : undefined; }, 10_000, 50, undefined,
  { what: `an audit row for ${tokenId}` });

describe('callTool audits a write tool\'s refusal as REST audits its twin', { skip }, () => {
  before(async () => {
    door = await openToolDoor({ suite: 'refusalaudit', spaces: [{ id: SPACE, label: SPACE, folders: [], meta: META }] });
    ({ MCP_TOOL_OPERATIONS } = await import('../../server/dist/mcp/audit-map.js'));
    ({ edgeIdFor } = await import('../../server/dist/brain/edge-id.js'));
    ({ bumpSeq } = await import('../../server/dist/util/seq.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    for (const part of ['entities', 'facts', 'chrono', 'edges']) await door.coll(SPACE, part).deleteMany({});
    await door.mongo.getDb().collection('audit_log').deleteMany({});
    await seed();
  });

  it('the audited record-write tools are derived from the audit map, and every one has a refusing call here', () => {
    const derived = Object.entries(MCP_TOOL_OPERATIONS).filter(([, op]) => typeof op === 'string' && RECORD_WRITE_OPERATION.test(op)).map(([t]) => t).sort();
    assert.ok(derived.length >= 8, `only ${derived.length} record-write tool(s) derived from MCP_TOOL_OPERATIONS: ${derived}`);
    assert.deepEqual(Object.keys(REFUSED).sort(), derived,
      'an audited record-write tool has no refusing call in this file (or a driver names a tool that is no longer one)');
  });

  for (const tool of Object.keys(REFUSED)) {
    it(`${tool}: a schema refusal (422) leaves exactly one audit row, under its operation, with no change list`, async () => {
      const out = await door.call(tool, { space: SPACE, ...REFUSED[tool]() });
      assert.equal(out.status, 422, `${tool} answered ${out.status}: ${out.text}`);
      assert.equal(out.result.isError, true);
      const rows = await rowsAfter(out.tokenId);
      assert.equal(rows.length, 1, `${tool} left ${rows.length} audit rows for one call: ${JSON.stringify(rows.map(r => [r.operation, r.status]))}`);
      const [row] = rows;
      assert.equal(row.operation, MCP_TOOL_OPERATIONS[tool], `${tool}: the row is under ${row.operation}`);
      assert.equal(row.status, 422);
      assert.equal(row.path, `http:${tool}`);
      assert.equal(row.spaceId, SPACE);
      assert.equal(row.method, 'MCP');
      assert.ok(!('changes' in row), `${tool}: a refused write recorded a change list: ${JSON.stringify(row.changes)}`);
    });
  }

  it('the REST twin\'s door (`POST /api/<tool>`) leaves the same row for the same refusal', async () => {
    const out = await door.call('update_entity', { space: SPACE, ...REFUSED.update_entity() }, { transport: 'rest' });
    assert.equal(out.status, 422);
    const [row] = await rowsAfter(out.tokenId);
    assert.deepEqual([row.operation, row.status, row.path], ['entity.update', 422, '/api/update_entity']);
  });

  describe('other refusal statuses are rows too', () => {
    it('graph_merge refused by the strict schema (400, thrown by the handler)', async () => {
      const [survivorId, absorbedId] = [randomUUID(), randomUUID()];
      const base = { spaceId: SPACE, tags: [], author: AUTHOR, createdAt: T0, updatedAt: T0, type: 'person' };
      await door.coll(SPACE, 'entities').insertMany([
        { ...base, _id: survivorId, name: 'N', properties: { age: 1 }, seq: 10 },
        { ...base, _id: absorbedId, name: 'S', properties: { age: 1, note: 'x' }, seq: 11 },
      ]);
      await bumpSeq(SPACE, 11);
      // The merge is refused by the schema, not by this test: a person without a numeric age cannot be the survivor.
      await door.coll(SPACE, 'entities').updateOne({ _id: survivorId }, { $set: { properties: { age: 1 } } });
      const out = await door.call('graph_merge', { space: SPACE, survivorId, absorbedId, resolutions: [{ key: 'age', resolution: 'fn:sum' }] });
      if (out.status !== 400) return assert.fail(`the fixture did not make graph_merge refuse (${out.status}: ${out.text}) — re-anchor this case`);
      const [row] = await rowsAfter(out.tokenId);
      assert.deepEqual([row.operation, row.status], ['entity.merge', 400]);
    });

    it('update_entity of a record that does not exist (404, thrown)', async () => {
      const out = await door.call('update_entity', { space: SPACE, id: randomUUID(), properties: { age: 3 } });
      assert.equal(out.status, 404, `answered ${out.status}: ${out.text}`);
      const [row] = await rowsAfter(out.tokenId);
      assert.deepEqual([row.operation, row.status], ['entity.update', 404]);
    });

    it('a call the dispatcher refuses on its arguments (400): a write with no name', async () => {
      const out = await door.call('save_entity', { space: SPACE, type: 'person' });
      assert.equal(out.status, 400, `answered ${out.status}: ${out.text}`);
      const [row] = await rowsAfter(out.tokenId);
      assert.deepEqual([row.operation, row.status], ['entity.create', 400]);
    });
  });

  it('an accepted write is still one row at its own status, and a read leaves none (the audit is not widened to reads)', async () => {
    const ok = await door.call('update_entity', { space: SPACE, id: IDS.entity, properties: { age: 6 } });
    assert.equal(ok.status, 200, ok.text);
    const [row] = await rowsAfter(ok.tokenId);
    assert.deepEqual([row.operation, row.status], ['entity.update', 200]);
    const read = await door.call('filter', { space: SPACE, collection: 'entities' });
    assert.equal(read.status, 200, read.text);
    assert.equal(await holdsWithin(async () => (await rowsOf(read.tokenId)).length > 0, 600, 50), false, 'a read left an audit row with logReads off');
  });
});
