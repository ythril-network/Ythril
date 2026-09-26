/**
 * An upstream's announcement is a proposal: the JOINING token decides which spaces a network may create or map here.
 *
 * Owner, 2026-09-26: *"only if you hold create space rights or hold enough (n) spaces you are allowed to network join
 * you should be able to join a network with n spaces"*, and *"on joining a network the space definition must come
 * from the token that joins the network, not from the peers"* (S-9).
 *
 * The join enforced that (`networkJoinRefusal`); everything after it did not. `adoptAnnouncedSpaces` created every
 * announced space, joined a same-id local space to the network, and widened the peer tokens — on the upstream's word
 * alone. Seen live: three spaces added on dev appeared on home, whose only token for that network reached one space.
 *
 * The decision is now `adoptionDecision`, a pure function over the network, the tokens and the local spaces, so it
 * is tested here without a stack: the network records who joined it (`joinedBy`), each announced space is judged by
 * the rule the join already uses, and what that token could not have joined waits in `pendingSpaces` for the
 * operator. A same-id local space is never adopted without an explicit mapping.
 *
 * Run: node --test testing/standalone/an-announcement-is-a-proposal-not-a-grant.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

let adoptionDecision, spacesToAdopt;
before(async () => { ({ adoptionDecision, spacesToAdopt } = await import('../../server/dist/networks/network-spaces.js')); });

const AREAS = ['knowledge', 'files', 'schema', 'dataQuality', 'networks'];
const floor = (rung) => Object.fromEntries(AREAS.map(a => [a, rung]));
const token = (id, rights) => ({ id, name: id, rights });
const joiner = (over = {}) => ({ instanceAdmin: false, createSpaces: false, floor: null, perSpace: { mine: floor('write') }, ...over });
const net = (over = {}) => ({ id: 'n1', type: 'pubsub', spaces: ['mine'], members: [], joinedBy: 'tok-joiner', ...over });
const entry = (id) => ({ networkId: id, localId: id });

describe('who joined decides what an announcement may add', () => {
  it('a joiner without createSpaces gets nothing created: the new space waits as pending', () => {
    const d = adoptionDecision(net(), [token('tok-joiner', joiner())], ['mine'], [entry('new-one')]);
    assert.deepEqual(d.adopt, []);
    assert.deepEqual(d.pending.map(p => p.networkId), ['new-one']);
    assert.match(d.pending[0].why, /create/i, 'the reason names what the joining token lacks');
  });

  it('a joiner that may create spaces with a write floor on networks adopts it', () => {
    const d = adoptionDecision(net(), [token('tok-joiner', joiner({ createSpaces: true, floor: floor('write') }))], ['mine'], [entry('new-one')]);
    assert.deepEqual(d.adopt.map(e => e.localId), ['new-one']);
    assert.deepEqual(d.pending, []);
  });

  it('an instance admin joiner adopts, as it could have joined it', () => {
    const d = adoptionDecision(net(), [token('tok-joiner', { ...joiner(), instanceAdmin: true })], ['mine'], [entry('new-one')]);
    assert.deepEqual(d.adopt.map(e => e.localId), ['new-one']);
  });

  it('a same-id LOCAL space is never joined to the network by an announcement, whoever joined', () => {
    // Joining a private space that happens to share the id would start syncing it; only an explicit mapping may.
    const admin = token('tok-joiner', { ...joiner(), instanceAdmin: true });
    const d = adoptionDecision(net(), [admin], ['mine', 'private-notes'], [entry('private-notes')]);
    assert.deepEqual(d.adopt, []);
    assert.deepEqual(d.pending.map(p => p.networkId), ['private-notes']);
    assert.match(d.pending[0].why, /already exists/i);
  });

  it('a network with no recorded joiner, or a revoked one, adopts nothing', () => {
    for (const [n, tokens] of [[net({ joinedBy: undefined }), [token('tok-joiner', joiner({ instanceAdmin: true }))]], [net(), []]]) {
      const d = adoptionDecision(n, tokens, ['mine'], [entry('new-one')]);
      assert.deepEqual(d.adopt, [], 'no joining token means no authority to add anything');
      assert.equal(d.pending.length, 1);
    }
  });

  it('an EXPIRED joining token adopts nothing: it can no longer authenticate, so it cannot authorise', () => {
    const t = { ...token('tok-joiner', { ...joiner(), instanceAdmin: true }), expiresAt: '2026-01-01T00:00:00Z' };
    const d = adoptionDecision(net(), [t], ['mine'], [entry('new-one')], Date.parse('2026-09-26T00:00:00Z'));
    assert.deepEqual(d.adopt, []);
    assert.match(d.pending[0].why, /expired/i);
    const live = adoptionDecision(net(), [t], ['mine'], [entry('new-one')], Date.parse('2025-12-31T00:00:00Z'));
    assert.deepEqual(live.adopt.map(e => e.localId), ['new-one'], 'before its expiry the same token still adopts');
  });

  it('a space the operator dismissed is never proposed again by an announcement', () => {
    const n = net({ members: [{ instanceId: 'pub', direction: 'pull' }], dismissedSpaces: ['gone'] });
    const proposed = spacesToAdopt(n, 'pub', ['gone', 'fresh']);
    assert.deepEqual(proposed.map(p => p.networkId), ['fresh'], 'dismissing is an answer, not a snooze');
  });

  it('each announced space is judged on its own', () => {
    const t = token('tok-joiner', joiner({ createSpaces: true, floor: floor('write') }));
    const d = adoptionDecision(net(), [t], ['mine', 'taken'], [entry('fresh'), entry('taken')]);
    assert.deepEqual(d.adopt.map(e => e.localId), ['fresh']);
    assert.deepEqual(d.pending.map(p => p.networkId), ['taken']);
  });
});

describe('the adoption path goes through the decision', () => {
  const src = stripComments(readFileSync('server/src/networks/network-spaces.ts', 'utf8'));
  it('adoptAnnouncedSpaces asks adoptionDecision before adding anything', () => {
    const at = src.indexOf('export async function adoptAnnouncedSpaces(');
    assert.ok(at > -1, 'adoptAnnouncedSpaces is gone — re-anchor this gate');
    const body = src.slice(at, src.indexOf('\nexport ', at + 10));
    assert.match(body, /adoptionDecision\(/, 'the announcement path must be judged by the joining token');
    assert.doesNotMatch(body, /addSpacesToNetwork\(networkId, adopt,/, 'the raw announced list must never reach addSpacesToNetwork');
  });
  it('a passed round that would CREATE a space here is judged by the joining token too', () => {
    const at = src.indexOf('export function applySpaceAdditionRound(');
    assert.ok(at > -1, 'applySpaceAdditionRound is gone — re-anchor this gate');
    const body = src.slice(at, src.indexOf('\nexport ', at + 10));
    assert.match(body, /adoptionDecision\(/, 'the round path must not create a space on the word of the network alone');
    assert.match(body, /holdAsPending\(/, 'what the joiner could not have joined waits for the operator');
  });
  it('adding a space clears its pending entry, and dismissing records the answer', () => {
    const at = src.indexOf('export async function addSpacesToNetwork(');
    const body = src.slice(at, src.indexOf('\nexport ', at + 10));
    assert.match(body, /pendingSpaces = net\.pendingSpaces\.filter/, 'an adopted space must not stay offered as pending');
    const acts = stripComments(readFileSync('server/src/networks/network-acts.ts', 'utf8'));
    assert.match(acts, /dismissedSpaces = \[\.\.\.\(net\.dismissedSpaces \?\? \[\]\), spaceId\]/, 'a dismissal must be remembered');
  });
  it('accepting a pending space runs the join rule over the ACCEPTING token', () => {
    const acts = stripComments(readFileSync('server/src/networks/network-acts.ts', 'utf8'));
    const at = acts.indexOf('export async function resolvePendingSpaceAct(');
    assert.ok(at > -1, 'resolvePendingSpaceAct is gone — re-anchor this gate');
    const body = acts.slice(at, acts.indexOf('\nexport ', at + 10));
    assert.match(body, /networkJoinRefusal\(caller,/, 'an accept must be priced like the join it completes');
  });

  it('the join and the create record who established the membership', () => {
    assert.match(stripComments(readFileSync('server/src/networks/network-acts.ts', 'utf8')), /joinedBy: caller\.id/, 'createNetworkAct must store the creating token id');
    const join = stripComments(readFileSync('server/src/networks/join-remote-act.ts', 'utf8'));
    assert.match(join, /joinedBy/, 'joinRemoteAct must store the joining token id on the network');
  });
});
