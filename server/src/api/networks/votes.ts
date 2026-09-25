/**
 * Governance votes — list open rounds and cast a vote.

 *
 * Split out of the api/networks.ts monolith (A17.5); handlers are unchanged.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../../auth/middleware.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { getConfig, saveConfig } from '../../config/loader.js';
import { concludeRoundIfReady, sendMemberRemovedNotify } from '../../sync/governance.js';
import { makeSignedOwnCast } from '../../util/signing.js';
import { log } from '../../util/log.js';
import { applyConcludedSpaceRounds } from '../../spaces/apply-wipe-round.js';

export const votesRouter = Router();

const CastVoteBody = z.object({
  vote: z.enum(['yes', 'veto']),
});

// ── GET /api/networks/:id/vote — list open vote rounds ─────────────────────

votesRouter.get('/:id/votes', globalRateLimit, requireAdmin, (req, res) => {
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === req.params['id']);
  if (!net) { res.status(404).json({ error: 'Network not found' }); return; }
  res.json({ rounds: net.pendingRounds.filter(r => !r.concluded) });
});


// ── POST /api/networks/:id/votes/:roundId — cast a vote ────────────────────

votesRouter.post('/:id/votes/:roundId', globalRateLimit, requireAdmin, (req, res) => {
  try {
    const parsed = CastVoteBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

    const cfg = getConfig();
    const net = cfg.networks.find(n => n.id === req.params['id']);
    if (!net) { res.status(404).json({ error: 'Network not found' }); return; }

    const round = net.pendingRounds.find(r => r.roundId === req.params['roundId'] && !r.concluded);
    if (!round) { res.status(404).json({ error: 'Round not found or already concluded' }); return; }

    const instanceId = cfg.instanceId;
    const existing = round.votes.findIndex(v => v.instanceId === instanceId);
    const cast = makeSignedOwnCast(net.id, round, instanceId, parsed.data.vote);
    if (existing >= 0) { round.votes[existing] = cast; }
    else { round.votes.push(cast); }

    concludeRoundIfReady(net, round);

    // If join round concluded and passed, add the pending member —
    // but only if this instance is the direct parent in the tree (for braintree networks
    // this check prevents ancestor-voters from adding the member to their own list).
    if (round.concluded && round.type === 'join' && round.pendingMember &&
        !net.members.some(m => m.instanceId === round.subjectInstanceId)) {
      const vetoCount = round.votes.filter(v => v.vote === 'veto').length;
      const isDirectParent = !round.pendingMember.parentInstanceId ||
        round.pendingMember.parentInstanceId === cfg.instanceId;
      if (vetoCount === 0 && (net.type !== 'braintree' || isDirectParent)) {
        net.members.push(round.pendingMember);
        log.info(`Join vote ${round.roundId} passed — added member ${round.subjectLabel} to network ${net.id}`);
      }
    }

    // S-9: deletion and wipe through one decision — a round that passed, on a space this network carries, once.
    applyConcludedSpaceRounds(net, [round], 'local vote');

    // If remove round concluded and passed, notify the ejected member
    if (round.concluded && round.passed && round.type === 'remove') {
      sendMemberRemovedNotify(round.subjectUrl, round.subjectInstanceId, net.id);
    }

    saveConfig(cfg);
    log.info(`Vote cast in round ${round.roundId}: ${parsed.data.vote} (concluded=${round.concluded})`);
    res.json({ concluded: round.concluded, round });
  } catch (err) {
    log.error(`POST /api/networks votes: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});
