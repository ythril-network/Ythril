/**
 * The ONE place a create/converge write reaches a record collection (`Q-99` part 3).
 *
 * A planner (`plan-*.ts`) has decided everything; this writes what was decided. One plan for a single-record
 * door, hundreds for a batch — the same code, so the two doors cannot mean different things. Per kind, in the
 * order `PLAN_KINDS` states, a stage is:
 *
 *  1. **one seq block and one `bulkWrite`** — the block is allocated immediately before the write that carries
 *     it (`withLandingStamp`), so the position-paged readers are held below the block for one round trip, not for a batch;
 *  2. **what landed**, read back when the write could not say: a per-operation failure maps to its item, an
 *     ambiguous one (a dropped connection) is settled by reading the minted ids, and a converge whose record moved
 *     since it was planned is reported STALE rather than overwritten (`expectSeq` is in the update's filter);
 *  3. **the landed items' link rows and embed jobs**, straight after their stage — never for an item whose own
 *     record did not land, and never left to the end where a later stage's failure would lose them.
 *
 * ## It does not throw once anything has landed
 *
 * A record that is stored and reported as failed is invited to be resent, and a resend without an id
 * duplicates it. So a failure past the first write becomes an item outcome or a warning, and the caller is told
 * what actually happened. A failure BEFORE anything landed (the seq block itself, or a stage's write that the
 * write bound ended) still throws: nothing is known written and there is nothing to report but the error — for a
 * timeout, the store-timeout every door answers 503 for.
 *
 * ## The stage writer is shared with the group commit (`Q-760`)
 *
 * `writeStage` — one kind's versions, its position block and its one `bulkWrite`, with the counts — is the one write of a planned record. Both
 * commits call it: this one maps what it reports to item outcomes (`stageOutcomes`); the group commit (`write-group.ts`) runs it inside one
 * transaction, where every error is thrown as it came (its labels kept, so a write conflict re-runs the transaction) and a short count aborts
 * the group. So this file stays the one place a create or converge reaches a record collection. What follows a landed stage (take-backs,
 * embed jobs, duplicate rules) is `runAfterCommit`'s (the last section below), asked per stage here and once after the commit there. It lives
 * in this file, not a module of its own: every module it names (the take-backs, the embed queue, the duplicate scanner) is in the server's
 * largest import cycle, which this file is already in, and a new module there would grow that cycle
 * (`check-i-architecture-dependency-direction`).
 *
 * ## What it is not
 *
 * Not the update or delete paths, not merge, re-key, redaction, sync ingest or file metadata — those keep their
 * own writes (`a-create-converge-write-lives-in-the-commit.test.js` names each). The link-row reconcile below is
 * the exception that proves the rule: the update paths call it too (`reconcileLinks`), so there is one writer of
 * link rows rather than two.
 */
import type { ClientSession } from 'mongodb';
import { col, asFilter, asBulk, asUpdate } from '../../db/mongo.js';
import { spaceCollection } from '../../db/space-collection.js';
import { versionsFor, versionsForRows, type RefusedVersion, type VersionAllocation } from '../../util/version-stamp.js';
import { withLandingStamp, localRow, type LocalLanding } from '../../sync/record-position-stream.js';
import { inChunks } from '../../util/chunks.js';
import { readStoredById, READ_CHUNK } from '../../db/read-by-id.js';
import { log, peerText } from '../../util/log.js';
import { bulkWriteFailures, phraseWriteFailure, onlyDuplicateKeys, DUPLICATE_KEY } from '../../db/write-errors.js';
import { FUNCTIONAL_GUARD, UNSET_GUARD } from '../../sync/local-only-fields.js';
import { isWriteTimeout } from '../../db/write-timeout.js';
import { writeFilterFor, RecordVersionAtCeiling, RECORD_VERSION_AT_CEILING } from '../write-precondition.js';
import { linkIdFor } from '../link-id.js';
import { removeWithTombstones } from '../tombstones.js';
import { takeBackEdgesToGoneEntities, takeBackLinksToGoneEntities } from '../gone-entity-references.js';
import { enqueueWriteEmbedJobs, EMBED_PRIORITY } from '../embed-queue.js';
import { mapLimit } from '../../util/map-limit.js';
import { EndpointRemoved, ENDPOINT_REMOVED } from '../../util/errors.js';
import { timePhase } from '../../http/phase-timer.js';
import { withSettlesJoined } from '../../util/position-clock.js';
import type { AuthorRef, EdgeDoc, LinkDoc, TombstoneDoc } from '../../config/types.js';
import type { RefKind } from '../../config/types-knowledge.js';
import type { DesiredLinks } from '../links.js';
import { COMMIT_ORDER, PLAN_KINDS, dependencyFailed, type CommitOutcome, type PlanKind, type WritePlan } from './types.js';
import { admitSpaceWrite, admitSpaceWriteUnit, assertSpaceTakesWrites, isSpaceNotWritable } from '../../spaces/space-write-gate.js';

/**
 * Write `plans` (all for `spaceId`) and say what happened to each, in the order given.
 *
 * `somethingLanded`: an EARLIER commit of the same request already stored something (a batch writing the edges that waited on a
 * re-planned record), so this commit is held to the promise above from its first stage: a failure is an outcome, never a throw.
 */
export async function commitPlans(
  spaceId: string, plans: readonly WritePlan[], opts: { somethingLanded?: boolean } = {},
): Promise<CommitOutcome[]> {
  // The triple index follows each stage's write while the work after it (link rows, embedding jobs) runs, and the commit returns only once
  // both are done (`withSettlesJoined`, bundle-378 Q-976 S3): every record door and kind saves through here.
  return withSettlesJoined(async () => {
    for (const p of plans) {
      if (p.spaceId !== spaceId) {
        throw new Error(`commitPlans: a plan decided for space '${p.spaceId}' was handed to a commit for '${spaceId}'`);
      }
      if (p.op === 'delete') throw new Error(`commitPlans: the ${p.kind} '${p.id}' is planned as a delete, which only a write group commits`);
    }
    const outcomes = new Array<CommitOutcome | undefined>(plans.length);
    const landed: number[] = [];
    const landedBefore = opts.somethingLanded === true;

    for (const kind of COMMIT_ORDER) {
      const ready: number[] = [];
      for (let i = 0; i < plans.length; i++) {
        if (plans[i]!.kind !== kind) continue;
        const failedDep = (plans[i]!.dependsOn ?? []).map(d => outcomes[d]).find(o => o !== undefined && !o.ok);
        if (failedDep && !failedDep.ok) {
          outcomes[i] = { ok: false, reason: dependencyFailed(failedDep.reason) };
        } else {
          ready.push(i);
        }
      }
      if (ready.length === 0) continue;
      // Asked per STAGE: a long write admitted before a deletion or wipe registered stops at its next stage. Before anything
      // landed the refusal is the request's answer (409); after, it is this stage's items' outcome, and the caller is told what
      // landed — a stored record reported failed would invite a duplicating resend.
      let leaveWriteUnit: () => void;
      try {
        leaveWriteUnit = admitSpaceWriteUnit(spaceId, PLAN_KINDS[kind].collection);
      } catch (err) {
        if ((landed.length === 0 && !landedBefore) || !isSpaceNotWritable(err)) throw err;
        for (const i of ready) outcomes[i] = { ok: false, reason: err.message };
        continue;
      }
      let stageLanded: number[];
      try {
        stageLanded = await stageOutcomes(spaceId, kind, plans, ready, outcomes, landed.length > 0 || landedBefore);
      } finally {
        leaveWriteUnit();
      }
      landed.push(...await timePhase('after', () => afterStage(spaceId, plans, stageLanded, outcomes)));
    }

    await runAfterCommit(spaceId, { dupeRules: landed.map(i => plans[i]!).filter(p => p.dupeRules) });
    return outcomes.map(o => o ?? { ok: false, reason: 'not written' });
  });
}

/** What one kind's stage write did (`writeStage`). Indexes are into the plans it was handed. */
export interface StageWrite {
  /** Per plan, in order: the version it took, or refused because its record's version is at the ceiling (that plan was not sent). */
  readonly rows: ReadonlyArray<VersionAllocation | RefusedVersion>;
  /** The plans sent to the write, and the version each carried (`stamps[k]` is `sent[k]`'s). */
  readonly sent: readonly number[];
  readonly stamps: readonly VersionAllocation[];
  /** The driver's counts: converges whose filter matched, and inserts made. */
  readonly matched: number;
  readonly inserted: number;
  /** Outside a session only: the write's own failure, handed back for the caller to map (`stageOutcomes`). Inside one it is thrown. */
  readonly writeError?: { readonly error: unknown };
}

/**
 * One kind's stage — every plan in `plans` is of `kind` — as ONE write: the versions (`versionsForRows`), one position block held around the
 * write (`withLandingStamp`), and one unordered `bulkWrite`; returns what the driver counted. The one write of a planned record (see the
 * module docblock).
 *
 * `session`: the group's transaction. Every read and the write carry it, and every error is thrown as it came, its labels kept: the transaction
 * is re-run on a transient one, and a duplicate key or a short count is the group's to abort on. Without one, a failure of the write itself is
 * handed back in `writeError`; a failure to take the versions or the position block is thrown.
 */
export async function writeStage(
  spaceId: string, kind: PlanKind, plans: readonly WritePlan[], opts: { session?: ClientSession } = {},
): Promise<StageWrite> {
  const { session } = opts;
  // A delete is not a write of a document: written here it would be a converge of nothing that stamps the record it meant to remove.
  const deleted = plans.find(p => p.op === 'delete');
  if (deleted) throw new Error(`writeStage: the ${kind} '${deleted.id}' is planned as a delete, which only a write group's removal writes`);
  const coll = col<{ _id: string; seq?: number }>(spaceCollection(spaceId, PLAN_KINDS[kind].collection));
  // Versions first, then the position block and the write under its hold (`withLandingStamp`): a version needs no hold, a position does.
  const rows = await timePhase('version', () => versionsForRows(spaceId, plans.map(p => p.id), { parts: [PLAN_KINDS[kind].collection], ...(session ? { session } : {}) }));
  const sent: number[] = [];
  const stamps: VersionAllocation[] = [];
  rows.forEach((row, k) => { if (!('refused' in row)) { sent.push(k); stamps.push(row); } });
  let matched = 0;
  let inserted = 0;
  let writeError: { error: unknown } | undefined;
  if (sent.length > 0) {
    await withLandingStamp(spaceId, stamps.map(s => localRow(s.version)), async (patches) => {
      try {
        const res = await timePhase('write', () => coll.bulkWrite(asBulk(sent.map((i, k) => opFor(plans[i]!, stamps[k]!, patches[k]!))),
          { ordered: false, ...(session ? { session } : {}) }));
        matched = res.matchedCount;
        inserted = res.insertedCount;
      } catch (error) {
        if (session) throw error;
        writeError = { error };
      }
    }, `write.${kind}`);
  }
  return { rows, sent, stamps, matched, inserted, ...(writeError ? { writeError } : {}) };
}

/** One kind's stage for `commitPlans`: written by `writeStage`, then mapped to item outcomes. Returns the indexes whose record landed; sets every index's outcome. */
async function stageOutcomes(
  spaceId: string, kind: PlanKind, plans: readonly WritePlan[], candidates: readonly number[],
  outcomes: Array<CommitOutcome | undefined>, somethingLanded: boolean,
): Promise<number[]> {
  let stage: StageWrite;
  try {
    stage = await writeStage(spaceId, kind, candidates.map(i => plans[i]!));
  } catch (err) {
    // The versions or the position block failed: nothing of this stage is known to be written.
    if (!somethingLanded) throw err;
    for (const i of candidates) outcomes[i] ??= { ok: false, reason: phraseWriteFailure(undefined) };
    log.warn(`write commit: the ${kind} stage for '${peerText(spaceId)}' could not start after earlier stages landed: ${peerText(String(err))}`);
    return [];
  }
  stage.rows.forEach((row, k) => {
    // The record's version is at the highest number sync accepts: this item is refused with its code, the other rows land.
    if ('refused' in row) outcomes[candidates[k]!] = { ok: false, reason: new RecordVersionAtCeiling(row.id).message, code: RECORD_VERSION_AT_CEILING };
  });
  const ready = stage.sent.map(k => candidates[k]!);
  const stamps = stage.stamps;
  if (ready.length === 0) return [];
  const matched = stage.matched;
  let failures: ReturnType<typeof bulkWriteFailures> = null;
  let ambiguous = false;
  if (stage.writeError) {
    const err = stage.writeError.error;
    /*
     * A write the bound ENDED is the store's failure, not an item's: rethrown, so the door answers the
     * store-timeout 503 every door answers (`brain/store-failure.ts`) rather than "did not complete" per item.
     * Only while nothing of this request has landed — after that the module's promise below wins (a stored
     * record reported failed invites a duplicating resend), so the stage is read back as any ambiguous one.
     */
    if (isWriteTimeout(err) && !somethingLanded) throw err;
    failures = bulkWriteFailures(err);
    if (!failures) ambiguous = true;
    /*
     * A duplicate key on an item is a LOST RACE, not a fault: the item is reported stale and re-planned against the
     * winner, so a busy functional subject would otherwise fill the log with a warning per loser. It is said at debug,
     * with the code, so that the one place a reader looks for why an item went stale still names it (`Q-439`).
     */
    const lostRace = failures !== null && onlyDuplicateKeys(failures);
    const detail = failures
      ? `${failures.length} item(s), code ${[...new Set(failures.map(f => f.code ?? 'none'))].join('/')}`
      : 'no per-item detail';
    (lostRace ? log.debug : log.warn)(`write commit: the ${kind} write to '${peerText(spaceId)}' reported a failure: ${detail}`);
  }

  const seqOf = (k: number) => stamps[k]!.version;
  const failedAt = new Map<number, number | undefined>();
  for (const f of (failures ?? []) as Array<{ index: number; code: number | undefined }>) failedAt.set(f.index, f.code);

  const converges = ready.map((i, k) => ({ i, k })).filter(({ i }) => plans[i]!.op === 'converge');
  // Read back what a write could not vouch for: everything after an ambiguous failure, and a converge that may
  // have matched nothing because its record moved since it was planned.
  const mustRead = ambiguous ? ready.map((i, k) => ({ i, k }))
    : converges.filter(({ k }) => !failedAt.has(k)).length > matched ? converges.filter(({ k }) => !failedAt.has(k)) : [];
  const storedSeq = await readSeqs(spaceCollection(spaceId, PLAN_KINDS[kind].collection), mustRead.map(({ i }) => plans[i]!.id));

  const landed: number[] = [];
  ready.forEach((i, k) => {
    const plan = plans[i]!;
    if (failedAt.has(k)) {
      const code = failedAt.get(k);
      outcomes[i] = { ok: false, reason: phraseWriteFailure(code), ...(code === DUPLICATE_KEY ? { stale: true } : {}) };
      return;
    }
    if (mustRead.some(m => m.k === k)) {
      if (storedSeq.get(plan.id) !== seqOf(k)) {
        outcomes[i] = plan.op === 'converge' && !ambiguous
          ? { ok: false, reason: 'the record was changed by another write while this one was being applied; nothing was written for this item — retry it', stale: true }
          : { ok: false, reason: phraseWriteFailure(undefined) };
        return;
      }
    }
    outcomes[i] = { ok: true, seq: seqOf(k) };
    landed.push(i);
  });
  return landed;
}

/**
 * Take a PHANTOM write guard off the edge holding it (`Q-439`): a marker that no longer names the `(from, label)` of the edge
 * it sits on, and so holds a subject's unique slot for an edge that is not there. The commit is the one writer of the guard —
 * it stores the marker the planner stamped — so the one clear lives beside it, and `heal-stale-marker.ts` decides WHEN.
 *
 * A compare-and-swap on `{ _id, guard, from, label }`, never a blind `$unset`: if the holder was relabelled, deleted or
 * healed since it was read, nothing matches and nothing is written. No seq: the guard is local to this instance, hashed and
 * replicated nowhere, so clearing it changes nothing a peer or a seq-paged reader could see.
 *
 * @returns whether THIS call cleared it.
 */
export async function clearStaleWriteGuard(
  spaceId: string, holder: { _id: string; from: string; label: string }, guard: string,
): Promise<boolean> {
  // A space whose edges an act is removing has no stale marker worth clearing: not cleared, never a failure of the caller's
  // own work (an index build at boot meets one too).
  try {
    return await admitSpaceWrite(spaceId, 'edges', async () => {
      const res = await col<EdgeDoc>(spaceCollection(spaceId, 'edges')).updateOne(
        asFilter<EdgeDoc>({ _id: holder._id, [FUNCTIONAL_GUARD]: guard, from: holder.from, label: holder.label }),
        asUpdate<EdgeDoc>({ $unset: UNSET_GUARD }),
      );
      return res.modifiedCount === 1;
    });
  } catch (err) { if (isSpaceNotWritable(err)) return false; throw err; }
}

/** The driver operation for one plan, stamped with its landing (`seq`, `pos`, `posAtSeq`, `writtenHere`). */
function opFor(plan: WritePlan, stamp: VersionAllocation, landing: LocalLanding): object {
  if (plan.op === 'insert') return { insertOne: { document: { ...plan.doc, ...landing } } };
  // A converge lands only on the version it planned against AND the version its stamp read (`writeFilterFor`, over `atReadSeq`: a record
  // that moved between the plan and the stamp is stale, and so is one that moved between the stamp and the write).
  const filter = writeFilterFor(plan.id, { readSeq: stamp.readSeq, ifMatchSeq: plan.expectSeq });
  const update: Record<string, unknown> = { $set: { ...plan.set, ...landing } };
  if (plan.unset && Object.keys(plan.unset).length > 0) update['$unset'] = plan.unset;
  return { updateOne: { filter, update } };
}

/**
 * The stored version of each of `ids` in a planned kind's collection, or in the link rows (`'link'`): what a write that could not vouch for itself
 * is read back by. `session`: read inside the group's transaction (a short count, which is no error, leaves it open).
 */
export async function storedVersions(
  spaceId: string, kind: PlanKind | 'link', ids: readonly string[], session?: ClientSession,
): Promise<Map<string, number | undefined>> {
  return readSeqs(spaceCollection(spaceId, kind === 'link' ? 'links' : PLAN_KINDS[kind].collection), ids, session);
}

async function readSeqs(collName: string, ids: readonly string[], session?: ClientSession): Promise<Map<string, number | undefined>> {
  const stored = await readStoredById<{ seq?: number }>(collName, ids, { seq: 1 }, session ? { session } : {});
  return new Map([...stored].map(([id, d]) => [id, d.seq]));
}

/**
 * The writer's half of the two-sided check (`brain/gone-entity-references.ts`, Q-305): an edge that landed against an entity deleted or merged away
 * since it was planned is taken back and its outcome says so. Returns the indexes of the edges taken back. Never throws: a failure to take one back is said,
 * and the edge keeps the outcome it had (a stored edge reported failed would invite a resend), so what is owed is in the log.
 */
async function refuseEdgesToGoneEntities(
  spaceId: string, plans: readonly WritePlan[], landed: readonly number[], outcomes: Array<CommitOutcome | undefined>,
): Promise<Set<number>> {
  const taken = new Set<number>();
  // A failure to check is said by `runAfterCommit` and the edges keep their outcomes.
  const { edgesTakenBack } = await runAfterCommit(spaceId, { edges: landed.map(i => landedEdgeOf(plans[i]!)) });
  for (const i of landed) {
    const end = edgesTakenBack.get(plans[i]!.id);
    if (!end) continue;
    taken.add(i);
    outcomes[i] = { ok: false, reason: new EndpointRemoved(end.id, end.side).message, code: ENDPOINT_REMOVED, removedEnd: end };
  }
  return taken;
}

/** The ends of a landed edge plan, as the take-back reads them. */
export function landedEdgeOf(plan: WritePlan): LandedEdge {
  const r = plan.result as { from: string; to: string; fromKind?: RefKind; toKind?: RefKind };
  return { _id: plan.id, from: r.from, to: r.to, fromKind: r.fromKind, toKind: r.toKind };
}

/** A landed stage's link rows and embed jobs. Returns the indexes that still stand. Never throws: the records are stored, and saying otherwise lies. */
async function afterStage(
  spaceId: string, plans: readonly WritePlan[], stageLanded: readonly number[], outcomes: Array<CommitOutcome | undefined>,
): Promise<number[]> {
  if (stageLanded.length === 0) return [];
  // Before the links and embed jobs: an edge taken back has nothing to link or embed.
  const takenBack = plans[stageLanded[0]!]!.kind === 'edge' ? await refuseEdgesToGoneEntities(spaceId, plans, stageLanded, outcomes) : new Set<number>();
  const landed = stageLanded.filter(i => !takenBack.has(i));
  if (landed.length === 0) return [];
  const withLinks = landed.filter(i => plans[i]!.links);
  if (withLinks.length > 0) {
    try {
      const counts = await reconcileLinkRows(spaceId, withLinks.map(i => ({
        from: plans[i]!.id, minted: plans[i]!.minted, ...plans[i]!.links!,
      })));
      withLinks.forEach((i, k) => {
        const o = outcomes[i];
        if (o?.ok) outcomes[i] = { ...o, linksAdded: counts[k]!.added, ...(counts[k]!.takenBack.length > 0 ? { linksTakenBack: counts[k]!.takenBack } : {}) };
      });
    } catch (err) {
      // The records are stored, so their outcomes stay `ok`: reporting them failed would invite a resend that
      // duplicates. What did not land is the links, and this is what says so.
      log.warn(`write commit: ${withLinks.length} record(s) in '${peerText(spaceId)}' were written but their link rows were not: `
        + `${peerText(err)}. Re-sending the same write (with its id) repairs them.`);
    }
  }
  // Never throws: a job not queued is said by `runAfterCommit`, and the records stay written.
  await runAfterCommit(spaceId, { embed: landed.filter(i => plans[i]!.enqueue).map(i => ({ recordType: plans[i]!.kind, recordId: plans[i]!.id })) });
  return landed;
}

/** One record's link reconcile: what it should link to, and whether it was minted this instant. */
export interface LinkReconcile {
  from: string;
  fromKind: RefKind;
  desired: DesiredLinks;
  author: AuthorRef;
  /** Minted by the write that is reconciling it: it can have no link rows yet, so none are read. */
  minted: boolean;
}

/** The connections a record's write wants, by derived link id. A record naming the same id twice is one connection — the Map dedupes it. */
function wantedLinks(r: LinkReconcile): Map<string, { to: string; toKind: RefKind }> {
  const wanted = new Map<string, { to: string; toKind: RefKind }>();
  for (const toKind of Object.keys(r.desired) as RefKind[]) {
    for (const to of r.desired[toKind] ?? []) wanted.set(linkIdFor(r.from, r.fromKind, to, toKind), { to, toKind });
  }
  return wanted;
}

/**
 * The stored link rows of the classes each of `records` names, by record (`existingBy[i]`), with each row's version. The one read of "what is
 * stored" for the reconcile and for the count of what a converge will drop ({@link countDroppedLinkRows}): a minted record, and one naming no
 * class, has none read. `session`: read inside a write group's transaction.
 */
async function readExistingLinkRows(spaceId: string, records: readonly LinkReconcile[], session?: ClientSession) {
  const linksColl = col<LinkDoc>(spaceCollection(spaceId, 'links'));
  const existingBy = records.map(() => [] as string[]);
  const seqOfExisting = new Map<string, number | undefined>();
  const toRead = records.map((r, i) => ({ r, i })).filter(({ r }) => !r.minted && Object.keys(r.desired).length > 0);
  for (const chunk of inChunks(toRead, READ_CHUNK)) {
    const rows = await linksColl.find(asFilter<LinkDoc>({
      spaceId,
      // Only the classes each write TOUCHED: a patch naming `linkEntities` alone must not disturb fact links.
      $or: chunk.map(({ r }) => ({ from: r.from, fromKind: r.fromKind, toKind: { $in: Object.keys(r.desired) } })),
    }), { projection: { _id: 1, from: 1, fromKind: 1, toKind: 1, seq: 1 }, ...(session ? { session } : {}) }).toArray() as Array<Pick<LinkDoc, '_id' | 'from' | 'fromKind' | 'toKind' | 'seq'>>;
    for (const { r, i } of chunk) {
      const classes = new Set(Object.keys(r.desired));
      const mine = rows.filter(row => row.from === r.from && row.fromKind === r.fromKind && classes.has(row.toKind));
      existingBy[i] = mine.map(row => row._id);
      // The seq each row has, so the tombstone of one this reconcile removes carries it (`writeTombstones`).
      for (const row of mine) seqOfExisting.set(row._id, row.seq);
    }
  }
  return { existingBy, seqOfExisting };
}

/**
 * How many stored link rows a non-additive {@link reconcileLinkRows} of `records` removes: the rows of the classes each names that its write no
 * longer wants. Read before a write group's session opens, so the group's ceilings count the removals and their tombstones.
 */
export async function countDroppedLinkRows(spaceId: string, records: readonly LinkReconcile[]): Promise<number> {
  const { existingBy } = await readExistingLinkRows(spaceId, records);
  let dropped = 0;
  records.forEach((r, i) => {
    const wanted = wantedLinks(r);
    dropped += existingBy[i]!.filter(id => !wanted.has(id)).length;
  });
  return dropped;
}

/** A group's reconcile would remove more link rows than its ceilings counted: rows arrived after the count. Nothing was removed. */
export class LinkRemovalsOverCount extends Error {
  constructor(readonly counted: number, readonly found: number) {
    super(`a reconcile would remove ${found} link row(s), and the ${counted} it was counted for were all it may remove`);
    this.name = 'LinkRemovalsOverCount';
  }
}

/**
 * Make each record's link rows equal what its write says — the one writer of link rows.
 *
 * `desired` names only the classes the caller wrote; a class it omits is left alone, an empty array removes.
 * Existing rows are read in one query for every record that was not minted this instant, and the removals and
 * the additions are each one seq block: a seq PER ROW, because `pageBySeq` continues from the last item's seq
 * with `seq > since`, so two rows sharing one at a page boundary would leave the rest unreachable.
 *
 * A removal writes its TOMBSTONE — a link deleted without one comes back on the next pull from any peer that
 * still holds it — and a re-created link clears the tombstone that retired it, or the next pull would delete it
 * again on the strength of a deletion the caller has since reversed.
 *
 * ## Inside a transaction (`Q-760`)
 *
 * Given `opts.session` (a write group's), every read and write here carries it, and the take-back of rows naming an entity removed meanwhile
 * does NOT run: it reads what is committed, and these rows are not until the group commits. Their rows are pushed onto `opts.owed` instead,
 * for the caller to check after its commit (`runAfterCommit`); `takenBack` stays empty.
 *
 * @param opts.additive create and never delete — the link conversion's question, see `reconcileLinks`.
 * @param opts.removalCeiling inside a transaction: the rows the caller counted this reconcile would remove ({@link countDroppedLinkRows}); more
 * rows to remove than that throws {@link LinkRemovalsOverCount} before any is removed.
 */
export async function reconcileLinkRows(
  spaceId: string, records: readonly LinkReconcile[],
  opts: { additive?: boolean } & ({ session?: undefined; owed?: undefined; removalCeiling?: undefined }
    | { session: ClientSession; owed: LandedLinkRow[]; removalCeiling?: number }) = {},
): Promise<Array<{ added: number; removed: number; takenBack: string[] }>> {
  const { session } = opts;
  const inSession = session ? { session } : {};
  // Refused before the rows are read; the removals and additions below are admitted and counted again, at the instant they are made.
  assertSpaceTakesWrites(spaceId, 'links');
  const wantedBy = records.map(wantedLinks);
  const { existingBy, seqOfExisting } = await readExistingLinkRows(spaceId, records, session);
  const linksColl = col<LinkDoc>(spaceCollection(spaceId, 'links'));

  const removals: string[] = [];
  const additions: Array<{ _id: string; r: LinkReconcile; at: number; to: string; toKind: RefKind }> = [];
  const counts = records.map((r, i) => {
    const have = new Set(existingBy[i]);
    const removed = opts.additive ? [] : existingBy[i]!.filter(id => !wantedBy[i]!.has(id));
    const added = [...wantedBy[i]!].filter(([id]) => !have.has(id));
    removals.push(...removed);
    for (const [_id, { to, toKind }] of added) additions.push({ _id, r, at: i, to, toKind });
    return { added: added.length, removed: removed.length, takenBack: [] as string[] };
  });
  // A group counted the rows its converges drop before its session opened: more rows read than were counted means rows arrived since, and the
  // group's ceilings did not count them. Refused before anything is removed.
  if (opts.removalCeiling !== undefined && removals.length > opts.removalCeiling) throw new LinkRemovalsOverCount(opts.removalCeiling, removals.length);

  const tombstones = col<TombstoneDoc>(spaceCollection(spaceId, 'tombstones'));
  const now = new Date().toISOString();
  // The removals and the additions are ONE admitted and counted unit (`admitSpaceWrite`): the additions CREATE link rows.
  await admitSpaceWrite(spaceId, 'links', async () => {
    if (removals.length > 0) {
      // The rows go, then their tombstones — stamped first (a link at the ceiling refuses the removal whole) and each carrying the row's seq.
      await removeWithTombstones(spaceId, 'links',
        removals.map(_id => ({ _id, type: 'link' as const, deletedAt: now, originalSeq: seqOfExisting.get(_id) })), { filter: { spaceId }, ...inSession });
    }
    if (additions.length > 0) {
      // Each row's version above any tombstone held for its id (a re-created link clears the one that retired it, below).
      const versions = await versionsFor(spaceId, additions.map(a => a._id), { parts: ['links'], ...inSession });
      await withLandingStamp(spaceId, versions.map(v => localRow(v.version)), async (patches) => {
        await linksColl.bulkWrite(asBulk(additions.map(({ _id, r, to, toKind }, i) => ({
          replaceOne: {
            filter: { _id, spaceId },
            replacement: {
              _id, spaceId, from: r.from, fromKind: r.fromKind, to, toKind, author: r.author,
              createdAt: now, updatedAt: now, ...patches[i]!,
            } satisfies LinkDoc,
            upsert: true,
          },
        }))), { ordered: false, ...inSession });
        await tombstones.deleteMany(asFilter<TombstoneDoc>({ _id: { $in: additions.map(a => a._id) } }), inSession);
      }, 'link.reconcile.add');
      const landedRows = additions.map((a, i) => ({ _id: a._id, to: a.to, toKind: a.toKind, seq: versions[i]!.version }));
      // Inside a transaction the rows are not visible yet: the take-back is the caller's, after its commit (see the docblock).
      if (opts.owed) { opts.owed.push(...landedRows); return; }
      // The writer's half of the two-sided check (Q-305): a row that names an entity deleted meanwhile is taken back, and the record that carried it keeps its write.
      const taken = await takeBackLinksToGoneEntities(spaceId, landedRows);
      for (const a of additions) {
        const entityId = taken.get(a._id);
        if (entityId === undefined) continue;
        counts[a.at]!.added--;
        counts[a.at]!.takenBack.push(entityId);
      }
    }
  });
  return counts;
}

// ── What follows a landed write ─────────────────────────────────────────────────────────────────────────────

/*
 * ## What follows a planned write once its records are COMMITTED — the one runner of it for both commits (`Q-760`).
 *
 * ## The question it answers
 *
 * *"These records landed: take back what names an entity removed meanwhile, queue their embed jobs, run their duplicate rules, and say what
 * did not happen."* `commitPlans` (`commit.ts`) asks it per stage, as it always did; the group commit (`write-group.ts`) asks it once, after
 * its transaction committed.
 *
 * ## What it prevents
 *
 * **An effect of a write that never landed.** Inside a group's transaction nothing is visible until the commit, and an aborted group leaves
 * nothing: an embed job queued, a duplicate rule run or a take-back made from inside the callback would act on records that may never exist,
 * or miss the rows it is meant to check (the take-back's two-sided handshake needs the write visible, `gone-entity-references.ts`). So these
 * effects take a list of LANDED records and run here, never inside a transaction.
 *
 * **A failure that is said nowhere.** An effect that fails after a commit is not the write's failure (the records are stored, and saying
 * otherwise invites a duplicating resend), and it is not nothing either: each failed effect is logged once AND returned, so the caller can
 * report it (`failed`). Nothing here throws.
 *
 * ## What it does not do
 *
 * It writes no record and no link row of its own: a take-back removes, through the one remover (`removeRecords`, `removeWithTombstones`),
 * rows that a write landed against an entity that was deleted or merged away meanwhile. Webhooks are the door's.
 */

/** Insert-time duplicate rules run at most this many at once — each is a vector search. */
const DUPE_RULE_CONCURRENCY = 4;

/** A landed edge whose entity ends are checked against entities removed meanwhile. */
export interface LandedEdge { readonly _id: string; readonly from: string; readonly to: string; readonly fromKind?: RefKind; readonly toKind?: RefKind }
/** A landed link row, checked likewise; `seq` is the version it landed at (its tombstone carries it). */
export interface LandedLinkRow { readonly _id: string; readonly to: string; readonly toKind: string; readonly seq: number }

/** The effects owed to records that landed. Every list is optional; an absent or empty one costs nothing. */
export interface AfterCommitEffects {
  /** Edges to take back when an entity end was removed while they were written. */
  readonly edges?: readonly LandedEdge[];
  /** Link rows to take back when the entity they point at was removed while they were written. */
  readonly linkRows?: readonly LandedLinkRow[];
  /** Records to queue for embedding. A record whose edge was taken back above is not queued. */
  readonly embed?: ReadonlyArray<{ readonly recordType: PlanKind; readonly recordId: string }>;
  /** Records whose insert-time duplicate rules run (never awaited). */
  readonly dupeRules?: ReadonlyArray<{ readonly kind: PlanKind; readonly id: string }>;
}

/** One effect that did not complete after its records landed: what it was, how many records it was for, and why. */
export interface FailedEffect {
  /** `removal`: a write group's deleted records' tail (`afterRemovalCommitted`: embed jobs, forks, the kind's cascade and take-back). */
  readonly effect: 'edge-take-back' | 'link-take-back' | 'embed' | 'removal';
  readonly count: number;
  readonly error: unknown;
}

/** What the effects did: what was taken back (a LANDED row removed again), and what failed. */
export interface AfterCommitReport {
  /** Edge id to the entity end that was gone. */
  readonly edgesTakenBack: ReadonlyMap<string, { readonly id: string; readonly side: 'from' | 'to' }>;
  /** Link id to the id of the entity it pointed at. */
  readonly linksTakenBack: ReadonlyMap<string, string>;
  readonly failed: readonly FailedEffect[];
}

/**
 * Run the effects owed to records that landed in `spaceId` — see the module docblock. Never throws.
 */
export async function runAfterCommit(spaceId: string, effects: AfterCommitEffects): Promise<AfterCommitReport> {
  const failed: FailedEffect[] = [];
  let edgesTakenBack: ReadonlyMap<string, { id: string; side: 'from' | 'to' }> = new Map();
  let linksTakenBack: ReadonlyMap<string, string> = new Map();
  const edges = effects.edges ?? [];
  if (edges.length > 0) {
    try {
      edgesTakenBack = await takeBackEdgesToGoneEntities(spaceId, edges);
    } catch (error) {
      failed.push({ effect: 'edge-take-back', count: edges.length, error });
      log.warn(`write commit: ${edges.length} edge(s) written to '${peerText(spaceId)}' could not be checked against entities removed meanwhile: ${peerText(error)}`);
    }
  }
  const linkRows = effects.linkRows ?? [];
  if (linkRows.length > 0) {
    try {
      linksTakenBack = await takeBackLinksToGoneEntities(spaceId, linkRows);
    } catch (error) {
      failed.push({ effect: 'link-take-back', count: linkRows.length, error });
      log.warn(`write commit: ${linkRows.length} link row(s) written to '${peerText(spaceId)}' could not be checked against entities removed meanwhile: ${peerText(error)}`);
    }
  }
  // An edge taken back has nothing to embed.
  const toQueue = (effects.embed ?? []).filter(r => !(r.recordType === 'edge' && edgesTakenBack.has(r.recordId)));
  if (toQueue.length > 0) {
    // The write lane never throws by contract (it answers how many it could not queue); the catch holds this module to its own promise whatever the lane does.
    const queued = await enqueueWriteEmbedJobs(spaceId, toQueue, { priority: EMBED_PRIORITY.write })
      .catch((error: unknown) => ({ queued: 0, failed: toQueue.length, error }));
    if (queued.failed > 0) {
      // The lane says its own failure in the log; one it threw (it never should) is said here.
      const thrown = 'error' in queued;
      const error = thrown ? queued.error : new Error(`${queued.failed} embed job(s) were not queued`);
      failed.push({ effect: 'embed', count: queued.failed, error });
      if (thrown) log.warn(`write commit: ${queued.failed} record(s) in '${peerText(spaceId)}' were written but not queued for embedding: ${peerText(String(error))}`);
    }
  }
  runDupeRules(spaceId, effects.dupeRules ?? []);
  return { edgesTakenBack, linksTakenBack, failed };
}

/** Insert-time duplicate rules for the landed records that asked for them — bounded, and never awaited by the write. */
function runDupeRules(spaceId: string, records: ReadonlyArray<{ kind: PlanKind; id: string }>): void {
  if (records.length === 0) return;
  // The dynamic import avoids a static cycle with dupe-scanner.js.
  void import('../dupe-scanner.js').then(m => mapLimit(records, DUPE_RULE_CONCURRENCY, async (p) => {
    try { await m.evaluateRecordForDuplicates(spaceId, p.kind as Parameters<typeof m.evaluateRecordForDuplicates>[1], p.id); }
    catch { /* best-effort: a duplicate rule never fails the write it follows */ }
  })).catch(() => { /* best-effort */ });
}
