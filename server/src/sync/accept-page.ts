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
 *  4. **No counter moves.** An arrival never raises the space's version counter (D-19 B, Q-241): a peer's version is the peer's, kept
 *     as it arrived, and the stamp of a local write over it is computed from the record it replaces (`util/version-stamp.ts`).
 *     A page's records take their positions in the writer, one block per chunk.
 *  5. **Forks**, last: a fork is a LOCAL write and takes a local version, stamped above the record it forks from (the stored
 *     copy), so it sorts above the arrival that caused it — and a parent at the ceiling refuses its fork (`rejected`). It keeps
 *     the divergent copy's `createdAt` and `updatedAt`: the fork holds what the other peer wrote, when it wrote it, and "now"
 *     would give it a fresh retention window and make two receivers store two documents under one derived fork id. It lands as
 *     an arrival (its own position); its embed jobs are queued after. A fork write that fails for the store's reasons fails the
 *     page (a push answers 500/503, a pull holds its watermark).
 *  6. **Report**: the forks dropped at their cap are named once per page (the sender moves past them), and every
 *     landed edge and link is checked for strict linkage — on every door (it was the single edge route's and the
 *     batch's links only).
 *
 *  7. **Recorded** (`sync/arrival-recording.ts`, `Q-93`, R6-9), in two halves that straddle the write. BEFORE it, each family's documents the
 *     plan may write are judged against the space's schema and the copy each replaces is read — afterwards it is gone. AFTER it, for the
 *     documents that LANDED (the winners and the forks, whatever else the page did), what each carries that the replaced copy lacked is
 *     answered per document (`AcceptedFamily.recorded`: the single routes' rows, the batch's count) and said once for the page — a counter,
 *     one line per (space, peer) per window, and a summary of names and counts the pull's history row keeps. A space in `off` records nothing,
 *     and a recorder that breaks never stops the write: it says so once and the page goes on. This is the ONE recording site of a peer's
 *     documents; the admin restore asks the same module.
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
import { versionsForRows } from '../util/version-stamp.js';
import { withinWriteBound } from '../db/write-bound.js';
import { TOMBSTONE_TYPE_OF } from '../config/types.js';
import type { LinkageCheck } from './linkage-check.js';
import { writeArrivals, warnArrivalsNotStored, convergeFileStamps, type ArrivalOutcome, type ArrivalRefusal } from './arrivals.js';
import { admitArrivals } from './arrival-shape.js';
import { planArrivals, type ArrivalPlan, type StoredCopy, bodyHashesOf, isForkingFamily, FORKING_FAMILIES, MAX_FORK_DEPTH, MAX_FORKS_PER_RECORD, type ArrivalDoc, type ArrivalDoor, type ArrivalVerdict, type PlannedFamily } from './upsert-plan.js';
import { REPLICATED_FAMILIES, RECORD_TYPE_OF, familyOf, type PayloadKey, type ReplicatedFamily } from './replicated-families.js';
import { readPageTombstones, readPushStored, readForkContext, deleteSupersededTombstones } from './push-reads.js';
import { watchArrivals, recordedOf, sayRecorded, summarise, type ArrivalWatch, type RecordedSummary } from './arrival-recording.js';
import type { SchemaViolation } from '../spaces/schema-validation.js';
import { assertPositionsReady } from './positions-ready.js';
import { edgeIdentityAdmitsForks } from '../spaces/edge-identity-index.js';
import { EdgeIdentityBuilding } from '../util/errors.js';
import { syncInvalidForksTotal, recordsFailingTheirSchema } from '../metrics/registry.js';

type Arrived = Record<string, unknown> & ArrivalDoc;

/** What became of each document of one family, by its index in what was handed in. */
export interface AcceptedFamily {
  /** One per document handed in, in order: what sequential processing would have answered. */
  verdicts: ArrivalVerdict[];
  forkIds: Array<string | undefined>;
  /**
   * Admitted although the fork id could not be derived from the body (a legacy fact fork under its stored parent, a chrono fork a redaction took the
   * bytes of): stored as an ordinary arrival, and counted so a peer's report of it reads as what it is.
   */
  unverifiable: boolean[];
  /** Why each `rejected` document was refused — the schema's, the shape rule's or the store's words. */
  reasons: Array<string | undefined>;
  /** Refused by the family's wire schema: a single route answers it in its own words. */
  invalid: boolean[];
  /** Each document as its schema parsed it, or undefined where it was refused before parsing succeeded. */
  docs: Array<Arrived | undefined>;
  /**
   * What each document that was STORED carries that its schema does not accept and the copy it replaced lacked (`Q-93`, R6-9), by its
   * index in what was handed in; undefined for a document that was not stored or has nothing new to answer for. Recorded here, once, by
   * `sync/arrival-recording.ts`: a door that answers it (a single push route's rows, the batch's count) reads it from here and decides
   * nothing of its own.
   */
  recorded: Array<SchemaViolation[] | undefined>;
  /** What this family's page recorded, in names and counts — the sync history keeps it. Absent when nothing was recorded. */
  summary?: RecordedSummary;
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
    // A space that owes its positions stores nothing and answers `positions_building` (held, to a sender): asked before any element is read.
    await assertPositionsReady(spaceId);
    const { door, deliveredBy } = opts;
    const peer = opts.from ?? deliveredBy ?? 'unknown';
    const where = `sync ${door} from ${peer}`;
    const results = {} as Record<PayloadKey, AcceptedFamily>;
    const sound = {} as Record<PayloadKey, Array<{ index: number; doc: Arrived }>>;

    // ── 1. validate ─────────────────────────────────────────────────────────────────────────────────────────
    for (const { payloadKey: key } of REPLICATED_FAMILIES) {
      const docs = page[key] ?? [];
      const res: AcceptedFamily = { verdicts: docs.map(() => 'rejected' as ArrivalVerdict), forkIds: docs.map(() => undefined),
        reasons: docs.map(() => undefined), invalid: docs.map(() => false), unverifiable: docs.map(() => false), docs: docs.map(() => undefined), recorded: docs.map(() => undefined) };
      results[key] = res;
      const { admitted, refused } = admitArrivals(key, docs);
      for (const r of refused) { res.reasons[r.index] = r.reason; res.invalid[r.index] = r.invalid; }
      for (const a of admitted) res.docs[a.index] = a.doc as Arrived;
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
    const landed: Array<{ key: PayloadKey; index: number; doc: Arrived }> = [];
    // What each family's documents carried against the space's schema, looked at BEFORE they were written (the copy they replace is gone
    // afterwards), and what it came to for the ones that landed (`sync/arrival-recording.ts`).
    const watches = new Map<PayloadKey, ArrivalWatch | null>();
    let failure: { err: unknown } | undefined;
    try {
      // One read, as before: the arriving ids, and the parent each fork row names, because a fork row of a record whose tombstone is held is refused with it (D2).
      const tombstones = await readPageTombstones(spaceId, REPLICATED_FAMILIES
        .filter(f => TOMBSTONE_TYPE_OF[f.collection] !== undefined).flatMap(f => sound[f.payloadKey].flatMap(s => (s.doc.forkOf === undefined ? [s.doc._id] : [s.doc._id, s.doc.forkOf]))));
      const allowedTypes = door === 'push' ? getAllowedChronoTypes(getConfig().spaces.find(sp => sp.id === spaceId)?.meta) : undefined;
      // A family's plan, made once per page: the edges family is planned ahead of every write when the space cannot store a fork edge yet (below), and the loop reuses it.
      const plans = new Map<PayloadKey, Promise<{ stored: Map<string, StoredCopy>; plan: ArrivalPlan<Arrived> }>>();
      const planOf = (key: PayloadKey, collection: ReplicatedFamily['collection']) => {
        const done = plans.get(key);
        if (done) return done;
        const planned = (async () => {
          const kind = collection as PlannedFamily;
          const tombType = TOMBSTONE_TYPE_OF[collection];
          const docs: Arrived[] = sound[key].map(s => s.doc);
          const stored = await readPushStored(spaceId, kind, docs);
          // A stored copy compared at an equal seq that fails its own schema is hashed raw; counted, so an operator can see how many there are (design section 2).
          for (const copy of stored.values()) if (copy.bodyHash && !copy.bodyHash.normalised) recordsFailingTheirSchema.inc({ family: kind });
          // One body hash per document per page: the candidate selection, the plan and the writer's read-back all ask it.
          const hashOf = bodyHashesOf(kind);
          const plan = planArrivals(docs, {
            kind, door, stored, deliveredBy, tombstones: (tombType === undefined ? undefined : tombstones.get(tombType)) ?? new Map(), hashOf,
            ...(kind === 'chrono' ? { allowedTypes } : {}),
            ...(isForkingFamily(kind) ? await readForkContext(spaceId, kind, docs, stored, hashOf) : {}),
          });
          return { stored, plan };
        })();
        plans.set(key, planned);
        return planned;
      };
      // A page that carries or plans a fork edge waits for a space whose identity index still counts fork rows: asked AFTER planning and BEFORE any write of the page
      // (design 5.4), so the held page leaves nothing half landed, and the sender keeps its copy and offers the page again.
      if (sound.edges.length > 0 && !(await edgeIdentityAdmitsForks(spaceId))) {
        const { plan } = await planOf('edges', 'edges');
        const storesAFork = plan.forks.length > 0
          || sound.edges.some((s, k) => s.doc.forkOf !== undefined && (plan.verdicts[k] === 'upserted' || plan.verdicts[k] === 'updated' || plan.verdicts[k] === 'inserted'));
        if (storesAFork) {
          log.warn(`${peerText(where)}: space '${peerText(spaceId)}': the edges of this page are held: this space is rebuilding its edge identity index and cannot store a fork edge yet`);
          throw new EdgeIdentityBuilding(spaceId);
        }
      }
      for (const { payloadKey: key, collection } of REPLICATED_FAMILIES) {
        const items = sound[key];
        if (items.length === 0) continue;
        const tombType = TOMBSTONE_TYPE_OF[collection];
        const { stored, plan } = await planOf(key, collection);
        const res = results[key];
        plan.verdicts.forEach((v, k) => { res.verdicts[items[k]!.index] = v; res.forkIds[items[k]!.index] = plan.forkIds[k]; });
        for (const u of plan.unverifiable) res.unverifiable[items[u.index]!.index] = true;
        if (plan.unverifiable.some(u => u.reason === 'legacy')) {
          log.warn(`${peerText(where)}: space '${peerText(spaceId)}': legacy fact fork ids from 5.6.0-5.6.1 cannot be verified; admitted under its stored parent`);
        }
        for (const f of plan.forks) forks.push({ key, index: items[f.index]!.index, doc: f.doc });
        // Every version the plan may write: the newest of each id, and the older ones a failed write falls back to.
        watches.set(key, await watchArrivals(spaceId, collection, [...plan.accepts.values()].flatMap(list => list.map(a => a.doc)), door));

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
            landed.push({ key, index: items[top.index]!.index, doc: top.doc });
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
    // ── 4. what landed, recorded against the schema; the counter, whatever became of the write; the write's own error is the one thrown (`Q-224`) ──
    // The recording is made of what LANDED so far even when the page failed: a record that is stored and unrecorded is never recorded —
    // the sender offers it again and the plan skips it as already held. It never throws, and never stops what follows.
    const recorded = new Map<PayloadKey, Map<string, SchemaViolation[]>>();
    const record = (key: PayloadKey, entries: ReadonlyArray<{ index: number; doc: Arrived }>, watch: ArrivalWatch | null) => {
      const rows = recordedOf(watch, entries.map(e => e.doc), door);
      for (const e of entries) {
        const found = rows.get(e.doc);
        if (!found) continue;
        results[key].recorded[e.index] = found;
        (recorded.get(key) ?? recorded.set(key, new Map()).get(key)!).set(e.doc._id, found);
      }
    };
    for (const { payloadKey: key } of REPLICATED_FAMILIES) record(key, landed.filter(l => l.key === key), watches.get(key) ?? null);
    const say = (): void => {
      const families = new Map([...recorded].map(([key, docs]) => [key, docs] as const));
      sayRecorded({ spaceId, source: door, peer, families });
      for (const [key, docs] of recorded) results[key].summary = summarise(new Map([[key, docs]]));
    };
    if (failure) { say(); throw failure.err; }

    // ── 5. forks ─────────────────────────────────────────────────────────────────────────────────────────────
    try {
      for (const family of FORKING_FAMILIES) {
        const ofFamily = forks.filter(f => f.key === family);
        if (ofFamily.length === 0) continue;
        // A divergence the write found meanwhile (Q-232) forks an edge too: the same hold as the page's (above), asked again because the space may have been ready then.
        if (family === 'edges' && !(await edgeIdentityAdmitsForks(spaceId))) throw new EdgeIdentityBuilding(spaceId);
        // A fork is a new record under an id nothing holds, so there is no copy it replaces; looked at before it is written like any other.
        const forkWatch = await watchArrivals(spaceId, family, ofFamily.map(f => f.doc), door);
        // A fork is a LOCAL version of a divergent copy, stamped above the record it forks from (the stored copy, at the arriving seq):
        // `versionsForRows` over the parents, so a parent at the ceiling refuses its fork (answered `rejected`, Q-241 doneWhen 2) and the
        // other forks of the page land. The copy lands as an arrival (`writePage`), which takes its own position.
        const stamps = await versionsForRows(spaceId, ofFamily.map(f => String(f.doc['forkOf'] ?? f.doc._id)), { parts: [family] });
        const live = ofFamily.flatMap((f, k) => { const s = stamps[k]!; return 'refused' in s ? [] : [{ f, version: s.version }]; });
        let forkOut: ArrivalOutcome | undefined;
        if (live.length > 0) {
          // The divergent copy's own createdAt and updatedAt, never "now" — see step 5 of the module docblock.
          forkOut = await writePage(spaceId, family, live.map(({ f, version }) => ({ ...f.doc, seq: version })),
            { from: peer, deliveredBy, deferEnqueue: true });
        }
        await forkOut?.enqueue();
        const liveIds = new Set(live.map(l => l.f.doc._id));
        const failed = new Set([
          ...ofFamily.map(f => f.doc._id).filter(id => !liveIds.has(id)),
          ...(forkOut?.refused.map(r => r._id) ?? []), ...(forkOut?.duplicates ?? []),
        ]);
        for (const f of ofFamily) {
          if (!failed.has(f.doc._id)) continue;
          results[f.key].verdicts[f.index] = 'rejected';
          results[f.key].forkIds[f.index] = undefined;
        }
        record(family, ofFamily.filter(f => !failed.has(f.doc._id)), forkWatch);
      }
    } finally {
      // Said once for the page, whatever the forks did: what landed is stored, and an operator is told what it carried.
      say();
    }

    // ── 6. report ────────────────────────────────────────────────────────────────────────────────────────────
    /*
     * A DROPPED RECORD is logged HERE, because this is the side that knows why: divergent content at an equal seq
     * that cannot fork any further, so the incoming version is discarded — and the sender moves past it. Holding
     * the watermark back would re-offer a record refused identically every cycle; the fix is visibility.
     */
    for (const family of FORKING_FAMILIES) {
      // A fork refused at its cap was admitted, so its parsed document is there.
      const droppedForks = (results[family].docs as Arrived[]).filter((_, i) => results[family].verdicts[i] === 'forkRefused').map(d => d._id);
      warnArrivalsNotStored(where, spaceId, family, 'DROPPED — divergent content at an equal seq whose fork chain is '
        + `${MAX_FORK_DEPTH} deep or whose record already has ${MAX_FORKS_PER_RECORD} forks; the sender will not offer them again. `
        + 'This space will show as a merkle divergence for each of those records until its forks are resolved. '
        + 'Resolve a fork of that record in Review to make room', droppedForks);
      // A malformed fork row is never stored and never a silent `rejected`: said once for the page, with the ids a sender can look up.
      const malformed = (results[family].docs as Arrived[]).filter((_, i) => results[family].verdicts[i] === 'invalidFork').map(d => d._id);
      warnArrivalsNotStored(where, spaceId, family, 'REFUSED as malformed fork row(s) — the id does not derive from the subject, the seq and the body '
        + '(or the row is its own fork, or an edge changed whether it is one); they are not offered again', malformed);
      if (malformed.length > 0) syncInvalidForksTotal.inc({ family }, malformed.length);
    }
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
 * Plan again the records of a family that forks whose write found a same-seq copy with other content stored meanwhile (`Q-232`): against what
 * is stored NOW they are equal-seq divergences, so they fork within the caps as any other — or are refused at the cap.
 * Anything else the second plan says (the stored copy moved on) leaves them `skipped`. Returns the forks to write.
 */
async function forkDiverged(
  spaceId: string, key: PayloadKey, diverged: ReadonlyArray<{ index: number; doc: Arrived }>, res: AcceptedFamily,
  { door, deliveredBy }: { door: ArrivalDoor; deliveredBy: string | undefined },
): Promise<Array<{ key: PayloadKey; index: number; doc: Arrived }>> {
  const docs = diverged.map(d => d.doc);
  const kind = familyOf(key).collection as PlannedFamily;
  const stored = await readPushStored(spaceId, kind, docs);
  const hashOf = bodyHashesOf(kind);
  // No tombstones: the first plan already found none governing these documents.
  const again = planArrivals(docs, { kind, door, stored, deliveredBy, tombstones: new Map(), hashOf,
    ...await readForkContext(spaceId, kind, docs, stored, hashOf) });
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
