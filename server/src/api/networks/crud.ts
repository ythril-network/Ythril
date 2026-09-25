/**
 * Network CRUD + sync trigger/history (`GET /`, `GET|PATCH|DELETE /:id`, `POST /`, `POST /:id/sync`, `GET /:id/sync-history`).
 *
 * Split out of the api/networks.ts monolith (A17.5); handlers are unchanged.
 */
import { Router } from 'express';
import { requireAdmin, requireAuth, denyReadOnly } from '../../auth/middleware.js';
import { visibleNetworks } from '../../auth/network-rights.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { getConfig } from '../../config/loader.js';
import { getSyncHistory } from '../../sync/history.js';
import { unknownPeerRefusal } from '../../sync/peer-target.js';
import { triggerNetworkSync, triggerPeerSync, syncTimeoutMs } from '../../sync/trigger.js';
import { log } from '../../util/log.js';
import {
  networkView, readNetworkAct, createNetworkAct, updateNetworkAct, leaveNetworkAct, type NetworkActResult,
  CreateNetworkBody, UpdateNetworkBody,
} from '../../networks/network-acts.js';

export const crudRouter = Router();

// ── GET /api/networks ──────────────────────────────────

// F-34: the networks this token may see — `networks: read` on every space each carries. Same filter as MCP
// `network_peers`, so the two doors list the same networks.
crudRouter.get('/', globalRateLimit, requireAuth, (req, res) => {
  const visible = visibleNetworks(req.authToken as Parameters<typeof visibleNetworks>[0], getConfig().networks);
  // `version`, `belowFloor` and `minPeerVersion` per MEMBER, spelled as MCP spells them — see `networkView`.
  res.json({ networks: visible.map(networkView) });
});


// ── GET /api/networks/:id ──────────────────────────────────────────────────

// F-34: readable with `networks: read` on every space it carries; otherwise a 404, because a 403 says it exists.
crudRouter.get('/:id', globalRateLimit, requireAuth, (req, res) => {
  send(res, readNetworkAct(req.authToken as Parameters<typeof readNetworkAct>[0], req.params['id'] as string));
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
crudRouter.post('/', globalRateLimit, requireAuth, denyReadOnly, (req, res) => {
  // Parsed here as well as in the act: the same-parameters gate reads a route's accepted keys off this call.
  const parsed = CreateNetworkBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  send(res, createNetworkAct(req.authToken as Parameters<typeof createNetworkAct>[0], parsed.data));
});


// ── DELETE /api/networks/:id — leave/delete a network ─────────────────────

// F-34: leaving takes each of the network's spaces out of it, so each membership is decided by the leave rule —
// its own at `networks: write`, anyone's at `admin`, an unknown establisher only at `admin`.
crudRouter.delete('/:id', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  send(res, await leaveNetworkAct(req.authToken as Parameters<typeof leaveNetworkAct>[0], req.params['id'] as string));
});


// ── PATCH /api/networks/:id — update mutable network fields ───────────────

// F-34: the settings are shared by every space the network carries, so `networks: admin` on every one.
crudRouter.patch('/:id', globalRateLimit, requireAuth, denyReadOnly, (req, res) => {
  const parsed = UpdateNetworkBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const r = updateNetworkAct(req.authToken as Parameters<typeof updateNetworkAct>[0], req.params['id'] as string, parsed.data);
  // The three fields this act can change, never the record: it also holds invite and member token hashes.
  if (r.audit) req.auditSnapshots = r.audit;
  send(res, r);
});

/** An act's answer, on the wire. The status is the act's own; this door only translates it. */
function send(res: import('express').Response, r: NetworkActResult): void {
  if (r.status === 204) { res.status(204).end(); return; }
  if ('error' in r) { res.status(r.status).json({ error: r.error }); return; }
  res.status(r.status).json(r.body);
}
