/**
 * What a network card says about re-reads: who still owes one, and whether this instance may start one (bundle-81, decision 39).
 *
 * `rereadOwed` is the administrator's view of the owed marker, one entry per member and space. Its readers (the member row's pill, the
 * header's pill, the Re-read section's lists) ask these functions, so "which member owes what" is read from the view one way. Absent
 * `rereadOwed` means the view is not an administrator's, and nothing here turns that into "none owed".
 */
import type { Network, RereadOwedEntry } from '../../core/api.types';

export type RereadState = RereadOwedEntry['state'];

/** The network's owed re-reads grouped by member, each member's spaces in the order the view listed them. */
export function rereadByMember(net: Pick<Network, 'rereadOwed'>): Map<string, RereadOwedEntry[]> {
  const byMember = new Map<string, RereadOwedEntry[]>();
  for (const entry of net.rereadOwed ?? []) byMember.set(entry.instanceId, [...(byMember.get(entry.instanceId) ?? []), entry]);
  return byMember;
}

/** What a member's row says: `catching` while one of its spaces is being read now, `owed` while spaces are still to come, null when nothing is owed. */
export function memberRereadState(entries: readonly RereadOwedEntry[] | undefined): RereadState | null {
  if (!entries?.length) return null;
  return entries.some(e => e.state === 'catching') ? 'catching' : 'owed';
}

/** The state of one member on this network, for the member row. */
export function rereadStateOf(net: Pick<Network, 'rereadOwed'>, instanceId: string): RereadState | null {
  return memberRereadState(rereadByMember(net).get(instanceId));
}

/** How many members still owe a re-read, for the card's header. */
export function rereadOwedMembers(net: Pick<Network, 'rereadOwed'>): number {
  return rereadByMember(net).size;
}

/**
 * Whether this view is an instance administrator's: the owed re-reads and the owed space acts are served to administrators only, so the
 * re-read control is offered where either arrives. A reader is not refused by hiding it; the route refuses a non-admin.
 */
export function isAdministeredView(net: Pick<Network, 'rereadOwed' | 'owedSpaceActs' | 'spaceRecordCounts'>): boolean {
  return net.rereadOwed !== undefined || net.owedSpaceActs !== undefined || net.spaceRecordCounts !== undefined;
}
