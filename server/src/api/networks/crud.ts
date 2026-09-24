/**
 * Network CRUD + sync trigger/history (`GET /`, `GET|PATCH|DELETE /:id`, `POST /`, `POST /:id/sync`, `GET /:id/sync-history`).
 *
 * Split out of the api/networks.ts monolith (A17.5); handlers are unchanged.
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { requireAdmin, requireAuth, denyReadOnly } from '../../auth/middleware.js';
import { networkCreateRefusal, networkLeaveRefusal, networkSettingsRefusal, visibleNetworks } from '../../auth/network-rights.js';
import { recordOrigin } from '../../auth/network-membership.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { syncScheduleRefusal } from '../../sync/schedule.js';
import { MIN_PEER_VERSION, peerFloorRefusal } from '../../sync/peer-floor.js';
import { getConfig, saveConfig, getSecrets } from '../../config/loader.js';
import { revokePeerCredentialsIfOrphaned } from '../../auth/tokens.js';
import { getSyncHistory } from '../../sync/history.js';
import { peerSafeFetch } from '../../sync/peer-fetch.js';
import { unknownPeerRefusal } from '../../sync/peer-target.js';
import { triggerNetworkSync, triggerPeerSync, syncTimeoutMs } from '../../sync/trigger.js';
import { log } from '../../util/log.js';
import type { NetworkConfig } from '../../config/types.js';

export const crudRouter = Router();

const CreateNetworkBody = z.object({
  id: z.string().uuid().optional(),  // optional pre-specified ID for cross-instance registration
  label: z.string().min(1).max(200),
  type: z.enum(['closed', 'democratic', 'club', 'braintree', 'pubsub']),
  spaces: z.array(z.string().min(1)).min(1),
  votingDeadlineHours: z.number().int().min(1).max(72).default(24),
  syncSchedule: z.string().optional(),
  merkle: z.boolean().optional(),
  requireSignedVotes: z.boolean().optional(),  // strict mode: reject unsigned governance votes
  myParentInstanceId: z.string().optional(),  // braintree: this instance's parent in the tree (omit → root)
});

const UpdateNetworkBody = z.object({
  syncSchedule: z.string().optional(),
  label: z.string().min(1).max(200).optional(),
  requireSignedVotes: z.boolean().optional(),
});

// ── GET /api/networks ──────────────────────────────────

// F-34: the networks this token may see — `networks: read` on every space each carries. Same filter as MCP
// `network_peers`, so the two doors list the same networks.
crudRouter.get('/', globalRateLimit, requireAuth, (req, res) => {
  const cfg = getConfig();
  const visible = visibleNetworks(req.authToken as Parameters<typeof visibleNetworks>[0], cfg.networks);
  // Strip sensitive fields
  const networks = visible.map(n => ({
    ...n,
    members: n.members.map(({ tokenHash: _th, skipTlsVerify: _sv, ...m }) => ({
      ...m,
      belowFloor: peerFloorRefusal(m.version, m.versionCheckedAt),
      minPeerVersion: MIN_PEER_VERSION,
    })),
    inviteKeyHash: undefined,
  }));
  /*
   * `version`, `belowFloor` and `minPeerVersion` per MEMBER — the same three facts, spelled the same
   * way, on both doors, which is the first rule in `CLAUDE.md`. On the envelope here and per-row on
   * MCP would be one fact with two shapes, and the MCP tool's contract is a bare array.
   *
   * `version` already travelled because a member is spread. The VERDICT did not, and it is the half an
   * operator gets wrong: a null version reads as 'unknown, probably fine' when it may mean refused.
   */
  res.json({ networks });
});


// ── GET /api/networks/:id ──────────────────────────────────────────────────

// F-34: readable with `networks: read` on every space it carries; otherwise a 404, because a 403 says it exists.
crudRouter.get('/:id', globalRateLimit, requireAuth, (req, res) => {
  const cfg = getConfig();
  const net = visibleNetworks(req.authToken as Parameters<typeof visibleNetworks>[0], cfg.networks).find(n => n.id === req.params['id']);
  if (!net) { res.status(404).json({ error: 'Network not found' }); return; }

  const safe = {
    ...net,
    members: net.members.map(({ tokenHash: _th, skipTlsVerify: _sv, ...m }) => ({
      ...m,
      belowFloor: peerFloorRefusal(m.version, m.versionCheckedAt),
      minPeerVersion: MIN_PEER_VERSION,
    })),
    inviteKeyHash: undefined,
  };
  res.json(safe);
});


// ── GET /api/networks/:id/sync-history ─────────────────────────────────────

crudRouter.get('/:id/sync-history', globalRateLimit, requireAdmin, async (req, res) => {
  try {
    const cfg = getConfig();
    const net = cfg.networks.find(n => n.id === req.params['id']);
    if (!net) { res.status(404).json({ error: 'Network not found' }); return; }

    const limit = Math.min(parseInt(req.query['limit'] as string, 10) || 20, 100);
    const history = await getSyncHistory(net.id, limit);
    res.json({ history });
  } catch (err) {
    log.error(`GET /api/networks/:id/sync-history: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});


// ── POST /api/networks/:id/sync — manually trigger a sync run ──────────────

/*
 * THE network sync door, and since 4.4 it has the strong sides of the route it is replacing.
 *
 * Owner, 2026-09-09, on the two routes that did this: *"merge if the goal is the same. then use the strong
 * sides of each."* This one already had what the other lacked — it names its subject in the URL and 404s a
 * network that does not exist — and lacked what the other had: `?wait=true` and `?timeoutMs`.
 *
 * Both now come from `sync/trigger.ts`, so the answer shapes cannot drift again. The old body also
 * answered `{ ok: true }`, which said nothing about what happened; it now answers `triggered`,
 * `completed`, `timeout` or `error` like every other door.
 */
crudRouter.post('/:id/sync', globalRateLimit, requireAdmin, async (req, res) => {
  const net = getConfig().networks.find(n => n.id === req.params['id']);
  if (!net) { res.status(404).json({ error: 'Network not found' }); return; }
  const wait = req.query['wait'] === 'true' || req.query['wait'] === '1';
  await triggerNetworkSync(res, net.id, { wait, timeoutMs: syncTimeoutMs(req.query['timeoutMs']) });
});

/*
 * ONE PEER, across every network it belongs to.
 *
 * It lives on the networks COLLECTION rather than under `/:id/` because a peer is not a property of one
 * network — it can be a member of several, and `runSyncForPeer` walks all of them. That is exactly why
 * this could not simply be folded into the route above, and why `network_sync` had no REST twin for it until
 * `Q-20` bolted one onto the notification channel.
 *
 * `unknownPeerRefusal` is the SEC-16 check, shared with the MCP tool: an unvalidated id becomes the
 * address the sync engine connects to, so the id is checked against the configured members and never
 * treated as a URL.
 */
crudRouter.post('/peers/:peerId/sync', globalRateLimit, requireAdmin, async (req, res) => {
  const peerId = req.params['peerId'] as string;
  const refusal = unknownPeerRefusal(peerId);
  if (refusal) { res.status(refusal.status).json({ error: refusal.error }); return; }
  const wait = req.query['wait'] === 'true' || req.query['wait'] === '1';
  await triggerPeerSync(res, peerId, { wait });
});


// F-34: `networks: write` on EVERY space it carries (instance admin passes). `denyReadOnly` because this was
// `requireAdmin`, which a read-only token never passed — swapping down to a rung check must not let it in.
crudRouter.post('/', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const parsed = CreateNetworkBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

    const { id: presetId, label, type, spaces, votingDeadlineHours, syncSchedule, merkle, requireSignedVotes, myParentInstanceId } = parsed.data;
    const cfg = getConfig();

    // A schedule the scheduler cannot run is refused rather than stored. It used to be accepted: the body
    // schema is `z.string().optional()`, so any string got a 201 and the network then sat on manual sync
    // with a startup warning as its only trace. Same helper as the PATCH below — one rule, one place.
    const scheduleRefusal = syncScheduleRefusal(syncSchedule);
    if (scheduleRefusal) { res.status(400).json({ error: scheduleRefusal }); return; }

    // Validate spaces exist
    const unknownSpaces = spaces.filter(s => !cfg.spaces.some(cs => cs.id === s));
    if (unknownSpaces.length > 0) {
      res.status(400).json({ error: `Unknown spaces: ${unknownSpaces.join(', ')}` });
      return;
    }
    const caller = req.authToken as Parameters<typeof networkCreateRefusal>[0];
    const refusal = networkCreateRefusal(caller, spaces);
    if (refusal) { res.status(403).json({ error: refusal }); return; }

    // If a preset ID is given, ensure it is not already in use
    if (presetId && cfg.networks.some(n => n.id === presetId)) {
      res.status(409).json({ error: 'Network with this ID already exists' });
      return;
    }

    const network: NetworkConfig = {
      id: presetId ?? uuidv4(),
      label,
      type,
      spaces,
      votingDeadlineHours,
      syncSchedule,
      merkle,
      ...(requireSignedVotes ? { requireSignedVotes: true } : {}),
      myParentInstanceId: type === 'braintree' ? myParentInstanceId : undefined,
      members: [],
      pendingRounds: [],
      createdAt: new Date().toISOString(),
      // Who established each membership, so the leave rule can tell a token's own from another's. Recorded for an
      // instance admin too: the record is about the membership, not about whether its maker needed permission.
      ...(caller.id ? { spaceOrigins: spaces.reduce<Record<string, string>>((o, s) => recordOrigin(o, s, caller.id!), {}) } : {}),
    };

    cfg.networks.push(network);
    saveConfig(cfg);

    log.info(`Created network '${label}' (${type}) id=${network.id}`);
    const { inviteKeyHash: _ikH, ...safe } = network;
    res.status(201).json(safe);
  } catch (err) {
    log.error(`POST /api/networks: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});


// ── DELETE /api/networks/:id — leave/delete a network ─────────────────────

// F-34: leaving takes each of the network's spaces out of it, so each membership is decided by the leave rule —
// its own at `networks: write`, anyone's at `admin`, an unknown establisher only at `admin`.
crudRouter.delete('/:id', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  const cfg = getConfig();
  const idx = cfg.networks.findIndex(n => n.id === req.params['id']);
  if (idx < 0 || !visibleNetworks(req.authToken as Parameters<typeof visibleNetworks>[0], [cfg.networks[idx]!]).length) {
    res.status(404).json({ error: 'Network not found' }); return;
  }

  const net = cfg.networks[idx]!;
  const leaveRefusal = networkLeaveRefusal(req.authToken as Parameters<typeof networkLeaveRefusal>[0], net);
  if (leaveRefusal) { res.status(403).json({ error: leaveRefusal }); return; }

  // Broadcast member_departed to all peers before removing the network locally.
  const secrets = getSecrets();
  const warnings: string[] = [];
  await Promise.all(net.members.map(async (member) => {
    const peerToken = secrets.peerTokens[member.instanceId];
    if (!peerToken) return;
    try {
      const r = await peerSafeFetch(`${member.url}/api/notify`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${peerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ networkId: net.id, instanceId: cfg.instanceId, event: 'member_departed' }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!r.ok) warnings.push(`${member.label}: HTTP ${r.status}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`member_departed to ${member.label}: ${msg}`);
      warnings.push(`${member.label}: ${msg}`);
    }
  }));

  // Re-fetch config after async peer notifications to avoid clobbering concurrent writes.
  {
    const c = getConfig();
    const i = c.networks.findIndex(n => n.id === req.params['id']);
    if (i >= 0) { c.networks.splice(i, 1); saveConfig(c); }
  }
  log.info(`Deleted network id=${net.id}`);

  // Revoke credentials of peers that no longer share any network with us.
  for (const member of net.members) {
    if (member.instanceId === cfg.instanceId) continue;
    await revokePeerCredentialsIfOrphaned(member.instanceId)
      .catch(err => log.error(`peer credential revocation for ${member.instanceId}: ${err}`));
  }

  if (warnings.length) {
    res.json({ ok: true, warnings });
  } else {
    res.status(204).end();
  }
});


// ── PATCH /api/networks/:id — update mutable network fields ───────────────

// F-34: the settings are shared by every space the network carries, so `networks: admin` on every one.
crudRouter.patch('/:id', globalRateLimit, requireAuth, denyReadOnly, (req, res) => {
  const parsed = UpdateNetworkBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // Before the network lookup, because a schedule the scheduler cannot run is a bad request whichever
  // network it names. Same helper as the create above — one rule, one place.
  const scheduleRefusal = syncScheduleRefusal(parsed.data.syncSchedule);
  if (scheduleRefusal) { res.status(400).json({ error: scheduleRefusal }); return; }

  const cfg = getConfig();
  const caller = req.authToken as Parameters<typeof visibleNetworks>[0];
  const net = visibleNetworks(caller, cfg.networks).find(n => n.id === req.params['id']);
  if (!net) { res.status(404).json({ error: 'Network not found' }); return; }
  const settingsRefusal = networkSettingsRefusal(caller, net);
  if (settingsRefusal) { res.status(403).json({ error: settingsRefusal }); return; }

  // Snapshot before mutating. Only the three fields this route can change — the record also holds
  // `inviteKeyHash` and members' `tokenHash`, and handing the whole thing over would rest entirely on
  // the allowlist in audit-changes.ts rather than being obvious here.
  req.auditSnapshots = {
    before: { label: net.label, syncSchedule: net.syncSchedule, requireSignedVotes: net.requireSignedVotes },
    after: {
      label: parsed.data.label ?? net.label,
      syncSchedule: parsed.data.syncSchedule !== undefined ? (parsed.data.syncSchedule || undefined) : net.syncSchedule,
      requireSignedVotes: parsed.data.requireSignedVotes ?? net.requireSignedVotes,
    },
  };

  if (parsed.data.syncSchedule !== undefined) {
    net.syncSchedule = parsed.data.syncSchedule || undefined;
    // Re-register cron timer for this network with the new schedule
    import('../../sync/scheduler.js').then(({ scheduleSyncForNetwork }) => {
      scheduleSyncForNetwork(net!.id, net!.syncSchedule);
    }).catch(err => log.warn(`Failed to reschedule sync for ${net!.id}: ${err}`));
  }
  if (parsed.data.label) net.label = parsed.data.label;
  if (parsed.data.requireSignedVotes !== undefined) net.requireSignedVotes = parsed.data.requireSignedVotes;

  saveConfig(cfg);
  log.info(`Updated network ${net.id}`);
  const { inviteKeyHash: _ikh, ...safe } = net;
  res.json({ ...safe, members: net.members.map(({ tokenHash: _th, skipTlsVerify: _sv, ...m }) => m) });
});
