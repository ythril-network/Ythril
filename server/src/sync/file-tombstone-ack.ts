/**
 * How far each peer has been told about our file deletions — the acknowledgement half of tombstone retention.
 *
 * `<space>_file_tombstones` has the same unbounded-growth problem the record tombstones had, plus a privacy
 * edge the record ones do not: `FileTombstoneDoc.path` is often personal in itself, so deleting a file erases
 * the file and keeps its **name**, permanently.
 *
 * ── Why this cannot reuse the seq floor ──────────────────────────────────────────────────────────────────
 *
 * `sync/served-watermark.ts` bounds record tombstones by the `sinceSeq` a peer pulls from. File tombstones have
 * **no seq at all** — they are keyed by `deletedAt`, and the peer pull is issued with no `since` — so there is
 * no served position to record.
 *
 * The confirmation comes from the PUSH instead, and it is a stronger signal than a pull watermark:
 * `POST /api/sync/file-tombstones` upserts each tombstone it receives (`$setOnInsert`) and re-propagates it
 * onward, so a 200 proves that specific peer now holds it. Dropping ours afterwards is therefore safe
 * transitively — every peer that answered is itself a copy that keeps propagating.
 *
 * ── Everything here fails towards KEEPING ────────────────────────────────────────────────────────────────
 *
 * Same asymmetry as the record half: a tombstone kept too long is a few hundred bytes, one dropped too early
 * lets a deleted file come back on the next manifest sync. So a peer whose position is unknown blocks its
 * space, and "unknown" includes every peer we have never had a 200 from.
 */
import type { Config } from '../config/types.js';
import { getConfig, saveConfigSoon } from '../config/loader.js';
import { membersServing, peerTokensReaching, peersOutside } from './served-watermark.js';
import { setMemberSpaceMark } from './member-space-mark.js';
import { isComparableIso } from '../util/comparable-iso.js';
import { fileTombstonePosition } from '../files/tombstones.js';

/** The subset of a member this decision needs — keeps the pure part testable without a config. */
export interface AckedMember {
  instanceId: string;
  label?: string;
  lastFileTombstoneAckedAt?: Record<string, string>;
}

export type FileTombstoneFloor =
  /** Safe to delete file tombstones whose position (`positionAt`; `deletedAt` for one stored before positions) is at or below `upTo` (ISO8601). */
  | { prune: true; upTo: string; peers: number }
  | { prune: false; reason: 'member-never-acked' | 'peer-token-scoped'; blockedBy?: string };

/**
 * ISO8601 UTC timestamps sort lexically, which is what lets this compare with `<` instead of parsing dates — the
 * fixed-width `Z` form only, so anything else is treated as unknown rather than compared (`util/comparable-iso.ts`,
 * where the rule lives so the file-tombstone cursor asks the same question). Re-exported: this is where its readers look.
 */
export { isComparableIso };

/**
 * The newest `deletedAt` every peer has acknowledged, or a reason not to prune.
 *
 * Pure in `members` / `peerTokenIds` so every branch is checkable without a database. `direction` is
 * deliberately not consulted, for the same reason as the record half: it governs our outbound behaviour, not
 * what a peer holds. A member we never push to simply never acks, and its space is never pruned — safe, and
 * the caller logs which member is holding the floor.
 */
export function fileTombstoneFloor(
  members: AckedMember[],
  spaceId: string,
  peerTokenIds: string[] = [],
): FileTombstoneFloor {
  const stranger = peersOutside(members, peerTokenIds)[0];
  if (stranger !== undefined) {
    return { prune: false, reason: 'peer-token-scoped', blockedBy: stranger };
  }

  // No members and no peer tokens: these tombstones exist only to propagate, and there is nobody to propagate
  // to. Nothing is carrying information for anyone, so the path can go.
  if (members.length === 0) return { prune: true, upTo: '9999-12-31T23:59:59.999Z', peers: 0 };

  let floor: string | null = null;
  for (const m of members) {
    const acked = m.lastFileTombstoneAckedAt?.[spaceId];
    if (!isComparableIso(acked)) {
      return { prune: false, reason: 'member-never-acked', blockedBy: m.label ?? m.instanceId };
    }
    if (floor === null || acked < floor) floor = acked;
  }

  return { prune: true, upTo: floor as string, peers: members.length };
}

/** Read the config and answer for one space. */
export function fileTombstoneFloorForSpace(cfg: Config, spaceId: string): FileTombstoneFloor {
  return fileTombstoneFloor(membersServing(cfg, spaceId) as AckedMember[], spaceId, peerTokensReaching(cfg, spaceId));
}

/**
 * The position a successful push proves, from the array that was actually sent.
 *
 * Deliberately computed over the pushed set rather than a fresh query: a file deleted between building the
 * body and reading the response was never in the payload, and treating it as delivered would drop a tombstone
 * no peer has seen. The position of a row is its `positionAt` — this instance's own clock, the publish time of an own
 * tombstone and the receive time of a relayed one — or, for a row that carries none, its `deletedAt`, which was the
 * position before positions existed (`fileTombstonePosition`). Malformed or missing positions are skipped, so one bad row cannot
 * vouch for the rest — and if none of them is comparable the answer is `null`, meaning "this push proves nothing".
 *
 * The caller hands it what the answer PROVES delivered, which is not always everything it sent: a page that ends inside a
 * run of rows at one position leaves the rest of the run for the next page, so the rows at that position are not proven
 * (`settledFileTombstones`), or a prune at the position would take the unsent rest of the run with it.
 */
export function ackedPositionFrom(pushed: Array<{ positionAt?: unknown; deletedAt?: unknown }>): string | null {
  let max: string | null = null;
  for (const t of pushed) {
    const at = fileTombstonePosition(t);
    if (!isComparableIso(at)) continue;
    if (max === null || at > max) max = at;
  }
  return max;
}

/**
 * Fold an acknowledged position into a member's record. Monotonic, and refuses anything not comparable.
 *
 * Returns the new value or `null` when nothing should be written, so a caller can skip the config save on the
 * common no-change path.
 */
export function foldAckedAt(current: string | undefined, observed: string | null): string | null {
  if (observed === null || !isComparableIso(observed)) return null;
  if (isComparableIso(current) && current >= observed) return null;
  return observed;
}

/**
 * Record that `peerInstanceId` answered 200 to a push containing tombstones up to `ackedAt`.
 *
 * **Only a 200 may reach this.** A 403 (a direction-blocked peer that will never accept our tombstones), a
 * timeout, or a 500 must leave the position unknown: pruning on a push the peer rejected is exactly how a
 * deleted file comes back.
 */
export function recordFileTombstoneAck(
  peerInstanceId: string | undefined,
  spaceId: string,
  ackedAt: string | null,
): void {
  let cfg: Config;
  try { cfg = getConfig(); } catch { return; }   // pre-setup
  if (applyFileTombstoneAck(cfg, peerInstanceId, spaceId, ackedAt)) saveConfigSoon(cfg);
}

/** Write the ack into a config object; returns whether anything changed. Mutates in place, takes no `await`. */
export function applyFileTombstoneAck(
  cfg: Config,
  peerInstanceId: string | undefined,
  spaceId: string,
  ackedAt: string | null,
): boolean {
  if (ackedAt === null) return false;
  return setMemberSpaceMark(cfg, peerInstanceId, spaceId, 'lastFileTombstoneAckedAt', current => foldAckedAt(current, ackedAt));
}

/*
 * ── Why the PULL is deliberately left unfiltered ─────────────────────────────────────────────────────────
 *
 * The obvious companion change is to send `since=<last pulled>` so an established peer stops re-downloading
 * every file tombstone it has ever held. It was designed, and then dropped: it trades correctness for a
 * saving this change already delivers by another route.
 *
 * A file tombstone carries the ORIGINAL `deletedAt`, and it can reach a peer long after that timestamp — a
 * third instance's old deletion relayed onward, a peer that was offline for a week, a network that gained a
 * member. With `deletedAt > since` we would skip exactly those: the tombstone is older than our watermark, so
 * we never see it, and the file it should delete stays. `find({spaceId})` with no filter cannot miss one.
 *
 * And the payload problem is solved by the prune itself: once every peer's copy is bounded, the full set IS
 * small. Adding a filter to make an unbounded set cheaper to send is fixing the symptom.
 */
