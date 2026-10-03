/**
 * Deciding which arriving documents — pushed or pulled — actually get written, and re-tagging them to the local
 * space.
 *
 * Extracted from `sync/engine.ts` as slice 2 of the god-file split. Pure: no Mongo, no network. The page
 * accept (`sync/accept-page.ts`) and the writer (`sync/arrivals.ts`) keep the IO; everything that decides is
 * here, because every mistake in this decision is silent and expensive.
 *
 * ── Last-writer-wins by `seq`, and why the comparison is strict ─────────────────────────────────
 *
 * Sync applies a pulled record as a whole-document replace. Which of two versions wins is decided by
 * `seq` alone, so this comparison IS the conflict resolution:
 *
 *   - **absent locally** → write it. This is the ordinary new-record path.
 *   - **incoming seq is HIGHER** → write it. The peer has a newer version.
 *   - **incoming seq is EQUAL** → do NOT write. Both sides already agree, and a re-sync must be a
 *     no-op. Loosening this to `>=` would make every cycle rewrite every document it has ever seen:
 *     the data would stay correct, so nothing would fail, while write volume grew with the size of
 *     the space rather than with what changed.
 *   - **incoming seq is LOWER** → do NOT write. A peer that is behind — restored from a backup, or
 *     offline through several local edits — must not roll newer local records backwards. This is the
 *     clause that makes the rule a data-loss guard rather than a bandwidth optimisation.
 *
 * ── Re-tagging is not cosmetic ──────────────────────────────────────────────────────────────────
 *
 * A peer's document carries ITS space id, and under `spaceMap` aliasing that is not ours — yet we
 * store it in OUR collection. Every read path filters on `spaceId` (`listEntities`,
 * `findEntityByName`, the edge-dedup lookup, cascade deletes), so leaving the remote id in place makes
 * a synced document invisible to list and lookup while still being counted. The data reads as lost,
 * and because `findEntityByName` stops matching, `saveFact` starts creating duplicates instead of
 * updating. The collection name is the only real scope: a document written into `{localSpaceId}_*`
 * belongs to `localSpaceId` by definition.
 */

import { createHash } from 'node:crypto';
import { idPart, edgeIdFor } from '../brain/edge-id.js';
import { linkIdFor } from '../brain/link-id.js';
import type { BrainCollection, RefKind } from '../config/types-knowledge.js';

/** The minimum shape this module needs: everything sync replicates carries an id and a seq. */
export interface Replicable {
  _id: string;
  seq: number;
}

/**
 * Stamp every document with the local space id, in place.
 *
 * In place because the caller writes these same objects straight to Mongo — copying would mean the
 * copy is tagged and the written original is not, which is the exact bug this prevents.
 *
 * The one writer of `RETAGGED_FIELDS` (`sync/retagged-fields.ts`): a field this rewrites is replicated yet local,
 * so it is on that list and out of the space hash. A field added here and not there makes every space held under a
 * `spaceMap` alias report a Merkle divergence on identical content.
 */
export function retagToLocalSpace(docs: readonly unknown[], localSpaceId: string): void {
  for (const doc of docs) {
    (doc as { spaceId?: string }).spaceId = localSpaceId;
  }
}

/**
 * Is a copy at seq `incoming` newer than one held at `held` — the ONE accept rule of every arrival door: the
 * page planner (`planArrivals`, push and pull alike), the writer's collapse of a repeated id within one page, and
 * its read-back of a guarded write. Strictly greater, so an equal seq is NOT newer: across peers that makes a
 * re-sync a no-op, and inside one page it means the EARLIER of two equal copies stands — the planner's sequential
 * reading, applied on restore too.
 *
 * Nothing held is beaten by anything; a copy that has no seq (file metadata from before 4.0) beats nothing held
 * at a seq — but a held copy with no seq is overwritten by anything that arrives.
 */
export function isNewerCopy(incoming: number | undefined, held: number | undefined): boolean {
  if (held === undefined) return true;
  if (incoming === undefined) return false;
  return incoming > held;
}

/**
 * The same rule AT THE WRITE: the filter under which an arriving copy at `seq` may replace what is stored — a
 * stored copy below it, or one with no seq, or none (the upsert). A copy newer than the one planned, written between
 * the accept read and the write, then fails the write with a duplicate `_id` and is kept. A copy that itself has no
 * seq is written by `_id` alone, as `isNewerCopy` lets anything replace a seq-less copy.
 */
export function seqGuard(id: string, seq: number | undefined): Record<string, unknown> {
  if (typeof seq !== 'number') return { _id: id };
  return { _id: id, $or: [{ seq: { $lt: seq } }, { seq: { $exists: false } }] };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// THE PAGE ACCEPT PLANNER (`Q-107` part 1 §2; every door since `Q-204`)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The fork cap, twice over: a fork chain may be this deep, and one parent may have this many forks. It lives
 * with the planner that enforces it on every door; `api/sync/_shared.ts` re-exports it.
 */
export const MAX_FORK_DEPTH = 10;

/**
 * The indexes on a space's FACTS collection the fork caps read through — declared once, as `LINK_INDEXES` is, and
 * created by `initSpace` for a new space and by `ensureQueryIndexes` for every existing one. Without it the push
 * door's sibling count was a `countDocuments({ forkOf })` per candidate over the whole collection. Sparse: most
 * facts are no fork. Local, like every index — nothing about it replicates.
 */
export const FORK_INDEXES: readonly { keys: Record<string, 1>; sparse: true }[] = Object.freeze([
  { keys: { forkOf: 1 }, sparse: true as const },
]);

/**
 * The families the planner decides: every replicated family, by its collection — derived, so a seventh is planned by
 * being a brain collection. File metadata has no tombstone type (a deleted file has its own route) and never forks,
 * so it is planned by seq alone — the same verdicts as any family with no unique key.
 */
export type PlannedFamily = BrainCollection;

/**
 * Which door a page came through. The planner decides alike for both but for ONE stated difference — see
 * `ArrivalPlanInput.door`. An admin import is a restore, not a door of this planner: it replaces, unplanned.
 */
export type ArrivalDoor = 'push' | 'pull';

/** The fields of an arriving document the planner reads. */
export interface ArrivalDoc extends Replicable {
  fact?: string;
  forkOf?: string;
  type?: string;
  from?: string;
  to?: string;
  label?: string;
  fromKind?: string;
  toKind?: string;
  author?: { instanceId?: string };
}

/**
 * A tombstone stored here for an id: its seq, and the instance that issued it. The issuer is what lets a tombstone
 * refuse only the records its own issuer wrote (bundle-46): without it, a tombstone one peer planted for an id
 * blocked every later copy of that record from every other author.
 */
export interface HeldTombstone {
  seq: number;
  issuer?: string;
}

/** What the planner needs to know of a stored copy. */
export interface StoredCopy {
  seq?: number;
  fact?: string;
  forkOf?: string;
}

/**
 * Everything the planner is told, read by the door in a bounded number of queries per page.
 *
 * `forkParent` holds the `forkOf` of every ANCESTOR the door walked (level by level), beyond the page's own
 * stored copies; `siblings` the stored fork count per candidate parent; `existingForks` the ids of forks already
 * stored for those parents. All three are empty for a fork-free page, and the door does not read them.
 */
export interface ArrivalPlanInput {
  kind: PlannedFamily;
  /**
   * The door, for the one deliberate difference: a chrono `type` outside this space's vocabulary is `unknownType` on
   * PUSH only. On pull the receiver's schema comes from the same upstream as the record, and dropping it would lose
   * the record for good — the receiver's watermark moves past it either way.
   */
  door: ArrivalDoor;
  stored: ReadonlyMap<string, StoredCopy>;
  /** The tombstone held per id, for this family's tombstone type only. */
  tombstones: ReadonlyMap<string, HeldTombstone>;
  /**
   * The peer identity the delivering door PROVES — the pushing token's peer, or the member a pull read from — or
   * undefined for an admin or local token. Required, so a door has to say it: a record escapes another issuer's
   * tombstone only when the peer delivering it IS its author.
   */
  deliveredBy: string | undefined;
  /** The chrono vocabulary this space allows; ignored for the other families, and on pull. */
  allowedTypes?: ReadonlySet<string>;
  forkParent?: ReadonlyMap<string, string | undefined>;
  siblings?: ReadonlyMap<string, number>;
  existingForks?: ReadonlySet<string>;
}

/**
 * What became of one arriving document. `inserted`/`updated` are the facts family's spelling of `upserted`.
 * `duplicate` and `rejected` are never decided here — they are what a WRITE can still say (a unique index other
 * than `_id`, a store refusal), and the door overwrites the winner's verdict with them.
 */
export type ArrivalVerdict = 'inserted' | 'updated' | 'upserted' | 'skipped' | 'tombstoned' | 'forked'
  | 'forkRefused' | 'unknownType' | 'duplicate' | 'rejected';

export interface ArrivalPlan<T extends ArrivalDoc> {
  /** One verdict per input document, in input order — what sequential processing would have answered. */
  verdicts: ArrivalVerdict[];
  /** The fork id behind each `forked` verdict. */
  forkIds: Array<string | undefined>;
  /**
   * Every accepted version per id, in page order. The LAST is the one written (at most one op per id: an
   * unordered bulk write lets the last op win whatever its seq). The earlier ones are what the door writes
   * instead when the winner's write fails, so the outcome stays the sequential one.
   */
  accepts: Map<string, Array<{ index: number; doc: T }>>;
  /** New forks to write, ids already derived, seqs still to be allocated. */
  forks: Array<{ index: number; doc: T }>;
  /**
   * Stale tombstones to delete: those below `below`. `onLanding` means only once the record lands — a tombstone
   * deleted before a write that then fails leaves the record absent and its deletion gone. Without it, the stored
   * copy is already above the tombstone (a crash between a write and its cleanup), so it is stale now.
   */
  tombstoneCleanups: Map<string, { below: number; onLanding: boolean }>;
}

/**
 * A fork's id, DERIVED from what it forks: the parent's id, the seq both copies share, and the diverging text.
 *
 * It was `uuidv4()`, so a push whose 200 was lost and is re-sent forked the record again — the stored parent is
 * unchanged, so the retry is divergent all over again. Derived, the retry upserts the fork it already made, and
 * two peers forking the same divergence arrive at one id.
 *
 * Shaped as a v4 UUID (version and variant bits set) rather than v5, because a fork id is a fact id and every
 * reader that validates one — link endpoints, the fork-id response — expects that shape. The encoding is
 * `edge-id.ts`'s length-prefixed parts, so no text can forge a separator. The namespace is fixed for ever.
 */
export function forkIdFor(parentId: string, seq: number, text: string): string {
  const h = createHash('sha256')
    .update(`ythril.fork-identity${idPart(parentId)}${idPart(String(seq))}${idPart(text)}`)
    .digest();
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/**
 * How many `forkOf` hops lie above `id`: 0 for a root. A visited set breaks a cycle, and the walk stops one past
 * the cap, so corrupted data costs at most `MAX_FORK_DEPTH + 1` steps. The reference shape for any chain walk.
 */
export function forkDepth(id: string, parentOf: (id: string) => string | undefined): number {
  const visited = new Set<string>();
  let depth = 0;
  let cur: string | undefined = id;
  while (cur && depth <= MAX_FORK_DEPTH) {
    if (visited.has(cur)) break;
    visited.add(cur);
    const parent = parentOf(cur);
    if (!parent) break;
    depth++;
    cur = parent;
  }
  return depth;
}

/**
 * The fact ids in a page that may FORK — the only ones the door reads a fork chain and a sibling count for.
 * Divergent text at an equal seq, against the stored copy or against another copy in the same page.
 */
export function forkCandidates(docs: readonly ArrivalDoc[], stored: ReadonlyMap<string, StoredCopy>): string[] {
  const out = new Set<string>();
  const seen = new Map<string, ArrivalDoc[]>();
  for (const d of docs) {
    if (divergesFrom(d, stored.get(d._id))) out.add(d._id);
    for (const other of seen.get(d._id) ?? []) if (divergesFrom(d, other)) out.add(d._id);
    seen.set(d._id, [...(seen.get(d._id) ?? []), d]);
  }
  return [...out];
}

/**
 * Does an arriving fact DIVERGE from a copy of it — the same seq, different `fact` text? The one fork rule, asked
 * by `forkCandidates` (which facts the door reads a fork context for) and `planArrivals` (which facts fork),
 * so the reads and the decision cannot disagree about what a fork is.
 */
export function divergesFrom(doc: { seq?: number; fact?: string }, copy: { seq?: number; fact?: string } | undefined): boolean {
  return copy !== undefined && copy.seq === doc.seq && copy.fact !== doc.fact;
}

/**
 * The key of the unique index a family carries besides `_id`, or undefined for a family with none — the
 * family's own DERIVED identity, never a key spelled here: an edge's is `edgeIdFor` (its triplet and endpoint
 * kinds, coalesced by the shared `edgeEndpointKind`), a link's is `linkIdFor`. Two copies with one key are one
 * row under the index, so they collide here exactly when they would collide in the store.
 */
function uniqueKey(kind: PlannedFamily, d: ArrivalDoc): string | undefined {
  if (kind === 'edges') return edgeIdFor(String(d.from ?? ''), String(d.to ?? ''), String(d.label ?? ''), d.fromKind, d.toKind);
  if (kind === 'links') {
    return linkIdFor(String(d.from ?? ''), d.fromKind as RefKind, String(d.to ?? ''), d.toKind as RefKind);
  }
  return undefined;
}

/**
 * The seq of the tombstone that governs `doc`, or `undefined` when none does.
 *
 * A held tombstone from a different issuer than the record's author is someone else's statement about an id, so it
 * neither refuses the record nor is cleaned up by it — but ONLY when the peer delivering the record proves it is
 * that author (`deliveredBy`). The author field is the sender's text: without the proof, a push claiming any other
 * author for a deleted id would resurrect it past its tombstone. It is the mirror of the rule a tombstone itself
 * passes (`applyPeerTombstones`: its issuer must be the delivering peer). When either side carries no instance (a
 * legacy tombstone, an author-less record) the tombstone governs, as it always did.
 */
function tombSeqFor(doc: ArrivalDoc, held: HeldTombstone | undefined, deliveredBy: string | undefined): number | undefined {
  if (held === undefined) return undefined;
  const author = doc.author?.instanceId;
  const provenOtherAuthor = !tombstoneGoverns(held.issuer, author) && deliveredBy !== undefined && author === deliveredBy;
  return provenOtherAuthor ? undefined : held.seq;
}

/**
 * May a tombstone `issuer` issued speak for a record `author` wrote? Only when they are the same instance — or when
 * either is unknown (a legacy tombstone, an author-less record), which governs as it always did. The one spelling of
 * the rule, for the two questions that ask it: whether a peer's tombstone may delete a record held here
 * (`applyPeerTombstones`) and whether a held tombstone refuses an arriving record (`planArrivals`).
 */
export function tombstoneGoverns(issuer: string | undefined, author: string | undefined): boolean {
  return !(issuer && author && issuer !== author);
}

/**
 * Decide an arriving page — PUSHED or PULLED, one rule (`Q-204`) — the way processing it one document at a time
 * decided it: pure, so every outcome is testable without a database, and so the WRITE can be one bulk operation
 * instead of one per document. The pull used to accept by seq alone, so the same document delivered the other way
 * round resurrected a deleted record and dropped one side of a divergence.
 *
 * ## The rules
 *
 * - A tombstone from another issuer than the record's author is ignored when the delivering peer proves it is that
 *   author (`tombSeqFor`); otherwise every held tombstone governs.
 * - A tombstone at or above the incoming seq: `tombstoned`. One below it is stale — superseded by this copy, so
 *   later copies of the id in the page no longer see it, and it is deleted once the record lands.
 * - Chrono, on PUSH only: a type outside this space's vocabulary is `unknownType`, before anything else is
 *   consulted (the one door difference — `ArrivalPlanInput.door` says why).
 * - Facts: no copy -> `inserted`; a higher seq -> `updated`; an equal seq with different `fact` text -> a FORK;
 *   anything else -> `skipped`. The other families: no copy or a higher seq -> `upserted`, else `skipped` — an
 *   equal seq never forks there.
 * - "The copy" is the stored one OVERLAID by every version this page accepted before it, so `[5, 6]` is
 *   inserted-then-updated and `[9, 3]` is inserted-then-skipped. The counters count ITEMS, as processing them in
 *   order counted them; the write is the final winner per id.
 * - A unique-index collision WITHIN the page (two ids, one edge triplet or one link's endpoints) is decided here,
 *   first accepted wins, rather than left to the execution order of an unordered bulk write.
 *
 * ## The fork caps, on every door
 *
 * A fork is refused (`forkRefused`) when the parent's chain is already `MAX_FORK_DEPTH` deep, or when the parent
 * already has `MAX_FORK_DEPTH` forks — stored ones and the ones this page is creating together, because a cap
 * that counts only stored siblings lets one page past it by any amount. A fork whose derived id is already stored
 * (or already created by this page) is that same fork: `forked`, with no second write and no cap consulted.
 */
export function planArrivals<T extends ArrivalDoc>(docs: readonly T[], input: ArrivalPlanInput): ArrivalPlan<T> {
  const { kind, stored, tombstones } = input;
  const plan: ArrivalPlan<T> = {
    verdicts: [], forkIds: [], accepts: new Map(), forks: [], tombstoneCleanups: new Map(),
  };
  /** The version of each id this page has accepted so far — what a later copy is compared against. */
  const overlay = new Map<string, T>();
  /** Ids whose stale tombstone a copy in this page has already superseded. */
  const superseded = new Set<string>();
  /** Unique-index key -> the id that holds it among this page's accepted writes. */
  const keyOwner = new Map<string, string>();
  const ownKey = new Map<string, string>();
  const newForks = new Set<string>();
  const forksMade = new Map<string, number>();

  const parentOf = (id: string): string | undefined => {
    if (overlay.has(id)) return overlay.get(id)!.forkOf;
    if (stored.has(id)) return stored.get(id)!.forkOf;
    return input.forkParent?.get(id);
  };
  const siblingsOf = (id: string): number => (input.siblings?.get(id) ?? 0) + (forksMade.get(id) ?? 0);

  const accept = (i: number, doc: T, verdict: ArrivalVerdict, tomb: number | undefined): void => {
    plan.verdicts[i] = verdict;
    const prev = parentOf(doc._id);
    overlay.set(doc._id, doc);
    if (!plan.accepts.has(doc._id)) plan.accepts.set(doc._id, []);
    plan.accepts.get(doc._id)!.push({ index: i, doc });
    // A foreign fork arriving under its parent is a sibling as soon as it is stored, as it was one at a time.
    if (kind === 'facts' && doc.forkOf && doc.forkOf !== prev) forksMade.set(doc.forkOf, (forksMade.get(doc.forkOf) ?? 0) + 1);
    const key = uniqueKey(kind, doc);
    if (key !== undefined) {
      const old = ownKey.get(doc._id);
      if (old !== undefined && keyOwner.get(old) === doc._id) keyOwner.delete(old);
      keyOwner.set(key, doc._id);
      ownKey.set(doc._id, key);
    }
    if (tomb !== undefined) {
      superseded.add(doc._id);
      plan.tombstoneCleanups.set(doc._id, { below: doc.seq, onLanding: true });
    }
  };

  docs.forEach((doc, i) => {
    plan.forkIds[i] = undefined;
    if (kind === 'chrono' && input.door === 'push' && input.allowedTypes && !input.allowedTypes.has(doc.type ?? '')) {
      plan.verdicts[i] = 'unknownType';
      return;
    }
    const tomb = superseded.has(doc._id) ? undefined : tombSeqFor(doc, tombstones.get(doc._id), input.deliveredBy);
    if (tomb !== undefined && tomb >= doc.seq) { plan.verdicts[i] = 'tombstoned'; return; }

    const cur: StoredCopy | undefined = overlay.get(doc._id) ?? stored.get(doc._id);
    const curSeq = cur?.seq;
    const newer = isNewerCopy(doc.seq, curSeq);

    if (kind === 'facts') {
      if (cur === undefined) return accept(i, doc, 'inserted', tomb);
      if (newer) return accept(i, doc, 'updated', tomb);
      if (divergesFrom(doc, cur)) {
        const forkId = forkIdFor(doc._id, doc.seq, doc.fact ?? '');
        if (input.existingForks?.has(forkId) || newForks.has(forkId)) {
          plan.verdicts[i] = 'forked'; plan.forkIds[i] = forkId; return;
        }
        if (forkDepth(doc._id, parentOf) >= MAX_FORK_DEPTH || siblingsOf(doc._id) >= MAX_FORK_DEPTH) {
          plan.verdicts[i] = 'forkRefused'; return;
        }
        newForks.add(forkId);
        forksMade.set(doc._id, (forksMade.get(doc._id) ?? 0) + 1);
        plan.forks.push({ index: i, doc: { ...doc, _id: forkId, forkOf: doc._id } });
        plan.verdicts[i] = 'forked'; plan.forkIds[i] = forkId;
        return;
      }
    } else if (newer) {
      const key = uniqueKey(kind, doc);
      const holder = key === undefined ? undefined : keyOwner.get(key);
      if (holder !== undefined && holder !== doc._id) { plan.verdicts[i] = 'duplicate'; return; }
      return accept(i, doc, 'upserted', tomb);
    }
    plan.verdicts[i] = 'skipped';
    // The stored copy is already above a tombstone the page still sees: a write landed and its cleanup did not.
    if (tomb !== undefined && curSeq !== undefined && curSeq > tomb && !plan.tombstoneCleanups.has(doc._id)) {
      plan.tombstoneCleanups.set(doc._id, { below: curSeq, onLanding: false });
    }
  });
  return plan;
}
