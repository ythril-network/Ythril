/**
 * How far each peer has been served — the missing half of the sync watermarks.
 *
 * `NetworkMember.lastSeqReceived` and `.lastSeqPushed` record OUR position in a peer's data. Nothing
 * recorded the position a peer reached in OURS: every pull handler reads `sinceSeq` off the query string and
 * throws it away. That one missing write is why tombstones could never be pruned.
 *
 * ── Why a served watermark and not a retention window ────────────────────────────────────────────────────
 *
 * Tombstones are served by `seq > sinceSeq` (see `brain/tombstones.ts` and `GET /api/sync/tombstones`), so a
 * peer that was away resumes from its own watermark and pulls every tombstone above it. Age has nothing to
 * do with it. Delete a tombstone by age and a peer offline longer than the window comes back, never sees the
 * deletion, and pushes its live copy — turning a retention fix into "deleted records keep coming back",
 * weeks later, with no way to tell where the record came from.
 *
 * A floor built from what peers have actually been served makes that impossible by construction rather than
 * unlikely: below the floor, every peer has already applied the deletion.
 *
 * ── Everything here fails towards KEEPING ────────────────────────────────────────────────────────────────
 *
 * The asymmetry is the whole design. Keeping a tombstone too long costs a few hundred bytes; dropping one too
 * early resurrects a deleted record. So every unknown resolves to "do not prune", and the reasons are
 * enumerated rather than defaulted, so a caller can log WHY nothing happened.
 */
import { getConfig, saveConfigSoon } from '../config/loader.js';
import { reachesSpace } from '../auth/space-reach.js';
import type { Config, NetworkMember } from '../config/types.js';
import { setMemberSpaceMark } from './member-space-mark.js';

/** The subset of a member this decision needs — so the pure part is testable without a config. */
export interface ServedMember {
  instanceId: string;
  label?: string;
  lastSeqServed?: Record<string, number>;
}

export type TombstoneFloor =
  /** Safe to delete tombstones with `seq <= upTo`. */
  | { prune: true; upTo: number; peers: number }
  /** Not safe. `reason` is for the log; `blockedBy` names the member when one is at fault. */
  | { prune: false; reason: 'member-never-pulled' | 'peer-token-scoped' | 'floor-at-zero'; blockedBy?: string };

/**
 * Peer instance ids that can reach `spaceId` through a token rather than a member entry.
 *
 * `spaceAllowed` has a documented fallback: a peer we do not list as a member — a manually provisioned peer
 * token, or an asymmetric network whose config only the other side holds — is authorised by plain token
 * space-scope. Such a peer pulls tombstones and has no member record to write a watermark to, so its
 * existence must block pruning entirely.
 *
 * **`TokenRecord.spaces` omitted means ALL spaces**, so one unscoped peer token makes every space
 * unprunable. That is the correct reading of the config, not an oversight: we cannot prove where an
 * unscoped token has been.
 */
export function peerTokensReaching(cfg: Config, spaceId: string): string[] {
  return (cfg.tokens ?? [])
    .filter(t => typeof t.peerInstanceId === 'string' && t.peerInstanceId !== '')
    /*
     * The matrix, and only the matrix. This read the legacy allowlist ALONE once, which is `undefined` on
     * every token minted since 2.9 — so every peer token counted as reaching every space and the watermark
     * was computed against peers that could not see it. The fix put the matrix first and kept the allowlist
     * as a fallback; 4.0 drops the fallback, because every stored token has a matrix (`createToken` writes
     * one and the boot backfill derives one in memory for anything older) and the fallback's absent-means-
     * unrestricted rule was the same fail-open that produced the original defect.
     */
    .filter(t => (t.rights ? reachesSpace(t.rights, spaceId) : false))
    .map(t => t.peerInstanceId as string);
}

/** Members of every network that carries this space, deduplicated by instance id. */
export function membersServing(cfg: Config, spaceId: string): NetworkMember[] {
  const seen = new Map<string, NetworkMember>();
  for (const net of cfg.networks ?? []) {
    if (!net.spaces?.includes(spaceId)) continue;
    for (const m of net.members ?? []) {
      if (!seen.has(m.instanceId)) seen.set(m.instanceId, m);
    }
  }
  return [...seen.values()];
}

/**
 * The peers in `peerTokenIds` that are not among `members` — a peer that can reach the space through a token and has no
 * member row to record anything on. The one spelling of "a peer outside the membership", asked by both retention floors
 * (a stranger blocks pruning: nothing it has seen is knowable) and by the upstream stamp's back-fill (a stranger is a
 * second route a record could have arrived by).
 */
export function peersOutside(members: ReadonlyArray<{ instanceId: string }>, peerTokenIds: readonly string[]): string[] {
  const known = new Set(members.map(m => m.instanceId));
  return peerTokenIds.filter(id => !known.has(id));
}

/** The peers that reach `spaceId` ONLY by a token: `peerTokensReaching` less every member of a network carrying it. */
export function peersReachingOnlyByToken(cfg: Config, spaceId: string): string[] {
  return peersOutside(membersServing(cfg, spaceId), peerTokensReaching(cfg, spaceId));
}

/**
 * The highest seq every peer has provably been served for this space.
 *
 * Pure in `members` and `peerTokenIds` so each branch is checkable without a database or a config file — and
 * these branches are where the data loss would be, not in the delete itself.
 *
 * `direction` is deliberately NOT used to exclude a member. It governs what WE do outbound; it does not stop
 * a peer from issuing a GET. So a `push`-only member still counts, and a network of them never prunes. That
 * is the safe direction of the trade, and the caller logs which member holds the floor down so it is
 * diagnosable rather than mysterious.
 */
export function tombstoneFloor(
  members: ServedMember[],
  spaceId: string,
  peerTokenIds: string[] = [],
): TombstoneFloor {
  const stranger = peersOutside(members, peerTokenIds)[0];
  if (stranger !== undefined) {
    // A peer that can read us but has nowhere to record a watermark. Nothing it has seen is knowable.
    return { prune: false, reason: 'peer-token-scoped', blockedBy: stranger };
  }

  if (members.length === 0) {
    // No members and no peer tokens: nobody can pull tombstones from this space, so none of them are
    // carrying information for anyone. This is the single-instance install — the common case, and the
    // largest win.
    return { prune: true, upTo: Number.MAX_SAFE_INTEGER, peers: 0 };
  }

  let floor = Number.MAX_SAFE_INTEGER;
  for (const m of members) {
    const served = m.lastSeqServed?.[spaceId];
    if (typeof served !== 'number' || !Number.isFinite(served)) {
      return { prune: false, reason: 'member-never-pulled', blockedBy: m.label ?? m.instanceId };
    }
    if (served < floor) floor = served;
  }

  // A floor of zero says the least-advanced peer has confirmed nothing. Nothing to do, and reporting it as
  // a prune of `seq <= 0` would be a lie in the log.
  if (floor <= 0) return { prune: false, reason: 'floor-at-zero' };

  return { prune: true, upTo: floor, peers: members.length };
}

/** Read the config and answer for one space. Thin wrapper so callers do not assemble the inputs twice. */
export function tombstoneFloorForSpace(cfg: Config, spaceId: string): TombstoneFloor {
  return tombstoneFloor(membersServing(cfg, spaceId), spaceId, peerTokensReaching(cfg, spaceId));
}

/**
 * Fold a newly observed `sinceSeq` into a member's served watermark.
 *
 * Monotonic by `Math.max`: a peer may legitimately re-request from an older position (a retry, a restarted
 * pull, a peer that lost its own watermark), and taking that at face value would drop the floor and re-serve
 * tombstones we had already dropped. It also must never move on a malformed value — `sinceSeq` arrives as a
 * query-string integer from a remote caller, and `parseInt('abc')` is `NaN`, which compares false against
 * everything and would otherwise poison the record.
 *
 * Returns the new value, or `null` when nothing should be written — so the caller can skip the config save
 * entirely on the overwhelmingly common no-change path.
 */
export function foldServedSeq(current: number | undefined, observed: number): number | null {
  if (!Number.isFinite(observed) || !Number.isInteger(observed) || observed <= 0) return null;
  if (current !== undefined && Number.isFinite(current) && current >= observed) return null;
  return observed;
}

/**
 * Record that `peerInstanceId` has pulled our tombstones for `spaceId` from `sinceSeq`.
 *
 * Called from the tombstone pull handler on the hot path, so it is deliberately cheap and silent: it writes
 * only when the value actually moves, and it uses the same coalesced `saveConfigSoon` as the pull watermark
 * one layer up. Losing the write on a crash costs a prune cycle, never a tombstone.
 *
 * A caller with no peer identity (an admin token, the UI, a manual curl) records nothing. It has no member
 * entry to write to, and treating a local read as a peer having caught up is exactly the mistake that would
 * drop tombstones a real peer still needs.
 */
export function recordServedSeq(
  peerInstanceId: string | undefined,
  spaceId: string,
  sinceSeq: number,
): void {
  let cfg: Config;
  try { cfg = getConfig(); } catch { return; }   // pre-setup
  if (applyServedSeq(cfg, peerInstanceId, spaceId, sinceSeq)) saveConfigSoon(cfg);
}

/**
 * Write the watermark into a config object; returns whether anything changed.
 *
 * Separated from the config read and the save so the decision is testable against a plain object — the branches
 * that matter (an unknown peer, a network that does not carry the space, a value that must not move) are all
 * here, and none of them needs a config file or a running instance.
 *
 * Mutates `cfg` in place, and takes no `await`, so it cannot be holding a detached reference across a reload
 * (the mechanism behind #346/#348/#353/#604) — `setMemberSpaceMark` is the loop, shared with the other per-space marks.
 */
export function applyServedSeq(
  cfg: Config,
  peerInstanceId: string | undefined,
  spaceId: string,
  sinceSeq: number,
): boolean {
  return setMemberSpaceMark(cfg, peerInstanceId, spaceId, 'lastSeqServed', current => foldServedSeq(current, sinceSeq));
}
