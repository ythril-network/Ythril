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
import { concludeRoundIfReady } from './sync.js';
import { log } from '../util/log.js';
import type { NetworkConfig, NetworkMember, VoteRound } from '../config/types.js';

export const networksRouter = Router();

const BCRYPT_ROUNDS = 12;

// ── Schemas ─────────────────────────────────────────────────────────────────

const CreateNetworkBody = z.object({
  id: z.string().uuid().optional(),  // optional pre-specified ID for cross-instance registration
  label: z.string().min(1).max(200),
  type: z.enum(['closed', 'democratic', 'club', 'braintree']),
  spaces: z.array(z.string().min(1)).min(1),
  votingDeadlineHours: z.number().int().min(1).max(72).default(24),
  syncSchedule: z.string().optional(),
  merkle: z.boolean().optional(),
});

const AddMemberBody = z.object({
  instanceId: z.string().min(1),
  label: z.string().min(1).max(200),
  url: z.string().url(),
  token: z.string().min(1),   // plaintext peer token — stored as bcrypt hash
  direction: z.enum(['both', 'push']).default('both'),
  parentInstanceId: z.string().optional(),
  skipTlsVerify: z.boolean().optional(),
});

const CastVoteBody = z.object({
  vote: z.enum(['yes', 'veto']),
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

    const { id: presetId, label, type, spaces, votingDeadlineHours, syncSchedule, merkle } = parsed.data;
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

  const [removed] = cfg.networks.splice(idx, 1);
  saveConfig(cfg);
  log.info(`Deleted network id=${removed?.id}`);
  res.status(204).end();
});

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

    // Club / Braintree — direct add
    net.members.push(member);
    // Save the peer token for outbound sync
    const secrets = getSecrets();
    secrets.peerTokens[instanceId] = token;
    saveSecrets(secrets);
    saveConfig(cfg);
    log.info(`Added member ${label} (${instanceId}) to network ${net.id}`);
    const { tokenHash: _th, skipTlsVerify: _sv, ...safeMember } = member;
    res.status(201).json(safeMember);
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

  net.members.splice(memberIdx, 1);
  saveConfig(cfg);
  res.status(204).end();
});

// ── GET /api/networks/:id/vote — list open vote rounds ─────────────────────

networksRouter.get('/:id/votes', globalRateLimit, requireAuth, (req, res) => {
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === req.params['id']);
  if (!net) { res.status(404).json({ error: 'Network not found' }); return; }
  res.json({ rounds: net.pendingRounds });
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

    // If join round concluded and passed, add the pending member
    if (round.concluded && round.type === 'join' && round.pendingMember &&
        !net.members.some(m => m.instanceId === round.subjectInstanceId)) {
      const vetoCount = round.votes.filter(v => v.vote === 'veto').length;
      if (vetoCount === 0) {
        net.members.push(round.pendingMember);
        log.info(`Join vote ${round.roundId} passed — added member ${round.subjectLabel} to network ${net.id}`);
      }
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
  url: z.string().url(),
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
