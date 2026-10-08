/**
 * Accept an arriving page — ONE rule for every door a peer's records come through (`Q-204`, `Q-225`, `Q-232`):
 * `POST /api/sync/batch-upsert`, the four single-record push routes (a page of one), and the engine's PULL.
 * Moved here from `api/sync/docs.ts` (`acceptPushedPage`), where it served the push alone; the pull accepted by seq
 * and validated nothing.
 *
 * ## Why one function for both doors
 *
 * Push and pull are two doors to one arrival, and each was individually defensible: the push planned each page
 * (a held tombstone governs a record its issuer authored, an equal-seq divergent fact FORKS within the caps, an
 * in-page unique-key collision is decided first-accepted-wins) and validated every document against its `Incoming*`
 * schema, while the pull wrote whatever was newer by seq. So the same document delivered the other way round
 * resurrected a deleted record, dropped one side of a divergence, stored a key the schema strips and a field of the
 * wrong type, and stored a file whose `parentFileId` was not a string as a top-level file. The gap was only visible
 * by sending one document through both, which `push-and-pull-decide-alike-db` now does for every verdict.
 *
 * ## The order, and why each step is where it is
 *
 *  1. **Validate** (`admitArrivals`, `sync/arrival-shape.ts`): the family's wire schema, then the writer's shape
 *     rule. A refused document is `rejected` on its own, never planned and never bumped over.
 *  2. **Plan** each family against what is stored (`planArrivals`, pure): one tombstone read for the page, one
 *     stored read per family, and fork reads only for facts that may fork. The door is told to the planner for its
 *     one stated difference (a chrono type outside the vocabulary is dropped on push only).
 *  3. **Write** the winners through `writeArrivals`. A winner whose write fails (a unique-index duplicate, a store
 *     refusal) is replaced by the version the page accepted before it, so the outcome stays the sequential one. A
 *     winner the write found DIVERGED from a same-seq copy stored meanwhile is planned again and forks (`Q-232`).
 *     A stale tombstone is deleted only once its record has LANDED.
 *  4. **Bump** the counter over every plausible seq RECEIVED, awaited, whatever became of the write. The writer
 *     bumps over every document it is HANDED; this bump exists only for the ones the planner never hands it —
 *     tombstoned, already current, an unknown chrono type, a fork refused at its cap. The counter follows the
 *     peer's clock, and a bump over only what landed leaves it behind exactly where a re-created record is then
 *     refused. The write's own error wins over the bump's (`Q-224`).
 *  5. **Forks**, last: a fork is a LOCAL write and takes a local seq, allocated from a counter that is already past
 *     everything this page carried — so it sorts above the arrival that caused it. It keeps the divergent copy's
 *     `createdAt` and `updatedAt`: the fork holds what the other peer wrote, when it wrote it, and "now" would give
 *     it a fresh retention window and make two receivers store two documents under one derived fork id. The seq
 *     hold covers the fork write alone; its embed jobs are queued after the hold is released. A fork write that
 *     fails for the store's reasons fails the page (a push answers 500/503, a pull holds its watermark).
 *  6. **Report**: the forks dropped at their cap are named once per page (the sender moves past them), and every
 *     landed edge and link is checked for strict linkage — on every door (it was the single edge route's and the
 *     batch's links only).
 *
 * Every operation of the page is bounded (bundle-30 `B2`): a stalled lock on a record or on the counter row would
 * otherwise hang a push with no bound at all, so the door could never answer the retryable 503 a stall is, and a
 * pull would hold its member's cycle. The fork's hold, nested inside, keeps whichever deadline is sooner.
 *
 * An admin import is a RESTORE, not a door of this accept: it replaces what is stored, unplanned (`writeArrivals`
 * with `restore`).
 */
import { getAllowedChronoTypes } from '../spaces/schema-validation.js';
import { getConfig } from '../config/loader.js';
import { log, peerList, peerText } from '../util/log.js';
import { withAllocatedSeqs } from '../util/seq.js';
import { withinWriteBound } from '../db/write-bound.js';
import { advanceCounterPast } from './counter-after-page.js';
import { TOMBSTONE_TYPE_OF } from '../config/types.js';
import { MAX_FORK_DEPTH } from '../api/sync/_shared.js';
import type { LinkageCheck } from './linkage-check.js';
import { writeArrivals, warnArrivalsNotStored, convergeFileStamps, type ArrivalOutcome, type ArrivalRefusal } from './arrivals.js';
import { admitArrivals } from './arrival-shape.js';
import { planArrivals, type ArrivalDoc, type ArrivalDoor, type ArrivalVerdict, type PlannedFamily } from './upsert-plan.js';
import { REPLICATED_FAMILIES, RECORD_TYPE_OF, familyOf, type PayloadKey } from './replicated-families.js';
import { readPageTombstones, readPushStored, readForkContext, deleteSupersededTombstones } from './push-reads.js';

type Arrived = Record<string, unknown> & ArrivalDoc;

/** What became of each document of one family, by its index in what was handed in. */
export interface AcceptedFamily {
  /** One per document handed in, in order: what sequential processing would have answered. */
  verdicts: ArrivalVerdict[];
  forkIds: Array<string | undefined>;
  /** Why each `rejected` document was refused — the schema's, the shape rule's or the store's words. */
  reasons: Array<string | undefined>;
  /** Refused by the family's wire schema: a single route answers it in its own words. */
  invalid: boolean[];
  /** Each document as its schema parsed it, or undefined where it was refused before parsing succeeded. */
  docs: Array<Arrived | undefined>;
}

export interface AcceptOptions {
  door: ArrivalDoor;
  /**
   * The peer identity the door PROVES — the pushing token's peer, or the member a pull read from — or undefined for
   * an admin or local token. Record planning does not depend on it, except that a record escapes another issuer's
   * tombstone only when its deliverer is its author.
   */
  deliveredBy: string | undefined;
  /** Who sent it, for the log lines (a member's label); `deliveredBy` when absent. */
  from?: string;
  /**
   * Collects the edges and links that land, for the door to check once its transfer is whole (`sync/linkage-check.ts`).
   * Required, so no door can accept a page without deciding when its references are checked.
   */
  linkage: LinkageCheck;
}

/** The families this accept plans, by their wire key: every replicated family. */

/** Accept one page — see the module docblock. Throws when the page could not be written; never for one document. */
export async function acceptArrivingPage(
  spaceId: string, page: Partial<Record<PayloadKey, readonly unknown[]>>, opts: AcceptOptions,
): Promise<Record<PayloadKey, AcceptedFamily>> {
  return withinWriteBound(async () => {
    const { door, deliveredBy } = opts;
    const peer = opts.from ?? deliveredBy ?? 'unknown';
    const where = `sync ${door} from ${peer}`;
    const results = {} as Record<PayloadKey, AcceptedFamily>;
    const sound = {} as Record<PayloadKey, Array<{ index: number; doc: Arrived }>>;
    let maxReceived = 0;

    // ── 1. validate ─────────────────────────────────────────────────────────────────────────────────────────
    for (const { payloadKey: key } of REPLICATED_FAMILIES) {
      const docs = page[key] ?? [];
      const res: AcceptedFamily = { verdicts: docs.map(() => 'rejected' as ArrivalVerdict), forkIds: docs.map(() => undefined),
        reasons: docs.map(() => undefined), invalid: docs.map(() => false), docs: docs.map(() => undefined) };
      results[key] = res;
      const { admitted, refused } = admitArrivals(key, docs);
      for (const r of refused) { res.reasons[r.index] = r.reason; res.invalid[r.index] = r.invalid; }
      for (const a of admitted) {
        res.docs[a.index] = a.doc as Arrived;
        if (a.doc.seq > maxReceived) maxReceived = a.doc.seq;
      }
      sound[key] = admitted.map(a => ({ index: a.index, doc: a.doc as Arrived }));
      warnArrivalsNotStored(where, spaceId, key, 'refused', refused.map((r): ArrivalRefusal => ({ _id: r._id, reason: r.reason })));
      // A repeated id is a sender's bug or a page that overlapped itself; the plan decides its copies in order and
      // writes the newest — said once per page, as the writer says it for a page it is handed whole.
      const seen = new Set<string>();
      const repeated = new Set(admitted.map(a => a.doc._id).filter(id => seen.has(id) || !seen.add(id)));
      warnArrivalsNotStored(where, spaceId, key, 'sent more than once in one page (the newest copy was kept)', [...repeated]);
    }

    // ── 2-3. plan and write, family by family ────────────────────────────────────────────────────────────────
    const forks: Array<{ key: PayloadKey; index: number; doc: Arrived }> = [];
    const landed: Array<{ key: PayloadKey; doc: Arrived }> = [];
    let failure: { err: unknown } | undefined;
    try {
      const tombstones = await readPageTombstones(spaceId, REPLICATED_FAMILIES
        .filter(f => TOMBSTONE_TYPE_OF[f.collection] !== undefined).flatMap(f => sound[f.payloadKey].map(s => s.doc._id)));
      const allowedTypes = door === 'push' ? getAllowedChronoTypes(getConfig().spaces.find(sp => sp.id === spaceId)?.meta) : undefined;
      for (const { payloadKey: key, collection } of REPLICATED_FAMILIES) {
        const items = sound[key];
        if (items.length === 0) continue;
        const kind = collection as PlannedFamily;
        const tombType = TOMBSTONE_TYPE_OF[collection];
        const docs = items.map(s => s.doc);
        const stored = await readPushStored(spaceId, kind, docs);
        const plan = planArrivals(docs, {
          kind, door, stored, deliveredBy, tombstones: (tombType === undefined ? undefined : tombstones.get(tombType)) ?? new Map(),
          ...(kind === 'chrono' ? { allowedTypes } : {}),
          ...(kind === 'facts' ? await readForkContext(spaceId, docs, stored) : {}),
        });
        const res = results[key];
        plan.verdicts.forEach((v, k) => { res.verdicts[items[k]!.index] = v; res.forkIds[items[k]!.index] = plan.forkIds[k]; });
        for (const f of plan.forks) forks.push({ key, index: items[f.index]!.index, doc: f.doc });

        // The winners, then — for any whose write failed — the version accepted before it, until each id lands
        // or runs out of versions.
        let pending = [...plan.accepts.values()].map(list => [...list]);
        const cleanups: Array<{ id: string; below: number; via?: string }> = [];
        const diverged: Array<{ index: number; doc: Arrived }> = [];
        while (pending.length > 0) {
          const out = await writePage(spaceId, key, pending.map(l => l.at(-1)!.doc), { from: peer, deliveredBy });
          const skipped = new Set([...out.newerLocal, ...out.derived]);
          const split = new Set(out.diverged);
          const dup = new Set(out.duplicates);
          const covered = new Set(out.tombstoned);
          const refused = new Map(out.refused.map(r => [r._id, r.reason]));
          const next: typeof pending = [];
          for (const list of pending) {
            const top = list.at(-1)!;
            const id = top.doc._id;
            if (covered.has(id)) {
              // A held file tombstone covers the version (Q-229); the versions planned before it are lower, so it covers those too.
              for (const a of list) res.verdicts[items[a.index]!.index] = 'tombstoned';
              continue;
            }
            if (skipped.has(id) || split.has(id)) {
              for (const a of list) res.verdicts[items[a.index]!.index] = 'skipped';
              // A same-seq copy with other content landed meanwhile: this one is a divergence, planned again below.
              if (split.has(id)) diverged.push({ index: items[top.index]!.index, doc: top.doc });
              continue;
            }
            if (dup.has(id) || refused.has(id)) {
              res.verdicts[items[top.index]!.index] = dup.has(id) ? 'duplicate' : 'rejected';
              res.reasons[items[top.index]!.index] = refused.get(id);
              list.pop();
              if (list.length > 0) next.push(list);
              continue;
            }
            const clean = plan.tombstoneCleanups.get(id);
            if (clean?.onLanding) cleanups.push({ id, below: top.doc.seq, ...(clean.via !== undefined ? { via: clean.via } : {}) });
            landed.push({ key, doc: top.doc });
          }
          pending = next;
        }
        /*
         * The file rows that CONVERGE (`Q-419`): the author's own copy, at the seq we hold and with the content we
         * hold, differing only in the timestamp that `merkle` hashes — so the two instances report a divergence every
         * cycle for a row nobody disagrees about. The verdict is the planner's; the write is the one arrival writer's.
         *
         * Outside the accepts loop above because it is not a version to store: nothing is stamped, nothing lands, and a
         * row whose filter went stale in the gap simply did not converge and is asked again next cycle.
         */
        if (plan.converges.length > 0) {
          const stamps = new Map([...plan.converges].map(c => [c.doc._id, stored.get(c.doc._id)?.updatedAt]));
          const done = new Set(await convergeFileStamps(spaceId, plan.converges.map(c => c.doc), stamps));
          for (const c of plan.converges) {
            if (!done.has(c.doc._id)) res.verdicts[items[c.index]!.index] = 'skipped';
          }
        }
        if (tombType !== undefined) {
          for (const [id, c] of plan.tombstoneCleanups) if (!c.onLanding) cleanups.push({ id, below: c.below });
          await deleteSupersededTombstones(spaceId, tombType, cleanups);
        }
        if (diverged.length > 0) forks.push(...await forkDiverged(spaceId, key, diverged, res, { door, deliveredBy }));
      }
    } catch (err) {
      failure = { err };
    }
    // ── 4. the counter, whatever became of the write; the write's own error is the one thrown (`Q-224`) ──────────
    const behind = await advanceCounterPast(spaceId, maxReceived, where);
    if (failure) throw failure.err;
    if (behind) throw behind;

    // ── 5. forks ─────────────────────────────────────────────────────────────────────────────────────────────
    if (forks.length > 0) {
      let forkOut: ArrivalOutcome | undefined;
      await withAllocatedSeqs(spaceId, forks.length, async (first) => {
        // The divergent copy's own createdAt and updatedAt, never "now" — see step 5 of the module docblock.
        forkOut = await writePage(spaceId, 'facts', forks.map((f, k) => ({ ...f.doc, seq: first + k })),
          { from: peer, deliveredBy, deferEnqueue: true });
      }, `sync.${door}.fork`);
      await forkOut?.enqueue();
      const failed = new Set([...(forkOut?.refused.map(r => r._id) ?? []), ...(forkOut?.duplicates ?? [])]);
      for (const f of forks) {
        if (!failed.has(f.doc._id)) continue;
        results[f.key].verdicts[f.index] = 'rejected';
        results[f.key].forkIds[f.index] = undefined;
      }
    }

    // ── 6. report ────────────────────────────────────────────────────────────────────────────────────────────
    /*
     * A DROPPED RECORD is logged HERE, because this is the side that knows why: divergent content at an equal seq
     * that cannot fork any further, so the incoming version is discarded — and the sender moves past it. Holding
     * the watermark back would re-offer a record refused identically every cycle; the fix is visibility.
     */
    // A fork refused at its cap was admitted, so its parsed document is there.
    const droppedForks = (results.facts.docs as Arrived[]).filter((_, i) => results.facts.verdicts[i] === 'forkRefused').map(d => d._id);
    warnArrivalsNotStored(where, spaceId, 'facts', 'DROPPED — divergent content at an equal seq whose fork chain or '
      + `fan-out is at its cap (MAX_FORK_DEPTH=${MAX_FORK_DEPTH}); the sender will not offer them again. Resolve the `
      + 'fork chain to accept them', droppedForks);
    // What landed is handed to the door's linkage check, which checks it once the door's transfer is whole — never
    // here, page by page, where a target later in the same transfer would be recorded missing (bundle-30 I8).
    for (const { key, doc } of landed) opts.linkage.add(key, doc);
    log.debug(`${peerText(where)}: page accepted for space '${peerText(spaceId)}': ${peerList(REPLICATED_FAMILIES.map(({ payloadKey: k }) =>
      `${k} ${summary(results[k].verdicts)}`), '; ')}`);
    return results;
  });
}

/** Store one family's documents through the arrival writer, with the family's own record type (`null`: links). */
async function writePage(spaceId: string, key: PayloadKey, docs: readonly Arrived[], opts: { from: string; deliveredBy: string | undefined; deferEnqueue?: boolean }): Promise<ArrivalOutcome> {
  const { collection } = familyOf(key);
  return await writeArrivals(spaceId, collection, RECORD_TYPE_OF[collection], docs, opts);
}

/**
 * Plan again the facts whose write found a same-seq copy with other content stored meanwhile (`Q-232`): against what
 * is stored NOW they are equal-seq divergences, so they fork within the caps as any other — or are refused at the cap.
 * Anything else the second plan says (the stored copy moved on) leaves them `skipped`. Returns the forks to write.
 */
async function forkDiverged(
  spaceId: string, key: PayloadKey, diverged: ReadonlyArray<{ index: number; doc: Arrived }>, res: AcceptedFamily,
  { door, deliveredBy }: { door: ArrivalDoor; deliveredBy: string | undefined },
): Promise<Array<{ key: PayloadKey; index: number; doc: Arrived }>> {
  const docs = diverged.map(d => d.doc);
  const stored = await readPushStored(spaceId, 'facts', docs);
  // No tombstones: the first plan already found none governing these documents.
  const again = planArrivals(docs, { kind: 'facts', door, stored, deliveredBy, tombstones: new Map(),
    ...await readForkContext(spaceId, docs, stored) });
  again.verdicts.forEach((v, k) => {
    if (v !== 'forked' && v !== 'forkRefused') return;
    res.verdicts[diverged[k]!.index] = v;
    res.forkIds[diverged[k]!.index] = again.forkIds[k];
  });
  return again.forks.map(f => ({ key, index: diverged[f.index]!.index, doc: f.doc }));
}

/** `verdict:count` pairs, for the debug line. */
function summary(verdicts: readonly ArrivalVerdict[]): string {
  const n = new Map<string, number>();
  for (const v of verdicts) n.set(v, (n.get(v) ?? 0) + 1);
  return n.size === 0 ? '-' : [...n].map(([v, c]) => `${v}:${c}`).join(',');
}
