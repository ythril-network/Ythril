/**
 * A joiner accepts an inviter's claimed instance id only when it is a stranger, or answers from the origin this
 * instance records for it (`S-6`, the joiner's half).
 *
 * The inviter states its own id in the apply answer, and the joiner scopes the token it mints for the inviter — and
 * the outbound token it keeps — by that id. A server borrowing the id of a peer the joiner already syncs with would
 * otherwise get a token reaching that peer's networks and overwrite the joiner's token for the real one. The live
 * handshake cannot stage a lying inviter, so the decision is tested here, pure.
 *
 * Run: node --test testing/standalone/an-inviter-is-the-peer-it-claims.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let inviterIsWhoItClaims, knownPeerAt, isKnownPeer;
before(async () => {
  ({ inviterIsWhoItClaims, knownPeerAt, isKnownPeer } = await import('../../server/dist/auth/peer-identity.js'));
});

const cfg = { networks: [
  { members: [{ instanceId: 'peer-c', url: 'https://c.example.com' }] },
  { members: [{ instanceId: 'peer-d', url: 'https://d.example.com:8443' }] },
] };

describe('an inviter\'s claimed id', () => {
  it('a stranger is taken at its word — it has nothing here to impersonate', () => {
    assert.equal(isKnownPeer(cfg, 'new-peer'), false);
    assert.equal(inviterIsWhoItClaims(cfg, 'new-peer', 'https://anywhere.example.org/api/invite/apply'), true);
  });

  it('a known peer must answer from its recorded origin', () => {
    assert.equal(inviterIsWhoItClaims(cfg, 'peer-c', 'https://c.example.com/api/invite/apply'), true);
    assert.equal(inviterIsWhoItClaims(cfg, 'peer-c', 'https://evil.example.org/api/invite/apply'), false);
    assert.equal(inviterIsWhoItClaims(cfg, 'peer-d', 'https://d.example.com/api/invite/apply'), false, 'the port is part of the origin');
    assert.equal(inviterIsWhoItClaims(cfg, 'peer-c', 'not a url'), false);
  });
});

describe('the proof a joiner presents', () => {
  it('is for the known peer at the invite\'s origin, and none for a stranger\'s', () => {
    assert.equal(knownPeerAt(cfg, 'https://c.example.com/api/invite/apply'), 'peer-c');
    assert.equal(knownPeerAt(cfg, 'https://d.example.com:8443/api/invite/apply'), 'peer-d');
    assert.equal(knownPeerAt(cfg, 'https://evil.example.org/api/invite/apply'), null);
  });
});
