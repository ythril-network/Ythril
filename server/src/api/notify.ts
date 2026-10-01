/**
 * Notify channel — peers call this to announce events.
 * Used for out-of-band notifications: pending votes, departures, space deletion warnings.
 *
 * Route prefix: /api/notify
 * Rate limit: notifyRateLimit (60/min)
 */

import { Router } from 'express';
import { pageList } from '../brain/list-page.js';
import { defaultBudgetChars } from '../brain/result-budget.js';
import { z } from 'zod';
import { requireAuth, isInstanceAdmin } from '../auth/middleware.js';
import { notifyRateLimit } from '../rate-limit/middleware.js';
import { getConfig, saveConfig } from '../config/loader.js';
import { revokePeerCredentialsIfOrphaned } from '../auth/tokens.js';
import { log } from '../util/log.js';

export const notifyRouter = Router();

// ── Event schema ────────────────────────────────────────────────────────────

export const NotifyBody = z.object({
  networkId: z.string().min(1),
  instanceId: z.string().min(1),  // caller's instanceId
  event: z.enum([
    'vote_pending',
    'member_departed',
    'member_removed',           // sent to the ejected instance after a remove vote passes
    'space_deletion_pending',
    'space_wipe_pending',       // a wipe round is open — pull it now rather than at the next scheduled sync
    // A schema-change round is open. `spaces/meta-update.ts` has sent this since the schema vote shipped and it was
    // never in this list, so every peer refused it with a 400 that the sender's fire-and-forget never read (`Q-108`).
    'meta_change_pending',
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

const MAX_EVENTS = 500;

/** Bytes the notify ring may hold across its events — the axis the ring costs on, beside its count (`Q-108`). */
const NOTIFY_RING_MAX_BYTES = 1024 * 1024;

/**
 * The kept events, bounded on BOTH axes: a count (`MAX_EVENTS`) and the bytes they hold (`NOTIFY_RING_MAX_BYTES`).
 * Oldest first out, whichever bound binds. Counted alone, the ring was a count of unbounded things: 500 events of
 * up to the JSON body limit each could hold gigabytes.
 */
class NotifyRing {
  private readonly events: { event: NotifyEvent; bytes: number }[] = [];
  private held = 0;

  push(event: NotifyEvent): void {
    const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
    this.events.push({ event, bytes });
    this.held += bytes;
    while (this.events.length > MAX_EVENTS || (this.held > NOTIFY_RING_MAX_BYTES && this.events.length > 0)) {
      this.held -= this.events.shift()!.bytes;
    }
  }

  /** Oldest first. */
  list(): NotifyEvent[] { return this.events.map(e => e.event); }

  bytes(): number { return this.held; }
}

export const notifyRing = new NotifyRing();

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

  notifyRing.push(entry);

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
  const { networkId, limit, skip, maxChars, maxBytes } = req.query as Record<string, string | undefined>;
  let results = notifyRing.list().reverse(); // newest first
  if (networkId) results = results.filter(e => e.networkId === networkId);
  // Q-130: the shared page rule, so a list cut at its page size says so and can be read on with `skip`. It was
  // `slice(0, 200)` with nothing in the answer to tell a complete list from a cut one.
  const page = pageList(results, { limit, skip, maxChars, maxBytes }, { defaultLimit: 50, maxLimit: 200, budgetChars: defaultBudgetChars('rest') });
  if (!page.ok) { res.status(400).json({ error: page.error }); return; }
  res.json({ events: page.rows, ...page.fields });
});
