/**
 * The boot sweep finds the peer tokens no membership needs — and never a live one.
 *
 * Until a handshake's token expired with its handshake, a joiner that applied and never finalized left the inviter
 * a token with no expiry and no member record. Those exist on instances in the field now; the sweep at start hands
 * each such peer to `revokePeerCredentialsIfOrphaned`, which re-checks before revoking. This is the selection.
 *
 * Run: node --test testing/standalone/an-orphaned-peer-token-is-found-for-the-boot-sweep.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let orphanedPeerInstanceIds;
before(async () => { ({ orphanedPeerInstanceIds } = await import('../../server/dist/auth/tokens.js')); });

const token = (peerInstanceId) => ({ id: `t-${peerInstanceId ?? 'user'}`, ...(peerInstanceId ? { peerInstanceId } : {}) });

describe('which peers the sweep revokes', () => {
  it('a peer token whose instance is in no network — the half-finished handshake', () => {
    assert.deepEqual(orphanedPeerInstanceIds({ tokens: [token('gone')], networks: [] }), ['gone']);
  });
  it('never a member of any network', () => {
    const networks = [{ members: [{ instanceId: 'live' }], pendingRounds: [] }];
    assert.deepEqual(orphanedPeerInstanceIds({ tokens: [token('live')], networks }), []);
  });
  // A join round as `joinRoundOf` reads it: a `join` round naming the peer, open until its deadline (Q-454).
  const joinRound = (instanceId, extra = {}) => ({ type: 'join', subjectInstanceId: instanceId, concluded: false, deadline: new Date(Date.now() + 3_600_000).toISOString(), pendingMember: { instanceId }, ...extra });
  it('never a joiner whose vote round is still open', () => {
    const networks = [{ members: [], pendingRounds: [joinRound('voting')] }];
    assert.deepEqual(orphanedPeerInstanceIds({ tokens: [token('voting')], networks }), []);
  });
  it('a concluded round keeps nobody alive', () => {
    const networks = [{ members: [], pendingRounds: [joinRound('rejected', { concluded: true })] }];
    assert.deepEqual(orphanedPeerInstanceIds({ tokens: [token('rejected')], networks }), ['rejected']);
  });
  it('a round past its deadline that nothing has concluded keeps nobody alive either', () => {
    const networks = [{ members: [], pendingRounds: [joinRound('late', { deadline: new Date(Date.now() - 3_600_000).toISOString() })] }];
    assert.deepEqual(orphanedPeerInstanceIds({ tokens: [token('late')], networks }), ['late']);
  });
  it('a user token is never a peer', () => {
    assert.deepEqual(orphanedPeerInstanceIds({ tokens: [token(undefined)], networks: [] }), []);
  });
});
