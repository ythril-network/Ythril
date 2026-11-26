/**
 * A `space_rebase` round is counted exactly as a deletion is, on every network type (Q-748, slice A; owner, 2026-11-18: a base change
 * on a shared space is its own vote kind, counted like a deletion).
 *
 * For the same casts on the same network, `roundVerdict` answers the same for `space_rebase` as for `space_deletion`: unanimous on closed
 * and braintree, a majority on democratic, the proposer's yes on club; a single veto stops it; past its deadline it expires. On pub/sub
 * the publisher clause covers it too: on a network where this instance is the publisher, a rebase round it did not open never passes, so
 * a subscriber cannot rebase the publisher's space. And no existing round type changes how it is counted.
 *
 * Run: node --test testing/standalone/a-rebase-round-passes-as-a-deletion-does.test.js (after the server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SELF = 'aaaaaaaa-0000-4000-8000-000000005e1f';
const PEER = 'aaaaaaaa-0000-4000-8000-00000000beef';
const THIRD = 'aaaaaaaa-0000-4000-8000-00000000c0c0';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-rebase-verdict-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');

let roundVerdict;
before(async () => {
  const loader = await import('../../server/dist/config/loader.js');
  fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
    instanceId: SELF, instanceLabel: 'self', tokens: [], networks: [],
    spaces: [{ id: 'general', label: 'General', builtIn: true, folders: [] }],
  }), { mode: 0o600 });
  loader.loadConfig();
  ({ roundVerdict } = await import('../../server/dist/sync/governance.js'));
});
after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } });

const future = () => new Date(Date.now() + 3_600_000).toISOString();
const past = () => new Date(Date.now() - 3_600_000).toISOString();
const member = (instanceId, over = {}) => ({ instanceId, label: instanceId.slice(-4), url: `http://${instanceId.slice(-4)}`, ...over });
const net = (type, members, over = {}) => ({ id: 'n', type, spaces: ['general'], members, pendingRounds: [], ...over });
const cast = (instanceId, vote = 'yes') => ({ instanceId, vote, castAt: new Date().toISOString() });
const REBASE = { base: 'https://b.example.org/ld/general/', vocab: 'https://b.example.org/ld/general/vocab/', epoch: 1 };
const roundOf = (type, over = {}) => ({
  roundId: 'r', type, spaceId: 'general', networkSpaceId: 'general', subjectInstanceId: SELF, subjectLabel: 's', subjectUrl: '',
  openedAt: new Date().toISOString(), deadline: future(), votes: [], ...(type === 'space_rebase' ? { rebase: REBASE } : {}), ...over,
});

const two = [member(PEER), member(THIRD)];
const CASES = [
  ['closed, only the proposer', net('closed', two), [cast(SELF)]],
  ['closed, every member', net('closed', two), [cast(SELF), cast(PEER), cast(THIRD)]],
  ['braintree, every member', net('braintree', two), [cast(SELF), cast(PEER), cast(THIRD)]],
  ['braintree, one missing', net('braintree', two), [cast(SELF), cast(PEER)]],
  ['democratic, a majority', net('democratic', two), [cast(SELF), cast(PEER)]],
  ['democratic, a minority', net('democratic', two), [cast(SELF)]],
  ['club, the proposer', net('club', two, { origin: 'created' }), [cast(SELF)]],
  ['club, no yes', net('club', two, { origin: 'created' }), []],
  ['any, one veto among yeses', net('democratic', two), [cast(SELF), cast(PEER), cast(THIRD, 'veto')]],
  ['club, one veto', net('club', two, { origin: 'created' }), [cast(SELF), cast(PEER, 'veto')]],
];

describe('the same casts give the same verdict as a deletion', () => {
  for (const [what, network, votes] of CASES) {
    it(what, () => {
      const deletion = roundVerdict(network, roundOf('space_deletion', { votes }));
      const rebase = roundVerdict(network, roundOf('space_rebase', { votes }));
      assert.equal(rebase, deletion, `${what}: a rebase answered ${rebase}, a deletion ${deletion}`);
    });
  }
  it('a single veto stops it, and past its deadline it expires', () => {
    const network = net('club', two, { origin: 'created' });
    assert.equal(roundVerdict(network, roundOf('space_rebase', { votes: [cast(SELF), cast(PEER, 'veto')] })), 'vetoed');
    assert.equal(roundVerdict(network, roundOf('space_rebase', { votes: [cast(SELF)], deadline: past() })), 'expired');
  });
});

describe('pub/sub: the publisher clause covers a rebase', () => {
  // This instance publishes: no member is its upstream (`direction: 'pull'` marks the publisher on a subscriber).
  const publishing = net('pubsub', [member(PEER), member(THIRD)]);
  it('a subscriber\'s rebase round never passes on the publisher, as its deletion never does', () => {
    const votes = [cast(PEER), cast(SELF)];
    assert.equal(roundVerdict(publishing, roundOf('space_deletion', { subjectInstanceId: PEER, votes })), null);
    assert.equal(roundVerdict(publishing, roundOf('space_rebase', { subjectInstanceId: PEER, votes })), null);
  });
  it('the publisher\'s own rebase passes on its yes, as its own deletion does', () => {
    const votes = [cast(SELF)];
    assert.equal(roundVerdict(publishing, roundOf('space_rebase', { votes, proposedHere: true })), 'passed');
    assert.equal(roundVerdict(publishing, roundOf('space_deletion', { votes, proposedHere: true })), 'passed');
  });
  // Review finding 12 (slice A-fix): the publisher refused to hold a subscriber's deletion, but adopted its rebase and served it open to
  // every other subscriber until its deadline.
  it('the publisher holds no subscriber\'s rebase round, as it holds no subscriber\'s deletion', async () => {
    const { adoptionRefusal } = await import('../../server/dist/networks/round-local-state.js');
    const now = Date.now();
    const deletion = adoptionRefusal(publishing, roundOf('space_deletion', { subjectInstanceId: PEER }), now);
    assert.equal(deletion, 'proposed by a subscriber');
    assert.equal(adoptionRefusal(publishing, roundOf('space_rebase', { subjectInstanceId: PEER }), now), deletion,
      'the publisher adopted a subscriber\'s rebase round');
  });
  // Q-968: this case asserted the hole, a subscriber's meta_change passing on the publisher on the subscriber's own yes. Only the publisher's
  // cast decides on pub/sub, and a publisher passes only a round it opened, of every kind.
  it('a subscriber\'s meta_change never passes on the publisher either, as its rebase does not', () => {
    const votes = [cast(PEER)];
    assert.equal(roundVerdict(publishing, roundOf('meta_change', { subjectInstanceId: PEER, votes })), null);
  });
});
