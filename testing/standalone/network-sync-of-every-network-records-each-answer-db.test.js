/**
 * `network_sync` with no network named records EVERY network's answer: a network whose cycle failed does not stop the ones after it (bundle-231).
 *
 * ## The rule (`mcp/tools/sync.ts`, the all-networks branch)
 *
 * The tool runs the same act per network and reads one verdict over all of them. A network whose cycle throws is counted in `failedNetworks`, named in the
 * answer's lines with the words "the cycle failed", and the loop goes on: the networks after it still run, and their answers are kept. The structured answer
 * says `status: 'error'`, `ok: false`, `failedNetworks`, and the call is an error; a network that completed says its counts.
 *
 * ## How it is driven
 *
 * Two networks in the loaded config: the first cannot run a cycle (its `members` is not a list, so the cycle throws when it reads the network, which is the
 * shape of a cycle that fails for a reason of its own), the second is a plain empty network whose cycle finishes at once. The failing one comes FIRST: an
 * answer that stopped at the first failure would carry no line for the second.
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/network-sync-of-every-network-records-each-answer-db.test.js` (a prior `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { syncToolCtx } from './_sync-doors.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-netsync-all-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config', 'config.json');
process.env['DATA_ROOT'] = tmpDir;

const BROKEN = 'net-cycle-throws';
const FINE = 'net-cycle-finishes';
let tool, mongo;

describe('network_sync of every network records each network\'s answer', { skip }, () => {
  before(async () => {
    fs.mkdirSync(path.dirname(process.env['CONFIG_PATH']), { recursive: true });
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'netsyncall', instanceLabel: 'netsyncall', spaces: [], tokens: [], networks: [],
    }), { mode: 0o600 });
    mongo = await openTestMongo('netsyncall');
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    const base = { type: 'club', spaces: [], pendingRounds: [], votingDeadlineHours: 24, createdAt: '2026-01-01T00:00:00.000Z' };
    loader.getConfig().networks.push(
      { ...base, id: BROKEN, label: 'Broken cycle', members: null },
      { ...base, id: FINE, label: 'Fine cycle', members: [] },
    );
    ({ network_syncTool: tool } = await import('../../server/dist/mcp/tools/sync.js'));
  });
  after(async () => {
    const { syncCyclesInFlight } = await import('../../server/dist/sync/engine.js');
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

  it('the failed network is counted and named, and the network after it still ran and is recorded', async () => {
    const r = await tool.handle(syncToolCtx({}));
    const sc = r.structuredContent;
    assert.equal(sc.failedNetworks, 1, `want one failed network: ${JSON.stringify(sc)}`);
    assert.equal(sc.networks.length, 2, `want a line per network, the one after the failure included: ${JSON.stringify(sc.networks)}`);
    assert.match(sc.networks[0], /^Broken cycle: the cycle failed/, 'the failed network is not named with its failure');
    assert.match(sc.networks[1], /^Fine cycle: 0 ok, 0 error\(s\)/, 'the network after the failure has no answer of its own');
  });

  it('the answer is an error that says which kind: status error, not ok, and the text says how many failed', async () => {
    const r = await tool.handle(syncToolCtx({}));
    assert.equal(r.isError, true, 'a failed network did not make the call an error');
    assert.equal(r.structuredContent.status, 'error');
    assert.equal(r.structuredContent.ok, false);
    assert.equal(r.structuredContent.wait, true);
    assert.match(r.content[0].text, /1 failed/, 'the text does not say how many networks failed');
    assert.equal(r.structuredContent.timedOut, undefined, 'a failed network is not a timed-out one');
  });

  it('control: with only the network that finishes, nothing failed and the call is not an error', async () => {
    const loader = await import('../../server/dist/config/loader.js');
    const cfg = loader.getConfig();
    const kept = cfg.networks;
    cfg.networks = kept.filter(n => n.id === FINE);
    try {
      const r = await tool.handle(syncToolCtx({}));
      assert.equal(r.structuredContent.failedNetworks, undefined, 'a finished network was counted as failed');
      assert.equal(r.structuredContent.status, 'completed');
      assert.notEqual(r.isError, true);
    } finally {
      cfg.networks = kept;
    }
  });
});
