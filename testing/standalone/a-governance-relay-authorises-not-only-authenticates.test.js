/**
 * The governance relays authorise the caller, not merely authenticate them.
 *
 * ## What was reachable, and why it read as safe
 *
 * `POST /api/sync/networks/:id/members` and `POST /api/sync/networks/:id/votes/:roundId` carried
 * `requireAuth` and `denyReadOnly` and nothing else — no space check, no peer-membership check. Both are
 * relays: a peer calls them to report its own member record, or to pass along a vote cast.
 *
 * **The code stated the rule it did not enforce, which is the whole reason this survived reading.** The
 * members route said, in as many words: *"tokens without peerInstanceId (admin/local) may update any
 * record."* The guard in front of it tests AUTHENTICATED, and "admin/local" was a description of who was
 * expected to hold such a token rather than a check that they did. So any write-capable token could rewrite
 * any member's `url`, `label` or `children`.
 *
 * The votes route was worse, because its identity defaulted. `acceptVoteCast(net, round, cast, callerPeerId
 * ?? body.instanceId)` — with no peer id the reporter becomes the cast's OWN `instanceId`, so the two always
 * match, the own-cast path is taken, and the signature requirement is satisfied by construction. A network
 * configured with `requireSignedVotes` accepted an unsigned cast from anyone with a write token, attributed
 * to any instance, on any round — and the rounds include `remove`, `space_deletion` and `space_wipe`, which
 * pass on a single yes with no veto for `club` and `pubsub`.
 *
 * ## Why the fix is a predicate and not two guards
 *
 * This is the defect `CLAUDE.md` names as the repo's commonest, with a security blast radius: one rule —
 * *only the peer itself, or an instance administrator* — expressed twice, and the weaker copy is the one in
 * front of the route. Two inline checks would be the same bug waiting to drift, so the question is answered
 * once, by `peerRelayCaller`, and both routes take its verdict.
 *
 * The verdict is three-valued rather than a boolean because the routes need to know WHICH, not just whether:
 * a peer may speak only for itself, an admin may relay for anyone, and those are different permissions.
 *
 * Run: node --test testing/standalone/a-governance-relay-authorises-not-only-authenticates.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { trackedSources, REPO_ROOT } from './_sources.mjs';

const { peerRelayCaller } = await import('../../server/dist/auth/peer-relay.js');

const MEMBERS = 'server/src/api/sync/members.ts';
const VOTES = 'server/src/api/sync/votes.ts';
const code = (f) => stripComments(readFileSync(f, 'utf8'));

const ADMIN = { rights: { instanceAdmin: true } };
const PLAIN = { rights: { instanceAdmin: false, floor: { knowledge: 'write' } } };
const PEER = { peerInstanceId: 'inst-a', rights: { instanceAdmin: false } };

describe('the predicate answers which caller this is, not merely whether there is one', () => {
  it('a peer token speaks for its own instance and no other', () => {
    const v = peerRelayCaller(PEER);
    assert.equal(v.kind, 'peer');
    assert.equal(v.peerInstanceId, 'inst-a');
  });

  it('an instance administrator may relay for anyone', () => {
    assert.equal(peerRelayCaller(ADMIN).kind, 'admin');
  });

  it('A WRITE-CAPABLE TOKEN THAT IS NEITHER IS REFUSED — the whole finding', () => {
    /*
     * The case that was reachable. A plain PAT with a write floor is not a peer and not an admin, and it
     * could previously rewrite any member record and cast any vote as any instance.
     */
    assert.equal(peerRelayCaller(PLAIN).kind, 'refused');
  });

  it('and so is no token at all, rather than defaulting to something wide', () => {
    // `no information is not permission` — the same rule that took `migrateToken({})` off two call sites.
    assert.equal(peerRelayCaller(undefined).kind, 'refused');
    assert.equal(peerRelayCaller({}).kind, 'refused');
  });

  it('the legacy admin flag still answers, because an OIDC session carries no matrix', () => {
    // Narrowing this would lock out every OIDC administrator, which is the opposite failure and as bad.
    assert.equal(peerRelayCaller({ admin: true }).kind, 'admin');
  });

  it('a peer id wins over admin, so an admin peer still speaks only for itself', () => {
    /*
     * Deliberate: a token carrying a peer identity is acting AS that peer. Reading it as an admin would let
     * a peer's own credential report another peer's record, which is the gossip-poisoning case the members
     * route already refuses — and it would refuse it only for non-admin peers, which is worse than either.
     */
    const v = peerRelayCaller({ peerInstanceId: 'inst-b', rights: { instanceAdmin: true } });
    assert.equal(v.kind, 'peer');
    assert.equal(v.peerInstanceId, 'inst-b');
  });
});

describe('the peer a token is bound to has one reader', () => {
  /*
   * The relay used to carry a one-line copy of the sync router's reader, because importing it from `auth/` closed an import cycle, and a
   * gate compared the two spellings. The reader now lives in `auth/peer-bound.ts` and imports nothing, so there is no copy to compare:
   * the rule is that no other source reads the field off a request's token by hand.
   */
  const READER = 'server/src/auth/peer-bound.ts';

  it('an empty string is no peer, not a peer named ""', () => {
    // The half a re-implementation drops. `typeof v === 'string'` alone admits '', and an empty peer id
    // would make `peer !== incoming.instanceId` true for every record — refusing a real peer.
    const v = peerRelayCaller({ peerInstanceId: '', rights: { instanceAdmin: false } });
    assert.equal(v.kind, 'refused', 'an empty peer id must not read as a peer identity');
  });

  it('no source but the reader takes `peerInstanceId` off a request\'s token itself', () => {
    const sources = trackedSources('server/src', { floor: 300 }).filter(f => f !== READER);
    // The shapes a hand read takes: a bracket read, a property read off the authenticated token, a read off a record cast to carry the field.
    const byHand = [/\['peerInstanceId'\]/, /authToken\b[^;\n]*?\??\.peerInstanceId\b/, /\bas \{ (?:readonly )?peerInstanceId\?: [a-z]+ \}[^;\n]*?\??\.peerInstanceId\b/];
    const offenders = sources.filter(f => { const text = stripComments(readFileSync(`${REPO_ROOT}/${f}`, 'utf8')); return byHand.some(re => re.test(text)); });
    assert.deepEqual(offenders, [], `these read the peer a token is bound to by hand instead of through peerBoundTo: ${offenders.join(', ')}`);
  });

  it('the doors that ask which peer a token is bound to call the one reader', () => {
    for (const f of ['server/src/auth/peer-relay.ts', 'server/src/auth/middleware.ts', 'server/src/api/sync/_shared.ts', 'server/src/mcp/call-tool.ts']) {
      assert.match(code(f), /\bpeerBoundTo\(/, `${f} no longer asks the one reader which peer a token is bound to`);
    }
  });
});

describe('both relays take the verdict', () => {
  for (const [name, f] of [['members', MEMBERS], ['votes', VOTES]]) {
    it(`the ${name} relay refuses a caller that is neither peer nor admin`, () => {
      const src = code(f);
      assert.match(src, /peerRelayCaller/, `${name} does not ask who the caller is`);
      assert.match(src, /'refused'/, `${name} never acts on a refusal`);
      assert.match(src, /403/, `${name} has no refusal status`);
    });

    it(`and the ${name} relay no longer reads peerInstanceId off the token itself`, () => {
      /*
       * The tell of the old shape. Both routes dug `peerInstanceId` out of `req.authToken` with a cast and
       * then treated absence as permission. A route still doing that has its own copy of the question.
       */
      const src = code(f);
      assert.doesNotMatch(src, /authToken as Record<string, unknown>\)\?\.\['peerInstanceId'\]/,
        `${name} still reads the peer id itself, which is the second implementation of the rule`);
    });
  }

  it('and the votes relay never falls back to the cast\'s own id for a non-peer caller', () => {
    /*
     * `callerPeerId ?? body.instanceId` is what made the signature check vacuous: the reporter and the cast
     * were the same value, so `acceptVoteCast` took the own-cast path every time.
     */
    assert.doesNotMatch(code(VOTES), /callerPeerId \?\? body\.instanceId/,
      'the reporter still defaults to the cast\'s own instanceId, so a cast authenticates itself');
  });
});
