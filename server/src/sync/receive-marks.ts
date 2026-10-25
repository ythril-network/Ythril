/**
 * What a network's members were marked for one space, forgotten or carried (the pure half of `sync/member-space-mark.ts`).
 *
 * A leaf, so `networks/take-space-out-of-network.ts` (which the config loader's proxy migration reaches) can forget a space's marks
 * without importing the config loader.
 *
 * ## One loop, and who it visits
 *
 * Every question here walks the marks through {@link eachMemberMarkOf}, and so does the counter-wipe recovery (`util/seq.ts`). A second
 * loop over the same maps is a second set of members to miss: the shared loop once visited `members` only, while the recovery walked
 * `pendingRounds[].pendingMember` by hand, so a wipe forgot every member's marks and left the ones a join round in flight carries - and
 * that member joins holding a position in numbers about to be reused. `one-mark-loop` holds every walker of the mark set to this one.
 */
import type { NetworkConfig, NetworkMember } from '../config/types.js';
import { PER_SPACE_WATERMARKS, RECEIVE_MARKS, ROLLBACK_MARKS, POSITION_TWIN, type PerSpaceWatermark } from '../config/types-networks.js';


/**
 * Visit every mark map of every member `net` holds, the members AND the member each join round in flight carries, for the marks in
 * `which` (all of `PER_SPACE_WATERMARKS` by default). `localSpaceId`: only the maps that hold a mark for that space; `null`: every map
 * that holds any mark. `visit` is handed the map itself (mutate it in place), the mark's name and who carries it (an instance id, or
 * `pendingMember`). The caller saves.
 */
export function eachMemberMarkOf(
  net: NetworkConfig,
  localSpaceId: string | null,
  visit: (marks: Record<string, unknown>, mark: PerSpaceWatermark, who: string, member: NetworkMember) => void,
  which: readonly PerSpaceWatermark[] = PER_SPACE_WATERMARKS,
): void {
  const carriers: [NetworkMember, string][] = (net.members ?? []).map(m => [m, m.instanceId]);
  for (const round of net.pendingRounds ?? []) if (round.pendingMember) carriers.push([round.pendingMember, 'pendingMember']);
  for (const [member, who] of carriers) {
    for (const key of which) {
      const marks = member[key] as Record<string, unknown> | undefined;
      if (!marks || typeof marks !== 'object') continue;
      if (localSpaceId === null ? Object.keys(marks).length > 0 : marks[localSpaceId] !== undefined) visit(marks, key, who, member);
    }
  }
}

/**
 * Forget EVERY mark each member of `net` holds for `localSpaceId`: the space was wiped or left, so the next exchange reads it from the
 * start. Marks are per SPACE, never per family (one position covers every family), so a wipe of any types forgets all of them. Mutates
 * `net` in place; the caller saves, in the same write as whatever made the marks wrong.
 */
export function forgetEveryMark(net: NetworkConfig, localSpaceId: string): void {
  eachMemberMarkOf(net, localSpaceId, (marks) => { delete marks[localSpaceId]; });
}

/**
 * Forget only what this instance RECEIVED for `localSpaceId` (`RECEIVE_MARKS`): a restore went back to an older snapshot, so the peers
 * send again what arrived after it, while what this instance sent and what its peers acknowledged (`KEPT_ON_RESTORE`) stays true.
 * Mutates `net` in place; the caller saves.
 */
export function forgetWhatWasReceived(net: NetworkConfig, localSpaceId: string): void {
  eachMemberMarkOf(net, localSpaceId, (marks) => { delete marks[localSpaceId]; }, RECEIVE_MARKS);
}

/**
 * The first carry's marks (bundle-81, design rev 8 §3a): every frozen 5.6 mark (`ROLLBACK_MARKS`) becomes its 6.0 twin by IDENTITY, for each member and space
 * where the twin is absent. A legacy row's position is its seq, so `{pos <= m}` is the set `{seq <= m}` was, ties included, and the first 6.0 cycle offers what
 * 5.6's next would have. The frozen keys are left exactly as they are: a 5.6 started after a rollback finds its own marks. A twin that exists is never
 * overwritten (it is 6.0's own, and a re-run must not move it back). Mutates `net`; the caller saves. Answers how many marks it carried.
 */
export function carryMarksToPositions(net: NetworkConfig): number {
  let carried = 0;
  // Through the one loop over the member marks, which hands the carrier too: a second walk over the members and the join rounds' candidates is a second set to miss.
  eachMemberMarkOf(net, null, (marks, frozen, _who, member) => {
    const twin = POSITION_TWIN[frozen as (typeof ROLLBACK_MARKS)[number]];
    for (const [spaceId, value] of Object.entries(marks)) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) continue;
      const to = (member[twin] ??= {}) as Record<string, number>;
      if (to[spaceId] !== undefined) continue;
      to[spaceId] = value;
      carried++;
    }
  }, ROLLBACK_MARKS);
  return carried;
}

/**
 * Carry every mark each member of `net` holds from `oldId` to `newId` - a rename moves the space, and a mark left at the old id would read
 * as "unknown" (a re-pull from 0, a stopped tombstone prune). Mutates `net` in place.
 */
export function moveEveryMark(net: NetworkConfig, oldId: string, newId: string): void {
  eachMemberMarkOf(net, oldId, (marks) => {
    marks[newId] = marks[oldId];
    delete marks[oldId];
  });
}
