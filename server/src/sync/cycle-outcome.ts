/**
 * What one sync cycle came to, member by member, and the one verdict every door, the history and the metric read (bundle-81 design rev 8 §6;
 * bundle-39 D1, D2: Q-220, Q-331).
 *
 * ## The questions it answers
 *
 * 1. "Given how a member's turn ended, what is its outcome?" — {@link classifyMemberTurn}, one precedence for both doors. The scheduled cycle
 *    (`runSyncForNetwork`) and the manual door (`runSyncForPeer`) each had their own reading: the scheduled one counted a database fault on THIS
 *    instance against the peer, the manual one discarded what the turn returned and counted nothing, so a peer answering 500 never raised PEER
 *    UNREACHABLE from a manual sync.
 * 2. "What does that outcome do to the member's failure counter?" — {@link CycleOutcome.member}, the one place it is decided: the counter measures
 *    the PEER, so `failed` counts, a turn in which the peer answered resets it, and anything else leaves it.
 * 3. "What did the cycle come to?" — {@link syncVerdict}, one ordered table over the members' outcomes. The owner (2026-11-01): "how can they differ?
 *    its different doors to the same house?? the answer should be truthful".
 *
 * ## The member outcomes (one closed list, {@link MEMBER_OUTCOMES})
 *
 *  - **success**: every transfer completed.
 *  - **catching-up**: a transfer stopped at the cycle's page cap (decision 33): the member answered, its mark moved, the rest follows. Not success:
 *    a cycle with one is `partial`.
 *  - **records-refused**: the peer answered and discarded some records by its own rules (Q-59).
 *  - **peer-too-old**: the peer answered in the 5.x shape (`PeerPagesBySeq`, `sync/wire-answer.ts`) or is below the version floor (`PeerBelowFloor`):
 *    its turn ended before any data moved, no mark was written, no failure is counted, and the member shows "Version too old".
 *  - **local-fault**: THIS instance failed (a page it could not land, its store failing at the turn, no token stored for the peer). Not the peer's
 *    failure, so never toward PEER UNREACHABLE; counted in the cycle's errors, since the turn did not complete. A lasting one is a streak of its own
 *    (`consecutiveLocalFaults`): the network chip reads it, and the tenth logs LOCAL STORE FAILING once.
 *  - **interrupted**: shutdown stopped the turn at a page boundary. Nothing failed; the counter does not move.
 *  - **failed**: the peer did not answer, or answered an error, or a transfer from it stopped early for a reason that is its own.
 *
 * A member's reason is OUR sentence per outcome ({@link REASONS}), never the driver's or the peer's text: it reaches an answer body. The detail
 * goes to the log and the cycle's history, as before.
 */
import { getConfig, saveConfigSoon } from '../config/loader.js';
import type { NetworkConfig, NetworkMember } from '../config/types.js';
import { SYNC_MEMBER_OUTCOMES, syncItemsPulledTotal, syncItemsPushedTotal, syncMemberOutcomesTotal } from '../metrics/registry.js';
import { PeerPagesBySeq } from '../util/errors.js';
import { log, peerText } from '../util/log.js';
import { warnOnce } from '../util/warn-once.js';
import { SKIP_WARNING_WINDOW_MS } from '../util/single-flight.js';
import { isStoreSide } from '../brain/store-failure.js';
import { storeIsNotAnswering } from '../db/store-condition.js';
import { isShuttingDown } from '../lifecycle.js';
import { PeerBelowFloor } from './peer-floor.js';
import { stopKindOfThrow } from './arrival-stop.js';
import { COUNT_KEYS, addCounts, zeroCounts, type SyncCounts } from './replicated-families.js';
import type { MemberExchange } from './space-exchange.js';

/** How a cycle is counted: `ythril_sync_cycles_total{status}` and the history row's `status`, the same word. */
export type CycleStatus = 'success' | 'partial' | 'failed' | 'refused';

/** Every way a member's turn can end, in the plan's order. A word added here is added to the verdict table and to the metric's series. */
export const MEMBER_OUTCOMES = SYNC_MEMBER_OUTCOMES;
export type MemberOutcome = typeof MEMBER_OUTCOMES[number];

/** One member's turn, as every waited answer carries it (`members[]`). `reason` is our sentence for the outcome, never a driver's or a peer's text. */
export interface MemberResult {
  networkId: string;
  instanceId: string;
  label: string;
  outcome: MemberOutcome;
  reason: string;
}

/** Our sentence per outcome (closed list, at most 200 characters): what a member's `reason` says. */
export const REASONS = {
  'success': 'every transfer with the peer completed',
  'catching-up': 'the peer answered; a transfer reached the cycle\'s page bound and continues next cycle',
  'records-refused': 'the peer answered and refused some records by its own rules',
  'peer-too-old': 'the peer runs a version this one cannot sync with',
  'local-fault': 'this instance\'s database failed while exchanging with the peer',
  'interrupted': 'stopped for shutdown',
  'failed': 'the peer did not answer, or answered an error',
  // Two local faults of their own (v6 S6, S10): the reason names which.
  'store-down': 'this instance\'s database is not answering',
  'no-token': 'no token is stored for this peer on this instance',
} as const;

/** The one verdict of a cycle: its word, whether it is a success, the HTTP status a REST door answers, and the code a 502 / 503 carries. */
export interface SyncVerdict {
  outcome: 'success' | 'partial' | 'refused' | 'failed' | 'interrupted';
  ok: boolean;
  status: 200 | 502 | 503;
  code?: 'shutting_down' | 'sync_store_failed' | 'sync_failed';
}

/**
 * The cycle's verdict from its members' outcomes: the FIRST row that matches wins (bundle-39 D2 v3, v5, v7).
 *
 *  1. any `interrupted` -> interrupted, 503 `shutting_down` (a shutdown is not a sync result);
 *  2. every member `success`, or none -> success, 200;
 *  3. nothing in {success, catching-up, records-refused} and every member `peer-too-old` -> refused, 200;
 *  4. nothing in {success, catching-up, records-refused} and every member that is not `peer-too-old` is `local-fault` -> failed, 503 `sync_store_failed`;
 *  5. nothing in {success, catching-up, records-refused} -> failed, 502 `sync_failed`;
 *  6. otherwise -> partial, 200 (catching-up alone is partial: decision 33).
 *
 * Pure: it reads the members and changes nothing. `ok` is true for `success` and for nothing else.
 */
export function syncVerdict(members: readonly Pick<MemberResult, 'outcome'>[]): SyncVerdict {
  const has = (...words: MemberOutcome[]): boolean => members.some(m => words.includes(m.outcome));
  if (has('interrupted')) return { outcome: 'interrupted', ok: false, status: 503, code: 'shutting_down' };
  if (members.every(m => m.outcome === 'success')) return { outcome: 'success', ok: true, status: 200 };
  if (!has('success', 'catching-up', 'records-refused')) {
    if (members.every(m => m.outcome === 'peer-too-old')) return { outcome: 'refused', ok: false, status: 200 };
    return members.every(m => m.outcome === 'local-fault' || m.outcome === 'peer-too-old')
      ? { outcome: 'failed', ok: false, status: 503, code: 'sync_store_failed' }
      : { outcome: 'failed', ok: false, status: 502, code: 'sync_failed' };
  }
  return { outcome: 'partial', ok: false, status: 200 };
}

/** The word a history row and the cycle metric record for a verdict: a shutdown is no sync result, so an interrupted cycle is `partial` there. */
export function cycleStatusOf(verdict: SyncVerdict): CycleStatus {
  return verdict.outcome === 'interrupted' ? 'partial' : verdict.outcome;
}

const isExchange = (x: unknown): x is MemberExchange =>
  typeof x === 'object' && x !== null && Array.isArray((x as MemberExchange).incomplete) && typeof (x as MemberExchange).pulled === 'object';

/**
 * A member's outcome from what its turn returned or threw, by one precedence: interrupted > failed > local-fault > peer-too-old > records-refused >
 * catching-up > success (v6 S13). A thrown `PeerPagesBySeq` / `PeerBelowFloor` is `peer-too-old`; a throw while shutdown is under way is `interrupted`;
 * this instance's store failing (`isStoreSide`) is `local-fault`; any other throw is `failed`.
 */
export function classifyMemberTurn(ended: MemberExchange | unknown): MemberOutcome {
  if (isExchange(ended)) {
    if ((ended.interrupted ?? []).length > 0) return 'interrupted';
    if (ended.incomplete.length > 0) return 'failed';
    if ((ended.localFaults ?? []).length > 0) return 'local-fault';
    if (ended.refused.length > 0) return 'records-refused';
    if (ended.capped.length > 0) return 'catching-up';
    return 'success';
  }
  if (ended instanceof PeerPagesBySeq || ended instanceof PeerBelowFloor) return 'peer-too-old';
  if (stopKindOfThrow(ended) === 'closing') return 'interrupted';
  if (isStoreSide(ended)) return 'local-fault';
  return 'failed';
}

// After this many consecutive sync failures for a single member, we emit a prominent warning. The member is NOT auto-removed — that is a human decision.
const STALE_FAILURE_THRESHOLD = 10;
/** The same threshold for this instance's own faults with a member (v4 S3): logged once, at error. */
const LOCAL_FAULT_THRESHOLD = 10;

const saidTooOld = warnOnce<string>({ every: SKIP_WARNING_WINDOW_MS });

/**
 * The member answered in the 5.x shape: stamp the evidence the floor reads (`versionCheckedAt`: a peer that answered and named no version is below the
 * floor, and a member that never gossiped has no other evidence) so the network view shows "Version too old", and say it once per member per window.
 * The stamp is written once and never refreshed (the config write is the same hot-path write the marks use).
 */
function noteMemberPagesBySeq(net: NetworkConfig, member: NetworkMember): void {
  const cfg = getConfig();
  const row = cfg.networks.find(n => n.id === net.id)?.members.find(m => m.instanceId === member.instanceId);
  if (row && !row.versionCheckedAt) { row.versionCheckedAt = new Date().toISOString(); saveConfigSoon(cfg); }
  saidTooOld(`${net.id}\u0000${member.instanceId}`, () => log.warn(
    `Sync with ${peerText(member.label ?? member.instanceId)} in network '${peerText(net.label)}': the peer does not page by position (pre-6.0), so its turn was `
    + 'ended and nothing was exchanged with it. It is shown as too old; upgrade it to this release.'));
}

/**
 * Move a member's two counters, as `outcome` says, and persist them: `consecutiveFailures` (the PEER failing) and `consecutiveLocalFaults` (THIS
 * instance failing with it). Hot-path bookkeeping written for every member every cycle: a coalesced write, a lost count on crash is cosmetic.
 */
function moveCounters(net: NetworkConfig, member: NetworkMember, outcome: MemberOutcome, peerAnswered: boolean): void {
  const cfg = getConfig();
  const row = cfg.networks.find(n => n.id === net.id)?.members.find(m => m.instanceId === member.instanceId);
  if (!row) return;
  const failuresBefore = row.consecutiveFailures ?? 0;
  if (outcome === 'failed') row.consecutiveFailures = failuresBefore + 1;
  // The counter measures the peer (D1 v2): a turn in which it answered resets it, whatever this instance then failed to do.
  else if (outcome === 'success' || outcome === 'catching-up' || outcome === 'records-refused' || (outcome === 'local-fault' && peerAnswered)) row.consecutiveFailures = 0;
  // The local streak resets only on a turn with no local fault (v6 S7): a page that fails to land every cycle stays visible.
  if (outcome === 'local-fault') row.consecutiveLocalFaults = (row.consecutiveLocalFaults ?? 0) + 1;
  else if (outcome !== 'interrupted') row.consecutiveLocalFaults = 0;
  saveConfigSoon(cfg);

  const failures = row.consecutiveFailures ?? 0;
  if (outcome === 'failed' && failures === STALE_FAILURE_THRESHOLD) {
    const hasChildren = net.type === 'braintree' && (member.children?.length ?? 0) > 0;
    log.warn(
      `PEER UNREACHABLE: '${peerText(member.label)}' in network '${peerText(net.label)}' has failed ` +
      `${failures} consecutive sync cycles. Last success: ${peerText(member.lastSyncAt ?? 'never')}. ` +
      'Member has NOT been removed — manual action required.' +
      (hasChildren
        ? ` NOTE: this node has ${member.children!.length} child(ren) in a braintree network — its entire subtree is now partitioned from this brain until it comes back online.`
        : ''),
    );
  } else if (outcome === 'failed' && failures > STALE_FAILURE_THRESHOLD && failures % 10 === 0) {
    log.warn(`PEER STILL UNREACHABLE: '${peerText(member.label)}' (${failures} consecutive failures, last success: ${peerText(member.lastSyncAt ?? 'never')})`);
  }
  if (outcome === 'local-fault' && row.consecutiveLocalFaults === LOCAL_FAULT_THRESHOLD) {
    log.error(`LOCAL STORE FAILING for sync with '${peerText(member.label)}' in network '${peerText(net.label)}': ${LOCAL_FAULT_THRESHOLD} turns in a row `
      + 'could not complete because of this instance\'s own database. The peer is not at fault; look at this instance\'s store.');
  }
}

/** The members not attempted once the cycle stopped: shutdown began (`interrupted`), or this instance's store stopped answering (`local-fault`). */
type Stop = { outcome: 'interrupted' | 'local-fault'; reason: string };

/** One cycle's tally: the members' results, the counts, the history's messages, and the verdict read from them. */
export class CycleOutcome {
  readonly members: MemberResult[] = [];
  readonly errorMessages: string[] = [];
  readonly pulled: SyncCounts = zeroCounts();
  readonly pushed: SyncCounts = zeroCounts();
  synced = 0;
  errors = 0;
  private storeDown = false;

  /**
   * Classify one member's turn (what it returned, or what it threw), move its counters, fold it into the cycle and return its result. The one
   * place a member's turn is read, for both doors.
   */
  member(net: NetworkConfig, member: NetworkMember, ended: MemberExchange | { thrown: unknown }): MemberResult {
    const thrown = 'thrown' in ended ? ended.thrown : undefined;
    const exchange = 'thrown' in ended ? undefined : ended;
    const outcome = classifyMemberTurn(exchange ?? thrown);
    const label = member.label ?? member.instanceId;
    let reason: string = REASONS[outcome];
    if (exchange) {
      addCounts(this.pulled, exchange.pulled); addCounts(this.pushed, exchange.pushed);
      if (exchange.storeDown) { this.storeDown = true; reason = REASONS['store-down']; }
      if (exchange.localFaults.includes(REASONS['no-token'])) reason = REASONS['no-token'];
    } else if (outcome === 'local-fault' && storeIsNotAnswering(thrown)) { this.storeDown = true; reason = REASONS['store-down']; }
    const where = `${label} (${member.instanceId})`;
    switch (outcome) {
      case 'success': case 'catching-up': case 'records-refused':
        this.synced++;
        if (exchange!.refused.length > 0) this.errorMessages.push(`${label} refused records: ${exchange!.refused.join('; ')}`);
        if (exchange!.capped.length > 0) this.errorMessages.push(`${label} is catching up: ${exchange!.capped.join('; ')}`);
        break;
      case 'peer-too-old':
        if (thrown instanceof PeerPagesBySeq) {
          noteMemberPagesBySeq(net, member);
          this.errorMessages.push(`${label} does not page by position (pre-6.0): its turn was ended and nothing was exchanged with it`);
        } else this.errorMessages.push(`${label} is below the version floor: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
        break;
      case 'local-fault': {
        this.errors++;
        const detail = exchange ? exchange.localFaults.join('; ') : (thrown instanceof Error ? thrown.message : String(thrown));
        const msg = `Sync with member ${where} did not complete because of this instance's database, not the peer: ${detail}`;
        log.warn(peerText(msg));
        this.errorMessages.push(msg);
        break;
      }
      case 'interrupted':
        this.errorMessages.push(`${label}: stopped for shutdown`);
        break;
      case 'failed': {
        this.errors++;
        // A member whose transfers were cut short moved nothing it was asked to move: an error for the cycle, a reason in the history (`Q-48`).
        const detail = exchange ? `transfer did not complete — ${exchange.incomplete.join('; ')}` : String(thrown);
        const msg = `Sync failed for member ${where}: ${detail}`;
        log.error(peerText(msg));
        this.errorMessages.push(msg);
        break;
      }
    }
    moveCounters(net, member, outcome, exchange?.peerAnswered === true);
    syncMemberOutcomesTotal.inc({ outcome });
    const result: MemberResult = { networkId: net.id, instanceId: member.instanceId, label, outcome, reason };
    this.members.push(result);
    return result;
  }

  /** Why the next member is not attempted, or null to attempt it: shutdown began, or this instance's store is not answering (v6 S6). */
  stopped(): Stop | null {
    if (isShuttingDown()) return { outcome: 'interrupted', reason: REASONS.interrupted };
    if (this.storeDown) return { outcome: 'local-fault', reason: REASONS['store-down'] };
    return null;
  }

  /** Record a member not attempted for `stop`: no counter moves, and a local fault is still counted in the cycle's errors. */
  skip(net: NetworkConfig, member: NetworkMember, stop: Stop): MemberResult {
    const label = member.label ?? member.instanceId;
    if (stop.outcome === 'local-fault') { this.errors++; this.errorMessages.push(`${label}: not attempted, ${stop.reason}`); }
    else this.errorMessages.push(`${label}: stopped for shutdown`);
    syncMemberOutcomesTotal.inc({ outcome: stop.outcome });
    const result: MemberResult = { networkId: net.id, instanceId: member.instanceId, label, outcome: stop.outcome, reason: stop.reason };
    this.members.push(result);
    return result;
  }

  /** The cycle's verdict, from its members. */
  verdict(): SyncVerdict { return syncVerdict(this.members); }

  /** Count what the cycle moved, per count key, as `stored` — every key of the family list plus `files`, so a new family is counted without an edit. */
  countItems(): void {
    for (const type of COUNT_KEYS) {
      if (this.pulled[type] > 0) syncItemsPulledTotal.inc({ type, outcome: 'stored' }, this.pulled[type]);
      if (this.pushed[type] > 0) syncItemsPushedTotal.inc({ type, outcome: 'stored' }, this.pushed[type]);
    }
  }
}
