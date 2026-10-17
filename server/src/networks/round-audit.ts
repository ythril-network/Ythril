/**
 * The audit entry for what a concluded round DID here when no request of this instance's operator asked for it (bundle-106, design v5
 * §2.3, §2.6, VR7, X17).
 *
 * ## What it prevents
 *
 * A round concludes through a relay, a gossip pass, the expiry tick or a retry as often as through an operator's own request — and only
 * the request has a route that audits it. So a space emptied by a peer's relayed yes, a member admitted on a gossip pass and an addition
 * a later deletion retired were each an effect the audit log never named: an operator reading it saw a vote and nothing it caused. Each
 * of those effects is written here, once, with the operation constant `audit/middleware.ts` re-exports, so the guide's table and the
 * entries cannot name it two ways. The operator's own request (`REQUEST_VIAS`) is audited by its route and never here.
 *
 * Imports nothing but the audit writer and the log: the space-act runner writes through it, and the runner may not import half the
 * server.
 */
import { logInternalAudit } from '../audit/audit.js';
import { log, peerText } from '../util/log.js';
import { warnOnce } from '../util/warn-once.js';

/** A held passed `space_addition` retired by a later deletion of the same network space: it is never applied. */
export const ROUND_ADDITION_RETIRED_OPERATION = 'network.round.addition_retired';
/** A passed deletion or wipe whose act completed here with nobody waiting for it. */
export const ROUND_SPACE_ACT_OPERATION = 'network.round.space_act';
/** A passed join that admitted its member here without a request of this instance's operator. */
export const ROUND_MEMBER_ADMITTED_OPERATION = 'network.round.member_admitted';
/** A space act with no round (solo, a subscriber's own) that completed after its door answered, or with no door at all (X17). */
export const SPACE_ACT_COMPLETED_OPERATION = 'space.act_completed';
/** A vote round the expiry job concluded because its deadline passed with nobody touching it: one entry per round. */
export const ROUND_EXPIRED_OPERATION = 'network.round.expired';

export type RoundEffectOperation =
  | typeof ROUND_ADDITION_RETIRED_OPERATION | typeof ROUND_SPACE_ACT_OPERATION | typeof ROUND_MEMBER_ADMITTED_OPERATION
  | typeof ROUND_EXPIRED_OPERATION;

/**
 * The path prefix of each operation's entry, which names the network and the round after it. The expiry's is the one the integration guide
 * documents (`internal:round-expiry:<network>:<round>`), so an integrator filtering the log by it keeps working; the others share
 * `internal:round`. The operation decides it, so no caller picks a path.
 */
const PATH_PREFIX: Readonly<Record<RoundEffectOperation, string>> = {
  [ROUND_ADDITION_RETIRED_OPERATION]: 'internal:round',
  [ROUND_SPACE_ACT_OPERATION]: 'internal:round',
  [ROUND_MEMBER_ADMITTED_OPERATION]: 'internal:round',
  [ROUND_EXPIRED_OPERATION]: 'internal:round-expiry',
};

const saidOnce = warnOnce<string>({ max: 10, every: 10 * 60_000 });

/**
 * One audit entry for `operation` on round `roundId` of network `networkId`. Never throws: an entry is a record, and a missing one must
 * not undo the effect it records.
 */
export function auditRoundEffect(
  operation: RoundEffectOperation, networkId: string, roundId: string, spaceId?: string | null,
): void {
  try {
    logInternalAudit({
      method: 'SYNC',
      path: `${PATH_PREFIX[operation]}:${String(networkId).slice(0, 80)}:${String(roundId).slice(0, 80)}`,
      operation,
      ...(spaceId ? { spaceId } : {}),
    });
  } catch (err) {
    saidOnce(operation, () => log.warn(`the audit entry ${operation} for round ${peerText(roundId)} was not written: ${peerText(err)}`));
  }
}
