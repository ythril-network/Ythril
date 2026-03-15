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
import { buildFileManifest } from '../files/manifest.js';
import { log } from '../util/log.js';
import type {
  NetworkConfig,
  NetworkMember,
  MemoryDoc,
  EntityDoc,
  EdgeDoc,
  TombstoneDoc,
} from '../config/types.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { getDataRoot } from '../config/loader.js';
import { createHash } from 'node:crypto';
import { resolveSafePath } from '../files/sandbox.js';

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
  log.info(`Sync scheduler started (${cfg.networks.length} networks)`);
}

/** Stop all scheduled timers */
export function stopSyncScheduler(): void {
  for (const [id, timer] of _scheduledTimers) {
    clearInterval(timer);
    log.info(`Sync scheduler stopped for network ${id}`);
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

  log.info(`Starting sync cycle for network '${net.label}' (${net.members.length} members)`);
  let synced = 0; let errors = 0;

  for (const member of net.members) {
    try {
      await runSyncForMember(net, member);
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
      log.error(`Sync failed for member ${member.label} (${member.instanceId}): ${err}`);
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

/** Sync a single member across all network spaces. */
async function runSyncForMember(net: NetworkConfig, member: NetworkMember): Promise<void> {
  const secrets = getSecrets();
  const peerToken = secrets.peerTokens[member.instanceId];
  if (!peerToken) {
    log.warn(`No peer token for ${member.label} (${member.instanceId}) — skipping sync`);
    return;
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
      await pullFromPeer(member, spaceId, net.id, headers, fetchOpts, batchFetchOpts);
    }
    if (shouldPush) {
      await pushToPeer(member, spaceId, net.id, headers, fetchOpts, batchFetchOpts);
    }

    // Sync file manifest
    await syncFiles(member, spaceId, net.id, headers, fetchOpts);
  }

  // ── Gossip: member list exchange ──────────────────────────────────────────
  // 1. Push our own self-record to this peer so it stays current on our URL/label.
  // 2. Pull the peer's view of the member list; update our local records for any
  //    members whose URL/label/children changed.
  await gossipWithPeer(net, member, headers, fetchOpts);

  // Update lastSyncAt
  const freshCfg = getConfig();
  const freshNet = freshCfg.networks.find(n => n.id === net.id);
  const m = freshNet?.members.find(m => m.instanceId === member.instanceId);
  if (m) { m.lastSyncAt = new Date().toISOString(); saveConfig(freshCfg); }
}

// ── Gossip: member list exchange ────────────────────────────────────────────

/**
 * Exchange member records with a single peer:
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

// ── Pull (ingest from peer) ─────────────────────────────────────────────────

async function pullFromPeer(
  member: NetworkMember,
  spaceId: string,
  networkId: string,
  headers: Record<string, string>,
  opts: RequestInit,
  batchOpts: RequestInit,
): Promise<void> {
  const cfg = getConfig();
  const freshNet = cfg.networks.find(n => n.id === networkId);
  const memberState = freshNet?.members.find(m => m.instanceId === member.instanceId);
  const sinceSeq = memberState?.lastSeqReceived?.[spaceId] ?? 0;

  // Pull tombstones first — so deletions apply before we potentially upsert deleted docs
  try {
    const tombsUrl = `${member.url}/api/sync/tombstones?spaceId=${encodeURIComponent(spaceId)}&networkId=${encodeURIComponent(networkId)}&sinceSeq=${sinceSeq}`;
    const resp = await fetch(tombsUrl, opts);
    if (resp.ok) {
      const data = await resp.json() as { memories?: TombstoneDoc[]; entities?: TombstoneDoc[]; edges?: TombstoneDoc[] };
      const all = [...(data.memories ?? []), ...(data.entities ?? []), ...(data.edges ?? [])];
      for (const t of all) { await applyRemoteTombstone(t); }
    }
  } catch (err) {
    log.warn(`pullFromPeer tombstones from ${member.label}: ${err}`);
  }

  // Pull memories — use full=true to return complete docs in a single pass,
  // eliminating the N per-document secondary fetches that would be brutal over WAN.
  let highestSeq = sinceSeq;
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
      if (doc.seq > highestSeq) highestSeq = doc.seq;
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
      await upsertEntity(spaceId, item as EntityDoc);
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
      await upsertEdge(spaceId, item as EdgeDoc);
    }
    cursor = nextCursor; page++;
  } while (cursor && page < 50);

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
}

// ── Push (upload our changes to peer) ──────────────────────────────────────

async function pushToPeer(
  member: NetworkMember,
  spaceId: string,
  networkId: string,
  headers: Record<string, string>,
  opts: RequestInit,
  batchOpts: RequestInit,
): Promise<void> {
  const cfg = getConfig();
  const freshNet = cfg.networks.find(n => n.id === networkId);
  const memberState = freshNet?.members.find(m => m.instanceId === member.instanceId);
  const lastSeqPushed = memberState?.lastSeqPushed?.[spaceId] ?? 0;

  // Push tombstones — only those newer than the last push watermark
  const myTombstones = await listTombstones(spaceId, lastSeqPushed, 500);
  if (myTombstones.length > 0) {
    const resp = await fetch(`${member.url}/api/sync/tombstones?spaceId=${encodeURIComponent(spaceId)}&networkId=${encodeURIComponent(networkId)}`, {
      ...opts,
      method: 'POST',
      body: JSON.stringify({ tombstones: myTombstones }),
    });
    if (!resp.ok) log.warn(`Push tombstones to ${member.label}: ${resp.status}`);
  }

  // Fetch only docs changed since the last push — then send in batches via batch-upsert.
  // This makes push O(changed) instead of O(total), and O(ceil(changed/200)) HTTP requests
  // instead of O(changed) — critical for WAN-distributed brains.
  const memories = await col<MemoryDoc>(`${spaceId}_memories`)
    .find({ seq: { $gt: lastSeqPushed } } as never).sort({ seq: 1 }).toArray() as MemoryDoc[];
  const entities = await col<EntityDoc>(`${spaceId}_entities`)
    .find({ seq: { $gt: lastSeqPushed } } as never).sort({ seq: 1 }).toArray() as EntityDoc[];
  const edges = await col<EdgeDoc>(`${spaceId}_edges`)
    .find({ seq: { $gt: lastSeqPushed } } as never).sort({ seq: 1 }).toArray() as EdgeDoc[];

  let maxSeqPushed = lastSeqPushed;

  // Send in PUSH_BATCH_SIZE slices; stop early on persistent failure
  const batchEndpoint = `${member.url}/api/sync/batch-upsert?spaceId=${encodeURIComponent(spaceId)}&networkId=${encodeURIComponent(networkId)}`;
  let pushFailed = false;

  for (let i = 0; i < memories.length; i += PUSH_BATCH_SIZE) {
    if (pushFailed) break;
    const batch = memories.slice(i, i + PUSH_BATCH_SIZE);
    const resp = await fetch(batchEndpoint, {
      ...batchOpts, method: 'POST',
      body: JSON.stringify({ memories: batch }),
    });
    if (!resp.ok) { log.warn(`Batch push memories to ${member.label}: ${resp.status}`); pushFailed = true; break; }
    maxSeqPushed = Math.max(maxSeqPushed, batch[batch.length - 1]!.seq);
  }

  for (let i = 0; i < entities.length && !pushFailed; i += PUSH_BATCH_SIZE) {
    const batch = entities.slice(i, i + PUSH_BATCH_SIZE);
    const resp = await fetch(batchEndpoint, {
      ...batchOpts, method: 'POST',
      body: JSON.stringify({ entities: batch }),
    });
    if (!resp.ok) { log.warn(`Batch push entities to ${member.label}: ${resp.status}`); pushFailed = true; break; }
    maxSeqPushed = Math.max(maxSeqPushed, batch[batch.length - 1]!.seq);
  }

  for (let i = 0; i < edges.length && !pushFailed; i += PUSH_BATCH_SIZE) {
    const batch = edges.slice(i, i + PUSH_BATCH_SIZE);
    const resp = await fetch(batchEndpoint, {
      ...batchOpts, method: 'POST',
      body: JSON.stringify({ edges: batch }),
    });
    if (!resp.ok) { log.warn(`Batch push edges to ${member.label}: ${resp.status}`); pushFailed = true; break; }
    maxSeqPushed = Math.max(maxSeqPushed, batch[batch.length - 1]!.seq);
  }

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
}

// ── File sync ──────────────────────────────────────────────────────────────

async function syncFiles(
  member: NetworkMember,
  spaceId: string,
  networkId: string,
  headers: Record<string, string>,
  opts: RequestInit,
): Promise<void> {
  try {
    const resp = await fetch(`${member.url}/api/sync/manifest?spaceId=${encodeURIComponent(spaceId)}&networkId=${encodeURIComponent(networkId)}`, opts);
    if (!resp.ok) { log.warn(`File manifest from ${member.label}: ${resp.status}`); return; }
    const { manifest } = await resp.json() as { manifest: { path: string; sha256: string; size: number; modifiedAt: string }[] };

    // Build our manifest for comparison
    const ours = await buildFileManifest(spaceId);
    const oursMap = new Map(ours.map(e => [e.path, e]));

    const dataRoot = getDataRoot();
    const spaceRoot = path.resolve(dataRoot, 'files', spaceId);

    for (const remote of manifest) {
      const local = oursMap.get(remote.path);
      if (!local || local.sha256 !== remote.sha256) {
        // Download from peer
        try {
          const dl = await fetch(`${member.url}/api/files/${encodeURIComponent(spaceId)}/${encodeURIComponent(remote.path)}`, opts);
          if (!dl.ok) { log.warn(`DL file ${remote.path} from ${member.label}: ${dl.status}`); continue; }
          const buf = Buffer.from(await dl.arrayBuffer());
          const sha = createHash('sha256').update(buf).digest('hex');
          if (sha !== remote.sha256) { log.warn(`SHA mismatch for ${remote.path} from ${member.label}`); continue; }
          const absPath = path.join(spaceRoot, remote.path);
          await fs.mkdir(path.dirname(absPath), { recursive: true });
          await fs.writeFile(absPath, buf);
        } catch (err) {
          log.warn(`File sync error for ${remote.path}: ${err}`);
        }
      }
    }
  } catch (err) {
    log.warn(`syncFiles for ${member.label} space ${spaceId}: ${err}`);
  }
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

// Silence unused import warning — resolveSafePath may be used by future file push refinement
void resolveSafePath;
