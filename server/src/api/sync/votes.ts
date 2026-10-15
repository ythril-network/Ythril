/**
 * Peer-facing governance votes — list rounds, accept a peer's cast.
 *
 * Split out of the api/sync.ts monolith (A17.6); handlers are unchanged.
 */
import { Router } from 'express';
import { syncRateLimit } from '../../rate-limit/middleware.js';
import { getConfig, loadConfig, saveConfig } from '../../config/loader.js';
import { requireAuth, denyReadOnly } from '../../auth/middleware.js';
import { peerRelayCaller } from '../../auth/peer-relay.js';
import { roundForPeer } from '../../networks/round-local-state.js';
import { acceptVoteCast, castFromBody } from '../../util/signing.js';
import { concludeRoundIfReady } from '../../sync/governance.js';
import { roundIsOpen } from '../../networks/round-state.js';
import { roundToVoteOn } from '../../networks/vote-acts.js';
import { applyRoundConclusion } from '../../networks/round-conclusion.js';
import { sendCaughtFailure } from '../send-failure.js';
import { requireNetworkStanding } from '../../auth/network-standing.js';

export const syncVotesRouter = Router();


/**
 * GET /api/sync/networks/:networkId/votes
 * Return the vote rounds a peer may act on: those still open — before their deadline, not concluded — and the PASSED
 * `space_addition` and `meta_change` rounds a member that joined later has to learn of.
 */
syncVotesRouter.get('/networks/:networkId/votes', syncRateLimit, requireAuth, requireNetworkStanding('votes-read'), async (req, res) => {
  try {
    const cfg = getConfig();
    const net = cfg.networks.find(n => n.id === req.params['networkId']);
    if (!net) { res.status(404).json({ error: 'Network not found' }); return; }

    // Open rounds, and PASSED space_addition and meta_change rounds (F-38.4, F-39.4): on a club the organiser's own
    // yes concludes one the moment it opens, so a member would never see it otherwise. The receiver re-decides it from the casts under its own rule
    // — it adopts the round as open and never takes "passed" on a peer's word. A round past its deadline is not open
    // whether or not anything has concluded it yet: serving it would hand a peer a round nobody can vote on.
    const now = Date.now();
    const open = net.pendingRounds
      .filter(r => roundIsOpen(r, now) || (r.passed && (r.type === 'space_addition' || r.type === 'meta_change')))
      .map(r => {
        // Strip sensitive key material before sending to a peer instance
        // This instance's own state never leaves (S-7, S-9).
        const { inviteKeyHash: _ikh, ...safeRound } = roundForPeer(r);
        if (safeRound.pendingMember) {
          const { tokenHash: _th, ...safeMember } = safeRound.pendingMember;
          safeRound.pendingMember = safeMember as typeof safeRound.pendingMember;
        }
        return safeRound;
      });
    res.json({ rounds: open });
  } catch (err) {
    sendCaughtFailure(res, 'sync GET /networks/:networkId/votes', err);
  }
});


/**
 * POST /api/sync/networks/:networkId/votes/:roundId
 * Peer submits or relays a vote: { vote: 'yes' | 'veto', instanceId }
 */
syncVotesRouter.post('/networks/:networkId/votes/:roundId', syncRateLimit, requireAuth, requireNetworkStanding('votes-relay'), denyReadOnly, async (req, res) => {
  try {
    /*
     * WHO before WHAT: `requireNetworkStanding('votes-relay')` has already refused every caller that is not an administrator or a
     * member of this network, before any network or round lookup, so the route is no oracle of which rounds exist. It is the ONE
     * refusal; this read only names the caller, and a refused kind here means the middleware was removed from the route.
     */
    const caller = peerRelayCaller(req.authToken as Parameters<typeof peerRelayCaller>[0]);
    if (caller.kind === 'refused') throw new Error('votes relay reached without requireNetworkStanding');

    // The one reading of a cast off the wire (Q-138), so the bound signature is not dropped here.
    const cast = castFromBody(req.body);
    if (!cast) {
      res.status(400).json({ error: 'vote (yes|veto) and instanceId required' });
      return;
    }

    const cfg = loadConfig();
    const net = cfg.networks.find(n => n.id === req.params['networkId']);
    if (!net) { res.status(404).json({ error: 'Network not found' }); return; }

    // One `now` for the check and the conclusion. The refusal is the operator act's own, word for word (`roundToVoteOn`).
    const now = Date.now();
    const found = roundToVoteOn(net, req.params['roundId'] as string, now);
    if ('refusal' in found) {
      const { status, ...body } = found.refusal;
      res.status(status).json(body);
      return;
    }
    const { round } = found;

    /*
     * Vote forgery prevention. A signed cast is accepted from any reporter — its signature proves the voter
     * cast it. An unsigned cast is accepted only from its own voter: a peer token may relay only its own
     * instanceId, and an instance administrator may relay any unsigned cast.
     *
     * **The reporter used to DEFAULT, and that made the check vacuous.** It read
     * `callerPeerId ?? body.instanceId`, so a caller with no peer id became the cast's own instance: the
     * reporter and the voter were the same value by construction, `acceptVoteCast` took the own-cast path
     * every time, and a network with `requireSignedVotes` accepted an unsigned cast attributed to any
     * instance. On any round — and the rounds include `remove`, `space_deletion` and `space_wipe`, which
     * pass on a single yes with no veto for `club` and `pubsub`.
     *
     * The relay is authorised above, so `admin` is a caller this route has established rather than the
     * shape of a token it could not identify. `members.ts` asks the same question through the same predicate.
     */
    const reporter = caller.kind === 'peer' ? caller.peerInstanceId : cast.instanceId;
    const decision = acceptVoteCast(net, round, cast, reporter);
    if (!decision.accept) {
      res.status(403).json({ error: `Vote rejected: ${decision.reason}` });
      return;
    }

    // Deduplicate: replace existing vote from this instance if present
    const existing = round.votes.findIndex(v => v.instanceId === cast.instanceId);
    if (existing >= 0) { round.votes[existing] = cast; }
    else { round.votes.push(cast); }

    // Check if the round should auto-conclude, and apply what its conclusion does here. A peer's yes can be the one that
    // carries the round, so this path must apply it too — through the one function every conclusion site calls.
    concludeRoundIfReady(net, round, now);
    applyRoundConclusion(net, cfg, [round], 'peer vote');

    saveConfig(cfg);
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    sendCaughtFailure(res, 'sync POST votes', err);
  }
});
