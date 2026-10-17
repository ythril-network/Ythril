/**
 * Who is calling a governance relay — the peer itself, an instance administrator, or nobody entitled to.
 *
 * ## The relays, and what they let through
 *
 * `POST /api/sync/networks/:id/members` and `POST /api/sync/networks/:id/votes/:roundId` are relays: a peer
 * calls them to report its own member record, or to pass along a vote cast. Both carried `requireAuth` and
 * `denyReadOnly` and nothing more — no space scope, no network membership.
 *
 * **Each stated the rule it did not enforce.** The members route said *"tokens without peerInstanceId
 * (admin/local) may update any record"* — a description of who was expected to hold such a token, sitting
 * where a check should have been. The votes route said *"tokens (no peerInstanceId) may relay any unsigned
 * cast (compat)"* and then resolved the reporter as `callerPeerId ?? body.instanceId`, so with no peer id the
 * reporter became the cast's own instance: the two always matched, `acceptVoteCast` took the own-cast path,
 * and a network with `requireSignedVotes` accepted an unsigned cast attributed to any instance, on any round.
 * The rounds include `remove`, `space_deletion` and `space_wipe`, and for `club` and `pubsub` one yes with no
 * veto carries.
 *
 * ## Three values, not a boolean
 *
 * The routes need to know WHICH caller this is, because the two permissions differ: a peer may speak only for
 * itself — that is the gossip-poisoning rule the members route already had — while an administrator may relay
 * on anyone's behalf. A boolean would collapse those and hand the wider one to both.
 *
 * ## A peer identity WINS over admin, deliberately
 *
 * A token carrying `peerInstanceId` is acting as that peer, so it gets the narrower verdict even when the
 * record is also an admin. The alternative reads an admin peer's own credential as entitled to report
 * another peer's record — and only for admin peers, which is a rule that holds for some callers and not
 * others. That is worse than either answer applied consistently.
 *
 * ## THIS IS THE RULE THE DATA-WRITE ENDPOINTS ALREADY ENFORCE
 *
 * `isNonPeerSyncWrite` in `api/sync/_shared.ts` is the same predicate — not admin and no peer identity
 * means refuse — and it guards every `/api/sync` document write. Its message states the contract in as
 * many words: *"Sync writes require a peer token (peerInstanceId) or an admin token."*
 *
 * **So the two governance relays were the two endpoints that did not apply an existing rule**, and the
 * test suite shows it from the outside: every sync test that pushes DATA mints its peer token WITH
 * `peerInstanceId`, because it has to. Only the governance tests used a bare token — they could, because
 * these two routes were the gap. That is the evidence that this guard restores a rule rather than
 * inventing one.
 *
 * It is not the same FUNCTION because that one answers a boolean for a write, and a relay needs to know
 * WHICH caller it has: a peer may speak only for itself. The primitives are shared instead.
 *
 * ## Absence is refusal
 *
 * No token, or a token that is neither, is `refused`. The same rule that took `migrateToken({})` off two
 * call sites in the tokens API: an input carrying no information must not resolve to the widest answer the
 * model can express.
 */
import { isInstanceAdmin } from './instance-admin.js';
import { peerBoundTo } from './peer-bound.js';
import type { TokenRights } from '../config/rights-shape.js';

/** What the token presenting itself at a governance relay may do. */
export type PeerRelayCaller =
  /** A peer speaking for itself. It may report only this instance's record or cast. */
  | { kind: 'peer'; peerInstanceId: string }
  /** An instance administrator, which may relay on any instance's behalf. */
  | { kind: 'admin' }
  /** Authenticated, and allowed neither. */
  | { kind: 'refused' };

/**
 * Read what the caller may do off the authenticated token record.
 *
 * Structural rather than `Pick<TokenRecord, …>` for the same reason `isInstanceAdmin` is: `peerInstanceId`
 * is not on every record shape that reaches here, and an OIDC session is built per request.
 */
export function peerRelayCaller(
  record: { peerInstanceId?: string; admin?: boolean; rights?: TokenRights | null } | undefined,
): PeerRelayCaller {
  if (!record) return { kind: 'refused' };

  const peerInstanceId = peerBoundTo(record);
  if (peerInstanceId) return { kind: 'peer', peerInstanceId };

  return isInstanceAdmin(record) ? { kind: 'admin' } : { kind: 'refused' };
}

/**
 * The refusal a relay answers with, in one place so both say the same thing.
 *
 * Names the two ways in, because the caller cannot tell from a bare 403 whether they need a peer credential
 * or an administrator's — and a relay is something an operator wires up once and then debugs from the
 * response.
 */
export const PEER_RELAY_REFUSAL = 'This relay accepts a peer token speaking for its own instance, or an '
  + 'instance administrator relaying on a peer\'s behalf. This token is neither.';
