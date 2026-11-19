/**
 * Land a passed `space_rebase` round at its DEADLINE (Q-748, design r4 §4.1 rule 4; owner, 2026-11-18: a base change on a shared space is
 * counted like a deletion and applied at the vote's deadline, and a member that left keeps its base).
 *
 * ## What it prevents
 *
 * - **A base that moves at the pass.** On a club or a pub/sub network the proposer's yes passes a round at once, so a change applied at the
 *   pass would leave a member no time to leave before every address of the space changed. Landed at the deadline, the voting period is
 *   every member's time to veto or leave; a member that leaves takes the network and its rounds off its config, so the round never lands
 *   there and it keeps its base, its epoch and every name it gave out.
 * - **A landing lost to a restart.** What is owed is the round itself, kept in the network config by the prune until it has landed
 *   (`rebaseRoundUnapplied`); the expiry tick lands every owed one through {@link applyOwedRebaseRounds}; nothing is held in memory.
 * - **A landing twice.** The round is marked through `settleSpaceAct`, and the setting refuses an epoch it already holds (`settleRdf`,
 *   `rebase-round`).
 *
 * It rewrites no record and holds no write: the base is a setting. It opens no round (the door does, in `applySpaceMetaUpdate`), so it
 * stays out of the server's largest import cycle.
 */
import type { Config, NetworkConfig } from '../config/types.js';
import { logInternalAudit } from '../audit/audit.js';
import { log, peerText } from '../util/log.js';
import { rebaseRoundOwed } from '../networks/round-state.js';
import { rebaseRoundSpaceOf, settleRdf } from './rdf-settle.js';
import { storeMovedRdf } from './rdf-store.js';
import { settleSpaceAct } from './apply-wipe-round.js';

/** The audit operation of one landing of a passed rebase round: one row per member that lands it. */
export const SPACE_RDF_REBASE_OPERATION = 'space.rdf_rebase';

/** The longest part of a network or round id an audit path carries, as the round-effect entries bound it. */
const AUDIT_PATH_PART_MAX = 80;

/**
 * Land every rebase round of `net` owed at `now` (passed, unvetoed, its deadline come, not applied here): set the space's base, vocab and
 * epoch, and clear the space's recorded base conflicts (`storeMovedRdf`); mark the round in the same synchronous step; write one `space.rdf_rebase` audit row. A round for a space not carried here is marked and moves
 * nothing. SYNCHRONOUS, for the expiry tick's one save; returns whether it changed the config.
 */
export function applyOwedRebaseRounds(net: NetworkConfig, cfg: Config, now: number): boolean {
  let wrote = false;
  for (const round of net.pendingRounds ?? []) {
    if (!rebaseRoundOwed(round, now)) continue;
    wrote = true;
    const local = rebaseRoundSpaceOf(net, round);
    const space = local === undefined ? undefined : cfg.spaces.find(s => s.id === local);
    if (!space || !round.rebase) { settleSpaceAct(net, round, 'not-carried'); continue; }
    const settled = settleRdf(space.ownMeta?.rdf ?? space.meta?.rdf, round.rebase, 'rebase-round');
    settleSpaceAct(net, round, 'completed');
    if (!settled.ok || !settled.rebased || !settled.rdf) continue;
    if (!storeMovedRdf(cfg, space, settled.rdf)) continue;
    log.info(`space '${peerText(space.id)}': RDF base moved from ${peerText(settled.rebased.from)} to ${peerText(settled.rebased.to)} `
      + `(epoch ${settled.rebased.epoch}) by round ${peerText(round.roundId)} of network ${peerText(net.id)}`);
    try {
      logInternalAudit({
        method: 'SYNC',
        path: `internal:round:${String(net.id).slice(0, AUDIT_PATH_PART_MAX)}:${String(round.roundId).slice(0, AUDIT_PATH_PART_MAX)}`,
        operation: SPACE_RDF_REBASE_OPERATION, spaceId: space.id,
      });
    } catch (err) {
      log.warn(`the audit entry ${SPACE_RDF_REBASE_OPERATION} for round ${peerText(round.roundId)} was not written: ${peerText(err)}`);
    }
  }
  return wrote;
}
