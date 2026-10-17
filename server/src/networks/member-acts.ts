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
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { getConfig, saveConfig, getSecrets, saveSecrets } from '../config/loader.js';
import { revokePeerCredentialsIfOrphaned } from '../auth/tokens.js';
import { buildBraintreeAncestors } from '../util/braintree.js';
import { forceSetMemberSigningKey } from '../util/signing.js';
import { log, peerText, refusalOfParse } from '../util/log.js';
import type { NetworkMember } from '../config/types.js';
import { BCRYPT_ROUNDS, SSRF_SAFE_URL, safeMemberList } from '../api/networks/_shared.js';
import type { NetworkActResult } from './network-acts.js';
import { proposeRound, type RoundProposal } from './propose-round.js';
import { roundIsOpen } from './round-state.js';
import { roundForOperator } from './vote-acts.js';
import { joinOutcomesAbout, joinWasDenied } from './round-outcomes.js';
import { stampAdmission, recordRemoval, acceptIntroduction } from './member-introductions.js';

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
  if (!parsed.success) return { status: 400, error: refusalOfParse(parsed.error).error };

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
  const joinRound = (requiredVoters?: string[]): RoundProposal => ({
    type: 'join',
    subjectInstanceId: instanceId,
    subjectLabel: label,
    subjectUrl: url,
    pendingMember: member,
    ...(requiredVoters ? { requiredVoters } : {}),
  });

  if (freshNet.type === 'club' || freshNet.type === 'pubsub') {
    // Pubsub never allows 'both' — publisher stores subscribers as 'push', subscriber stores publisher as 'pull'.
    // If 'both' is provided, default to 'push' (the common publisher-side case); explicit 'pull' is respected so the
    // subscriber can manually add the publisher.
    if (freshNet.type === 'pubsub' && member.direction === 'both') member.direction = 'push';
    stampAdmission(freshNet, member);
    freshNet.members.push(member);
    storePeerToken(instanceId, token);
    saveConfig(freshCfg);
    log.info(`Added member ${peerText(label)} (${peerText(instanceId)}) to network ${peerText(freshNet.id)}`);
    return { status: 201, body: safe(member) };
  }

  // Closed, democratic, braintree: a vote. The proposer's yes is in it from the start (D-36), so where that yes is the quorum —
  // the only member of a closed or democratic network, a braintree root — the member is admitted at once (`applyPassedJoin`,
  // through the settle) → 201. A braintree's required voters are the ancestry path from self to the root.
  const requiredVoters = freshNet.type === 'braintree' ? buildBraintreeAncestors(freshNet, freshCfg.instanceId, freshCfg.instanceId) : undefined;
  storePeerToken(instanceId, token);
  const { round, decided } = proposeRound(freshNet, freshCfg, joinRound(requiredVoters));
  saveConfig(freshCfg);
  if (decided === 'passed') {
    log.info(`Join of ${peerText(label)} (${peerText(instanceId)}) to network ${peerText(freshNet.id)} passed at open: admitted`);
    return { status: 201, body: safe(member) };
  }
  log.info(`Opened join vote round ${peerText(round.roundId)} for ${peerText(label)} (${peerText(instanceId)}) in network ${peerText(freshNet.id)}`);
  return { status: 202, body: { status: 'vote_pending', roundId: round.roundId, round: roundForOperator(freshNet, round) } };
}

/** Remove a member: `204` when done at once, or `202` when the network's type puts it to a vote. */
export function removeMemberAct(networkId: string, instanceId: string): NetworkActResult {
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  if (!net) return NOT_FOUND;

  const memberIdx = net.members.findIndex(m => m.instanceId === instanceId);
  if (memberIdx < 0) return { status: 404, error: 'Member not found' };
  const subject = net.members[memberIdx]!;

  if (net.type === 'club' || net.type === 'pubsub') {
    // Club / Pubsub: publisher (owner) removes directly, no vote required
    net.members.splice(memberIdx, 1);
    // Q-135: on a club the removal travels to every member beside the roster, the way the admission did.
    recordRemoval(net, subject.instanceId);
    saveConfig(cfg);
    revokePeerCredentialsIfOrphaned(subject.instanceId)
      .catch(err => log.error(`peer credential revocation for ${peerText(subject.instanceId)}: ${peerText(err)}`));
    return { status: 204 };
  }

  // Closed, democratic, braintree: a vote, with the proposer's yes in it from the start (D-36). On a braintree the subject's parent
  // and every ancestor up to the root must approve (a yes from outside that set decides nothing: the pass rule counts the ancestors);
  // where the proposer's yes is the quorum the member is removed at once and told (`member_removed`, through the settle) → 204.
  const requiredVoters = net.type === 'braintree' ? buildBraintreeAncestors(net, cfg.instanceId, subject.parentInstanceId ?? cfg.instanceId) : undefined;
  const { round, decided } = proposeRound(net, cfg, {
    type: 'remove', subjectInstanceId: subject.instanceId, subjectLabel: subject.label, subjectUrl: subject.url,
    ...(requiredVoters ? { requiredVoters } : {}),
  });
  saveConfig(cfg);
  if (decided === 'passed') {
    log.info(`Removal of ${peerText(subject.label)} (${peerText(subject.instanceId)}) from network ${peerText(net.id)} passed at open`);
    return { status: 204 };
  }
  log.info(`Opened remove vote round ${peerText(round.roundId)} for ${peerText(subject.label)} (${peerText(subject.instanceId)}) in network ${peerText(net.id)}`);
  return { status: 202, body: { status: 'vote_pending', roundId: round.roundId, round: roundForOperator(net, round) } };
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
  if (!parsed.success) return { status: 400, error: refusalOfParse(parsed.error).error };

  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  if (!net) return { status: 404, error: 'Network not found' };

  const keyValid = net.inviteKeyHash
    ? await bcrypt.compare(parsed.data.inviteKey, net.inviteKeyHash)
    : false;

  if (!keyValid) {
    // Vote-governed joins consume the network's invite key when the round opens
    // and preserve the validated hash on the round record. Re-presenting the
    // same key lets the joiner poll the outcome of its own round — while the
    // round is kept, and afterwards from the entry that records how it ended.
    const now = Date.now();
    for (let i = net.pendingRounds.length - 1; i >= 0; i--) {
      const round = net.pendingRounds[i]!;
      if (round.type !== 'join' || !round.inviteKeyHash) continue;
      if (round.subjectInstanceId !== parsed.data.instanceId) continue;
      if (!await bcrypt.compare(parsed.data.inviteKey, round.inviteKeyHash)) continue;

      // Open means before its deadline: a round past it takes no vote, so "pending" would be a promise nothing keeps.
      if (roundIsOpen(round, now)) {
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
    // The round was pruned: the log of how it ended answers for it. A joiner whose round did not pass is told so, as it was
    // before the prune — never "no active invite key", which says nobody was asked. That includes an entry whose reason was
    // never recorded (`ended`): a round that had passed would have made the joiner a member, and a member is not asked here.
    if (!net.members.some(m => m.instanceId === parsed.data.instanceId)) {
      for (const entry of joinOutcomesAbout(net, parsed.data.instanceId)) {
        if (!await bcrypt.compare(parsed.data.inviteKey, entry.inviteKeyHash!)) continue;
        if (joinWasDenied(entry)) {
          return { status: 403, error: 'Join was denied by network governance (vetoed or expired)' };
        }
      }
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

  if (freshNet.type === 'closed' || freshNet.type === 'democratic' || freshNet.type === 'braintree') {
    // A vote (S9 for braintree: every ancestor on the path from this inviting node to the root votes yes; the joiner always becomes a
    // child of the inviting node, topology fields from the wire ignored). The inviting node's yes is in it from the start (D-36), so
    // where it is the quorum — this instance alone in a closed or democratic network, a braintree root — the joiner is admitted at
    // once and answered as a re-presentation after a pass is: the admitted shape.
    const requiredVoters = freshNet.type === 'braintree' ? buildBraintreeAncestors(freshNet, freshCfg.instanceId, freshCfg.instanceId) : undefined;
    if (freshNet.type === 'braintree') {
      member.parentInstanceId = freshCfg.instanceId;
      member.direction = 'push';   // we push to our children
    }
    // Consume the key (single-use) and store the peer token for post-admission sync.
    const inviteKeyHash = net.inviteKeyHash;   // preserved on the round so the joiner can poll it
    freshNet.inviteKeyHash = undefined;
    const secrets = getSecrets();
    secrets.peerTokens[instanceId] = token;
    saveSecrets(secrets);
    const { round, decided } = proposeRound(freshNet, freshCfg, {
      type: 'join', subjectInstanceId: instanceId, subjectLabel: label, subjectUrl: url,
      pendingMember: member, inviteKeyHash, ...(requiredVoters ? { requiredVoters } : {}),
    });
    saveConfig(freshCfg);
    if (decided === 'passed') {
      log.info(`Join via invite key of ${peerText(label)} (${peerText(instanceId)}) to network ${peerText(freshNet.id)} passed at open: admitted`);
      return { status: 200, body: { status: 'joined', members: safeMemberList(freshNet, instanceId), networkId: freshNet.id } };
    }
    log.info(`Join via invite key opened vote round ${peerText(round.roundId)} for ${peerText(label)} (${peerText(instanceId)}) in network ${peerText(freshNet.id)}`);
    return { status: 202, body: { status: 'vote_pending', roundId: round.roundId, round: roundForOperator(freshNet, round) } };
  }

  // Club / Pubsub — direct join via invite key (documented behavior)
  // Pubsub subscribers are always push-only (publisher pushes to them).
  if (freshNet.type === 'pubsub') member.direction = 'push';
  stampAdmission(freshNet, member);
  freshNet.members.push(member);
  // Pubsub keys are reusable (publishable in docs, QR codes, etc.)
  // All other types consume the key after use to prevent replay.
  if (freshNet.type !== 'pubsub') freshNet.inviteKeyHash = undefined;
  saveConfig(freshCfg);
  log.info(`Member ${peerText(label)} joined network ${peerText(freshNet.id)} via invite key`);

  // Return peer the member list and network metadata (enough to start syncing)
  return { status: 200, body: { status: 'joined', members: safeMemberList(freshNet, instanceId), networkId: freshNet.id } };
}

/**
 * The operator's OK on a member another member's roster only PROPOSED, on a closed or democratic network (`Q-154`).
 *
 * On a voted network a roster is not the authority — an admitted instance votes — so an introduction from anyone but
 * the member that admitted this instance waits here until the operator accepts it; pairing follows on the next sync.
 * Instance-admin on both doors, as every member act is: it decides who this instance trusts.
 */
export function acceptIntroductionAct(networkId: string, instanceId: string): NetworkActResult {
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  if (!net) return NOT_FOUND;
  if (!acceptIntroduction(net, instanceId)) {
    return { status: 404, error: 'No introduction of that instance is waiting for an OK on this network' };
  }
  saveConfig(cfg);
  log.info(`Network ${peerText(net.id)}: introduction of ${peerText(instanceId)} accepted; pairing follows on the next sync`);
  return { status: 200, body: { status: 'accepted', instanceId } };
}

/**
 * Break-glass: force-pin a member's governance signing key WITHOUT a rotation proof. Use when a peer lost its old
 * private key (so it cannot produce a continuity proof) and must re-establish trust. Normal rotations propagate
 * automatically via a signed proof over gossip.
 */
export const SigningKeyBody = z.object({ signingPublicKey: z.string().min(100).max(4000) });

export function setSigningKeyAct(networkId: string, instanceId: string, input: unknown): NetworkActResult {
  const parsed = SigningKeyBody.safeParse(input);
  if (!parsed.success) return { status: 400, error: refusalOfParse(parsed.error).error };

  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  if (!net) return { status: 404, error: 'Network not found' };
  const member = net.members.find(m => m.instanceId === instanceId);
  if (!member) return { status: 404, error: 'Member not found' };
  forceSetMemberSigningKey(member, parsed.data.signingPublicKey);
  saveConfig(cfg);
  return { status: 200, body: { ok: true, instanceId: member.instanceId } };
}
