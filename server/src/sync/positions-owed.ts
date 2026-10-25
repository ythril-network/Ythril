/**
 * The positions a space owes, who records that it does, and the work that clears it: the first carry into position space, the repair after a 5.6 build, the
 * re-upgrade detector, the job that retries them (bundle-81, design rev 8 §3, decisions 7, 9, 16, 61).
 *
 * ## The question it answers
 *
 * *"Does this space owe its positions, and which kind of work?"* The READ side (the readiness every door and reader asks) is `sync/positions-ready.ts`, a leaf
 * so the readers can ask it without importing the work; this module re-exports it and holds the writes:
 *
 * - **The marker**, on the space's `ythril_counters` document: `positionsOwed: 'carry' | 'repair'` while it owes, `positionsReadyAt` once it does not. READINESS
 *   IS ONE WRITE (`recordPositionsReady`: set `positionsReadyAt` and `seqSeenBy6`, unset `positionsOwed`), made after every step of the work it records, so a crash
 *   before it leaves the space owing and nothing else can mark it ready. A carry that used the ABSENCE of `seqSeenBy6` to mean "first" was never resumed after
 *   its first landing (every allocation writes it): the marker is explicit.
 * - **`moveCounterDoc`**: a rename carries the whole document with every marker field. `replaceOne` with a hand-built `{_id, seq}` dropped them (P34), so no other
 *   counter writer replaces the document (`every-counter-writer-keeps-the-positions-marker-db`).
 * - **The carry** (`'carry'`): a row with a version and no position takes the identity band (`pos = posAtSeq = seq`, which lies below every clock value), every row
 *   of the record families takes `writtenHere` from the one predicate (`sync/written-here.ts`), and a poisoned counter is brought back to the highest version the
 *   space holds below the cap. Chunked by the `(seq, _id)` keyset, 1,000 rows a unit, under the housekeeping bound; every filter says `pos` is ABSENT, so a record
 *   that landed meanwhile keeps the clock position it took.
 * - **The repair** (`'repair'`): a row with no position, or whose `posAtSeq` is not its `seq` (a 5.6 build changed it without one), takes a FRESH clock position
 *   (never the identity band: after a rollback, peers' marks for this instance are in the clock band) and a recomputed `writtenHere`.
 * - **The detector** (`detectReupgrade`): once per boot, marks what needs the above. The first 6.0 boot marks every counter document with neither field `'carry'`,
 *   carries the marks and the scanner cursors by identity, and writes `positionsSince`; every boot marks a document with neither field `'repair'` (once
 *   `positionsSince` is written), a ready space whose counter moved under a 5.6 allocation (`seq != seqSeenBy6`), and every space of a member whose `lastSyncAt`
 *   differs from `lastSyncAtBy6` (a 5.6 build synced with it and can replace rows without moving a counter, P23).
 * - **The job** (`positionsOwedJob`): every 60 s, the work of every space that owes, indexes first. Not a boot step: a failed index build, an interrupted carry and a
 *   space renamed or restored at runtime all finish here, within a tick and not at the next boot.
 *
 * ## What the owed space answers meanwhile
 *
 * Every sync door answers `503 positions_building`, which a sender reads as HELD (`sync/positions-ready.ts`). It is not a space act: it closes no space to
 * writes, and a local write still takes its clock position. The carry's `pos`-absent filters are what make the two safe together.
 *
 * ## What it does not do
 *
 * The one-time pass is `util/space-backfill-pass.ts` (the `deliveredBy` back-fill is its other user). The marks a restore forgets and keeps are
 * `config/types-networks.ts`'s; a restore calls {@link finishPositionsOf} for its space and carries no mark (it has no business moving a receive mark forward).
 */
import type { Collection } from 'mongodb';
import { col, asFilter, asUpdate } from '../db/mongo.js';
import { spaceCollection, SPACE_COLLECTIONS, type SpacePart } from '../db/space-collection.js';
import { andPredicates } from '../db/and-predicates.js';
import { writeInOneCommands } from '../db/one-command.js';
import { getConfig, saveConfig } from '../config/loader.js';
import type { SpaceCounterDoc } from '../config/types.js';
import { configuredSpaceIds } from '../spaces/space-lookup.js';
import { POSITION_WORK_INDEXES, buildSpaceIndex, spaceIndexUnit, type SpaceIndex } from '../spaces/space-indexes.js';
import { SEQ_CARRYING } from '../util/seq.js';
import { tieThenRange } from '../util/seq-keyset.js';
import { repairPoisonedCounter } from '../util/version-stamp.js';
import { backfillSpaceOnce, type SpaceBackfillResult } from '../util/space-backfill-pass.js';
import { intervalJob } from '../util/interval-job.js';
import { log, peerText } from '../util/log.js';
import { positionsBuildingSpaces, positionsCarryUnpositionedTotal } from '../metrics/registry.js';
import { carryScanCursors } from '../brain/scan-cursor.js';
import { writtenHereFilter, isWrittenHere } from './written-here.js';
import { withLandingStamp, arrivalRow } from './record-position-stream.js';
import { carryMarksToPositions } from './receive-marks.js';
import { syncedBy56 } from './member-status.js';
import {
  COUNTERS, forgetPositionsReady, holdPositionsUntilDetected, positionsHeldUntilDetected, positionsOwed, releasePositionsHold, type PositionsOwed,
} from './positions-ready.js';

export {
  positionsOwed, positionsReady, forgetPositionsReady, assertPositionsReady, holdPositionsUntilDetected, releasePositionsHold, positionsHeldUntilDetected,
} from './positions-ready.js';
export type { PositionsOwed } from './positions-ready.js';

/** The walk step the work of a space is reported under. */
const STEP = 'positions carry';
/** Rows a unit handles at once: ids read, then one update (the carry) or one stamped block (the repair). */
const CHUNK = 1_000;
/** How often the job looks for a space that owes. */
export const POSITIONS_OWED_INTERVAL_MS = 60_000;

const counters = () => col<SpaceCounterDoc>(COUNTERS);

// ── the marker ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Record that the space owes `kind` of work, and that it is not ready. A space that already owes `'carry'` keeps it (a carry covers a repair's rows, and never the
 * other way round). Upserts, so a space with no counter document owes too. In-process readiness is forgotten.
 */
export async function owePositions(spaceId: string, kind: PositionsOwed): Promise<void> {
  await counters().updateOne(
    asFilter<SpaceCounterDoc>({ _id: spaceId }),
    [
      { $set: { positionsOwed: { $cond: [{ $eq: ['$positionsOwed', 'carry'] }, 'carry', kind] } } },
      { $unset: 'positionsReadyAt' },
    ] as unknown as ReturnType<typeof asUpdate<SpaceCounterDoc>>,
    { upsert: true },
  );
  forgetPositionsReady(spaceId);
}

/**
 * Record the space READY, in ONE update: `positionsReadyAt` and `seqSeenBy6` (the counter as this build saw it, so the next boot's detector reads no 5.6
 * allocation) are set and `positionsOwed` is unset. `kind` makes the write conditional on the space still owing THAT kind, so a repair marked while a carry
 * ran is not erased by the carry's ending. Answers whether it landed.
 */
export async function recordPositionsReady(spaceId: string, kind?: PositionsOwed): Promise<boolean> {
  const r = await counters().updateOne(
    asFilter<SpaceCounterDoc>({ _id: spaceId, ...(kind ? { positionsOwed: kind } : {}) }),
    [
      { $set: { seqSeenBy6: '$seq', positionsReadyAt: new Date().toISOString() } },
      { $unset: 'positionsOwed' },
    ] as unknown as ReturnType<typeof asUpdate<SpaceCounterDoc>>,
  );
  forgetPositionsReady(spaceId);
  return r.modifiedCount > 0;
}

/**
 * A space CREATED now owes nothing: an empty space has no row to position. Written ready (`seq` 0, `seqSeenBy6` 0, `positionsReadyAt`) only where the space has no
 * counter document; one that exists (a space id used before) says for itself what it owes.
 */
export async function createReadyCounter(spaceId: string): Promise<void> {
  await counters().updateOne(
    asFilter<SpaceCounterDoc>({ _id: spaceId }),
    asUpdate<SpaceCounterDoc>({ $setOnInsert: { seq: 0, seqSeenBy6: 0, positionsReadyAt: new Date().toISOString() } }),
    { upsert: true },
  );
  forgetPositionsReady(spaceId);
}

/**
 * Move a space's counter document to its new id, WHOLE: the greater of the two versions, and every other field it carries (`positionsOwed`, `positionsReadyAt`,
 * `seqSeenBy6`) as it is. `_id` is immutable, so it is copy then delete, and a re-run after a crash between the two is harmless. A target that already held a
 * counter with a HIGHER version had a history of its own (it is not a plain move), so the space owes a repair. Answers the moved document, or `null` when the old
 * id had none.
 */
export async function moveCounterDoc(oldId: string, newId: string): Promise<SpaceCounterDoc | null> {
  const old = await counters().findOne(asFilter<SpaceCounterDoc>({ _id: oldId }));
  if (!old) return null;
  const existing = await counters().findOne(asFilter<SpaceCounterDoc>({ _id: newId }));
  const seq = Math.max(old.seq ?? 0, existing?.seq ?? 0);
  const moved: SpaceCounterDoc = { ...old, _id: newId, seq };
  if (existing && (existing.seq ?? 0) > (old.seq ?? 0) && moved.positionsOwed !== 'carry') {
    moved.positionsOwed = 'repair';
    delete moved.positionsReadyAt;
  }
  await counters().replaceOne(asFilter<SpaceCounterDoc>({ _id: newId }), moved as never, { upsert: true });
  await counters().deleteOne(asFilter<SpaceCounterDoc>({ _id: oldId }));
  forgetPositionsReady(oldId);
  forgetPositionsReady(newId);
  return moved;
}

// ── the work of one space ─────────────────────────────────────────────────────────────────────────────────────────

/** One row as the carry and the repair read it. */
interface Row {
  _id: string;
  seq?: number;
  pos?: number;
  posAtSeq?: number;
  author?: { instanceId?: unknown } | null;
  deliveredBy?: unknown;
}

/** The units of a space's work, in the order they are done: its indexes first (a carry finds rows without a position through them), then each collection, then the counter. */
type Unit = { kind: 'index'; ix: SpaceIndex } | { kind: 'rows'; part: SpacePart } | { kind: 'counter' };

const unitsOf = (kind: PositionsOwed): Unit[] => [
  ...POSITION_WORK_INDEXES.map((ix): Unit => ({ kind: 'index', ix })),
  ...SEQ_CARRYING.map((part): Unit => ({ kind: 'rows', part })),
  ...(kind === 'carry' ? [{ kind: 'counter' } as Unit] : []),
];

const unitName = (u: Unit): string => (u.kind === 'index' ? spaceIndexUnit(u.ix) : u.kind === 'rows' ? `rows of ${SPACE_COLLECTIONS[u.part]}` : 'version counter');

/**
 * The rows of a collection that carry a numeric version, `CHUNK` at a time in `(seq, _id)` order, each chunk after the last row of the one before: the tie at the
 * last row's version first, then everything above it (`tieThenRange`, the one reading of a keyset). A version is the one thing a legacy row has to be walked by.
 */
async function* chunksBySeq(coll: Collection<Row>, projection: Record<string, 1>): AsyncGenerator<Row[]> {
  let after: { seq: number; id: string } | undefined;
  for (;;) {
    const rows = await tieThenRange<Row, number>(
      (filter, n) => coll.find(asFilter<Row>(filter), { projection }).sort({ seq: 1, _id: 1 }).limit(n).toArray(),
      after ? { seq: after.seq, _id: { $gt: after.id } } : null,
      after ? { seq: { $gt: after.seq } } : { seq: { $type: 'number' } },
      CHUNK,
    );
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < CHUNK) return;
    const last = rows[rows.length - 1]!;
    after = { seq: last.seq as number, id: last._id };
  }
}

/** Does the family carry a stored `writtenHere`? Tombstones do not: they carry `issuedHere`, a local mark the tombstone writer stamps. */
const hasWrittenHere = (part: SpacePart): boolean => part !== 'tombstones';

/**
 * The carry of one collection: the identity band for every row with a version and no position, then `writtenHere` for every row of a record family that has none.
 * Every filter names the field ABSENT, so a row that landed while the carry ran keeps what it was stamped with. Answers how many rows it positioned.
 */
async function carryRows(spaceId: string, part: SpacePart): Promise<number> {
  const coll = col<Row>(spaceCollection(spaceId, part));
  let positioned = 0;
  for await (const rows of chunksBySeq(coll, { seq: 1 })) {
    const ids = rows.map(r => r._id);
    const r = await coll.updateMany(
      asFilter<Row>({ _id: { $in: ids }, pos: { $exists: false }, seq: { $type: 'number' } }),
      [{ $set: { pos: '$seq', posAtSeq: '$seq' } }] as unknown as ReturnType<typeof asUpdate<Row>>,
    );
    positioned += r.modifiedCount;
    if (!hasWrittenHere(part)) continue;
    const unstamped = { _id: { $in: ids }, writtenHere: { $exists: false } };
    await coll.updateMany(asFilter<Row>(andPredicates(unstamped, writtenHereFilter()) ?? unstamped), asUpdate<Row>({ $set: { writtenHere: true } }));
    await coll.updateMany(asFilter<Row>(unstamped), asUpdate<Row>({ $set: { writtenHere: false } }));
  }
  // What the carry could not position: rows without a numeric version (pre-4.0 file rows), which no pager ever served.
  const left = await coll.countDocuments(asFilter<Row>({ pos: { $exists: false } }));
  if (left > 0) {
    positionsCarryUnpositionedTotal.labels({ collection: part }).inc(left);
    log.debug(`Space '${peerText(spaceId)}': ${left} row(s) of ${peerText(SPACE_COLLECTIONS[part])} carry no version and were left without a position`);
  }
  return positioned;
}

/**
 * The repair of one collection: every row with no position, or whose `posAtSeq` is not its `seq`, takes a fresh clock position (one block per chunk, held until its
 * write ends: `withLandingStamp`) and a recomputed `writtenHere`. The write is conditional on the row still being as it was read, so a local edit that landed with a
 * position of its own is never overwritten. Answers how many rows it repaired.
 *
 * Exported for the gates that stall a record-position holder behind a lock (`a-write-inside-a-seq-hold-always-ends-db`, `a-write-the-bound-ended-never-lands-db`): they
 * must see the bound's own timeout THROWN, which `finishPositionsOf` (a walk: it reports a failure and quarantines the space after one) never does.
 */
export async function repairRows(spaceId: string, part: SpacePart): Promise<number> {
  const coll = col<Row>(spaceCollection(spaceId, part));
  let repaired = 0;
  for await (const rows of chunksBySeq(coll, { seq: 1, pos: 1, posAtSeq: 1, author: 1, deliveredBy: 1 })) {
    const needing = rows.filter(r => typeof r.pos !== 'number' || r.posAtSeq !== r.seq);
    if (needing.length === 0) continue;
    await withLandingStamp(spaceId, needing.map(r => arrivalRow(r.seq as number)), (patches) => writeInOneCommands(needing.map((r, i) => ({
      updateOne: {
        filter: asFilter<Row>({ _id: r._id, seq: r.seq as number, $or: [{ pos: { $exists: false } }, { posAtSeq: { $ne: r.seq as number } }] }),
        update: asUpdate<Row>({ $set: { ...patches[i]!, ...(hasWrittenHere(part) ? { writtenHere: isWrittenHere(r) } : {}) } }),
      },
    })), (slice, { ordered }) => coll.bulkWrite(slice, { ordered }), { ordered: false }), 'positions.repair');
    repaired += needing.length;
  }
  return repaired;
}

/** One unit of a space's work. Answers how many rows it changed. */
async function doUnit(spaceId: string, kind: PositionsOwed, unit: Unit): Promise<number> {
  if (unit.kind === 'index') { await buildSpaceIndex(spaceId, unit.ix); return 0; }
  if (unit.kind === 'counter') { await repairPoisonedCounter(spaceId); return 0; }
  return kind === 'carry' ? carryRows(spaceId, unit.part) : repairRows(spaceId, unit.part);
}

/**
 * Do the work the space owes, to its end, and record it ready. Reads what it owes from the store; a space that owes nothing costs that one read. Never throws: a
 * unit that fails is said once per window by the shared reporter, the space stays owing, and the job finishes it. Called by the job's tick and, inline, by the acts
 * that make a space owe (a restore).
 */
export async function finishPositionsOf(spaceId: string): Promise<SpaceBackfillResult> {
  const kind = await positionsOwed(spaceId);
  if (!kind) return { finished: true, changed: 0, stop: false };
  const result = await backfillSpaceOnce<Unit>({
    step: STEP,
    spaceId,
    units: unitsOf(kind),
    unit: (u) => doUnit(spaceId, kind, u),
    label: unitName,
    markDone: () => recordPositionsReady(spaceId, kind),
    onFinished: (changed) => log.info(`Space '${peerText(spaceId)}': ${kind === 'carry' ? 'carried' : 'repaired'} the positions of ${changed} row(s); the space takes part in sync again.`),
    when: 'next tick',
  });
  forgetPositionsReady(spaceId);
  return result;
}

// ── the detector ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The spaces of this instance that owe work now, with what they owe. */
async function owingSpaces(): Promise<Array<{ spaceId: string; kind: PositionsOwed }>> {
  const configured = new Set(configuredSpaceIds());
  const docs = await counters().find(asFilter<SpaceCounterDoc>({ positionsOwed: { $in: ['carry', 'repair'] } }), { projection: { positionsOwed: 1 } }).toArray();
  return docs.filter(d => configured.has(d._id)).map(d => ({ spaceId: d._id, kind: d.positionsOwed as PositionsOwed }));
}

/** Set `ythril_positions_building_spaces` from the counter documents: what is owed now, by kind. */
async function refreshBuildingGauge(): Promise<void> {
  const owed = await counters().aggregate<{ _id: string; n: number }>([
    { $match: { positionsOwed: { $in: ['carry', 'repair'] } } }, { $group: { _id: '$positionsOwed', n: { $sum: 1 } } },
  ]).toArray();
  for (const kind of ['carry', 'repair'] as const) positionsBuildingSpaces.labels({ kind }).set(owed.find(o => o._id === kind)?.n ?? 0);
}

/** Mark a READY space as owing a repair. A space that owes already (a carry included) is left as it is; one with no counter document is not created. */
async function markRepair(spaceId: string): Promise<void> {
  await counters().updateOne(
    asFilter<SpaceCounterDoc>({ _id: spaceId, positionsOwed: { $exists: false }, positionsReadyAt: { $exists: true } }),
    asUpdate<SpaceCounterDoc>({ $set: { positionsOwed: 'repair' }, $unset: { positionsReadyAt: '' } }),
  );
  forgetPositionsReady(spaceId);
}

/**
 * The first 6.0 boot's part of the detector: every counter document with neither marker field (what 5.6 leaves) owes its first carry, the frozen marks and the
 * scanner cursors are carried by identity, every member that was synced is stamped as synced by this build, and `positionsSince` says so. The database writes come
 * first and the config write last, so a crash between them runs the whole of it again, which is harmless (every step is idempotent).
 */
async function firstCarry(): Promise<void> {
  const marked = await counters().updateMany(
    asFilter<SpaceCounterDoc>({ positionsOwed: { $exists: false }, positionsReadyAt: { $exists: false } }),
    asUpdate<SpaceCounterDoc>({ $set: { positionsOwed: 'carry' } }),
  );
  const cursors = await carryScanCursors();
  // The live config, read after the awaits above and written with no await between: a reload cannot land in the middle.
  const cfg = getConfig();
  let marks = 0;
  for (const net of cfg.networks ?? []) {
    marks += carryMarksToPositions(net);
    for (const member of net.members ?? []) if (member.lastSyncAt !== undefined && member.lastSyncAtBy6 === undefined) member.lastSyncAtBy6 = member.lastSyncAt;
  }
  cfg.positionsSince = new Date().toISOString();
  saveConfig(cfg);
  log.info(`Positions: the first carry is owed by ${marked.modifiedCount} space(s); ${marks} sync mark(s) and ${cursors} scanner cursor(s) were carried into position space by identity.`);
}

/**
 * What a 5.6 build left, as three questions about the counter documents and the members, asked on EVERY boot (the first one too: a 5.6 build can have run
 * between two 6.0 builds before the first carry's `positionsSince` was ever written, and the first carry's own marking cannot see it):
 *
 *  - a document with neither marker field owes a repair once `positionsSince` is written (a 5.6 rename replaced it, or 5.6 created the space; before it, the
 *    first carry has marked every such document `'carry'` already);
 *  - a READY space whose counter differs from the one this build last saw (`seq != seqSeenBy6`) was allocated in by a 5.6 build;
 *  - a member whose `lastSyncAt` differs from `lastSyncAtBy6` was synced by a 5.6 build, which can replace a row without moving a counter: every space of its
 *    networks owes a repair, and the member is stamped as read.
 *
 * A healthy 6.0 state trips none of them: every 6.0 writer of the counter keeps the two in step and every 6.0 writer of `lastSyncAt` goes through `stampLastSync`.
 */
async function whatFiveSixLeft(): Promise<void> {
  await counters().updateMany(
    asFilter<SpaceCounterDoc>({ positionsOwed: { $exists: false }, positionsReadyAt: { $exists: false } }),
    asUpdate<SpaceCounterDoc>({ $set: { positionsOwed: 'repair' } }),
  );
  await counters().updateMany(
    asFilter<SpaceCounterDoc>({ positionsOwed: { $exists: false }, positionsReadyAt: { $exists: true }, $expr: { $ne: ['$seq', { $ifNull: ['$seqSeenBy6', -1] }] } } as never),
    asUpdate<SpaceCounterDoc>({ $set: { positionsOwed: 'repair' }, $unset: { positionsReadyAt: '' } }),
  );
  const tripped = (getConfig().networks ?? []).flatMap(net => net.members.filter(syncedBy56).map(m => ({ netId: net.id, memberId: m.instanceId, at: m.lastSyncAt as string, localSpaces: net.spaces })));
  if (tripped.length === 0) return;
  for (const spaceId of new Set(tripped.flatMap(t => t.localSpaces))) await markRepair(spaceId);
  // The owed marker is durable now, so the member can be stamped. On the live config, and only a stamp this pass judged: a sync that completed meanwhile stamped both.
  const cfg = getConfig();
  for (const t of tripped) {
    const m = cfg.networks.find(n => n.id === t.netId)?.members.find(x => x.instanceId === t.memberId);
    if (m && t.at === m.lastSyncAt) m.lastSyncAtBy6 = t.at;
  }
  saveConfig(cfg);
  log.warn(`Positions: ${tripped.length} member(s) were synced by a 5.6 build since this build last ran (${tripped.map(t => peerText(t.memberId)).join(', ')}); every space of their networks owes a repair.`);
}

/**
 * The re-upgrade detector's one pass: what the first carry or a later boot has to mark (above), then the hold on every space is released and the gauge is set.
 * Run once per boot in phase 1, before the scheduler starts, and retried by the job while it is held. Throws when the store does not answer, which leaves the hold
 * armed: no transfer runs on a position a 5.6 build left stale.
 */
export async function detectReupgrade(): Promise<void> {
  if (getConfig().positionsSince === undefined) await firstCarry();
  await whatFiveSixLeft();
  releasePositionsHold();
  await refreshBuildingGauge();
}

/** The boot's call: arm the hold, run the detector, and on a failure leave the hold armed for the job to retry (said once). Never throws. */
export async function detectReupgradeAtBoot(): Promise<void> {
  holdPositionsUntilDetected();
  try {
    await detectReupgrade();
  } catch (err) {
    log.warn(`Positions: the re-upgrade check did not finish (${peerText(err)}); every space is held (503 positions_building) and the check is retried within a minute.`);
  }
}

// ── the job ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One tick of the owed job, to its end: the detector first while it is still held, then the work of every space that owes, one after another (a space's work is
 * a walk of its own under the housekeeping bound). A store that is not answering stops the loop. Awaited by the tests, which trigger a tick rather than wait for one.
 */
export async function runPositionsOwedTick(): Promise<void> {
  if (positionsHeldUntilDetected()) await detectReupgrade();
  for (const { spaceId } of await owingSpaces()) {
    if ((await finishPositionsOf(spaceId)).stop) break;
  }
  await refreshBuildingGauge();
}

const positionsOwedJob = intervalJob('Positions owed', POSITIONS_OWED_INTERVAL_MS, () => runPositionsOwedTick());

/** Start the job (idempotent). Phase 2 of the boot, beside the sync scheduler: a phase-1 hiccup does not stop it. */
export function startPositionsOwedJob(): void {
  if (positionsOwedJob.armed) return;
  positionsOwedJob.start();
  log.debug('Positions owed job started');
}

/** Stop the job: before the drain, so no tick starts over a closing connection. */
export function stopPositionsOwedJob(): void {
  positionsOwedJob.stop();
}
