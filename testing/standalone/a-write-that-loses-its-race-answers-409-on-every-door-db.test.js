/**
 * An edit that misses the record's version on every attempt answers `409 write_race_lost` on every door that edits a record, never 404
 * (bundle-378, Q-976 S2, contract row 4).
 *
 * ## The rule
 *
 * A local edit writes at the version it read (`writeAtReadVersion`, `brain/write-at-read-version.ts`) and, without `If-Match`, reads again
 * and writes again when another write moved the record meanwhile, a bounded number of times. Its last miss answered `null`, which every
 * caller reads as "not found": a record that is there, and that another writer kept changing, was answered `404 Entity not found` (found by
 * the equal-answers spec's overlapping writes, S1). A lost race is a conflict: retrying is the remedy, which is what 409 says.
 *
 * ## The case
 *
 * A stored row whose version no write filter can match (its `seq` stored as text) is a record every attempt misses while it is there: the
 * loop's last miss on a record that exists, made deterministic. Each kind that forks is edited by REST (the brain router's own PATCH) and by
 * MCP (`callTool`): both answer 409 with the code, and the row is as it was. A record that is not there still answers 404.
 *
 * ## Seen red
 *
 * On d97660409 every edit answers 404 (REST `Entity not found` and its kin; MCP the same refusal).
 *
 * Run: node --test testing/standalone/a-write-that-loses-its-race-answers-409-on-every-door-db.test.js  (a server build and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { FORK_KINDS, initForkFixtures, findHandler } from './_fork-kinds.mjs';
import { fakeRes } from './_vote-round-instance.mjs';

const skip = await mongoSkipReason();
const S = 'b378race';
const CODE = 'write_race_lost';

const EDIT = {
  fact:   { path: '/spaces/:spaceId/facts/:id',    body: { fact: 'edited' },        tool: 'update_fact' },
  entity: { path: '/spaces/:spaceId/entities/:id', body: { name: 'Edited' },       tool: 'update_entity' },
  chrono: { path: '/spaces/:spaceId/chrono/:id',   body: { title: 'Edited' },      tool: 'update_chrono' },
  edge:   { path: '/spaces/:spaceId/edges/:id',    body: { description: 'edited' }, tool: 'update_edge' },
};

describe('a write that loses its race answers 409 on every door', { skip }, () => {
  let door; let routers; let callTool; let rights;

  before(async () => {
    door = await openPushDoor({ suite: 'b378_race', spaces: [{ id: S, label: 'Race', folders: [], meta: {} }] });
    await initForkFixtures();
    routers = {
      fact: (await import('../../server/dist/api/brain/facts.js')).memoriesRouter,
      entity: (await import('../../server/dist/api/brain/entities.js')).entitiesRouter,
      chrono: (await import('../../server/dist/api/brain/chrono.js')).chronoRouter,
      edge: (await import('../../server/dist/api/brain/edges.js')).edgesRouter,
    };
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    rights = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  /** A row of `kind` no version filter matches: its `seq` stored as text. */
  async function unmatchable(kind) {
    const k = FORK_KINDS[kind];
    const id = randomUUID();
    const extra = kind === 'edge' ? { from: randomUUID(), to: randomUUID(), label: 'knows' } : {};
    await door.coll(S, k.family).insertOne({ ...k.row(S, id, 5, { pos: 5, posAtSeq: 5, ...extra }), seq: '5' });
    return id;
  }

  const restPatch = async (kind, id, body) => {
    const handler = findHandler(routers[kind], 'patch', EDIT[kind].path);
    assert.ok(handler, `no PATCH ${EDIT[kind].path}`);
    const res = { ...fakeRes(), end() { this.sent = true; return this; } };
    await handler({ method: 'PATCH', params: { spaceId: S, id }, body, query: {}, authToken: { rights }, headers: {}, get: () => undefined }, res);
    return { status: res.code, body: res.body };
  };
  const mcpEdit = async (kind, id) => {
    const out = await callTool({ name: EDIT[kind].tool, args: { space: S, id, ...EDIT[kind].body },
      caller: { rights, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 'b378race', tokenLabel: 'b378race' } });
    return { status: out.status, error: out.result.isError === true, body: out.result.structuredContent ?? null,
      text: (out.result.content ?? []).map(c => c.text ?? '').join('') };
  };

  for (const kind of Object.keys(EDIT)) {
    it(`${kind}: REST and MCP answer 409 ${CODE} for a lost race, and the row is as it was`, async () => {
      const id = await unmatchable(kind);
      const family = FORK_KINDS[kind].family;
      const before = await door.coll(S, family).findOne({ _id: id });
      const rest = await restPatch(kind, id, EDIT[kind].body);
      assert.equal(rest.status, 409, `REST: a lost race answered ${rest.status} ${JSON.stringify(rest.body)}`);
      assert.equal(rest.body?.code, CODE, `REST: the 409 names its reason: ${JSON.stringify(rest.body)}`);
      const mcp = await mcpEdit(kind, id);
      assert.equal(mcp.error, true, `MCP: ${EDIT[kind].tool} on a lost race was accepted`);
      assert.equal(mcp.status, 409, `MCP: a lost race answered ${mcp.status}: ${mcp.text}`);
      assert.equal(mcp.body?.code, CODE, `MCP: the refusal names its reason: ${JSON.stringify(mcp.body)} ${mcp.text}`);
      assert.deepEqual(await door.coll(S, family).findOne({ _id: id }), before, 'a lost race writes nothing');
    });
  }

  it('a record that is not there still answers 404 on both doors', async () => {
    const rest = await restPatch('entity', randomUUID(), EDIT.entity.body);
    assert.equal(rest.status, 404, `REST: ${rest.status} ${JSON.stringify(rest.body)}`);
    const mcp = await mcpEdit('entity', randomUUID());
    assert.equal(mcp.error, true);
    assert.notEqual(mcp.body?.code, CODE, `MCP: a missing record is not a lost race: ${mcp.text}`);
  });
});
