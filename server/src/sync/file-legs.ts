/**
 * Whether a member's file leg was COMPLETE — the evidence the absent-bytes sweep asks before it removes the record of a file whose bytes this
 * instance lost (bundle-70, Q-337).
 *
 * ## The question it answers
 *
 * *"Since this record's bytes were found gone, has every member we pull this space from shown us its whole manifest, and did we take everything it
 * offered?"* File sync fetches any file this side lacks (`sync/file-conflict.ts`, `decideFilePull`), so a member that held the bytes and whose leg
 * refused nothing would have delivered them. A leg that refused or deferred anything (a quota refusal, a fetch that failed, a path it left alone,
 * an entry outside the space, a turn stopped part way) proves nothing about the paths it did not reach, and is not evidence.
 *
 * ## One accumulator, fed by every exit
 *
 * `syncFiles` makes ONE {@link FileLegAccumulator} per leg and every way the pull can leave a file undone feeds it its class ({@link LEG_EXITS}).
 * The record is written at the end only when the accumulator is EMPTY and the peer's manifest was read: a new exit added to `syncFiles` that forgot
 * to feed it would make an incomplete leg evidence, so the source gate `the-file-leg-record-is-fed-by-every-exit` holds `syncFiles` to name every
 * class here.
 *
 * ## What a record says, and what it does not
 *
 * The time OUR read of the peer's manifest happened (evidence only for a stamp older than it), whether the peer's manifest carried the `unreadable`
 * field at all (a peer of an older release omits a file it could not hash in silence, so its leg is no evidence), the paths it named unreadable
 * (no evidence for those, or below them) and whether its list was cut (then no evidence for any path).
 *
 * **In memory only**, per space and member: a restart forgets every record, which only delays removals until fresh legs complete; a record cannot
 * fail a leg, and no config write happens per cycle.
 */
import type { PeerUnreadable } from '../files/unreadable-paths.js';

/** Every way a pull leg can leave something undone. Each is a reason the leg proves nothing. */
export const LEG_EXITS = [
  'not_pulled',        // the leg does not pull from this member (push only)
  'turn_stopped',      // the space's turn ended before the leg did (an act registered, shutdown)
  'manifest_refused',  // the peer's manifest could not be read
  'outside',           // an entry of the peer's manifest names a path outside the space
  'unreadable_here',   // a path this side could not look at was left alone
  'not_now',           // an arrival a held or undecided tombstone shadows, asked again next cycle
  'quota',             // the space quota refused a file
  'repair_budget',     // a repair was owed past the cycle's budget
  'pull_failed',       // a file's fetch, write or record failed
  'failed',            // the leg failed as a whole
] as const;
export type LegExit = typeof LEG_EXITS[number];

/** The evidence of the last complete leg of a member for a space. */
export interface FileLegEvidence {
  /** When our read of the member's manifest happened, epoch ms. */
  manifestReadAt: number;
  /** The member's manifest carried the `unreadable` field (a peer of this release or later). */
  carriesUnreadable: boolean;
  /** What the member named unreadable, resolved to our keys. */
  unreadable: PeerUnreadable;
}

const legs = new Map<string, FileLegEvidence>();
const keyOf = (spaceId: string, memberId: string): string => `${spaceId}\0${memberId}`;

/** The last complete leg of `memberId` for `spaceId`, if one completed since this process started. */
export function lastCompleteFileLeg(spaceId: string, memberId: string): FileLegEvidence | undefined {
  return legs.get(keyOf(spaceId, memberId));
}

/** Forget every leg (a test seam; also what a restart does). */
export function forgetFileLegs(): void { legs.clear(); }

/** One leg of `syncFiles`: told what the manifest said and every way the leg left something undone; records at {@link end} only if nothing was. */
export class FileLegAccumulator {
  private readonly exits = new Set<LegExit>();
  private manifest: FileLegEvidence | undefined;

  constructor(private readonly spaceId: string, private readonly memberId: string) {}

  /** The peer's manifest was read at `at`; `answer` is its body (whether it carries `unreadable` at all), `unreadable` what it named. */
  manifestRead(at: number, answer: { unreadable?: unknown }, unreadable: PeerUnreadable): void {
    this.manifest = { manifestReadAt: at, carriesUnreadable: Array.isArray(answer.unreadable), unreadable };
  }

  /** The leg left something undone, for this reason. */
  refused(exit: LegExit): void { this.exits.add(exit); }

  /** What the leg left undone so far, by class. */
  get refusals(): ReadonlySet<LegExit> { return this.exits; }

  /** Close the leg: record it when the manifest was read and nothing was left undone. Answers whether it was recorded. */
  end(): boolean {
    if (this.manifest === undefined || this.exits.size > 0) return false;
    legs.set(keyOf(this.spaceId, this.memberId), this.manifest);
    return true;
  }
}
