/**
 * Network governance — vote-round conclusion and member-removal notification.
 *
 * These were exported from the api/sync.ts ROUTE module and imported by five others
 * (api/invite.ts, api/networks/{join,members,votes}.ts, sync/engine.ts) — route modules importing
 * domain logic from another route module. They are domain logic, so they live here now (A17.6).
 *
 * Round state is config (`network.pendingRounds`), persisted via saveConfig — not in-memory — which
 * is why both the HTTP surfaces and the sync engine can safely drive conclusion.
 */
import { getConfig, getSecrets } from '../config/loader.js';
import { revokePeerCredentialsIfOrphaned } from '../auth/tokens.js';
import { log } from '../util/log.js';
import { commitOwnMetaEdit } from '../spaces/effective-meta.js';
import { peerSafeFetch } from './peer-fetch.js';
import { buildBraintreeAncestors } from '../util/braintree.js';
import { applyMetaRound, type MetaRoundProposal } from './meta-round-merge.js';
import type { SpaceMeta } from '../config/types.js';

/**
 * Recompute the braintree ancestor voter set for a round from this instance's
 * own view of the tree, so conclusion never depends on a peer-supplied
 * `requiredVoters` *set*. Returns null for round types that are not
 * ancestor-gated (space_deletion / meta_change) or when no anchor is available —
 * the caller then falls back to requiring every member to vote yes.
 *
 * The round's `requiredVoters[0]` is the anchor node the proposer computed the
 * chain from (the inviting node for a join, the subject's parent for a remove).
 * We trust only that single anchor and recompute the FULL chain from it against
 * our local topology. This exactly reproduces the proposer's set for legitimate
 * rounds, but a peer cannot SHRINK the required set: anchoring on `[attacker]`
 * still recomputes the real ancestor chain from the attacker up to the root, so
 * every genuine ancestor must still vote yes.
 */
export function localBraintreeRequiredVoters(
  net: import('../config/types.js').NetworkConfig,
  round: import('../config/types.js').VoteRound,
): string[] | null {
  if (round.type !== 'join' && round.type !== 'remove') return null;
  const anchor = round.requiredVoters?.[0];
  if (!anchor) return null;
  return buildBraintreeAncestors(net, getConfig().instanceId, anchor);
}

export function concludeRoundIfReady(
  net: import('../config/types.js').NetworkConfig,
  round: import('../config/types.js').VoteRound,
): boolean {
  const voters = net.members.filter(m => !round.subjectInstanceId || m.instanceId !== round.subjectInstanceId);
  const vetoCount = round.votes.filter(v => v.vote === 'veto').length;
  const pastDeadline = new Date(round.deadline) < new Date();

  if (vetoCount > 0 || pastDeadline) {
    round.concluded = true;
    round.passed = false;
    // A failed JOIN leaves the candidate's provisioned credentials (peer PAT
    // issued at invite/apply time, outbound token in secrets) with no membership
    // to justify them — revoke unless something else still references the
    // instance. Deferred a tick so the caller's saveConfig runs first.
    if (round.type === 'join' && round.subjectInstanceId) {
      const rejectedId = round.subjectInstanceId;
      setImmediate(() => {
        revokePeerCredentialsIfOrphaned(rejectedId)
          .catch(err => log.error(`peer credential revocation for rejected joiner ${rejectedId}: ${err}`));
      });
    }
    return false;
  }

  // For unanimous-requirement types (closed, braintree): every remote voter must have voted yes
  // individually. A self/proposer yes vote counts as evidence of intent but does NOT short-circuit
  // the requirement for all listed members to vote.
  //
  // SECURITY: when there are no remote voters (the only member left is the round's
  // subject), conclude ONLY if THIS instance itself voted yes — i.e. a local
  // operator proposed the action. A self-initiated remove / space_deletion casts
  // our own yes when the round opens, so legitimate solo actions still pass. An
  // empty voter set was previously treated as vacuously "all voted yes", so a round
  // ADOPTED via gossip (which never carries our vote) concluded on an empty
  // quorum — letting a malicious peer in a small network force a
  // remove / space_deletion / meta_change through with no legitimate vote. Forged
  // casts are dropped by acceptVoteCast, so an adopted forged round holds no local
  // yes and correctly never concludes here.
  const localInstanceId = getConfig().instanceId;
  const localVotedYes = round.votes.some(
    c => c.instanceId === localInstanceId && c.vote === 'yes',
  );
  const allRemoteVotedYes =
    voters.length === 0
      ? localVotedYes
      : voters.every(v => round.votes.some(c => c.instanceId === v.instanceId && c.vote === 'yes'));

  const yesCount = round.votes.filter(v => v.vote === 'yes').length;

  let passed = false;
  switch (net.type) {
    case 'closed':
      passed = allRemoteVotedYes;
      break;
    case 'braintree': {
      // SECURITY: recompute the ancestor voter set from the LOCAL topology rather
      // than trusting `round.requiredVoters`. Once a round is adopted via gossip,
      // that field is attacker-controllable — a malicious peer could shrink it to
      // `[attacker]` and, with its own (authentic) yes vote, force a join/remove/
      // space_deletion to conclude on the victim. The local recomputation yields
      // the same set for legitimate rounds and cannot be shrunk by a peer.
      const localRequired = localBraintreeRequiredVoters(net, round);
      if (localRequired && localRequired.length > 0) {
        const relevant = localRequired.filter(id => id !== round.subjectInstanceId);
        passed = relevant.every(id =>
          round.votes.some(c => c.instanceId === id && c.vote === 'yes'),
        );
      } else {
        // No locally-derivable ancestor set (e.g. space_deletion / meta_change, a
        // pre-requiredVoters round, or an incomplete local tree view): fall back to
        // requiring EVERY current member to have voted yes — never fewer.
        passed = allRemoteVotedYes;
      }
      break;
    }
    case 'democratic':
      passed = (voters.length === 0 && yesCount > 0) || (yesCount > voters.length / 2 && vetoCount === 0);
      break;
    case 'club':
    case 'pubsub':
      // For Club/Pubsub: only the inviter/publisher (first yes voter) decides
      passed = yesCount >= 1 && vetoCount === 0;
      break;
  }
  if (passed) {
    round.concluded = true;
    round.passed = true;
    // On join round pass: the candidate will call join again and get a 200 with member list
    // On remove round pass: remove the member
    if (round.type === 'remove') {
      const idx = net.members.findIndex(m => m.instanceId === round.subjectInstanceId);
      if (idx >= 0) net.members.splice(idx, 1);
      // Revoke the ejected peer's credentials once it holds no membership anywhere.
      // Deferred a tick so the caller's saveConfig (and the member_removed notify,
      // which still needs our outbound token) run first.
      const ejectedId = round.subjectInstanceId;
      if (ejectedId) {
        setImmediate(() => {
          revokePeerCredentialsIfOrphaned(ejectedId)
            .catch(err => log.error(`peer credential revocation for ${ejectedId}: ${err}`));
        });
      }
    }
    // On meta_change round pass: apply the fields this round proposed to the space's CURRENT meta.
    //
    // Not `{ meta: round.pendingMeta }`. That snapshot was computed when the round opened, and rounds stay
    // open for `votingDeadlineHours` — so writing it wholesale reverts every field another round changed
    // in the meantime, with no error and a correctly-recorded carried vote to hide it.
    if (round.type === 'meta_change' && round.spaceId && round.pendingMeta) {
      const currentMeta = getConfig().spaces.find(s => s.id === round.spaceId)?.meta;
      // Through the own definitions (F-39.2): a space whose meta is rebuilt from layers would lose a direct write
      // at the next recompute. Before any layer exists this is the same plain write as before.
      let applied = applyMetaRound(currentMeta, round as MetaRoundProposal);
      commitOwnMetaEdit(round.spaceId, base => (applied = applyMetaRound(base, round as MetaRoundProposal)).meta as SpaceMeta);
      if (applied.conflicts.length > 0) {
        // The vote wins — the network decided this value — but the operator whose edit it superseded has
        // to be able to find out, and the only place that can say so is here.
        log.warn(
          `meta_change round ${round.roundId} overwrote field(s) changed since it was proposed ` +
          `(space ${round.spaceId}, based on meta v${round.baseMetaVersion}, now v${currentMeta?.version ?? 0}): ` +
          `${applied.conflicts.join(', ')} — the passed vote wins`,
        );
      }
    }
    return true;
  }
  return false;
}

// ── Notify ejected member after a remove vote passes ──────────────────────
// Fire-and-forget: non-fatal if the peer is unreachable.
export function sendMemberRemovedNotify(
  subjectUrl: string,
  subjectInstanceId: string,
  networkId: string,
): void {
  const cfg = getConfig();
  const secrets = getSecrets();
  const peerToken = secrets.peerTokens[subjectInstanceId];
  if (!peerToken) {
    log.warn(`member_removed: no outbound token for ${subjectInstanceId} — cannot notify`);
    return;
  }
  peerSafeFetch(`${subjectUrl}/api/notify`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${peerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ networkId, instanceId: cfg.instanceId, event: 'member_removed' }),
    signal: AbortSignal.timeout(10_000),
  }).catch(err => log.warn(`member_removed notify to ${subjectInstanceId}: ${err}`));
}
