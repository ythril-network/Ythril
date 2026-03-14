/**
 * Notify channel — peers call this to announce events.
 * Used for out-of-band notifications: pending votes, departures, space deletion warnings.
 *
 * Route prefix: /api/notify
 * Rate limit: notifyRateLimit (60/min)
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { notifyRateLimit } from '../rate-limit/middleware.js';
import { getConfig, saveConfig } from '../config/loader.js';
import { log } from '../util/log.js';

export const notifyRouter = Router();

// ── Event schema ────────────────────────────────────────────────────────────

const NotifyBody = z.object({
  networkId: z.string().min(1),
  instanceId: z.string().min(1),  // caller's instanceId
  event: z.enum([
    'vote_pending',
    'member_departed',
    'space_deletion_pending',
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
      res.status(403).json({ error: 'Caller is not a member of this network' });
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

  // For space_deletion_pending events, trigger a sync so we pull the vote round immediately
  if (event === 'space_deletion_pending') {
    import('../sync/engine.js').then(({ runSyncForNetwork }) => {
      runSyncForNetwork(networkId).catch(err =>
        log.error(`Triggered sync (space_deletion_pending) for network ${networkId} failed: ${err}`),
      );
    }).catch(err => log.error(`Failed to import sync engine (space_deletion_pending): ${err}`));
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

notifyRouter.post('/trigger', notifyRateLimit, requireAuth, (req, res) => {
  const { networkId } = req.body as { networkId?: string };
  if (!networkId) { res.status(400).json({ error: 'networkId required' }); return; }

  import('../sync/engine.js').then(({ runSyncForNetwork }) => {
    void runSyncForNetwork(networkId);
  }).catch(err => log.error(`trigger import: ${err}`));

  res.json({ status: 'triggered', networkId });
});
