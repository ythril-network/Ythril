/**
 * A reindex's progress is ONE answer — `reindex-status`, the REST meta route and MCP `space_meta` say the same thing.
 *
 * ## Why three reads of one fact
 *
 * Q-99 part 2 makes a reindex a run the queue finishes, and adds `reindexRun: {running, remaining, failed}` so a caller
 * can see it. The fact has three doors: `GET /api/brain/spaces/:id/reindex-status` (what the client polls),
 * `GET /api/spaces/:id/meta` and the `space_meta` tool (what an agent reads, and what `space_reindex`'s description
 * tells it to poll). The plan computes all three from `reindexStateFor`; this holds them to it from outside, which is
 * the only place a door that computes its own copy would show.
 *
 * ## The sandwich
 *
 * Status, then the two meta doors, then status again — and the two status reads must agree before the meta reads
 * are compared to them. A run can change between reads; agreeing bookends are what make a difference between doors a
 * difference of DOORS rather than of time.
 *
 * ## How the run is held open
 *
 * By seeding an active run document (and one failed rebuild job, so `failed` is not trivially 0) straight into
 * instance A's database — `testing/_shared/reindex-run-seed.mjs` says why a real run cannot be held deterministically.
 *
 * Run: node --test testing/integration/reindex-progress-is-one-answer-on-every-door.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, delWithBody } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';
import {
  seedActiveReindexRun, seedFailedRebuildJob, clearSeededReindexState, closeReindexSeed,
} from '../_shared/reindex-run-seed.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const BUSY = `reindex-doors-busy-${RUN}`;
const IDLE = `reindex-doors-idle-${RUN}`;

let token;
let session;
const created = [];

const statusDoor = async (id) => {
  const r = await get(INSTANCES.a, token, `/api/brain/spaces/${id}/reindex-status`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.reindexRun;
};
const restMetaDoor = async (id) => {
  const r = await get(INSTANCES.a, token, `/api/spaces/${id}/meta`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.reindexRun;
};
const toolRestDoor = async (id) => {
  const r = await post(INSTANCES.a, token, '/api/space_meta', { space: id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body?.data?.reindexRun;
};
const mcpDoor = async (id) => {
  const r = await session.callTool('space_meta', { space: id });
  assert.ok(!r?.isError, JSON.stringify(r));
  return r?.structuredContent?.reindexRun;
};

/** A, B…, A: the bookends must agree, and every door between them must equal them. */
async function sandwich(id) {
  const first = await statusDoor(id);
  const restMeta = await restMetaDoor(id);
  const toolRest = await toolRestDoor(id);
  const mcp = await mcpDoor(id);
  const last = await statusDoor(id);
  assert.deepEqual(first, last, 'the run changed between the bookend reads — the comparison below would be of time');
  assert.deepEqual(restMeta, first, 'GET /api/spaces/:id/meta reports a different reindex from reindex-status');
  assert.deepEqual(toolRest, first, 'POST /api/space_meta reports a different reindex from reindex-status');
  assert.deepEqual(mcp, first, 'MCP space_meta reports a different reindex from reindex-status');
  return first;
}

before(async () => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  for (const id of [BUSY, IDLE]) {
    const r = await post(INSTANCES.a, token, '/api/spaces', { id, label: id });
    assert.equal(r.status, 201, `space create failed: ${JSON.stringify(r.body)}`);
    created.push(id);
  }
  session = await openMcpSession(token);
});

after(async () => {
  session?.close();
  for (const id of created) await clearSeededReindexState(id).catch(() => {});
  await closeReindexSeed();
  for (const id of created.reverse()) {
    await delWithBody(INSTANCES.a, token, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
  }
});

describe('reindex progress — one answer on every door', () => {
  it('an idle space: every door says not running, nothing remaining, nothing failed', async () => {
    const got = await sandwich(IDLE);
    assert.deepEqual(got, { running: false, remaining: 0, failed: 0 });
  });

  it('a space with an active run: every door says running, and counts the same failed rebuild', async () => {
    await seedActiveReindexRun(BUSY);
    await seedFailedRebuildJob(BUSY, `seeded-${RUN}`);
    try {
      const got = await sandwich(BUSY);
      assert.deepEqual(got, { running: true, remaining: 0, failed: 1 });
      // And the other space is not dragged into it: progress is per space.
      assert.deepEqual(await statusDoor(IDLE), { running: false, remaining: 0, failed: 0 });
    } finally {
      await clearSeededReindexState(BUSY);
    }
  });
});
