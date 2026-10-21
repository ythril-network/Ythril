/**
 * What a network's members were marked for one space, forgotten or carried (the pure half of `sync/member-space-mark.ts`).
 *
 * A leaf, so `networks/take-space-out-of-network.ts` (which the config loader's proxy migration reaches) can forget a space's receive
 * marks without importing the config loader: `member-space-mark.ts` reads and saves the config and re-exports these.
 */
import type { NetworkConfig } from '../config/types.js';
import { PER_SPACE_WATERMARKS } from '../config/types-networks.js';

/**
 * Every member's marks for `localSpaceId` on `net`, ALL of `PER_SPACE_WATERMARKS` - one loop for the two questions below, so a mark
 * added to the list is forgotten and carried alike (a list per caller was how a fifth mark would be missed by one of them).
 */
function eachMemberMarkOf(net: NetworkConfig, localSpaceId: string, visit: (marks: Record<string, unknown>) => void): void {
  for (const member of net.members ?? []) {
    for (const key of PER_SPACE_WATERMARKS) {
      const marks = member[key] as Record<string, unknown> | undefined;
      if (marks && marks[localSpaceId] !== undefined) visit(marks);
    }
  }
}

/**
 * Forget what every member of `net` was marked for `localSpaceId`: the space was wiped or left, so the next exchange reads it from the
 * start. Marks are per SPACE, never per family (one position covers every family), so a wipe of any types forgets all of them.
 * Mutates `net` in place; the caller saves, in the same write as whatever made the marks wrong.
 */
export function forgetReceiveMarks(net: NetworkConfig, localSpaceId: string): void {
  eachMemberMarkOf(net, localSpaceId, (marks) => { delete marks[localSpaceId]; });
}

/**
 * Carry every member's marks on `net` from `oldId` to `newId` - a rename moves the space, and a mark left at the old id would read as
 * "unknown" (a re-pull from 0, a stopped tombstone prune). Mutates `net` in place.
 */
export function moveReceiveMarks(net: NetworkConfig, oldId: string, newId: string): void {
  eachMemberMarkOf(net, oldId, (marks) => {
    marks[newId] = marks[oldId];
    delete marks[oldId];
  });
}
