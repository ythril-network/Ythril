/**
 * Peer-facing network membership — list members, request to join.
 *
 * Split out of the api/sync.ts monolith (A17.6); handlers are unchanged.
 */
import { Router } from 'express';
import { syncRateLimit } from '../../rate-limit/middleware.js';
import { getConfig, loadConfig, saveConfig } from '../../config/loader.js';
import { requireAuth, denyReadOnly } from '../../auth/middleware.js';
import { peerRelayCaller, PEER_RELAY_REFUSAL } from '../../auth/peer-relay.js';
import { log, logSafe } from '../../util/log.js';
import { reportServerFailure } from '../../util/report-failure.js';
import { isPeerUrlAllowed } from '../../sync/peer-fetch.js';
import { pinMemberSigningKey, type SigningKeyRotation } from '../../util/signing.js';
import { peerFloorRefusal } from '../../sync/peer-floor.js';
import type { NetworkMember } from '../../config/types.js';
import { adoptAnnouncedSpaces, healAnnouncedAliases } from '../../networks/network-spaces.js';
import { selfRecordFor } from '../../networks/self-record.js';

export const syncMembersRouter = Router();


// ═══════════════════════════════════════════════════════════════════════════
// GOSSIP — member list & votes
// ═══════════════════════════════════════════════════════════════════════════

// ── Ejection guard ────────────────────────────────────────────────────────
// If this instance has been removed from a network by vote, all sync requests
// for that network return 401 {"error":"ejected"} so peers stop trying to sync.
syncMembersRouter.use('/networks/:networkId', (req, res, next) => {
  const cfg = getConfig();
  if (cfg.ejectedFromNetworks?.includes(req.params['networkId'] ?? '')) {
    res.status(401).json({ error: 'ejected' });
    return;
  }
  next();
});

/**
 * GET /api/sync/networks/:networkId/members
 * Return our current view of this network's member list (excluding sensitive fields).
 */
syncMembersRouter.get('/networks/:networkId/members', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const cfg = getConfig();
    const net = cfg.networks.find(n => n.id === req.params['networkId']);
    if (!net) { res.status(404).json({ error: 'Network not found' }); return; }

    const safeMembers = net.members.map(m => {
      const { tokenHash: _th, skipTlsVerify: _sv, ...safe } = m;
      return safe;
    });
    res.json({ members: safeMembers, updatedAt: new Date().toISOString() });
  } catch (err) {
    reportServerFailure('sync GET /networks/:networkId/members', err);
    res.status(500).json({ error: 'Internal error' });
  }
});


/**
 * POST /api/sync/networks/:networkId/members
 * Peer announces its own member record or relays records it knows about.
 * Only a member may update its own record (gossip poisoning protection).
 */
syncMembersRouter.post('/networks/:networkId/members', syncRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    /*
     * Gossip poisoning protection: only accept a record for the member the caller represents.
     *
     * The rule has two halves and only one of them used to be enforced. A peer token may update its own
     * member record and no other — that half was below. The other half was a COMMENT: "tokens without
     * peerInstanceId (admin/local) may update any record", sitting where a check should have been, in front
     * of a route guarded by `requireAuth` and `denyReadOnly`. So any write-capable token could rewrite any
     * member's url, label or children.
     *
     * `peerRelayCaller` answers both halves once, and `votes.ts` asks it the same question.
     *
     * WHO before WHAT: this ran after the network lookup, so an unauthorised caller learned whether a
     * network existed and got a 404 rather than a 403 for the ids that did not.
     */
    const caller = peerRelayCaller(req.authToken as Parameters<typeof peerRelayCaller>[0]);
    if (caller.kind === 'refused') {
      res.status(403).json({ error: PEER_RELAY_REFUSAL });
      return;
    }

    const cfg = getConfig();
    const net = cfg.networks.find(n => n.id === req.params['networkId']);
    if (!net) { res.status(404).json({ error: 'Network not found' }); return; }

    const incoming = req.body as Partial<NetworkMember>;
    if (!incoming?.instanceId || !incoming?.label) {
      res.status(400).json({ error: 'instanceId and label required' });
      return;
    }

    const callerPeerId = caller.kind === 'peer' ? caller.peerInstanceId : undefined;
    if (callerPeerId && callerPeerId !== incoming.instanceId) {
      res.status(403).json({ error: 'Token is not authorized to update this member record' });
      return;
    }

    const existing = net.members.find(m => m.instanceId === incoming.instanceId);
    if (!existing) {
      // Unknown member — relay is informational; don't auto-add
      res.status(200).json({ status: 'unknown_member' });
      return;
    }

    // Only the declared instance may update its own record's URL/label/children/direction
    // We trust the caller if they can authenticate (which syncAuth already verified).
    // For simplicity in Phase 3 we apply without full cryptographic proof.
    const fresh = loadConfig();
    const freshNet = fresh.networks.find(n => n.id === req.params['networkId']);
    if (freshNet) {
      const idx = freshNet.members.findIndex(m => m.instanceId === incoming.instanceId);
      if (idx >= 0) {
        // Re-validate a peer-supplied URL before accepting it — a peer must not be
        // able to move itself onto a blocked/internal address post-admission (SSRF).
        let nextUrl = freshNet.members[idx]!.url;
        if (incoming.url && incoming.url !== nextUrl) {
          if (isPeerUrlAllowed(incoming.url)) nextUrl = incoming.url;
          else log.warn(`Member self-update: rejected unsafe URL from ${logSafe(incoming.instanceId)}: ${logSafe(incoming.url)}`);
        }
        /*
         * The announced version is stored here and NOWHERE ELSE, which is why this route is the one
         * hole in the floor guard: it is how the guard learns what to check. A peer below the floor
         * may still announce itself — it updates its own label, url and version and nothing else — so
         * an operator can see what a refused peer runs, and so an UPGRADED peer can tell us it is now
         * current without needing a route it is currently refused on.
         *
         * `?? existing` rather than a bare assignment: an older peer sends no `version` field at all,
         * and overwriting a known version with `undefined` on every gossip round would make a
         * previously-reported version disappear.
         */
        const updated = {
          ...freshNet.members[idx]!,
          label: incoming.label ?? freshNet.members[idx]!.label,
          url: nextUrl,
          children: incoming.children ?? freshNet.members[idx]!.children,
          version: incoming.version ?? freshNet.members[idx]!.version,
          /*
           * Stamped here as well as on the outbound exchange, because an announce IS a completed
           * exchange — a peer that dials us and names no version has told us it predates version
           * reporting just as surely as one that answers our call. Stamping only outbound would
           * leave a pull-only peer permanently unjudgeable.
           */
          versionCheckedAt: new Date().toISOString(),
          lastSyncAt: new Date().toISOString(),
        };
        const belowFloor = peerFloorRefusal(updated.version, updated.versionCheckedAt);
        if (belowFloor) {
          log.warn(`Member ${logSafe(incoming.instanceId)} on network ${net.id} is below the peer floor: ${logSafe(belowFloor)}`);
        }
        // Trust-on-first-use pin; a change to a different key is accepted only
        // with a valid rotation proof carried on the self-record.
        const incomingRotation = (incoming as { signingKeyRotation?: SigningKeyRotation }).signingKeyRotation;
        pinMemberSigningKey(updated, incoming.signingPublicKey, incomingRotation);
        freshNet.members[idx] = updated;
        saveConfig(fresh);
      }
    }

    /*
     * F-38.3: a space the caller's network carries and ours does not. Adopted only when the caller is our UPSTREAM —
     * our publisher, our tree parent — and `adoptAnnouncedSpaces` is where that is decided, so a subscriber announcing
     * a space to its publisher changes nothing. After the member update, which saved: adoption re-reads the config.
     */
    if (callerPeerId) {
      // Q-133: the alias heal first, so a network id this instance merely lacks an alias for is not adopted as a
      // second space. It swallows and logs its own failure: this route must still answer.
      const announced = incoming as { spaces?: unknown; spaceNames?: unknown };
      await healAnnouncedAliases(net.id, callerPeerId, announced.spaces, announced.spaceNames);
      await adoptAnnouncedSpaces(net.id, callerPeerId, announced.spaces);
    }

    // Piggyback our own identity in the response so the caller can update their record for us — built by the one
    // builder both directions use (`networks/self-record.ts`), from the config as it is NOW, after adoption.
    const liveNet = getConfig().networks.find(n => n.id === net.id) ?? net;
    res.status(200).json({ status: 'ok', self: selfRecordFor(cfg, liveNet, existing) });
  } catch (err) {
    log.error(`sync POST members: ${logSafe(String(err))}`);
    res.status(500).json({ error: 'Internal error' });
  }
});
