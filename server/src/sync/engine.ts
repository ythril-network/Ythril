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
import { reconcileLinksForPage } from '../brain/links.js';
import { applyFileMetaPage } from '../api/sync/_shared.js';
import { boundedJson } from '../util/bounded-read.js';
import { reportPushRefusals } from './push-refusals.js';
import { toSafeRelPath } from '../util/paths.js';
import { col, asFilter, asDoc, asBulk } from '../db/mongo.js';
import { applyRemoteTombstone, listTombstones } from '../brain/tombstones.js';
import { recordFileTombstoneAck, ackedPositionFrom } from './file-tombstone-ack.js';
import { recordSyncResult, type SyncCounts } from './history.js';
import { buildFileManifest } from '../files/manifest.js';
import { log } from '../util/log.js';
import { resolveWatermark, truncationWarn, type TransferOutcome } from './watermark.js';
import { pullTombstones, pushTombstones } from './tombstone-transfer.js';
import { applyConcludedSpaceRounds } from '../spaces/apply-wipe-round.js';
import { bumpSeq, isSeqImplausible } from '../util/seq.js';
import { peerSafeFetch, isPeerUrlAllowed, transferInit, PEER_TRANSFER_TIMEOUT_MS } from './peer-fetch.js';
import { concludeRoundIfReady, sendMemberRemovedNotify } from './governance.js';
import { enqueueMediaJob } from '../files/media/job-queue.js';
import { resolveInputFormat } from '../files/converters/pipeline.js';
import { mimeTypeForPath } from '../files/mime.js';
import { schedule as cronSchedule, type ScheduledTask } from 'node-cron';
import { resolveSyncCron } from './schedule.js';
import { createCoalescingRunner } from './coalescing-runner.js';
import { remoteToLocal, localToRemote } from './space-map.js';
import { retagToLocalSpace, planSeqUpserts } from './upsert-plan.js';
import { decideFilePull, conflictCopyPath } from './file-conflict.js';
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
  TombstoneDoc,
  FileTombstoneDoc,
  ConflictDoc,
  VoteRound,
  VoteCast,
} from '../config/types.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { getDataRoot } from '../config/loader.js';
import { createHash } from 'node:crypto';
import { resolveSafePath } from '../files/sandbox.js';
import { deleteFileMeta, upsertFileMeta } from '../files/file-meta.js';
import type { FileMetaDoc } from '../config/types.js';
import { acceptVoteCast, getSigningPublicKey, getSigningKeyRotation, pinMemberSigningKey } from '../util/signing.js';
import { v4 as uuidv4 } from 'uuid';
import { armedSchedules } from '../util/armed-schedule.js';
import { assertPeerAtFloor } from './peer-floor.js';
import { REPLICATED_FAMILIES, type PayloadKey } from './replicated-families.js';
import { SERVER_VERSION } from '../util/server-version.js';
import { stripLocalOnly } from './local-only-fields.js';
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

// ── Vote-round retention ────────────────────────────────────────────────────

/** A round is prunable once it is concluded AND past its deadline. After the deadline
 *  every peer concludes the round independently (the deadline path in
 *  `concludeRoundIfReady`), so such a round can no longer influence any decision and
 *  never needs re-serving or re-propagating. A malformed/unparseable deadline yields
 *  `NaN`, and `NaN < now` is false, so we keep the round rather than prune on doubt. */
export function isRoundPrunable(
  round: { concluded?: boolean; deadline: string },
  now: number = Date.now(),
): boolean {
  return Boolean(round.concluded) && new Date(round.deadline).getTime() < now;
}

/** Drop concluded-and-expired rounds from a network's `pendingRounds` in place.
 *  `concludeRoundIfReady` marks a round `concluded` but never removes it, so without
 *  this `pendingRounds` grows for the life of the network — bloating `config.json`, the
 *  `GET /votes` scan, and gossip payloads. Returns the number of rounds removed. */
export function pruneExpiredRounds(net: NetworkConfig, now: number = Date.now()): number {
  const rounds = net.pendingRounds;
  if (!rounds || rounds.length === 0) return 0;
  const kept = rounds.filter(r => !isRoundPrunable(r, now));
  const removed = rounds.length - kept.length;
  if (removed > 0) net.pendingRounds = kept;
  return removed;
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
  onQueued: (id) => log.debug(`Sync cycle already running for network ${id} — queuing rerun`),
  onRerun: (id) => log.debug(`Rerun requested for network ${id} — starting`),
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

  log.info(`Starting sync cycle for network '${net.label}' (${net.members.length} members)`);
  let synced = 0; let errors = 0;
  const syncTimer = syncDurationSeconds.startTimer({ network: networkId });

  for (const member of net.members) {
    try {
      const counts = await runSyncForMember(net, member);
      pulled.facts += counts.pulled.facts;
      pulled.entities += counts.pulled.entities;
      pulled.edges += counts.pulled.edges;
      pulled.files += counts.pulled.files;
      pulled.chrono += counts.pulled.chrono;
      pushed.facts += counts.pushed.facts;
      pushed.entities += counts.pushed.entities;
      pushed.edges += counts.pushed.edges;
      pushed.files += counts.pushed.files;
      pushed.chrono += counts.pushed.chrono;
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
          `REPARENT_REVERT_AVAILABLE: original parent '${member.label}' is back online. ` +
          `'${rc.label}' (${rc.instanceId}) was temporarily re-parented during the outage. ` +
          `To restore original topology: POST /api/networks/${net.id}/members/${rc.instanceId}/revert-parent. ` +
          `To make the adoption permanent:  POST /api/networks/${net.id}/members/${rc.instanceId}/adopt.`,
        );
      }
    } catch (err) {
      const errMsg = `Sync failed for member ${member.label} (${member.instanceId}): ${err}`;
      log.error(errMsg);
      errorMessages.push(errMsg);
      errors++;
      const failures = _setFailureCount(net.id, member.instanceId, 'increment');
      if (failures === STALE_FAILURE_THRESHOLD) {
        const hasChildren = net.type === 'braintree' && (member.children?.length ?? 0) > 0;
        log.warn(
          `PEER UNREACHABLE: '${member.label}' in network '${net.label}' has failed ` +
          `${failures} consecutive sync cycles. Last success: ${member.lastSyncAt ?? 'never'}. ` +
          `Member has NOT been removed — manual action required.` +
          (hasChildren
            ? ` NOTE: this node has ${member.children!.length} child(ren) in a braintree network — its entire subtree is now partitioned from this brain until it comes back online.`
            : ''),
        );
      } else if (failures > STALE_FAILURE_THRESHOLD && failures % 10 === 0) {
        log.warn(`PEER STILL UNREACHABLE: '${member.label}' (${failures} consecutive failures, last success: ${member.lastSyncAt ?? 'never'})`);
      }
    }
  }

  log.info(`Sync cycle complete for '${net.label}': ${synced} ok, ${errors} errors`);
  syncTimer();

  // Calculate status once and share between Prometheus and sync history
  const status: 'success' | 'partial' | 'failed' =
    errors === 0 ? 'success' : synced === 0 && net.members.length > 0 ? 'failed' : 'partial';

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
  }).catch(err => log.error(`Failed to record sync history: ${err}`));

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
            `ORPHAN DETECTED: '${orphan.label}' (${orphan.instanceId}) in '${freshNet.label}' ` +
            `has parentInstanceId '${orphan.parentInstanceId}' which is not in the member list. ` +
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
        log.info(`Pruned ${removed} concluded+expired vote round(s) from network '${freshNet.label}'`);
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
      log.error(`sync_now failed for peer ${member.label} (${member.instanceId}) in network '${net.label}': ${err}`);
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
): Promise<{ pulled: SyncCounts; pushed: SyncCounts }> {
  const pulled: SyncCounts = { facts: 0, entities: 0, edges: 0, files: 0, chrono: 0, links: 0 };
  const pushed: SyncCounts = { facts: 0, entities: 0, edges: 0, files: 0, chrono: 0, links: 0 };
  const secrets = getSecrets();
  const peerToken = secrets.peerTokens[member.instanceId];
  if (!peerToken) {
    log.warn(`No peer token for ${member.label} (${member.instanceId}) — skipping sync`);
    return { pulled, pushed };
  }

  const cfg = getConfig();
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${peerToken}`,
    'Content-Type': 'application/json',
  };

  // Build fresh RequestInit per call so each fetch gets its own AbortSignal.
  // Sharing one AbortSignal.timeout() across sequential fetches starves later
  // requests because the timer starts at creation time, not at fetch time.
  const fetchOpts = (): RequestInit => ({
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  const batchFetchOpts = (): RequestInit => ({
    headers,
    signal: AbortSignal.timeout(BATCH_FETCH_TIMEOUT_MS),
  });

  // ── Presync warm-up ────────────────────────────────────────────────────
  // Ask the peer to eagerly warm its embedding model, bcrypt token cache,
  // and MongoDB collection handles BEFORE we start the real sync cycle.
  // The peer's POST /api/sync/warm returns only once everything is ready.
  // In parallel, warm our own local MongoDB collections.
  {
    const _tw = Date.now();
    const peerWarm = peerSafeFetch(`${member.url}/api/sync/warm`, {
      ...fetchOpts(),
      method: 'POST',
      body: JSON.stringify({ networkId: net.id, spaces: net.spaces }),
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
    await gossipWithPeer(net, member, headers, fetchOpts);
    await propagateVotesWithPeer(net, member, headers, fetchOpts);
  } catch (err) {
    log.warn(`Governance gossip with ${member.label} (${member.instanceId}): ${err}`);
  }

  /*
   * THE OUTBOUND HALF OF THE PEER FLOOR (`P-33` = B), and it must stay BELOW the gossip above.
   * Gossip is the only thing that learns a version, so checking first deadlocks: every member on a
   * fresh network reports nothing, absent is below the floor, and the exchange that would clear it
   * sits behind the refusal. Governance is deliberately not gated — see `sync/peer-floor.ts`.
   */
  assertPeerAtFloor(net.id, member.instanceId, member.version);

  // Pre-build reverse spaceMap (local → remote) for O(1) lookup per space
  // instead of the O(n) linear scan inside localToRemote().
  const reverseSpaceMap = new Map(
    Object.entries(net.spaceMap ?? {}).map(([remote, local]) => [local, remote]),
  );

  for (const spaceId of net.spaces) {
    // Resolve remote space ID for this local space — peers reference spaces by
    // their original (remote) ID, which may differ from our local ID when
    // spaceMap aliasing is active.
    const remoteSpaceId = reverseSpaceMap.get(spaceId) ?? spaceId;

    // Skip spaces that don't exist in local config — prevents orphan data and collection access
    // for space IDs that were registered on the network but never created locally.
    const cfg = getConfig();
    if (!cfg.spaces.some(s => s.id === spaceId && !s.proxyFor)) {
      log.warn(`Skipping sync for space '${spaceId}' in network '${net.label}': space not in local config`);
      continue;
    }

    // Push to this member if the direction allows it (push or both).
    // Pull from this member if bidirectional (both), or for non-directional networks.
    // Braintree/Pubsub with direction='push': parent/publisher pushes down, child/subscriber never pushes up.
    const isDirectional = net.type === 'braintree' || net.type === 'pubsub';
    const shouldPull = !isDirectional || member.direction === 'both' || member.direction === 'pull';
    const shouldPush = !isDirectional || member.direction === 'both' || member.direction === 'push';

    if (shouldPull) {
      const pc = await pullFromPeer(member, spaceId, remoteSpaceId, net.id, headers, fetchOpts, batchFetchOpts);
      pulled.facts += pc.facts; pulled.entities += pc.entities; pulled.edges += pc.edges; pulled.chrono += pc.chrono;
    }
    if (shouldPush) {
      const pc = await pushToPeer(member, spaceId, remoteSpaceId, net.id, headers, fetchOpts, batchFetchOpts);
      pushed.facts += pc.facts; pushed.entities += pc.entities; pushed.edges += pc.edges; pushed.chrono += pc.chrono;
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
                log.warn(`Face reprocess enqueue for ${spaceId}/${p}: ${err}`),
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

  return { pulled, pushed };
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
  headers: Record<string, string>,
  opts: () => RequestInit,
): Promise<void> {
  const cfg = getConfig();
  const base = `${member.url}/api/sync/networks/${encodeURIComponent(net.id)}`;

  // 1. Push self-record to peer
  try {
    // Determine our own public URL: prefer the INSTANCE_URL env var; fall back to empty
    // string so the peer keeps whatever URL it already has for us.
    const selfUrl = process.env['INSTANCE_URL'] ?? '';
    /*
     * `version` is on BOTH self-records — this one and the piggyback in `api/sync/members.ts`. They
     * are the two directions of one exchange, so a field on only one of them means a peer learns our
     * version when it calls us and never when we call it: the floor would then depend on who dialled.
     */
    const selfRecord: Record<string, unknown> = {
      instanceId: cfg.instanceId,
      label: cfg.instanceLabel,
      version: SERVER_VERSION,
      children: net.members
        .filter(m => m.parentInstanceId === cfg.instanceId)
        .map(m => m.instanceId),
    };
    if (selfUrl) selfRecord['url'] = selfUrl;
    const ownSigningKey = getSigningPublicKey();
    if (ownSigningKey) selfRecord['signingPublicKey'] = ownSigningKey;
    const ownRotation = getSigningKeyRotation();
    if (ownRotation) selfRecord['signingKeyRotation'] = ownRotation;
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
          const freshCfg = getConfig();
          const freshNet = freshCfg.networks.find(n => n.id === net.id);
          if (freshNet) {
            const local = freshNet.members.find(m => m.instanceId === member.instanceId);
            if (local) {
              let changed = false;
              if (peerSelf.url && peerSelf.url !== local.url) {
                if (isPeerUrlAllowed(peerSelf.url)) { local.url = peerSelf.url; changed = true; }
                else log.warn(`Gossip: rejected unsafe self-URL from ${member.label} (${member.instanceId}): ${peerSelf.url}`);
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
                log.info(`Gossip: updated ${member.label} via self-piggyback (${net.id})`);
                saveConfig(freshCfg);
              }
            }
          }
        }
      } catch { /* ignore JSON parse failures */ }
    } else {
      log.warn(`Gossip self-push to ${member.label}: HTTP ${resp.status}`);
    }
  } catch (err) {
    log.warn(`Gossip self-push to ${member.label}: ${err}`);
  }

  // 2. Pull peer's member view and merge into our config
  try {
    const resp = await peerSafeFetch(`${base}/members`, opts());
    if (!resp.ok) {
      log.warn(`Gossip pull from ${member.label}: HTTP ${resp.status}`);
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
        log.info(`Gossip: updated member ${local.label} (${local.instanceId}) in network ${net.id}`);
        changed = true;
      }
    }
    if (changed) saveConfig(fresh);
  } catch (err) {
    log.warn(`Gossip pull from ${member.label}: ${err}`);
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
  headers: Record<string, string>,
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
      log.warn(`Vote pull from ${member.label}: HTTP ${resp.status}`);
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
        const newRound: VoteRound = {
          ...(peerRound as VoteRound),
          votes: [],        // votes are merged below
          concluded: false,
        };
        freshNet.pendingRounds.push(newRound);
        local = newRound;
        changed = true;
        log.info(`Vote gossip: adopted round ${peerRound.roundId} (${peerRound.type}) from ${member.label}`);
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
            `Vote gossip: rejecting cast for '${peerCast.instanceId}' relayed by '${member.instanceId}' ` +
            `(round ${peerRound.roundId}) — ${decision.reason}`,
          );
          continue;
        }
        const idx = local.votes.findIndex(v => v.instanceId === peerCast.instanceId);
        if (idx >= 0) {
          // Only replace if the new cast changes the vote value; preserve the
          // signature that came with it.
          if (local.votes[idx]!.vote !== peerCast.vote || local.votes[idx]!.sig !== peerCast.sig) {
            local.votes[idx] = peerCast;
            changed = true;
          }
        } else {
          local.votes.push(peerCast);
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
          // For join rounds, add the held pending member on conclusion.
          // Braintree: only the direct parent (the node that opened the round)
          // admits — ancestor-voters must NOT add the joining node to their own
          // member list. Other vote-governed types: only the instance holding
          // the joiner's credentials admits (gossip-adopted round copies have
          // pendingMember.tokenHash stripped).
          if (justPassed && round.type === 'join' && round.pendingMember) {
            const alreadyAdded = freshNet.members.some(m => m.instanceId === round.subjectInstanceId);
            const mayAdmit = freshNet.type === 'braintree'
              ? (!round.pendingMember.parentInstanceId || round.pendingMember.parentInstanceId === fresh.instanceId)
              : Boolean(round.pendingMember.tokenHash);
            const vetoed = round.votes.some(v => v.vote === 'veto');
            if (!alreadyAdded && mayAdmit && !vetoed) {
              freshNet.members.push(round.pendingMember);
              log.info(`Join round ${round.roundId} concluded via gossip — added ${round.subjectLabel} to network ${net.id}`);
            }
          }
        }
      }
      // Space-scoped side-effects for rounds that just concluded — deletion and wipe. The gossip pass
      // concludes rounds nobody here voted on, so this is where a decision made elsewhere lands.
      applyConcludedSpaceRounds(freshNet.pendingRounds, 'gossip');
      saveConfig(fresh);
    }
  } catch (err) {
    log.warn(`Vote pull from ${member.label}: ${err}`);
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
          body: JSON.stringify({ vote: cast.vote, instanceId: cast.instanceId, sig: cast.sig, castAt: cast.castAt }),
        }).catch(err => log.warn(`Vote push (${round.roundId}) to ${member.label}: ${err}`));
      }
    }
  } catch (err) {
    log.warn(`Vote push to ${member.label}: ${err}`);
  }
}

// ── Pull (ingest from peer) ─────────────────────────────────────────────────

async function pullFromPeer(
  member: NetworkMember,
  spaceId: string,
  remoteSpaceId: string,
  networkId: string,
  headers: Record<string, string>,
  opts: () => RequestInit,
  batchOpts: () => RequestInit,
): Promise<{ facts: number; entities: number; edges: number; chrono: number; links: number }> {
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
  let overallMaxSeq = 0; // Track the highest seq seen across ALL items (used to bump local counter)

  type PullResult = { count: number; highSeq: number; maxSeq: number } & TransferOutcome;
  /*
   * NOT ALL BRAIN COLLECTIONS: `files` is absent because a file arrives as blob plus manifest, not as a
   * document on this path. `links` is present — a collection missing here is one a peer never sends us,
   * and nothing reports that, because a peer holding no links hashes none either.
   */
  async function pullType<T extends FactDoc | EntityDoc | EdgeDoc | ChronoEntry | LinkDoc | (FileMetaDoc & { seq: number })>(
    urlSuffix: string,
  ): Promise<PullResult> {
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
        log.warn(truncationWarn(`Pull ${urlSuffix} from`, member.label ?? '', spaceId, resp.status, deliveredThrough));
        break;
      }
      const { items, nextCursor } = await boundedJson<{
        items: (T | { _id: string; seq: number; deletedAt: string })[]; nextCursor: string | null;
      }>(resp, 'sync peer');
      // Collect the applyable docs for this page, then upsert them in one batch (P3).
      const pageDocs: T[] = [];
      for (const item of items) {
        if ('deletedAt' in item && (item as { deletedAt?: string }).deletedAt) continue;
        const doc = item as T;
        // Refuse a document whose seq is too close to the protocol ceiling:
        // ingesting it would drag the counter there via the bumpSeq below,
        // eventually making our own writes unsyncable (see util/seq.ts).
        if (isSeqImplausible((doc as FactDoc).seq)) {
          log.warn(
            `Pull ${urlSuffix} from ${member.label}: skipped doc '${(doc as FactDoc)._id}' ` +
            `with implausible seq ${(doc as FactDoc).seq} in space '${spaceId}'.`,
          );
          continue;
        }
        /*
         * THE RECEIVER DECIDES WHAT IT STORES, and this is the one place on the pull path where it can.
         *
         * The push path drops these by omission — no `Incoming*` schema declares one, so zod strips them
         * — and this path validates nothing at all: it fetches `full=true` and `replaceOne`s what comes
         * back. Without the strip a pulled record carried the sender's vector, which ranks plausibly and
         * in the wrong order, and the sender's `_expireAt`, which `brain/ttl-sweep.ts` acts on — so a peer
         * decided when THIS instance deleted its data, with nothing logged either side.
         */
        pageDocs.push(stripLocalOnly(doc));
        count++;
        if ((doc as FactDoc).seq > maxSeq) maxSeq = (doc as FactDoc).seq;
        if ((doc as FactDoc).seq > highSeq && (doc as FactDoc).author?.instanceId === member.instanceId) {
          highSeq = (doc as FactDoc).seq;
        }
      }
      await batchUpsertBySeq<T>(`${spaceId}_${urlSuffix}`, pageDocs, spaceId);
      // Only after the page is APPLIED. Recording it before the upsert would vouch for records that a throw
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
      log.warn(truncationWarn(`Pull ${urlSuffix} from`, member.label ?? '', spaceId, `${pg}-page cap`, deliveredThrough));
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
    pulled[family.payloadKey] = await pullType(family.payloadKey);
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
  highestSeq = resolveWatermark({
    direction: 'receive', peerLabel: member.label ?? member.instanceId, spaceId,
    from: sinceSeq,
    transfers: pulled,
    // Bounds the advance, never raises it: a tombstone seq is not a position in the data stream.
    alsoCheck: { tombstones },
    seqOf: (t) => t.highSeq,
    warn: log.warn,
  });
  // TOMBSTONES ARE IN THIS MAX, and their absence was a silent record-loss bug rather than an omission.
  //
  // The bump below exists so local writes always sort above anything received from this peer. A tombstone IS
  // received from this peer and carries the deleting instance's seq — so excluding it left a quiet peer's
  // counter behind a busy peer's deletions, and a record re-created there (same id, lower seq) was refused
  // by every peer holding the tombstone, permanently, with a 200 the sender reads as success.
  //
  // The watermark line above passes every transfer and says why an omitted one is the dangerous one. This
  // is the same argument about the same transfer, one line down.
  //
  // AND IT WAS A THIRD HAND-WRITTEN LIST, missing file metadata. `filemeta` is in `transfers` and was
  // absent here, so a file-meta record arriving with a high seq left the local counter below it — and the
  // next local write could take a seq beneath a record already received, which is the exact failure the
  // bump exists to prevent. Derived from the same object now, so there is one enumeration for all three
  // uses.
  overallMaxSeq = Math.max(...Object.values(pulled).map(t => t.maxSeq), tombstones.maxSeq);

  // Bump the local seq counter so future local writes always get a seq higher
  // than any document received from this peer.  Without this, sync-upserted docs
  // with high seq values from the source instance would sit above the local
  // counter, causing newly written docs to get a lower seq that the pull
  // watermark has already advanced past.
  if (overallMaxSeq > 0) {
    await bumpSeq(spaceId, overallMaxSeq);
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
    links: pulledLinks,
  };
}

// ── Push (upload our changes to peer) ──────────────────────────────────────

async function pushToPeer(
  member: NetworkMember,
  spaceId: string,
  remoteSpaceId: string,
  networkId: string,
  headers: Record<string, string>,
  opts: () => RequestInit,
  batchOpts: () => RequestInit,
): Promise<{ facts: number; entities: number; edges: number; chrono: number; links: number }> {
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
  ): Promise<{ pushed: number; maxSeq: number } & TransferOutcome> {
    let pushed = 0;
    let localMaxSeq = lastSeqPushed;
    let seqCursor = lastSeqPushed;
    let truncated = false;
    while (true) {
      const batch = await col<T>(collName)
        .find(asFilter<T>({ seq: { $gt: seqCursor }, ...ownedFilter, ...extraFilter }))
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
      log.debug(`Push ${payloadKey} to ${member.label ?? member.instanceId} space '${spaceId}': `
        + `${batch.length} doc(s) with seq > ${seqCursor}`
        + (batch.length ? ` (through ${(batch[batch.length - 1] as FactDoc).seq})` : ''));
      if (batch.length === 0) break;
      const resp = await peerSafeFetch(batchEndpoint, {
        ...batchOpts(), method: 'POST',
        body: JSON.stringify({ [payloadKey]: batch }),
      });
      if (!resp.ok) {
        truncated = true;
        log.warn(truncationWarn(`Batch push ${payloadKey} to`, member.label ?? '', spaceId, resp.status, seqCursor));
        break;
      }
      // A 200 does not mean every record landed: the peer can discard a fact whose fork chain is at its
      // cap and still answer 200. `sync/push-refusals.ts` says what that costs and why the watermark still
      // advances anyway.
      await reportPushRefusals(resp, payloadKey, member.label ?? member.instanceId, spaceId);
      pushed += batch.length;
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
    return { pushed, maxSeq: localMaxSeq, deliveredThrough: seqCursor, truncated };
  }

  // Sequential for the same reason as the pull, and the parents-only filter comes from the row rather
  // than from a special case here — see `REPLICATED_FAMILIES`.
  const pushed = {} as Record<PayloadKey, { pushed: number; maxSeq: number } & TransferOutcome>;
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
  maxSeqPushed = resolveWatermark({
    direction: 'push', peerLabel: member.label ?? member.instanceId, spaceId,
    from: lastSeqPushed,
    transfers: pushed,
    alsoCheck: { tombstones },
    seqOf: (t) => t.maxSeq,
    warn: log.warn,
  });

  /*
   * The other half of the X-20 instrumentation: what the cycle DECIDED, beside what it found.
   *
   * A watermark that moves while every transfer reported zero documents is the shape that would explain the
   * stall — the cursor advancing past a record nothing sent, after which every later cycle correctly finds
   * nothing and the record is never offered again. That combination is invisible without both numbers in one
   * line, which is why they are logged together rather than at four separate call sites.
   */
  log.debug(`Push cycle to ${member.label ?? member.instanceId} space '${spaceId}': watermark ${lastSeqPushed} -> `
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
    links: pushedLinks,
  };
}

// ── File sync ──────────────────────────────────────────────────────────────

async function syncFiles(
  member: NetworkMember,
  spaceId: string,
  remoteSpaceId: string,
  networkId: string,
  headers: Record<string, string>,
  opts: () => RequestInit,
  doPull = true,
  doPush = true,
): Promise<{ pulledFiles: number; pushedFiles: number; pulledPaths: string[] }> {
  let pulledFiles = 0, pushedFiles = 0;
  const pulledPaths: string[] = [];
  try {
    // ── 1. Apply peer's file tombstones (deletions) first ─────────────────
    // Fetch tombstones before the manifest so that files deleted on the peer
    // are removed locally before the manifest comparison runs.
    if (doPull) try {
      const tsResp = await peerSafeFetch(
        `${member.url}/api/sync/file-tombstones?spaceId=${encodeURIComponent(remoteSpaceId)}&networkId=${encodeURIComponent(networkId)}`,
        opts(),
      );
      if (tsResp.ok) {
        const { tombstones } = await boundedJson<{ tombstones: { path: string }[] }>(tsResp, 'sync peer');
        const spaceDataRoot = getDataRoot();
        const spaceFiles = path.resolve(spaceDataRoot, 'files', spaceId);
        for (const ts of tombstones) {
          try {
            // Normalise to prevent path traversal (sandbox-safe relative path).
            const rel = toSafeRelPath(ts.path);
            const abs = path.join(spaceFiles, rel);
            if (!abs.startsWith(spaceFiles + path.sep) && abs !== spaceFiles) continue;
            await fs.unlink(abs).catch(() => { /* already gone — ignore */ });
            await deleteFileMeta(spaceId, rel).catch(() => { /* best-effort */ });
          } catch { /* ignore per-file errors */ }
        }
      } else {
        log.warn(`File tombstones from ${member.label}: ${tsResp.status}`);
      }
    } catch (err) {
      // Tombstone fetch is best-effort; continue with manifest sync.
      log.warn(`File tombstone fetch from ${member.label}: ${err}`);
    }

    // ── 1b. Push our file tombstones to the peer ──────────────────────────
    // Files we deleted locally must be propagated to the peer so they disappear there too.
    if (doPush) try {
      const ourTombstones = await col<FileTombstoneDoc>(spaceCollection(spaceId, 'fileTombstones'))
        .find(asFilter<FileTombstoneDoc>({ spaceId }))
        .toArray();
      if (ourTombstones.length > 0) {
        const ackResp = await peerSafeFetch(
          `${member.url}/api/sync/file-tombstones?networkId=${encodeURIComponent(networkId)}`,
          {
            ...opts(),
            method: 'POST',
            body: JSON.stringify({ spaceId: remoteSpaceId, tombstones: ourTombstones }),
          },
        );
        // A 200 is a real acknowledgement, and it used to be thrown away. The peer upserts every tombstone it
        // receives and re-propagates it onward, so a 200 proves this peer now holds them — which is what lets us
        // drop ours (see `sync/file-tombstone-ack.ts`). The position is taken from the array we actually SENT,
        // never from a fresh query: a file deleted between building this body and reading the response was not in
        // the payload, and counting it as delivered would drop a tombstone no peer has seen.
        //
        // Anything other than 200 acknowledges nothing. A 403 means a direction-blocked peer that will never
        // accept our tombstones, and pruning on a rejected push is precisely how a deleted file comes back.
        if (ackResp.ok) {
          recordFileTombstoneAck(member.instanceId, spaceId, ackedPositionFrom(ourTombstones));
        } else {
          log.debug(`Push file tombstones to ${member.label}: ${ackResp.status} — position not advanced`);
        }
      }
    } catch (err) {
      log.warn(`Push file tombstones to ${member.label}: ${err}`);
    }

    // ── 2. Fetch peer manifest and download new/changed files ─────────────
    // Only fetch the peer manifest if we need to pull or push (manifest comparison
    // drives both directions). When neither direction needs manifest, skip entirely.
    if (!doPull && !doPush) return { pulledFiles, pushedFiles, pulledPaths };
    const resp = await peerSafeFetch(`${member.url}/api/sync/manifest?spaceId=${encodeURIComponent(remoteSpaceId)}&networkId=${encodeURIComponent(networkId)}`, opts());
    if (!resp.ok) { log.warn(`File manifest from ${member.label}: ${resp.status}`); return { pulledFiles, pushedFiles, pulledPaths }; }
    const { manifest } = await boundedJson<{ manifest: { path: string; sha256: string; size: number; modifiedAt: string }[] }>(resp, 'sync peer');

    // Build our manifest for comparison
    const ours = await buildFileManifest(spaceId);
    const oursMap = new Map(ours.map(e => [e.path, e]));

    const dataRoot = getDataRoot();
    const spaceRoot = path.resolve(dataRoot, 'files', spaceId);

    if (doPull) for (const remote of manifest) {
      const local = oursMap.get(remote.path);
      // See ./file-conflict.ts — a file has no `seq`, so a differing hash cannot be resolved by
      // last-writer-wins the way records are. Ours is kept and theirs lands beside it.
      const action = decideFilePull(local, remote);
      if (action === 'skip') continue;

      try {
        /*
         * Whole-file body, so it gets the TRANSFER budget — and until now it did not, whatever this
         * comment said.
         *
         * `opts()` is the control-plane request init and already carries `signal:
         * AbortSignal.timeout(FETCH_TIMEOUT_MS)`. `peerSafeFetch` resolves `init.signal ??
         * AbortSignal.timeout(opts.timeoutMs)`, so the caller's signal WON and the transfer budget beside
         * it was dead code. The effective ceiling was ten seconds — not the thirty this comment assumed —
         * so any file whose body took longer than that aborted, logged, and was retried identically on
         * every cycle, for ever. Large files simply never replicated.
         *
         * `transferInit` strips the control-plane deadline, and it lives in `peer-fetch.ts` because that
         * file owns what each budget is for — stripping it by hand here would be a second copy of the
         * decision that was wrong the first time.
         */
        const dl = await peerSafeFetch(
          `${member.url}/api/files/${encodeURIComponent(remoteSpaceId)}?path=${encodeURIComponent(remote.path)}`,
          transferInit(opts()),
          { timeoutMs: PEER_TRANSFER_TIMEOUT_MS },
        );
        if (!dl.ok) { log.warn(`DL file ${remote.path} from ${member.label}: ${dl.status}`); continue; }
        const buf = Buffer.from(await dl.arrayBuffer());
        const sha = createHash('sha256').update(buf).digest('hex');
        if (sha !== remote.sha256) { log.warn(`SHA mismatch for ${remote.path} from ${member.label}`); continue; }

        pulledFiles++;
        if (!local) {
          // File is new locally — write directly to the original path
          const absPath = path.join(spaceRoot, remote.path);
          await fs.mkdir(path.dirname(absPath), { recursive: true });
          await fs.writeFile(absPath, buf);
          await upsertFileMeta(spaceId, remote.path, buf.length).catch(() => { /* best-effort */ });
          pulledPaths.push(remote.path);
        } else {
          // File exists locally with a different hash — keep local, save incoming
          // under a conflict-copy name so the user can decide which version to keep.
          // The peer's label reaches a filesystem path, so it is sanitised there — see
          // ./file-conflict.ts for why that is an allowlist rather than a strip-list.
          const conflictRelPath = conflictCopyPath(remote.path, member.label, new Date());
          const absConflictPath = path.join(spaceRoot, conflictRelPath);
          await fs.mkdir(path.dirname(absConflictPath), { recursive: true });
          await fs.writeFile(absConflictPath, buf);

          // Persist a conflict record so the UI can surface it to the user
          const conflictDoc: ConflictDoc = {
            _id: uuidv4(),
            spaceId,
            originalPath: remote.path,
            conflictPath: conflictRelPath,
            peerInstanceId: member.instanceId,
            peerInstanceLabel: member.label,
            detectedAt: new Date().toISOString(),
          };
          await col<ConflictDoc>(spaceCollection(spaceId, 'conflicts')).insertOne(asDoc<ConflictDoc>(conflictDoc));

          log.warn(
            `FILE_CONFLICT: '${remote.path}' from peer '${member.label}' differs from local copy. ` +
            `Conflict copy saved as '${conflictRelPath}'. Resolve in Settings → Conflicts.`,
          );
        }
      } catch (err) {
        log.warn(`File sync error for ${remote.path}: ${err}`);
      }
    }

    // ── 3. Push our files that the peer doesn't have or that we have updated ─
    // • Peer doesn't have the file at all → push new
    // • Peer has an older version (our modifiedAt > peer modifiedAt) → push update
    // • Peer is at same version or newer → skip (pull step handled that)
    if (doPush) {
    const peerManifestMap = new Map(manifest.map(e => [e.path, e]));
    for (const [localPath, localEntry] of oursMap) {
      const peerEntry = peerManifestMap.get(localPath);
      if (peerEntry) {
        if (localEntry.sha256 === peerEntry.sha256) continue; // already in sync
        if (localEntry.modifiedAt <= peerEntry.modifiedAt) continue; // peer is same age or newer
        // fall through — our version is newer, push the update
      }
      try {
        const absPath = path.join(spaceRoot, localPath);
        const bytes = await fs.readFile(absPath);
        const pushResp = await peerSafeFetch(
          `${member.url}/api/files/${encodeURIComponent(remoteSpaceId)}?path=${encodeURIComponent(localPath)}`,
          {
            method: 'POST',
            headers: {
              Authorization: headers['Authorization'],
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(bytes.length),
            },
            body: bytes,
            // Whole-file body: BATCH_FETCH_TIMEOUT_MS is a control-plane budget and would abort any
            // upload slower than a minute. Same reasoning as the download below-- see
            // PEER_TRANSFER_TIMEOUT_MS.
            signal: AbortSignal.timeout(PEER_TRANSFER_TIMEOUT_MS),
          },
        );
        if (!pushResp.ok) {
          log.warn(`Push file '${localPath}' to ${member.label}: HTTP ${pushResp.status}`);
        } else {
          pushedFiles++;
        }
      } catch (err) {
        log.warn(`Push file '${localPath}' to ${member.label}: ${err}`);
      }
    }
    } // end doPush
  } catch (err) {
    log.warn(`syncFiles for ${member.label} space ${spaceId}: ${err}`);
  }
  return { pulledFiles, pushedFiles, pulledPaths };
}

// ── Local upsert helpers ────────────────────────────────────────────────────

/**
 * Apply a page of pulled docs to a local collection with last-writer-wins-by-seq
 * semantics, in a bounded number of round trips (P3). Instead of a findOne+replaceOne
 * per doc (2×N round trips per page), this loads every existing seq for the page in one
 * `find({_id: {$in}})` and applies the survivors in one `bulkWrite`. The seq comparison
 * stays strictly greater-than, so conflict resolution is identical to the old per-doc path.
 */
async function batchUpsertBySeq<T extends { _id: string; seq: number }>(
  collName: string,
  docs: T[],
  localSpaceId: string,
): Promise<void> {
  if (docs.length === 0) return;

  // See ./upsert-plan.ts for why re-tagging is load-bearing and why the seq comparison is strict.
  retagToLocalSpace(docs, localSpaceId);

  const collection = col<T>(collName);
  const ids = docs.map(d => d._id);
  const existing = await collection
    .find(asFilter<T>({ _id: { $in: ids } as unknown as string }), { projection: { _id: 1, seq: 1 } })
    .toArray() as Array<{ _id: string; seq: number }>;
  const existingSeq = new Map(existing.map(e => [e._id, e.seq]));

  const toWrite = planSeqUpserts(docs, existingSeq);
  if (toWrite.length === 0) return;

  /*
   * UNORDERED, AND A DUPLICATE KEY IS A RECORD-LEVEL FAULT.
   *
   * `_edges` carries a unique index on `(from, to, label)` and new edges get a `uuidv4()` `_id`, while ingest
   * is keyed on `_id` alone and never consults the triplet. So two peers that independently create the same
   * relationship hold two ids for one unique key, and the first to cross the wire raises `E11000`.
   *
   * This used to be an unguarded, ORDERED `bulkWrite`, and the consequences were entirely out of proportion to
   * the cause. Ordered meant every later document in the page was abandoned. Unguarded meant the error escaped
   * `pullType` before `deliveredThrough` was written, escaped `pullFromPeer` before the watermark persisted,
   * escaped the space loop — **taking every remaining space with it, including files** — and landed in the
   * member-level catch, which increments the failure count and eventually prints `PEER UNREACHABLE`.
   * `lastSyncAt` was never written, so the next cycle pulled the identical page and threw identically: one
   * duplicate edge stopped a member syncing permanently, and pointed the operator at the network.
   *
   * Now: `ordered: false` so the rest of the page applies, and the duplicates are reported as the records they
   * are. Only duplicate-key errors are absorbed — any other write fault still throws, because swallowing those
   * would hide genuine corruption, which is the opposite defect.
   */
  /*
   * A FILE'S METADATA IS MERGED, NOT REPLACED — the one collection this bulk path may not touch.
   *
   * The receiver derived `sizeBytes`, `sha256`, the excerpt, the vector and the chunk count from bytes it
   * holds. A `replaceOne` would leave the file reporting the SENDER's size and hash with no vector at all.
   *
   * The applier lives in `api/sync/_shared.ts` beside `ingestFileMeta`, not here: the PUSH path already
   * uses that function, and a second merge in the engine would be one rule with two implementations —
   * the weaker being whichever direction nobody tested. It is also what the god-file ratchet on this file
   * asks for, and the reason it asks.
   */
  if (collName.endsWith('_files')) {
    await applyFileMetaPage(localSpaceId, toWrite as never);
    return;
  }

  try {
    await collection.bulkWrite(asBulk<T>(
      toWrite.map(doc => ({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } })),
    ), { ordered: false });
  } catch (err) {
    const writeErrors = (err as { writeErrors?: Array<{ code?: number; err?: { code?: number; op?: unknown } }> })?.writeErrors;
    if (!Array.isArray(writeErrors) || writeErrors.length === 0) throw err;
    const codeOf = (w: { code?: number; err?: { code?: number } }) => w.code ?? w.err?.code;
    const nonDuplicate = writeErrors.filter(w => codeOf(w) !== 11000);
    if (nonDuplicate.length > 0) throw err;
    log.warn(
      `sync: ${writeErrors.length} duplicate-key rejection(s) applying '${collName}' for space `
      + `'${localSpaceId}'. Every other document in the page was applied. A duplicate means two peers created `
      + `the same uniquely-indexed record independently; the local copy is kept and the incoming one is not `
      + `applied. Ids: ${writeErrors.map(w => {
        const op = (w.err as { op?: { _id?: unknown } } | undefined)?.op;
        return typeof op?._id === 'string' ? op._id : '(unknown)';
      }).slice(0, 10).join(', ')}`,
    );
  }

  /*
   * The link records for PULLED documents — the sync direction that does NOT go through `ingestBrainDoc`.
   *
   * Push arrives at `api/sync/_shared.ts`, which is the ingest router's only write door and carries the same
   * call. Pull lands here instead, in a `bulkWrite` of its own, so the hook has to exist twice — and this is
   * the copy that would have been forgotten, because the push side is the one anybody pictures. Left out, a
   * space that only ever PULLS would hold arrays with no link records at all.
   *
   * One line because the ratchet on this file asked for it: the first version put the collection-to-kind
   * lookup and the loop here, and both belong with the rest of the link logic rather than in the engine.
   */
  await reconcileLinksForPage(localSpaceId, collName.slice(localSpaceId.length + 1), toWrite);
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
      log.warn(`Merkle check for space '${spaceId}' with peer '${member.label}': peer returned HTTP ${peerResp.status} — skipping`);
      return;
    }

    const peerResult = await boundedJson<{ root?: string; leafCount?: number }>(peerResp, 'sync peer');
    const peerRoot = peerResult.root;

    if (!peerRoot) {
      log.warn(`Merkle check for space '${spaceId}' with peer '${member.label}': peer response missing 'root' field`);
      return;
    }

    if (localResult.root !== peerRoot) {
      log.warn(
        `MERKLE_DIVERGENCE: space '${spaceId}', peer '${member.label}' (${member.instanceId}), ` +
        `network '${net.label}'. ` +
        `local root=${localResult.root} (${localResult.leafCount} leaves), ` +
        `peer root=${peerRoot} (${peerResult.leafCount ?? '?'} leaves). ` +
        `The space contents differ after sync — possible data loss, concurrent write, or sync bug.`,
      );
    } else {
      log.info(`Merkle OK: space '${spaceId}', peer '${member.label}' root=${localResult.root.slice(0, 12)}…`);
    }
  } catch (err) {
    log.warn(`Merkle check for space '${spaceId}' with peer '${member.label}': ${err}`);
  }
}
