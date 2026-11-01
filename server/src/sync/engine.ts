/**
 * Outbound sync engine.
 *
 * For each network that has at least one member, this engine:
 * 1. Calls /api/sync/* on each peer to pull their changes into us
 * 2. Calls /api/sync/* on each peer to push our changes to them
 *    (push is symmetric — we push to peers; peers pull from us)
 *
 * The engine is triggered either by a cron schedule (per network) or
 * explicitly via POST /api/networks/:id/sync (manual trigger from admin UI).
 *
 * Braintree topology:
 * - Nodes with direction='push' only receive from their parent; never push up.
 * - When a node runs sync for a braintree network, it pushes down to its children
 *   and pulls from its parent.
 */

import { getConfig, saveConfig, saveConfigSoon, getSecrets } from '../config/loader.js';
import { CycleOutcome, REASONS, cycleStatusOf, type MemberResult, type SyncVerdict } from './cycle-outcome.js';
import { isShuttingDown } from '../lifecycle.js';
import { boundedJson } from '../util/bounded-read.js';
import { col, asFilter } from '../db/mongo.js';
import { deliverChangeNotes } from './change-notes.js';
import { recordSyncResult, type SyncSchemaRecording } from './history.js';
import { mergeSummaries, NOTHING_RECORDED, type RecordedSummary } from './arrival-recording.js';
import type { SyncHeldSpace, SyncDeclinedSpace } from './history.js';
import { log, peerText } from '../util/log.js';
import { emptyExchange, exchangeSpacesWithMember, type MemberExchange } from './space-exchange.js';
import { liftDeclinesFromAnnounce } from './space-exchange-set.js';
import { takeServedRounds } from './served-rounds.js';
import { adoptAnnouncedSpaces, announcedSpaces, healAnnouncedAliases } from '../networks/network-spaces.js';
import { selfRecordFor } from '../networks/self-record.js';
import { mergePeerRoster, revokeRemoved, pairIntroduced } from '../networks/member-introductions.js';
import { peerSafeFetch, isPeerUrlAllowed } from './peer-fetch.js';
import { settleRounds } from '../networks/round-conclusion.js';
import { createCoalescingRunner } from './coalescing-runner.js';
import { warnOnce } from '../util/warn-once.js';
import { SKIP_WARNING_WINDOW_MS } from '../util/single-flight.js';
import { syncCyclesTotal, syncDurationSeconds } from '../metrics/registry.js';
import type {
  NetworkConfig,
  NetworkMember,
  FactDoc,
  EntityDoc,
  EdgeDoc,
  ChronoEntry,
} from '../config/types.js';
import { pinMemberSigningKey, castForWire } from '../util/signing.js';
import { assertPeerAtFloor } from './peer-floor.js';
import { roundCastsStillPropagate, pruneExpiredRounds } from './vote-round-retention.js';
import { spaceCollection } from '../db/space-collection.js';
import { stampLastSync } from './member-status.js';

// Every outbound fetch's budget, and the longer one for batch payloads — in their own module because the
// receiver's hold deadline is derived from the batch one (`db/write-bound.ts`).
import { FETCH_TIMEOUT_MS, BATCH_FETCH_TIMEOUT_MS } from './peer-timeouts.js';

/**
 * A refused members or votes pull, said once per (route, network, member, status) and window, not per cycle: the peer may list this
 * instance only after a join vote passes, or on one side only, and both routes now refuse a caller without standing (Q-454).
 */
const refusedGovernancePull = warnOnce<string>({ max: 500, every: SKIP_WARNING_WINDOW_MS });

// ── Space ID resolution ────────────────────────────────────────────────────
// Moved to ./space-map.ts (pure). Re-exported so existing importers are unaffected.

export { remoteToLocal, localToRemote } from './space-map.js';

// ── Cron scheduler ─────────────────────────────────────────────────────────
// Moved to ./scheduler.ts, on the god-file gate's own instruction: "put the new behaviour beside it rather than
// inside it."
//
// NOT re-exported from here, unlike `space-map.ts`. The scheduler calls `runSyncForNetwork`, so a re-export
// would make engine and scheduler import each other — a real runtime cycle, which `no-runtime-import-cycles`
// caught immediately. The four importers name the new module directly instead: that is four one-line changes
// against a cycle that would have been load-order-dependent and intermittent.

// ── Per-network sync ────────────────────────────────────────────────────────
// A member's failure counters, PEER UNREACHABLE and the local-fault streak are moved by the one classifier both doors use (`sync/cycle-outcome.ts`).

// ── Per-network sync dedup lock ─────────────────────────────────────────────
// Prevents concurrent sync cycles for the same network from competing for
// bcrypt cache, MongoDB connections, and peer HTTP sockets.  When a trigger
// arrives while a cycle is in-flight, we set a "rerun requested" flag so the
// running cycle fires one more round after completion.
// The coalescing + rerun-once behaviour lives in ./coalescing-runner.ts, where the job is a
// parameter and can therefore be counted by a test. It could not be verified while inlined here:
// `runSyncForNetwork` is async, so the in-flight promise it returns is never referentially equal to
// the one it holds, and a members-less cycle resolves in microtasks, so a queued rerun starts and
// finishes before any caller resumes.
const _syncRunner = createCoalescingRunner<NetworkCycleResult>({
  onQueued: (id) => log.debug(`Sync cycle already running for network ${peerText(id)} — queuing rerun`),
  onRerun: (id) => log.debug(`Rerun requested for network ${peerText(id)} — starting`),
});

/** True while a sync cycle for the given network is in-flight. Cheap, in-memory —
 *  used by GET /api/spaces to show a "syncing" status on a space's network chip. */
export function isNetworkSyncing(networkId: string): boolean {
  return _syncRunner.isRunning(networkId);
}

/** Run a full sync cycle for a network: iterate members and sync each space.
 *
 *  Concurrent triggers for the same network join the running cycle rather than starting another, and
 *  schedule exactly one follow-up. Resolves with the result of the cycle the caller JOINED, not of
 *  any rerun. */
export async function runSyncForNetwork(networkId: string): Promise<NetworkCycleResult> {
  return _syncRunner.run(networkId, () => inCycle(() => _runSyncForNetworkImpl(networkId)));
}

let cyclesInFlight = 0;
/** Sync cycles running now, network and single-peer alike: the quiescence a test or a shutdown waits for. */
export function syncCyclesInFlight(): number { return cyclesInFlight; }
async function inCycle<T>(run: () => Promise<T>): Promise<T> {
  cyclesInFlight++;
  try { return await run(); } finally { cyclesInFlight--; }
}

async function _runSyncForNetworkImpl(networkId: string): Promise<NetworkCycleResult> {
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  if (!net) throw new Error(`Network ${networkId} not found`);

  const triggeredAt = new Date().toISOString();
  // What the cycle's pulls stored against the local schemas' rules, per space across every member (`sync/arrival-recording.ts`, R6-9).
  const recordedBySpace = new Map<string, RecordedSummary>();
  // Spaces not exchanged and why, per space across every member: a hold or a decline is not a failure (W9, X10).
  const heldBySpace = new Map<string, SyncHeldSpace>(); const declinedBySpace = new Map<string, SyncDeclinedSpace>();

  log.info(`Starting sync cycle for network '${peerText(net.label)}' (${net.members.length} members)`);
  // Every member's turn is read by the one classifier both doors use (`sync/cycle-outcome.ts`): its outcome, its counters, the cycle's tally.
  const cycle = new CycleOutcome();
  const syncTimer = syncDurationSeconds.startTimer({ network: networkId });

  for (const member of net.members) {
    // Shutdown began, or this instance's store stopped answering: the rest are not attempted, and no counter moves for them (bundle-39 D5, v6 S6).
    const stop = cycle.stopped();
    if (stop) { cycle.skip(net, member, stop); continue; }
    let counts: MemberExchange;
    try { counts = await runSyncForMember(net, member); } catch (err) { cycle.member(net, member, { thrown: err }); continue; }
    for (const r of counts.recorded) recordedBySpace.set(r.spaceId, mergeSummaries(recordedBySpace.get(r.spaceId) ?? NOTHING_RECORDED, r));
    for (const h of counts.held) (heldBySpace.get(h.spaceId) ?? heldBySpace.set(h.spaceId, { spaceId: h.spaceId, members: [], reason: h.reason, ...(h.families ? { families: h.families } : {}) }).get(h.spaceId)!).members.push(member.instanceId);
    for (const d of counts.declined) (declinedBySpace.get(d) ?? declinedBySpace.set(d, { spaceId: d, members: [] }).get(d)!).members.push(member.instanceId);
    const { outcome } = cycle.member(net, member, counts);
    if (outcome !== 'success' && outcome !== 'catching-up' && outcome !== 'records-refused') continue;
    // If any members were temporarily re-parented away from this peer while it was
    // offline, now is the right moment to surface the choice to the admin.
    const reparentedChildren = net.members.filter(
      m => m.originalParentInstanceId === member.instanceId,
    );
    for (const rc of reparentedChildren) {
      log.warn(
        `REPARENT_REVERT_AVAILABLE: original parent '${peerText(member.label)}' is back online. ` +
        `'${peerText(rc.label)}' (${peerText(rc.instanceId)}) was temporarily re-parented during the outage. ` +
        `To restore original topology: POST /api/networks/${peerText(net.id)}/members/${peerText(rc.instanceId)}/revert-parent. ` +
        `To make the adoption permanent:  POST /api/networks/${peerText(net.id)}/members/${peerText(rc.instanceId)}/adopt.`,
      );
    }
  }
  const { synced, errors, members, pulled, pushed, errorMessages } = cycle;

  // Q-135: pair with every club member a peer introduced this cycle (or earlier, and not yet paired). Never throws.
  if (!isShuttingDown()) await pairIntroduced(networkId);

  log.info(`Sync cycle complete for '${peerText(net.label)}': ${synced} ok, ${errors} errors`);
  syncTimer();

  // One verdict, from the members' outcomes (`syncVerdict`): the metric, the history and every door read the same word.
  const verdict = cycle.verdict();
  const status = cycleStatusOf(verdict);
  syncCyclesTotal.inc({ network: networkId, status });
  cycle.countItems();

  // Persist sync history
  recordSyncResult({
    networkId,
    triggeredAt,
    completedAt: new Date().toISOString(),
    status,
    pulled,
    pushed,
    ...(errorMessages.length > 0 ? { errors: errorMessages } : {}),
    // Per space, in names and counts: what the pulled pages stored that the local schema does not accept (R6-9). Absent when nothing was.
    ...(recordedBySpace.size > 0 ? { schemaViolations: [...recordedBySpace].map(([spaceId, r]): SyncSchemaRecording => ({ spaceId, records: r.records, top: r.top })) } : {}),
    ...(heldBySpace.size > 0 ? { held: [...heldBySpace.values()] } : {}),
    ...(declinedBySpace.size > 0 ? { declined: [...declinedBySpace.values()] } : {}),
  }).catch(err => log.error(`Failed to record sync history: ${peerText(err)}`));

  // ── Orphan detection (braintree only) ──────────────────────────────────
  // After the sync loop finishes, check if any member's parentInstanceId points to
  // a node that no longer exists in the member list.  This catches silent departures
  // where the N-7 notify was never received.
  if (net.type === 'braintree') {
    const freshCfg = getConfig();
    const freshNet = freshCfg.networks.find(n => n.id === networkId);
    if (freshNet) {
      const memberIds = new Set(freshNet.members.map(m => m.instanceId));
      memberIds.add(freshCfg.instanceId);  // current node is never in its own member list
      const orphans = freshNet.members.filter(
        m => m.parentInstanceId && !memberIds.has(m.parentInstanceId),
      );
      if (orphans.length > 0) {
        let changed = false;
        const me = freshNet.members.find(m => m.instanceId === freshCfg.instanceId);
        for (const orphan of orphans) {
          log.warn(
            `ORPHAN DETECTED: '${peerText(orphan.label)}' (${peerText(orphan.instanceId)}) in '${peerText(freshNet.label)}' ` +
            `has parentInstanceId '${peerText(orphan.parentInstanceId)}' which is not in the member list. ` +
            `Auto-adopting as direct child of this instance.`,
          );
          orphan.parentInstanceId = freshCfg.instanceId;
          if (me) {
            me.children = me.children ?? [];
            if (!me.children.includes(orphan.instanceId)) me.children.push(orphan.instanceId);
          }
          changed = true;
        }
        if (changed) saveConfig(freshCfg);
      }
    }
  }

  // ── Prune expired vote rounds ───────────────────────────────────────────
  // A round that has concluded is kept until its deadline has passed (a concluding cast
  // may still have to reach a peer), then dropped here once per cycle, after its outcome
  // is recorded in the network's log. The expiry job (`networks/round-expiry.ts`) does
  // the same every minute, and concludes the rounds nobody touched, so this is the
  // backstop for an instance whose job has not ticked yet and not the way a round ends.
  {
    const freshCfg = getConfig();
    const freshNet = freshCfg.networks.find(n => n.id === networkId);
    if (freshNet) {
      const removed = pruneExpiredRounds(freshNet);
      if (removed > 0) {
        log.info(`Pruned ${removed} concluded+expired vote round(s) from network '${peerText(freshNet.label)}'`);
        saveConfig(freshCfg);
      }
    }
  }

  return { synced, errors, members, outcome: verdict.outcome };
}

/**
 * Trigger a sync cycle for a single peer across every network it appears in.
 * `peerId` must be an exact instanceId match from the registered member list —
 * it is never used as a URL (SSRF guard, SEC-16).
 * Returns how many network/member pairs were synced, errored (failed or this instance's fault) and too old, each pair's outcome by the
 * classifier the scheduled cycle uses (bundle-39 D1), and the verdict over them. No history row and no cycle metric: it is no network's cycle.
 */
export async function runSyncForPeer(peerId: string): Promise<PeerCycleResult> {
  const cfg = getConfig();
  const matches: Array<{ net: typeof cfg.networks[number]; member: typeof cfg.networks[number]['members'][number] }> = [];

  for (const net of cfg.networks) {
    const member = net.members.find(m => m.instanceId === peerId);
    if (member) matches.push({ net, member });
  }

  if (matches.length === 0) return { networksSynced: 0, errors: 0, refused: 0, notFound: true, members: [], outcome: 'success' };

  const cycle = new CycleOutcome();
  await inCycle(async () => {
    for (const { net, member } of matches) {
      const stop = cycle.stopped();
      if (stop) { cycle.skip(net, member, stop); continue; }
      try { cycle.member(net, member, await runSyncForMember(net, member)); } catch (err) { cycle.member(net, member, { thrown: err }); }
    }
  });
  const refused = cycle.members.filter(m => m.outcome === 'peer-too-old').length;
  return { networksSynced: cycle.synced, errors: cycle.errors, refused, notFound: false, members: cycle.members, outcome: cycle.verdict().outcome };
}

/** What a network cycle answers: the members synced and errored, each member's outcome, and the cycle's verdict word (`syncVerdict`). */
export type NetworkCycleResult = { synced: number; errors: number; members: MemberResult[]; outcome: SyncVerdict['outcome'] };
/** What a single-peer sync answers: the same, over every network the peer is a member of. */
export type PeerCycleResult = {
  networksSynced: number; errors: number; refused: number; notFound: boolean; members: MemberResult[]; outcome: SyncVerdict['outcome'];
};

/** Sync a single member across all network spaces. */
async function runSyncForMember(
  net: NetworkConfig,
  member: NetworkMember,
): Promise<MemberExchange> {
  // `incomplete`, one entry per space and direction, makes the member's sync a failure in the cycle's accounting (`Q-48`); a HELD
  // or DECLINED space is not in it (W9, X10).
  const peerToken = getSecrets().peerTokens[member.instanceId];
  if (!peerToken) {
    log.warn(`No peer token for ${peerText(member.label)} (${peerText(member.instanceId)}) — skipping sync`);
    // This instance's own configuration, not the peer's failure (v6 S10): a local fault, and the peer was not asked.
    return { ...emptyExchange(), localFaults: [REASONS['no-token']] };
  }

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${peerToken}`,
    'Content-Type': 'application/json',
  };

  // Build fresh RequestInit per call so each fetch gets its own AbortSignal.
  // Sharing one AbortSignal.timeout() across sequential fetches starves later
  // requests because the timer starts at creation time, not at fetch time.
  const fetchOpts = (): RequestInit => ({ headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const batchFetchOpts = (): RequestInit => ({ headers, signal: AbortSignal.timeout(BATCH_FETCH_TIMEOUT_MS) });

  // ── Presync warm-up ────────────────────────────────────────────────────
  // Ask the peer to eagerly warm its embedding model, bcrypt token cache,
  // and MongoDB collection handles BEFORE we start the real sync cycle.
  // The peer's POST /api/sync/warm returns only once everything is ready.
  // In parallel, warm our own local MongoDB collections. Neither it nor governance starts once shutdown has (bundle-39 D5).
  if (!isShuttingDown()) {
    const peerWarm = peerSafeFetch(`${member.url}/api/sync/warm`, {
      ...fetchOpts(),
      method: 'POST',
      // The network's ids (Q-133): the peer maps them to its own spaces; a local name would warm nothing there.
      body: JSON.stringify({ networkId: net.id, spaces: announcedSpaces(net) }),
    }).then(r => r.body?.cancel()).catch(() => {});

    const localWarm = Promise.all(
      net.spaces.flatMap(sid => [
        col<FactDoc>(spaceCollection(sid, 'facts'))
          .findOne(asFilter({}), { projection: { _id: 1 } })
          .catch(() => {}),
        col<EntityDoc>(spaceCollection(sid, 'entities'))
          .findOne(asFilter({}), { projection: { _id: 1 } })
          .catch(() => {}),
        col<EdgeDoc>(spaceCollection(sid, 'edges'))
          .findOne(asFilter({}), { projection: { _id: 1 } })
          .catch(() => {}),
        col<ChronoEntry>(spaceCollection(sid, 'chrono'))
          .findOne(asFilter({}), { projection: { _id: 1 } })
          .catch(() => {}),
      ]),
    );

    await Promise.all([peerWarm, localWarm]);
  }

  // ── Governance gossip + vote propagation (BEFORE data sync) ───────────────
  // 1. Push our own self-record to this peer so it stays current on our URL/label.
  // 2. Pull the peer's view of the member list; update our local records.
  // 3. Push our open vote casts to the peer.
  // 4. Pull the peer's open rounds and votes; merge any new rounds or casts.
  //
  // This runs FIRST — ahead of the per-space data/file loop — on purpose.
  // Governance is deadline-sensitive (vote rounds expire) and its messages are
  // small, so it must converge promptly and independently of the data plane.
  // Previously it ran last, which meant any failure in the per-space loop (a
  // timed-out pull, an unreachable member, a slow file transfer) threw out of
  // this function and skipped governance for the whole cycle — so under load a
  // saturated peer could starve vote propagation indefinitely. Both calls are
  // internally best-effort (they catch their own errors); the extra guard here
  // keeps a data-plane failure below from ever masking governance progress.
  try {
    if (!isShuttingDown()) await gossipWithPeer(net, member, fetchOpts);
    if (!isShuttingDown()) await propagateVotesWithPeer(net, member, fetchOpts);
    if (!isShuttingDown()) await deliverChangeNotes(net, member, fetchOpts); // F-42: only to a member below us; never throws, undelivered stays queued
  } catch (err) {
    log.warn(`Governance gossip with ${peerText(member.label)} (${peerText(member.instanceId)}): ${peerText(err)}`);
  }

  /*
   * THE OUTBOUND HALF OF THE PEER FLOOR (`P-33` = B), and it must stay BELOW the gossip above.
   * Gossip is the only thing that learns a version, so checking first deadlocks: every member on a
   * fresh network reports nothing, absent is below the floor, and the exchange that would clear it
   * sits behind the refusal. Governance is deliberately not gated — see `sync/peer-floor.ts`.
   */
  assertPeerAtFloor(net.id, member.instanceId, member.version);

  // The per-space turns, the hold that chooses them and the marks they write: `sync/space-exchange.ts`.
  const exchanged = await exchangeSpacesWithMember(net, member, headers, fetchOpts, batchFetchOpts);

  // Update lastSyncAt
  const freshCfg = getConfig();
  const freshNet = freshCfg.networks.find(n => n.id === net.id);
  const m = freshNet?.members.find(m => m.instanceId === member.instanceId);
  // Hot-path bookkeeping: a cosmetic timestamp written every member every cycle.
  if (m) { stampLastSync(m); saveConfigSoon(freshCfg); }

  return exchanged;
}

// ── Gossip: member list exchange ────────────────────────────────────────────
/**
 *  1. POST our self-record to the peer (so the peer knows our current URL/label).
 *  2. GET the peer's member list view; merge any updated records into our own config.
 *
 * Failures are non-fatal — gossip is best-effort and logged at warn level.
 */
async function gossipWithPeer(
  net: NetworkConfig,
  member: NetworkMember,
  opts: () => RequestInit,
): Promise<void> {
  const cfg = getConfig();
  const base = `${member.url}/api/sync/networks/${encodeURIComponent(net.id)}`;

  // 1. Push self-record to peer
  try {
    // ONE builder for both directions of the exchange (`networks/self-record.ts`): a field on only one of them means
    // a peer learns it when it calls us and never when we call it.
    const selfRecord = selfRecordFor(cfg, net, member);
    const resp = await peerSafeFetch(`${base}/members`, {
      ...opts(),
      method: 'POST',
      body: JSON.stringify(selfRecord),
    });
    if (resp.ok) {
      // Peer may piggyback its own self-record in the response so we can update our entry for it
      try {
        const body = await boundedJson<{ status: string; self?: Partial<NetworkMember> & { signingKeyRotation?: import('../util/signing.js').SigningKeyRotation } }>(resp, 'sync peer');
        const peerSelf = body.self;
        if (peerSelf?.instanceId === member.instanceId) {
          // Q-133: heal a missing alias BEFORE adoption, or the network id would be adopted as a second space. It
          // swallows and logs its own failure, so a bad heal cannot skip the member-record update below.
          const announced = peerSelf as { spaces?: unknown; spaceNames?: unknown };
          await healAnnouncedAliases(net.id, member.instanceId, announced.spaces, announced.spaceNames);
          await adoptAnnouncedSpaces(net.id, member.instanceId, announced.spaces);
          const freshCfg = getConfig();
          const freshNet = freshCfg.networks.find(n => n.id === net.id);
          if (freshNet) {
            const local = freshNet.members.find(m => m.instanceId === member.instanceId);
            if (local) {
              let changed = false;
              if (peerSelf.url && peerSelf.url !== local.url) {
                if (isPeerUrlAllowed(peerSelf.url)) { local.url = peerSelf.url; changed = true; }
                else log.warn(`Gossip: rejected unsafe self-URL from ${peerText(member.label)} (${peerText(member.instanceId)}): ${peerText(peerSelf.url)}`);
              }
              if (peerSelf.label && peerSelf.label !== local.label) { local.label = peerSelf.label; changed = true; }
              /*
               * The floor's two inputs, arriving by the other direction of the exchange. Without them
               * a version is only ever learned from a peer that dials US, so a leaf that only dials
               * out would stay versionless for ever.
               *
               * `versionCheckedAt` IS STAMPED WHETHER OR NOT A VERSION CAME BACK, and that is the
               * whole point of it: a peer that answered and named no version is a pre-4.0 peer, which
               * is evidence. A peer we have never exchanged with is not. Only the stamp tells those
               * apart, and conflating them stopped every asymmetric network's data plane.
               */
              if (peerSelf.version && peerSelf.version !== local.version) { local.version = peerSelf.version; changed = true; }
              /*
               * STAMPED ONCE, not every round — and the first draft stamped unconditionally, which is a
               * defect rather than noise. `changed` drives `saveConfig`, a full atomic rewrite of
               * config.json that also replaces the in-memory copy; forcing it on every member of every
               * cycle turned an idle network into a continuous write loop and let a stale snapshot
               * overwrite a concurrent change. CI found it as four peer-revocation tests timing out.
               *
               * Writing it once is also what it MEANS. The question this answers is 'have we ever
               * completed an exchange with this peer' — a boolean wearing a timestamp — so refreshing
               * it adds nothing a reader can use and costs a write per member per cycle.
               */
              if (!local.versionCheckedAt) { local.versionCheckedAt = new Date().toISOString(); changed = true; }
              if (pinMemberSigningKey(local, peerSelf.signingPublicKey, peerSelf.signingKeyRotation)) changed = true;
              if (liftDeclinesFromAnnounce(freshNet, member.instanceId, announced.spaces)) changed = true; // AM2: announced again, asked again
              if (changed) {
                log.info(`Gossip: updated ${peerText(member.label)} via self-piggyback (${peerText(net.id)})`);
                saveConfig(freshCfg);
              }
            }
          }
        }
      } catch { /* ignore JSON parse failures */ }
    } else {
      log.warn(`Gossip self-push to ${peerText(member.label)}: HTTP ${resp.status}`);
    }
  } catch (err) {
    log.warn(`Gossip self-push to ${peerText(member.label)}: ${peerText(err)}`);
  }

  // 2. Pull peer's member view and merge into our config
  try {
    const resp = await peerSafeFetch(`${base}/members`, opts());
    if (!resp.ok) {
      refusedGovernancePull(`members ${net.id} ${member.instanceId} ${resp.status}`, () => log.warn(`Gossip pull from ${peerText(member.label)} for network ${peerText(net.id)}: HTTP ${resp.status}`));
      return;
    }
    const { members: peerView, removed: peerRemoved } = await boundedJson<{ members: Partial<NetworkMember>[]; removed?: unknown }>(resp, 'sync peer');
    if (!Array.isArray(peerView)) return;

    const fresh = getConfig();
    const freshNet = fresh.networks.find(n => n.id === net.id);
    if (!freshNet) return;

    let changed = false;
    for (const peerRecord of peerView) {
      if (!peerRecord.instanceId) continue;
      // Never update our own record from gossip (poisoning protection on our side)
      if (peerRecord.instanceId === fresh.instanceId) continue;
      const local = freshNet.members.find(m => m.instanceId === peerRecord.instanceId);
      if (!local) continue; // unknown member — do not auto-add
      // Merge: only update mutable identity fields (url, label, children)
      let updated = false;
      if (peerRecord.url && peerRecord.url !== local.url && isPeerUrlAllowed(peerRecord.url)) {
        local.url = peerRecord.url;
        updated = true;
      }
      if (peerRecord.label && peerRecord.label !== local.label) {
        local.label = peerRecord.label;
        updated = true;
      }
      if (peerRecord.children !== undefined &&
          JSON.stringify(peerRecord.children) !== JSON.stringify(local.children)) {
        local.children = peerRecord.children;
        updated = true;
      }
      if (pinMemberSigningKey(local, peerRecord.signingPublicKey)) updated = true;
      if (updated) {
        log.info(`Gossip: updated member ${peerText(local.label)} (${peerText(local.instanceId)}) in network ${peerText(net.id)}`);
        changed = true;
      }
    }
    // Q-135: on a club the loop above ignores an unknown member, and this is where it is not ignored — it becomes
    // an introduction to pair with, and the peer's removals are applied here too.
    const merged = mergePeerRoster(freshNet, fresh.instanceId, member.instanceId, peerView, peerRemoved);
    if (changed || merged.changed) saveConfig(fresh);
    revokeRemoved(merged.removed);
  } catch (err) {
    log.warn(`Gossip pull from ${peerText(member.label)}: ${peerText(err)}`);
  }
}

// ── Vote propagation via gossip ───────────────────────────────────────────────

/**
 * Propagate vote rounds and casts with a single peer:
 *  1. PUSH our locally known vote casts to the peer (for rounds that already exist on both sides).
 *  2. PULL the peer's open rounds; create any we don't have locally, merge new vote casts.
 *
 * Failures are non-fatal — gossip is best-effort.
 */
async function propagateVotesWithPeer(
  net: NetworkConfig,
  member: NetworkMember,
  opts: () => RequestInit,
): Promise<void> {
  const base = `${member.url}/api/sync/networks/${encodeURIComponent(net.id)}`;

  // Pull the peer's rounds FIRST, then push ours (the push block below explains why the
  // order matters). Adopting and persisting the peer's vote casts is the convergence-
  // critical step, so it must not be gated behind our push. The early `return`s in this
  // block bail out only when the peer is unreachable / misbehaving or our network is gone
  // — exactly the cases where the push below would be pointless anyway.
  //
  // Pull peer's open rounds; create new ones locally and merge vote casts
  try {
    const resp = await peerSafeFetch(`${base}/votes`, opts());
    if (!resp.ok) {
      refusedGovernancePull(`votes ${net.id} ${member.instanceId} ${resp.status}`, () => log.warn(`Vote pull from ${peerText(member.label)} for network ${peerText(net.id)}: HTTP ${resp.status}`));
      return;
    }
    // Unread: every served round is read by its declared shape where it is taken (`sync/served-rounds.ts`, X11).
    const { rounds: peerRounds } = await boundedJson<{ rounds?: unknown }>(resp, 'sync peer');
    if (!Array.isArray(peerRounds)) return;

    const fresh = getConfig();
    const freshNet = fresh.networks.find(n => n.id === net.id);
    if (!freshNet) return;

    // One reading of the clock for the whole pass: what is adopted, merged into and concluded is judged at the same instant.
    const now = Date.now();
    // Evidence, adoptions and merged casts: what this list changes here (`sync/served-rounds.ts`).
    const { changed, refused } = takeServedRounds(freshNet, peerRounds, member, now);

    if (refused.size > 0) {
      log.debug(`Vote gossip: did not adopt ${peerText([...refused].map(([why, n]) => `${n} round(s) ${why}`).join(', '))} from ${peerText(member.label)}`);
    }

    if (changed) {
      // Re-evaluate every undecided round — new votes may carry one — and apply what concluded, through the one settle step (design
      // v5 section 1.1). Every held round is handed to the space-scoped step too, so an addition that did not land is tried again. The
      // pass does NOT await the acts it starts (VR6): the hold keeps their spaces out of this cycle's exchange while they run.
      const settled = settleRounds(freshNet, fresh, freshNet.pendingRounds, 'gossip', now, freshNet.pendingRounds);
      void settled.settled;
      saveConfig(fresh);
    }
  } catch (err) {
    log.warn(`Vote pull from ${peerText(member.label)}: ${peerText(err)}`);
  }

  // Push our votes to the peer (non-fatal 404 if the peer doesn't have the round yet).
  //
  // This runs AFTER the pull on purpose. It re-sends every cast of every locally-known
  // round, and a round is never removed from `pendingRounds` once it concludes, so on an
  // instance with a long governance history this loop grows without bound. Running it
  // before the pull would let a peer spend an entire sync cycle pushing dead history and
  // never reach the pull — stalling vote propagation under load. Pulling first makes
  // convergence independent of how much history we have to broadcast.
  //
  // We still push open rounds and recently-concluded ones (a concluding cast must reach
  // peers that haven't concluded yet), but skip any round already concluded AND past its
  // deadline: every peer concludes such a round independently once the deadline passes, so
  // re-pushing it every cycle forever is pure waste.
  try {
    const cfg = getConfig();
    const localNet = cfg.networks.find(n => n.id === net.id);
    const now = Date.now();
    const roundsToPush = (localNet?.pendingRounds ?? []).filter(r => roundCastsStillPropagate(r, now));
    for (const round of roundsToPush) {
      for (const cast of round.votes) {
        await peerSafeFetch(`${base}/votes/${encodeURIComponent(round.roundId)}`, {
          ...opts(),
          method: 'POST',
          // Forward the signature (and castAt) so the peer can verify and, when
          // valid, relay this cast onward — signed casts are relay-safe.
          // Both signatures travel (Q-138): the one shape the relay route reads back.
          body: JSON.stringify(castForWire(cast)),
        }).catch(err => log.warn(`Vote push (${peerText(round.roundId)}) to ${peerText(member.label)}: ${peerText(err)}`));
      }
    }
  } catch (err) {
    log.warn(`Vote push to ${peerText(member.label)}: ${peerText(err)}`);
  }
}


