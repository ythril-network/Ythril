/**
 * The "tell the members to pull now" send reads each member's peer token when it SENDS, and skips a member whose token is gone by then (bundle-106
 * R5, token-at-send row; design v5 section 1.6, VR19).
 *
 * ## What was true before
 *
 * The three copies of the notify read `getSecrets().peerTokens[member]` at SNAPSHOT time, on the caller's stack, and sent what they had read. With
 * the send deferred past the caller's synchronous save (so a round that passes at open acts first), a token rotated or revoked between the two was
 * still used: the member was woken with a credential this instance had already replaced, or revoked an instant ago.
 *
 * ## What holds now
 *
 * `notifyMembersToPull(snapshot)` takes the recipients from the snapshot (who to tell is decided before the round acted) and reads the TOKEN inside
 * the deferred callback:
 *
 * - **rotated meanwhile:** the request carries the token as it stands at send time;
 * - **gone meanwhile (the member was removed and its credential revoked):** that member is skipped - no request - while the others are told.
 *
 * ## How it is driven
 *
 * The module's own function, called with a snapshot of the shape section 1.2 step 0 names, and the secrets changed in the SAME synchronous turn
 * right after the call returns: anything the function read before returning is the snapshot-time read. Two recording peers capture the
 * `Authorization` header (the shared fake peer records none), a third is the control that is told with its unchanged token.
 *
 * The absence ("the skipped member saw no request") is read after the control and the rotated member have been told, then after a bounded run of
 * event-loop turns - and sits beside its twin: the same send DID reach the member whose token stood.
 *
 * ## Seen red
 *
 * On the base the module does not exist (the three copies are inline and read the token on the caller's stack), so the first row fails for that.
 * After the fix, by hand: read the token before the `setImmediate` -> the rotated and the skipped rows red; hold the recipients to the live
 * member list instead of the snapshot -> not asserted here (the deletion-at-open row of `a-round-that-may-pass-at-open-tells-its-members-db` holds it).
 *
 * Run: node --test testing/standalone/a-round-notify-reads-its-tokens-at-send-db.test.js
 * (requires a prior server build, the test MongoDB and a private LAN address)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason, privateHostAddress } from './_private-address.mjs';
import { removeInstanceDir, allowEngineToDialPrivatePeers } from './_vote-round-instance.mjs';
import { tempInstance, networkOf, boot, until, requireExport, databaseTakesCollections } from './_round-open-fixtures.mjs';

const dir = tempInstance('ythril-notify-token-');
const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const KEPT = 'aaaaaaaa-0000-4000-8000-0000000000d1';
const ROTATED = 'aaaaaaaa-0000-4000-8000-0000000000d2';
const GONE = 'aaaaaaaa-0000-4000-8000-0000000000d3';

/** A recording peer that keeps the `Authorization` header of every notify it receives. */
async function authRecordingPeer() {
  const seen = [];
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => { seen.push({ url: req.url, authorization: req.headers['authorization'] }); res.writeHead(204).end(); });
  });
  // own-listener: the peer must bind a private LAN address, because the engine's peer client refuses loopback
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, privateHostAddress(), resolve); });
  return { seen, url: `http://${privateHostAddress()}:${server.address().port}`, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

describe('the notify send reads its tokens when it sends', { skip }, () => {
  let mongo; const peers = {};
  before(async () => {
    allowEngineToDialPrivatePeers();
    for (const id of [KEPT, ROTATED, GONE]) peers[id] = await authRecordingPeer();
    mongo = await openTestMongo('notify_token_at_send');
    await databaseTakesCollections(mongo);
  });
  after(async () => { for (const p of Object.values(peers)) await p.close(); await closeTestMongo(); removeInstanceDir(dir); });

  it('a token rotated in the turn after the call is the one sent; a member whose token is gone in that turn is skipped; the others are told (twin)', async () => {
    const notifyMembersToPull = await requireExport('../../server/dist/networks/notify-members.js', 'notifyMembersToPull', 'design v5 section 1.6: the one "tell the members to pull now", reading tokens at send time - the three copies of it read the token on the caller\'s stack, at snapshot time');
    const net = networkOf('club', [KEPT, ROTATED, GONE], { spaces: ['general', 'notes'] });
    net.members.forEach(m => { m.url = peers[m.instanceId].url; });
    const loader = await boot(dir, { spaces: ['notes'], networks: [net], peerTokens: { [KEPT]: 'kept-1', [ROTATED]: 'rotated-OLD', [GONE]: 'gone-1' } });
    const snapshot = {
      networkId: 'net-1', label: net.label, roundId: 'r-token', type: 'space_deletion', spaceId: 'notes', spaceLabel: 'notes',
      members: net.members.map(m => ({ instanceId: m.instanceId, url: m.url, label: m.label })),
    };
    const returned = notifyMembersToPull(snapshot);
    // The very next synchronous statements: whatever the function read before returning was read at snapshot time.
    const secrets = loader.getSecrets();
    loader.saveSecrets({ ...secrets, peerTokens: { [KEPT]: 'kept-1', [ROTATED]: 'rotated-NEW' } });
    await returned;
    await until(() => peers[KEPT].seen.length > 0 && peers[ROTATED].seen.length > 0, 'the members whose tokens stand were told');
    assert.equal(peers[KEPT].seen[0].authorization, 'Bearer kept-1', 'the control member was not told with its own, unchanged token');
    assert.equal(peers[ROTATED].seen[0].authorization, 'Bearer rotated-NEW', `the send used ${peers[ROTATED].seen[0].authorization}: the token as it stood when the call returned, not when it sent`);
    for (let i = 0; i < 400; i++) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(peers[GONE].seen, [], 'a member whose credential was gone at send time was sent a request with the credential it had at snapshot time');
  });
});
