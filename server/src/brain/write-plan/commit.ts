/**
 * The ONE place a create/converge write reaches a record collection (`Q-99` part 3).
 *
 * A planner (`plan-*.ts`) has decided everything; this writes what was decided. One plan for a single-record
 * door, hundreds for a batch — the same code, so the two doors cannot mean different things. Per kind, in the
 * order `PLAN_KINDS` states, a stage is:
 *
 *  1. **one seq block and one `bulkWrite`** — the block is allocated immediately before the write that carries
 *     it (`withAllocatedSeqs`), so the seq-paged readers' horizon is held for one round trip, not for a batch;
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
 * ## What it is not
 *
 * Not the update or delete paths, not merge, re-key, redaction, sync ingest or file metadata — those keep their
 * own writes (`a-create-converge-write-lives-in-the-commit.test.js` names each). The link-row reconcile below is
 * the exception that proves the rule: the update paths call it too (`reconcileLinks`), so there is one writer of
 * link rows rather than two.
 */
import { col, asFilter, asBulk, asUpdate } from '../../db/mongo.js';
import { spaceCollection } from '../../db/space-collection.js';
import { withAllocatedSeqs } from '../../util/seq.js';
import { inChunks } from '../../util/chunks.js';
import { readStoredById, READ_CHUNK } from '../../db/read-by-id.js';
import { mapLimit } from '../../util/map-limit.js';
import { log, peerText } from '../../util/log.js';
import { bulkWriteFailures, phraseWriteFailure, onlyDuplicateKeys, DUPLICATE_KEY } from '../../db/write-errors.js';
import { FUNCTIONAL_GUARD, UNSET_GUARD } from '../../sync/local-only-fields.js';
import { isWriteTimeout } from '../../db/write-timeout.js';
import { writeFilterFor } from '../write-precondition.js';
import { enqueueWriteEmbedJobs, EMBED_PRIORITY } from '../embed-queue.js';
import { linkIdFor } from '../link-id.js';
import { writeTombstones } from '../tombstones.js';
import type { AuthorRef, EdgeDoc, LinkDoc, TombstoneDoc } from '../../config/types.js';
import type { RefKind } from '../../config/types-knowledge.js';
import type { DesiredLinks } from '../links.js';
import { COMMIT_ORDER, PLAN_KINDS, type CommitOutcome, type PlanKind, type WritePlan } from './types.js';

/** Insert-time duplicate rules run at most this many at once — each is a vector search. */
const DUPE_RULE_CONCURRENCY = 4;

/** Write `plans` (all for `spaceId`) and say what happened to each, in the order given. */
export async function commitPlans(spaceId: string, plans: readonly WritePlan[]): Promise<CommitOutcome[]> {
  for (const p of plans) {
    if (p.spaceId !== spaceId) {
      throw new Error(`commitPlans: a plan decided for space '${p.spaceId}' was handed to a commit for '${spaceId}'`);
    }
  }
  const outcomes = new Array<CommitOutcome | undefined>(plans.length);
  const landed: number[] = [];

  for (const kind of COMMIT_ORDER) {
    const ready: number[] = [];
    for (let i = 0; i < plans.length; i++) {
      if (plans[i]!.kind !== kind) continue;
      const failedDep = (plans[i]!.dependsOn ?? []).map(d => outcomes[d]).find(o => o !== undefined && !o.ok);
      if (failedDep && !failedDep.ok) {
        outcomes[i] = { ok: false, reason: `it depends on an item of this request that was not written: ${failedDep.reason}` };
      } else {
        ready.push(i);
      }
    }
    if (ready.length === 0) continue;
    const stageLanded = await writeStage(spaceId, kind, plans, ready, outcomes, landed.length > 0);
    landed.push(...stageLanded);
    await afterStage(spaceId, plans, stageLanded, outcomes);
  }

  runDupeRules(spaceId, landed.map(i => plans[i]!).filter(p => p.dupeRules));
  return outcomes.map(o => o ?? { ok: false, reason: 'not written' });
}

/** One kind's block write. Returns the indexes whose record landed; sets every index's outcome. */
async function writeStage(
  spaceId: string, kind: PlanKind, plans: readonly WritePlan[], ready: readonly number[],
  outcomes: Array<CommitOutcome | undefined>, somethingLanded: boolean,
): Promise<number[]> {
  const coll = col<{ _id: string; seq?: number }>(spaceCollection(spaceId, PLAN_KINDS[kind].collection));
  let first = 0;
  let failures: ReturnType<typeof bulkWriteFailures> = null;
  let ambiguous = false;
  let matched = 0;
  try {
    await withAllocatedSeqs(spaceId, ready.length, async (block) => {
      first = block;
      try {
        const res = await coll.bulkWrite(asBulk(ready.map((i, k) => opFor(plans[i]!, block + k))), { ordered: false });
        matched = res.matchedCount;
      } catch (err) {
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
    }, `write.${kind}`);
  } catch (err) {
    // The seq block itself failed, or its write timed out: nothing of this stage is known to be written.
    if (!somethingLanded) throw err;
    for (const i of ready) outcomes[i] = { ok: false, reason: phraseWriteFailure(undefined) };
    log.warn(`write commit: the ${kind} stage for '${peerText(spaceId)}' could not start after earlier stages landed: ${peerText(String(err))}`);
    return [];
  }

  const seqOf = (k: number) => first + k;
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
  const res = await col<EdgeDoc>(spaceCollection(spaceId, 'edges')).updateOne(
    asFilter<EdgeDoc>({ _id: holder._id, [FUNCTIONAL_GUARD]: guard, from: holder.from, label: holder.label }),
    asUpdate<EdgeDoc>({ $unset: UNSET_GUARD }),
  );
  return res.modifiedCount === 1;
}

/** The driver operation for one plan, stamped with its seq. */
function opFor(plan: WritePlan, seq: number): object {
  if (plan.op === 'insert') return { insertOne: { document: { ...plan.doc, seq } } };
  // A converge lands only on the version it planned against; any other plan, unconditionally — the one filter
  // every update writes through (`writeFilterFor`, over `atReadSeq`).
  const filter = writeFilterFor(plan.id, plan.expectSeq);
  const update: Record<string, unknown> = { $set: { ...plan.set, seq } };
  if (plan.unset && Object.keys(plan.unset).length > 0) update['$unset'] = plan.unset;
  return { updateOne: { filter, update } };
}

async function readSeqs(collName: string, ids: readonly string[]): Promise<Map<string, number | undefined>> {
  const stored = await readStoredById<{ seq?: number }>(collName, ids, { seq: 1 });
  return new Map([...stored].map(([id, d]) => [id, d.seq]));
}

/** A landed stage's link rows and embed jobs. Never throws: the records are stored, and saying otherwise lies. */
async function afterStage(
  spaceId: string, plans: readonly WritePlan[], landed: readonly number[], outcomes: Array<CommitOutcome | undefined>,
): Promise<void> {
  if (landed.length === 0) return;
  const withLinks = landed.filter(i => plans[i]!.links);
  if (withLinks.length > 0) {
    try {
      const counts = await reconcileLinkRows(spaceId, withLinks.map(i => ({
        from: plans[i]!.id, minted: plans[i]!.minted, ...plans[i]!.links!,
      })));
      withLinks.forEach((i, k) => {
        const o = outcomes[i];
        if (o?.ok) outcomes[i] = { ...o, linksAdded: counts[k]!.added };
      });
    } catch (err) {
      // The records are stored, so their outcomes stay `ok`: reporting them failed would invite a resend that
      // duplicates. What did not land is the links, and this is what says so.
      log.warn(`write commit: ${withLinks.length} record(s) in '${peerText(spaceId)}' were written but their link rows were not: `
        + `${peerText(err)}. Re-sending the same write (with its id) repairs them.`);
    }
  }
  const toQueue = landed.filter(i => plans[i]!.enqueue).map(i => ({ recordType: plans[i]!.kind, recordId: plans[i]!.id }));
  // The write lane never throws by contract; this holds the commit to its own promise whatever the lane does.
  if (toQueue.length > 0) {
    await enqueueWriteEmbedJobs(spaceId, toQueue, { priority: EMBED_PRIORITY.write }).catch((err: unknown) => {
      log.warn(`write commit: ${toQueue.length} record(s) in '${peerText(spaceId)}' were written but not queued for embedding: ${peerText(String(err))}`);
    });
  }
}

/** Insert-time duplicate rules for the landed records that asked for them — bounded, and never awaited by the write. */
function runDupeRules(spaceId: string, plans: readonly WritePlan[]): void {
  if (plans.length === 0) return;
  // The dynamic import avoids a static cycle with dupe-scanner.js.
  void import('../dupe-scanner.js').then(m => mapLimit(plans, DUPE_RULE_CONCURRENCY, async (p) => {
    try { await m.evaluateRecordForDuplicates(spaceId, p.kind as Parameters<typeof m.evaluateRecordForDuplicates>[1], p.id); }
    catch { /* best-effort: a duplicate rule never fails the write it follows */ }
  })).catch(() => { /* best-effort */ });
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
 * @param opts.additive create and never delete — the link conversion's question, see `reconcileLinks`.
 */
export async function reconcileLinkRows(
  spaceId: string, records: readonly LinkReconcile[], opts: { additive?: boolean } = {},
): Promise<Array<{ added: number; removed: number }>> {
  const wantedBy = records.map(r => {
    const wanted = new Map<string, { to: string; toKind: RefKind }>();
    for (const toKind of Object.keys(r.desired) as RefKind[]) {
      // A record naming the same id twice is one connection — the Map dedupes it by the derived id.
      for (const to of r.desired[toKind] ?? []) wanted.set(linkIdFor(r.from, r.fromKind, to, toKind), { to, toKind });
    }
    return wanted;
  });

  const linksColl = col<LinkDoc>(spaceCollection(spaceId, 'links'));
  const existingBy = records.map(() => [] as string[]);
  const seqOfExisting = new Map<string, number | undefined>();
  const toRead = records.map((r, i) => ({ r, i })).filter(({ r }) => !r.minted && Object.keys(r.desired).length > 0);
  for (const chunk of inChunks(toRead, READ_CHUNK)) {
    const rows = await linksColl.find(asFilter<LinkDoc>({
      spaceId,
      // Only the classes each write TOUCHED: a patch naming `linkEntities` alone must not disturb fact links.
      $or: chunk.map(({ r }) => ({ from: r.from, fromKind: r.fromKind, toKind: { $in: Object.keys(r.desired) } })),
    }), { projection: { _id: 1, from: 1, fromKind: 1, toKind: 1, seq: 1 } }).toArray() as Array<Pick<LinkDoc, '_id' | 'from' | 'fromKind' | 'toKind' | 'seq'>>;
    for (const { r, i } of chunk) {
      const classes = new Set(Object.keys(r.desired));
      const mine = rows.filter(row => row.from === r.from && row.fromKind === r.fromKind && classes.has(row.toKind));
      existingBy[i] = mine.map(row => row._id);
      // The seq each row has, so the tombstone of one this reconcile removes carries it (`writeTombstones`).
      for (const row of mine) seqOfExisting.set(row._id, row.seq);
    }
  }

  const removals: string[] = [];
  const additions: Array<{ _id: string; r: LinkReconcile; to: string; toKind: RefKind }> = [];
  const counts = records.map((r, i) => {
    const have = new Set(existingBy[i]);
    const removed = opts.additive ? [] : existingBy[i]!.filter(id => !wantedBy[i]!.has(id));
    const added = [...wantedBy[i]!].filter(([id]) => !have.has(id));
    removals.push(...removed);
    for (const [_id, { to, toKind }] of added) additions.push({ _id, r, to, toKind });
    return { added: added.length, removed: removed.length };
  });

  const tombstones = col<TombstoneDoc>(spaceCollection(spaceId, 'tombstones'));
  const now = new Date().toISOString();
  if (removals.length > 0) {
    // The rows go, then their tombstones — one seq block taken at their write, each carrying the row's seq.
    await linksColl.deleteMany(asFilter<LinkDoc>({ _id: { $in: removals }, spaceId }));
    await writeTombstones(spaceId, removals.map(_id => ({ _id, type: 'link', deletedAt: now, originalSeq: seqOfExisting.get(_id) })));
  }
  if (additions.length > 0) {
    await withAllocatedSeqs(spaceId, additions.length, async (first) => {
      await linksColl.bulkWrite(asBulk(additions.map(({ _id, r, to, toKind }, i) => ({
        replaceOne: {
          filter: { _id, spaceId },
          replacement: {
            _id, spaceId, from: r.from, fromKind: r.fromKind, to, toKind, author: r.author,
            createdAt: now, updatedAt: now, seq: first + i,
          } satisfies LinkDoc,
          upsert: true,
        },
      }))), { ordered: false });
      await tombstones.deleteMany(asFilter<TombstoneDoc>({ _id: { $in: additions.map(a => a._id) } }));
    }, 'link.reconcile.add');
  }
  return counts;
}
