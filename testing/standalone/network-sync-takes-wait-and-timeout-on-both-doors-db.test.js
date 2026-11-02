/**
 * `network_sync` takes `wait` and `timeoutMs`, like `POST /api/networks/:id/sync`, and both doors say what they used (Q-468).
 *
 * ## What was missing
 *
 * The REST route read `?wait=` and `?timeoutMs=`; the tool declared neither, always waited and had no bound at all, so a stuck peer
 * held an agent's call for as long as the cycle ran. `a-tool-and-its-route-take-the-same-parameters` found it from the route's side
 * (`network_sync:wait`, `network_sync:timeoutMs`): the half of parameter parity that a tool-only comparison cannot see.
 *
 * ## What this holds, per door
 *
 * - the tool declares both parameters, `timeoutMs` without a `maximum` (the dispatcher would REFUSE what REST clamps);
 * - MCP waits when `wait` is not stated, REST does not (the one sanctioned divergence of a default; its own gate is
 *   `mcp-network-sync-waits-by-default-and-says-so`);
 * - every answer carries the `wait` it used, and the `timeoutMs` where one applied (a wait on a network);
 * - `timeoutMs` is clamped to the same 1 000-120 000 by the same function on both doors, never refused.
 *
 * A network with no members runs a cycle that finishes at once, so what is measured here is the parameters and the answer, not the
 * race against a slow peer (`withinTimeBound` has its own cases).
 *
 * Run: node --test testing/standalone/network-sync-takes-wait-and-timeout-on-both-doors-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { fakeRes } from './_vote-round-instance.mjs';
import { syncToolCtx } from './_sync-doors.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-netsync-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config', 'config.json');
process.env['DATA_ROOT'] = tmpDir;

const NET = 'net-wait-test';
let tool, trigger, getConfig, mongo;


describe('network_sync takes wait and timeoutMs on both doors and says what it used', { skip }, () => {
  before(async () => {
    fs.mkdirSync(path.dirname(process.env['CONFIG_PATH']), { recursive: true });
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'netsync', instanceLabel: 'netsync', spaces: [], tokens: [], networks: [],
    }), { mode: 0o600 });
    mongo = await openTestMongo('netsyncwait');
    ({ getConfig } = await import('../../server/dist/config/loader.js'));
    (await import('../../server/dist/config/loader.js')).loadConfig();
    getConfig().networks.push({ id: NET, label: 'Wait test', type: 'club', spaces: [], members: [], pendingRounds: [],
      votingDeadlineHours: 24, createdAt: '2026-01-01T00:00:00.000Z' });
    ({ network_syncTool: tool } = await import('../../server/dist/mcp/tools/sync.js'));
    trigger = await import('../../server/dist/sync/trigger.js');
  });
  after(async () => {
    // A `wait: false` trigger leaves its cycle running: let it finish before the database goes.
    const { syncCyclesInFlight } = await import('../../server/dist/sync/engine.js');
    // A cycle records its history just AFTER it stops counting as in flight, so the wait is for none in flight AND the history
    // count unchanged between two probes.
    let before = -1;
    await waitFor(async () => {
      const n = await mongo.col('_sync_history').countDocuments();
      const settled = syncCyclesInFlight() === 0 && n === before;
      before = n;
      return settled;
    }, 10_000, 100);
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('the tool declares `wait` (boolean) and `timeoutMs` (integer, no maximum: REST clamps what a schema would refuse)', () => {
    const props = tool.inputSchema({}).properties;
    assert.equal(props.wait?.type, 'boolean', '`wait` is not declared');
    assert.equal(props.timeoutMs?.type, 'integer', '`timeoutMs` is not declared');
    assert.equal(props.timeoutMs.maximum, undefined, 'a `maximum` would make MCP refuse a value REST clamps');
    assert.equal(props.timeoutMs.minimum, undefined, 'a `minimum` would make MCP refuse a value REST clamps');
  });

  it('MCP waits when `wait` is not stated, and the answer says so, with the bound it applied', async () => {
    const r = await tool.handle(syncToolCtx({ networkId: NET }));
    assert.equal(r.isError, false);
    assert.equal(r.structuredContent.wait, true);
    assert.equal(r.structuredContent.timeoutMs, 30_000);
    assert.equal(r.structuredContent.synced, 0);
    assert.match(r.content[0].text, /0 ok, 0 error/);
  });

  it('MCP `wait: false` answers at once that a cycle was started, and names no bound (none applied)', async () => {
    const r = await tool.handle(syncToolCtx({ networkId: NET, wait: false }));
    assert.equal(r.structuredContent.wait, false);
    assert.equal(r.structuredContent.status, 'triggered');
    assert.equal(r.structuredContent.timeoutMs, undefined);
    assert.notEqual(r.isError, true);
  });

  it('`timeoutMs` is clamped to 1 000-120 000 and the answer says which number applied, as REST does', async () => {
    const low = await tool.handle(syncToolCtx({ networkId: NET, timeoutMs: 5 }));
    assert.equal(low.structuredContent.timeoutMs, 1_000);
    const high = await tool.handle(syncToolCtx({ networkId: NET, timeoutMs: 99_999_999 }));
    assert.equal(high.structuredContent.timeoutMs, 120_000);
    const res = fakeRes();
    await trigger.triggerNetworkSync(res, NET, { wait: true, timeoutMs: trigger.syncTimeoutMs(5) });
    assert.equal(res.body.timeoutMs, low.structuredContent.timeoutMs, 'the two doors clamp one value two ways');
  });

  it('a cycle for every network applies the wait and the bound per network and says so', async () => {
    const r = await tool.handle(syncToolCtx({}));
    assert.equal(r.structuredContent.wait, true);
    assert.equal(r.structuredContent.timeoutMs, 30_000);
    const nowait = await tool.handle(syncToolCtx({ wait: false }));
    assert.equal(nowait.structuredContent.wait, false);
    assert.notEqual(nowait.isError, true);
  });

  it('REST: `wait` unstated does not wait, and the body says `wait: false`; waited, it says `wait: true` and the bound', async () => {
    const quick = fakeRes();
    await trigger.triggerNetworkSync(quick, NET, { wait: trigger.resolveSyncWait(undefined, 'rest'), timeoutMs: trigger.syncTimeoutMs(undefined) });
    assert.equal(quick.body.status, 'triggered');
    assert.equal(quick.body.wait, false);
    const waited = fakeRes();
    await trigger.triggerNetworkSync(waited, NET, { wait: true, timeoutMs: 7_000 });
    assert.equal(waited.body.status, 'completed');
    assert.equal(waited.body.wait, true);
    assert.equal(waited.body.timeoutMs, 7_000);
  });

  it('a peer sync names the wait it used and ignores `timeoutMs`, on both doors', async () => {
    const res = fakeRes();
    await trigger.triggerPeerSync(res, 'nobody', { wait: true });
    assert.equal(res.body.wait, true);
    assert.equal(res.body.timeoutMs, undefined, 'a peer cycle is bounded by its own request timeouts, not by this parameter');
    const quick = fakeRes();
    await trigger.triggerPeerSync(quick, 'nobody', { wait: false });
    assert.equal(quick.body.wait, false);
  });
});
