/**
 * When a peer's handshake completes, its earlier handshake token whose expiry passed is revoked, and one still in flight is not
 * (bundle-47, Q-354; the behaviour the pure file's source gate cannot show, review finding F5).
 *
 * `adoptPeerToken` makes the completed handshake's token live and revokes the peer's other live tokens. It skipped every token that still
 * carried an expiry as "a handshake in flight", so a handshake that ended unfinished left its token listed for ever. Driven through the real
 * token store: three tokens of one peer (the adopted one, an expired handshake token, a future one) and an expired token of another peer.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-peer-handshake-token-past-its-expiry-is-revoked-at-adoption-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';

const skip = await mongoSkipReason();

let door; let tokens; let loader;
const ids = () => new Set(loader.getConfig().tokens.map(t => t.id));

describe('a handshake token past its expiry is revoked when the peer\'s handshake completes', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'expiredadopt', spaces: [{ id: 'expiredadopt', label: 'x', folders: [] }] });
    tokens = await import('../../server/dist/auth/tokens.js');
    loader = await import('../../server/dist/config/loader.js');
  });
  after(async () => { await door?.close(); });

  it('revokes the peer\'s expired handshake token, keeps its in-flight one and another peer\'s', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const adopted = (await tokens.createToken({ name: 'peer:p-now', peerInstanceId: 'p', expiresAt: future })).record.id;
    const expired = (await tokens.createToken({ name: 'peer:p-old', peerInstanceId: 'p', expiresAt: past })).record.id;
    const inFlight = (await tokens.createToken({ name: 'peer:p-next', peerInstanceId: 'p', expiresAt: future })).record.id;
    const otherPeer = (await tokens.createToken({ name: 'peer:q-old', peerInstanceId: 'q', expiresAt: past })).record.id;
    await tokens.adoptPeerToken(adopted);
    const left = ids();
    assert.ok(left.has(adopted), 'the adopted token was revoked');
    assert.equal(loader.getConfig().tokens.find(t => t.id === adopted).expiresAt, null, 'the adopted token was not made live');
    assert.ok(!left.has(expired), 'the peer\'s handshake token whose expiry passed is still listed after its next handshake completed');
    assert.ok(left.has(inFlight), 'a handshake still in flight lost its token');
    assert.ok(left.has(otherPeer), 'another peer\'s token was revoked by this peer\'s adoption');
  });
});
