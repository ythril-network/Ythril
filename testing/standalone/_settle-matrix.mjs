/**
 * The cells of the settle matrix — a round of type T on a network of type N, concluded through the settle via V — answered once, with every set DERIVED.
 *
 * ## The question it answers
 *
 * *"Round of type T on a network of type N, one yes from deciding (or the proposer's own yes, at open): what does THIS instance look like once the
 * instance is quiescent, by each via that can conclude AND pass a round?"* The vias are the server's own `SETTLE_VIAS` (design v5 section 1.1), the
 * round types and the network types are the unions declared in `config/types-networks.ts`: nothing is a hand-written list of sites, so a seventh via,
 * a seventh round type or a sixth network type is a cell, or this fails (design v5 section 6.1 X19, TS-2, TS-5).
 *
 * ## What it derives, and the two exclusions that are written WITH their reason
 *
 * The matrix is over the vias that can conclude a round as PASSED. `expiry` concludes `expired` only (D-39 = C: a round within its deadline is never
 * evaluated for passing by the tick) and `retry` concludes nothing (it hands owed space rounds back to the runner). Each exclusion is a row of
 * {@link CANNOT_PASS_A_ROUND} and a row naming a via the server no longer has is stale and fails. Every via that remains needs a driver in
 * {@link DRIVERS}: a via with no driver FAILS, it is never skipped.
 *
 * ## The guards a hand-written copy drops
 *
 * - **It waits for QUIESCENCE, never for a number of calm turns** (`_quiescence.mjs`): the notify queue, the sync cycles and the space-act runner.
 * - **"Acted once" is the REAL body's run count** (`spaceActBodyRuns`), as a difference across the cell, so a cell cannot read an earlier cell's run.
 * - **The round is read LIVE** from the loader after the act: `appliedHere` on the object a local variable holds says nothing about the config.
 * - **The proposer has its own scenario.** A vote site starts one yes short with everyone else's cast stored; the proposer's yes is the only one a
 *   round has when it opens, so its network has no other voter (the subject of a join or a removal excepted) and its deciding yes is its own.
 *
 * ## What it does not do
 *
 * It does not decide what a cell asserts beyond the state it returns: the per-type tables and their reasons are in the test that uses them.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { allowEngineToDialPrivatePeers, bootInstance, callRoute } from './_vote-round-instance.mjs';
import { SELF, P1, P2, JOINER, NET_ID, ROUND_ID, scenario, bootScenario } from './_vote-round-sites.mjs';
import { requireExport } from './_round-open-fixtures.mjs';
import { quiescent } from './_quiescence.mjs';
import { entriesOf } from './_space-act-harness.mjs';

const SETTLE_MODULE = '../../server/dist/networks/round-conclusion.js';

/** The vias that cannot conclude a round as passed, each with the reason the matrix leaves it out. An exclusion with no via behind it is stale. */
export const CANNOT_PASS_A_ROUND = {
  expiry: 'concludes `expired` only: D-39 = C, the tick never evaluates a round within its deadline for passing',
  retry: 'concludes nothing: it hands owed space rounds back to the runner',
};

/** The union members a `export type Name = 'a' | 'b'` declaration lists, read from the server source — the set a new member joins. */
export function declaredUnion(name) {
  const declared = new RegExp(`export type ${name}\\s*=([^;]+);`).exec(fs.readFileSync('server/src/config/types-networks.ts', 'utf8'));
  assert.ok(declared, `${name} is gone from config/types-networks.ts — re-anchor this matrix`);
  const members = [...declared[1].matchAll(/'(\w+)'/g)].map(m => m[1]);
  assert.ok(members.length >= 2, `${name} lists ${members.length} member(s): a set of fewer than two is not a matrix axis`);
  return members;
}

/** `SETTLE_VIAS` and `REQUEST_VIAS` from the built server, or `undefined` for each that does not exist (the test names the absence). */
export async function settleVocabulary() {
  const mod = await import(SETTLE_MODULE);
  return { vias: Array.isArray(mod.SETTLE_VIAS) ? [...mod.SETTLE_VIAS] : undefined, requestVias: Array.isArray(mod.REQUEST_VIAS) ? [...mod.REQUEST_VIAS] : undefined };
}

/** What a settle of a passing round by a vote (`local vote`, `peer vote`, `gossip`) leaves, per round type — a fixture, literal on purpose. */
export const AFTER_A_VOTE = {
  join: { applied: false, members: [P1, P2, JOINER], spaces: ['general', 'notes'], pending: [], layers: [], notified: false, runs: {} },
  remove: { applied: false, members: [P1], spaces: ['general', 'notes'], pending: [], layers: [], notified: true, runs: {} },
  space_deletion: { applied: true, members: [P1, P2], spaces: ['general'], pending: [], layers: [], notified: false, runs: { delete: 1 } },
  space_wipe: { applied: true, members: [P1, P2], spaces: ['general', 'notes'], pending: [], layers: [], notified: false, runs: { wipe: 1 } },
  meta_change: { applied: false, members: [P1, P2], spaces: ['general', 'notes'], pending: [], layers: ['notes'], notified: false, runs: {} },
  space_addition: { applied: false, members: [P1, P2], spaces: ['general', 'notes'], pending: ['fresh'], layers: [], notified: false, runs: {} },
};

/**
 * What the proposer's own yes leaves when it decides a round at open, on a network with no other voter. The same effects, differing in the two places
 * the design says they differ: the roster has nobody else on it, and a space the proposer adds is a space it HAS, so it is added and not offered.
 */
export const AFTER_AT_OPEN = {
  join: { applied: false, members: [JOINER], spaces: ['general', 'notes'], pending: [], layers: [], notified: false, runs: {} },
  remove: { applied: false, members: [], spaces: ['general', 'notes'], pending: [], layers: [], notified: true, runs: {} },
  space_deletion: { applied: true, members: [], spaces: ['general'], pending: [], layers: [], notified: false, runs: { delete: 1 } },
  space_wipe: { applied: true, members: [], spaces: ['general', 'notes'], pending: [], layers: [], notified: false, runs: { wipe: 1 } },
  // A third difference, the governance's own (F-39.2, `planPassedMetaChange`): the proposer's own schema edit lands in its OWN
  // definitions, and a network layer is written here only where this instance already holds one — a fresh network holds none.
  meta_change: { applied: false, members: [], spaces: ['general', 'notes'], pending: [], layers: [], notified: false, runs: {} },
  space_addition: { applied: false, members: [], spaces: ['fresh', 'general', 'notes'], pending: [], layers: [], notified: false, runs: {} },
};

const member = (instanceId, extra = {}) => ({
  instanceId, label: `member ${instanceId.slice(-2)}`, url: `https://${instanceId.slice(-2)}.example`, tokenHash: 'h', direction: 'both', ...extra,
});

/** The proposal an opener hands `proposeRound` for a round of this type: only what the round is ABOUT, never the fields the open path completes. */
function proposalOf(roundType, netType, peerUrl) {
  const base = { type: roundType, subjectInstanceId: SELF, subjectLabel: 'Subject', subjectUrl: '' };
  const spaces = {
    space_deletion: { spaceId: 'notes' }, space_wipe: { spaceId: 'notes' }, space_addition: { spaceId: 'fresh' },
    meta_change: { spaceId: 'notes', pendingMeta: { purpose: 'a purpose the network chose' }, metaChangedFields: ['purpose'], baseMetaVersion: 0 },
  };
  if (roundType === 'join') return { ...base, subjectInstanceId: JOINER, pendingMember: member(JOINER), ...(netType === 'braintree' ? { requiredVoters: [SELF] } : {}) };
  if (roundType === 'remove') return { ...base, subjectInstanceId: P2, subjectUrl: peerUrl, ...(netType === 'braintree' ? { requiredVoters: [SELF] } : {}) };
  return { ...base, ...spaces[roundType] };
}

/** A network whose only voter is this instance (a removal's subject is on its roster and does not vote), the round not yet opened. */
function soloNetwork(roundType, netType) {
  return {
    id: NET_ID, label: 'Net', type: netType, origin: 'created', syncSchedule: '', spaces: ['general', 'notes'], votingDeadlineHours: 24,
    createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [],
    members: roundType === 'remove' ? [member(P2, netType === 'braintree' ? { parentInstanceId: SELF } : netType === 'pubsub' ? { direction: 'push' } : {})] : [],
  };
}

/** Everything about this instance a conclusion can have changed, read LIVE from the loader, as plain data. */
export function observeRound(loader, peer, roundId) {
  const net = loader.getConfig().networks.find(n => n.id === NET_ID);
  const r = (net?.pendingRounds ?? []).find(x => x.roundId === roundId);
  return {
    held: !!r, concluded: r?.concluded === true, passed: r?.passed === true, applied: r?.appliedHere === true,
    members: (net?.members ?? []).map(m => m.instanceId).sort(),
    spaces: [...(net?.spaces ?? [])].sort(),
    pending: (net?.pendingSpaces ?? []).map(p => p.networkId).sort(),
    introductions: (net?.introductions ?? []).map(i => i.instanceId).sort(),
    layers: Object.keys(net?.schemaLayers ?? {}).sort(),
    notified: peer.seen.some(s => s.method === 'POST' && s.url === '/api/notify'),
  };
}

/** Space-act bodies the runner has run, per kind, read from the runner's own counter of the REAL bodies. */
async function bodyRuns() {
  const runner = await import('../../server/dist/spaces/space-act-runner.js');
  assert.equal(typeof runner.spaceActBodyRuns, 'function', 'server/src/spaces/space-act-runner.ts does not export spaceActBodyRuns — design v5 section 2.5: the count of REAL bodies that "ran once" is read from');
  return { ...runner.spaceActBodyRuns() };
}

/** The runs of each kind between two readings of {@link bodyRuns}, zero kinds left out. */
function runsBetween(before, after) {
  return Object.fromEntries(Object.keys(after).map(k => [k, after[k] - (before[k] ?? 0)]).filter(([, n]) => n !== 0));
}

/**
 * The drivers, one per via: each delivers the DECIDING yes through that via's own door. The key is the via's own name in `SETTLE_VIAS`, so a via the
 * server has and this object lacks is found by {@link driverFor}.
 */
export const DRIVERS = {
  'local vote': async ({ roundId }) => {
    const { castVoteAct } = await import('../../server/dist/networks/vote-acts.js');
    const res = castVoteAct(NET_ID, roundId, { vote: 'yes' });
    if (res.status !== 200) throw new Error(`the operator cast was refused: ${JSON.stringify(res)}`);
  },
  'peer vote': async ({ roundId, scen }) => {
    const { syncVotesRouter } = await import('../../server/dist/api/sync/votes.js');
    const res = await callRoute(syncVotesRouter, 'post', '/networks/:networkId/votes/:roundId', {
      params: { networkId: NET_ID, roundId }, body: scen.decidingCast, authToken: { peerInstanceId: P1, rights: { instanceAdmin: false } },
    });
    if (res.code !== 200) throw new Error(`the relayed cast was refused: ${JSON.stringify(res)}`);
  },
  gossip: async ({ scen, peer }) => {
    peer.serve([scen.wire]);
    const { runSyncForPeer } = await import('../../server/dist/sync/engine.js');
    await runSyncForPeer(P1);
  },
  proposer: async (world) => {
    const proposeRound = await requireExport('../../server/dist/networks/propose-round.js', 'proposeRound', 'design v5 section 1.2: the one open path, which settles through the proposer via');
    const loader = world.loader;
    const cfg = loader.getConfig();
    const net = cfg.networks.find(n => n.id === NET_ID);
    const out = proposeRound(net, cfg, world.proposal, { now: Date.now() });
    loader.saveConfig(cfg);
    world.roundId = out.round.roundId;
    await out.settled;
  },
};

/** The driver of `via`, or a failure naming the via: a via with no driver is not a via nobody drives, it is a cell nobody wrote. */
export function driverFor(via) {
  const driver = DRIVERS[via];
  assert.equal(typeof driver, 'function', `SETTLE_VIAS has '${via}' and the settle matrix has no driver for it: add one to DRIVERS in _settle-matrix.mjs (a via nothing drives is a conclusion nothing tests)`);
  return driver;
}

/**
 * Put the cell on disk and load it: a vote site's scenario (one yes short), or the proposer's solo network. Returns the world a driver reads.
 * `spaces` of the proposer include `fresh`, because a space a proposer adds is a space it has.
 */
export async function bootCell(dir, via, roundType, netType, peer) {
  if (via === 'proposer') {
    const net = soloNetwork(roundType, netType);
    const loader = await bootInstance(dir, {
      instanceId: SELF, networks: [net], peerTokens: { [P2]: 'token-p2', [JOINER]: 'token-joiner' },
      spaces: [{ id: 'general', label: 'General', builtIn: true, folders: [] }, { id: 'notes', label: 'Notes', folders: [] }, { id: 'fresh', label: 'Fresh', folders: [] }],
    });
    return { loader, peer, proposal: proposalOf(roundType, netType, peer.url), roundId: undefined, expected: AFTER_AT_OPEN[roundType] };
  }
  const site = via === 'local vote' ? 'cast' : via === 'peer vote' ? 'relay' : 'gossip';
  const scen = scenario(roundType, netType, site, peer.url);
  // On pub/sub a deletion or wipe that passes by a vote is the PUBLISHER's, reaching a subscriber (D-40, X10): a publisher never passes
  // one it did not open. So in those cells this instance subscribes — it pulls from P1, its publisher.
  if (netType === 'pubsub' && (roundType === 'space_deletion' || roundType === 'space_wipe')) {
    const publisher = scen.net.members.find(m => m.instanceId === P1);
    if (publisher) publisher.direction = 'pull';
  }
  const loader = await bootScenario(dir, scen);
  assert.equal(loader.getConfig().networks[0].pendingRounds[0].concluded, false, 'the scenario starts concluded');
  return { loader, peer, scen, roundId: ROUND_ID, expected: AFTER_A_VOTE[roundType] };
}

/** Drive the deciding yes through `via`, wait for quiescence, and return the instance as it is then, with the runs of space-act bodies and what stands. */
export async function settleCell(world, via) {
  allowEngineToDialPrivatePeers();
  world.peer.seen.length = 0;
  const before = await bodyRuns();
  await driverFor(via)(world);
  await quiescent(world.loader);
  return {
    ...observeRound(world.loader, world.peer, world.roundId),
    runs: runsBetween(before, await bodyRuns()),
    entries: entriesOf(world.loader).map(e => [e.kind, e.localId, e.state]),
  };
}
