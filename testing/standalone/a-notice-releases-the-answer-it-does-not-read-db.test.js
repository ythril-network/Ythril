/**
 * A notice to a member reads its answer's STATUS and nothing else, so it cancels the body it does not read (bundle-106 PR A, lens finding F6).
 *
 * ## What it prevents
 *
 * `sendNotice` returned `res.status` and left the response's body alone. A caller that does not read a body must cancel it, or the body holds
 * its connection until the signal fires (`sync/file-sync.ts` does so for the download it refuses, and `util/ssrf.ts` says every streaming caller
 * must). The cancel belongs in `sendNotice` itself and not in its callers, so a caller written next year gets it with the send: the only callers
 * it had were the round notifier and the change-note sender, and each would otherwise have carried its own copy.
 *
 * ## How it is driven
 *
 * The real `sendNotice` against a real peer on this host's private address, with the web stream's own `cancel` counted for the length of the
 * call: a body that was given back to the runtime unread shows as no cancel. A `204` has no body to cancel and is the control that the count is
 * about the body, not about every answer.
 *
 * Run: node --test testing/standalone/a-notice-releases-the-answer-it-does-not-read-db.test.js
 * (requires a prior server build, the test MongoDB and a private LAN address)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason, privateHostAddress } from './_private-address.mjs';
import { removeInstanceDir, allowEngineToDialPrivatePeers } from './_vote-round-instance.mjs';
import { tempInstance, networkOf, boot, databaseTakesCollections } from './_round-open-fixtures.mjs';

const dir = tempInstance('ythril-notice-cancel-');
const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const MEMBER = 'aaaaaaaa-0000-4000-8000-0000000000e1';

/** A peer that answers every notify with `status` and, unless it is a 204, a small body. */
async function answeringPeer(status) {
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => { if (status === 204) res.writeHead(204).end(); else res.writeHead(status, { 'content-type': 'text/plain' }).end('answered'); });
  });
  // own-listener: the peer must bind a private LAN address, because the engine's peer client refuses loopback
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, privateHostAddress(), resolve); });
  return { url: `http://${privateHostAddress()}:${server.address().port}`, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

/** Run `fn` while counting the web stream's `cancel` calls; the real one is put back, and the count is returned with `fn`'s result. */
async function countingCancels(fn) {
  const proto = globalThis.ReadableStream.prototype;
  const real = proto.cancel;
  let cancels = 0;
  proto.cancel = function counted(...args) { cancels++; return real.apply(this, args); };
  try { const result = await fn(); return { result, cancels }; } finally { proto.cancel = real; }
}

describe('a notice cancels the answer body it does not read', { skip }, () => {
  let mongo; let sendNotice; const peers = {};
  before(async () => {
    allowEngineToDialPrivatePeers();
    for (const status of [200, 500, 204]) peers[status] = await answeringPeer(status);
    mongo = await openTestMongo('notice_cancel');
    await databaseTakesCollections(mongo);
    const net = networkOf('club', [MEMBER], { spaces: ['general', 'notes'] });
    await boot(dir, { spaces: ['notes'], networks: [net], peerTokens: { [MEMBER]: 'member-token' } });
    ({ sendNotice } = await import('../../server/dist/networks/notify-members.js'));
  });
  after(async () => { for (const p of Object.values(peers)) await p.close(); await closeTestMongo(); removeInstanceDir(dir); });

  for (const status of [200, 500]) {
    it(`an answer of ${status} with a body is cancelled once, and the status is still returned`, async () => {
      const { result, cancels } = await countingCancels(() => sendNotice('net-1', { instanceId: MEMBER, url: peers[status].url }, 'sync_available', { spaceId: 'notes' }));
      assert.equal(result, status, 'the notice did not return the answer\'s status');
      assert.equal(cancels, 1, `the answer's body was left unread and uncancelled (${cancels} cancel(s)): it holds its connection until the signal fires`);
    });
  }

  it('control: an answer of 204 has no body, so there is nothing to cancel and the status is returned', async () => {
    const { result, cancels } = await countingCancels(() => sendNotice('net-1', { instanceId: MEMBER, url: peers[204].url }, 'sync_available', { spaceId: 'notes' }));
    assert.equal(result, 204);
    assert.equal(cancels, 0, 'a cancel was counted for an answer with no body: the count is not about the body');
  });
});
