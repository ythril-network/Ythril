/**
 * Peer-facing governance votes — list rounds, accept a peer's cast.
 *
 * Split out of the api/sync.ts monolith (A17.6); handlers are unchanged.
 */
import { Router } from 'express';
import { syncRateLimit } from '../../rate-limit/middleware.js';
import { getConfig, loadConfig, saveConfig } from '../../config/loader.js';
import { requireAuth, denyReadOnly } from '../../auth/middleware.js';
import { peerRelayCaller, PEER_RELAY_REFUSAL } from '../../auth/peer-relay.js';
import { log } from '../../util/log.js';
import { reportServerFailure } from '../../util/report-failure.js';
import { applyConcludedSpaceRounds } from '../../spaces/apply-wipe-round.js';
import { acceptVoteCast } from '../../util/signing.js';
import { concludeRoundIfReady, sendMemberRemovedNotify } from '../../sync/governance.js';

export const syncVotesRouter = Router();


/**
 * GET /api/sync/networks/:networkId/votes
 * Return current open vote rounds for this network.
 */
syncVotesRouter.get('/networks/:networkId/votes', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const cfg = getConfig();
    const net = cfg.networks.find(n => n.id === req.params['networkId']);
    if (!net) { res.status(404).json({ error: 'Network not found' }); return; }

    // Open rounds, and PASSED space_addition and meta_change rounds (F-38.4, F-39.4): on a club the organiser's own
    // yes concludes one the moment it opens, so a member would never see it otherwise. The receiver re-decides it from the casts under its own rule
    // — it adopts the round as open and never takes "passed" on a peer's word.
    const open = net.pendingRounds
      .filter(r => !r.concluded || (r.passed && (r.type === 'space_addition' || r.type === 'meta_change')))
      .map(r => {
        // Strip sensitive key material before sending to a peer instance
        // Local-only state never leaves: `appliedHere` says what THIS instance did (S-9).
        const { inviteKeyHash: _ikh, appliedHere: _ah, ...safeRound } = r;
        if (safeRound.pendingMember) {
          const { tokenHash: _th, ...safeMember } = safeRound.pendingMember;
          safeRound.pendingMember = safeMember as typeof safeRound.pendingMember;
        }
        return safeRound;
      });
    res.json({ rounds: open });
  } catch (err) {
    reportServerFailure('sync GET /networks/:networkId/votes', err);
    res.status(500).json({ error: 'Internal error' });
  }
});


/**
 * POST /api/sync/networks/:networkId/votes/:roundId
 * Peer submits or relays a vote: { vote: 'yes' | 'veto', instanceId }
 */
syncVotesRouter.post('/networks/:networkId/votes/:roundId', syncRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    /*
     * WHO before WHAT, and the order is the point.
     *
     * This check used to sit below the network and round lookups, so an unauthorised caller learned whether
     * a given round existed — an existence oracle over another network's governance — and the 404 arrived
     * before the 403 for every id that did not. Authorising first closes that and makes the refusal
     * testable without constructing a round to be refused on.
     */
    const caller = peerRelayCaller(req.authToken as Parameters<typeof peerRelayCaller>[0]);
    if (caller.kind === 'refused') {
      res.status(403).json({ error: PEER_RELAY_REFUSAL });
      return;
    }

    const body = req.body as { vote: string; instanceId: string; sig?: string; castAt?: string };
    if (!body?.vote || !body?.instanceId || !['yes', 'veto'].includes(body.vote)) {
      res.status(400).json({ error: 'vote (yes|veto) and instanceId required' });
      return;
    }

    const cfg = loadConfig();
    const net = cfg.networks.find(n => n.id === req.params['networkId']);
    if (!net) { res.status(404).json({ error: 'Network not found' }); return; }

    const round = net.pendingRounds.find(r => r.roundId === req.params['roundId'] && !r.concluded);
    if (!round) { res.status(404).json({ error: 'Round not found or concluded' }); return; }

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
    const cast = {
      instanceId: body.instanceId,
      vote: body.vote as 'yes' | 'veto',
      castAt: typeof body.castAt === 'string' ? body.castAt : new Date().toISOString(),
      ...(typeof body.sig === 'string' && body.sig ? { sig: body.sig } : {}),
    };
    const reporter = caller.kind === 'peer' ? caller.peerInstanceId : body.instanceId;
    const decision = acceptVoteCast(net, round, cast, reporter);
    if (!decision.accept) {
      res.status(403).json({ error: `Vote rejected: ${decision.reason}` });
      return;
    }

    // Deduplicate: replace existing vote from this instance if present
    const existing = round.votes.findIndex(v => v.instanceId === body.instanceId);
    if (existing >= 0) { round.votes[existing] = cast; }
    else { round.votes.push(cast); }

    // Check if the round should auto-conclude
    concludeRoundIfReady(net, round);

    // Deletion, wipe and addition, through the function the other two conclusion sites call (X-5, F-38.4). A peer's
    // yes can be the one that carries the round, so this path must apply it too — the half a per-site copy misses.
    applyConcludedSpaceRounds(net, [round], 'peer vote');

    // If a remove round just passed, notify the ejected member
    if (round.concluded && round.passed && round.type === 'remove') {
      sendMemberRemovedNotify(round.subjectUrl, round.subjectInstanceId, net.id);
    }

    // If a join round just passed via this vote relay, add the pending member.
    if (round.concluded && round.type === 'join' && round.pendingMember) {
      const alreadyAdded = net.members.some(m => m.instanceId === round.subjectInstanceId);
      // Braintree: only the direct parent in the tree admits (ancestor-voters
      // must not add the joiner to their own lists). Other vote-governed types:
      // only the instance that holds the joiner's credentials admits — gossip-
      // adopted round copies have pendingMember.tokenHash stripped.
      const mayAdmit = net.type === 'braintree'
        ? (!round.pendingMember.parentInstanceId || round.pendingMember.parentInstanceId === cfg.instanceId)
        : Boolean(round.pendingMember.tokenHash);
      const vetoed = round.votes.some(v => v.vote === 'veto');
      if (!alreadyAdded && mayAdmit && !vetoed) {
        net.members.push(round.pendingMember);
        log.info(`Join round ${round.roundId} passed via vote relay — added ${round.subjectLabel} to network ${net.id}`);
      }
    }

    saveConfig(cfg);
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    log.error(`sync POST votes: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});
