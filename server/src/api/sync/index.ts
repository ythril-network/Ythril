/**
 * Sync protocol endpoints — called by remote peer instances.
 *
 * Route prefix: /api/sync
 * Authentication: validated against the network member's tokenHash using the
 * same Bearer token mechanism as client tokens, but via a separate lookup
 * that checks network member hashes rather than named PATs.
 *
 * Was a single 1713-line api/sync.ts with 24 routes (A17.6). Each sub-router declares full paths, so
 * every URL is unchanged. The ejection guard below stays on the parent and is registered BEFORE the
 * sub-routers, so it still runs ahead of every sync endpoint exactly as it did in the monolith.
 */
import { Router } from 'express';
import { getConfig } from '../../config/loader.js';
import { callerPeerId } from './_shared.js';
import { peerFloorRefusal, MIN_PEER_VERSION } from '../../sync/peer-floor.js';
import { syncDocsRouter } from './docs.js';
import { syncTombstonesRouter } from './tombstones.js';
import { syncManifestRouter } from './manifest.js';
import { syncMembersRouter } from './members.js';
import { syncVotesRouter } from './votes.js';
import { syncWarmRouter } from './warm.js';
import { syncMetaRouter } from './meta.js';
import { syncChangeNotesRouter } from './change-notes.js';
import { resolveNetworkSpaceAlias } from './space-alias.js';

export const syncRouter = Router();

// ── Ejection guard (all sync endpoints) ─────────────────────────────────────
// If this instance has been removed from a network by vote, refuse every sync
// request scoped to that network — data endpoints carry the networkId in the
// query string or body, gossip endpoints in the path (guarded again below).
// Without this, ex-peers could keep syncing data because the network config is
// deleted on ejection and the space-scope check falls back to "space exists".
syncRouter.use((req, res, next) => {
  const nid = (req.query['networkId'] ?? (req.body as Record<string, unknown> | undefined)?.['networkId']) as string | undefined;
  if (nid && typeof nid === 'string' && getConfig().ejectedFromNetworks?.includes(nid)) {
    res.status(401).json({ error: 'ejected' });
    return;
  }
  next();
});

/*
 * ── Peer version floor (all sync endpoints but one) ────────────────────────────────────
 *
 * `P-33` = B: a peer below `MIN_PEER_VERSION` is refused, and the refusal names the version.
 *
 * **HERE, on the parent, for the same reason the ejection guard is here.** The floor is one rule and
 * this repo's most expensive defect is one rule with several implementations, the weakest winning
 * silently. Eight route files could each have grown their own check; one middleware ahead of all of
 * them cannot be forgotten by a route added later.
 *
 * **The one exception is the member announce, and it is not a hole in the floor — it is the floor's
 * input.** A version is only ever learned from gossip, so refusing the announce would mean refusing
 * every peer for having no version and then never being able to learn one: a stale peer could never
 * report that it had been upgraded. What that route lets a below-floor peer do is describe ITSELF —
 * label, url, version — and it already refuses to let a peer write any other member's record. No
 * brain document moves through it.
 *
 * **Only a PEER token is checked.** An admin or local token has no `peerInstanceId`, is not another
 * instance, and has no version to report; running it through the floor would refuse the operator's own
 * tooling for being absent — the absent-is-old rule applied to something that is not a peer at all.
 */
syncRouter.use((req, res, next) => {
  const peerId = callerPeerId(req.authToken as Record<string, unknown> | undefined);
  if (!peerId) { next(); return; }
  // The announce is how a version arrives; see above.
  if (req.method === 'POST' && /\/networks\/[^/]+\/members$/.test(req.path)) { next(); return; }

  const cfg = getConfig();
  for (const net of cfg.networks) {
    const member = net.members.find(m => m.instanceId === peerId);
    if (!member) continue;
    const refusal = peerFloorRefusal(member.version, member.versionCheckedAt);
    if (refusal) {
      res.status(426).json({ error: refusal, minPeerVersion: MIN_PEER_VERSION, peerVersion: member.version ?? null });
      return;
    }
    /*
     * Found in the FIRST network listing this peer and admitted there. A peer we share two networks
     * with runs one build, so its version cannot differ per network — checking every network would
     * refuse on whichever record happened to be staler, which is a fact about our gossip history
     * rather than about the peer.
     */
    next();
    return;
  }
  /*
   * A peer token bound to nothing we list as a member: manually-provisioned tokens and
   * single-side-configured networks both look like this, and `spaceAllowed` already falls back to
   * plain token-space scoping for them. There is no member record to carry a version, so the floor
   * has nothing to say — refusing here would break asymmetric networks that work today, on a rule
   * about versions.
   */
  next();
});

// Q-51: a peer's network space id becomes this instance's local one before any route admits or reads by it.
syncRouter.use(resolveNetworkSpaceAlias);

syncRouter.use(syncDocsRouter);
syncRouter.use(syncTombstonesRouter);
syncRouter.use(syncManifestRouter);
syncRouter.use(syncMembersRouter);
syncRouter.use(syncVotesRouter);
syncRouter.use(syncWarmRouter);
syncRouter.use(syncMetaRouter);
syncRouter.use(syncChangeNotesRouter);
