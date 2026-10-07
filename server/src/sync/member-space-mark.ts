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
import type { Config, NetworkMember } from '../config/types.js';
import type { PER_SPACE_WATERMARKS } from '../config/types-networks.js';

/** The member fields this writes: exactly the per-space maps `PER_SPACE_WATERMARKS` lists. */
export type MemberSpaceMarkKey = (typeof PER_SPACE_WATERMARKS)[number];

/** What one mark holds for one space. */
export type MemberSpaceMark<K extends MemberSpaceMarkKey> = NonNullable<NetworkMember[K]>[string];

/**
 * Fold `key` for `peerInstanceId` and `spaceId` on every member row of every network carrying the space.
 *
 * @param fold the current value (or `undefined`) to the next one, or `null` when nothing should be written
 * @returns whether any row changed
 */
export function setMemberSpaceMark<K extends MemberSpaceMarkKey>(
  cfg: Config,
  peerInstanceId: string | undefined,
  spaceId: string,
  key: K,
  fold: (current: MemberSpaceMark<K> | undefined) => MemberSpaceMark<K> | null,
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
    const target = (marks ?? ((m as unknown as Record<string, unknown>)[key] = {})) as Record<string, MemberSpaceMark<K>>;
    target[spaceId] = next;
    changed = true;
  }
  return changed;
}
