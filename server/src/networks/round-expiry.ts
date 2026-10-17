/**
 * A vote round nobody touches still ends at its deadline: this job concludes it, records how, and prunes it.
 *
 * ## What it prevents
 *
 * A round past its deadline stayed `concluded: false` until a cast, a peer relay or a gossip pass happened to touch it. Until
 * then the operator list and the space chip showed it as open, a cast on it was taken, and on a quiet network (a single member,
 * a peer that never comes back) it stayed for ever, with nothing recording how it ended once the prune removed it.
 *
 * ## What a tick does, and why it is SYNCHRONOUS
 *
 * It reads the config, settles every round past its deadline through `settleRounds` (never by setting fields: what concluding does —
 * revoking a failed join's credentials, recording the outcome — is written once, in `concludeRoundIfReady`, and what a conclusion does
 * here once, in the settle), hands each network's owed space rounds back to the settle (`'retry'`: a round with nothing to do here is
 * settled there, one this instance must act on registers or joins its act), prunes what is prunable (recording it first), and saves
 * ONCE if anything changed. Then it starts every owed space act whose `retryAt` has passed — the runner's retry clock. There is no
 * `await` between the read and the save: a config reload landing between them would be overwritten by a snapshot older than it. So
 * the tick returns nothing to await, and the walk is `eachNetwork`, which is synchronous too (config work has no database operation
 * for the space walk's bound to end).
 *
 * ## What it promises, and no more
 *
 * One poison round never stops the rest of its network and one poison network never stops the others: each round is a unit of the
 * walk inside each network. A failure is counted (`ythril_round_expiry_failures_total`) and said once per network per window
 * (`eachNetwork`); a failed save is counted and said the same way, and the next tick tries again — what it concluded is still in
 * memory and the rounds still stand concluded, so nothing is decided twice.
 *
 * What an EXPIRED round does here, by round type and network type: nothing — except a failed join, whose provisioned credentials
 * are revoked once nothing else references the instance, as a vetoed or expired join always did. A round that has a quorum yet was
 * never evaluated (a `space_deletion` or `space_wipe` nobody concluded at open) is not this job's: it ends as expired, as it would
 * have when anything touched it past the deadline. D-39 = C (owner, 2026-10-15): a round within its deadline is never evaluated for
 * passing here — rounds open at the upgrade run to their deadline and expire, and the operator proposes again.
 */
import { getConfig, saveConfig } from '../config/loader.js';
import type { NetworkConfig, VoteRound } from '../config/types.js';
import { logInternalAudit } from '../audit/audit.js';
import { ROUND_EXPIRED_OPERATION } from '../audit/middleware.js';
import { roundExpiryFailuresTotal } from '../metrics/registry.js';
import { pruneExpiredRounds } from '../sync/vote-round-retention.js';
import { retryOwedSpaceActs } from '../spaces/space-act-runner.js';
import { roundSpaceLocalId } from '../sync/space-map.js';
import { eachNetwork } from '../util/housekeeping-walk.js';
import { intervalJob } from '../util/interval-job.js';
import { log, peerText } from '../util/log.js';
import { SKIP_WARNING_WINDOW_MS } from '../util/single-flight.js';
import { warnOnce } from '../util/warn-once.js';
import { settleRounds } from './round-conclusion.js';
import { roundPastDeadline, spaceActOwed } from './round-state.js';

/** The label of the job: the `job` of `ythril_interval_tick_skipped_total` and the head of its failure lines. Kept equal to the one literal `intervalJob` is registered under, below. */
const LABEL = 'Vote round expiry';

/** A failure that is not a unit of the walk (the save, an audit write): one line per window. */
const saidOnce = warnOnce<string>({ max: 10, every: SKIP_WARNING_WINDOW_MS });

/**
 * A save failed and none has succeeded since. The rounds it would have written are concluded and pruned in memory, so the next tick
 * finds nothing to change and would not save on its own: this is what makes it save anyway.
 */
let unsaved = false;

/** One audit entry for a round this job concluded. Never throws: the audit is a record, and a missing one must not undo the conclusion. */
function auditExpired(net: NetworkConfig, round: VoteRound): void {
  try {
    let space: string | null = null;
    try { space = roundSpaceLocalId(net, round); } catch { /* a network whose spaces are unreadable names none */ }
    logInternalAudit({
      method: 'SYNC',
      path: `internal:round-expiry:${String(net.id).slice(0, 80)}:${String(round.roundId).slice(0, 80)}`,
      // `satisfies` ties the constant to the operation name the audit documentation lists, so renaming one without the other does not compile.
      operation: ROUND_EXPIRED_OPERATION satisfies 'network.round.expired',
      ...(space ? { spaceId: space } : {}),
    });
  } catch (err) {
    saidOnce('audit', () => log.warn(`${LABEL}: the audit entry for an expired round was not written: ${peerText(err)}`));
  }
}

/**
 * One pass over every network at `now`. SYNCHRONOUS and exported for the tests that drive it; the job calls it every minute.
 * Never throws: a failure is counted and said, and the pass goes on.
 */
export function runRoundExpiryTick(now: number = Date.now()): void {
  const cfg = getConfig();
  let dirty = false;
  let failures = 0;

  const networks = Array.isArray(cfg.networks) ? cfg.networks : [];
  // Not `failures += eachNetwork(...)`: the right side reads `failures` BEFORE the walk runs and writes it back after, which would
  // discard what the callbacks added meanwhile.
  const walked = eachNetwork(LABEL, networks, (net) => {
    const concluded: VoteRound[] = [];
    const rounds = Array.isArray(net.pendingRounds) ? [...net.pendingRounds] : [];
    // The lazy heal (design v5 §3.1, VR1): a stored round that is NOT concluded but says `passed` can only have come from a peer — an
    // older build adopted an upgraded proposer's passed round with its `passed` kept — and every reader requires `concluded` with it,
    // but a stored contradiction is one reader away from deciding something. Cleared once, in this tick's one save.
    for (const round of rounds) {
      if (round.concluded !== true && round.passed !== undefined) { delete round.passed; dirty = true; }
    }
    const walkedRounds = eachNetwork(`${LABEL} (network ${net.label ?? net.id})`, rounds, (round) => {
      if (round.concluded || !roundPastDeadline(round, now)) return;
      // Before the call, not after: a conclusion that throws once it has marked the round still changed what the save must write.
      dirty = true;
      // At once and per round: it IS concluded in memory, and the save keeps it, so what it decided is applied even when another
      // round of the network fails. The tick awaits no act (it stays synchronous); a failure is counted below.
      const out = settleRounds(net, cfg, [round], 'expiry', now);
      failures += out.failed.length;
      if (round.concluded) {
        concluded.push(round);
        auditExpired(net, round);
      }
    });
    failures += walkedRounds.failed.length;
    // The owed space rounds of this network, handed back once per tick: one with nothing to do here (stored by an older build, or
    // whose space this instance no longer carries) is settled, one this instance must act on registers or joins its act (X1, X7).
    const owed = rounds.filter(spaceActOwed);
    if (owed.length > 0) {
      const out = settleRounds(net, cfg, [], 'retry', now, owed);
      if (out.wrote) dirty = true;
      failures += out.failed.length;
    }
    if (concluded.length > 0) {
      const byType: Record<string, number> = {};
      for (const round of concluded) byType[round.type] = (byType[round.type] ?? 0) + 1;
      log.info(`Vote rounds past their deadline on network '${peerText(net.label)}' concluded: ${
        Object.entries(byType).map(([type, n]) => `${n} ${peerText(type)}`).join(', ')}`);
    }
    if (pruneExpiredRounds(net, now) > 0) dirty = true;
  });
  failures += walked.failed.length;

  if (dirty || unsaved) {
    try {
      saveConfig(cfg);
      unsaved = false;
    } catch (err) {
      unsaved = true;
      failures += 1;
      saidOnce('save', () => log.error(`${LABEL}: the config could not be saved after rounds concluded, so they are tried again next tick: ${peerText(err)}`));
    }
  }
  if (failures > 0) roundExpiryFailuresTotal.inc(failures);
  // The runner's retry clock: every owed act whose `retryAt` has passed at `now` is started (it joins a run already going). Never
  // awaited and never rejected — a run answers, and a failure leaves its entry owed with the next `retryAt`.
  void retryOwedSpaceActs(now);
}

const job = intervalJob('Vote round expiry', 60_000, () => runRoundExpiryTick());

/** Start the job. Idempotent; the first tick is one interval away. */
export function startRoundExpiry(): void { job.start(); }

/** Stop the job. Idempotent; a tick that is running finishes. */
export function stopRoundExpiry(): void { job.stop(); }
