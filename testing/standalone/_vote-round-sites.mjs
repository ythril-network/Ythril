/**
 * The three places a vote round is concluded by someone else's cast — driven through the real doors, over one scenario.
 *
 * ## The question it answers
 *
 * *"Round of type T on a network of type N, one yes from deciding: what does THIS instance look like after the deciding
 * yes arrives by each of the three routes?"* The routes are an operator's own cast (`castVoteAct`, what REST and MCP call), a
 * peer relaying a cast (`POST /api/sync/networks/:id/votes/:roundId`, its own handler) and the gossip pass of the sync engine
 * (`runSyncForPeer` against a peer that really answers over HTTP). A round reaches a conclusion through all three, and the
 * test that compares them has to drive all three the same way or it compares the harnesses.
 *
 * ## The guards a hand-written copy drops
 *
 * - **Everyone but the decider has already voted.** The deciding cast is the only thing that differs between the sites; a
 *   scenario where an earlier cast could conclude the round would test the earlier cast.
 * - **The cycle ends after the gossip.** The peer is stored below the version floor, so the sync cycle throws once governance
 *   has been exchanged and never reaches the data plane (which needs records, spaces and a peer to pull from).
 * - **The state is read after the deferred effects have landed** (`settled`), never after a delay.
 *
 * ## What it does not do
 *
 * It does not pick what to assert. A caller compares the {@link observe} snapshot it gets.
 */
import { bootInstance, settled, startFakePeer, callRoute, allowEngineToDialPrivatePeers } from './_vote-round-instance.mjs';

export const SELF = 'aaaaaaaa-0000-4000-8000-000000005e1f';
export const P1 = 'aaaaaaaa-0000-4000-8000-0000000000a1';
export const P2 = 'aaaaaaaa-0000-4000-8000-0000000000a2';
export const JOINER = 'aaaaaaaa-0000-4000-8000-0000000000b1';

export const NET_TYPES = ['closed', 'democratic', 'club', 'braintree', 'pubsub'];
export const ROUND_TYPES = ['join', 'remove', 'space_deletion', 'space_wipe', 'meta_change', 'space_addition'];
export const SITES = ['cast', 'relay', 'gossip'];
export const NET_ID = 'net-1';
export const ROUND_ID = 'round-1';
const SPACES = [{ id: 'general', label: 'General', builtIn: true, folders: [] }, { id: 'notes', label: 'Notes', folders: [] }];
const CAST_AT = '2026-10-09T10:05:00.000Z';

const member = (instanceId, extra = {}) => ({
  instanceId, label: `member ${instanceId.slice(-2)}`, url: `https://${instanceId.slice(-2)}.example`, tokenHash: 'h', direction: 'both', ...extra,
});

/** Who votes on a round of this type: every member and this instance, less the member a join or a removal is ABOUT. */
function electorate(roundType) {
  const everyone = [P1, P2, SELF];
  if (roundType === 'join') return everyone;
  if (roundType === 'remove') return everyone.filter(i => i !== P2);
  return everyone;
}

/** The round as it stood before the deciding cast, with this site's decider absent from `votes`, and the full set beside it. */
export function scenario(roundType, netType, site, peerUrl) {
  const decider = site === 'cast' ? SELF : P1;
  const cast = (instanceId) => ({ instanceId, vote: 'yes', castAt: CAST_AT });
  const all = electorate(roundType).map(cast);
  const round = {
    roundId: ROUND_ID, type: roundType, subjectInstanceId: roundType === 'join' ? JOINER : roundType === 'remove' ? P2 : P1,
    subjectLabel: 'Subject', subjectUrl: roundType === 'remove' ? peerUrl : '', openedAt: '2026-10-09T10:00:00.000Z',
    deadline: '2099-01-01T00:00:00.000Z', votes: all.filter(c => c.instanceId !== decider), concluded: false,
    ...(roundType === 'join' ? { pendingMember: member(JOINER) } : {}),
    ...(['space_deletion', 'space_wipe', 'meta_change'].includes(roundType) ? { spaceId: 'notes' } : {}),
    ...(roundType === 'space_addition' ? { spaceId: 'fresh' } : {}),
    ...(roundType === 'meta_change' ? { pendingMeta: { purpose: 'a purpose the network chose' }, metaChangedFields: ['purpose'], baseMetaVersion: 0 } : {}),
    ...(netType === 'braintree' && (roundType === 'join' || roundType === 'remove') ? { requiredVoters: [P1] } : {}),
  };
  const net = {
    id: NET_ID, label: 'Net', type: netType, origin: 'created', syncSchedule: '', spaces: ['general', 'notes'], votingDeadlineHours: 24,
    createdAt: '2026-01-01T00:00:00.000Z',
    // P1 is stored below the version floor, so a gossip cycle ends after governance has been exchanged.
    members: [member(P1, { url: peerUrl, version: '1.0.0', versionCheckedAt: '2026-10-09T09:00:00.000Z' }), member(P2, netType === 'braintree' ? { parentInstanceId: P1 } : {})],
    ...(netType === 'braintree' ? { myParentInstanceId: P1 } : {}),
    pendingRounds: [round],
  };
  return { net, round, decider, decidingCast: cast(decider), wire: { ...round, votes: all, concluded: false } };
}

/** Everything about this instance a conclusion can have changed, as plain data. */
export function observe(loader, peer) {
  const net = loader.getConfig().networks.find(n => n.id === NET_ID);
  const r = (net?.pendingRounds ?? []).find(x => x.roundId === ROUND_ID);
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

/** A fake peer that serves `payload.rounds` as its open rounds and acknowledges everything a sync cycle pushes. */
export async function startVotesPeer() {
  const state = { rounds: [] };
  const peer = await startFakePeer((method, url) => {
    if (method === 'GET' && /\/votes$/.test(url)) return { status: 200, body: { rounds: state.rounds } };
    if (method === 'POST' && url === '/api/notify') return { status: 204, body: undefined };
    if (method === 'POST' && (/\/votes\//.test(url) || url === '/api/sync/warm')) return { status: 200, body: { status: 'ok' } };
    return undefined;
  });
  peer.serve = (rounds) => { state.rounds = rounds; };
  return peer;
}

/** Put the scenario on disk and load it. */
export async function bootScenario(dir, scen) {
  return bootInstance(dir, {
    instanceId: SELF, spaces: SPACES, networks: [scen.net],
    peerTokens: { [P1]: 'token-p1', [P2]: 'token-p2', [JOINER]: 'token-joiner' },
  });
}

/** Deliver the deciding cast through `site`, then wait for the deferred effects, and return what the instance looks like. */
export async function decide(site, loader, scen, peer) {
  allowEngineToDialPrivatePeers();
  peer.seen.length = 0;
  if (site === 'cast') {
    const { castVoteAct } = await import('../../server/dist/networks/vote-acts.js');
    const res = castVoteAct(NET_ID, ROUND_ID, { vote: 'yes' });
    if (res.status !== 200) throw new Error(`the operator cast was refused: ${JSON.stringify(res)}`);
  } else if (site === 'relay') {
    const { syncVotesRouter } = await import('../../server/dist/api/sync/votes.js');
    const res = await callRoute(syncVotesRouter, 'post', '/networks/:networkId/votes/:roundId', {
      params: { networkId: NET_ID, roundId: ROUND_ID }, body: scen.decidingCast, authToken: { peerInstanceId: P1, rights: { instanceAdmin: false } },
    });
    if (res.code !== 200) throw new Error(`the relayed cast was refused: ${JSON.stringify(res)}`);
  } else {
    peer.serve([scen.wire]);
    const { runSyncForPeer } = await import('../../server/dist/sync/engine.js');
    await runSyncForPeer(P1);
  }
  return settled(() => observe(loader, peer));
}
