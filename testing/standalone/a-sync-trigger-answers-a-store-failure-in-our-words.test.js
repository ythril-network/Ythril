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
 * The TEXT: the answer says one of our sentences (`caughtFailureText`), the driver's message goes to the log, which already
 * carries it once (`Synchronous trigger … failed`). The STATUS stays `500`: main answers `503` and `Retry-After` for a store
 * failure, a change of status that a patch (D-10, fixes only) does not take. Pinned, so the fix cannot drift into it.
 *
 * Run: node --test testing/standalone/a-sync-trigger-answers-a-store-failure-in-our-words.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { MongoNetworkError } = createRequire(path.resolve('server/package.json'))('mongodb');
const LEAK = /10\.1\.2\.3|27017/;

let tmp, getConfig, trigger;

/** A network whose member list cannot be read: the cycle's read of it throws the driver's error. */
function failingNetwork(id) {
  const net = { id, label: id, type: 'pubsub', spaces: [], pendingRounds: [], votingDeadlineHours: 24, createdAt: '2026-01-01T00:00:00.000Z' };
  Object.defineProperty(net, 'members', { enumerable: true, get() { throw new MongoNetworkError('connection 3 to 10.1.2.3:27017 closed'); } });
  return net;
}

const fakeRes = () => ({ code: 200, body: undefined, headers: {}, headersSent: false,
  status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
  json(b) { this.body = b; this.headersSent = true; return this; } });

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
    getConfig().networks.push(failingNetwork('net-down'));
    const res = fakeRes();
    try { await trigger.triggerNetworkSync(res, 'net-down', { wait: true, timeoutMs: 5_000 }); } finally { getConfig().networks.pop(); }
    assert.doesNotMatch(JSON.stringify(res.body), LEAK, `the trigger answered with the driver's text: ${JSON.stringify(res.body)}`);
  });

  it('PIN: the network trigger still answers 500 (the 503 of main is a status change the patch does not take)', async () => {
    getConfig().networks.push(failingNetwork('net-down-pin'));
    const res = fakeRes();
    try { await trigger.triggerNetworkSync(res, 'net-down-pin', { wait: true, timeoutMs: 5_000 }); } finally { getConfig().networks.pop(); }
    assert.equal(res.code, 500, `a store failure under the cycle answered ${res.code}`);
    assert.equal(res.body?.ok, false);
    assert.equal(res.body?.status, 'error');
    assert.equal(res.headers['retry-after'], undefined);
  });

  it('the peer trigger: no driver text', async () => {
    getConfig().networks.push(failingNetwork('net-down-peer'));
    const res = fakeRes();
    try { await trigger.triggerPeerSync(res, 'any-peer', { wait: true }); } finally { getConfig().networks.pop(); }
    assert.doesNotMatch(JSON.stringify(res.body), LEAK, `the trigger answered with the driver's text: ${JSON.stringify(res.body)}`);
  });

  it('PIN: the peer trigger still answers 500', async () => {
    getConfig().networks.push(failingNetwork('net-down-peer-pin'));
    const res = fakeRes();
    try { await trigger.triggerPeerSync(res, 'any-peer', { wait: true }); } finally { getConfig().networks.pop(); }
    assert.equal(res.code, 500, `a store failure under the cycle answered ${res.code}`);
    assert.equal(res.body?.status, 'error');
  });
});
