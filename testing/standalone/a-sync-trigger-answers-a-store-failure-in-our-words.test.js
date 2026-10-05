/**
 * A waited sync trigger whose cycle throws answers WITHOUT the driver's text, at the status it already had
 * (`Q-361`: main's bundle-30 I13 security residue in `sync/trigger.ts`, carried without its status change).
 *
 * ## The defect
 *
 * `POST /api/networks/:id/sync?wait=true` and `POST /api/networks/peers/:peerId/sync?wait=true` answered a throw from
 * the cycle with `500 { error: err.message }`. For a failure on the store that message names internal hosts and ports.
 * A cycle catches each member's failure and reports it in `errors`, so what reaches the trigger's catch is a throw outside
 * the member loop — driven here with a real driver error from the cycle's first read of the network.
 *
 * ## What changes and what does not
 *
 * The TEXT: the answer says one of our sentences (`caughtFailureText`), the driver's message goes to the log
 * once, through `caughtFailureText`'s line naming the network or peer — asserted present, and once. The STATUS stays `500`: main answers `503` and `Retry-After` for a store
 * failure, a change of status that a patch (D-10, fixes only) does not take. Pinned, so the fix cannot drift into it.
 *
 * Run: node --test testing/standalone/a-sync-trigger-answers-a-store-failure-in-our-words.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOST_TEXT, LEAK, driver } from './_store-failure-fixtures.mjs';
import { fakeResponse } from './_fake-response.mjs';
import { logLinesDuring } from './_log-lines.mjs';

let tmp, getConfig, trigger;

/** A network whose member list cannot be read: the cycle's read of it throws the driver's error. */
function failingNetwork(id) {
  const net = { id, label: id, type: 'pubsub', spaces: [], pendingRounds: [], votingDeadlineHours: 24, createdAt: '2026-01-01T00:00:00.000Z' };
  Object.defineProperty(net, 'members', { enumerable: true, get() { throw new driver.MongoNetworkError(HOST_TEXT); } });
  return net;
}

/** Run `call(res)` against a network that cannot be read; what was answered, and the log lines it wrote. */
async function triggered(id, call) {
  getConfig().networks.push(failingNetwork(id));
  const res = fakeResponse();
  try {
    const { lines } = await logLinesDuring(() => call(res));
    return { out: { status: res.statusCode, headers: res.headers, body: res.body }, lines };
  } finally { getConfig().networks.pop(); }
}

describe('a sync trigger answers a store failure in our words', () => {
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-trigger-'));
    process.env['CONFIG_PATH'] = path.join(tmp, 'config.json');
    process.env['DATA_ROOT'] = path.join(tmp, 'data');
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({ instanceId: 'trigger-test', instanceLabel: 'T', tokens: [], networks: [], spaces: [] }), { mode: 0o600 });
    ({ getConfig } = await import('../../server/dist/config/loader.js'));
    (await import('../../server/dist/config/loader.js')).loadConfig();
    trigger = await import('../../server/dist/sync/trigger.js');
  });
  after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('the network trigger: no driver text', async () => {
    const { out } = await triggered('net-down', res => trigger.triggerNetworkSync(res, 'net-down', { wait: true, timeoutMs: 5_000 }));
    assert.doesNotMatch(JSON.stringify(out.body), LEAK, `the trigger answered with the driver's text: ${JSON.stringify(out.body)}`);
  });

  it('PIN: the network trigger still answers 500 (the 503 of main is a status change the patch does not take)', async () => {
    const { out } = await triggered('net-down-pin', res => trigger.triggerNetworkSync(res, 'net-down-pin', { wait: true, timeoutMs: 5_000 }));
    assert.equal(out.status, 500, `a store failure under the cycle answered ${out.status}`);
    assert.equal(out.body?.ok, false);
    assert.equal(out.body?.status, 'error');
    assert.equal(out.headers['retry-after'], undefined);
  });

  it('the network trigger: the driver\'s text is in the log, naming the network', async () => {
    const { lines } = await triggered('net-down-log', res => trigger.triggerNetworkSync(res, 'net-down-log', { wait: true, timeoutMs: 5_000 }));
    const logged = lines.filter(l => LEAK.test(l));
    assert.ok(logged.length >= 1, `the answer withholds the cause and the log does not carry it: ${JSON.stringify(lines)}`);
    assert.ok(logged.every(l => l.includes('net-down-log')), `a line does not name the network: ${logged}`);
  });

  // The triggers used to log a driver-side throw themselves and then answer through `caughtFailureText`, which logs
  // it again: two lines for one failure (found writing this case, Q-361 round R). They now leave a driver-side
  // failure to `caughtFailureText` and log only an own error themselves.
  it('the network trigger: the driver\'s text is in the log ONCE', async () => {
    const { lines } = await triggered('net-down-once', res => trigger.triggerNetworkSync(res, 'net-down-once', { wait: true, timeoutMs: 5_000 }));
    const logged = lines.filter(l => LEAK.test(l));
    assert.equal(logged.length, 1, `the operator reads the cause once: ${JSON.stringify(lines.map(l => l.slice(0, 160)))}`);
  });

  it('the peer trigger: no driver text', async () => {
    const { out } = await triggered('net-down-peer', res => trigger.triggerPeerSync(res, 'any-peer', { wait: true }));
    assert.doesNotMatch(JSON.stringify(out.body), LEAK, `the trigger answered with the driver's text: ${JSON.stringify(out.body)}`);
  });

  it('PIN: the peer trigger still answers 500', async () => {
    const { out } = await triggered('net-down-peer-pin', res => trigger.triggerPeerSync(res, 'any-peer', { wait: true }));
    assert.equal(out.status, 500, `a store failure under the cycle answered ${out.status}`);
    assert.equal(out.body?.status, 'error');
  });

  it('the peer trigger: the driver\'s text is in the log, naming the peer', async () => {
    const { lines } = await triggered('net-down-peer-log', res => trigger.triggerPeerSync(res, 'any-peer-log', { wait: true }));
    const logged = lines.filter(l => LEAK.test(l));
    assert.ok(logged.length >= 1, `the answer withholds the cause and the log does not carry it: ${JSON.stringify(lines)}`);
    assert.ok(logged.every(l => l.includes('any-peer-log')), `a line does not name the peer: ${logged}`);
  });

  it('the peer trigger: the driver\'s text is in the log ONCE', async () => {
    const { lines } = await triggered('net-down-peer-once', res => trigger.triggerPeerSync(res, 'any-peer-once', { wait: true }));
    const logged = lines.filter(l => LEAK.test(l));
    assert.equal(logged.length, 1, `the operator reads the cause once: ${JSON.stringify(lines.map(l => l.slice(0, 160)))}`);
  });
});
