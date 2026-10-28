/**
 * What version does a local write of these ids take, and what is the highest version this space may continue from.
 *
 * ## The question it answers
 *
 * A local write of row `i` (a create, an edit, a tombstone issue, a fork, a re-key, a merge) is stamped
 *
 *     stamp = max(V + 1 + i, heldSeq + 1, min(heldTomb, VERSION_FLOOR_CAP) + 1)
 *
 * where `V` is the space's counter before the allocation, `heldSeq` the stored record's version whatever its author (so an edit beats
 * what it replaces) and `heldTomb` the version of ANY held tombstone for the id, whatever its issuer (so a re-create lands above every
 * deletion this instance knows of, on every relay: a quiet instance re-creating an edge a busy peer deleted would otherwise be refused
 * by every relay holding that tombstone, for good). One batched read of both runs BEFORE the counter moves (held must be read first),
 * then ONE pipeline update sets `seq := max(seq + n, H)` and `seqSeenBy6 := seq` and returns the previous value. `H` is the highest held
 * term at or below the cap, so the counter only ever takes stamps at or below it.
 *
 * Nothing here takes a position or a hold: a version is compared, never paged by, so it needs no horizon (`util/position-clock.ts` and
 * `sync/record-position-stream.ts` are where a record's place in the stream is decided). What keeps a version honest instead is the
 * compare-and-swap on the version the stamp READ (`writeFilterFor`, `brain/write-precondition.ts`).
 *
 * ## The forgettable parts, which are the reason to call this and not rebuild it
 *
 *  - **`min(heldTomb, VERSION_FLOOR_CAP)`** sits in the term. A tombstone a peer planted at `MAX_INGEST_SEQ` on a guessable id
 *    (`edgeIdFor`, `linkIdFor`) raises that one record's stamp to at most `VERSION_FLOOR_CAP + 1`, which a peer accepts, and never
 *    raises `V`. A copy that dropped the `min` hands every later create to the ceiling.
 *  - **The ceiling refusal**: a stamp above `MAX_INGEST_SEQ` is `RecordVersionAtCeiling` (`record_version_at_ceiling`), raised BEFORE
 *    anything is written and before the counter moves for the refused row, so a refused edit changes nothing and a refused delete leaves
 *    no tombstone. It is D-19 B's accepted residual, and nothing else is refused here. Counted, per collection, as
 *    `ythril_brain_write_seq_total{outcome="ceiling"}`.
 *  - **The version mark is read here and nowhere else** (`util/version-mark.ts`, Q-556): the first stamp of a space in this process raises the counter to the
 *    mark kept in config.json BEFORE the counter's update, and a counter found below one this process saw (it went back while running) is raised to it and
 *    the update redone once, so a restore onto an empty database, a counter wipe, an import onto an emptied space or a failed rename's counter move cannot
 *    restart a space's versions below ones peers hold. After the update the mark follows the counter, never a stamp lifted by a held tombstone.
 *  - **The counter is only ever raised to a value at or below the cap** (`raiseVersionTo` clamps), never lowered, and an allocation
 *    keeps every field of the counter doc it does not own (`positionsOwed`, `positionsReadyAt`: the owed marker rides on this doc).
 *
 * `versionsFor` throws for the first refused row, which is what every single-record caller wants. A caller whose other rows should land
 * (the bulk write, a fork page) asks `versionsForRows`, which says which rows were refused and allocates for the rest.
 */
import { col, asFilter, asUpdate } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { readStoredById } from '../db/read-by-id.js';
import { readPageTombstones } from '../sync/push-reads.js';
import { BRAIN_COLLECTIONS, type BrainCollection, type SpaceCounterDoc } from '../config/types.js';
import { countBrainWriteSeq } from '../metrics/brain-write-count.js';
import { RecordVersionAtCeiling } from '../brain/write-precondition.js';
import { withinWriteBound } from '../db/write-bound.js';
import { readyWhenCreated } from '../sync/positions-ready.js';
import { log, peerText } from './log.js';
import { versionMarkOf, followCounter, counterSeenBefore, isFirstStampOf, firstStampChecked, reportCounterRaised } from './version-mark.js';
import type { VersionRaiseReason } from '../metrics/version-raise-count.js';
import { MAX_INGEST_SEQ, SEQ_CARRYING, VERSION_FLOOR_CAP, highestVersionBelowCapOf } from './seq.js';
import type { ClientSession } from 'mongodb';

/** The version a local write of one id takes, and the version the stamp read (what the write's filter names: `writeFilterFor`). */
export interface VersionAllocation {
  readonly id: string;
  /** The stamp. */
  readonly version: number;
  /** The stored row's version as the stamp read it: a number, or `null` when the row carries none or does not exist. */
  readonly readSeq: number | null;
  /** Whether a stored row was there to read: a write that misses its compare-and-swap on a row that is gone is not retried. */
  readonly exists: boolean;
}

/** A row `versionsForRows` refused: its version would have been above `MAX_INGEST_SEQ`. */
export interface RefusedVersion {
  readonly id: string;
  readonly refused: true;
}

/** Where a stamp's held terms are read: the record collections the ids may live in (all of them unless the caller says), and a session. */
export interface VersionReadOptions {
  /** The record collections to read the held version from. Defaults to every record collection. */
  readonly parts?: readonly BrainCollection[];
  /** The transaction the caller's reads belong to (a merge reads what it is about to write inside its session). */
  readonly session?: ClientSession;
  /**
   * Versions the caller already READ for some of the ids, which count as held beside what the store says now: a tombstone is stamped above
   * the record it buries, and the record may already be gone by the time the tombstone is written (`originalSeq`). A row's `readSeq` is
   * still the STORED row's.
   */
  readonly known?: ReadonlyMap<string, number | undefined>;
}

/** The held terms of each id: the stored version and where it was found, and the highest held tombstone version. */
async function heldTermsOf(spaceId: string, ids: readonly string[], opts: VersionReadOptions) {
  const parts = opts.parts ?? BRAIN_COLLECTIONS;
  const session = opts.session ? { session: opts.session } : {};
  const [byPart, tombs] = await Promise.all([
    Promise.all(parts.map(async part => [part, await readStoredById<{ seq?: number }>(spaceCollection(spaceId, part), ids, { seq: 1 }, session)] as const)),
    readPageTombstones(spaceId, ids, opts.session),
  ]);
  return ids.map((id) => {
    let stored: { part: BrainCollection; seq: number | null } | undefined;
    for (const [part, rows] of byPart) {
      const row = rows.get(id);
      if (!row) continue;
      const seq = typeof row.seq === 'number' ? row.seq : null;
      if (!stored || (seq ?? -1) > (stored.seq ?? -1)) stored = { part, seq };
    }
    let heldTomb: number | undefined;
    for (const byId of tombs.values()) {
      const t = byId.get(id)?.seq;
      if (typeof t === 'number' && (heldTomb === undefined || t > heldTomb)) heldTomb = t;
    }
    // What the caller already read counts as held, but is never the row's `readSeq`: that names what is STORED, for the write's filter.
    const known = opts.known?.get(id);
    return { id, stored, heldTomb, known: typeof known === 'number' ? known : undefined };
  });
}

/**
 * The lowest version a write of the id may take: above the stored version and above the held tombstone, the latter capped. `0` is
 * "nothing held"; versions start at 1. `fromRecord` is the part that comes from the record the write replaces or buries (the stored version,
 * and a version the caller already read): the only part the counter follows (see {@link allocate}).
 */
function heldFloor(
  stored: { seq: number | null } | undefined, heldTomb: number | undefined, known?: number,
): { floor: number; fromRecord: number } {
  const fromRecord = Math.max(stored?.seq != null ? stored.seq + 1 : 0, known !== undefined ? known + 1 : 0);
  const fromTombstone = heldTomb !== undefined ? Math.min(heldTomb, VERSION_FLOOR_CAP) + 1 : 0;
  return { floor: Math.max(fromRecord, fromTombstone), fromRecord };
}

/**
 * Allocate versions for `ids` and say which were refused: the core of {@link versionsFor} and {@link versionsForRows}.
 * Every id gets its own stamp, in the order given; a refused row takes no number from the counter.
 */
async function allocate(
  spaceId: string, ids: readonly string[], opts: VersionReadOptions,
): Promise<Array<VersionAllocation | RefusedVersion>> {
  if (ids.length === 0) return [];
  // The reads are a plan's own reads and carry no bound of theirs (a read the store refuses fails at once and is the caller's error: under
  // the write bound's driver clock it would be retried for the whole bound, hot). What is BOUNDED, though it holds nothing, is the counter's one
  // update: the first write of every local write, which used to run inside the seq hold's bound (`Q-213`). A counter row locked elsewhere must
  // end the write with the store's own timeout (503), not leave it waiting for the driver's.
  const held = await heldTermsOf(spaceId, ids, opts);
  return withinWriteBound(() => allocateBounded(spaceId, held));
}

/** {@link allocate}'s counter update and its arithmetic, inside the write bound, over the held terms already read. */
async function allocateBounded(
  spaceId: string, held: Awaited<ReturnType<typeof heldTermsOf>>,
): Promise<Array<VersionAllocation | RefusedVersion>> {
  const terms = held.map(h => heldFloor(h.stored, h.heldTomb, h.known));
  const floors = terms.map(t => t.floor);
  const accepted = floors.flatMap((f, i) => (f > MAX_INGEST_SEQ ? [] : [i]));
  const refusedAt = new Set(floors.flatMap((f, i) => (f > MAX_INGEST_SEQ ? [i] : [])));
  for (const i of refusedAt) countBrainWriteSeq(held[i]!.stored?.part ?? 'facts', 'ceiling');
  /*
   * H: the highest RECORD term at or below the cap among the rows that take a number — what the counter is raised to. Only the record's: a
   * version stamped over a record this instance held (or a tombstone it is about to write for one) stays above every earlier version of that
   * record, own tombstones included, even after the tombstone is pruned and the record re-created (the re-create takes `V + 1`, and `V` has
   * followed). A held TOMBSTONE's term is not: it is another instance's statement about one id, it lifts that one record's stamp (capped) and
   * leaves `V` alone, so a peer's deletion — or a tombstone planted on a guessable id — cannot move every later stamp of the space.
   */
  const raiseTo = Math.max(0, ...accepted.map(i => terms[i]!.fromRecord).filter(f => f <= VERSION_FLOOR_CAP));
  let counter = 0;
  if (accepted.length > 0) {
    const n = accepted.length;
    // The version mark (`util/version-mark.ts`) is read HERE and nowhere else, before the counter moves for this allocation: the first stamp of a
    // space in this process starts from a counter at or above its mark, so a restore onto an empty database or a wiped counter cannot restart a
    // space's versions below ones peers hold. Marked done only after the raise succeeded, so a failed raise is tried again by the next stamp.
    if (isFirstStampOf(spaceId)) {
      const mark = versionMarkOf(spaceId);
      if (mark !== undefined) await raiseCounterToMark(spaceId, mark, 'start');
      firstStampChecked(spaceId);
    }
    const seenBefore = counterSeenBefore(spaceId);
    // ONE pipeline, atomic: `seq := max(seq + n, H)` and the version the build that wrote it has seen. Upserted for a space with no
    // doc yet; every other field of the doc (`positionsOwed`, `positionsReadyAt`) is left as it is.
    const allocateFromCounter = () => col<SpaceCounterDoc>('ythril_counters').findOneAndUpdate(
      asFilter<SpaceCounterDoc>({ _id: spaceId }),
      [
        readyWhenCreated(),
        { $set: { seq: { $max: [{ $add: [{ $ifNull: ['$seq', 0] }, n] }, raiseTo] } } },
        { $set: { seqSeenBy6: '$seq' } },
      ] as unknown as ReturnType<typeof asUpdate<SpaceCounterDoc>>,
      { upsert: true, returnDocument: 'before' },
    );
    let before = await allocateFromCounter();
    // A counter below one this process saw BEFORE it sent this update has gone back while the process ran (an import onto an emptied space, a
    // failed rename's counter move, a live wipe): the update above started from it and its stamps are not safe. Raised to the mark and redone once;
    // the numbers the first update took are simply not used.
    const mark = versionMarkOf(spaceId);
    if ((before?.seq ?? 0) < seenBefore && mark !== undefined) {
      await raiseCounterToMark(spaceId, mark, 'went_back');
      before = await allocateFromCounter();
    }
    counter = before?.seq ?? 0;
    // The mark follows the counter this update LEFT (the stamp's lifts by a held tombstone are not in it).
    followCounter(spaceId, Math.max(counter + n, raiseTo));
  }
  let next = 0;
  return held.map((h, i): VersionAllocation | RefusedVersion => {
    if (refusedAt.has(i)) return { id: h.id, refused: true };
    const version = Math.max(counter + 1 + next++, floors[i]!);
    // A counter already above the ceiling (a poisoned one, before the carry repaired it) cannot stamp anything a peer accepts.
    if (version > MAX_INGEST_SEQ) {
      countBrainWriteSeq(h.stored?.part ?? 'facts', 'ceiling');
      return { id: h.id, refused: true };
    }
    return { id: h.id, version, readSeq: h.stored?.seq ?? null, exists: h.stored !== undefined };
  });
}

/**
 * The versions a local write of `ids` takes, in order. Throws `RecordVersionAtCeiling` for the first id whose version would be above
 * `MAX_INGEST_SEQ`, with nothing written for any of them. `opts.parts` narrows where the held version is read (a fact write reads
 * `facts`); the held tombstone is always read.
 */
export async function versionsFor(spaceId: string, ids: readonly string[], opts: VersionReadOptions = {}): Promise<VersionAllocation[]> {
  const out = await allocate(spaceId, ids, opts);
  const refused = out.find((o): o is RefusedVersion => 'refused' in o);
  if (refused) throw new RecordVersionAtCeiling(refused.id);
  return out as VersionAllocation[];
}

/**
 * {@link versionsFor} for a caller whose other rows should land: a refused row comes back as `{ id, refused: true }` and took no number.
 */
export async function versionsForRows(
  spaceId: string, ids: readonly string[], opts: VersionReadOptions = {},
): Promise<Array<VersionAllocation | RefusedVersion>> {
  return allocate(spaceId, ids, opts);
}

/**
 * The highest version stored in any of the space's collections that is at or below `VERSION_FLOOR_CAP`: what the counter may continue
 * from. `0` for a space holding none. The carry's counter repair, the restore act's raise and the rollback tool read it; nothing else
 * reads the version maximum.
 */
export async function highestVersionBelowCap(spaceId: string): Promise<number> {
  return highestVersionBelowCapOf(SEQ_CARRYING.map(part => col(spaceCollection(spaceId, part))));
}

/**
 * Raise the space's counter to at least `target`, never above `VERSION_FLOOR_CAP` and never down, keeping every other field of the doc.
 * Also records the version this build has seen (`seqSeenBy6`), so a restore never trips the re-upgrade detector. A target above the cap is
 * clamped and said (a stray value must not strand the counter within `SEQ_CEILING_RESERVE` of the ceiling).
 */
export async function raiseVersionTo(spaceId: string, target: number): Promise<void> {
  await raiseCounter(spaceId, target);
}

/** {@link raiseVersionTo}, answering the counter as it stood BEFORE the raise (`0` for a space with no counter doc), so a caller can say whether it moved. */
async function raiseCounter(spaceId: string, target: number): Promise<number> {
  let to = target;
  if (to > VERSION_FLOOR_CAP) {
    log.warn(`Clamped the version raise for space '${peerText(spaceId)}': ${to} is above the cap (${VERSION_FLOOR_CAP}); raising to the cap instead.`);
    to = VERSION_FLOOR_CAP;
  }
  const before = await col<SpaceCounterDoc>('ythril_counters').findOneAndUpdate(
    asFilter<SpaceCounterDoc>({ _id: spaceId }),
    [
      readyWhenCreated(),
      { $set: { seq: { $max: [{ $ifNull: ['$seq', 0] }, to] } } },
      { $set: { seqSeenBy6: '$seq' } },
    ] as unknown as ReturnType<typeof asUpdate<SpaceCounterDoc>>,
    { upsert: true, returnDocument: 'before' },
  );
  return before?.seq ?? 0;
}

/**
 * Raise the counter to the space's version mark (`util/version-mark.ts`) and say so when that moved it: one line and one count, with the reason.
 * The only reader of a mark that moves a counter, and it is called from `allocate` alone.
 */
async function raiseCounterToMark(spaceId: string, mark: number, reason: VersionRaiseReason): Promise<void> {
  const from = await raiseCounter(spaceId, mark);
  if (from < mark) reportCounterRaised(spaceId, from, mark, reason);
}

/**
 * Bring a POISONED counter back to what the space holds: a counter above `VERSION_FLOOR_CAP` (a 5.6 build that took a received version near the ceiling
 * into it) cannot stamp anything a peer accepts, so it becomes {@link highestVersionBelowCap}. The first carry's counter repair (design rev 8 §3 step 2);
 * the only place the counter goes DOWN, and only from above the cap, so a healthy counter is never lowered. Answers whether it repaired one.
 */
export async function repairPoisonedCounter(spaceId: string): Promise<boolean> {
  // The target is read first, and the write names the poison in its own filter, so a counter that is no longer above the cap by the time it lands is left as it is
  // (one atomic compare-and-set, never a read of the counter and a write after an await).
  const to = await highestVersionBelowCap(spaceId);
  const r = await col<SpaceCounterDoc>('ythril_counters').updateOne(
    asFilter<SpaceCounterDoc>({ _id: spaceId, seq: { $gt: VERSION_FLOOR_CAP } }), asUpdate<SpaceCounterDoc>({ $set: { seq: to } }));
  if (r.modifiedCount > 0) log.warn(`Space '${peerText(spaceId)}': the version counter was above the cap; it is now ${to}, the highest version the space holds below it.`);
  return r.modifiedCount > 0;
}
