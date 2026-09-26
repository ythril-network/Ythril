/**
 * Network CRUD + sync trigger/history (`GET /`, `GET|PATCH|DELETE /:id`, `POST /`, `POST /:id/spaces`, `POST /:id/sync`, `GET /:id/sync-history`).
 *
 * Split out of the api/networks.ts monolith (A17.5); handlers are unchanged.
 */
import { Router } from 'express';
import { requireAdmin, requireAuth, denyReadOnly } from '../../auth/middleware.js';
import { visibleNetworks } from '../../auth/network-rights.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { getConfig } from '../../config/loader.js';
import { syncHistoryAct } from '../../networks/vote-acts.js';
import { sendAct } from './_shared.js';
import { unknownPeerRefusal } from '../../sync/peer-target.js';
import { triggerNetworkSync, triggerPeerSync, syncTimeoutMs } from '../../sync/trigger.js';
import { log } from '../../util/log.js';
import { attachSyncNote, changeNotesAct } from '../../sync/change-notes.js';
import {
  networkView, readNetworkAct, createNetworkAct, updateNetworkAct, leaveNetworkAct, addNetworkSpaceAct, 
  CreateNetworkBody, UpdateNetworkBody, AddNetworkSpaceBody, ResolvePendingSpaceBody, resolvePendingSpaceAct,
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
  sendAct(res, readNetworkAct(req.authToken as Parameters<typeof readNetworkAct>[0], req.params['id'] as string));
});


// ── GET /api/networks/:id/sync-history ─────────────────────────────────────

// The act is shared with MCP `network_sync_history` (F-36 slice 2).
crudRouter.get('/:id/sync-history', globalRateLimit, requireAdmin, async (req, res) => {
  try {
    sendAct(res, await syncHistoryAct(req.params['id'] as string, req.query['limit']));
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
  // F-42: an optional `{ note, spaces }` body rides this sync to the members below. Queued BEFORE the cycle starts,
  // so this cycle carries it; a note that cannot travel is refused and the sync does not run, rather than running
  // without the note the caller asked for.
  // Only `note` and `spaces` are read, as MCP reads them: this door took no body before, and a key an integrator
  // already sends must stay ignored rather than start refusing the sync.
  const b = (req.body ?? {}) as Record<string, unknown>;
  const noteInput = b['note'] !== undefined || b['spaces'] !== undefined ? { note: b['note'], spaces: b['spaces'] } : undefined;
  const attached = await attachSyncNote(net, noteInput, String(req.authToken?.name ?? 'an instance admin'));
  if (attached && 'error' in attached) { res.status(attached.status).json({ error: attached.error }); return; }
  await triggerNetworkSync(res, net.id, { wait, timeoutMs: syncTimeoutMs(req.query['timeoutMs']), ...(attached ? { noteId: attached.queued._id } : {}) });
});

// ── GET /api/networks/:id/change-notes — notes that arrived here (`in`) or were written here (`out`) ───
// F-42. The act is shared with MCP `network_change_notes`.
crudRouter.get('/:id/change-notes', globalRateLimit, requireAdmin, async (req, res) => {
  try {
    sendAct(res, await changeNotesAct(req.params['id'] as string, req.query['direction'], req.query['limit']));
  } catch (err) {
    log.error(`GET /api/networks/:id/change-notes: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
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
  sendAct(res, createNetworkAct(req.authToken as Parameters<typeof createNetworkAct>[0], parsed.data));
});


// ── DELETE /api/networks/:id — leave/delete a network ─────────────────────

// F-34: leaving takes each of the network's spaces out of it, so each membership is decided by the leave rule —
// its own at `networks: write`, anyone's at `admin`, an unknown establisher only at `admin`.
crudRouter.delete('/:id', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  sendAct(res, await leaveNetworkAct(req.authToken as Parameters<typeof leaveNetworkAct>[0], req.params['id'] as string));
});


// ── PATCH /api/networks/:id — update mutable network fields ───────────────

// F-34: the settings are shared by every space the network carries, so `networks: admin` on every one.
crudRouter.patch('/:id', globalRateLimit, requireAuth, denyReadOnly, (req, res) => {
  const parsed = UpdateNetworkBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const r = updateNetworkAct(req.authToken as Parameters<typeof updateNetworkAct>[0], req.params['id'] as string, parsed.data);
  // The three fields this act can change, never the record: it also holds invite and member token hashes.
  if (r.audit) req.auditSnapshots = r.audit;
  sendAct(res, r);
});

// ── POST /api/networks/:id/pending-spaces — accept or dismiss a space an upstream announced (S-9) ──

// The rights are the act's: accepting runs the join rule over the accepting token, dismissing needs the settings right.
crudRouter.post('/:id/pending-spaces', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  const parsed = ResolvePendingSpaceBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const r = await resolvePendingSpaceAct(req.authToken as Parameters<typeof resolvePendingSpaceAct>[0], req.params['id'] as string, parsed.data);
  if (r.audit) req.auditSnapshots = r.audit;
  sendAct(res, r);
});

// ── POST /api/networks/:id/spaces — add a space to a network this instance governs (F-38.3) ──

// The publisher of a pub/sub network or the root of a braintree; the rights are the act's (`networkAddSpaceRefusal`).
crudRouter.post('/:id/spaces', globalRateLimit, requireAuth, denyReadOnly, (req, res) => {
  const parsed = AddNetworkSpaceBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const r = addNetworkSpaceAct(req.authToken as Parameters<typeof addNetworkSpaceAct>[0], req.params['id'] as string, parsed.data);
  if (r.audit) req.auditSnapshots = r.audit;
  sendAct(res, r);
});

