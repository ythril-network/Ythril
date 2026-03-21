/**
 * Network management API — CRUD for Ythril sync networks.
 *
 * Route prefix: /api/networks
 *
 * Authentication: requireAuth (PAT Bearer token)
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { getConfig, saveConfig, getSecrets, saveSecrets } from '../config/loader.js';
import { concludeRoundIfReady, sendMemberRemovedNotify } from './sync.js';
import { log } from '../util/log.js';
import type { NetworkConfig, NetworkMember, VoteRound } from '../config/types.js';

export const networksRouter = Router();

const BCRYPT_ROUNDS = 12;

// ── SSRF-safe peer URL validation ────────────────────────────────────────────
// Shared validator from util/ssrf.ts covers:
//   RFC-1918 IPv4, loopback, 169.254 IMDS, IPv6 ULA (fc00::/7),
//   IPv6 link-local (fe80::/10), GCP metadata FQDN, embedded credentials.
import { isSsrfSafeUrl, SSRF_SAFE_MESSAGE } from '../util/ssrf.js';

// ── Schemas ─────────────────────────────────────────────────────────────────

const SSRF_SAFE_URL = z
  .string()
  .url()
  .refine(isSsrfSafeUrl, { message: SSRF_SAFE_MESSAGE });

const CreateNetworkBody = z.object({
  id: z.string().uuid().optional(),  // optional pre-specified ID for cross-instance registration
  label: z.string().min(1).max(200),
  type: z.enum(['closed', 'democratic', 'club', 'braintree']),
  spaces: z.array(z.string().min(1)).min(1),
  votingDeadlineHours: z.number().int().min(1).max(72).default(24),
  syncSchedule: z.string().optional(),
  merkle: z.boolean().optional(),
  myParentInstanceId: z.string().optional(),  // braintree: this instance's parent in the tree (omit → root)
});

const AddMemberBody = z.object({
  instanceId: z.string().min(1),
  label: z.string().min(1).max(200),
  url: SSRF_SAFE_URL,
  token: z.string().min(1),   // plaintext peer token — stored as bcrypt hash
  direction: z.enum(['both', 'push']).default('both'),
  parentInstanceId: z.string().optional(),
  skipTlsVerify: z.boolean().optional(),
});

const CastVoteBody = z.object({
  vote: z.enum(['yes', 'veto']),
});

const ReparentSelfBody = z.object({
  /** instanceId of the new parent (e.g. grandparent) */
  newParentInstanceId: z.string().uuid(),
  newParentLabel: z.string().min(1).max(200),
  newParentUrl: SSRF_SAFE_URL,
  /** Plaintext token (decrypted from the invite apply response) to call the new parent */
  tokenForNewParent: z.string().min(1),
  /** instanceId of the original parent that is offline */
  originalParentInstanceId: z.string().uuid(),
});

// ── GET /api/networks ──────────────────────────────────────────────────────

networksRouter.get('/', globalRateLimit, requireAuth, (_req, res) => {
  const cfg = getConfig();
  // Strip sensitive fields
  const networks = cfg.networks.map(n => ({
    ...n,
    members: n.members.map(({ tokenHash: _th, skipTlsVerify: _sv, ...m }) => m),
    inviteKeyHash: undefined,
  }));
  res.json({ networks });
});

// ── GET /api/networks/:id ──────────────────────────────────────────────────

networksRouter.get('/:id', globalRateLimit, requireAuth, (req, res) => {
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === req.params['id']);
  if (!net) { res.status(404).json({ error: 'Network not found' }); return; }

  const safe = {
    ...net,
    members: net.members.map(({ tokenHash: _th, skipTlsVerify: _sv, ...m }) => m),
    inviteKeyHash: undefined,
  };
  res.json(safe);
});

// ── POST /api/networks — create a new network ──────────────────────────────

networksRouter.post('/', globalRateLimit, requireAuth, async (req, res) => {
  try {
    const parsed = CreateNetworkBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

    const { id: presetId, label, type, spaces, votingDeadlineHours, syncSchedule, merkle, myParentInstanceId } = parsed.data;
    const cfg = getConfig();

    // Validate spaces exist
    const unknownSpaces = spaces.filter(s => !cfg.spaces.some(cs => cs.id === s));
    if (unknownSpaces.length > 0) {
      res.status(400).json({ error: `Unknown spaces: ${unknownSpaces.join(', ')}` });
      return;
    }

    // If a preset ID is given, ensure it is not already in use
    if (presetId && cfg.networks.some(n => n.id === presetId)) {
      res.status(409).json({ error: 'Network with this ID already exists' });
      return;
    }

    const network: NetworkConfig = {
      id: presetId ?? uuidv4(),
      label,
      type,
      spaces,
      votingDeadlineHours,
      syncSchedule,
      merkle,
      myParentInstanceId: type === 'braintree' ? myParentInstanceId : undefined,
      members: [],
      pendingRounds: [],
      createdAt: new Date().toISOString(),
    };

    cfg.networks.push(network);
    saveConfig(cfg);

    log.info(`Created network '${label}' (${type}) id=${network.id}`);
    const { inviteKeyHash: _ikH, ...safe } = network;
    res.status(201).json(safe);
  } catch (err) {
    log.error(`POST /api/networks: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── DELETE /api/networks/:id — leave/delete a network ─────────────────────

networksRouter.delete('/:id', globalRateLimit, requireAuth, (req, res) => {
  const cfg = getConfig();
  const idx = cfg.networks.findIndex(n => n.id === req.params['id']);
  if (idx < 0) { res.status(404).json({ error: 'Network not found' }); return; }

  const net = cfg.networks[idx]!;

  // Broadcast member_departed to all peers before removing the network locally.
  // Fire-and-forget: non-fatal if a peer is unreachable.
  const secrets = getSecrets();
  for (const member of net.members) {
    const peerToken = secrets.peerTokens[member.instanceId];
    if (!peerToken) continue;
    fetch(`${member.url}/api/notify`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${peerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ networkId: net.id, instanceId: cfg.instanceId, event: 'member_departed' }),
      signal: AbortSignal.timeout(5_000),
    }).catch(err => log.warn(`member_departed to ${member.label}: ${err}`));
  }

  cfg.networks.splice(idx, 1);
  saveConfig(cfg);
  log.info(`Deleted network id=${net.id}`);
  res.status(204).end();
});

// ── Braintree governance helpers ────────────────────────────────────────────

/**
 * Compute the list of instance IDs that must vote yes for a Braintree governance action.
 *
 * Walks from `startId` upward through `parentInstanceId` on network members.
 * When the walk reaches `selfId` it continues via `net.myParentInstanceId` (the recorded
 * parent of this instance).  Returns the path from `startId` up to (and including) the root.
 *
 * For a JOIN round: call with startId = selfId (the inviting node is this server).
 * For a REMOVE round: call with startId = subject.parentInstanceId (the subject's direct parent).
 */
function buildBraintreeAncestors(
  net: NetworkConfig,
  selfId: string,
  startId: string,
): string[] {
  const path: string[] = [];
  const visited = new Set<string>();
  let cur: string | undefined = startId;
  while (cur && !visited.has(cur)) {
    path.push(cur);
    visited.add(cur);
    if (cur === selfId) {
      cur = net.myParentInstanceId;   // continue upward via this instance's declared parent
    } else {
      const m = net.members.find(m => m.instanceId === cur);
      if (!m) break;                  // chain incomplete; stop here
      cur = m.parentInstanceId;
    }
  }
  return path;
}

// ── POST /api/networks/:id/members — add a peer member ────────────────────

networksRouter.post('/:id/members', globalRateLimit, requireAuth, async (req, res) => {
  try {
    const parsed = AddMemberBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

    const cfg = getConfig();
    const net = cfg.networks.find(n => n.id === req.params['id']);
    if (!net) { res.status(404).json({ error: 'Network not found' }); return; }

    const { instanceId, label, url, token, direction, parentInstanceId, skipTlsVerify } = parsed.data;

    if (net.members.some(m => m.instanceId === instanceId)) {
      res.status(409).json({ error: 'Member already exists' });
      return;
    }

    const tokenHash = await bcrypt.hash(token, BCRYPT_ROUNDS);

    const member: NetworkMember = {
      instanceId,
      label,
      url,
      tokenHash,
      direction,
      parentInstanceId,
      skipTlsVerify,
    };

    if (net.type === 'closed' || net.type === 'democratic') {
      // Open a vote round for the new member
      const round: VoteRound = {
        roundId: uuidv4(),
        type: 'join',
        subjectInstanceId: instanceId,
        subjectLabel: label,
        subjectUrl: url,
        deadline: new Date(Date.now() + net.votingDeadlineHours * 3_600_000).toISOString(),
        openedAt: new Date().toISOString(),
        votes: [],
        pendingMember: member,
      };
      net.pendingRounds.push(round);
      // Save the plaintext peer token so the sync engine can use it once the vote passes
      const secrets = getSecrets();
      secrets.peerTokens[instanceId] = token;
      saveSecrets(secrets);
      saveConfig(cfg);
      log.info(`Opened join vote round ${round.roundId} for ${label} in network ${net.id}`);
      res.status(202).json({ status: 'vote_pending', roundId: round.roundId });
      return;
    }

    if (net.type === 'club') {
      // Club: direct add, no vote required
      net.members.push(member);
      const secrets = getSecrets();
      secrets.peerTokens[instanceId] = token;
      saveSecrets(secrets);
      saveConfig(cfg);
      log.info(`Added member ${label} (${instanceId}) to network ${net.id}`);
      const { tokenHash: _th, skipTlsVerify: _sv, ...safeMember } = member;
      res.status(201).json(safeMember);
      return;
    }

    // Braintree: open a vote round with requiredVoters = ancestry path from self to root.
    // The proposer (this instance) auto-votes yes.  If the path is only [self] (root case),
    // concludeRoundIfReady passes immediately and we add the member right away → 201.
    // Otherwise we return 202 and wait for all ancestors to vote via gossip propagation.
    const requiredVoters = buildBraintreeAncestors(net, cfg.instanceId, cfg.instanceId);
    const round: VoteRound = {
      roundId: uuidv4(),
      type: 'join',
      subjectInstanceId: instanceId,
      subjectLabel: label,
      subjectUrl: url,
      deadline: new Date(Date.now() + net.votingDeadlineHours * 3_600_000).toISOString(),
      openedAt: new Date().toISOString(),
      votes: [],
      pendingMember: member,
      requiredVoters,
    };
    net.pendingRounds.push(round);
    // Auto-cast this instance's yes vote (proposer implicitly approves their own proposal)
    round.votes.push({ instanceId: cfg.instanceId, vote: 'yes', castAt: new Date().toISOString() });
    const secrets = getSecrets();
    secrets.peerTokens[instanceId] = token;
    saveSecrets(secrets);
    const immediatePassed = concludeRoundIfReady(net, round);
    if (immediatePassed) {
      // Root case: only self needed to vote → add member directly
      net.members.push(member);
      saveConfig(cfg);
      log.info(`Braintree join immediate (root): added ${label} (${instanceId}) to network ${net.id}`);
      const { tokenHash: _th, skipTlsVerify: _sv, ...safeMember } = member;
      res.status(201).json(safeMember);
      return;
    }
    saveConfig(cfg);
    log.info(`Opened braintree join round ${round.roundId} for ${label} (${instanceId}) in network ${net.id}`);
    res.status(202).json({ status: 'vote_pending', roundId: round.roundId });
  } catch (err) {
    log.error(`POST /api/networks/:id/members: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── DELETE /api/networks/:id/members/:instanceId — remove a member ─────────

networksRouter.delete('/:id/members/:instanceId', globalRateLimit, requireAuth, (req, res) => {
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === req.params['id']);
  if (!net) { res.status(404).json({ error: 'Network not found' }); return; }

  const memberIdx = net.members.findIndex(m => m.instanceId === req.params['instanceId']);
  if (memberIdx < 0) { res.status(404).json({ error: 'Member not found' }); return; }

  if (net.type === 'closed' || net.type === 'democratic') {
    // Open a remove vote round
    const member = net.members[memberIdx]!;
    const round: VoteRound = {
      roundId: uuidv4(),
      type: 'remove',
      subjectInstanceId: member.instanceId,
      subjectLabel: member.label,
      subjectUrl: member.url,
      deadline: new Date(Date.now() + net.votingDeadlineHours * 3_600_000).toISOString(),
      openedAt: new Date().toISOString(),
      votes: [],
    };
    net.pendingRounds.push(round);
    saveConfig(cfg);
    log.info(`Opened remove vote round ${round.roundId} for ${member.label} in network ${net.id}`);
    res.status(202).json({ status: 'vote_pending', roundId: round.roundId });
    return;
  }

  if (net.type === 'club') {
    net.members.splice(memberIdx, 1);
    saveConfig(cfg);
    res.status(204).end();
    return;
  }

  // Braintree: open a remove vote round with requiredVoters = ancestor path of the subject.
  // The subject's parent (and all ancestors up to root) must approve the removal.
  const subject = net.members[memberIdx]!;
  // Walk from subject's parent upward; if the subject is a direct child of self,
  // buildBraintreeAncestors(startId=self) correctly includes self and self's own ancestors.
  const subjectParentId = subject.parentInstanceId ?? cfg.instanceId;
  const requiredVoters = buildBraintreeAncestors(net, cfg.instanceId, subjectParentId);
  const removeRound: VoteRound = {
    roundId: uuidv4(),
    type: 'remove',
    subjectInstanceId: subject.instanceId,
    subjectLabel: subject.label,
    subjectUrl: subject.url,
    deadline: new Date(Date.now() + net.votingDeadlineHours * 3_600_000).toISOString(),
    openedAt: new Date().toISOString(),
    votes: [],
    requiredVoters,
  };
  net.pendingRounds.push(removeRound);
  // Auto-cast this instance's yes vote if we are a required voter
  if (requiredVoters.includes(cfg.instanceId)) {
    removeRound.votes.push({ instanceId: cfg.instanceId, vote: 'yes', castAt: new Date().toISOString() });
  }
  const immediatePassed = concludeRoundIfReady(net, removeRound);
  if (immediatePassed) {
    // Ancestor path is only [self] → remove immediately (member already spliced by concludeRoundIfReady)
    saveConfig(cfg);
    sendMemberRemovedNotify(removeRound.subjectUrl, removeRound.subjectInstanceId, net.id);
    log.info(`Braintree remove immediate: removed ${subject.label} (${subject.instanceId}) from network ${net.id}`);
    res.status(204).end();
    return;
  }
  saveConfig(cfg);
  log.info(`Opened braintree remove round ${removeRound.roundId} for ${subject.label} (${subject.instanceId}) in network ${net.id}`);
  res.status(202).json({ status: 'vote_pending', roundId: removeRound.roundId });
});

// ── POST /api/networks/:id/reparent-self ────────────────────────────────────
// Called by a node on ITSELF after completing the invite apply step.
// Records the new parent in the local config so this node knows it is
// temporarily connected to a grandparent rather than its original parent.

networksRouter.post('/:id/reparent-self', globalRateLimit, requireAuth, async (req, res) => {
  try {
    const parsed = ReparentSelfBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

    const cfg = getConfig();
    const net = cfg.networks.find(n => n.id === req.params['id']);
    if (!net) { res.status(404).json({ error: 'Network not found' }); return; }
    if (net.type !== 'braintree') { res.status(400).json({ error: 'reparent-self is only valid for braintree networks' }); return; }

    const { newParentInstanceId, newParentLabel, newParentUrl, tokenForNewParent, originalParentInstanceId } = parsed.data;

    // Upsert the new parent in the local member list so the engine can report status
    const existing = net.members.find(m => m.instanceId === newParentInstanceId);
    if (!existing) {
      net.members.push({
        instanceId: newParentInstanceId,
        label: newParentLabel,
        url: newParentUrl,
        tokenHash: '',   // no inbound auth needed on this side — new parent pushes TO us
        direction: 'push',
      });
    }

    // Store the outbound token so this engine can call the new parent if needed
    const secrets = getSecrets();
    secrets.peerTokens[newParentInstanceId] = tokenForNewParent;
    saveSecrets(secrets);

    // Mark the temporary reparent state
    net.temporaryReparent = {
      newParentInstanceId,
      originalParentInstanceId,
      reparentedAt: new Date().toISOString(),
    };

    saveConfig(cfg);
    log.info(`reparent-self: network ${net.id} — new parent ${newParentInstanceId} (was ${originalParentInstanceId})`);
    res.json({ status: 'reparented', newParentInstanceId, originalParentInstanceId });
  } catch (err) {
    log.error(`POST /api/networks reparent-self: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── POST /api/networks/:id/members/:instanceId/adopt ───────────────────────
// Called on the GRANDPARENT side. Makes a temporary reparent permanent by clearing
// originalParentInstanceId from the grandchild's member record.

networksRouter.post('/:id/members/:instanceId/adopt', globalRateLimit, requireAuth, (req, res) => {
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === req.params['id']);
  if (!net) { res.status(404).json({ error: 'Network not found' }); return; }

  const member = net.members.find(m => m.instanceId === req.params['instanceId']);
  if (!member) { res.status(404).json({ error: 'Member not found' }); return; }
  if (!member.originalParentInstanceId) {
    res.status(409).json({ error: 'Member is not in a temporary reparent state' });
    return;
  }

  const oldOriginal = member.originalParentInstanceId;
  delete member.originalParentInstanceId;
  saveConfig(cfg);

  log.info(`Permanent adoption: '${member.label}' (${member.instanceId}) adopted from ${oldOriginal} in network ${net.id}`);
  res.json({ status: 'adopted', instanceId: member.instanceId, parentInstanceId: member.parentInstanceId });
});

// ── POST /api/networks/:id/members/:instanceId/revert-parent ───────────────
// Called on the GRANDPARENT side when the original parent is back online.
// Restores the topology: grandchild re-parents to its original parent.

networksRouter.post('/:id/members/:instanceId/revert-parent', globalRateLimit, requireAuth, (req, res) => {
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === req.params['id']);
  if (!net) { res.status(404).json({ error: 'Network not found' }); return; }

  const member = net.members.find(m => m.instanceId === req.params['instanceId']);
  if (!member) { res.status(404).json({ error: 'Member not found' }); return; }
  if (!member.originalParentInstanceId) {
    res.status(409).json({ error: 'Member is not in a temporary reparent state' });
    return;
  }

  // Restore original parent
  const restoredParentId = member.originalParentInstanceId;
  member.parentInstanceId = restoredParentId;
  delete member.originalParentInstanceId;

  // Move member from this instance's children back to original parent's children
  const selfInNet = net.members.find(m => m.instanceId === cfg.instanceId);
  if (selfInNet?.children) {
    selfInNet.children = selfInNet.children.filter(c => c !== member.instanceId);
  }
  const originalParent = net.members.find(m => m.instanceId === restoredParentId);
  if (originalParent?.children && !originalParent.children.includes(member.instanceId)) {
    originalParent.children.push(member.instanceId);
  }

  // Remove direct outbound token — grandparent no longer pushes directly
  const secrets = getSecrets();
  delete secrets.peerTokens[member.instanceId];
  saveSecrets(secrets);

  saveConfig(cfg);
  log.info(`Parent reverted: '${member.label}' (${member.instanceId}) re-parented back to ${restoredParentId} in network ${net.id}`);
  res.json({ status: 'reverted', instanceId: member.instanceId, parentInstanceId: restoredParentId });
});
// ── GET /api/networks/:id/vote — list open vote rounds ─────────────────────

networksRouter.get('/:id/votes', globalRateLimit, requireAuth, (req, res) => {
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === req.params['id']);
  if (!net) { res.status(404).json({ error: 'Network not found' }); return; }
  res.json({ rounds: net.pendingRounds.filter(r => !r.concluded) });
});

// ── POST /api/networks/:id/votes/:roundId — cast a vote ────────────────────

networksRouter.post('/:id/votes/:roundId', globalRateLimit, requireAuth, (req, res) => {
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
    const cast = { instanceId, vote: parsed.data.vote, castAt: new Date().toISOString() };
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

    // If space_deletion round concluded and passed, remove the space on this instance
    if (round.concluded && round.type === 'space_deletion') {
      const vetoCount = round.votes.filter(v => v.vote === 'veto').length;
      if (vetoCount === 0 && round.spaceId) {
        import('../spaces/spaces.js').then(({ removeSpace }) => {
          removeSpace(round.spaceId!).catch(err => log.error(`space_deletion vote side-effect: ${err}`));
        }).catch(err => log.error(`space_deletion import: ${err}`));
      }
    }

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

// ── POST /api/networks/:id/invite — generate invite key ───────────────────

networksRouter.post('/:id/invite', globalRateLimit, requireAuth, async (req, res) => {
  try {
    const cfg = getConfig();
    const net = cfg.networks.find(n => n.id === req.params['id']);
    if (!net) { res.status(404).json({ error: 'Network not found' }); return; }

    const { randomBytes } = await import('crypto');
    const key = `ythril_invite_${randomBytes(32).toString('base64url')}`;
    net.inviteKeyHash = await bcrypt.hash(key, BCRYPT_ROUNDS);
    saveConfig(cfg);

    log.info(`Generated new invite key for network ${net.id} (shown once)`);
    res.json({ inviteKey: key, note: 'Store this key securely — it will not be shown again' });
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
  direction: z.enum(['both', 'push']).default('both'),
  parentInstanceId: z.string().optional(),
  skipTlsVerify: z.boolean().optional(),
});

networksRouter.post('/:id/join', globalRateLimit, requireAuth, async (req, res) => {
  try {
    const parsed = JoinNetworkBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

    const cfg = getConfig();
    const net = cfg.networks.find(n => n.id === req.params['id']);
    if (!net) { res.status(404).json({ error: 'Network not found' }); return; }

    if (!net.inviteKeyHash) {
      res.status(400).json({ error: 'No active invite key — generate one first via POST /invite' });
      return;
    }

    const keyValid = await bcrypt.compare(parsed.data.inviteKey, net.inviteKeyHash);
    if (!keyValid) {
      res.status(403).json({ error: 'Invalid invite key' });
      return;
    }

    if (net.members.some(m => m.instanceId === parsed.data.instanceId)) {
      res.status(409).json({ error: 'Member already exists' });
      return;
    }

    const { instanceId, label, url, token, direction, parentInstanceId, skipTlsVerify } = parsed.data;
    const tokenHash = await bcrypt.hash(token, BCRYPT_ROUNDS);
    const member: NetworkMember = { instanceId, label, url, tokenHash, direction, parentInstanceId, skipTlsVerify };

    if (net.type === 'closed' || net.type === 'democratic') {
      const round: VoteRound = {
        roundId: uuidv4(),
        type: 'join',
        subjectInstanceId: instanceId,
        subjectLabel: label,
        subjectUrl: url,
        deadline: new Date(Date.now() + net.votingDeadlineHours * 3_600_000).toISOString(),
        openedAt: new Date().toISOString(),
        votes: [],
        inviteKeyHash: net.inviteKeyHash,
      };
      net.pendingRounds.push(round);
      // Revoke invite key after use to prevent replay
      net.inviteKeyHash = undefined;
      saveConfig(cfg);
      log.info(`Join via invite key opened vote round ${round.roundId} for ${label}`);
      res.status(202).json({ status: 'vote_pending', roundId: round.roundId });
      return;
    }

    // Club / Braintree — direct join via invite key
    net.members.push(member);
    net.inviteKeyHash = undefined; // single-use key
    saveConfig(cfg);
    log.info(`Member ${label} joined network ${net.id} via invite key`);

    // Return peer the member list and network metadata (enough to start syncing)
    const safeMemberList = net.members
      .filter(m => m.instanceId !== instanceId)
      .map(({ tokenHash: _th, skipTlsVerify: _sv, ...m }) => m);
    res.status(200).json({ status: 'joined', members: safeMemberList, networkId: net.id });
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

const ForkNetworkBody = z.object({
  label: z.string().min(1).max(200),
  type: z.enum(['closed', 'club']).default('closed'),
  votingDeadlineHours: z.number().int().min(1).max(72).optional(),
  spaces: z.array(z.string().min(1)).optional(),
});

networksRouter.post('/:id/fork', globalRateLimit, requireAuth, (req, res) => {
  try {
    const parsed = ForkNetworkBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const cfg = getConfig();
    const sourceId = String(req.params['id'] ?? '');
    const sourceNet = cfg.networks.find(n => n.id === sourceId);
    const isEjected = cfg.ejectedFromNetworks?.includes(sourceId) ?? false;

    if (!sourceNet && !isEjected) {
      res.status(404).json({ error: 'Network not found' });
      return;
    }

    // Spaces: body override takes precedence; otherwise inherited from source.
    const spaces = parsed.data.spaces ?? sourceNet?.spaces;

    if (!spaces || spaces.length === 0) {
      res.status(400).json({
        error: 'spaces is required when the source network is no longer locally available',
      });
      return;
    }

    // All requested spaces must be locally known.
    const unknownSpaces = spaces.filter(s => !cfg.spaces.some(cs => cs.id === s));
    if (unknownSpaces.length > 0) {
      res.status(400).json({ error: `Unknown spaces: ${unknownSpaces.join(', ')}` });
      return;
    }

    const forkedNet: NetworkConfig = {
      id: uuidv4(),
      label: parsed.data.label,
      type: parsed.data.type,
      spaces,
      votingDeadlineHours: parsed.data.votingDeadlineHours ?? sourceNet?.votingDeadlineHours ?? 24,
      members: [],
      pendingRounds: [],
      createdAt: new Date().toISOString(),
    };

    cfg.networks.push(forkedNet);
    saveConfig(cfg);
    log.info(`Forked network ${sourceId} → new network ${forkedNet.id} ('${forkedNet.label}')`);
    res.status(201).json(forkedNet);
  } catch (err) {
    log.error(`POST /api/networks/:id/fork: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});
