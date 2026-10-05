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

import { getConfig, saveConfig, saveConfigSoon, getSecrets, getFaceRecognitionConfig } from '../config/loader.js';
import { BRAIN_COLLECTIONS, type LinkDoc } from '../config/types.js';
import { fileMetaForWire } from '../api/sync/_shared.js';
import { boundedJson } from '../util/bounded-read.js';
import { reportPushRefusals, refusedTransfers } from './push-refusals.js';
import { deliverChangeNotes } from './change-notes.js';
import { col, asFilter } from '../db/mongo.js';
import { recordSyncResult, type SyncCounts } from './history.js';
import { log, logSafe } from '../util/log.js';
import { caughtFailureText } from '../brain/store-failure.js';
import { resolveWatermark, truncationWarn, type TransferOutcome } from './watermark.js';
import { pullTombstones, pushTombstones } from './tombstone-transfer.js';
import { TombstoneCounterError } from './tombstone-apply.js';
import { applyConcludedSpaceRounds } from '../spaces/apply-wipe-round.js';
import { bumpSeq, settledSeqRange } from '../util/seq.js';
import { adoptAnnouncedSpaces, announcedSpaces, healAnnouncedAliases } from '../networks/network-spaces.js';
import { selfRecordFor } from '../networks/self-record.js';
import { pullSpaceMetaFromUpstream } from './space-meta-pull.js';
import { peerSafeFetch, isPeerUrlAllowed } from './peer-fetch.js';
import { concludeRoundIfReady, sendMemberRemovedNotify, isRoundPrunable, pruneExpiredRounds } from './governance.js';
import { admitPassedJoin } from '../networks/admit-passed-join.js';
import { adoptPeerRound } from '../networks/round-local-state.js';
import { enqueueMediaJob } from '../files/media/job-queue.js';
import { resolveInputFormat } from '../files/converters/pipeline.js';
import { mimeTypeForPath } from '../files/mime.js';
import { createCoalescingRunner } from './coalescing-runner.js';
import { writeArrivals, arrivalId, type ArrivalOutcome } from './arrivals.js';
import { syncFiles } from './file-sync.js';
import {
  syncCyclesTotal,
  syncItemsPulledTotal,
  syncItemsPushedTotal,
  syncDurationSeconds,
} from '../metrics/registry.js';
import type {
  NetworkConfig,
  NetworkMember,
  FactDoc,
  EntityDoc,
  EdgeDoc,
  ChronoEntry,
  VoteRound,
  VoteCast,
} from '../config/types.js';
import { resolveSafePath } from '../files/sandbox.js';
import type { FileMetaDoc } from '../config/types.js';
import { acceptVoteCast, pinMemberSigningKey, castForWire } from '../util/signing.js';
import { assertPeerAtFloor } from './peer-floor.js';
import { REPLICATED_FAMILIES, RECORD_TYPE_OF, type PayloadKey, type ReplicatedFamily } from './replicated-families.js';
import { spaceCollection } from '../db/space-collection.js';

// Timeout for every outbound fetch to a peer.
// Without this, the OS TCP timeout (~75 s on Linux) applies, which means one
// offline peer can block an entire sync cycle by that duration per attempt.
const FETCH_TIMEOUT_MS = 10_000;

// Longer timeout for batch push/pull payloads: 200 docs × a few KB each can be
// several hundred KB over a slow WAN link.
const BATCH_FETCH_TIMEOUT_MS = 60_000;

// Docs pushed per batch-upsert request (caps per-request payload size).
const PUSH_BATCH_SIZE = 200;

// After this many consecutive sync failures for a single member, we emit a
// prominent warning. The member is NOT auto-removed — that is a human decision.
const STALE_FAILURE_THRESHOLD = 10;

// ── Space ID resolution ────────────────────────────────────────────────────
// Moved to ./space-map.ts (pure). Re-exported so existing importers are unaffected.

export { remoteToLocal, localToRemote } from './space-map.js';
import { reverseSpaceMap as reverseSpaceMapOf } from './space-map.js';

// ── Cron scheduler ─────────────────────────────────────────────────────────
// Moved to ./scheduler.ts, on the god-file gate's own instruction: "put the new behaviour beside it rather than
// inside it."
//
// NOT re-exported from here, unlike `space-map.ts`. The scheduler calls `runSyncForNetwork`, so a re-export
// would make engine and scheduler import each other — a real runtime cycle, which `no-runtime-import-cycles`
// caught immediately. The four importers name the new module directly instead: that is four one-line changes
// against a cycle that would have been load-order-dependent and intermittent.

// ── Per-network sync ────────────────────────────────────────────────────────

/** Set or increment the consecutive failure counter for a member and persist it.
 *  Pass `'increment'` to add 1 and return the new count; pass a number to set
 *  the counter to that value (use 0 to reset on success). */
function _setFailureCount(networkId: string, instanceId: string, value: number | 'increment'): number {
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  const member = net?.members.find(m => m.instanceId === instanceId);
  if (!member) return typeof value === 'number' ? value : 1;
  const newValue = value === 'increment' ? (member.consecutiveFailures ?? 0) + 1 : value;
  member.consecutiveFailures = newValue;
  // Hot-path bookkeeping: written for every member every cycle. Coalesced async
  // write — a lost counter on crash is cosmetic (it re-derives on the next cycle).
  saveConfigSoon(cfg);
  return newValue;
}

// Vote-round retention (`isRoundPrunable`, `pruneExpiredRounds`) lives with round conclusion in `governance.ts`.

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
const _syncRunner = createCoalescingRunner<{ synced: number; errors: number }>({
  onQueued: (id) => log.debug(`Sync cycle already running for network ${logSafe(id)} — queuing rerun`),
  onRerun: (id) => log.debug(`Rerun requested for network ${logSafe(id)} — starting`),
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
export async function runSyncForNetwork(networkId: string): Promise<{ synced: number; errors: number }> {
  return _syncRunner.run(networkId, () => _runSyncForNetworkImpl(networkId));
}

async function _runSyncForNetworkImpl(networkId: string): Promise<{ synced: number; errors: number }> {
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  if (!net) throw new Error(`Network ${networkId} not found`);

  const triggeredAt = new Date().toISOString();
  const pulled: SyncCounts = { facts: 0, entities: 0, edges: 0, files: 0, chrono: 0, links: 0 };
  const pushed: SyncCounts = { facts: 0, entities: 0, edges: 0, files: 0, chrono: 0, links: 0 };
  const errorMessages: string[] = [];

  log.info(`Starting sync cycle for network '${logSafe(net.label)}' (${net.members.length} members)`);
  let synced = 0; let errors = 0; let refusals = 0;
  const syncTimer = syncDurationSeconds.startTimer({ network: networkId });

  for (const member of net.members) {
    try {
      const counts = await runSyncForMember(net, member);
      // Every family, links included: a hand-written list of five here never summed links into the cycle (Q-59).
      for (const k of Object.keys(pulled) as (keyof SyncCounts)[]) { pulled[k] += counts.pulled[k]; pushed[k] += counts.pushed[k]; }
      // A member whose transfers were refused or cut short moved nothing it was asked to move. Counting it as
      // synced recorded `success` for a network that had transferred nothing since it was created (`Q-48`), so
      // it takes the failure path below: an error for the cycle, a reason in the history, a failure counted.
      if (counts.incomplete.length > 0) throw new Error(`transfer did not complete — ${counts.incomplete.join('; ')}`);
      // Q-59: records the peer answered for and refused make the cycle PARTIAL with the reason, not a failure of the
      // member — it answered, so its failure counter (and the "unreachable" alarm read from it) must not move.
      if (counts.refused.length > 0) { refusals++; errorMessages.push(`${logSafe(member.label)} refused records: ${counts.refused.join('; ')}`); }
      synced++;
      // Reset failure counter on success
      _setFailureCount(net.id, member.instanceId, 0);

      // If any members were temporarily re-parented away from this peer while it was
      // offline, now is the right moment to surface the choice to the admin.
      const reparentedChildren = net.members.filter(
        m => m.originalParentInstanceId === member.instanceId,
      );
      for (const rc of reparentedChildren) {
        log.warn(
          `REPARENT_REVERT_AVAILABLE: original parent '${logSafe(member.label)}' is back online. ` +
          `'${logSafe(rc.label)}' (${logSafe(rc.instanceId)}) was temporarily re-parented during the outage. ` +
          `To restore original topology: POST /api/networks/${logSafe(net.id)}/members/${logSafe(rc.instanceId)}/revert-parent. ` +
          `To make the adoption permanent:  POST /api/networks/${logSafe(net.id)}/members/${logSafe(rc.instanceId)}/adopt.`,
        );
      }
    } catch (err) {
      const errMsg = `Sync failed for member ${logSafe(member.label)} (${logSafe(member.instanceId)}): ${logSafe(caughtFailureText(err, `sync member ${member.instanceId}`))}`;
      log.error(errMsg);
      errorMessages.push(errMsg);
      errors++;
      const failures = _setFailureCount(net.id, member.instanceId, 'increment');
      if (failures === STALE_FAILURE_THRESHOLD) {
        const hasChildren = net.type === 'braintree' && (member.children?.length ?? 0) > 0;
        log.warn(
          `PEER UNREACHABLE: '${logSafe(member.label)}' in network '${logSafe(net.label)}' has failed ` +
          `${logSafe(failures)} consecutive sync cycles. Last success: ${logSafe(member.lastSyncAt ?? 'never')}. ` +
          `Member has NOT been removed — manual action required.` +
          (hasChildren
            ? ` NOTE: this node has ${member.children!.length} child(ren) in a braintree network — its entire subtree is now partitioned from this brain until it comes back online.`
            : ''),
        );
      } else if (failures > STALE_FAILURE_THRESHOLD && failures % 10 === 0) {
        log.warn(`PEER STILL UNREACHABLE: '${logSafe(member.label)}' (${logSafe(failures)} consecutive failures, last success: ${logSafe(member.lastSyncAt ?? 'never')})`);
      }
    }
  }

  log.info(`Sync cycle complete for '${logSafe(net.label)}': ${logSafe(synced)} ok, ${logSafe(errors)} errors`);
  syncTimer();

  // Calculate status once and share between Prometheus and sync history
  const status: 'success' | 'partial' | 'failed' =
    errors === 0 && refusals === 0 ? 'success' : synced === 0 && net.members.length > 0 ? 'failed' : 'partial';

  // Record Prometheus metrics
  syncCyclesTotal.inc({ network: networkId, status });
  // Every knowledge collection, so a new one is counted without an edit. Order is irrelevant here: the
  // body only increments two Prometheus counters.
  for (const type of BRAIN_COLLECTIONS) {
    if (pulled[type] > 0) syncItemsPulledTotal.inc({ type }, pulled[type]);
    if (pushed[type] > 0) syncItemsPushedTotal.inc({ type }, pushed[type]);
  }

  // Persist sync history
  recordSyncResult({
    networkId,
    triggeredAt,
    completedAt: new Date().toISOString(),
    status,
    pulled,
    pushed,
    ...(errorMessages.length > 0 ? { errors: errorMessages } : {}),
  }).catch(err => log.error(`Failed to record sync history: ${logSafe(String(err))}`));

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
            `ORPHAN DETECTED: '${logSafe(orphan.label)}' (${logSafe(orphan.instanceId)}) in '${logSafe(freshNet.label)}' ` +
            `has parentInstanceId '${logSafe(orphan.parentInstanceId)}' which is not in the member list. ` +
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
  // Concluded rounds are never removed by the governance code (concludeRoundIfReady
  // only flips `concluded`), so pendingRounds would otherwise grow for the life of the
  // network. Once a round is concluded AND past its deadline it can influence nothing
  // and needs no further propagation, so drop it here, once per cycle.
  {
    const freshCfg = getConfig();
    const freshNet = freshCfg.networks.find(n => n.id === networkId);
    if (freshNet) {
      const removed = pruneExpiredRounds(freshNet);
      if (removed > 0) {
        log.info(`Pruned ${logSafe(removed)} concluded+expired vote round(s) from network '${logSafe(freshNet.label)}'`);
        saveConfig(freshCfg);
      }
    }
  }

  return { synced, errors };
}

/**
 * Trigger a sync cycle for a single peer across every network it appears in.
 * `peerId` must be an exact instanceId match from the registered member list —
 * it is never used as a URL (SSRF guard, SEC-16).
 * Returns a summary of how many network/member pairs were synced and how many
 * errored.
 */
export async function runSyncForPeer(
  peerId: string,
): Promise<{ networksSynced: number; errors: number; notFound: boolean }> {
  const cfg = getConfig();
  const matches: Array<{ net: typeof cfg.networks[number]; member: typeof cfg.networks[number]['members'][number] }> = [];

  for (const net of cfg.networks) {
    const member = net.members.find(m => m.instanceId === peerId);
    if (member) matches.push({ net, member });
  }

  if (matches.length === 0) return { networksSynced: 0, errors: 0, notFound: true };

  let networksSynced = 0;
  let errors = 0;
  for (const { net, member } of matches) {
    try {
      await runSyncForMember(net, member);
      networksSynced++;
      _setFailureCount(net.id, member.instanceId, 0);
    } catch (err) {
      log.error(`network_sync failed for peer ${logSafe(member.label)} (${logSafe(member.instanceId)}) in network '${logSafe(net.label)}': ${logSafe(String(err))}`);
      errors++;
      _setFailureCount(net.id, member.instanceId, 'increment');
    }
  }
  return { networksSynced, errors, notFound: false };
}

/** Sync a single member across all network spaces. */
async function runSyncForMember(
  net: NetworkConfig,
  member: NetworkMember,
): Promise<{ pulled: SyncCounts; pushed: SyncCounts; incomplete: string[]; refused: string[] }> {
  const pulled: SyncCounts = { facts: 0, entities: 0, edges: 0, files: 0, chrono: 0, links: 0 };
  const pushed: SyncCounts = { facts: 0, entities: 0, edges: 0, files: 0, chrono: 0, links: 0 };
  // What did not complete this cycle, one entry per space and direction. Non-empty makes the member's sync a
  // failure in the cycle's accounting (`Q-48`) — the watermarks were held correctly; what was missing was saying so.
  const incomplete: string[] = []; const refused: string[] = [];
  const secrets = getSecrets();
  const peerToken = secrets.peerTokens[member.instanceId];
  if (!peerToken) {
    log.warn(`No peer token for ${logSafe(member.label)} (${logSafe(member.instanceId)}) — skipping sync`);
    return { pulled, pushed, incomplete: ['no peer token for this member'], refused };
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
  // In parallel, warm our own local MongoDB collections.
  {
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
    await gossipWithPeer(net, member, fetchOpts);
    await propagateVotesWithPeer(net, member, fetchOpts);
    await deliverChangeNotes(net, member, fetchOpts); // F-42: only to a member below us; never throws, undelivered stays queued
  } catch (err) {
    log.warn(`Governance gossip with ${logSafe(member.label)} (${logSafe(member.instanceId)}): ${logSafe(String(err))}`);
  }

  /*
   * THE OUTBOUND HALF OF THE PEER FLOOR (`P-33` = B), and it must stay BELOW the gossip above.
   * Gossip is the only thing that learns a version, so checking first deadlocks: every member on a
   * fresh network reports nothing, absent is below the floor, and the exchange that would clear it
   * sits behind the refusal. Governance is deliberately not gated — see `sync/peer-floor.ts`.
   */
  assertPeerAtFloor(net.id, member.instanceId, member.version);

  // Local -> network id, built once per cycle. FIRST match, as `localToRemote` answers (Q-133): a later key for the
  // same space is an inbound alias a rename left behind, and pulling by it would address the space by a name the
  // network does not use. The inline Map this replaced kept the LAST key, the opposite of the documented rule.
  const toNetworkId = reverseSpaceMapOf(net);

  for (const spaceId of net.spaces) {
    // Peers reference a space by the network's id, which differs from ours once it has been renamed or mapped.
    const remoteSpaceId = toNetworkId.get(spaceId) ?? spaceId;

    // Skip spaces that don't exist in local config — prevents orphan data and collection access
    // for space IDs that were registered on the network but never created locally.
    const cfg = getConfig();
    if (!cfg.spaces.some(s => s.id === spaceId && !s.proxyFor)) {
      log.warn(`Skipping sync for space '${logSafe(spaceId)}' in network '${logSafe(net.label)}': space not in local config`);
      continue;
    }

    // Push to this member if the direction allows it (push or both).
    // Pull from this member if bidirectional (both), or for non-directional networks.
    // Braintree/Pubsub with direction='push': parent/publisher pushes down, child/subscriber never pushes up.
    const isDirectional = net.type === 'braintree' || net.type === 'pubsub';
    const shouldPull = !isDirectional || member.direction === 'both' || member.direction === 'pull';
    const shouldPush = !isDirectional || member.direction === 'both' || member.direction === 'push';

    if (shouldPull) {
      await pullSpaceMetaFromUpstream(net, member, spaceId, remoteSpaceId, fetchOpts); // F-39.1: only from upstream, never throws
      const pc = await pullFromPeer(member, spaceId, remoteSpaceId, net.id, fetchOpts, batchFetchOpts);
      pulled.facts += pc.facts; pulled.entities += pc.entities; pulled.edges += pc.edges; pulled.chrono += pc.chrono; pulled.links += pc.links;
      if (pc.stoppedEarly.length > 0) incomplete.push(`space '${spaceId}' receive: ${pc.stoppedEarly.join(', ')} stopped early`);
    }
    if (shouldPush) {
      const pc = await pushToPeer(member, spaceId, remoteSpaceId, net.id, fetchOpts, batchFetchOpts);
      pushed.facts += pc.facts; pushed.entities += pc.entities; pushed.edges += pc.edges; pushed.chrono += pc.chrono; pushed.links += pc.links;
      if (pc.stoppedEarly.length > 0) incomplete.push(`space '${spaceId}' push: ${pc.stoppedEarly.join(', ')} stopped early`);
      if (pc.refused.length > 0) refused.push(`space '${spaceId}' push: ${pc.refused.join(', ')}`);
    }

    // Sync file manifest — respect direction guards like pull/push above
    if (shouldPull || shouldPush) {
      const fc = await syncFiles(member, spaceId, remoteSpaceId, net.id, headers, fetchOpts, shouldPull, shouldPush);
      pulled.files += fc.pulledFiles; pushed.files += fc.pushedFiles;

      // Re-enqueue newly-pulled image files for face recognition so secondary
      // instances can build their own gallery from synced content.
      // Gated on faceRecognition.enabled && reprocessSyncedImages (default: true).
      if (fc.pulledPaths.length > 0) {
        const faceCfg = getFaceRecognitionConfig();
        if (faceCfg.enabled && faceCfg.reprocessSyncedImages) {
          for (const p of fc.pulledPaths) {
            if (resolveInputFormat(p) === 'image') {
              // Shared table. The inline copy here defaulted to `image/jpeg`, so a synced image whose
              // extension it did not list was mislabelled rather than left unknown.
              enqueueMediaJob(spaceId, p, mimeTypeForPath(p), 'image').catch(err =>
                log.warn(`Face reprocess enqueue for ${logSafe(spaceId)}/${logSafe(p)}:${logSafe(String(err))}`),
              );
            }
          }
        }
      }
    }

    // Merkle integrity check (opt-in: network.merkle === true)
    if (net.merkle) {
      await checkMerkleWithPeer(net, member, spaceId, remoteSpaceId, fetchOpts);
    }
  }

  // Update lastSyncAt
  const freshCfg = getConfig();
  const freshNet = freshCfg.networks.find(n => n.id === net.id);
  const m = freshNet?.members.find(m => m.instanceId === member.instanceId);
  // Hot-path bookkeeping: a cosmetic timestamp written every member every cycle.
  if (m) { m.lastSyncAt = new Date().toISOString(); saveConfigSoon(freshCfg); }

  return { pulled, pushed, incomplete, refused };
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
                else log.warn(`Gossip: rejected unsafe self-URL from ${logSafe(member.label)} (${logSafe(member.instanceId)}): ${logSafe(peerSelf.url)}`);
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
              if (changed) {
                log.info(`Gossip: updated ${logSafe(member.label)} via self-piggyback (${logSafe(net.id)})`);
                saveConfig(freshCfg);
              }
            }
          }
        }
      } catch { /* ignore JSON parse failures */ }
    } else {
      log.warn(`Gossip self-push to ${logSafe(member.label)}: HTTP ${logSafe(resp.status)}`);
    }
  } catch (err) {
    log.warn(`Gossip self-push to ${logSafe(member.label)}: ${logSafe(String(err))}`);
  }

  // 2. Pull peer's member view and merge into our config
  try {
    const resp = await peerSafeFetch(`${base}/members`, opts());
    if (!resp.ok) {
      log.warn(`Gossip pull from ${logSafe(member.label)}: HTTP ${logSafe(resp.status)}`);
      return;
    }
    const { members: peerView } = await boundedJson<{ members: Partial<NetworkMember>[] }>(resp, 'sync peer');
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
        log.info(`Gossip: updated member ${logSafe(local.label)} (${logSafe(local.instanceId)}) in network ${logSafe(net.id)}`);
        changed = true;
      }
    }
    if (changed) saveConfig(fresh);
  } catch (err) {
    log.warn(`Gossip pull from ${logSafe(member.label)}: ${logSafe(String(err))}`);
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
      log.warn(`Vote pull from ${logSafe(member.label)}: HTTP ${logSafe(resp.status)}`);
      return;
    }
    const { rounds: peerRounds } = await boundedJson<{ rounds: (Omit<VoteRound, 'concluded'>)[] }>(resp, 'sync peer');
    if (!Array.isArray(peerRounds)) return;

    const fresh = getConfig();
    const freshNet = fresh.networks.find(n => n.id === net.id);
    if (!freshNet) return;

    let changed = false;
    for (const peerRound of peerRounds) {
      if (!peerRound.roundId) continue;

      let local = freshNet.pendingRounds.find(r => r.roundId === peerRound.roundId);
      if (!local) {
        // Round is new to us — adopt it (GET only returns open/non-concluded rounds)
        // Nothing local is taken from it (S-7, S-9); votes are merged below, one cast at a time.
        local = adoptPeerRound(freshNet, peerRound as VoteRound);
        changed = true;
        log.info(`Vote gossip: adopted round ${logSafe(peerRound.roundId)} (${logSafe(peerRound.type)}) from ${logSafe(member.label)}`);
      }
      if (local.concluded) continue;

      // Merge vote casts.
      //
      // SECURITY: a signed cast is accepted from any reporter (its signature
      // proves the voter cast it, so multi-hop relay is safe); an unsigned cast
      // is accepted only when the reporting peer IS the voter. This blocks the
      // forgery where a malicious peer serves a round pre-stuffed with `yes`
      // votes forged for other members, while allowing signed votes to relay
      // through intermediate nodes (deep braintree trees).
      for (const peerCast of (peerRound.votes ?? []) as VoteCast[]) {
        if (!peerCast.instanceId || !['yes', 'veto'].includes(peerCast.vote)) continue;
        const decision = acceptVoteCast(freshNet, local, peerCast, member.instanceId);
        if (!decision.accept) {
          log.warn(
            `Vote gossip: rejecting cast for '${logSafe(peerCast.instanceId)}' relayed by '${logSafe(member.instanceId)}' ` +
            `(round ${logSafe(peerRound.roundId)}) — ${logSafe(decision.reason)}`,
          );
          continue;
        }
        const idx = local.votes.findIndex(v => v.instanceId === peerCast.instanceId);
        if (idx >= 0) {
          // Only replace if the new cast changes the vote value; preserve the
          // signature that came with it.
          const had = local.votes[idx]!;
          if (had.vote !== peerCast.vote || had.sig !== peerCast.sig || had.bsig !== peerCast.bsig) {
            local.votes[idx] = castForWire(peerCast);
            changed = true;
          }
        } else {
          local.votes.push(castForWire(peerCast));
          changed = true;
        }
      }
    }

    if (changed) {
      // Re-evaluate all open rounds — new votes may push them over the threshold
      for (const round of freshNet.pendingRounds) {
        if (!round.concluded) {
          const justPassed = concludeRoundIfReady(freshNet, round);
          if (justPassed && round.type === 'remove') {
            sendMemberRemovedNotify(round.subjectUrl, round.subjectInstanceId, net.id);
          }
          if (justPassed && admitPassedJoin(freshNet, fresh.instanceId, round)) {
            log.info(`Join round ${logSafe(round.roundId)} concluded via gossip — added ${logSafe(round.subjectLabel)} to network ${logSafe(net.id)}`);
          }
        }
      }
      // Space-scoped side-effects for rounds that just concluded — deletion and wipe. The gossip pass
      // concludes rounds nobody here voted on, so this is where a decision made elsewhere lands.
      applyConcludedSpaceRounds(freshNet, freshNet.pendingRounds, 'gossip');
      saveConfig(fresh);
    }
  } catch (err) {
    log.warn(`Vote pull from ${logSafe(member.label)}: ${logSafe(String(err))}`);
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
    const roundsToPush = (localNet?.pendingRounds ?? []).filter(r => !isRoundPrunable(r, now));
    for (const round of roundsToPush) {
      for (const cast of round.votes) {
        await peerSafeFetch(`${base}/votes/${encodeURIComponent(round.roundId)}`, {
          ...opts(),
          method: 'POST',
          // Forward the signature (and castAt) so the peer can verify and, when
          // valid, relay this cast onward — signed casts are relay-safe.
          // Both signatures travel (Q-138): the one shape the relay route reads back.
          body: JSON.stringify(castForWire(cast)),
        }).catch(err => log.warn(`Vote push (${logSafe(round.roundId)}) to ${logSafe(member.label)}: ${logSafe(String(err))}`));
      }
    }
  } catch (err) {
    log.warn(`Vote push to ${logSafe(member.label)}: ${logSafe(String(err))}`);
  }
}

// ── Pull (ingest from peer) ─────────────────────────────────────────────────

async function pullFromPeer(
  member: NetworkMember,
  spaceId: string,
  remoteSpaceId: string,
  networkId: string,
  opts: () => RequestInit,
  batchOpts: () => RequestInit,
): Promise<{ facts: number; entities: number; edges: number; chrono: number; links: number; stoppedEarly: string[] }> {
  let pulledMemories = 0, pulledEntities = 0, pulledEdges = 0, pulledChrono = 0, pulledLinks = 0;
  const cfg = getConfig();
  const freshNet = cfg.networks.find(n => n.id === networkId);
  const memberState = freshNet?.members.find(m => m.instanceId === member.instanceId);
  const sinceSeq = memberState?.lastSeqReceived?.[spaceId] ?? 0;

  // Tombstones first, so deletions apply before anything that would re-upsert a deleted doc. Both directions
  // live in `sync/tombstone-transfer.ts`; its own doc block says why they belong together.
  const tombstones = await pullTombstones({ member, spaceId, remoteSpaceId, networkId, sinceSeq, requestInit: opts });

  // Pull facts — use full=true to return complete docs in a single pass,
  // eliminating the N per-document secondary fetches that would be brutal over WAN.
  let highestSeq = sinceSeq;
  let overallMaxSeq = 0; // the pulled tombstones' highest seq — the records are bumped by the writer

  type PullResult = { count: number; highSeq: number; maxSeq: number } & TransferOutcome;
  /*
   * One transfer per REPLICATED family: the five record collections and file metadata, which is the `files`
   * collection pulled from the `filemeta` route. The family is passed whole because the URL suffix and the
   * collection differ for that one (`F15`): the page write named its collection after the suffix, so a pulled
   * file-metadata page went to a `<space>_filemeta` collection nothing reads. A family missing here is one a peer
   * never sends us, and nothing reports that, because a peer holding none of it hashes none either.
   */
  async function pullType<T extends FactDoc | EntityDoc | EdgeDoc | ChronoEntry | LinkDoc | (FileMetaDoc & { seq: number })>(
    family: ReplicatedFamily,
  ): Promise<PullResult> {
    const urlSuffix = family.payloadKey;
    let count = 0, highSeq = sinceSeq, maxSeq = 0;
    let cur: string | null = null;
    let pg = 0;
    // Complete THROUGH here. Pages arrive in ascending seq order, so the highest seq applied is also the
    // position this transfer is complete up to — which is what a shared watermark needs when it stops early.
    let deliveredThrough = sinceSeq;
    let truncated = false;
    do {
      const params = new URLSearchParams({
        spaceId: remoteSpaceId, networkId, sinceSeq: String(sinceSeq), limit: '200', full: 'true',
        ...(cur ? { cursor: cur } : {}),
      });
      const resp = await peerSafeFetch(`${member.url}/api/sync/${urlSuffix}?${params}`, batchOpts());
      if (!resp.ok) {
        truncated = true;
        log.warn(truncationWarn(`Pull ${urlSuffix} from`, logSafe(member.label ?? ''), spaceId, resp.status, deliveredThrough));
        break;
      }
      const { items, nextCursor } = await boundedJson<{
        items: (T | { _id: string; seq: number; deletedAt: string })[]; nextCursor: string | null;
      }>(resp, 'sync peer');
      // The page's documents; the tombstones riding in it were applied by `pullTombstones` above.
      const pageDocs = items.filter(item => !('deletedAt' in item && (item as { deletedAt?: string }).deletedAt)) as T[];
      /*
       * THE RECEIVER DECIDES WHAT IT STORES, through the one arrival writer (`sync/arrivals.ts`): a malformed id
       * or an implausible seq refused per document (warned, and the position advances past it as 5.6.1's "skipped
       * doc" did), the retag to the local space, a repeated id collapsed to its highest seq, the sender's
       * local-only fields dropped and this instance's own carried across the replace, the guard against a newer
       * stored copy, the counter bumped per landed chunk, and every landed record queued for embedding by THIS
       * instance's rules (`Q-203` — a pulled record used to be stored and never queued at all). A bump that failed
       * is reported (`counterBehind`) and holds the position like a failed write (`Q-218` R3).
       *
       * A write the store could not do is a RECORD-WRITE failure, not an unreachable peer (`F10`): the transfer
       * stops, holds `deliveredThrough` below the page, and fetches it again next cycle. It used to escape to the
       * member-level catch, which counts toward PEER UNREACHABLE and names the driver error and nothing else. A
       * document the STORE refuses holds the position the same way (cut `C3`: never counted as delivered).
       */
      let written: ArrivalOutcome;
      try {
        written = await writeArrivals(spaceId, family.collection, RECORD_TYPE_OF[family.collection], pageDocs,
          { from: member.label ?? member.instanceId });
      } catch (err) {
        truncated = true;
        log.warn(`sync pull ${logSafe(spaceId)} ${family.collection}: record write failed: `
          + `${logSafe(err instanceof Error ? err.message : String(err))} (from ${logSafe(member.label ?? member.instanceId)}). `
          + `This is this instance's database, not the peer: the transfer holds at ${logSafe(deliveredThrough)} and the page `
          + 'is fetched again next cycle.');
        break;
      }
      if (written.counterBehind) {
        // `Q-218` R3: the page is stored, but this counter may be behind it, so the position is not vouched for.
        truncated = true;
        log.warn(`sync pull ${logSafe(spaceId)} ${family.collection}: record write failed: the seq counter could not be moved `
          + `past the page from ${logSafe(member.label ?? member.instanceId)}. The transfer holds at ${logSafe(deliveredThrough)} `
          + 'and the page is fetched again next cycle.');
        break;
      }
      if (written.storeRefused.length > 0) {
        truncated = true;
        // The documents are named once, by the writer's own summary (`warnArrivalsNotStored`); this says what it costs.
        log.warn(`sync pull ${logSafe(spaceId)} ${family.collection}: record write failed: the store refused `
          + `${written.storeRefused.length} document(s) from ${logSafe(member.label ?? member.instanceId)}. The `
          + `transfer holds at ${logSafe(deliveredThrough)} and the page is fetched again next cycle.`);
        break;
      }
      const refused = new Set(written.refused.map(r => r._id));
      for (const doc of pageDocs as FactDoc[]) {
        if (refused.has(arrivalId(doc))) continue;
        count++;
        if (doc.seq > maxSeq) maxSeq = doc.seq;
        if (doc.seq > highSeq && doc.author?.instanceId === member.instanceId) highSeq = doc.seq;
      }
      // Only after the page is APPLIED. Recording it before the write would vouch for records that a throw
      // between the two would have lost.
      if (maxSeq > deliveredThrough) deliveredThrough = maxSeq;
      cur = nextCursor; pg++;
    } while (cur && pg < 50);
    // The page cap is a truncation too, and it is the one that made "never advance on truncation" the wrong
    // fix: this transfer genuinely has more to give, so it must keep the ceiling AND keep making progress.
    // The page cap is a truncation too, and it is why "never advance on truncation" was the wrong fix: this
    // transfer has more to give, so it must cap the watermark AND keep making progress.
    if (cur) {
      truncated = true;
      log.warn(truncationWarn(`Pull ${urlSuffix} from`, logSafe(member.label ?? ''), spaceId, `${logSafe(pg)}-page cap`, deliveredThrough));
    }
    return { count, highSeq, maxSeq, deliveredThrough, truncated };
  }

  /*
   * SEQUENTIAL, not `Promise.all`. Each transfer pages against the same peer and applies as it goes, so
   * running them together multiplies the concurrent load on the side of the cycle that is already slow,
   * and interleaves the writes a truncated transfer's watermark has to reason about.
   */
  const pulled = {} as Record<PayloadKey, PullResult>;
  for (const family of REPLICATED_FAMILIES) {
    pulled[family.payloadKey] = await pullType(family);
  }

  pulledMemories = pulled.facts.count;
  pulledEntities = pulled.entities.count;
  pulledEdges = pulled.edges.count;
  pulledChrono = pulled.chrono.count;
  pulledLinks = pulled.links.count;

  /*
   * ONE WATERMARK, FIVE TRANSFERS — so the max is only safe if all five finished.
   *
   * `Math.max` across the four types was the old rule, and it moved `lastSeqReceived` to a position a
   * truncated type had not reached: its unserved records then sat behind the watermark for ever, while every
   * later cycle reported success. `safeWatermark` lowers the ceiling to whatever the stopped transfers can
   * actually vouch for. EVERY transfer is passed — an omitted one places no ceiling, which makes it
   * exactly the one that gets skipped.
   */
  const stoppedEarly: string[] = [];
  highestSeq = resolveWatermark({
    heldBack: stoppedEarly, direction: 'receive', peerLabel: member.label ?? member.instanceId, spaceId,
    from: sinceSeq,
    transfers: pulled,
    // Bounds the advance, never raises it: a tombstone seq is not a position in the data stream.
    alsoCheck: { tombstones },
    seqOf: (t) => t.highSeq,
    warn: log.warn,
  });
  // THE TOMBSTONES' share of the counter bump — and only theirs. Every RECORD this pull handed over was bumped
  // over by the arrival writer itself, per landed chunk (`writeArrivals`), so a second bump over the records here
  // would be the same rule in two places. A tombstone is not written by the writer, and it IS received from this
  // peer with the deleting instance's seq: left out, a quiet peer's counter stays behind a busy peer's deletions,
  // and a record re-created there (same id, lower seq) is refused by every peer holding the tombstone, for good.
  // The one tombstone apply hands the pull its highest ADMITTED seq instead of bumping per page (`deferBump`), so on
  // 5.6.x the bump stays here, after the records: it also raises the settled horizon, which must not run ahead of
  // records still being written (vet R3). Thrown when it fails, before the watermark is persisted, so the cycle
  // counts an error and the position is held.
  overallMaxSeq = tombstones.maxSeq;
  if (overallMaxSeq > 0) {
    try {
      await bumpSeq(spaceId, overallMaxSeq);
    } catch (err) {
      throw new TombstoneCounterError(spaceId, overallMaxSeq, err);
    }
  }

  // Persist the high-water mark
  if (highestSeq > sinceSeq) {
    const freshCfg = getConfig();
    const freshNet2 = freshCfg.networks.find(n => n.id === networkId);
    const m = freshNet2?.members.find(m => m.instanceId === member.instanceId);
    if (m) {
      m.lastSeqReceived ??= {};
      m.lastSeqReceived[spaceId] = highestSeq;
      // Hot-path watermark: written per space per member per cycle. Coalesced
      // async write — if lost on crash the next pull simply re-pulls from the
      // older watermark (idempotent by seq), never dropping data.
      saveConfigSoon(freshCfg);
    }
  }

  return {
    facts: pulledMemories, entities: pulledEntities, edges: pulledEdges, chrono: pulledChrono,
    links: pulledLinks, stoppedEarly,
  };
}

// ── Push (upload our changes to peer) ──────────────────────────────────────

async function pushToPeer(
  member: NetworkMember,
  spaceId: string,
  remoteSpaceId: string,
  networkId: string,
  opts: () => RequestInit,
  batchOpts: () => RequestInit,
): Promise<{ facts: number; entities: number; edges: number; chrono: number; links: number; stoppedEarly: string[]; refused: string[] }> {
  let pushedMemories = 0, pushedEntities = 0, pushedEdges = 0, pushedChrono = 0, pushedLinks = 0;
  const cfg = getConfig();
  const freshNet = cfg.networks.find(n => n.id === networkId);
  const memberState = freshNet?.members.find(m => m.instanceId === member.instanceId);
  const lastSeqPushed = memberState?.lastSeqPushed?.[spaceId] ?? 0;

  // Tombstones first — paged, with no hard cap, since one would silently drop deletions after a long absence.
  const tombstones = await pushTombstones({ member, spaceId, remoteSpaceId, networkId, lastSeqPushed, requestInit: opts });

  // Fetch only docs changed since the last push — read and send in PUSH_BATCH_SIZE
  // chunks directly from MongoDB without loading the whole result set into fact first.
  // This makes push O(changed) instead of O(total), and keeps heap usage flat regardless
  // of how many documents have accumulated since the last sync.
  // Braintree nodes relay docs from all peers; other topologies only push their own authored docs
  // to prevent foreign docs (e.g. received from a third instance) from polluting peers' watermarks.
  const isDirectionalType = freshNet?.type === 'braintree' || freshNet?.type === 'pubsub';
  const ownedFilter = isDirectionalType ? {} : { 'author.instanceId': cfg.instanceId };

  let maxSeqPushed = lastSeqPushed;

  // Send in PUSH_BATCH_SIZE slices; stop early on persistent failure
  const batchEndpoint = `${member.url}/api/sync/batch-upsert?spaceId=${encodeURIComponent(remoteSpaceId)}&networkId=${encodeURIComponent(networkId)}`;

  // Helper: stream one collection type to the peer in cursor-paginated batches.
  /*
   * NOT ALL BRAIN COLLECTIONS — `files` is absent because a file crosses the wire as blob plus manifest,
   * not as a document in this batch. Every other collection is here, `links` included: a collection missing
   * from this union is written locally and never offered to a peer, which for a record type whose entire
   * purpose is to be shared ships the feature and none of it.
   *
   * And it would not even be reported. `brain/merkle.ts` hashes the links collection, so the two roots would
   * differ for ever — except that a peer which never RECEIVES a link has nothing to hash either, so both
   * sides agree on a root computed from data only one of them holds.
   */
  /**
   * @param extraFilter narrows what is SENT. Files use it for parents only: a chunk is derived from the
   *   blob and the receiver makes its own, so sending one would ship passage text and a vector from a
   *   model the receiver may not run.
   */
  async function pushCollection<T extends FactDoc | EntityDoc | EdgeDoc | ChronoEntry | LinkDoc | (FileMetaDoc & { seq: number })>(
    collName: string,
    payloadKey: PayloadKey,
    extraFilter: Record<string, unknown> = {},
  ): Promise<{ pushed: number; maxSeq: number; refused: number } & TransferOutcome> {
    let pushed = 0; let refused = 0;
    let localMaxSeq = lastSeqPushed;
    let seqCursor = lastSeqPushed;
    let truncated = false;
    while (true) {
      // Settled seqs only (Q-196): `lastSeqPushed` moves to the last seq sent, so sending one above an
      // unsettled write would step the watermark past a record this instance has not finished writing.
      const batch = await col<T>(collName)
        .find(asFilter<T>({ seq: await settledSeqRange(spaceId, seqCursor), ...ownedFilter, ...extraFilter }))
        .sort({ seq: 1 })
        .limit(PUSH_BATCH_SIZE)
        .toArray() as T[];
      /*
       * X-20 instrumentation. The stall this exists to name has one recorded symptom and it is this loop:
       * `A's cycles ran every 3 s in 19 ms each` — the signature of a cycle that FOUND NOTHING, not of a slow
       * sender. Nothing in the log could tell "found nothing because there is nothing" from "found nothing
       * because the cursor is already past it", and those are a healthy cycle and a permanent data loss.
       *
       * So the cursor and the count are logged on every pass, empty ones included. Gated on `DEBUG`, so it is
       * free unless somebody is looking — and it is the one line that would have made six failed reproduction
       * attempts conclusive instead of inconclusive.
       */
      log.debug(`Push ${payloadKey} to ${logSafe(member.label ?? member.instanceId)} space '${logSafe(spaceId)}': `
        + `${batch.length} doc(s) with seq > ${logSafe(seqCursor)}`
        + (batch.length ? ` (through ${logSafe((batch[batch.length - 1] as FactDoc).seq)})` : ''));
      if (batch.length === 0) break;
      const resp = await peerSafeFetch(batchEndpoint, {
        ...batchOpts(), method: 'POST',
        body: JSON.stringify({ [payloadKey]: payloadKey === 'filemeta' ? batch.map(fileMetaForWire) : batch }), // Q-69
      });
      if (!resp.ok) {
        truncated = true;
        log.warn(truncationWarn(`Batch push ${payloadKey} to`, logSafe(member.label ?? ''), spaceId, resp.status, seqCursor));
        break;
      }
      // A 200 does not mean every record landed: the peer can discard a fact whose fork chain is at its
      // cap and still answer 200. `sync/push-refusals.ts` says what that costs and why the watermark still
      // advances anyway.
      const r = await reportPushRefusals(resp, payloadKey, member.label ?? member.instanceId, spaceId, batch.length);
      pushed += batch.length - r; refused += r; // Q-59: what the peer refused was not pushed
      for (const doc of batch) {
        const d = doc as FactDoc;
        if (d.author?.instanceId === cfg.instanceId && d.seq > localMaxSeq) localMaxSeq = d.seq;
      }
      seqCursor = (batch[batch.length - 1] as FactDoc).seq;
      if (batch.length < PUSH_BATCH_SIZE) break;
    }
    // `deliveredThrough` is `seqCursor` — the last seq the peer ACCEPTED — and not `localMaxSeq`, which is
    // author-guarded. The two answer different questions: `localMaxSeq` is how far our own records reached,
    // `seqCursor` is how far this transfer got at all. Capping with the author-guarded number would let the
    // watermark advance past a foreign doc that was never accepted, which on a pubsub or braintree network
    // (where `ownedFilter` is empty and we relay everything) is a record only we were going to send.
    return { pushed, maxSeq: localMaxSeq, deliveredThrough: seqCursor, truncated, refused };
  }

  // Sequential for the same reason as the pull, and the parents-only filter comes from the row rather
  // than from a special case here — see `REPLICATED_FAMILIES`.
  const pushed = {} as Record<PayloadKey, { pushed: number; maxSeq: number; refused: number } & TransferOutcome>;
  for (const family of REPLICATED_FAMILIES) {
    pushed[family.payloadKey] = await pushCollection(
      `${spaceId}_${family.collection}`, family.payloadKey, family.pushFilter ?? {});
  }

  pushedMemories = pushed.facts.pushed;
  pushedEntities = pushed.entities.pushed;
  pushedEdges = pushed.edges.pushed;
  pushedChrono = pushed.chrono.pushed;
  pushedLinks = pushed.links.pushed;
  /*
   * Same rule as the pull, same function, AND NOW THE SAME LIST — which is what this comment used to claim
   * while the line below it disproved it.
   *
   * It read *"see `sync/watermark.ts` for why it is not two implementations"*, and the `candidate`
   * argument directly beneath was the second implementation: pull's enumerated six families, this one five,
   * with `filemeta` present in `transfers` and missing from the max. So a file-metadata transfer could hold
   * this watermark back and never advance it, and a cycle whose only change was file metadata re-pushed the
   * same page for ever. The candidate is derived from the transfers now.
   */
  const stoppedEarly: string[] = [];
  maxSeqPushed = resolveWatermark({
    heldBack: stoppedEarly, direction: 'push', peerLabel: member.label ?? member.instanceId, spaceId,
    from: lastSeqPushed,
    transfers: pushed,
    alsoCheck: { tombstones },
    seqOf: (t) => t.maxSeq,
    warn: log.warn,
  });
  const refused = refusedTransfers(pushed); // Q-59: the peer answered, so this is not a failure — see runSyncForNetwork

  /*
   * The other half of the X-20 instrumentation: what the cycle DECIDED, beside what it found.
   *
   * A watermark that moves while every transfer reported zero documents is the shape that would explain the
   * stall — the cursor advancing past a record nothing sent, after which every later cycle correctly finds
   * nothing and the record is never offered again. That combination is invisible without both numbers in one
   * line, which is why they are logged together rather than at four separate call sites.
   */
  log.debug(`Push cycle to ${logSafe(member.label ?? member.instanceId)} space '${logSafe(spaceId)}': watermark ${logSafe(lastSeqPushed)} -> `
    + `${logSafe(maxSeqPushed)}, pushed ${logSafe(pushedMemories)}m/${logSafe(pushedEntities)}e/${logSafe(pushedEdges)}g/${logSafe(pushedChrono)}c/${logSafe(pushedLinks)}l`);

  // Persist the push high-water mark so next sync only sends new/changed docs
  if (maxSeqPushed > lastSeqPushed) {
    const freshCfg = getConfig();
    const freshNet2 = freshCfg.networks.find(n => n.id === networkId);
    const m = freshNet2?.members.find(m => m.instanceId === member.instanceId);
    if (m) {
      m.lastSeqPushed ??= {};
      m.lastSeqPushed[spaceId] = maxSeqPushed;
      // Hot-path watermark: written per space per member per cycle. Coalesced
      // async write — if lost on crash the next push simply re-pushes from the
      // older watermark (idempotent by seq), never dropping data.
      saveConfigSoon(freshCfg);
    }
  }

  return {
    facts: pushedMemories, entities: pushedEntities, edges: pushedEdges, chrono: pushedChrono,
    links: pushedLinks, stoppedEarly, refused,
  };
}


// Silence unused import warning — resolveSafePath may be used by future file push refinement
void resolveSafePath;

// ── Merkle integrity check ──────────────────────────────────────────────────

/**
 * After a full space sync with a peer, fetch the peer's Merkle root and compare
 * it to our own locally-computed root.  Any divergence is logged as a prominent
 * MERKLE_DIVERGENCE warning — it does NOT block the sync or modify data.
 *
 * This is a best-effort, non-fatal check.  Failures (e.g. peer doesn't support
 * the endpoint yet, network timeout) are logged at warn level and swallowed.
 */
async function checkMerkleWithPeer(
  net: NetworkConfig,
  member: NetworkMember,
  spaceId: string,
  remoteSpaceId: string,
  opts: () => RequestInit,
): Promise<void> {
  try {
    const { computeMerkleRoot } = await import('../brain/merkle.js');
    const [localResult, peerResp] = await Promise.all([
      computeMerkleRoot(spaceId),
      peerSafeFetch(
        `${member.url}/api/sync/merkle?spaceId=${encodeURIComponent(remoteSpaceId)}&networkId=${encodeURIComponent(net.id)}`,
        opts(),
      ),
    ]);

    if (!peerResp.ok) {
      log.warn(`Merkle check for space '${logSafe(spaceId)}' with peer '${logSafe(member.label)}': peer returned HTTP ${logSafe(peerResp.status)} — skipping`);
      return;
    }

    const peerResult = await boundedJson<{ root?: string; leafCount?: number }>(peerResp, 'sync peer');
    const peerRoot = peerResult.root;

    if (!peerRoot) {
      log.warn(`Merkle check for space '${logSafe(spaceId)}' with peer '${logSafe(member.label)}': peer response missing 'root' field`);
      return;
    }

    if (localResult.root !== peerRoot) {
      log.warn(
        `MERKLE_DIVERGENCE: space '${logSafe(spaceId)}', peer '${logSafe(member.label)}' (${logSafe(member.instanceId)}), ` +
        `network '${logSafe(net.label)}'. ` +
        `local root=${logSafe(localResult.root)} (${logSafe(localResult.leafCount)} leaves), ` +
        `peer root=${logSafe(peerRoot)} (${logSafe(peerResult.leafCount ?? '?')} leaves). ` +
        `The space contents differ after sync — possible data loss, concurrent write, or sync bug.`,
      );
    } else {
      log.info(`Merkle OK: space '${logSafe(spaceId)}', peer '${logSafe(member.label)}' root=${logSafe(localResult.root.slice(0, 12))}…`);
    }
  } catch (err) {
    log.warn(`Merkle check for space '${logSafe(spaceId)}' with peer '${logSafe(member.label)}': ${logSafe(String(err))}`);
  }
}
