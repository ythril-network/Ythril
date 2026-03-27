/**
 * Outbound sync engine.
 *
 * For each network that has at least one member, this engine:
 * 1. Calls /api/sync/* on each peer to pull their changes into us
 * 2. Calls /api/sync/* on each peer to push our changes to them
 *    (push is symmetric — we push to peers; peers pull from us)
 *
 * The engine is triggered either by a cron schedule (per network) or
 * explicitly via POST /api/sync/trigger (manual).
 *
 * Braintree topology:
 * - Nodes with direction='push' only receive from their parent; never push up.
 * - When a node runs sync for a braintree network, it pushes down to its children
 *   and pulls from its parent.
 */

import { getConfig, saveConfig, getSecrets } from '../config/loader.js';
import { col } from '../db/mongo.js';
import { applyRemoteTombstone, listTombstones } from '../brain/tombstones.js';
import { recordSyncResult, type SyncCounts } from './history.js';
import { buildFileManifest } from '../files/manifest.js';
import { log } from '../util/log.js';
import { bumpSeq } from '../util/seq.js';
import { concludeRoundIfReady, sendMemberRemovedNotify } from '../api/sync.js';
import {
  syncCyclesTotal,
  syncItemsPulledTotal,
  syncItemsPushedTotal,
  syncDurationSeconds,
} from '../metrics/registry.js';
import type {
  NetworkConfig,
  NetworkMember,
  MemoryDoc,
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
import { v4 as uuidv4 } from 'uuid';

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

// ── Cron scheduler ─────────────────────────────────────────────────────────

const _scheduledTimers = new Map<string, ReturnType<typeof setInterval>>();

/** Start cron-based sync for all networks that have a syncSchedule.
 *  Call this from index.ts after spaces are initialised. */
export function startSyncScheduler(): void {
  const cfg = getConfig();
  for (const net of cfg.networks) {
    scheduleSyncForNetwork(net.id, net.syncSchedule);
  }
  log.debug(`Sync scheduler started (${cfg.networks.length} networks)`);
}

/** Stop all scheduled timers */
export function stopSyncScheduler(): void {
  for (const [id, timer] of _scheduledTimers) {
    clearInterval(timer);
    log.debug(`Sync scheduler stopped for network ${id}`);
  }
  _scheduledTimers.clear();
}

/** Schedule (or reschedule) sync for a network */
export function scheduleSyncForNetwork(networkId: string, schedule?: string): void {
  const old = _scheduledTimers.get(networkId);
  if (old) { clearInterval(old); _scheduledTimers.delete(networkId); }

  if (!schedule) return;

  // Parse simple schedule: "*/N minutes" or "*/N hours"
  // Full cron parsing out of scope — we parse the two most common patterns
  const intervalMs = parseSyncSchedule(schedule);
  if (!intervalMs) {
    log.warn(`Unrecognised sync schedule '${schedule}' for network ${networkId} — using manual sync only`);
    return;
  }

  const timer = setInterval(() => {
    runSyncForNetwork(networkId).catch(err =>
      log.error(`Scheduled sync failed for network ${networkId}: ${err}`),
    );
  }, intervalMs);

  _scheduledTimers.set(networkId, timer);
  log.info(`Sync scheduled for network ${networkId} every ${intervalMs / 1000}s`);
}

// Parse cron-style schedule patterns: "* /N minutes", "every Nm", "every Nh"
// (space deliberately added above to avoid TS parsing as block comment end)
function parseSyncSchedule(s: string): number | null {
  // Build pattern using constructor to avoid TS lexer confusion with "*/"
  const cronPattern = new RegExp(String.raw`\*/(\d+)\s*(min(?:utes?)?|h(?:ours?)?)`, 'i');
  const m = cronPattern.exec(s) ?? /every\s+(\d+)\s*(m(?:in)?|h(?:r?)?)/i.exec(s);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  const unit = m[2]!.toLowerCase();
  const isHours = unit.startsWith('h');
  return n * (isHours ? 3_600_000 : 60_000);
}

// ── Per-network sync ────────────────────────────────────────────────────────

/** Increment the consecutive failure counter for a member and persist it. Returns new count. */
function _incrementFailureCount(networkId: string, instanceId: string): number {
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  const member = net?.members.find(m => m.instanceId === instanceId);
  if (!member) return 1;
  member.consecutiveFailures = (member.consecutiveFailures ?? 0) + 1;
  saveConfig(cfg);
  return member.consecutiveFailures;
}

/** Reset (or set) the consecutive failure counter for a member and persist it. */
function _persistFailureCount(networkId: string, instanceId: string, value: number): void {
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  const member = net?.members.find(m => m.instanceId === instanceId);
  if (!member) return;
  member.consecutiveFailures = value;
  saveConfig(cfg);
}

/** Run a full sync cycle for a network: iterate members and sync each space. */
export async function runSyncForNetwork(networkId: string): Promise<{ synced: number; errors: number }> {
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  if (!net) throw new Error(`Network ${networkId} not found`);

  const triggeredAt = new Date().toISOString();
  const pulled: SyncCounts = { memories: 0, entities: 0, edges: 0, files: 0, chrono: 0 };
  const pushed: SyncCounts = { memories: 0, entities: 0, edges: 0, files: 0, chrono: 0 };
  const errorMessages: string[] = [];

  log.info(`Starting sync cycle for network '${net.label}' (${net.members.length} members)`);
  let synced = 0; let errors = 0;
  const syncTimer = syncDurationSeconds.startTimer({ network: networkId });

  for (const member of net.members) {
    try {
      const counts = await runSyncForMember(net, member);
      pulled.memories += counts.pulled.memories;
      pulled.entities += counts.pulled.entities;
      pulled.edges += counts.pulled.edges;
      pulled.files += counts.pulled.files;
      pulled.chrono += counts.pulled.chrono;
      pushed.memories += counts.pushed.memories;
      pushed.entities += counts.pushed.entities;
      pushed.edges += counts.pushed.edges;
      pushed.files += counts.pushed.files;
      pushed.chrono += counts.pushed.chrono;
      synced++;
      // Reset failure counter on success
      _persistFailureCount(net.id, member.instanceId, 0);

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
      const failures = _incrementFailureCount(net.id, member.instanceId);
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
  for (const type of ['memories', 'entities', 'edges', 'files', 'chrono'] as const) {
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
      _persistFailureCount(net.id, member.instanceId, 0);
    } catch (err) {
      log.error(`sync_now failed for peer ${member.label} (${member.instanceId}) in network '${net.label}': ${err}`);
      errors++;
      _incrementFailureCount(net.id, member.instanceId);
    }
  }
  return { networksSynced, errors, notFound: false };
}

/** Sync a single member across all network spaces. */
async function runSyncForMember(
  net: NetworkConfig,
  member: NetworkMember,
): Promise<{ pulled: SyncCounts; pushed: SyncCounts }> {
  const pulled: SyncCounts = { memories: 0, entities: 0, edges: 0, files: 0, chrono: 0 };
  const pushed: SyncCounts = { memories: 0, entities: 0, edges: 0, files: 0, chrono: 0 };
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

  const fetchOpts: RequestInit = {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    // Node 18/22 fetch doesn't support skipTlsVerify natively.
    // For skipTlsVerify, we use an undici dispatcher via env override only in non-prod.
    // Production environments use trusted certs — skipTlsVerify is a dev-only escape hatch.
  };

  const batchFetchOpts: RequestInit = {
    headers,
    signal: AbortSignal.timeout(BATCH_FETCH_TIMEOUT_MS),
  };

  for (const spaceId of net.spaces) {
    // Push to this member if the direction allows it (push or both).
    // Pull from this member if bidirectional (both), or for non-braintree networks.
    // Braintree with direction='push': parent pushes down, child never pushes up.
    const isBraintree = net.type === 'braintree';
    const shouldPull = member.direction === 'both' || !isBraintree;
    const shouldPush = member.direction === 'both' || member.direction === 'push';

    if (shouldPull) {
      const pc = await pullFromPeer(member, spaceId, net.id, headers, fetchOpts, batchFetchOpts);
      pulled.memories += pc.memories; pulled.entities += pc.entities; pulled.edges += pc.edges; pulled.chrono += pc.chrono;
    }
    if (shouldPush) {
      const pc = await pushToPeer(member, spaceId, net.id, headers, fetchOpts, batchFetchOpts);
      pushed.memories += pc.memories; pushed.entities += pc.entities; pushed.edges += pc.edges; pushed.chrono += pc.chrono;
    }

    // Sync file manifest
    const fc = await syncFiles(member, spaceId, net.id, headers, fetchOpts);
    pulled.files += fc.pulledFiles; pushed.files += fc.pushedFiles;

    // Merkle integrity check (opt-in: network.merkle === true)
    if (net.merkle) {
      await checkMerkleWithPeer(net, member, spaceId, fetchOpts);
    }
  }

  // ── Gossip: member list exchange + vote propagation ──────────────────────
  // 1. Push our own self-record to this peer so it stays current on our URL/label.
  // 2. Pull the peer's view of the member list; update our local records.
  // 3. Push our open vote casts to the peer.
  // 4. Pull the peer's open rounds and votes; merge any new rounds or casts.
  await gossipWithPeer(net, member, headers, fetchOpts);
  await propagateVotesWithPeer(net, member, headers, fetchOpts);

  // Update lastSyncAt
  const freshCfg = getConfig();
  const freshNet = freshCfg.networks.find(n => n.id === net.id);
  const m = freshNet?.members.find(m => m.instanceId === member.instanceId);
  if (m) { m.lastSyncAt = new Date().toISOString(); saveConfig(freshCfg); }

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
  opts: RequestInit,
): Promise<void> {
  const cfg = getConfig();
  const base = `${member.url}/api/sync/networks/${encodeURIComponent(net.id)}`;

  // 1. Push self-record to peer
  try {
    // Determine our own public URL: prefer the INSTANCE_URL env var; fall back to empty
    // string so the peer keeps whatever URL it already has for us.
    const selfUrl = process.env['INSTANCE_URL'] ?? '';
    const selfRecord: Record<string, unknown> = {
      instanceId: cfg.instanceId,
      label: cfg.instanceLabel,
      children: net.members
        .filter(m => m.parentInstanceId === cfg.instanceId)
        .map(m => m.instanceId),
    };
    if (selfUrl) selfRecord['url'] = selfUrl;
    const resp = await fetch(`${base}/members`, {
      ...opts,
      method: 'POST',
      body: JSON.stringify(selfRecord),
    });
    if (resp.ok) {
      // Peer may piggyback its own self-record in the response so we can update our entry for it
      try {
        const body = await resp.json() as { status: string; self?: Partial<NetworkMember> };
        const peerSelf = body.self;
        if (peerSelf?.instanceId === member.instanceId) {
          const freshCfg = getConfig();
          const freshNet = freshCfg.networks.find(n => n.id === net.id);
          if (freshNet) {
            const local = freshNet.members.find(m => m.instanceId === member.instanceId);
            if (local) {
              let changed = false;
              if (peerSelf.url && peerSelf.url !== local.url) { local.url = peerSelf.url; changed = true; }
              if (peerSelf.label && peerSelf.label !== local.label) { local.label = peerSelf.label; changed = true; }
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
    const resp = await fetch(`${base}/members`, opts);
    if (!resp.ok) {
      log.warn(`Gossip pull from ${member.label}: HTTP ${resp.status}`);
      return;
    }
    const { members: peerView } = await resp.json() as { members: Partial<NetworkMember>[] };
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
      if (peerRecord.url && peerRecord.url !== local.url) {
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
  opts: RequestInit,
): Promise<void> {
  const base = `${member.url}/api/sync/networks/${encodeURIComponent(net.id)}`;

  // 1. Push our open votes to the peer (non-fatal 404 if peer doesn't have the round yet)
  try {
    const cfg = getConfig();
    const localNet = cfg.networks.find(n => n.id === net.id);
    // Include all rounds — not just open ones — so that a vote that immediately concludes a
    // round on this instance (e.g. a final yes or a veto) still propagates to peers that
    // haven't yet received the concluding cast.
    const roundsToPush = localNet?.pendingRounds ?? [];
    for (const round of roundsToPush) {
      for (const cast of round.votes) {
        await fetch(`${base}/votes/${encodeURIComponent(round.roundId)}`, {
          ...opts,
          method: 'POST',
          body: JSON.stringify({ vote: cast.vote, instanceId: cast.instanceId }),
        }).catch(err => log.warn(`Vote push (${round.roundId}) to ${member.label}: ${err}`));
      }
    }
  } catch (err) {
    log.warn(`Vote push to ${member.label}: ${err}`);
  }

  // 2. Pull peer's open rounds; create new ones locally and merge vote casts
  try {
    const resp = await fetch(`${base}/votes`, opts);
    if (!resp.ok) {
      log.warn(`Vote pull from ${member.label}: HTTP ${resp.status}`);
      return;
    }
    const { rounds: peerRounds } = await resp.json() as { rounds: (Omit<VoteRound, 'concluded'>)[] };
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

      // Merge vote casts
      for (const peerCast of (peerRound.votes ?? []) as VoteCast[]) {
        if (!peerCast.instanceId || !['yes', 'veto'].includes(peerCast.vote)) continue;
        const idx = local.votes.findIndex(v => v.instanceId === peerCast.instanceId);
        if (idx >= 0) {
          if (local.votes[idx]!.vote !== peerCast.vote) {
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
          // For braintree join rounds, add the pending member only if this instance
          // is the direct parent (i.e. the node that opened the round).
          // Ancestor-voters must NOT add the joining node to their own member list.
          if (justPassed && round.type === 'join' && round.pendingMember &&
              freshNet.type === 'braintree') {
            const alreadyAdded = freshNet.members.some(m => m.instanceId === round.subjectInstanceId);
            const isDirectParent = !round.pendingMember.parentInstanceId ||
              round.pendingMember.parentInstanceId === fresh.instanceId;
            const vetoed = round.votes.some(v => v.vote === 'veto');
            if (!alreadyAdded && isDirectParent && !vetoed) {
              freshNet.members.push(round.pendingMember);
              log.info(`Braintree join ${round.roundId} concluded via gossip — added ${round.subjectLabel} to network ${net.id}`);
            }
          }
        }
      }
      // Apply space_deletion side-effects for rounds that just concluded
      for (const round of freshNet.pendingRounds) {
        if (round.concluded && round.type === 'space_deletion') {
          const vetoCount = round.votes.filter(v => v.vote === 'veto').length;
          if (vetoCount === 0 && round.spaceId) {
            import('../spaces/spaces.js').then(({ removeSpace }) => {
              removeSpace(round.spaceId!).catch(e => log.error(`space_deletion vote gossip: ${e}`));
            }).catch(e => log.error(`space_deletion import: ${e}`));
          }
        }
      }
      saveConfig(fresh);
    }
  } catch (err) {
    log.warn(`Vote pull from ${member.label}: ${err}`);
  }
}

// ── Pull (ingest from peer) ─────────────────────────────────────────────────

async function pullFromPeer(
  member: NetworkMember,
  spaceId: string,
  networkId: string,
  headers: Record<string, string>,
  opts: RequestInit,
  batchOpts: RequestInit,
): Promise<{ memories: number; entities: number; edges: number; chrono: number }> {
  let pulledMemories = 0, pulledEntities = 0, pulledEdges = 0, pulledChrono = 0;
  const cfg = getConfig();
  const freshNet = cfg.networks.find(n => n.id === networkId);
  const memberState = freshNet?.members.find(m => m.instanceId === member.instanceId);
  const sinceSeq = memberState?.lastSeqReceived?.[spaceId] ?? 0;

  // Pull tombstones first — so deletions apply before we potentially upsert deleted docs
  try {
    const tombsUrl = `${member.url}/api/sync/tombstones?spaceId=${encodeURIComponent(spaceId)}&networkId=${encodeURIComponent(networkId)}&sinceSeq=${sinceSeq}`;
    const resp = await fetch(tombsUrl, opts);
    if (resp.ok) {
      const data = await resp.json() as { memories?: TombstoneDoc[]; entities?: TombstoneDoc[]; edges?: TombstoneDoc[]; chrono?: TombstoneDoc[] };
      const all = [...(data.memories ?? []), ...(data.entities ?? []), ...(data.edges ?? []), ...(data.chrono ?? [])];
      for (const t of all) { await applyRemoteTombstone(t); }
    }
  } catch (err) {
    log.warn(`pullFromPeer tombstones from ${member.label}: ${err}`);
  }

  // Pull memories — use full=true to return complete docs in a single pass,
  // eliminating the N per-document secondary fetches that would be brutal over WAN.
  let highestSeq = sinceSeq;
  let overallMaxSeq = 0; // Track the highest seq seen across ALL items (used to bump local counter)
  let cursor: string | null = null;
  let page = 0;
  do {
    const params = new URLSearchParams({
      spaceId, networkId, sinceSeq: String(sinceSeq), limit: '200', full: 'true',
      ...(cursor ? { cursor } : {}),
    });
    const resp = await fetch(`${member.url}/api/sync/memories?${params}`, batchOpts);
    if (!resp.ok) { log.warn(`Pull memories from ${member.label} returned ${resp.status}`); break; }
    const { items, nextCursor } = await resp.json() as {
      items: (MemoryDoc | { _id: string; seq: number; deletedAt: string })[]; nextCursor: string | null;
    };

    for (const item of items) {
      if ('deletedAt' in item && item.deletedAt) continue; // already handled via tombstones above
      const doc = item as MemoryDoc;
      await upsertMemory(spaceId, doc);
      pulledMemories++;
      if (doc.seq > overallMaxSeq) overallMaxSeq = doc.seq;
      // Only advance the pull watermark for docs authored by the peer.
      // Docs we pushed to the peer and are echoing back must not inflate our
      // received-from-peer watermark — doing so would cause us to miss their
      // lower-seq locally-written docs on subsequent pulls.
      if (doc.seq > highestSeq && doc.author?.instanceId === member.instanceId) {
        highestSeq = doc.seq;
      }
    }
    cursor = nextCursor;
    page++;
  } while (cursor && page < 50);

  // Pull entities
  cursor = null; page = 0;
  do {
    const params = new URLSearchParams({ spaceId, networkId, sinceSeq: String(sinceSeq), limit: '200', full: 'true', ...(cursor ? { cursor } : {}) });
    const resp = await fetch(`${member.url}/api/sync/entities?${params}`, batchOpts);
    if (!resp.ok) break;
    const { items, nextCursor } = await resp.json() as { items: (EntityDoc | { _id: string; seq: number; deletedAt: string })[]; nextCursor: string | null };
    for (const item of items) {
      if ('deletedAt' in item && item.deletedAt) continue;
      const ent = item as EntityDoc;
      await upsertEntity(spaceId, ent);
      pulledEntities++;
      if (ent.seq > overallMaxSeq) overallMaxSeq = ent.seq;
    }
    cursor = nextCursor; page++;
  } while (cursor && page < 50);

  // Pull edges
  cursor = null; page = 0;
  do {
    const params = new URLSearchParams({ spaceId, networkId, sinceSeq: String(sinceSeq), limit: '200', full: 'true', ...(cursor ? { cursor } : {}) });
    const resp = await fetch(`${member.url}/api/sync/edges?${params}`, batchOpts);
    if (!resp.ok) break;
    const { items, nextCursor } = await resp.json() as { items: (EdgeDoc | { _id: string; seq: number; deletedAt: string })[]; nextCursor: string | null };
    for (const item of items) {
      if ('deletedAt' in item && item.deletedAt) continue;
      const edge = item as EdgeDoc;
      await upsertEdge(spaceId, edge);
      pulledEdges++;
      if (edge.seq > overallMaxSeq) overallMaxSeq = edge.seq;
    }
    cursor = nextCursor; page++;
  } while (cursor && page < 50);

  // Pull chrono
  cursor = null; page = 0;
  do {
    const params = new URLSearchParams({ spaceId, networkId, sinceSeq: String(sinceSeq), limit: '200', full: 'true', ...(cursor ? { cursor } : {}) });
    const resp = await fetch(`${member.url}/api/sync/chrono?${params}`, batchOpts);
    if (!resp.ok) break;
    const { items, nextCursor } = await resp.json() as { items: (ChronoEntry | { _id: string; seq: number; deletedAt: string })[]; nextCursor: string | null };
    for (const item of items) {
      if ('deletedAt' in item && item.deletedAt) continue;
      const chrono = item as ChronoEntry;
      await upsertChrono(spaceId, chrono);
      pulledChrono++;
      if (chrono.seq > overallMaxSeq) overallMaxSeq = chrono.seq;
    }
    cursor = nextCursor; page++;
  } while (cursor && page < 50);

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
      saveConfig(freshCfg);
    }
  }

  return { memories: pulledMemories, entities: pulledEntities, edges: pulledEdges, chrono: pulledChrono };
}

// ── Push (upload our changes to peer) ──────────────────────────────────────

async function pushToPeer(
  member: NetworkMember,
  spaceId: string,
  networkId: string,
  headers: Record<string, string>,
  opts: RequestInit,
  batchOpts: RequestInit,
): Promise<{ memories: number; entities: number; edges: number; chrono: number }> {
  let pushedMemories = 0, pushedEntities = 0, pushedEdges = 0, pushedChrono = 0;
  const cfg = getConfig();
  const freshNet = cfg.networks.find(n => n.id === networkId);
  const memberState = freshNet?.members.find(m => m.instanceId === member.instanceId);
  const lastSeqPushed = memberState?.lastSeqPushed?.[spaceId] ?? 0;

  // Push tombstones — only those newer than the last push watermark
  // Push tombstones — page through all tombstones since the last push watermark.
  // A hard cap would silently drop deletions after long offline periods.
  {
    let tsCursor: number = lastSeqPushed;
    const tsEndpoint = `${member.url}/api/sync/tombstones?spaceId=${encodeURIComponent(spaceId)}&networkId=${encodeURIComponent(networkId)}`;
    while (true) {
      const page = await listTombstones(spaceId, tsCursor, 500);
      if (page.length === 0) break;
      const resp = await fetch(tsEndpoint, {
        ...opts,
        method: 'POST',
        body: JSON.stringify({ tombstones: page }),
      });
      if (!resp.ok) { log.warn(`Push tombstones to ${member.label}: ${resp.status}`); break; }
      tsCursor = page[page.length - 1]!.seq;
      if (page.length < 500) break;
    }
  }

  // Fetch only docs changed since the last push — read and send in PUSH_BATCH_SIZE
  // chunks directly from MongoDB without loading the whole result set into memory first.
  // This makes push O(changed) instead of O(total), and keeps heap usage flat regardless
  // of how many documents have accumulated since the last sync.
  // Braintree nodes relay docs from all peers; other topologies only push their own authored docs
  // to prevent foreign docs (e.g. received from a third instance) from polluting peers' watermarks.
  const isBraintree = freshNet?.type === 'braintree';
  const ownedFilter = isBraintree ? {} : { 'author.instanceId': cfg.instanceId };

  let maxSeqPushed = lastSeqPushed;
  let pushFailed = false;

  // Send in PUSH_BATCH_SIZE slices; stop early on persistent failure
  const batchEndpoint = `${member.url}/api/sync/batch-upsert?spaceId=${encodeURIComponent(spaceId)}&networkId=${encodeURIComponent(networkId)}`;

  // Helper: stream one collection type to the peer in cursor-paginated batches.
  async function pushCollection<T extends MemoryDoc | EntityDoc | EdgeDoc | ChronoEntry>(
    collName: string,
    payloadKey: 'memories' | 'entities' | 'edges' | 'chrono',
  ): Promise<number> {
    let pushed = 0;
    let seqCursor = lastSeqPushed;
    while (!pushFailed) {
      const batch = await col<T>(collName)
        .find({ seq: { $gt: seqCursor }, ...ownedFilter } as never)
        .sort({ seq: 1 })
        .limit(PUSH_BATCH_SIZE)
        .toArray() as T[];
      if (batch.length === 0) break;
      const resp = await fetch(batchEndpoint, {
        ...batchOpts, method: 'POST',
        body: JSON.stringify({ [payloadKey]: batch }),
      });
      if (!resp.ok) {
        log.warn(`Batch push ${payloadKey} to ${member.label}: ${resp.status}`);
        pushFailed = true;
        break;
      }
      pushed += batch.length;
      // Only advance the push watermark for docs authored by this instance.
      // Relayed docs (received from peers) must not inflate the watermark —
      // doing so would prevent future pushes of this instance's own content.
      for (const doc of batch) {
        const d = doc as MemoryDoc;
        if (d.author?.instanceId === cfg.instanceId && d.seq > maxSeqPushed) maxSeqPushed = d.seq;
      }
      seqCursor = (batch[batch.length - 1] as MemoryDoc).seq;
      if (batch.length < PUSH_BATCH_SIZE) break;
    }
    return pushed;
  }

  pushedMemories = await pushCollection<MemoryDoc>(`${spaceId}_memories`, 'memories');
  pushedEntities = await pushCollection<EntityDoc>(`${spaceId}_entities`, 'entities');
  pushedEdges = await pushCollection<EdgeDoc>(`${spaceId}_edges`, 'edges');
  pushedChrono = await pushCollection<ChronoEntry>(`${spaceId}_chrono`, 'chrono');

  // Persist the push high-water mark so next sync only sends new/changed docs
  if (maxSeqPushed > lastSeqPushed) {
    const freshCfg = getConfig();
    const freshNet2 = freshCfg.networks.find(n => n.id === networkId);
    const m = freshNet2?.members.find(m => m.instanceId === member.instanceId);
    if (m) {
      m.lastSeqPushed ??= {};
      m.lastSeqPushed[spaceId] = maxSeqPushed;
      saveConfig(freshCfg);
    }
  }

  return { memories: pushedMemories, entities: pushedEntities, edges: pushedEdges, chrono: pushedChrono };
}

// ── File sync ──────────────────────────────────────────────────────────────

async function syncFiles(
  member: NetworkMember,
  spaceId: string,
  networkId: string,
  headers: Record<string, string>,
  opts: RequestInit,
): Promise<{ pulledFiles: number; pushedFiles: number }> {
  let pulledFiles = 0, pushedFiles = 0;
  try {
    // ── 1. Apply peer's file tombstones (deletions) first ─────────────────
    // Fetch tombstones before the manifest so that files deleted on the peer
    // are removed locally before the manifest comparison runs.
    try {
      const tsResp = await fetch(
        `${member.url}/api/sync/file-tombstones?spaceId=${encodeURIComponent(spaceId)}&networkId=${encodeURIComponent(networkId)}`,
        opts,
      );
      if (tsResp.ok) {
        const { tombstones } = await tsResp.json() as { tombstones: { path: string }[] };
        const spaceDataRoot = getDataRoot();
        const spaceFiles = path.resolve(spaceDataRoot, 'files', spaceId);
        for (const ts of tombstones) {
          try {
            // Normalise to prevent path traversal (sandbox-safe relative path).
            const rel = ts.path.replace(/\\/g, '/').replace(/^\/+/, '');
            const abs = path.join(spaceFiles, rel);
            if (!abs.startsWith(spaceFiles + path.sep) && abs !== spaceFiles) continue;
            await fs.unlink(abs).catch(() => { /* already gone — ignore */ });
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
    try {
      const ourTombstones = await col<FileTombstoneDoc>(`${spaceId}_file_tombstones`)
        .find({ spaceId } as never)
        .toArray();
      if (ourTombstones.length > 0) {
        await fetch(
          `${member.url}/api/sync/file-tombstones`,
          {
            ...opts,
            method: 'POST',
            body: JSON.stringify({ spaceId, tombstones: ourTombstones }),
          },
        );
        // Ignore response — best-effort; peer will log errors internally.
      }
    } catch (err) {
      log.warn(`Push file tombstones to ${member.label}: ${err}`);
    }

    // ── 2. Fetch peer manifest and download new/changed files ─────────────
    const resp = await fetch(`${member.url}/api/sync/manifest?spaceId=${encodeURIComponent(spaceId)}&networkId=${encodeURIComponent(networkId)}`, opts);
    if (!resp.ok) { log.warn(`File manifest from ${member.label}: ${resp.status}`); return { pulledFiles, pushedFiles }; }
    const { manifest } = await resp.json() as { manifest: { path: string; sha256: string; size: number; modifiedAt: string }[] };

    // Build our manifest for comparison
    const ours = await buildFileManifest(spaceId);
    const oursMap = new Map(ours.map(e => [e.path, e]));

    const dataRoot = getDataRoot();
    const spaceRoot = path.resolve(dataRoot, 'files', spaceId);

    for (const remote of manifest) {
      const local = oursMap.get(remote.path);
      if (local && local.sha256 === remote.sha256) continue; // already in sync

      try {
        const dl = await fetch(
          `${member.url}/api/files/${encodeURIComponent(spaceId)}?path=${encodeURIComponent(remote.path)}`,
          opts,
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
        } else {
          // File exists locally with a different hash — keep local, save incoming
          // under a conflict-copy name so the user can decide which version to keep.
          const ext = path.extname(remote.path);
          const base = path.basename(remote.path, ext);
          const dir = path.dirname(remote.path);
          // Sanitise peer label so the filename stays filesystem-safe on all OSes
          const safeLabel = member.label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);
          // ISO timestamp with colons/dots replaced to be valid on Windows/macOS/Linux
          const ts = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-');
          const conflictName = `${base}_${ts}_${safeLabel}${ext}`;
          const conflictRelPath = dir === '.' ? conflictName : `${dir}/${conflictName}`;
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
          await col<ConflictDoc>(`${spaceId}_conflicts`).insertOne(conflictDoc as never);

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
        const pushResp = await fetch(
          `${member.url}/api/files/${encodeURIComponent(spaceId)}?path=${encodeURIComponent(localPath)}`,
          {
            method: 'POST',
            headers: {
              Authorization: headers['Authorization'],
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(bytes.length),
            },
            body: bytes,
            signal: AbortSignal.timeout(BATCH_FETCH_TIMEOUT_MS),
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
  } catch (err) {
    log.warn(`syncFiles for ${member.label} space ${spaceId}: ${err}`);
  }
  return { pulledFiles, pushedFiles };
}

// ── Local upsert helpers ────────────────────────────────────────────────────

async function upsertMemory(spaceId: string, incoming: MemoryDoc): Promise<void> {
  const existing = await col<MemoryDoc>(`${spaceId}_memories`).findOne({ _id: incoming._id } as never) as MemoryDoc | null;
  if (!existing || incoming.seq > existing.seq) {
    await col<MemoryDoc>(`${spaceId}_memories`).replaceOne({ _id: incoming._id } as never, incoming as never, { upsert: true });
  }
}

async function upsertEntity(spaceId: string, incoming: EntityDoc): Promise<void> {
  const existing = await col<EntityDoc>(`${spaceId}_entities`).findOne({ _id: incoming._id } as never) as EntityDoc | null;
  if (!existing || incoming.seq > existing.seq) {
    await col<EntityDoc>(`${spaceId}_entities`).replaceOne({ _id: incoming._id } as never, incoming as never, { upsert: true });
  }
}

async function upsertEdge(spaceId: string, incoming: EdgeDoc): Promise<void> {
  const existing = await col<EdgeDoc>(`${spaceId}_edges`).findOne({ _id: incoming._id } as never) as EdgeDoc | null;
  if (!existing || incoming.seq > existing.seq) {
    await col<EdgeDoc>(`${spaceId}_edges`).replaceOne({ _id: incoming._id } as never, incoming as never, { upsert: true });
  }
}

async function upsertChrono(spaceId: string, incoming: ChronoEntry): Promise<void> {
  const existing = await col<ChronoEntry>(`${spaceId}_chrono`).findOne({ _id: incoming._id } as never) as ChronoEntry | null;
  if (!existing || incoming.seq > existing.seq) {
    await col<ChronoEntry>(`${spaceId}_chrono`).replaceOne({ _id: incoming._id } as never, incoming as never, { upsert: true });
  }
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
  opts: RequestInit,
): Promise<void> {
  try {
    const { computeMerkleRoot } = await import('../brain/merkle.js');
    const [localResult, peerResp] = await Promise.all([
      computeMerkleRoot(spaceId),
      fetch(
        `${member.url}/api/sync/merkle?spaceId=${encodeURIComponent(spaceId)}&networkId=${encodeURIComponent(net.id)}`,
        opts,
      ),
    ]);

    if (!peerResp.ok) {
      log.warn(`Merkle check for space '${spaceId}' with peer '${member.label}': peer returned HTTP ${peerResp.status} — skipping`);
      return;
    }

    const peerResult = await peerResp.json() as { root?: string; leafCount?: number };
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
