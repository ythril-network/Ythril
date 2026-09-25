/**
 * Governance votes — list open rounds and cast a vote.

 *
 * Split out of the api/networks.ts monolith (A17.5). The decisions live in `networks/vote-acts.ts` since F-36 slice 2.
 */
import { Router } from 'express';
import { requireAdmin } from '../../auth/middleware.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { log } from '../../util/log.js';
import { CastVoteBody, castVoteAct, listOpenVotesAct } from '../../networks/vote-acts.js';
import { sendAct } from './_shared.js';

export const votesRouter = Router();

// ── GET /api/networks/:id/votes — list open vote rounds ────────────────────

// The acts are shared with MCP `network_votes` / `network_vote` (F-36 slice 2), so both doors answer alike.
votesRouter.get('/:id/votes', globalRateLimit, requireAdmin, (req, res) => {
  sendAct(res, listOpenVotesAct(req.params['id'] as string));
});


// ── POST /api/networks/:id/votes/:roundId — cast a vote ────────────────────

votesRouter.post('/:id/votes/:roundId', globalRateLimit, requireAdmin, (req, res) => {
  try {
    // Parsed here as well as in the act: the same-parameters gate reads a route's accepted keys off this call.
    const parsed = CastVoteBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
    sendAct(res, castVoteAct(req.params['id'] as string, req.params['roundId'] as string, parsed.data));
  } catch (err) {
    log.error(`POST /api/networks votes: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

