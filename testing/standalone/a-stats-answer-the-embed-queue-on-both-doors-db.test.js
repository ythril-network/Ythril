/**
 * REST stats and MCP `space_stats` answer one stats body, `embedQueue` included (bundle-38, Q-169).
 *
 * ## The defect it prevents
 *
 * `GET /api/brain/spaces/:id/stats` answers `embedQueue` (how much of the space is not searchable yet) and MCP `space_stats` built its
 * own answer without it, so an agent asking "is this space ready to search" got the figure on one door and nothing on the other,
 * and the space's counts were written out twice. The body is now built by one function (`spaceStatsAnswer`, `spaces/space-meta-answer.ts`) and both doors send it.
 *
 * ## What is held
 *
 * With three failed jobs in the space's queue and two facts, both doors answer the same keys and the same values, `embedQueue`
 * among them: `{ pending: 0, processing: 0, failed: 3 }`. The figure is poisoned on purpose (3, a value nothing else in the space is),
 * so a door that answers a default of its own fails. A read of REST, then MCP, then REST again must agree, so the MCP answer was
 * compared with a stable value (a worker that drained the queue between the reads would show as a difference).
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-stats-answer-the-embed-queue-on-both-doors-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { listenApp } from '../_shared/in-process-app.mjs';

const skip = await mongoSkipReason();
for (const k of ['SKIP_GLOBAL_RATE_LIMIT', 'SKIP_AUTH_RATE_LIMIT', 'SKIP_SYNC_RATE_LIMIT']) process.env[k] = 'true';
process.env['YTHRIL_RATE_LIMIT_PER_MINUTE'] ??= '1000000';

// A space this run made (the count gate refuses two reads of a fixed space: other files write into those).
const S = `qstats-${process.pid}`;
const FAILED_JOBS = 3;
const OLD = '2026-01-01T00:00:00.000Z';

let door, server, base, adminKey, callTool, ADMIN;

const failedJob = (space, id) => ({
  _id: `fact:${id}`, spaceId: space, recordType: 'fact', recordId: id, status: 'failed', priority: 0,
  attempts: 5, transientFailures: 0, lostChildFailures: 0, maxAttempts: 5, lastError: 'embedder unreachable',
  claimedAt: null, progressAt: null, claimableAfter: null, claimToken: null, createdAt: OLD, updatedAt: OLD,
});
const fact = (space, i) => ({ _id: `${space}-f${i}`, spaceId: space, fact: `fact ${i}`, tags: [], seq: i, pos: i, posAtSeq: i, createdAt: OLD, updatedAt: OLD });

async function restStats(space) {
  const r = await fetch(`${base}/api/brain/spaces/${space}/stats`, { headers: { authorization: `Bearer ${adminKey}` } });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
async function mcpStats(space) {
  const out = await callTool({
    name: 'space_stats', args: { space },
    caller: { rights: ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' },
  });
  assert.notEqual(out.result.isError, true, JSON.stringify(out.result));
  return { structured: out.result.structuredContent, text: JSON.parse(out.result.content.map(c => c.text).join('')) };
}

describe('REST stats and MCP space_stats answer one body, embedQueue included (real MongoDB)', { skip }, () => {
  before(async () => {
    door = await openPushDoor({
      suite: 'qstats',
      spaces: [{ id: S, label: S, folders: [], meta: { suppressEmbeddings: true } }],
    });
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    const tokens = await import('../../server/dist/auth/tokens.js');
    adminKey = (await tokens.createToken({ name: 'qstats-admin', admin: true })).plaintext;
    server = await listenApp();
    base = server.url;
    await door.coll(S, 'facts').insertMany([fact(S, 1), fact(S, 2)]);
    await door.mongo.col(`${S}_embed_jobs`).insertMany([...Array(FAILED_JOBS).keys()].map(i => failedJob(S, `job${i}`)));  });
  after(async () => {
    await server?.close();
    await door?.close();
  });

  it('both doors answer embedQueue with the figures of the space\'s queue', async () => {
    const first = await restStats(S);
    const mcp = await mcpStats(S);
    const again = await restStats(S);
    assert.deepEqual(first.embedQueue, { pending: 0, processing: 0, failed: FAILED_JOBS }, `REST stats: ${JSON.stringify(first)}`);
    assert.deepEqual(again.embedQueue, first.embedQueue, 'the queue moved between the two REST reads: the MCP read below was compared with an unstable value');
    assert.deepEqual(mcp.structured.embedQueue, first.embedQueue,
      `MCP space_stats answers embedQueue ${JSON.stringify(mcp.structured.embedQueue)}, REST stats ${JSON.stringify(first.embedQueue)}: an agent asking whether the space is ready to search is answered on one door only`);
  });

  it('both doors answer the same keys and the same values, in the structured half and in the text half', async () => {
    const rest = await restStats(S);
    const mcp = await mcpStats(S);
    assert.equal(rest.facts, 2, 'fixture: the two facts are not counted');
    assert.deepEqual(Object.keys(mcp.structured).sort(), Object.keys(rest).sort(), 'the doors answer different keys');
    assert.deepEqual(mcp.structured, rest);
    assert.deepEqual(mcp.text, mcp.structured, 'the two halves of the MCP answer differ');
  });
});
