/**
 * Joining a network — invite, join, join-remote, and fork.
 *
 * Split out of the api/networks.ts monolith (A17.5). join-remote, invite and fork are acts in `networks/`, shared
 * with their MCP tools (F-36); the peer-protocol `/:id/join` stays here.
 */
import { ForkNetworkBody, forkNetworkAct, inviteKeyAct } from '../../networks/network-acts.js';
import { joinRemoteAct } from '../../networks/join-remote-act.js';
import { sendAct } from './_shared.js';
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { requireAdmin, requireAuth, denyReadOnly } from '../../auth/middleware.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { getConfig, saveConfig, getSecrets, saveSecrets } from '../../config/loader.js';
import { concludeRoundIfReady } from '../../sync/governance.js';
import { buildBraintreeAncestors } from '../../util/braintree.js';
import { makeSignedOwnCast } from '../../util/signing.js';
import { log } from '../../util/log.js';
import type { NetworkMember, VoteRound } from '../../config/types.js';
import { BCRYPT_ROUNDS, SSRF_SAFE_URL, safeMemberList } from './_shared.js';

export const joinRouter = Router();

// ── POST /api/networks/join-remote ─────────────────────────────────────────
// Called by the JOINING brain's UI; the handshake is `networks/join-remote-act.ts`, which MCP `network_join_remote`
// calls too (F-36). F-34.1: the Networks column, checked between apply and finalize. `denyReadOnly` because this was
// `requireAdmin`, which a read-only token never passed.
joinRouter.post('/join-remote', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    sendAct(res, await joinRemoteAct(req.authToken as Parameters<typeof joinRemoteAct>[0], req.body));
  } catch (err) {
    log.error(`POST /api/networks/join-remote: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});


// ── POST /api/networks/:id/invite — generate invite key ───────────────────

// `denyReadOnly` because this was `requireAdmin`, which a read-only token never passed (`F-37`).
// The act is shared with MCP `network_invite` (F-36 slice 3).
joinRouter.post('/:id/invite', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    sendAct(res, await inviteKeyAct(req.authToken as Parameters<typeof inviteKeyAct>[0], req.params['id'] as string));
  } catch (err) {
    log.error(`POST /api/networks/:id/invite: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});


// ── POST /api/networks/:id/join — join via invite key ─────────────────────

const JoinNetworkBody = z.object({
  inviteKey: z.string().min(1),
  instanceId: z.string().min(1),
  label: z.string().min(1).max(200),
  url: SSRF_SAFE_URL,
  token: z.string().min(1),  // plaintext token for inbound auth
  direction: z.enum(['both', 'push', 'pull']).default('both'),
  parentInstanceId: z.string().optional(),
  skipTlsVerify: z.boolean().optional(),
});


joinRouter.post('/:id/join', globalRateLimit, requireAdmin, async (req, res) => {
  try {
    const parsed = JoinNetworkBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

    const cfg = getConfig();
    const net = cfg.networks.find(n => n.id === req.params['id']);
    if (!net) { res.status(404).json({ error: 'Network not found' }); return; }

    const keyValid = net.inviteKeyHash
      ? await bcrypt.compare(parsed.data.inviteKey, net.inviteKeyHash)
      : false;

    if (!keyValid) {
      // Vote-governed joins consume the network's invite key when the round opens
      // and preserve the validated hash on the round record. Re-presenting the
      // same key lets the joiner poll the outcome of its own round.
      for (let i = net.pendingRounds.length - 1; i >= 0; i--) {
        const round = net.pendingRounds[i]!;
        if (round.type !== 'join' || !round.inviteKeyHash) continue;
        if (round.subjectInstanceId !== parsed.data.instanceId) continue;
        if (!await bcrypt.compare(parsed.data.inviteKey, round.inviteKeyHash)) continue;

        if (!round.concluded) {
          res.status(202).json({ status: 'vote_pending', roundId: round.roundId });
          return;
        }
        if (!round.passed) {
          res.status(403).json({ error: 'Join was denied by network governance (vetoed or expired)' });
          return;
        }
        // Passed: the member is normally added when the round concludes; re-add
        // from the round's pendingMember if that side-effect was lost (crash
        // between conclusion and persistence). Re-fetch config after the async
        // bcrypt compares to avoid clobbering concurrent writes.
        const freshCfg = getConfig();
        const freshNet = freshCfg.networks.find(n => n.id === req.params['id']);
        if (!freshNet) { res.status(404).json({ error: 'Network not found' }); return; }
        if (!freshNet.members.some(m => m.instanceId === parsed.data.instanceId)) {
          if (!round.pendingMember) {
            res.status(410).json({ error: 'Join round passed but the member record was not retained — generate a new invite' });
            return;
          }
          freshNet.members.push(round.pendingMember);
          saveConfig(freshCfg);
        }
        res.status(200).json({ status: 'joined', members: safeMemberList(freshNet, parsed.data.instanceId), networkId: freshNet.id });
        return;
      }
      if (!net.inviteKeyHash) {
        res.status(400).json({ error: 'No active invite key — generate one first via POST /invite' });
        return;
      }
      res.status(403).json({ error: 'Invalid invite key' });
      return;
    }

    if (net.members.some(m => m.instanceId === parsed.data.instanceId)) {
      res.status(409).json({ error: 'Member already exists' });
      return;
    }

    const { instanceId, label, url, token, direction, parentInstanceId, skipTlsVerify } = parsed.data;
    const tokenHash = await bcrypt.hash(token, BCRYPT_ROUNDS);
    // Re-fetch config after async bcrypt to avoid clobbering concurrent writes.
    const freshCfg = getConfig();
    const freshNet = freshCfg.networks.find(n => n.id === req.params['id']);
    if (!freshNet) { res.status(404).json({ error: 'Network not found' }); return; }
    if (freshNet.members.some(m => m.instanceId === instanceId)) {
      res.status(409).json({ error: 'Member already exists' });
      return;
    }
    const member: NetworkMember = { instanceId, label, url, tokenHash, direction, parentInstanceId, skipTlsVerify };

    if (freshNet.type === 'closed' || freshNet.type === 'democratic') {
      const round: VoteRound = {
        roundId: uuidv4(),
        type: 'join',
        subjectInstanceId: instanceId,
        subjectLabel: label,
        subjectUrl: url,
        deadline: new Date(Date.now() + freshNet.votingDeadlineHours * 3_600_000).toISOString(),
        openedAt: new Date().toISOString(),
        votes: [],
        pendingMember: member,             // held here until the vote passes
        inviteKeyHash: net.inviteKeyHash,  // preserve the original validated hash in the round record
      };
      freshNet.pendingRounds.push(round);
      // Revoke invite key after use to prevent replay
      freshNet.inviteKeyHash = undefined;
      // Save the plaintext peer token so the sync engine can use it once the vote passes
      const secrets = getSecrets();
      secrets.peerTokens[instanceId] = token;
      saveSecrets(secrets);
      saveConfig(freshCfg);
      log.info(`Join via invite key opened vote round ${round.roundId} for ${label}`);
      res.status(202).json({ status: 'vote_pending', roundId: round.roundId });
      return;
    }

    if (freshNet.type === 'braintree') {
      // Braintree is vote-governed (S9): the joiner is admitted only after every
      // ancestor on the path from this (inviting) node to the root votes yes —
      // same round shape as the admin member-add path. The joiner always becomes
      // a child of the inviting node; topology fields from the wire are ignored.
      member.parentInstanceId = freshCfg.instanceId;
      member.direction = 'push';   // we push to our children
      const requiredVoters = buildBraintreeAncestors(freshNet, freshCfg.instanceId, freshCfg.instanceId);
      const round: VoteRound = {
        roundId: uuidv4(),
        type: 'join',
        subjectInstanceId: instanceId,
        subjectLabel: label,
        subjectUrl: url,
        deadline: new Date(Date.now() + freshNet.votingDeadlineHours * 3_600_000).toISOString(),
        openedAt: new Date().toISOString(),
        votes: [],
        pendingMember: member,
        requiredVoters,
        inviteKeyHash: net.inviteKeyHash,  // preserve the validated hash so the joiner can poll
      };
      freshNet.pendingRounds.push(round);
      // The inviting node's approval is implicit — it generated the invite key.
      round.votes.push(makeSignedOwnCast(freshNet.id, round, freshCfg.instanceId, 'yes'));
      // Consume the key (single-use) and store the peer token for post-admission sync.
      freshNet.inviteKeyHash = undefined;
      const secrets = getSecrets();
      secrets.peerTokens[instanceId] = token;
      saveSecrets(secrets);
      const immediatePassed = concludeRoundIfReady(freshNet, round);
      if (immediatePassed) {
        // Root case: the ancestor path is only [self] → admit immediately
        freshNet.members.push(member);
        saveConfig(freshCfg);
        log.info(`Braintree join via invite key immediate (root): added ${label} (${instanceId}) to network ${freshNet.id}`);
        res.status(200).json({ status: 'joined', members: safeMemberList(freshNet, instanceId), networkId: freshNet.id });
        return;
      }
      saveConfig(freshCfg);
      log.info(`Join via invite key opened braintree ancestor round ${round.roundId} for ${label} (${instanceId}) in network ${freshNet.id}`);
      res.status(202).json({ status: 'vote_pending', roundId: round.roundId });
      return;
    }

    // Club / Pubsub — direct join via invite key (documented behavior)
    // Pubsub subscribers are always push-only (publisher pushes to them).
    if (freshNet.type === 'pubsub') member.direction = 'push';
    freshNet.members.push(member);
    // Pubsub keys are reusable (publishable in docs, QR codes, etc.)
    // All other types consume the key after use to prevent replay.
    if (freshNet.type !== 'pubsub') freshNet.inviteKeyHash = undefined;
    saveConfig(freshCfg);
    log.info(`Member ${label} joined network ${freshNet.id} via invite key`);

    // Return peer the member list and network metadata (enough to start syncing)
    res.status(200).json({ status: 'joined', members: safeMemberList(freshNet, instanceId), networkId: freshNet.id });
  } catch (err) {
    log.error(`POST /api/networks/:id/join: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});


// ── POST /api/networks/:id/fork ──────────────────────────────────────────────
// Creates a new standalone/closed network seeded from the caller's copy of the
// source network's spaces. Works for:
//   • Active member  — source network still present; spaces are inherited
//   • Ejected member — source network is gone (deleted on ejection); caller must
//     supply spaces explicitly in the request body
//
// The source network is never modified. ejectedFromNetworks is never cleared.

// The act is shared with MCP `network_fork` (F-36 slice 3).
joinRouter.post('/:id/fork', globalRateLimit, requireAdmin, (req, res) => {
  try {
    // Parsed here as well as in the act: the same-parameters gate reads a route's accepted keys off this call.
    const parsed = ForkNetworkBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
    sendAct(res, forkNetworkAct(String(req.params['id'] ?? ''), parsed.data));
  } catch (err) {
    log.error(`POST /api/networks/:id/fork: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});
