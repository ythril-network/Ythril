/**
 * Notify channel — peers call this to announce events.
 * Used for out-of-band notifications: pending votes, departures, space deletion warnings.
 *
 * Route prefix: /api/notify
 * Rate limit: notifyRateLimit (60/min)
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireAdmin, isInstanceAdmin } from '../auth/middleware.js';
import { notifyRateLimit } from '../rate-limit/middleware.js';
import { getConfig, saveConfig } from '../config/loader.js';
import { revokePeerCredentialsIfOrphaned } from '../auth/tokens.js';
import { log } from '../util/log.js';

export const notifyRouter = Router();

// ── Event schema ────────────────────────────────────────────────────────────

const NotifyBody = z.object({
  networkId: z.string().min(1),
  instanceId: z.string().min(1),  // caller's instanceId
  event: z.enum([
    'vote_pending',
    'member_departed',
    'member_removed',           // sent to the ejected instance after a remove vote passes
    'space_deletion_pending',
    'space_wipe_pending',       // a wipe round is open — pull it now rather than at the next scheduled sync
    'sync_available',   // "I have new data, come pull me"
    'ping',             // health check / keep-alive
  ]),
  data: z.record(z.string(), z.unknown()).optional(),  // event-specific payload
});

// In-memory event log (not persistent — restart clears it)
// Production deployments would store this in MongoDB.
interface NotifyEvent {
  id: string;
  networkId: string;
  instanceId: string;
  event: string;
  data?: Record<string, unknown>;
  receivedAt: string;
}

const _events: NotifyEvent[] = [];
const MAX_EVENTS = 500;

// ── POST /api/notify ────────────────────────────────────────────────────────

notifyRouter.post('/', notifyRateLimit, requireAuth, (req, res) => {
  const parsed = NotifyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { networkId, instanceId, event, data } = parsed.data;

  // Validate the caller is a member of the network
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  if (!net) {
    res.status(404).json({ error: 'Network not found' });
    return;
  }

  const isMember = net.members.some(m => m.instanceId === instanceId);
  if (!isMember) {
    // Allow if instanceId matches our own instance (for self-test pings)
    if (instanceId !== cfg.instanceId) {
      // member_departed is an advisory notification: a peer announcing they are
      // leaving. Accept idempotently regardless of current membership state —
      // the member may already have been removed by a prior handling of this event,
      // or may never have been a member on this replica (e.g. asymmetric config).
      if (event !== 'member_departed') {
        res.status(403).json({ error: 'Caller is not a member of this network' });
        return;
      }
    }
  }

  // Verify the caller's token is authorised to claim this instanceId.
  // Peer tokens created during the invite handshake carry a peerInstanceId field
  // linking the PAT to the specific peer.  Admin tokens are exempt (admins
  // already have full instance control).  Non-admin / non-peer tokens may only
  // send events as the local instance (self-test pings).
  if (instanceId !== cfg.instanceId) {
    const authToken = req.authToken as { peerInstanceId?: string; admin?: boolean };
    if (!isInstanceAdmin(authToken) && authToken.peerInstanceId !== instanceId) {
      res.status(403).json({ error: 'Token is not authorised for the claimed instanceId' });
      return;
    }
  }

  const entry: NotifyEvent = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    networkId,
    instanceId,
    event,
    data,
    receivedAt: new Date().toISOString(),
  };

  _events.push(entry);
  if (_events.length > MAX_EVENTS) _events.shift(); // rolling window

  log.info(`Notify: [${event}] from ${instanceId} in network ${networkId}`);

  // For sync_available events, we trigger an async sync run
  if (event === 'sync_available') {
    import('../sync/engine.js').then(({ runSyncForNetwork }) => {
      runSyncForNetwork(networkId).catch(err =>
        log.error(`Triggered sync for network ${networkId} failed: ${err}`),
      );
    }).catch(err => log.error(`Failed to import sync engine: ${err}`));
  }

  // For a pending space_deletion or space_wipe, trigger a sync so we pull the vote round immediately.
  // Both are irreversible and space-scoped, so the round wants to be in front of an operator now rather
  // than at the next scheduled cycle — a deadline that expires unseen is a vote nobody got to cast.
  if (event === 'space_deletion_pending' || event === 'space_wipe_pending') {
    import('../sync/engine.js').then(({ runSyncForNetwork }) => {
      runSyncForNetwork(networkId).catch(err =>
        log.error(`Triggered sync (${event}) for network ${networkId} failed: ${err}`),
      );
    }).catch(err => log.error(`Failed to import sync engine (${event}): ${err}`));
  }

  // N-7: when a member departs, auto-adopt its children as direct children of this instance
  if (event === 'member_departed' && net.type === 'braintree') {
    const orphans = net.members.filter(m => m.parentInstanceId === instanceId);
    if (orphans.length > 0) {
      const cfgW = getConfig();
      const netW = cfgW.networks.find(n => n.id === networkId);
      if (netW) {
        let changed = false;
        for (const orphan of netW.members.filter(m => m.parentInstanceId === instanceId)) {
          orphan.parentInstanceId = cfgW.instanceId;
          const me = netW.members.find(m => m.instanceId === cfgW.instanceId);
          if (me) {
            me.children = me.children ?? [];
            if (!me.children.includes(orphan.instanceId)) me.children.push(orphan.instanceId);
          }
          log.info(
            `N-7 auto-adopt: re-parented '${orphan.label}' (${orphan.instanceId}) ` +
            `from departed ${instanceId} in network '${netW.label}'`,
          );
          changed = true;
        }
        if (changed) saveConfig(cfgW);
      }
    }
  }

  // All network types: remove the departed member from our local member list
  if (event === 'member_departed') {
    const cfgDep = getConfig();
    const netDep = cfgDep.networks.find(n => n.id === networkId);
    if (netDep) {
      const depIdx = netDep.members.findIndex(m => m.instanceId === instanceId);
      if (depIdx >= 0) {
        netDep.members.splice(depIdx, 1);
        saveConfig(cfgDep);
        log.info(`Departed member ${instanceId} removed from network ${networkId}`);
      }
    }
    // The departing peer's PAT stays valid only while it is still a member of
    // some other shared network; otherwise revoke it (and our outbound token).
    revokePeerCredentialsIfOrphaned(instanceId)
      .catch(err => log.error(`peer credential revocation for ${instanceId}: ${err}`));
  }

  // We have been ejected from this network — mark as ejected and remove it locally
  if (event === 'member_removed') {
    const cfgEject = getConfig();
    cfgEject.ejectedFromNetworks = cfgEject.ejectedFromNetworks ?? [];
    if (!cfgEject.ejectedFromNetworks.includes(networkId)) {
      cfgEject.ejectedFromNetworks.push(networkId);
    }
    const netIdx = cfgEject.networks.findIndex(n => n.id === networkId);
    const formerMembers = netIdx >= 0 ? cfgEject.networks[netIdx]!.members.map(m => m.instanceId) : [];
    if (netIdx >= 0) {
      cfgEject.networks.splice(netIdx, 1);
    }
    saveConfig(cfgEject);
    log.warn(`Ejected from network ${networkId} — network removed and marked as ejected`);
    // Ex-peers of the deleted network keep their PATs only if they still share
    // another network with us; otherwise their credentials are revoked so they
    // cannot keep hitting our data endpoints after the ejection.
    for (const memberId of formerMembers) {
      if (memberId === cfgEject.instanceId) continue;
      revokePeerCredentialsIfOrphaned(memberId)
        .catch(err => log.error(`peer credential revocation for ${memberId}: ${err}`));
    }
  }

  res.status(204).end();
});

// ── GET /api/notify — list recent events (admin) ───────────────────────────

notifyRouter.get('/', notifyRateLimit, requireAuth, (req, res) => {
  const { networkId, limit = '50' } = req.query as Record<string, string>;
  let results = _events.slice().reverse(); // newest first
  if (networkId) results = results.filter(e => e.networkId === networkId);
  const pageSize = Math.min(parseInt(limit, 10) || 50, 200);
  res.json({ events: results.slice(0, pageSize) });
});

// ── POST /api/notify/trigger — manually trigger a sync (admin) ────────────
//
// Fire-and-forget by default (`{ status: 'triggered' }`). Pass `?wait=true` (C6) to run the cycle
// synchronously and get its outcome — bounded by `?timeoutMs` (default 30s, clamped 1s–120s) so a
// slow or stuck sync can never hang the request; on timeout the cycle keeps running in the background.

import { unknownPeerRefusal } from '../sync/peer-target.js';

const TIMEOUT_SENTINEL = Symbol('sync-trigger-timeout');

/*
 * `requireAdmin`, matching `POST /api/networks/:id/sync`, and it was `requireAuth` until 2026-09-09.
 *
 * ANY valid token could start a sync cycle on any network id it named — proven by minting a token with
 * `instanceAdmin: false`, every area `none` and no spaces, and getting `200 {"status":"triggered"}`. The
 * sibling route refused the same token with `403 Admin token required`, which is what made the difference
 * visible: two doors onto one capability, and the weaker one in charge.
 *
 * The guard-coverage gate did not see it because `notifyRouter` is exempt as a whole, under a reason —
 * "peer notifications, peer-authenticated" — that is true of `POST /api/notify` and was never true of this
 * route. Its own comment above has always called it "(admin)". An exemption whose reason covers one route
 * and is applied to every route on the router is the shape `CLAUDE.md` warns about, and this is what it
 * costs.
 *
 * Found while answering `Q-21`, and worth saying plainly: adding `peerId` here in `Q-20` widened what an
 * unprivileged caller could aim before this line was written.
 */
notifyRouter.post('/trigger', notifyRateLimit, requireAdmin, async (req, res) => {
  const { networkId, peerId } = req.body as { networkId?: string; peerId?: string };
  /*
   * `peerId` — one peer rather than a whole network, and it is here because MCP had it and REST did not.
   *
   * `sync_now` has taken a `peerId` since it was written; no REST route accepted one anywhere, so a REST
   * caller could sync a network and never a single peer. One capability, two doors, and the difference
   * only visible from outside — found by the parameter-parity gate rather than reported (`Q-20`).
   *
   * The id is checked against the configured members by `unknownPeerRefusal`, which is the SEC-16 rule the
   * tool already ran: an unvalidated value becomes the address the sync engine connects to.
   */
  if (networkId && peerId) {
    res.status(400).json({ error: 'Send networkId or peerId, not both — they name different subjects.' });
    return;
  }
  if (!networkId && !peerId) { res.status(400).json({ error: 'networkId or peerId required' }); return; }
  const wait = req.query['wait'] === 'true' || req.query['wait'] === '1';

  if (peerId) {
    const refusal = unknownPeerRefusal(peerId);
    if (refusal) { res.status(refusal.status).json({ error: refusal.error }); return; }
    const { runSyncForPeer } = await import('../sync/engine.js');
    if (!wait) {
      void runSyncForPeer(peerId).catch(err => log.error(`Triggered sync for peer ${peerId} failed: ${err}`));
      res.json({ status: 'triggered', peerId });
      return;
    }
    // No timeout race here: `runSyncForPeer` is bounded by the peer's own request timeouts, and the
    // network path's race exists because a cycle can span many peers. One peer cannot.
    try {
      const r = await runSyncForPeer(peerId);
      res.json({ status: 'completed', peerId, networksSynced: r.networksSynced, errors: r.errors });
    } catch (err) {
      log.error(`Synchronous trigger for peer ${peerId} failed: ${err}`);
      res.status(500).json({ status: 'error', peerId, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  let runSyncForNetwork: (id: string) => Promise<{ synced: number; errors: number }>;
  try {
    ({ runSyncForNetwork } = await import('../sync/engine.js'));
  } catch (err) {
    log.error(`trigger import: ${err}`);
    res.status(500).json({ error: 'Sync engine unavailable' });
    return;
  }

  const net = networkId as string;
  if (!wait) {
    void runSyncForNetwork(net).catch(err => log.error(`Triggered sync for ${networkId} failed: ${err}`));
    res.json({ status: 'triggered', networkId });
    return;
  }

  const timeoutMs = Math.min(Math.max(parseInt(String(req.query['timeoutMs'] ?? ''), 10) || 30_000, 1_000), 120_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(TIMEOUT_SENTINEL), timeoutMs); });
  try {
    const result = await Promise.race([runSyncForNetwork(net), timeout]);
    res.json({ status: 'completed', networkId, synced: result.synced, errors: result.errors });
  } catch (err) {
    if (err === TIMEOUT_SENTINEL) {
      res.status(504).json({ status: 'timeout', networkId, timeoutMs });
    } else {
      log.error(`Synchronous trigger for ${networkId} failed: ${err}`);
      res.status(500).json({ status: 'error', networkId, error: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    clearTimeout(timer);
  }
});
