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

import { edgeIdFor } from '../brain/edge-id.js';
import { derivedV4Id } from '../util/derived-id.js';
import { linkIdFor } from '../brain/link-id.js';
import { fileContentHash } from '../brain/merkle.js';
import { authorRef } from '../config/author.js';
import type { BrainCollection, RefKind } from '../config/types-knowledge.js';
import { authoredContentHash, bodiesDiffer, BodyNotRead, BODY_FIELDS_OF, type AuthoredContent } from './authored-content.js';

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
 * How deep a fork chain may be: a fork of a fork of a fork, counted in `forkOf` hops. It lives with the planner that enforces it on every door;
 * `api/sync/_shared.ts` re-exports it.
 */
export const MAX_FORK_DEPTH = 10;

/**
 * How many forks one record may have: the next differing copy of a record already at this many is dropped (`forkRefused`, logged and counted), so
 * Review's list is bounded per record. ONE constant for the planner that enforces it, the fork list that reports it (`maxForksPerRecord`, which the
 * client's "at the limit" notice reads) and the tool description that tells a caller, so none of them holds a number of its own.
 */
export const MAX_FORKS_PER_RECORD = 10;

/**
 * The families whose records FORK: an equal-seq copy that says something different is kept beside the stored one as a fork row of its own
 * family (D-23, Q-624). Declared ONCE, here; every place that handles a fork reads it (the planner, the fork context read, the fork write, the
 * writer's read-back, the fork indexes, the fork list), and `a-forking-family-is-read-from-the-planner` holds each of them to it.
 *
 * **Links are out** because a link's body IS its identity (`brain/link-id.ts`): two links that say different things are two links, and there is
 * nothing for a fork to hold. **Files are out** because a file keeps its own conflict copies (`api/conflicts.ts`) and its row is hashed by
 * `fileContentHash`, which this does not touch.
 *
 * Checked at load against the hash leaf, which derives the families it hashes from the schemas that declare `forkOf`: the two lists cannot say
 * different things for longer than it takes the server to start.
 */
// NOT ALL BRAIN COLLECTIONS, deliberately: the four that fork, and links and files are out for the reasons above.
export const FORKING_FAMILIES: readonly ForkingFamily[] = Object.freeze(['facts', 'entities', 'edges', 'chrono'] as const);

// NOT ALL BRAIN COLLECTIONS: see FORKING_FAMILIES.
/** A family that forks. */
export type ForkingFamily = 'facts' | 'entities' | 'edges' | 'chrono';

{
  const hashed = new Set(Object.keys(BODY_FIELDS_OF));
  const declared = new Set<string>(FORKING_FAMILIES);
  if (hashed.size !== declared.size || [...declared].some(f => !hashed.has(f))) {
    throw new Error(`FORKING_FAMILIES (${[...declared]}) does not match the families whose Incoming schema declares forkOf (${[...hashed]}): a family forks only when both say so`);
  }
}

/** Does `kind` fork? The one test of it, so no caller spells the list or the `includes` of its own. */
export function isForkingFamily(kind: string): kind is ForkingFamily {
  return (FORKING_FAMILIES as readonly string[]).includes(kind);
}

/**
 * The indexes on the collection of EACH forking family the fork caps read through — declared once, as `LINK_INDEXES` is, and
 * created by `initSpace` for a new space and by `ensureQueryIndexes` for every existing one, for every member of `FORKING_FAMILIES`
 * (`spaces/space-indexes.ts`). Without it the push door's sibling count was a `countDocuments({ forkOf })` per candidate over the whole
 * collection. Sparse: most records are no fork. Local, like every index — nothing about it replicates.
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
  contentRedacted?: boolean;
  /** The shared version a fork row was made at: the seq its id is derived from (`forkRowVerdict`). Absent on every record that is no fork, and on a 5.6 fact fork. */
  forkAt?: number;
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
 *
 * `storedVia` is the upstream this instance stored the tombstone FOR (the D-14 ground of `authorises`: a relayed
 * deletion of a record the upstream itself delivered), absent for every other tombstone. It is local to the tombstone
 * collection and never served (`brain/tombstones.ts`). It exists so the upstream's own later version is not refused by
 * the deletion it relayed, which carries a seq the issuer's clock chose (`tombSeqFor`).
 */
export interface HeldTombstone {
  seq: number;
  issuer?: string;
  storedVia?: string;
}

/** What the planner needs to know of a stored copy. */
export interface StoredCopy {
  seq?: number;
  forkOf?: string;
  /**
   * The hash of this copy's body (`authoredContentHash`, the WHOLE answer), read by the door and only when this copy's seq EQUALS an arriving one's:
   * a copy at another seq is newer or older and its body is not asked. A copy at an equal seq without it is a programming error (`BodyNotRead`).
   */
  bodyHash?: AuthoredContent;
  /**
   * A FILE row's own fields, read for the equal-seq convergence (`Q-419`): who authored it, the timestamp two copies
   * may disagree about, and the hash of everything else the wire carries.
   *
   * The hash, not the fields: the comparison belongs to `brain/merkle.ts`, which owns what a file row's authored half
   * IS, and a planner holding the fields would be a second place to decide that.
   */
  author?: { instanceId?: string };
  updatedAt?: string;
  contentHash?: string;
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
  /** The ids of every fork already stored for the candidate parents: a copy whose derived id is among them IS that fork. */
  existingForks?: ReadonlySet<string>;
  /** The ids, among the parents the page's fork rows name, that are stored here: a legacy fact fork is admitted only under a stored parent. */
  heldParents?: ReadonlySet<string>;
  /**
   * The body hash of an arriving document, memoised for the page: the candidate selection, the verdict and the writer's read-back all ask it, and
   * a document is hashed once. A door that reads a fork context passes the same function it selected candidates with.
   */
  hashOf?: BodyHashes;
}

/**
 * What became of one arriving document. `inserted`/`updated` are the facts family's spelling of `upserted`.
 * `duplicate` and `rejected` are never decided here — they are what a WRITE can still say (a unique index other
 * than `_id`, a store refusal), and the door overwrites the winner's verdict with them.
 */
export type ArrivalVerdict = 'inserted' | 'updated' | 'upserted' | 'skipped' | 'tombstoned' | 'forked'
  | 'forkRefused' | 'invalidFork' | 'unknownType' | 'duplicate' | 'rejected' | 'converged';

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
   * File rows that CONVERGE: the arriving copy is the author's own, at the same seq and the same authored content, and
   * only its timestamp differs (`convergesOnAuthorStamp`).
   *
   * Their own list rather than an `accepts` entry, because what the writer does with them is not what it does with an
   * accepted version: one field is written, no seq is stamped, `deliveredBy` is not rewritten, and the row is never
   * counted as landed — so no embed job is queued for a row whose content did not change.
   */
  converges: Array<{ index: number; doc: T }>;
  /**
   * The documents (by index) admitted although their fork id could not be derived from their body: a legacy fact fork of 5.6.0 or 5.6.1 under its
   * stored parent, and a chrono fork whose bytes a redaction took. They are stored as ordinary arrivals and counted `unverifiable`.
   */
  unverifiable: Array<{ index: number; reason: 'legacy' | 'redacted' }>;
  /**
   * Stale tombstones to delete: those below `below`. `onLanding` means only once the record lands — a tombstone
   * deleted before a write that then fails leaves the record absent and its deletion gone. Without it, the stored
   * copy is already above the tombstone (a crash between a write and its cleanup), so it is stale now.
   *
   * `via` marks a tombstone this instance stored FOR the upstream that is now delivering a version of the record
   * (`supersededVia`): it is removed whatever seq it claims, matched on `storedVia` instead of a seq bound, because the
   * seq is a position in the issuer's clock and says nothing about whether this upstream's version came after it.
   */
  tombstoneCleanups: Map<string, { below: number; onLanding: boolean; via?: string }>;
}

/**
 * A fork's id, DERIVED from what it forks: the parent's id, the seq both copies share, and the diverging text.
 *
 * It was `uuidv4()`, so a push whose 200 was lost and is re-sent forked the record again — the stored parent is
 * unchanged, so the retry is divergent all over again. Derived, the retry upserts the fork it already made, and
 * two peers forking the same divergence arrive at one id.
 *
 * Shaped as a v4 UUID (version and variant bits set) rather than v5, because a fork id is a fact id and every
 * reader that validates one — link endpoints, the fork-id response — expects that shape. Derived by
 * `util/derived-id.ts`, whose length-prefixed parts no text can forge a separator in, byte-for-byte what it was
 * before it moved there (pinned by `a-derived-id-is-shaped-in-one-place.test.js`). The namespace is fixed for ever.
 */
export function forkIdFor(parentId: string, seq: number, text: string): string {
  return derivedV4Id('ythril.fork-identity', parentId, String(seq), text);
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

/** A memoised body hash of an arriving document: one `authoredContentHash` per document per page. */
export type BodyHashes = (doc: object) => AuthoredContent;

/**
 * A fresh per-page memo of `authoredContentHash` for one family. A per-page Map keyed by the document, never a `WeakMap` on it: the planner spreads
 * documents into fork rows, and object identity is not a safe key across that. Owned by the door that reads a page, handed to every reader of it.
 */
export function bodyHashesOf(kind: PlannedFamily): BodyHashes {
  const memo = new Map<object, AuthoredContent>();
  return (doc) => {
    let found = memo.get(doc);
    if (found === undefined) { found = authoredContentHash(kind, doc as Record<string, unknown>); memo.set(doc, found); }
    return found;
  };
}

/**
 * The ids in a page that may FORK — the only ones the door reads a fork chain and a sibling count for.
 * A different body at an equal seq, against the stored copy or against another copy in the same page.
 */
export function forkCandidates(
  kind: PlannedFamily, docs: readonly ArrivalDoc[], stored: ReadonlyMap<string, StoredCopy>, hashOf: BodyHashes = bodyHashesOf(kind),
): string[] {
  const out = new Set<string>();
  const seen = new Map<string, ArrivalDoc[]>();
  for (const d of docs) {
    if (divergesFrom(kind, d, stored.get(d._id), hashOf)) out.add(d._id);
    for (const other of seen.get(d._id) ?? []) if (divergesFrom(kind, d, { seq: other.seq, bodyHash: hashOf(other) }, hashOf)) out.add(d._id);
    const copies = seen.get(d._id);
    if (copies) copies.push(d); else seen.set(d._id, [d]);
  }
  return [...out];
}

/**
 * Does a file row arriving at an EQUAL seq carry the author's own timestamp, so a receiver should adopt it?
 *
 * ## The drift this closes
 *
 * `updatedAt` is hashed and replicates, and an equal-seq arrival is otherwise skipped — so two instances holding one
 * file row with different timestamps stay different for ever, and a network with `merkle: true` reports a divergence
 * every cycle for a space where nothing is wrong. Nothing else can repair it: the row's content is identical, so no
 * ordinary write will ever be made.
 *
 * ## Every clause, and what goes wrong without it
 *
 *  - **the deliverer IS the author.** A relay serves its OWN stored value with the author field intact, so a receiver
 *    that adopted whatever arrived would flip a, b, a, b between the author and a drifted relay — each flip a write, a
 *    divergence and a re-arm. Only the author's own delivery carries the author's value.
 *  - **both copies name that author**, by `instanceId` alone: the hashed `author` object also carries a mutable
 *    `instanceLabel`, and adopting a display name would make two instances that agree about everything disagree over
 *    what a peer calls itself.
 *  - **the author is not this instance.** Our own row is the author's copy; there is nothing to adopt.
 *  - **the authored content is equal**, compared through the hash's own projection with the timestamp blanked
 *    (`fileContentHash`). Without it a real edit at an equal seq — a divergence — would be flattened into a timestamp
 *    change.
 *  - **the timestamps differ.** Nothing to do otherwise, and a write that changes nothing is still a write.
 *
 * ## Where it does NOT converge, stated because the rule is not total
 *
 * A row whose author is not a member of this network, has left, or is not named at all has nobody to take a value
 * from: it does not converge, and the repair reports that rather than retrying for ever.
 */
/**
 * The keys the convergence does NOT compare: the timestamp it is about, and `author` — whose `instanceId` the rule
 * compares itself and whose `instanceLabel` is a mutable display name. Exported so the two sides of the comparison (the
 * stored row, hashed where it is read, and the arriving document, hashed here) cannot blank different sets.
 */
export const CONVERGE_BLANKED: readonly string[] = ['updatedAt', 'author'];

export function convergesOnAuthorStamp(
  doc: { _id: string; seq?: number; author?: { instanceId?: string }; updatedAt?: string },
  copy: StoredCopy | undefined,
  o: { deliveredBy: string | undefined; localInstanceId: string | undefined; contentHashOf: (d: object) => string },
): boolean {
  const author = doc.author?.instanceId;
  if (author === undefined || author === '' || copy === undefined) return false;
  if (o.deliveredBy !== author) return false;
  if (copy.author?.instanceId !== author) return false;
  if (author === o.localInstanceId) return false;
  if (doc.updatedAt === undefined || copy.updatedAt === undefined || doc.updatedAt === copy.updatedAt) return false;
  return copy.contentHash !== undefined && copy.contentHash === o.contentHashOf(doc);
}

/**
 * Does an arriving copy DIVERGE from a copy of it: the same seq, a different BODY? The one fork rule, for every family that forks, asked by
 * `forkCandidates` (which records the door reads a fork context for), `planArrivals` (which records fork) and the writer's read-back of a guarded write
 * (`writeArrivals`), so the reads and the decision cannot disagree about what a fork is.
 *
 * The body is `authoredContentHash` (`sync/authored-content.ts`): the family's body fields, normalised through its `Incoming*` schema, version metadata
 * removed. Two copies of one document are never different (`divergence-is-irreflexive`). A copy at another seq is newer or older, never a divergence, and
 * its body is not asked. A copy at an EQUAL seq whose body was not read is `BodyNotRead`: a door that hands one over has a defect, and "different" would
 * be a fork nobody can explain while "same" would lose the edit.
 */
export function divergesFrom(
  kind: PlannedFamily, doc: object & { seq?: number }, copy: { seq?: number; bodyHash?: AuthoredContent } | undefined,
  hashOf: BodyHashes = (d) => authoredContentHash(kind, d as Record<string, unknown>),
): boolean {
  if (copy === undefined || copy.seq !== doc.seq) return false;
  if (copy.bodyHash === undefined) throw new BodyNotRead(kind, (doc as { _id?: unknown })._id);
  return bodiesDiffer(hashOf(doc), copy.bodyHash);
}

/**
 * The id a FACT fork had under 5.6.2 and later, derived from the TEXT alone (`forkIdFor(parent, seq, fact)`), or undefined for a family whose forks never had one.
 * Those rows are real on every member that upgraded, so a copy is matched to one by it as well as by the body-derived id.
 */
function legacyForkIdOf(kind: PlannedFamily, doc: ArrivalDoc, parent: string = doc._id, seq: number = doc.seq): string | undefined {
  return kind === 'facts' ? forkIdFor(parent, seq, doc.fact ?? '') : undefined;
}

/** Does `id` look like a v4 UUID, the shape of every fork id and of the random ones 5.6.0 and 5.6.1 gave a fact fork? */
const V4_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Can a fork row that ARRIVES (a pushed, pulled or restored row carrying `forkOf`) be accepted as what it says it is? The ONE derivation check of
 * every door (design section 3): its `_id` must equal `forkIdFor(forkOf, forkAt, authoredContentHash(family, row).text)`, so a fork id proves its body and
 * "is this the same fork" is an id lookup. The input is `forkAt`, the shared version the copies diverged at (the arriving copy's seq), and never the row's `seq`:
 * the row keeps a LOCAL version stamp there (parent decision, 2026-10-25).
 *
 *  - `ok`: the id derives. For FACTS the id a 5.6.2 or later instance derived from the TEXT (`forkIdFor(forkOf, seq, fact)`, a row with no `forkAt`) derives too,
 *    because those rows are real and a member that upgraded serves them.
 *  - `legacy`: a FACT fork WITHOUT `forkAt` whose id derives from neither but is v4-shaped, which is what 5.6.0 and 5.6.1 stored (`uuidv4()`). It cannot be verified,
 *    and refusing a real row is a permanent divergence between the members that hold it and the ones that refuse it, so the caller admits it under a
 *    STORED parent and the cap.
 *  - `redacted`: a CHRONO fork carrying `contentRedacted` whose id no longer derives, because the redaction deleted the bytes the id was made from.
 *    Admitted under the cap and the tombstoned-parent rule.
 *  - `invalid`: everything else, a `forkOf` equal to the row's own id and an entity, chrono or edge fork with no `forkAt` included. It is never silently dropped.
 *
 * What it is for, said plainly: `forkIdFor` is public, so this is not authentication. It makes one row per distinct body under a parent, so
 * re-deliveries collapse and a buggy peer cannot plant duplicates.
 */
export function forkRowVerdict(
  kind: PlannedFamily, row: ArrivalDoc, text: string,
): 'ok' | 'legacy' | 'redacted' | 'invalid' {
  const parent = row.forkOf;
  if (parent === undefined || parent === row._id || !isForkingFamily(kind)) return 'invalid';
  if (row.forkAt === undefined) {
    // A row that carries no `forkAt` is one 5.6 stored, and only a FACT fork existed then: its id derived from the text (at the seq the copies shared, which
    // the row no longer says) or was a random v4 uuid. An entity, chrono or edge fork without it cannot have been written by anything that exists.
    if (kind !== 'facts') return 'invalid';
    if (row._id === legacyForkIdOf(kind, row, parent)) return 'ok';
    return V4_SHAPED.test(row._id) ? 'legacy' : 'invalid';
  }
  // The derivation input is `forkAt`, never `seq`: the row keeps its LOCAL version stamp in `seq`, which no other instance derived the id from.
  if (row._id === forkIdFor(parent, row.forkAt, text)) return 'ok';
  if (row._id === legacyForkIdOf(kind, row, parent, row.forkAt)) return 'ok';
  return kind === 'chrono' && row.contentRedacted === true ? 'redacted' : 'invalid';
}

/**
 * The key of the unique index a family carries besides `_id`, or undefined for a family with none — the
 * family's own DERIVED identity, never a key spelled here: an edge's is `edgeIdFor` (its triplet and endpoint
 * kinds, coalesced by the shared `edgeEndpointKind`), a link's is `linkIdFor`. Two copies with one key are one
 * row under the index, so they collide here exactly when they would collide in the store.
 */
function uniqueKey(kind: PlannedFamily, d: ArrivalDoc): string | undefined {
  // A fork edge shares its subject's five identity fields and stays outside the identity slot (the partial index), so it holds no key.
  if (kind === 'edges' && d.forkOf) return undefined;
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
 *
 * **A tombstone stored via the upstream does not refuse that upstream's later version** (`storedVia`): the upstream
 * sending a version again means it superseded its own deletion, and its seq is a position in ITS clock, so a relayed
 * tombstone whose issuer claimed a high seq would otherwise refuse every later version of the record from the very peer
 * that deleted it, on the whole subtree below. A tombstone stored for another reason, and a version delivered by
 * anybody else, are refused exactly as before — a lateral non-author included. This is the ARRIVAL side of the
 * question `authorises` answers for a delete, which is why it is spelled here and not there.
 */
function tombSeqFor(doc: ArrivalDoc, held: HeldTombstone | undefined, deliveredBy: string | undefined): number | undefined {
  if (held === undefined) return undefined;
  return heldTombstoneRefuses(held, doc.author?.instanceId, deliveredBy) ? held.seq : undefined;
}

/**
 * Does a held tombstone speak against an arriving version written by `author` and delivered by `deliveredBy`, whatever
 * the two versions are? The WHO half of the arrival question (the rules above), asked by a record (`tombSeqFor`) and by
 * a file's metadata (`shadowDecision` in `files/tombstones.ts`); the version half is each kind's own.
 *
 * What it prevents: the file side once asked only the version, so a tombstone any pushing peer stored for a path nobody
 * held yet, at a high version, refused every later version of a file at that path from every author — and a path,
 * unlike a record id, is easy to guess.
 */
export function heldTombstoneRefuses(
  held: { issuer?: string; storedVia?: string }, author: string | undefined, deliveredBy: string | undefined,
): boolean {
  if (supersededVia(held, deliveredBy) !== undefined) return false;
  const provenOtherAuthor = !tombstoneGoverns(held.issuer, author) && deliveredBy !== undefined && author === deliveredBy;
  return !provenOtherAuthor;
}

/**
 * Is `row` a LATER version of the path a held tombstone deleted, written by the tombstone's own issuer? The ARRIVAL side of
 * the question of whether deleted content came back (bundle-71, Q-349): a deleted file's sidecars are shadowed by their
 * parent's tombstone until the parent is re-created, and a re-creation by the instance that deleted it is the one a version
 * number can speak for.
 *
 * **Never the version alone, across authors**: two instances' seq counters are not one clock, so another author's higher
 * number says nothing about whether the deleted content came back. A tombstone with no issuer or no version, or a row with no
 * author or no version, names nothing to compare, so the answer is no.
 */
export function isNewerVersionByTheIssuer(
  held: { issuer?: string; rowSeq?: number }, row: { author?: { instanceId?: string }; seq?: number },
): boolean {
  const author = row.author?.instanceId;
  return !!held.issuer && held.issuer === author
    && typeof row.seq === 'number' && typeof held.rowSeq === 'number' && isNewerCopy(row.seq, held.rowSeq);
}

/**
 * The upstream whose delivery supersedes `held`, or `undefined` when none does: the tombstone was stored for the very
 * peer now delivering a version of the record. It does not refuse that version (`tombSeqFor`) and it is DELETED once
 * the version lands (`tombstoneCleanups.via`) — otherwise this instance would go on serving a deletion of a record it
 * now holds in a newer version, and a child whose copy it delivered would apply it and lose that version too.
 */
function supersededVia(held: { storedVia?: string }, deliveredBy: string | undefined): string | undefined {
  return held.storedVia !== undefined && held.storedVia === deliveredBy ? held.storedVia : undefined;
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
 * - Every family that forks (`FORKING_FAMILIES`): no copy -> `inserted` (facts) or `upserted`; a higher seq -> `updated` or
 *   `upserted`; an equal seq with a different BODY (`divergesFrom`, the body hash) -> a FORK; anything else -> `skipped`. The
 *   other families (links, file metadata) carry no body of their own to disagree about: no copy or a higher seq ->
 *   `upserted`, else `skipped`.
 * - A row that arrives carrying `forkOf` is judged by what it says it is first (`forkRowVerdict`): an id that does not derive from
 *   its body, a `forkOf` equal to its own id, one on a family that does not fork, or an edge whose `forkOf` presence differs from
 *   the stored copy's is `invalidFork` — its own verdict, never a silent `rejected`. A fork row of a record whose tombstone is held
 *   and which is not held itself is `tombstoned`: the deletion wins. No fork of a fork is minted: a stored row that carries
 *   `forkOf` never forks.
 * - "The copy" is the stored one OVERLAID by every version this page accepted before it, so `[5, 6]` is
 *   inserted-then-updated and `[9, 3]` is inserted-then-skipped. The counters count ITEMS, as processing them in
 *   order counted them; the write is the final winner per id.
 * - A unique-index collision WITHIN the page (two ids, one edge triplet or one link's endpoints) is decided here,
 *   first accepted wins, rather than left to the execution order of an unordered bulk write.
 *
 * ## The fork caps, on every door
 *
 * A fork is refused (`forkRefused`) when the parent's chain is already `MAX_FORK_DEPTH` deep, or when the parent
 * already has `MAX_FORKS_PER_RECORD` forks — stored ones and the ones this page is creating together, because a cap
 * that counts only stored siblings lets one page past it by any amount. A fork whose derived id is already stored
 * (or already created by this page) is that same fork: `forked`, with no second write and no cap consulted — matched by
 * ID, never by hashing a stored fork, because a fork's id proves its body.
 */
export function planArrivals<T extends ArrivalDoc>(docs: readonly T[], input: ArrivalPlanInput): ArrivalPlan<T> {
  const { kind, stored, tombstones } = input;
  const forking = (FORKING_FAMILIES as readonly string[]).includes(kind);
  const hashOf = input.hashOf ?? bodyHashesOf(kind);
  const plan: ArrivalPlan<T> = {
    verdicts: [], forkIds: [], accepts: new Map(), forks: [], converges: [], unverifiable: [], tombstoneCleanups: new Map(),
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
  const pageIds = new Set(docs.map(d => d._id));

  const parentOf = (id: string): string | undefined => {
    if (overlay.has(id)) return overlay.get(id)!.forkOf;
    if (stored.has(id)) return stored.get(id)!.forkOf;
    return input.forkParent?.get(id);
  };
  const siblingsOf = (id: string): number => (input.siblings?.get(id) ?? 0) + (forksMade.get(id) ?? 0);
  /** Is the record `id` held here: stored, accepted earlier in this page, or about to be accepted later in it. */
  const parentHeld = (id: string): boolean => stored.has(id) || overlay.has(id) || pageIds.has(id) || input.heldParents?.has(id) === true;
  /** The copy a later document is compared against: the page's accepted version, whose body is hashed only when its seq is asked. */
  const copyOf = (accepted: T): StoredCopy => {
    return { seq: accepted.seq, ...(accepted.forkOf !== undefined ? { forkOf: accepted.forkOf } : {}), get bodyHash() { return hashOf(accepted); } };
  };

  const accept = (i: number, doc: T, verdict: ArrivalVerdict, tomb: number | undefined, via: string | undefined): void => {
    plan.verdicts[i] = verdict;
    const prev = parentOf(doc._id);
    overlay.set(doc._id, doc);
    if (!plan.accepts.has(doc._id)) plan.accepts.set(doc._id, []);
    plan.accepts.get(doc._id)!.push({ index: i, doc });
    // A foreign fork arriving under its parent is a sibling as soon as it is stored, as it was one at a time.
    if (forking && doc.forkOf && doc.forkOf !== prev) forksMade.set(doc.forkOf, (forksMade.get(doc.forkOf) ?? 0) + 1);
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
    } else if (via !== undefined) {
      superseded.add(doc._id);
      plan.tombstoneCleanups.set(doc._id, { below: doc.seq, onLanding: true, via });
    }
  };

  docs.forEach((doc, i) => {
    plan.forkIds[i] = undefined;
    if (kind === 'chrono' && input.door === 'push' && input.allowedTypes && !input.allowedTypes.has(doc.type ?? '')) {
      plan.verdicts[i] = 'unknownType';
      return;
    }
    // What this page accepted for the id so far overlays what is stored; a family that forks compares it by body, a file by its own fields.
    const accepted = overlay.get(doc._id);
    const cur: StoredCopy | undefined = accepted === undefined ? stored.get(doc._id) : forking ? copyOf(accepted) : accepted;

    // An edge's `forkOf` never changes presence: no writer adds or removes it on a stored edge (a re-point re-mints the fork, a resolve of an orphan re-keys it),
    // and a subject that arrived as a fork, or a stored fork that arrived as a subject, would move a row into or out of the identity slot behind the index's back.
    // Judged for EVERY arriving edge against what is stored (or accepted earlier in this page), before anything else: a malformed row is never a silent `rejected`.
    if (kind === 'edges' && cur !== undefined && (cur.forkOf !== undefined) !== (doc.forkOf !== undefined)) { plan.verdicts[i] = 'invalidFork'; return; }

    // A row that carries `forkOf` is a fork row arriving, and it is judged FIRST by what it says it is (design sections 3 and 4): a malformed one is
    // never stored and never a silent `rejected`. A kind that does not fork is malformed by carrying it.
    let admittedAs: 'legacy' | 'redacted' | undefined;
    if (doc.forkOf !== undefined) {
      const verdict = forking ? forkRowVerdict(kind, doc, hashOf(doc).text) : 'invalid';
      if (verdict === 'invalid') { plan.verdicts[i] = 'invalidFork'; return; }
      if (verdict !== 'ok') admittedAs = verdict;
      // The deletion wins: a fork row of a record whose tombstone is held here and which is not held itself is an orphan nothing would ever remove.
      if (cur === undefined && !parentHeld(doc.forkOf) && tombstones.has(doc.forkOf)) { plan.verdicts[i] = 'tombstoned'; return; }
      // A legacy fork cannot prove its body, so it is admitted only under a parent that is here.
      if (verdict === 'legacy' && !parentHeld(doc.forkOf)) { plan.verdicts[i] = 'invalidFork'; return; }
      // The cap counts the stored siblings and this page's, and a fork row already stored here is a re-delivery that the cap does not refuse.
      if (cur === undefined && siblingsOf(doc.forkOf) >= MAX_FORKS_PER_RECORD) { plan.verdicts[i] = 'forkRefused'; return; }
    }

    const held = superseded.has(doc._id) ? undefined : tombstones.get(doc._id);
    const tomb = tombSeqFor(doc, held, input.deliveredBy);
    const via = held === undefined ? undefined : supersededVia(held, input.deliveredBy);
    if (tomb !== undefined && tomb >= doc.seq) { plan.verdicts[i] = 'tombstoned'; return; }

    const curSeq = cur?.seq;
    const newer = isNewerCopy(doc.seq, curSeq);

    if (forking && cur !== undefined && !newer && divergesFrom(kind, doc, cur, hashOf)) {
      // The fork's id proves its body: a copy whose body a stored fork (or one this page made) already holds IS that fork, found by id, so a
      // re-delivery adds no row whatever cap the parent has reached since. A FACT fork a 5.6.2 or later instance stored is under the id its TEXT derives.
      const forkId = forkIdFor(doc._id, doc.seq, hashOf(doc).text);
      const legacyId = legacyForkIdOf(kind, doc);
      const known = [forkId, legacyId].find(id => id !== undefined && (input.existingForks?.has(id) || newForks.has(id)));
      if (known !== undefined) {
        plan.verdicts[i] = 'forked'; plan.forkIds[i] = known; return;
      }
      if (forkDepth(doc._id, parentOf) >= MAX_FORK_DEPTH || siblingsOf(doc._id) >= MAX_FORKS_PER_RECORD) {
        plan.verdicts[i] = 'forkRefused'; return;
      }
      // No fork of a fork is minted: a stored row that carries `forkOf` is one body under one derived id, so a divergent copy of it is no new version of
      // anything the author wrote. A legacy fact chain keeps its depth cap above (a copy refused there is still dropped and said), and is never extended.
      if (cur.forkOf !== undefined) { plan.verdicts[i] = 'skipped'; return; }
      newForks.add(forkId);
      forksMade.set(doc._id, (forksMade.get(doc._id) ?? 0) + 1);
      plan.forks.push({ index: i, doc: { ...doc, _id: forkId, forkOf: doc._id, forkAt: doc.seq } });
      plan.verdicts[i] = 'forked'; plan.forkIds[i] = forkId;
      return;
    }
    if (newer) {
      const key = uniqueKey(kind, doc);
      const holder = key === undefined ? undefined : keyOwner.get(key);
      if (holder !== undefined && holder !== doc._id) { plan.verdicts[i] = 'duplicate'; return; }
      if (admittedAs !== undefined) plan.unverifiable.push({ index: i, reason: admittedAs });
      // The facts family's own spelling of the two outcomes; every other family says `upserted`.
      return accept(i, doc, kind === 'facts' ? (cur === undefined ? 'inserted' : 'updated') : 'upserted', tomb, via);
    }
    /*
     * A file row the AUTHOR delivered at the seq we already hold, identical but for its timestamp (`Q-419`).
     *
     * Decided here rather than at the writer because it is a verdict: the page says what became of every document, and
     * "skipped" was the answer that left two instances different for ever. Asked AFTER the newer-copy branch, so an
     * ordinary update is never routed through it, and only for files — no other family has a hashed field that one
     * instance can move without the other.
     */
    if (kind === 'files' && convergesOnAuthorStamp(doc, cur, {
      deliveredBy: input.deliveredBy,
      localInstanceId: authorRef().instanceId,
      // `author` is blanked with the timestamp, and compared by `instanceId` alone in the rule above: the hashed
      // `author` object also carries a mutable `instanceLabel`, so a peer that renamed itself would otherwise read as
      // different content — and the label is not what the receiver was asked to converge on.
      contentHashOf: (d) => fileContentHash(d as Record<string, unknown>, CONVERGE_BLANKED),
    })) {
      plan.converges.push({ index: i, doc });
      plan.verdicts[i] = 'converged';
      return;
    }
    plan.verdicts[i] = 'skipped';
    // The stored copy is already above a tombstone the page still sees: a write landed and its cleanup did not.
    if (tomb !== undefined && curSeq !== undefined && curSeq > tomb && !plan.tombstoneCleanups.has(doc._id)) {
      plan.tombstoneCleanups.set(doc._id, { below: curSeq, onLanding: false });
    }
  });
  return plan;
}
