/**
 * Write one per-space mark onto a peer's member rows — the one place a `spaceId -> value` map on a network member is
 * folded forward.
 *
 * ## What it answers
 *
 * *"Record this fact about this peer and this space on every network that carries the space."* Three marks are written
 * that way: how far a peer has been served our tombstones (`lastSeqServed`), which file deletions it acknowledged
 * (`lastFileTombstoneAckedAt`), and where the one-time re-read of an upstream's tombstones stands (`tombstoneRereadAt`).
 * Each had its own copy of the loop — find the networks that carry the space, find the member, fold, create the map on
 * first write — and the fold is the only thing that differs.
 *
 * ## What it prevents
 *
 * The part a hand-written copy drops. A peer can be a member of several networks that carry one space, and the loop must
 * visit every one of them, not stop at the first; the map must be created only when there IS something to write, so a
 * refused value leaves no empty `{}` behind to be saved; and the fold returns `null` for "nothing to write", so a
 * caller never saves the config for a no-op on a hot path. A caller that wrote its own loop would get one of those
 * wrong without anything failing.
 *
 * Mutates `cfg` in place and takes no `await`, so it cannot be holding a detached reference across a reload (the
 * mechanism behind #346/#348/#353/#604).
 */
import { getConfig, saveConfig } from '../config/loader.js';
import type { Config, NetworkConfig, NetworkMember } from '../config/types.js';
import { PER_SPACE_WATERMARKS } from '../config/types-networks.js';

/** The member fields this writes: exactly the per-space maps `PER_SPACE_WATERMARKS` lists. */
export type MemberSpaceMarkKey = (typeof PER_SPACE_WATERMARKS)[number];

/** What one mark holds for one space. */
export type MemberSpaceMark<K extends MemberSpaceMarkKey> = NonNullable<NetworkMember[K]>[string];

/**
 * Fold `key` for `peerInstanceId` and `spaceId` on every member row of every network carrying the space.
 *
 * @param fold the current value (or `undefined`) to the next one, `null` when nothing should be written, or `undefined`
 *   to REMOVE the space's entry — a mark that is no longer owed is absent, never an empty or sentinel value
 * @returns whether any row changed
 */
export function setMemberSpaceMark<K extends MemberSpaceMarkKey>(
  cfg: Config,
  peerInstanceId: string | undefined,
  spaceId: string,
  key: K,
  fold: (current: MemberSpaceMark<K> | undefined) => MemberSpaceMark<K> | null | undefined,
): boolean {
  if (!peerInstanceId) return false;
  let changed = false;
  for (const net of cfg.networks ?? []) {
    if (!net.spaces?.includes(spaceId)) continue;
    const m = net.members?.find(x => x.instanceId === peerInstanceId);
    if (!m) continue;
    const marks = m[key] as Record<string, MemberSpaceMark<K>> | undefined;
    const next = fold(marks?.[spaceId]);
    if (next === null) continue;
    if (next === undefined) {
      if (marks && spaceId in marks) { delete marks[spaceId]; changed = true; }
      continue;
    }
    const target = (marks ?? ((m as unknown as Record<string, unknown>)[key] = {})) as Record<string, MemberSpaceMark<K>>;
    target[spaceId] = next;
    changed = true;
  }
  return changed;
}

/**
 * The value `key` holds for `peerInstanceId` and `spaceId` on `networkId`'s member row, read from the LIVE config — so a
 * driver deciding what to do next reads what the last fold wrote, not a copy taken before an await.
 */
export function readMemberSpaceMark<K extends MemberSpaceMarkKey>(
  networkId: string,
  peerInstanceId: string,
  spaceId: string,
  key: K,
): MemberSpaceMark<K> | undefined {
  const m = getConfig().networks.find(n => n.id === networkId)?.members.find(x => x.instanceId === peerInstanceId);
  return (m?.[key] as Record<string, MemberSpaceMark<K>> | undefined)?.[spaceId];
}

/**
 * Move a repair's state forward on the LIVE config with a pure transition, and save once — only when a row changed, so
 * a no-op on a hot path writes nothing. `next` returning `undefined` removes the entry.
 *
 * Both re-read marks went through a hand-written copy of this (read the live config, fold, save if changed); the
 * second is what made it a module.
 *
 * @returns the state before and after on the first row visited, so a caller can say a transition exactly once
 */
export function foldRepairMark(
  peerInstanceId: string,
  spaceId: string,
  key: 'tombstoneRereadAt' | 'fileMetaRereadAt',
  next: (current: string | undefined) => string | undefined,
): { before: string | undefined; after: string | undefined } | null {
  const cfg = getConfig();
  let seen: { before: string | undefined; after: string | undefined } | null = null;
  const changed = setMemberSpaceMark(cfg, peerInstanceId, spaceId, key, (current) => {
    const after = next(current);
    seen ??= { before: current, after };
    return after === current ? null : after;
  });
  if (changed) saveConfig(cfg);
  return seen;
}

/**
 * Every member's marks for `localSpaceId` on `net`, ALL of `PER_SPACE_WATERMARKS` — one loop for the two questions below, so a mark
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
 * Carry every member's marks on `net` from `oldId` to `newId` — a rename moves the space, and a mark left at the old id would read as
 * "unknown" (a re-pull from 0, a stopped tombstone prune). Mutates `net` in place.
 */
export function moveReceiveMarks(net: NetworkConfig, oldId: string, newId: string): void {
  eachMemberMarkOf(net, oldId, (marks) => {
    marks[newId] = marks[oldId];
    delete marks[oldId];
  });
}
