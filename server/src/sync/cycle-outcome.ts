/**
 * What one network cycle came to, member by member, and the status it is counted under (bundle-81, design rev 8 §6).
 *
 * ## The question it answers
 *
 * "Given what each member's turn did, how was the CYCLE counted, and what does a member that was not failing but not finished say?" It sits beside the
 * engine (frozen against growth, `no-new-god-files`) and holds the three outcomes a member can have that are NOT a failure:
 *
 *  - **refused records**: the peer answered and discarded some (Q-59). The cycle is partial with the reason; the member's failure counter does not move.
 *  - **catching up**: a pull stopped at the cycle's page cap (decision 33). The member answered, its pages landed and its mark moved; the rest follows next
 *    cycle. A large D-20 re-read is this, and must never show its member as unreachable.
 *  - **too old**: the member answered in the 5.x shape (`PeerPagesBySeq`, `sync/wire-answer.ts`). Its turn ended before any file route, no mark was written,
 *    no failure is counted, the member shows "Version too old" even if it never gossiped a version (`noteMemberPagesBySeq`), and the cycle is counted
 *    `refused` when nobody else was exchanged with.
 *
 * `status()` is the one reading of the three beside errors, so a metric and the history cannot count the same cycle two ways.
 */
import { getConfig, saveConfigSoon } from '../config/loader.js';
import type { NetworkConfig, NetworkMember } from '../config/types.js';
import { BRAIN_COLLECTIONS } from '../config/types.js';
import { syncItemsPulledTotal, syncItemsPushedTotal } from '../metrics/registry.js';
import { PeerPagesBySeq } from '../util/errors.js';
import { log, peerText } from '../util/log.js';
import { warnOnce } from '../util/warn-once.js';
import { SKIP_WARNING_WINDOW_MS } from '../util/single-flight.js';
import type { MemberExchange } from './space-exchange.js';
import type { SyncCounts } from './history.js';

/** How a cycle is counted: `ythril_sync_cycles_total{status}`. The history keeps three of them (`refused` is recorded as `failed`, nothing was exchanged). */
export type CycleStatus = 'success' | 'partial' | 'failed' | 'refused';

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

export class CycleOutcome {
  private refusals = 0;
  private catchingUp = 0;
  private tooOld = 0;

  /** Fold a member whose turn ended without a failure: what it refused and what it is still catching up on, as messages for the history. */
  fold(member: NetworkMember, counts: Pick<MemberExchange, 'refused' | 'capped'>, errorMessages: string[]): void {
    if (counts.refused.length > 0) { this.refusals++; errorMessages.push(`${member.label} refused records: ${counts.refused.join('; ')}`); }
    if (counts.capped.length > 0) { this.catchingUp++; errorMessages.push(`${member.label} is catching up: ${counts.capped.join('; ')}`); }
  }

  /** A member's turn ended with `err`: true when it was the 5.x refusal (handled here, no failure to count), false for any other error. */
  foldRefusal(err: unknown, net: NetworkConfig, member: NetworkMember, errorMessages: string[]): boolean {
    if (!(err instanceof PeerPagesBySeq)) return false;
    this.tooOld++;
    noteMemberPagesBySeq(net, member);
    errorMessages.push(`${member.label} does not page by position (pre-6.0): its turn was ended and nothing was exchanged with it`);
    return true;
  }

  /** The cycle's status: a failure or a refusal of records beats a catch-up, which beats a member too old, which beats success. */
  status(synced: number, errors: number, members: number): CycleStatus {
    if (errors > 0 || this.refusals > 0 || this.catchingUp > 0) return synced === 0 && members > 0 ? 'failed' : 'partial';
    if (this.tooOld > 0) return synced === 0 ? 'refused' : 'partial';
    return 'success';
  }

  /** Count what the cycle moved, per collection, as `stored` — every knowledge collection, so a new one is counted without an edit. */
  countItems(pulled: SyncCounts, pushed: SyncCounts): void {
    for (const type of BRAIN_COLLECTIONS) {
      if (pulled[type] > 0) syncItemsPulledTotal.inc({ type, outcome: 'stored' }, pulled[type]);
      if (pushed[type] > 0) syncItemsPushedTotal.inc({ type, outcome: 'stored' }, pushed[type]);
    }
  }
}
