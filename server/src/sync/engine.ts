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
    } catch (err) {
      log.error(`Sync failed for member ${member.label} (${member.instanceId}): ${err}`);
      errors++;
    }
  }

  log.info(`Sync cycle complete for '${net.label}': ${synced} ok, ${errors} errors`);
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
    // Node 18/22 fetch doesn't support skipTlsVerify natively.
    // For skipTlsVerify, we use an undici dispatcher via env override only in non-prod.
    // Production environments use trusted certs — skipTlsVerify is a dev-only escape hatch.
  };

  for (const spaceId of net.spaces) {
    // Push to this member if the direction allows it (push or both).
    // Pull from this member if bidirectional (both), or for non-braintree networks.
    // Braintree with direction='push': parent pushes down, child never pushes up.
    const isBraintree = net.type === 'braintree';
    const shouldPull = member.direction === 'both' || !isBraintree;
    const shouldPush = member.direction === 'both' || member.direction === 'push';

    if (shouldPull) {
      await pullFromPeer(member, spaceId, net.id, headers, fetchOpts);
    }
    if (shouldPush) {
      await pushToPeer(member, spaceId, net.id, headers, fetchOpts);
    }

    // Sync file manifest
    await syncFiles(member, spaceId, net.id, headers, fetchOpts);
  }

  // Update lastSyncAt
  const freshCfg = getConfig();
  const freshNet = freshCfg.networks.find(n => n.id === net.id);
  const m = freshNet?.members.find(m => m.instanceId === member.instanceId);
  if (m) { m.lastSyncAt = new Date().toISOString(); saveConfig(freshCfg); }
}

// ── Pull (ingest from peer) ─────────────────────────────────────────────────

async function pullFromPeer(
  member: NetworkMember,
  spaceId: string,
  networkId: string,
  headers: Record<string, string>,
  opts: RequestInit,
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

  // Pull memories
  let highestSeq = sinceSeq;
  let cursor: string | null = null;
  let page = 0;
  do {
    const params = new URLSearchParams({
      spaceId, networkId, sinceSeq: String(sinceSeq), limit: '200',
      ...(cursor ? { cursor } : {}),
    });
    const resp = await fetch(`${member.url}/api/sync/memories?${params}`, opts);
    if (!resp.ok) { log.warn(`Pull memories from ${member.label} returned ${resp.status}`); break; }
    const { items, nextCursor } = await resp.json() as { items: { _id: string; seq: number; deletedAt?: string }[]; nextCursor: string | null };

    for (const stub of items) {
      if (stub.deletedAt) continue; // already handled via tombstones
      const full = await fetch(`${member.url}/api/sync/memories/${stub._id}?spaceId=${encodeURIComponent(spaceId)}&networkId=${encodeURIComponent(networkId)}`, opts);
      if (!full.ok) continue;
      const doc = await full.json() as MemoryDoc;
      await upsertMemory(spaceId, doc);
      if (doc.seq > highestSeq) highestSeq = doc.seq;
    }
    cursor = nextCursor;
    page++;
  } while (cursor && page < 50); // safety: max 50 pages (~10k docs) per sync run

  // Pull entities
  cursor = null; page = 0;
  do {
    const params = new URLSearchParams({ spaceId, networkId, sinceSeq: String(sinceSeq), limit: '200', ...(cursor ? { cursor } : {}) });
    const resp = await fetch(`${member.url}/api/sync/entities?${params}`, opts);
    if (!resp.ok) break;
    const { items, nextCursor } = await resp.json() as { items: { _id: string; seq: number }[]; nextCursor: string | null };
    for (const stub of items) {
      const full = await fetch(`${member.url}/api/sync/entities/${stub._id}?spaceId=${encodeURIComponent(spaceId)}&networkId=${encodeURIComponent(networkId)}`, opts);
      if (!full.ok) continue;
      const doc = await full.json() as EntityDoc;
      await upsertEntity(spaceId, doc);
    }
    cursor = nextCursor; page++;
  } while (cursor && page < 50);

  // Pull edges
  cursor = null; page = 0;
  do {
    const params = new URLSearchParams({ spaceId, networkId, sinceSeq: String(sinceSeq), limit: '200', ...(cursor ? { cursor } : {}) });
    const resp = await fetch(`${member.url}/api/sync/edges?${params}`, opts);
    if (!resp.ok) break;
    const { items, nextCursor } = await resp.json() as { items: { _id: string; seq: number }[]; nextCursor: string | null };
    for (const stub of items) {
      const full = await fetch(`${member.url}/api/sync/edges/${stub._id}?spaceId=${encodeURIComponent(spaceId)}&networkId=${encodeURIComponent(networkId)}`, opts);
      if (!full.ok) continue;
      const doc = await full.json() as EdgeDoc;
      await upsertEdge(spaceId, doc);
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
): Promise<void> {
  // Get the last seq the peer has received from us (stored remotely — we ask them)
  // Simplified: push everything from seq 0 (peers deduplicate via upsert)
  // In production this would store the peer's last-ack seq per-space server-side.

  // Push tombstones
  const myTombstones = await listTombstones(spaceId, 0, 500);
  if (myTombstones.length > 0) {
    const resp = await fetch(`${member.url}/api/sync/tombstones?spaceId=${encodeURIComponent(spaceId)}&networkId=${encodeURIComponent(networkId)}`, {
      ...opts,
      method: 'POST',
      body: JSON.stringify({ tombstones: myTombstones }),
    });
    if (!resp.ok) log.warn(`Push tombstones to ${member.label}: ${resp.status}`);
  }

  // Push memories
  const memories = await col<MemoryDoc>(`${spaceId}_memories`).find({}).toArray() as MemoryDoc[];
  for (const mem of memories) {
    const resp = await fetch(`${member.url}/api/sync/memories?spaceId=${encodeURIComponent(spaceId)}&networkId=${encodeURIComponent(networkId)}`, {
      ...opts,
      method: 'POST',
      body: JSON.stringify(mem),
    });
    if (!resp.ok) log.warn(`Push memory ${mem._id} to ${member.label}: ${resp.status}`);
  }

  // Push entities
  const entities = await col<EntityDoc>(`${spaceId}_entities`).find({}).toArray() as EntityDoc[];
  for (const ent of entities) {
    const resp = await fetch(`${member.url}/api/sync/entities?spaceId=${encodeURIComponent(spaceId)}&networkId=${encodeURIComponent(networkId)}`, {
      ...opts,
      method: 'POST',
      body: JSON.stringify(ent),
    });
    if (!resp.ok) log.warn(`Push entity ${ent._id} to ${member.label}: ${resp.status}`);
  }

  // Push edges
  const edges = await col<EdgeDoc>(`${spaceId}_edges`).find({}).toArray() as EdgeDoc[];
  for (const edge of edges) {
    const resp = await fetch(`${member.url}/api/sync/edges?spaceId=${encodeURIComponent(spaceId)}&networkId=${encodeURIComponent(networkId)}`, {
      ...opts,
      method: 'POST',
      body: JSON.stringify(edge),
    });
    if (!resp.ok) log.warn(`Push edge ${edge._id} to ${member.label}: ${resp.status}`);
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
