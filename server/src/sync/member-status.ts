/**
 * When did this member last complete an exchange with us, written in the one way the re-upgrade detector can read (bundle-81, design rev 8 §3 "Re-upgrade").
 *
 * ## The question it answers
 *
 * *"Record that an exchange with this member just completed."* `stampLastSync(member, at)` sets `lastSyncAt` and `lastSyncAtBy6` to the SAME instant.
 * A 5.6 build writes `lastSyncAt` alone and has never heard of `lastSyncAtBy6`, so a member whose two stamps differ was synced by a 5.6 build since this build
 * last did: it may have replaced rows without moving a counter, and the detector marks every space of that member's networks for a repair.
 *
 * ## What it prevents
 *
 * A 6.0 writer that wrote `lastSyncAt` alone would make every healthy member look as though 5.6 had been running, and every space would be repaired on
 * every boot (a full pass over every row, the space answering `positions_building` meanwhile). The announce door is the writer a 5.6 build also has, so it is
 * the one most likely to be forgotten. `every-last-sync-writer-stamps-both-db` derives every writer of `lastSyncAt` and allows this module, a named read and
 * the invite's clear (which clears both).
 */
import type { NetworkMember } from '../config/types.js';

/**
 * Stamp both fields of `member` with `at` (an ISO instant). Mutates and returns the member; touches no other field. The caller saves.
 */
export function stampLastSync<M extends Pick<NetworkMember, 'lastSyncAt' | 'lastSyncAtBy6'>>(member: M, at: string = new Date().toISOString()): M {
  member.lastSyncAt = at;
  member.lastSyncAtBy6 = at;
  return member;
}

/**
 * Does this member read as synced by a 5.6 build since 6.0 last stamped it? `lastSyncAt` present and different from `lastSyncAtBy6` (which is absent when 6.0
 * never stamped it: the first carry stamps every member that was synced, so an absent `lastSyncAtBy6` on a member that has a `lastSyncAt` is a 5.6 sync of a
 * member 6.0 never synced with). A member that was never synced is not tripped.
 */
export function syncedBy56(member: Pick<NetworkMember, 'lastSyncAt' | 'lastSyncAtBy6'>): boolean {
  return member.lastSyncAt !== undefined && member.lastSyncAt !== member.lastSyncAtBy6;
}
