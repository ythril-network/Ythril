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
import { BRAIN_COLLECTIONS } from '../config/types.js';
import { boundedJson } from '../util/bounded-read.js';
import { col, asFilter } from '../db/mongo.js';
import { refusedTransfers } from './push-refusals.js';
import { deliverChangeNotes } from './change-notes.js';
import { recordSyncResult, type SyncCounts } from './history.js';
import { log, peerText } from '../util/log.js';
import { resolveWatermark, type TransferOutcome } from './watermark.js';
import { pullFamily, type PullResult } from './pull-family.js';
import { pushFamily } from './push-family.js';
import { pullTombstones, pushTombstones } from './tombstone-transfer.js';
import { applyConcludedSpaceRounds } from '../spaces/apply-wipe-round.js';
import { concreteSpaces } from '../spaces/proxy.js';
import { adoptAnnouncedSpaces, announcedSpaces, healAnnouncedAliases } from '../networks/network-spaces.js';
import { selfRecordFor } from '../networks/self-record.js';
import { mergePeerRoster, revokeRemoved, pairIntroduced, applyPassedJoin } from '../networks/member-introductions.js';
import { pullSpaceMetaFromUpstream } from './space-meta-pull.js';
import { peerSafeFetch, isPeerUrlAllowed } from './peer-fetch.js';
import { concludeRoundIfReady, sendMemberRemovedNotify } from './governance.js';
import { adoptPeerRound } from '../networks/round-local-state.js';
import { enqueueMediaJob } from '../files/media/job-queue.js';
import { resolveInputFormat } from '../files/converters/pipeline.js';
import { mimeTypeForPath } from '../files/mime.js';
import { createCoalescingRunner } from './coalescing-runner.js';
import { LinkageCheck } from './linkage-check.js';
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
import { acceptVoteCast, pinMemberSigningKey, castForWire } from '../util/signing.js';
import { assertPeerAtFloor } from './peer-floor.js';
import { REPLICATED_FAMILIES, type PayloadKey } from './replicated-families.js';
import { isRoundPrunable, pruneExpiredRounds } from './vote-round-retention.js';
import { spaceCollection } from '../db/space-collection.js';

// Every outbound fetch's budget, and the longer one for batch payloads — in their own module because the
// receiver's hold deadline is derived from the batch one (`db/write-bound.ts`).
import { FETCH_TIMEOUT_MS, BATCH_FETCH_TIMEOUT_MS } from './peer-timeouts.js';

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

  log.info(`Starting sync cycle for network '${peerText(net.label)}' (${net.members.length} members)`);
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
      if (counts.refused.length > 0) { refusals++; errorMessages.push(`${member.label} refused records: ${counts.refused.join('; ')}`); }
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
          `REPARENT_REVERT_AVAILABLE: original parent '${peerText(member.label)}' is back online. ` +
          `'${peerText(rc.label)}' (${peerText(rc.instanceId)}) was temporarily re-parented during the outage. ` +
          `To restore original topology: POST /api/networks/${peerText(net.id)}/members/${peerText(rc.instanceId)}/revert-parent. ` +
          `To make the adoption permanent:  POST /api/networks/${peerText(net.id)}/members/${peerText(rc.instanceId)}/adopt.`,
        );
      }
    } catch (err) {
      const errMsg = `Sync failed for member ${member.label} (${member.instanceId}): ${err}`;
      log.error(peerText(errMsg));
      errorMessages.push(errMsg);
      errors++;
      const failures = _setFailureCount(net.id, member.instanceId, 'increment');
      if (failures === STALE_FAILURE_THRESHOLD) {
        const hasChildren = net.type === 'braintree' && (member.children?.length ?? 0) > 0;
        log.warn(
          `PEER UNREACHABLE: '${peerText(member.label)}' in network '${peerText(net.label)}' has failed ` +
          `${failures} consecutive sync cycles. Last success: ${peerText(member.lastSyncAt ?? 'never')}. ` +
          `Member has NOT been removed — manual action required.` +
          (hasChildren
            ? ` NOTE: this node has ${member.children!.length} child(ren) in a braintree network — its entire subtree is now partitioned from this brain until it comes back online.`
            : ''),
        );
      } else if (failures > STALE_FAILURE_THRESHOLD && failures % 10 === 0) {
        log.warn(`PEER STILL UNREACHABLE: '${peerText(member.label)}' (${failures} consecutive failures, last success: ${peerText(member.lastSyncAt ?? 'never')})`);
      }
    }
  }

  // Q-135: pair with every club member a peer introduced this cycle (or earlier, and not yet paired). Never throws.
  await pairIntroduced(networkId);

  log.info(`Sync cycle complete for '${peerText(net.label)}': ${synced} ok, ${errors} errors`);
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
        log.info(`Pruned ${removed} concluded+expired vote round(s) from network '${peerText(freshNet.label)}'`);
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
      log.error(`network_sync failed for peer ${peerText(member.label)} (${peerText(member.instanceId)}) in network '${peerText(net.label)}': ${peerText(err)}`);
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
    log.warn(`No peer token for ${peerText(member.label)} (${peerText(member.instanceId)}) — skipping sync`);
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
    log.warn(`Governance gossip with ${peerText(member.label)} (${peerText(member.instanceId)}): ${peerText(err)}`);
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
    if (!concreteSpaces().some(s => s.id === spaceId)) {
      log.warn(`Skipping sync for space '${peerText(spaceId)}' in network '${peerText(net.label)}': space not in local config`);
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
                log.warn(`Face reprocess enqueue for ${peerText(spaceId)}/${peerText(p)}: ${peerText(err)}`),
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
      log.warn(`Gossip pull from ${peerText(member.label)}: HTTP ${resp.status}`);
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
      log.warn(`Vote pull from ${peerText(member.label)}: HTTP ${resp.status}`);
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
        log.info(`Vote gossip: adopted round ${peerText(peerRound.roundId)} (${peerRound.type}) from ${peerText(member.label)}`);
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
            `Vote gossip: rejecting cast for '${peerText(peerCast.instanceId)}' relayed by '${peerText(member.instanceId)}' ` +
            `(round ${peerText(peerRound.roundId)}) — ${peerText(decision.reason)}`,
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
          // A passed join: the credential holder admits, every other member of a voted network introduces (Q-154).
          if (justPassed && applyPassedJoin(freshNet, fresh.instanceId, round) === 'admitted') {
            log.info(`Join round ${peerText(round.roundId)} concluded via gossip — added ${peerText(round.subjectLabel)} to network ${peerText(net.id)}`);
          }
        }
      }
      // Space-scoped side-effects for rounds that just concluded — deletion and wipe. The gossip pass
      // concludes rounds nobody here voted on, so this is where a decision made elsewhere lands.
      applyConcludedSpaceRounds(freshNet, freshNet.pendingRounds, 'gossip');
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
        }).catch(err => log.warn(`Vote push (${peerText(round.roundId)}) to ${peerText(member.label)}: ${peerText(err)}`));
      }
    }
  } catch (err) {
    log.warn(`Vote push to ${peerText(member.label)}: ${peerText(err)}`);
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

  let highestSeq = sinceSeq;

  /*
   * What lands in this space's transfer is checked for strict linkage ONCE, after every family (below) — page by
   * page, an edge to a chrono entry pulled later in the same cycle was recorded missing (bundle-30 I8).
   */
  const linkage = new LinkageCheck(spaceId, member.instanceId);

  /*
   * SEQUENTIAL, not `Promise.all`. Each transfer pages against the same peer and applies as it goes, so
   * running them together multiplies the concurrent load on the side of the cycle that is already slow,
   * and interleaves the writes a truncated transfer's watermark has to reason about.
   *
   * NOT ALL BRAIN COLLECTIONS: `files` is absent from the list because a file arrives as blob plus manifest, not as a
   * document on this path. `links` is present — a collection missing here is one a peer never sends us, and nothing
   * reports that, because a peer holding no links hashes none either.
   */
  const pulled = {} as Record<PayloadKey, PullResult>;
  try {
    for (const family of REPLICATED_FAMILIES) {
      pulled[family.payloadKey] = await pullFamily({ family, member, spaceId, remoteSpaceId, networkId, sinceSeq, requestInit: batchOpts, linkage });
    }
  } finally {
    /*
     * What landed is checked even when a fetch REJECTS part-way (bundle-30 I13): edges that landed before it are
     * re-served next cycle at an equal seq and plan as skipped, so they are never checked again. A family whose
     * transfer stopped early, or never ran (the one that threw and every one after), may still hold a target: its
     * ends are not judged missing this cycle.
     */
    await linkage.run({ stillToCome: REPLICATED_FAMILIES
      .filter(f => pulled[f.payloadKey] === undefined || pulled[f.payloadKey].truncated).map(f => f.collection) });
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
  // No counter bump here: every record this pull received was bumped over by the page accept, per page
  // (`acceptArrivingPage`), and every tombstone by the one tombstone apply, per page (`applyPeerTombstones`).

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

  // Only docs changed since the last push, read and sent in batches (`sync/push-family.ts`) straight from MongoDB, so the
  // push is O(changed) and its heap is flat however much has accumulated since the last sync.
  // Braintree nodes relay docs from all peers; other topologies only push their own authored docs
  // to prevent foreign docs (e.g. received from a third instance) from polluting peers' watermarks.
  const isDirectionalType = freshNet?.type === 'braintree' || freshNet?.type === 'pubsub';
  const ownedFilter = isDirectionalType ? {} : { 'author.instanceId': cfg.instanceId };

  let maxSeqPushed = lastSeqPushed;

  /*
   * Sequential for the same reason as the pull, and the parents-only filter comes from the row rather than from a
   * special case here — see `REPLICATED_FAMILIES`.
   *
   * NOT ALL BRAIN COLLECTIONS — `files` is absent because a file crosses the wire as blob plus manifest, not as a
   * document in this batch. Every other collection is here, `links` included: a collection missing from this union is
   * written locally and never offered to a peer, which for a record type whose entire purpose is to be shared ships the
   * feature and none of it. And it would not even be reported: `brain/merkle.ts` hashes the links collection, so the two
   * roots would differ for ever — except that a peer which never RECEIVES a link has nothing to hash either, so both
   * sides agree on a root computed from data only one of them holds.
   */
  const pushed = {} as Record<PayloadKey, { pushed: number; maxSeq: number; refused: number } & TransferOutcome>;
  for (const family of REPLICATED_FAMILIES) {
    pushed[family.payloadKey] = await pushFamily({
      family, member, spaceId, remoteSpaceId, networkId, lastSeqPushed, owned: ownedFilter, instanceId: cfg.instanceId, requestInit: batchOpts,
    });
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
  log.debug(`Push cycle to ${peerText(member.label ?? member.instanceId)} space '${peerText(spaceId)}': watermark ${lastSeqPushed} -> `
    + `${maxSeqPushed}, pushed ${pushedMemories}m/${pushedEntities}e/${pushedEdges}g/${pushedChrono}c/${pushedLinks}l`);

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
      log.warn(`Merkle check for space '${peerText(spaceId)}' with peer '${peerText(member.label)}': peer returned HTTP ${peerResp.status} — skipping`);
      return;
    }

    const peerResult = await boundedJson<{ root?: string; leafCount?: number }>(peerResp, 'sync peer');
    const peerRoot = peerResult.root;

    if (!peerRoot) {
      log.warn(`Merkle check for space '${peerText(spaceId)}' with peer '${peerText(member.label)}': peer response missing 'root' field`);
      return;
    }

    if (localResult.root !== peerRoot) {
      log.warn(
        `MERKLE_DIVERGENCE: space '${peerText(spaceId)}', peer '${peerText(member.label)}' (${peerText(member.instanceId)}), ` +
        `network '${peerText(net.label)}'. ` +
        `local root=${peerText(localResult.root)} (${localResult.leafCount} leaves), ` +
        `peer root=${peerText(peerRoot)} (${peerResult.leafCount ?? '?'} leaves). ` +
        `The space contents differ after sync — possible data loss, concurrent write, or sync bug.`,
      );
    } else {
      log.info(`Merkle OK: space '${peerText(spaceId)}', peer '${peerText(member.label)}' root=${peerText(localResult.root.slice(0, 12))}…`);
    }
  } catch (err) {
    log.warn(`Merkle check for space '${peerText(spaceId)}' with peer '${peerText(member.label)}': ${peerText(err)}`);
  }
}
