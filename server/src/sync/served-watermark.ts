/**
 * How far each peer has been served — the missing half of the sync watermarks.
 *
 * `NetworkMember.lastPosReceived` and `.lastPosPushed` record OUR position in a peer's data. Nothing
 * recorded the position a peer reached in OURS: every pull handler reads where the puller starts off the query string and
 * throws it away. That one missing write is why tombstones could never be pruned. 6.0 records it as `lastPosServed`, in the position
 * stream tombstones share with the records.
 *
 * ── Why a served watermark and not a retention window ────────────────────────────────────────────────────
 *
 * Tombstones are served by position (see `brain/tombstones.ts` and `GET /api/sync/tombstones`), so a
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
import { settledPositionCap } from '../util/position-clock.js';
import { recordPositions } from './record-position-stream.js';

/** The subset of a member this decision needs — so the pure part is testable without a config. */
export interface ServedMember {
  instanceId: string;
  label?: string;
  lastPosServed?: Record<string, number>;
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
 * Does this instance serve `spaceId` to any peer OTHER than `except` — a member of a network carrying it, or a peer that
 * reaches it by a token alone? The one answer to "is there anyone to pass a relayed deletion on to": a file tombstone's
 * path is often personal, so an instance with nobody downstream applies a relayed one and does not keep the name of the file.
 */
export function servesOnward(cfg: Config, spaceId: string, except?: string): boolean {
  const members = membersServing(cfg, spaceId);
  return members.some(m => m.instanceId !== except) || peersOutside(members, peerTokensReaching(cfg, spaceId)).some(id => id !== except);
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
    const served = m.lastPosServed?.[spaceId];
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
 * Fold a newly observed position into a member's served mark.
 *
 * Monotonic by `Math.max`: a peer may legitimately re-request from an older position (a retry, a restarted
 * pull, a peer that lost its own watermark), and taking that at face value would drop the floor and re-serve
 * tombstones we had already dropped. It also must never move on a malformed value — the position arrives as a
 * query-string integer from a remote caller, and `parseInt('abc')` is `NaN`, which compares false against
 * everything and would otherwise poison the record.
 *
 * Returns the new value, or `null` when nothing should be written — so the caller can skip the config save
 * entirely on the overwhelmingly common no-change path.
 */
export function foldServedPosition(current: number | undefined, observed: number): number | null {
  if (!Number.isFinite(observed) || !Number.isInteger(observed) || observed <= 0) return null;
  if (current !== undefined && Number.isFinite(current) && current >= observed) return null;
  return observed;
}

/**
 * The value a position mark this instance answers for may be recorded at: `min(value, settledPositionCap(records, spaceId))`, or `null` when
 * there is nothing to record (a value that is not a positive whole number, or a stream whose seed could not be read).
 *
 * ## What it prevents (bundle-81, decision 4 and decision 34)
 *
 * The marks this instance answers for (`lastPosPushed`, `lastPosServed`) seed its position clock after a restart that lost its stored maximum
 * (`sync/record-position-stream.ts`): positions continue above every number a peer holds in OUR stream. A mark that took a peer's number
 * as sent — a puller's `afterPos` of 2^53 - 1 — would drive every later stamp to the ceiling, so each is cut at this instance's own settled cap
 * for the space at the moment it is recorded, and that cut lives in ONE function that both mark writers (the served fold, the pushed mark) go
 * through. A position can only ever be recorded as high as one this instance has handed out or is about to.
 *
 * The cap is async (the stream is seeded from the store once), so it is awaited INSIDE a `try`: a seed that cannot be read records nothing
 * and NEVER throws, because the served fold runs on the tombstone pull's hot path and a throw there would turn a read the peer is owed into a
 * `500`. The failed seed is not remembered (`util/position-clock.ts`), so the next call records the capped mark.
 */
export async function ownPositionMark(spaceId: string, value: number): Promise<number | null> {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return null;
  try {
    return Math.min(value, await settledPositionCap(recordPositions, spaceId));
  } catch {
    return null;
  }
}

/**
 * Record that `peerInstanceId` has pulled our tombstones for `spaceId` from `position`, cut at this instance's own settled cap
 * (`ownPositionMark`).
 *
 * Called from the tombstone pull handler on the hot path, so it is deliberately cheap and silent: it writes
 * only when the value actually moves, and it uses the same coalesced `saveConfigSoon` as the pull watermark
 * one layer up. Losing the write on a crash costs a prune cycle, never a tombstone. It never throws: a read the peer is owed is
 * never turned into a failure by the bookkeeping of it.
 *
 * A caller with no peer identity (an admin token, the UI, a manual curl) records nothing. It has no member
 * entry to write to, and treating a local read as a peer having caught up is exactly the mistake that would
 * drop tombstones a real peer still needs.
 */
export async function recordServedPosition(
  peerInstanceId: string | undefined,
  spaceId: string,
  position: number,
): Promise<void> {
  if (!peerInstanceId) return;
  const own = await ownPositionMark(spaceId, position);
  if (own === null) return;
  let cfg: Config;
  try { cfg = getConfig(); } catch { return; }   // pre-setup
  if (applyServedPosition(cfg, peerInstanceId, spaceId, own)) saveConfigSoon(cfg);
}

/**
 * Write the served mark into a config object; returns whether anything changed.
 *
 * Separated from the config read and the save so the decision is testable against a plain object — the branches
 * that matter (an unknown peer, a network that does not carry the space, a value that must not move) are all
 * here, and none of them needs a config file or a running instance.
 *
 * Mutates `cfg` in place, and takes no `await`, so it cannot be holding a detached reference across a reload
 * (the mechanism behind #346/#348/#353/#604) — `setMemberSpaceMark` is the loop, shared with the other per-space marks. The served mark
 * belongs to the peer TOKEN, not to a network, so it is written on every network that carries the space.
 */
export function applyServedPosition(
  cfg: Config,
  peerInstanceId: string | undefined,
  spaceId: string,
  position: number,
): boolean {
  return setMemberSpaceMark(cfg, peerInstanceId, spaceId, 'lastPosServed', 'every-network', current => foldServedPosition(current, position));
}
