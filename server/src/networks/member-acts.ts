/**
 * A network's members — add, remove, admit by invite key, pin a signing key — once, for both doors (`F-36`, slices 4-5).
 *
 * These were the bodies of `POST /api/networks/:id/members` and `DELETE /api/networks/:id/members/:instanceId`,
 * so an agent could not manage a network's members at all. They moved here unchanged so the route and the MCP tool
 * call one implementation — the governance per network type (a vote on closed, democratic and braintree; a direct
 * change on club and pub/sub) cannot drift between the doors. Both stay instance-admin on both doors, as the routes
 * always were: a member is an act on the network as a whole (`auth/network-rights.ts`).
 *
 * The answer never carries a credential: the peer token is stored as a bcrypt hash and the plaintext in secrets,
 * and the member returned has its hash and TLS override stripped.
 */
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { getConfig, saveConfig, getSecrets, saveSecrets } from '../config/loader.js';
import { revokePeerCredentialsIfOrphaned } from '../auth/tokens.js';
import { concludeRoundIfReady, sendMemberRemovedNotify } from '../sync/governance.js';
import { buildBraintreeAncestors } from '../util/braintree.js';
import { makeSignedOwnCast, forceSetMemberSigningKey } from '../util/signing.js';
import { log } from '../util/log.js';
import type { NetworkMember, VoteRound } from '../config/types.js';
import { BCRYPT_ROUNDS, SSRF_SAFE_URL, safeMemberList } from '../api/networks/_shared.js';
import type { NetworkActResult } from './network-acts.js';
import { openRoundHere } from './round-local-state.js';

export const AddMemberBody = z.object({
  instanceId: z.string().min(1),
  label: z.string().min(1).max(200),
  url: SSRF_SAFE_URL,
  token: z.string().min(1),   // plaintext peer token — stored as bcrypt hash
  direction: z.enum(['both', 'push', 'pull']).default('both'),
  parentInstanceId: z.string().optional(),
  skipTlsVerify: z.boolean().optional(),
});

const NOT_FOUND = { status: 404, error: 'Network not found' } as const;
const safe = (m: NetworkMember): Record<string, unknown> => { const { tokenHash: _th, skipTlsVerify: _sv, ...rest } = m; return rest; };

/** Keep the plaintext peer token so the sync engine can call the member once it is one. */
function storePeerToken(instanceId: string, token: string): void {
  const secrets = getSecrets();
  secrets.peerTokens[instanceId] = token;
  saveSecrets(secrets);
}

/** Add a peer member: `201` with the member, or `202` when the network's type puts it to a vote. */
export async function addMemberAct(networkId: string, input: unknown): Promise<NetworkActResult> {
  const parsed = AddMemberBody.safeParse(input);
  if (!parsed.success) return { status: 400, error: parsed.error.message };

  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  if (!net) return NOT_FOUND;

  const { instanceId, label, url, token, direction, parentInstanceId, skipTlsVerify } = parsed.data;
  if (net.members.some(m => m.instanceId === instanceId)) return { status: 409, error: 'Member already exists' };

  const tokenHash = await bcrypt.hash(token, BCRYPT_ROUNDS);

  // Re-fetch config after async bcrypt to avoid clobbering concurrent writes.
  const freshCfg = getConfig();
  const freshNet = freshCfg.networks.find(n => n.id === networkId);
  if (!freshNet) return NOT_FOUND;
  if (freshNet.members.some(m => m.instanceId === instanceId)) return { status: 409, error: 'Member already exists' };

  const member: NetworkMember = { instanceId, label, url, tokenHash, direction, parentInstanceId, skipTlsVerify };
  const joinRound = (requiredVoters?: string[]): VoteRound => ({
    roundId: uuidv4(),
    type: 'join',
    subjectInstanceId: instanceId,
    subjectLabel: label,
    subjectUrl: url,
    deadline: new Date(Date.now() + freshNet.votingDeadlineHours * 3_600_000).toISOString(),
    openedAt: new Date().toISOString(),
    votes: [],
    pendingMember: member,
    ...(requiredVoters ? { requiredVoters } : {}),
  });

  if (freshNet.type === 'closed' || freshNet.type === 'democratic') {
    const round = joinRound();
    openRoundHere(freshNet, round);
    storePeerToken(instanceId, token);
    saveConfig(freshCfg);
    log.info(`Opened join vote round ${round.roundId} for ${label} in network ${freshNet.id}`);
    return { status: 202, body: { status: 'vote_pending', roundId: round.roundId } };
  }

  if (freshNet.type === 'club' || freshNet.type === 'pubsub') {
    // Pubsub never allows 'both' — publisher stores subscribers as 'push', subscriber stores publisher as 'pull'.
    // If 'both' is provided, default to 'push' (the common publisher-side case); explicit 'pull' is respected so the
    // subscriber can manually add the publisher.
    if (freshNet.type === 'pubsub' && member.direction === 'both') member.direction = 'push';
    freshNet.members.push(member);
    storePeerToken(instanceId, token);
    saveConfig(freshCfg);
    log.info(`Added member ${label} (${instanceId}) to network ${freshNet.id}`);
    return { status: 201, body: safe(member) };
  }

  // Braintree: requiredVoters = ancestry path from self to root, and the proposer auto-votes yes. If the path is
  // only [self] (root case), concludeRoundIfReady passes immediately and the member is added at once → 201.
  const round = joinRound(buildBraintreeAncestors(freshNet, freshCfg.instanceId, freshCfg.instanceId));
  openRoundHere(freshNet, round);
  round.votes.push(makeSignedOwnCast(freshNet.id, round, freshCfg.instanceId, 'yes'));
  storePeerToken(instanceId, token);
  if (concludeRoundIfReady(freshNet, round)) {
    freshNet.members.push(member);
    saveConfig(freshCfg);
    log.info(`Braintree join immediate (root): added ${label} (${instanceId}) to network ${freshNet.id}`);
    return { status: 201, body: safe(member) };
  }
  saveConfig(freshCfg);
  log.info(`Opened braintree join round ${round.roundId} for ${label} (${instanceId}) in network ${freshNet.id}`);
  return { status: 202, body: { status: 'vote_pending', roundId: round.roundId } };
}

/** Remove a member: `204` when done at once, or `202` when the network's type puts it to a vote. */
export function removeMemberAct(networkId: string, instanceId: string): NetworkActResult {
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  if (!net) return NOT_FOUND;

  const memberIdx = net.members.findIndex(m => m.instanceId === instanceId);
  if (memberIdx < 0) return { status: 404, error: 'Member not found' };
  const subject = net.members[memberIdx]!;
  const removeRound = (requiredVoters?: string[]): VoteRound => ({
    roundId: uuidv4(),
    type: 'remove',
    subjectInstanceId: subject.instanceId,
    subjectLabel: subject.label,
    subjectUrl: subject.url,
    deadline: new Date(Date.now() + net.votingDeadlineHours * 3_600_000).toISOString(),
    openedAt: new Date().toISOString(),
    votes: [],
    ...(requiredVoters ? { requiredVoters } : {}),
  });

  if (net.type === 'closed' || net.type === 'democratic') {
    const round = removeRound();
    openRoundHere(net, round);
    saveConfig(cfg);
    log.info(`Opened remove vote round ${round.roundId} for ${subject.label} in network ${net.id}`);
    return { status: 202, body: { status: 'vote_pending', roundId: round.roundId } };
  }

  if (net.type === 'club' || net.type === 'pubsub') {
    // Club / Pubsub: publisher (owner) removes directly, no vote required
    net.members.splice(memberIdx, 1);
    saveConfig(cfg);
    revokePeerCredentialsIfOrphaned(subject.instanceId)
      .catch(err => log.error(`peer credential revocation for ${subject.instanceId}: ${err}`));
    return { status: 204 };
  }

  // Braintree: the subject's parent and every ancestor up to the root must approve. If the subject is a direct
  // child of self, buildBraintreeAncestors(startId=self) includes self and self's own ancestors.
  const requiredVoters = buildBraintreeAncestors(net, cfg.instanceId, subject.parentInstanceId ?? cfg.instanceId);
  const round = removeRound(requiredVoters);
  openRoundHere(net, round);
  if (requiredVoters.includes(cfg.instanceId)) round.votes.push(makeSignedOwnCast(net.id, round, cfg.instanceId, 'yes'));
  if (concludeRoundIfReady(net, round)) {
    // Ancestor path is only [self] → removed at once (concludeRoundIfReady spliced the member)
    saveConfig(cfg);
    sendMemberRemovedNotify(round.subjectUrl, round.subjectInstanceId, net.id);
    log.info(`Braintree remove immediate: removed ${subject.label} (${subject.instanceId}) from network ${net.id}`);
    return { status: 204 };
  }
  saveConfig(cfg);
  log.info(`Opened braintree remove round ${round.roundId} for ${subject.label} (${subject.instanceId}) in network ${net.id}`);
  return { status: 202, body: { status: 'vote_pending', roundId: round.roundId } };
}

/**
 * Admit an instance presenting this network's invite key: the other half of a join, the inviter's side of
 * `POST /api/networks/:id/join`. A vote on closed, democratic and braintree (unless this instance is the root); direct
 * on club and pub/sub. The key is single-use except on pub/sub, and re-presenting it polls the joiner's own round.
 */
export const JoinNetworkBody = z.object({
  inviteKey: z.string().min(1),
  instanceId: z.string().min(1),
  label: z.string().min(1).max(200),
  url: SSRF_SAFE_URL,
  token: z.string().min(1),  // plaintext token for inbound auth
  direction: z.enum(['both', 'push', 'pull']).default('both'),
  parentInstanceId: z.string().optional(),
  skipTlsVerify: z.boolean().optional(),
});

export async function admitByInviteKeyAct(networkId: string, input: unknown): Promise<NetworkActResult> {
  const parsed = JoinNetworkBody.safeParse(input);
  if (!parsed.success) return { status: 400, error: parsed.error.message };

  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  if (!net) return { status: 404, error: 'Network not found' };

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
        return { status: 202, body: { status: 'vote_pending', roundId: round.roundId } };
      }
      if (!round.passed) {
        return { status: 403, error: 'Join was denied by network governance (vetoed or expired)' };
      }
      // Passed: the member is normally added when the round concludes; re-add
      // from the round's pendingMember if that side-effect was lost (crash
      // between conclusion and persistence). Re-fetch config after the async
      // bcrypt compares to avoid clobbering concurrent writes.
      const freshCfg = getConfig();
      const freshNet = freshCfg.networks.find(n => n.id === networkId);
      if (!freshNet) return { status: 404, error: 'Network not found' };
      if (!freshNet.members.some(m => m.instanceId === parsed.data.instanceId)) {
        if (!round.pendingMember) {
          return { status: 410, error: 'Join round passed but the member record was not retained — generate a new invite' };
        }
        freshNet.members.push(round.pendingMember);
        saveConfig(freshCfg);
      }
      return { status: 200, body: { status: 'joined', members: safeMemberList(freshNet, parsed.data.instanceId), networkId: freshNet.id } };
    }
    if (!net.inviteKeyHash) {
      return { status: 400, error: 'No active invite key — generate one first via POST /invite' };
    }
    return { status: 403, error: 'Invalid invite key' };
  }

  if (net.members.some(m => m.instanceId === parsed.data.instanceId)) {
    return { status: 409, error: 'Member already exists' };
  }

  const { instanceId, label, url, token, direction, parentInstanceId, skipTlsVerify } = parsed.data;
  const tokenHash = await bcrypt.hash(token, BCRYPT_ROUNDS);
  // Re-fetch config after async bcrypt to avoid clobbering concurrent writes.
  const freshCfg = getConfig();
  const freshNet = freshCfg.networks.find(n => n.id === networkId);
  if (!freshNet) return { status: 404, error: 'Network not found' };
  if (freshNet.members.some(m => m.instanceId === instanceId)) {
    return { status: 409, error: 'Member already exists' };
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
    openRoundHere(freshNet, round);
    // Revoke invite key after use to prevent replay
    freshNet.inviteKeyHash = undefined;
    // Save the plaintext peer token so the sync engine can use it once the vote passes
    const secrets = getSecrets();
    secrets.peerTokens[instanceId] = token;
    saveSecrets(secrets);
    saveConfig(freshCfg);
    log.info(`Join via invite key opened vote round ${round.roundId} for ${label}`);
    return { status: 202, body: { status: 'vote_pending', roundId: round.roundId } };
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
    openRoundHere(freshNet, round);
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
      return { status: 200, body: { status: 'joined', members: safeMemberList(freshNet, instanceId), networkId: freshNet.id } };
    }
    saveConfig(freshCfg);
    log.info(`Join via invite key opened braintree ancestor round ${round.roundId} for ${label} (${instanceId}) in network ${freshNet.id}`);
    return { status: 202, body: { status: 'vote_pending', roundId: round.roundId } };
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
  return { status: 200, body: { status: 'joined', members: safeMemberList(freshNet, instanceId), networkId: freshNet.id } };
}

/**
 * Break-glass: force-pin a member's governance signing key WITHOUT a rotation proof. Use when a peer lost its old
 * private key (so it cannot produce a continuity proof) and must re-establish trust. Normal rotations propagate
 * automatically via a signed proof over gossip.
 */
export const SigningKeyBody = z.object({ signingPublicKey: z.string().min(100).max(4000) });

export function setSigningKeyAct(networkId: string, instanceId: string, input: unknown): NetworkActResult {
  const parsed = SigningKeyBody.safeParse(input);
  if (!parsed.success) return { status: 400, error: parsed.error.message };

  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  if (!net) return { status: 404, error: 'Network not found' };
  const member = net.members.find(m => m.instanceId === instanceId);
  if (!member) return { status: 404, error: 'Member not found' };
  forceSetMemberSigningKey(member, parsed.data.signingPublicKey);
  saveConfig(cfg);
  return { status: 200, body: { ok: true, instanceId: member.instanceId } };
}
