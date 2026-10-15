/**
 * A passed `meta_change` round warns "overwrote field(s) changed since it was proposed" ONLY for a field whose stored value
 * is no longer the value the round captured when it was proposed (`R6-8`, the base-value half; found as P5's false positive).
 *
 * ## The defect
 *
 * `applyMetaRound` decides "did somebody else change this field since the proposal" from the meta VERSION: the round records
 * the version it was computed against and the conclusion compares it with the version of what it merges into. That works for
 * the space's own meta, which has a version. It cannot work for a NETWORK LAYER, which has none (`replicatedMetaOf` strips the
 * counters), and it cannot work for the own definitions of a space that a layer has set apart (`space.ownMeta`, also stripped).
 * Both read as "moved" — version 0 against the base's 5 — with no history to recover the base from, so EVERY field the round
 * changes is reported as overwritten, on the first conclusion, with nothing else having touched it. The operator who reads the
 * warning to find whose edit was superseded finds nobody's: the warning cries wolf on the normal path, which is the one an
 * operator learns to skip.
 *
 * ## The rule
 *
 * The round carries the BASE VALUES of the fields it changes, captured at proposal. At conclusion a field is a collision only
 * when the value stored now differs from that captured value: somebody changed it after the proposal. A field nobody moved is
 * applied silently, and a field somebody moved is applied (the vote wins) and reported by name. Nothing here depends on how the
 * round stores them: the cases drive the PROPOSER's own path (`planSpaceMetaUpdate` and `applySpaceMetaUpdate`, as PATCH and
 * schema_update call them) and then conclude the round by a peer's relayed yes, the real route handler, and read the log.
 *
 * ## The cases
 *
 *  - UNMOVED: the layer and the own definitions hold what the round captured; the round concludes. No "overwrote" line.
 *  - ANOTHER FIELD MOVED: a different round changed `usageNotes` in between (own definitions and layer, as a conclusion writes
 *    them, so the space's version moves). The round's field `purpose` is untouched. No line naming `purpose`.
 *  - THE FIELD MOVED: `purpose` itself was changed in between. The round still applies (the vote wins) and the line names it.
 *
 * Each case asserts the round DID conclude and apply (the space runs on the round's value), so a case that never concluded
 * cannot pass by saying nothing.
 *
 * ## Seen red
 *
 * On 85c4c564 UNMOVED and ANOTHER FIELD MOVED fail with a line naming `purpose` (the false positive); THE FIELD MOVED passes
 * there (it is the control for the warning still being said when it is true).
 *
 * Run: a Mongo the harness accepts, then
 *      node --test testing/standalone/a-passed-round-warns-only-of-a-field-that-moved-from-its-base-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir, removeInstanceDir, bootInstance, settled, callRoute } from './_vote-round-instance.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const dir = tempInstanceDir('ythril-round-base-');
const skip = await mongoSkipReason();

const SELF = 'bbbbbbbb-0000-4000-8000-000000005e1f';
const P1 = 'bbbbbbbb-0000-4000-8000-0000000000a1';
const P2 = 'bbbbbbbb-0000-4000-8000-0000000000a2';
const NET = 'net-base';
const SPACE = 'notes';
const BASE = { purpose: 'original purpose', usageNotes: 'original notes' };

const member = (instanceId) => ({
  instanceId, label: `member ${instanceId.slice(-2)}`, url: `https://${instanceId.slice(-2)}.example`, tokenHash: 'h', direction: 'both',
});

let loader, effective, metaUpdate, votes;

/**
 * A democratic network of three (this instance and two peers), so the proposer's own yes is not enough and the round stays open
 * until a peer's relayed yes; the space carries a layer from the network that holds the base values, which is what sets its own
 * definitions apart (`ownMeta`) — the shape a space has once any network has sent it a schema.
 */
async function boot() {
  loader = await bootInstance(dir, {
    instanceId: SELF,
    spaces: [
      { id: 'general', label: 'General', builtIn: true, folders: [] },
      { id: SPACE, label: 'Notes', folders: [], meta: { ...BASE, version: 5, updatedAt: '2026-10-01T00:00:00.000Z' } },
    ],
    networks: [{
      id: NET, label: 'Net', type: 'democratic', origin: 'created', syncSchedule: '', spaces: [SPACE], votingDeadlineHours: 24,
      createdAt: '2026-01-01T00:00:00.000Z', members: [member(P1), member(P2)], pendingRounds: [],
    }],
    peerTokens: { [P1]: 'token-p1', [P2]: 'token-p2' },
  });
  assert.equal(effective.storeNetworkLayer(NET, SPACE, { ...BASE }), false, 'fixture check: the layer holding the base changed the effective meta');
  const held = loader.getConfig().spaces.find(s => s.id === SPACE);
  assert.ok(held.ownMeta, 'fixture check: the first layer did not set the own definitions apart');
}

/** This instance proposes `patch` as PATCH /api/spaces/:id does; returns the open round's id. */
async function propose(patch) {
  const space = loader.getConfig().spaces.find(s => s.id === SPACE);
  const decision = metaUpdate.planSpaceMetaUpdate({ spaceId: SPACE, space, body: { meta: patch }, ifMatch: undefined });
  assert.ok(decision.ok, `the proposal was refused: ${JSON.stringify(decision)}`);
  const out = await metaUpdate.applySpaceMetaUpdate(decision.plan);
  assert.equal(out.outcome, 'vote_pending', 'the proposer\'s own yes must not be enough on a democratic network of three');
  return out.rounds[0].roundId;
}

/** What another round that concluded meanwhile does: the new value in the own definitions and in the network's layer. */
function conclusionElsewhere(patch) {
  effective.commitOwnMetaEdit(SPACE, base => ({ ...base, ...patch }));
  const layer = loader.getConfig().networks.find(n => n.id === NET).schemaLayers[SPACE];
  effective.storeNetworkLayer(NET, SPACE, { ...layer, ...patch });
}

/** Peer P1's yes arrives by the relay route: the deciding cast. Returns the lines the conclusion logged. */
async function decide(roundId) {
  const { lines } = await logLinesDuring(async () => {
    const res = await callRoute(votes.syncVotesRouter, 'post', '/networks/:networkId/votes/:roundId', {
      params: { networkId: NET, roundId },
      body: { instanceId: P1, vote: 'yes', castAt: new Date().toISOString() },
      authToken: { peerInstanceId: P1, rights: { instanceAdmin: false } },
    });
    assert.equal(res.code, 200, `the relayed cast was refused: ${JSON.stringify(res)}`);
    await settled(() => {
      const r = loader.getConfig().networks.find(n => n.id === NET).pendingRounds.find(x => x.roundId === roundId);
      return { concluded: r?.concluded, meta: loader.getConfig().spaces.find(s => s.id === SPACE).meta };
    });
  });
  const round = loader.getConfig().networks.find(n => n.id === NET).pendingRounds.find(x => x.roundId === roundId);
  assert.equal(round.concluded && round.passed, true, `the round did not conclude as passed: ${JSON.stringify({ concluded: round.concluded, passed: round.passed, outcome: round.outcome })}`);
  return lines.filter(l => l.includes('overwrote field(s)'));
}

describe('a passed round warns of an overwrite only when the stored value moved from the base it captured', { skip }, () => {
  before(async () => {
    await openTestMongo('round_base_value_warning');
    effective = await import('../../server/dist/spaces/effective-meta.js');
    metaUpdate = await import('../../server/dist/spaces/meta-update.js');
    votes = await import('../../server/dist/api/sync/votes.js');
  });
  after(async () => {
    await closeTestMongo();
    removeInstanceDir(dir);
  });
  beforeEach(async () => { await boot(); });

  it('UNMOVED: nothing changed the field since the proposal, so applying it says nothing', async () => {
    const roundId = await propose({ purpose: 'the proposed purpose' });
    const warned = await decide(roundId);
    assert.equal(loader.getConfig().spaces.find(s => s.id === SPACE).meta.purpose, 'the proposed purpose', 'the passed round was not applied');
    assert.deepEqual(warned, [], `a clean conclusion warned that it overwrote something: ${warned.join(' | ')}`);
  });

  it('ANOTHER FIELD MOVED: a field the round does not change moved in between, so the round\'s own field is not a collision', async () => {
    const roundId = await propose({ purpose: 'the proposed purpose' });
    conclusionElsewhere({ usageNotes: 'notes another round set' });
    assert.ok(loader.getConfig().spaces.find(s => s.id === SPACE).meta.version > 5, 'fixture check: the other round left the space\'s meta version where it was');
    const warned = await decide(roundId);
    const meta = loader.getConfig().spaces.find(s => s.id === SPACE).meta;
    assert.equal(meta.purpose, 'the proposed purpose', 'the passed round was not applied');
    assert.equal(meta.usageNotes, 'notes another round set', 'the round reverted a field it never changed');
    assert.deepEqual(warned.filter(l => l.includes('purpose')), [], `the line names a field nobody moved: ${warned.join(' | ')}`);
  });

  it('THE FIELD MOVED: somebody changed this very field after the proposal — the vote wins and the line names it', async () => {
    const roundId = await propose({ purpose: 'the proposed purpose' });
    conclusionElsewhere({ purpose: 'what another round made it' });
    const warned = await decide(roundId);
    assert.equal(loader.getConfig().spaces.find(s => s.id === SPACE).meta.purpose, 'the proposed purpose', 'the vote did not win');
    assert.ok(warned.length === 1 && warned[0].includes('purpose'), `the overwritten field is not reported by name: ${JSON.stringify(warned)}`);
  });
});
