/**
 * What this instance's vote list tells a peer, what the expiry tick heals, what the hold reads, and which casts are pushed again (bundle-106, §3.1, §3.6, §3.3 v5 (X15), §3.4 (W19);
 * R-VR1, R-VR1b, R-X15, R-W19).
 *
 * ## The rules
 *
 * - **R-VR1 (what "a member has concluded it" means on the wire).** A deletion or wipe round is SERVED - `SERVED_ONCE_PASSED` names the types - once it has passed, and a copy
 *   says `concluded: true` only when this instance's act for it is COMPLETE (`appliedHere`). A member whose wipe is running, queued or failed serves it as `concluded: false`, so a
 *   peer never lifts its hold on the word of a member that has only decided.
 * - **R-X15 (a past-deadline round is not served).** The passed half of the filter carries a deadline term: an owed round kept for retry past its deadline, and a passed
 *   addition or meta change nobody needs after its deadline, are not re-served on every `GET .../votes` by every member every cycle. Kept for retry and served are two questions.
 *   The hold index (`holdIndex`) is memoised on the config's write generation: the same object while nothing was written, a new one after a write.
 * - **R-VR1b (the lazy heal).** A stored OPEN round carrying `passed: true` can only have come from a peer (an older build adopted an upgraded proposer's round and a build before
 *   this one stored it): the expiry tick clears it, writes once for it, and a second tick writes nothing. The count is the config's write generation, never a spy or an mtime.
 * - **R-W19 (kept is not pushed).** An owed round past its deadline stays in the network's rounds (it is the debt a retry needs) but its casts are not POSTed to a peer again every
 *   cycle; a round concluded within its deadline still is - the twin. And the relay and the member announce read `getConfig()` (the live config) and never `loadConfig()` (a
 *   disk read that races the debounced writer), matched on CALLS outside comments.
 *
 * ## Seen red
 *
 * At a638e702: the served filter has no deadline term and does not serve a passed deletion or wipe at all; there is no `SERVED_ONCE_PASSED`, `configWriteGeneration`,
 * `holdIndex` or heal; an owed round past its deadline is pruned (so `kept` fails) and `loadConfig(` is called at `api/sync/votes.ts` and `members.ts`. The within-deadline twins are
 * controls that pass on purpose. After the fix, by hand: drop `!roundPastDeadline` from the served filter -> R-X15 red; rebuild the index per call -> the identity row red; drop the heal ->
 * R-VR1b red; serve `concluded: true` for an owed round -> R-VR1 red.
 *
 * Run: node --test testing/standalone/a-served-vote-list-says-what-a-peer-may-rely-on.test.js  (requires a prior server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { tempInstanceDir, removeInstanceDir, bootInstance, settled, allowEngineToDialPrivatePeers } from './_vote-round-instance.mjs';
import { callRouteAfterAuth } from './_route-after-auth.mjs';
import { startVotesPeer, SELF, P1 } from './_vote-round-sites.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { stripComments } from './_strip-comments.mjs';
import { REPO_ROOT } from './_sources.mjs';

const dir = tempInstanceDir('ythril-served-list-');
const HOUR = 3_600_000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const NET = 'served-net';

const member = (instanceId, extra = {}) => ({ instanceId, label: `m${instanceId.slice(-2)}`, url: `https://${instanceId.slice(-2)}.example`, tokenHash: 'h', direction: 'both', ...extra });
const round = (roundId, over = {}) => ({
  roundId, type: 'space_wipe', spaceId: 'notes', subjectInstanceId: SELF, subjectLabel: 'x', subjectUrl: '',
  openedAt: iso(NOW - 2 * HOUR), deadline: iso(NOW + 22 * HOUR), votes: [{ instanceId: SELF, vote: 'yes', castAt: iso(NOW - 2 * HOUR) }],
  concluded: true, passed: true, ...over,
});
const owedEntry = (roundId) => ({ id: `act-${roundId}`, kind: 'wipe', localId: 'notes', rounds: [{ networkId: NET, roundId }], postSteps: {}, registeredAt: iso(NOW - HOUR), state: 'owed', attempts: 2, retryAt: iso(NOW + HOUR) });

let loader;
const bootWith = (rounds, { carried = ['notes'] } = {}) => bootInstance(dir, {
  instanceId: SELF, peerTokens: { [P1]: 'token-p1' },
  spaces: [{ id: 'general', label: 'General', builtIn: true, folders: [] }, { id: 'notes', label: 'Notes', folders: [] }],
  networks: [{
    id: NET, label: 'Served', type: 'club', origin: 'created', syncSchedule: '', spaces: carried, votingDeadlineHours: 24, createdAt: '2026-01-01T00:00:00.000Z',
    pendingRounds: rounds, members: [member(P1, { version: '99.0.0', versionCheckedAt: iso(NOW - HOUR) })],
  }],
});
async function servedBy(authToken = { peerInstanceId: P1, rights: { instanceAdmin: false } }) {
  const { syncVotesRouter } = await import('../../server/dist/api/sync/votes.js');
  const res = await callRouteAfterAuth(syncVotesRouter, 'get', '/networks/:networkId/votes', { params: { networkId: NET }, authToken });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  return res.body.rounds;
}

describe('what this instance serves a peer about its rounds', () => {
  before(async () => { loader = await bootWith([]); });

  it('R-VR1: SERVED_ONCE_PASSED names every type a member must still learn of, deletions and wipes included', async () => {
    const state = await import('../../server/dist/networks/round-state.js');
    assert.ok(Array.isArray(state.SERVED_ONCE_PASSED) || state.SERVED_ONCE_PASSED instanceof Set,
      'networks/round-state.ts has no SERVED_ONCE_PASSED: which rounds a peer still needs after they end is spelled inline at the served filter');
    const set = new Set(state.SERVED_ONCE_PASSED);
    for (const type of ['space_addition', 'meta_change', 'space_deletion', 'space_wipe']) assert.ok(set.has(type), `${type} is not served after it passes: a proposer that decided it at open is never learned of`);
    for (const type of ['join', 'remove']) assert.ok(!set.has(type), `${type} must stay out of the served-once set`);
  });

  it('R-VR1: a decided wipe whose act is not complete is served as concluded:false; complete, as concluded:true', async () => {
    loader = await bootWith([round('v-owed'), round('v-done', { appliedHere: true })]);
    loader.mutateConfig((cfg) => { cfg.pendingSpaceActs = [owedEntry('v-owed')]; });
    const rounds = await servedBy();
    const owed = rounds.find(r => r.roundId === 'v-owed');
    const done = rounds.find(r => r.roundId === 'v-done');
    assert.ok(owed, `a decided, un-applied wipe is not served at all (served: ${rounds.map(r => r.roundId).join(', ') || 'nothing'}): a peer cannot see that this member holds the space`);
    assert.equal(owed.concluded, false, 'a member whose wipe is owed served it as concluded: a peer lifts its hold on the word of a member that has only decided');
    assert.ok(done, 'a completed wipe is not served');
    assert.equal(done.concluded, true);
    assert.equal(done.passed, true);
    assert.equal(Object.hasOwn(done, 'appliedHere'), false, 'a local field left on the wire');
  });

  it('R-X15: a passed meta change past its deadline is not served; the same round within its deadline is (the twin)', async () => {
    const meta = (id, over) => round(id, { type: 'meta_change', spaceId: 'notes', pendingMeta: { purpose: 'p' }, metaChangedFields: ['purpose'], baseMetaVersion: 0, ...over });
    loader = await bootWith([
      meta('m-live', { appliedHere: true }),
      meta('m-late', { appliedHere: true, deadline: iso(NOW - HOUR), openedAt: iso(NOW - 30 * HOUR) }),
    ]);
    const ids = (await servedBy()).map(r => r.roundId);
    assert.ok(ids.includes('m-live'), `the twin failed: a passed meta change within its deadline is not served (${ids.join(', ')})`);
    assert.ok(!ids.includes('m-late'), 'a passed round past its deadline was served again: every member re-serves it to every peer on every cycle until it is pruned');
  });

  it('R-X15: an owed round kept past its deadline is not re-served either', async () => {
    loader = await bootWith([round('o-late', { deadline: iso(NOW - HOUR), openedAt: iso(NOW - 30 * HOUR) })]);
    loader.mutateConfig((cfg) => { cfg.pendingSpaceActs = [owedEntry('o-late')]; });
    const ids = (await servedBy()).map(r => r.roundId);
    assert.ok(!ids.includes('o-late'), 'an owed round past its deadline was served: receivers refuse it at adoption anyway and its copy carries no evidence');
  });

  it('R-X15: the hold index is one object per config write generation, and a new one after a write', async () => {
    loader = await bootWith([round('h-1', { appliedHere: true })]);
    assert.ok(existsSync(`${REPO_ROOT}/server/src/sync/space-exchange-set.ts`), 'sync/space-exchange-set.ts does not exist: the hold is not evaluated from any index, so it cannot be one object per config generation');
    const { holdIndex } = await import('../../server/dist/sync/space-exchange-set.js');
    assert.equal(typeof holdIndex, 'function', 'sync/space-exchange-set.ts has no holdIndex: the hold is evaluated from the rounds on every request, every loop step and every peer-token search');
    const first = holdIndex(loader.getConfig());
    assert.equal(holdIndex(loader.getConfig()), first, 'the index was rebuilt although nothing was written');
    loader.mutateConfig((cfg) => { cfg.networks[0].pendingRounds.push(round('h-2', { appliedHere: true })); });
    assert.notEqual(holdIndex(loader.getConfig()), first, 'the index did not see a config write: the hold would answer from a stale generation');
  });
});

describe('the lazy heal of a stored open round that says passed', () => {
  before(async () => { loader = await bootWith([]); });

  const open = () => round('heal-1', { concluded: false, passed: true, appliedHere: undefined, votes: [] });

  it('R-VR1b: one tick clears the passed an open round was stored with', async () => {
    loader = await bootWith([open()]);
    const { runRoundExpiryTick } = await import('../../server/dist/networks/round-expiry.js');
    runRoundExpiryTick(NOW);
    assert.equal(loader.getConfig().networks[0].pendingRounds[0].passed, undefined, 'the stored open round still says passed: it was adopted from a peer and reads as decided');
  });

  it('R-VR1b: the heal is one write, and a second tick writes nothing (counted through the write generation)', async () => {
    loader = await bootWith([open()]);
    assert.equal(typeof loader.configWriteGeneration, 'function', 'config/loader.ts exports no configWriteGeneration: a write cannot be counted without spying on an export ESM does not allow spied');
    const { runRoundExpiryTick } = await import('../../server/dist/networks/round-expiry.js');
    const gen = () => loader.configWriteGeneration();
    const g0 = gen();
    runRoundExpiryTick(NOW);
    const g1 = gen();
    assert.ok(g1 > g0, 'the heal was not written');
    runRoundExpiryTick(NOW + 1000);
    assert.equal(gen(), g1, 'a tick with nothing to heal wrote the config again');
  });
});

describe('an owed round is kept but its casts are not pushed again', { skip: privateAddressSkipReason() }, () => {
  let peer;
  before(async () => { allowEngineToDialPrivatePeers(); peer = await startVotesPeer(); });
  // The last suite of the file, so its teardown is the file's: the instance directory goes once nothing reads it.
  after(async () => { await peer?.close(); removeInstanceDir(dir); });

  it('R-W19: an owed round past its deadline stays and is not POSTed; a round concluded within its deadline is (the twin)', async () => {
    loader = await bootWith([
      round('push-live', { appliedHere: true }),
      round('push-owed', { deadline: iso(NOW - HOUR), openedAt: iso(NOW - 30 * HOUR) }),
    ], { carried: [] }); // no carried space: the cycle runs governance only, and needs no store
    loader.mutateConfig((cfg) => { cfg.pendingSpaceActs = [owedEntry('push-owed')]; cfg.networks[0].members[0].url = peer.url; });
    peer.seen.length = 0;
    const { runSyncForPeer } = await import('../../server/dist/sync/engine.js');
    await runSyncForPeer(P1);
    await settled(() => peer.seen.length);
    const posted = peer.seen.filter(s => s.method === 'POST' && /\/votes\//.test(s.url)).map(s => decodeURIComponent(s.url.split('/votes/')[1]));
    assert.ok(posted.includes('push-live'), `the twin failed: a round concluded within its deadline was not pushed (posted: ${posted.join(', ') || 'nothing'})`);
    assert.ok(loader.getConfig().networks[0].pendingRounds.some(r => r.roundId === 'push-owed'), 'the owed round was pruned: the debt a retry needs is gone');
    assert.ok(!posted.includes('push-owed'), 'an owed round past its deadline was POSTed to the peer again');
  });

  it('R-W19: the prune keeps an owed round past its deadline and removes a finished one (kept for retry, with its twin)', async () => {
    loader = await bootWith([
      round('prune-done', { appliedHere: true, deadline: iso(NOW - HOUR), openedAt: iso(NOW - 30 * HOUR) }),
      round('prune-owed', { deadline: iso(NOW - HOUR), openedAt: iso(NOW - 30 * HOUR) }),
    ], { carried: [] });
    loader.mutateConfig((cfg) => { cfg.pendingSpaceActs = [owedEntry('prune-owed')]; });
    const { pruneExpiredRounds } = await import('../../server/dist/sync/vote-round-retention.js');
    loader.mutateConfig((cfg) => { pruneExpiredRounds(cfg.networks[0], Date.now()); });
    const kept = loader.getConfig().networks[0].pendingRounds.map(r => r.roundId);
    assert.ok(!kept.includes('prune-done'), 'the twin failed: a finished round past its deadline was not pruned');
    assert.ok(kept.includes('prune-owed'), 'an owed round past its deadline was pruned: the debt a retry (and the hold that rides on it) is deleted with it');
  });

  it('R-W19: the relay and the member announce read getConfig(), never loadConfig() (calls, outside comments)', () => {
    for (const file of ['server/src/api/sync/votes.ts', 'server/src/api/sync/members.ts']) {
      const code = stripComments(readFileSync(`${REPO_ROOT}/${file}`, 'utf8'));
      assert.ok(/\bgetConfig\(/.test(code), `${file} reads no config at all: the derivation is broken`);
      assert.ok(!/\bloadConfig\(/.test(code), `${file} calls loadConfig(): a disk read in a handler that races the debounced writer, once per request`);
    }
  });
});
