/**
 * THE ONE APPLY of a brain tombstone a peer delivered — by push (`POST /api/sync/tombstones`) or by pull
 * (`pullTombstones`, `sync/tombstone-transfer.ts`). Bundle-46: `Q-236`, `Q-221`, and the batching `Q-107` part 2
 * named.
 *
 * ## Why one function, and what each door used to drop
 *
 * Each door applied a page one tombstone at a time through `applyRemoteTombstone`, which routed every collection it
 * touched by the TOMBSTONE's own `spaceId`. So a peer admitted to one space deleted from, and stored tombstones in,
 * any other space it named — including one this instance does not have — and under a `spaceMap` an honest peer's
 * deletions landed under the network's id, where no local read sees them, and never reached the local space at
 * all. The push validated the page as one array (one bad element refused all of it) and the pull validated
 * nothing. Both stored a tombstone BEFORE deciding whether it was authorised, so a refused forgery was kept and
 * refused every later copy of its record from the real author.
 *
 * ## The rule, in order, per element
 *
 *  1. **Shape** (`admitTombstone`): a malformed element is refused on its own and the rest of the page applies. An
 *     element whose `type` this instance does not know (a newer peer's) makes the WHOLE page unapplied, so the door
 *     answers it as unapplied (a 400 on push, a truncation on pull) and the sender holds and re-sends after this
 *     receiver upgrades — refusing it alone would let the sender advance past a deletion this instance cannot do.
 *  2. **Seq**, by the one rule for a received seq (`seqRefusal`): a seq no counter can carry is refused alone, and
 *     never moves the counter.
 *  3. **The admitted space**: every element is retagged to `localSpaceId` and every collection is named by it —
 *     never by what arrived.
 *  4. **Authorised before it is stored**, by the one authority (`authorises`, `sync/deletion-authority.ts`) over the
 *     page's `Delivery`: the delivering peer proved the issuer and the issuer wrote the record (ground `issuer`), or
 *     the deliverer is this space's direct upstream and the record carries ITS delivery stamp (ground `upstream`,
 *     D-14). A declined tombstone is NOT stored, and is named by reason in the answer's `declined`, the counter and one
 *     warning per (peer, space, reason) window. One whose target is absent is stored and deletes nothing — a deletion
 *     may arrive before its record, and storing it lets this node relay it. A tombstone stored on the upstream ground
 *     carries `storedVia`, so a middle node relays it and the upstream's own later version is not refused by it.
 *  5. **One write per kind**: one `$in` read of the stored tombstones, one per target collection, one bulk upsert, one
 *     delete per target collection, ground and issuer (the issuer ground's bound names it) — a page costs the same
 *     whatever its size. Each delete carries the bound of the ground that authorised it (`deleteBound`), so a verdict
 *     gone stale between the read and the write deletes nothing.
 *  6. **No counter moves.** A tombstone keeps its issuer's version (`seq`) and an arrival never raises the space's version counter
 *     (D-19 B): a planted tombstone at the ceiling would otherwise drag every later local stamp up to it (Q-241). What the old counter
 *     bump was for — a quiet peer re-creating a record a busy peer deleted, at a version below the deletion, refused by every relay —
 *     is the stamp's own term now: a local write is stamped above every tombstone this instance holds for the id, capped
 *     (`util/version-stamp.ts`). A tombstone that is STORED takes its position as it lands (`withLandingStamp`), as a record does.
 *
 * An entity this apply deletes has its face labels removed (`unlabelFacesForEntities`, `Q-395`): the descriptor belongs
 * to the file and stays, the claim of whose face it is goes with the person.
 *
 * Refusals are named in ONE warning per page, through `warnArrivalsNotStored`, so a refusal reads the same from a
 * tombstone as from a record, and every peer value in it goes through `logSafe`.
 */
import { z } from 'zod';
import { col, asBulk, asFilter } from '../db/mongo.js';
import { bulkWriteFailures, DUPLICATE_KEY } from '../db/write-errors.js';
import { spaceCollection } from '../db/space-collection.js';
import { readStoredById } from '../db/read-by-id.js';
import { writeInOneCommands, operationBytes, bulkCommandOf, SlicedBulkWriteError } from '../db/one-command.js';
import { readBackDuplicates } from './duplicate-readback.js';
import { assertPositionsReady } from './positions-ready.js';
import { inChunks, ROWS_PER_BULK_COMMAND } from '../util/chunks.js';
import { TOMBSTONE_TYPES, TOMBSTONE_COLLECTION } from '../config/types.js';
import type { TombstoneDoc } from '../config/types.js';
import { getConfig } from '../config/loader.js';
import { withLandingStamp, arrivalRow } from './record-position-stream.js';
import { log, logSafe, peerList, peerText, refusalOfParse } from '../util/log.js';
import { seqRefusal, arrivalId, warnArrivalsNotStored, type ArrivalRefusal } from './arrivals.js';
import { recordDecline, sayDeclines, saidDeletions } from './decline-report.js';
import { retagToLocalSpace, FORKING_FAMILIES } from './upsert-plan.js';
import { resolvedElsewhereEntry, writeResolvedElsewhere, type ResolvedElsewhereMark } from './resolved-elsewhere.js';
import { forkRowsUnder } from '../brain/forks.js';
import { authorises, deleteBound, MAX_ISSUER, type Delivery, type DeletionGround, type DeletionTarget } from './deletion-authority.js';
import { unlabelFacesForEntities } from '../brain/entities.js';
import { syncTombstonesAppliedTotal } from '../metrics/registry.js';
import { admitSpaceWrite, assertSpaceTakesWrites } from '../spaces/space-write-gate.js';

/**
 * The most tombstones one push request may carry. An honest sender pages at 500 (`pushTombstones`) and retries a
 * page of one seq at this size; a larger body is refused whole, before anything is read, so a request's cost is
 * bounded by the door rather than by the sender.
 */
export const MAX_TOMBSTONES_PER_REQUEST = 5000;

/** The wire shape of one tombstone. Unknown keys are stripped, so what is stored is only what is declared here. */
const TombstoneShape = z.object({
  _id: z.string().min(1),
  type: z.enum(TOMBSTONE_TYPES),
  spaceId: z.string(),
  deletedAt: z.string(),
  // A blank issuer is no issuer: the codebase reads an empty one as "issuer-less", which governs every author (`upsert-plan.ts`'s `issuer && …`,
  // `deletion-authority.ts`'s `['', null]`), so `''` and `' '` are refused here, alone, rather than stored and trusted (bundle-81, decision 1).
  instanceId: z.string().trim().min(1).max(MAX_ISSUER),
  seq: z.number(),
  originalSeq: z.number().optional(),
});

/** What one element is: a tombstone this instance can apply, one it refuses alone, or one of a type it does not know. */
export type TombstoneAdmission =
  | { readonly tombstone: TombstoneDoc }
  | { readonly refused: ArrivalRefusal }
  | { readonly unknownType: string };

/**
 * Steps 1 and 2 for one element — the one admission rule, asked by the apply and by the transfer's pager (whose
 * cursor may only move over what is admitted, or a forged high seq would page past real deletions).
 */
export function admitTombstone(raw: unknown): TombstoneAdmission {
  const type = (raw as { type?: unknown } | null)?.type;
  if (typeof type === 'string' && !(TOMBSTONE_TYPES as readonly string[]).includes(type)) return { unknownType: type };
  const parsed = TombstoneShape.safeParse(raw);
  if (!parsed.success) return { refused: { _id: arrivalId(raw), reason: `not a tombstone (${refusalOfParse(parsed.error).error})` } };
  const t = parsed.data as TombstoneDoc;
  const why = seqRefusal(t.seq, { optional: false });
  return why ? { refused: { _id: t._id, reason: why } } : { tombstone: t };
}

/** What a page came to. */
export interface TombstoneApplyOutcome {
  /** Elements that passed shape and seq — what the door admitted, whatever authorisation then decided. */
  admitted: number;
  /** Elements refused on shape or seq, each on its own. */
  refused: ArrivalRefusal[];
  /** Admitted elements the deletion authority declined: NOT stored, nothing deleted. */
  declined: ArrivalRefusal[];
  /** Types this instance does not know. Non-empty: nothing of the page was applied and the counter did not move. */
  unknownTypes: string[];
  /** The highest admitted seq — what the counter was advanced to at least. */
  maxSeq: number;
  /** Records deleted on each ground — what the page did, for the caller's own line. */
  deleted: Record<DeletionGround, number>;
}

/** What differs for the ONE-TIME RE-READ of an upstream's tombstones (`sync/tombstone-reread.ts`). */
export interface TombstoneApplyOptions {
  /**
   * A re-read tombstone deletes a record only if the record's seq is not above the tombstone's: it was issued long ago,
   * and a record re-created since carries a higher seq. A live apply has no such bound (a tombstone is issued after its
   * issuer received the version it deletes). A record kept this way is not a decline, and its tombstone is not stored.
   * The re-read also leaves the per-page info line to its own completion line, so a deletion is stated once.
   */
  repair?: boolean;
}

/** The target as the apply reads it: what authority reads, and the seq the repair bounds by. */
type HeldTarget = DeletionTarget & { seq?: number; forkOf?: string };

/**
 * Apply a page of tombstones a peer delivered, to the space the door ADMITTED — see the module docblock.
 *
 * @param localSpaceId the local space the door admitted: `req.query.spaceId` after the alias middleware, or the
 *   space the sync cycle is on. Never a tombstone's own `spaceId`, and never the network's id for the space.
 * @param raw the elements as they arrived, unvalidated
 * @param delivery who delivered the page, from `deliveryOf` — what the deletion authority reads
 * @param where names the door and the peer, for the log lines only
 */
export async function applyPeerTombstones(
  localSpaceId: string, raw: readonly unknown[], delivery: Delivery, where: string, opts: TombstoneApplyOptions = {},
): Promise<TombstoneApplyOutcome> {
  // A peer's tombstones delete records of every family a page carries, as an exchange moves every family: any act standing for the
  // space refuses them, as the hold refuses the exchange (the write below asks and counts again, at the instant it is made).
  assertSpaceTakesWrites(localSpaceId);
  // A space that owes its positions stores nothing and answers `positions_building` (held, to a sender).
  await assertPositionsReady(localSpaceId);
  const out: TombstoneApplyOutcome = {
    admitted: 0, refused: [], declined: [], unknownTypes: [], maxSeq: 0, deleted: { issuer: 0, upstream: 0 },
  };
  // Keyed in a Map, because an id is a peer's text; a repeated id keeps its highest seq.
  const page = new Map<string, TombstoneDoc>();
  for (const r of raw) {
    const a = admitTombstone(r);
    if ('unknownType' in a) { out.unknownTypes.push(a.unknownType); continue; }
    if ('refused' in a) { out.refused.push(a.refused); continue; }
    out.admitted++;
    if (a.tombstone.seq > out.maxSeq) out.maxSeq = a.tombstone.seq;
    const prev = page.get(a.tombstone._id);
    if (!prev || a.tombstone.seq > prev.seq) page.set(a.tombstone._id, a.tombstone);
  }
  if (out.unknownTypes.length > 0) {
    log.warn(`${logSafe(where)}: a page carried tombstone type(s) this instance does not know `
      + `(${peerList(new Set(out.unknownTypes), ', ', { count: 5 })}) for space '${peerText(localSpaceId)}' — nothing `
      + 'of it was applied, so the sender holds it and re-sends once this instance knows the type.');
    return out;
  }
  const admitted = [...page.values()];
  retagToLocalSpace(admitted, localSpaceId);
  const selfId = getConfig().instanceId;
  const ledger = { declined: out.declined, declinedBy: new Map<string, ArrivalRefusal[]>() };

  let failed = false;
  let failure: unknown;
  try {
    const ids = admitted.map(t => t._id);
    const held = await readStoredById<{ seq?: number }>(spaceCollection(localSpaceId, 'tombstones'), ids, { seq: 1 });
    const byCollection = new Map<TombstoneDoc['type'], TombstoneDoc[]>();
    for (const t of admitted) {
      if (!byCollection.has(t.type)) byCollection.set(t.type, []);
      byCollection.get(t.type)!.push(t);
    }
    /**
     * A tombstone to store, the upstream it is stored for when it stood on that ground, and the ground it stood on: `proven` is the ground `issuer`
     * (the deliverer IS the issuer, so the issuer text is worth storing over a stored one), which is the only proof of who issued a deletion.
     */
    const store: Array<{ t: TombstoneDoc; via?: string; ground: DeletionGround | 'absent'; proven: boolean }> = [];
    /** Tombstones this instance already holds at the same or a higher version: counted, never written. */
    const alreadyNewer: Array<{ t: TombstoneDoc; ground: string }> = [];
    /** Held at EXACTLY this version and delivered by an upstream now: the one `storedVia` write a re-delivery still makes. */
    const rerelay: Array<{ t: TombstoneDoc; via: string }> = [];
    /** The apply's one decision per tombstone about the STORE (not the delete): what a held copy of the same id means for the write. */
    const queue = (entry: { t: TombstoneDoc; via?: string; ground: DeletionGround | 'absent'; proven: boolean }): void => {
      const heldSeq = held.get(entry.t._id)?.seq;
      if (typeof heldSeq === 'number' && heldSeq >= entry.t.seq) {
        alreadyNewer.push({ t: entry.t, ground: entry.ground });
        if (heldSeq === entry.t.seq && entry.via !== undefined) rerelay.push({ t: entry.t, via: entry.via });
        return;
      }
      store.push(entry);
    };
    /**
     * Per target collection, ground and — on the issuer ground, whose bound names it — issuer: the rows to delete. Every
     * row of one group carries the same bound, so a group is ONE `deleteMany` (per `ROWS_PER_BULK_COMMAND` ids).
     */
    const deletes: Array<{ type: TombstoneDoc['type']; ground: DeletionGround; issuer: string; rows: TombstoneDoc[] }> = [];
    /** Declined tombstones of FORK rows: each a mark, never a delete (Q-624 §9a). */
    const marks: ResolvedElsewhereMark[] = [];
    /** The ids of a forking kind the authority accepted a tombstone for: their forks go with them here, no tombstone issued (§7, R7). */
    const cascade: Array<{ type: TombstoneDoc['type']; id: string }> = [];
    for (const [type, list] of byCollection) {
      const targets = await readStoredById<HeldTarget>(
        spaceCollection(localSpaceId, TOMBSTONE_COLLECTION[type]), list.map(t => t._id),
        { 'author.instanceId': 1, deliveredBy: 1, seq: 1, forkOf: 1 });
      const forking = (FORKING_FAMILIES as readonly string[]).includes(TOMBSTONE_COLLECTION[type]);
      const groups = new Map<string, { ground: DeletionGround; issuer: string; rows: TombstoneDoc[] }>();
      for (const t of list) {
        const target = targets.get(t._id);
        // `t.instanceId` is the sender's text: the authority decides what it is worth, never this loop.
        const verdict = authorises(delivery, t.instanceId, target ?? null, selfId);
        if (!verdict.ok) {
          recordDecline(ledger, { id: t._id, reason: verdict.reason, kind: type, what: 'record', issuer: t.instanceId, delivery, target });
          // A FORK another instance resolved behind a tombstone this authority declines: kept, and marked for a decision here (Q-624 §9a). Nothing is deleted.
          if (forking && typeof target?.forkOf === 'string') {
            const proven = delivery.trustedRelay || (delivery.peerInstanceId !== undefined && delivery.peerInstanceId === t.instanceId);
            marks.push({
              collection: TOMBSTONE_COLLECTION[type], kind: type, id: t._id,
              entry: resolvedElsewhereEntry(t, { proven, ...(delivery.peerInstanceId !== undefined ? { deliverer: delivery.peerInstanceId } : {}) }),
            });
          }
          continue;
        }
        // Every element the authority accepted: its subject's forks go with it here, whatever this page deletes (R7).
        if (forking) cascade.push({ type, id: t._id });
        if (verdict.ground === 'absent') { queue({ t, ground: 'absent', proven: false }); continue; }
        // The re-read only: a record newer than the deletion is a re-creation. It is kept, and so is its tombstone
        // unstored — a held tombstone beside a live record would be served on as a deletion of it.
        if (opts.repair && typeof target?.seq === 'number' && target.seq > t.seq) continue;
        // A stored tombstone at a higher seq means this one is stale: it is not stored over, and deletes nothing. Asked
        // BEFORE the store, because storing it would still mark the newer one as held for this upstream (`storedVia`),
        // and that mark lets the upstream's later version past a deletion it did not make.
        const heldSeq = held.get(t._id)?.seq;
        if (typeof heldSeq === 'number' && heldSeq > t.seq) { alreadyNewer.push({ t, ground: verdict.ground }); continue; }
        queue({ t, ground: verdict.ground, proven: verdict.ground === 'issuer', ...(verdict.ground === 'upstream' && delivery.peerInstanceId ? { via: delivery.peerInstanceId } : {}) });
        // The upstream bound names no issuer (it is the stamp and the self-exclusion), so every issuer shares its group.
        const issuer = verdict.ground === 'issuer' ? t.instanceId : '';
        const key = JSON.stringify([verdict.ground, issuer]);
        if (!groups.has(key)) groups.set(key, { ground: verdict.ground, issuer, rows: [] });
        groups.get(key)!.rows.push(t);
      }
      for (const g of groups.values()) deletes.push({ type, ...g });
    }
    // What the page decided is written as ONE admitted and counted unit, from its own check (`admitSpaceWrite`): an act registered while the page
    // was being judged refuses it, and one registered after waits for it, so a stored tombstone or a deleted row never lands after the act's delete.
    await admitSpaceWrite(localSpaceId, undefined, async () => {
      for (const { t, ground } of alreadyNewer) syncTombstonesAppliedTotal.labels({ kind: t.type, ground, outcome: 'already_newer' }).inc();
      const tombstones = col<TombstoneDoc>(spaceCollection(localSpaceId, 'tombstones'));
      // The one `storedVia` a re-delivery at the SAME version still writes: the upstream it is relayed for. It writes no position and no version.
      for (const { t, via } of rerelay) await tombstones.updateOne({ _id: t._id, seq: t.seq }, { $set: { storedVia: via } });
      if (store.length > 0) {
        // A page is a peer's: counted (`MAX_TOMBSTONES_PER_REQUEST`), not measured, and an id is text it chose, carried twice
        // by each operation. So the bulk is sliced to stay ONE wire command (`db/one-command.ts`): the driver would split a
        // larger one, and a second command carries a deadline of its own after the bound has answered the sender.
        // Duplicate keys are collected here and read back AFTER the hold (everything awaited under it holds every reader of the space).
        const duplicates: Array<{ t: TombstoneDoc; ground: string }> = [];
        // One block of positions for the page's stored tombstones, held below every position-paged reader until the write has settled. A position
        // taken for a tombstone whose write then finds a newer copy is burnt, a safe gap: nothing is paged by "no gaps".
        await withLandingStamp(localSpaceId, store.map(({ t }) => arrivalRow(t.seq)), async (landings) => {
          const items = store.map((entry, i) => ({ entry, op: guardedUpsertOf(entry, landings[i]!) }));
          // Slice-local operation indexes: the driver reports a failure by its place in the slice it sent, and the slices are written in order.
          const slices: Array<typeof items> = [];
          try {
            await writeInOneCommands(items, (slice, { ordered }) => {
              slices.push(slice);
              return tombstones.bulkWrite(asBulk<TombstoneDoc>(slice.map(x => x.op)), { ordered });
            }, { ordered: false, bytesOf: (x) => operationBytes(x.op), commandKindOf: (x) => bulkCommandOf(x.op) });
          } catch (err) {
            duplicates.push(...duplicateKeysOf(err, slices));
          }
        }, 'sync.tombstone.apply');
        // A duplicate key says the held copy is at the same version or newer (the guard refused the write, the copy stays) — or that the
        // write was lost to something else, which fails the page so the sender offers it again.
        for (const { planned, held: copy, relation } of await readBackDuplicates<TombstoneDoc, TombstoneDoc>(spaceCollection(localSpaceId, 'tombstones'), duplicates.map(d => d.t))) {
          if (relation === 'other') throw new Error(`a tombstone write for '${peerText(planned._id)}' met a duplicate key and the stored copy (${copy === undefined ? 'none' : `version ${String(copy.seq)}`}) is not at its version or above`);
          syncTombstonesAppliedTotal.labels({ kind: planned.type, ground: duplicates.find(d => d.t._id === planned._id)?.ground ?? 'absent', outcome: 'already_newer' }).inc();
        }
      }
      for (const d of deletes) {
        const coll = col<{ _id: string }>(spaceCollection(localSpaceId, TOMBSTONE_COLLECTION[d.type]));
        // The group's delete carries the BOUND of the ground that authorised it (`deleteBound`), so a record another author
        // wrote, or whose stamp changed, between the read above and this write is not taken with it — the write re-checks
        // the verdict. The re-read adds each row's own seq bound.
        const bound = deleteBound(d.ground, { issuer: d.issuer, deliverer: delivery.peerInstanceId, selfId });
        let deleted = 0;
        for (const chunk of inChunks(d.rows, ROWS_PER_BULK_COMMAND)) {
          // The bound names `deliveredBy` and `author.instanceId`, never `_id` or `$or`, so the spread cannot replace the ids.
          const res = opts.repair
            ? await coll.deleteMany(asFilter<{ _id: string }>({ ...bound, $or: chunk.map(t => ({ _id: t._id, seq: { $lte: t.seq } })) }))
            : await coll.deleteMany(asFilter<{ _id: string }>({ _id: { $in: chunk.map(t => t._id) }, ...bound }));
          deleted += res.deletedCount ?? 0;
        }
        out.deleted[d.ground] += deleted;
        if (deleted > 0) syncTombstonesAppliedTotal.labels({ kind: d.type, ground: d.ground, outcome: 'deleted' }).inc(deleted);
        if (d.type === 'entity') await unlabelRemoved(localSpaceId, d.rows.map(t => t._id), deleted);
      }
      if (marks.length > 0) await writeResolvedElsewhere(localSpaceId, marks);
      await cascadeToForks(localSpaceId, cascade);
    });
    // The re-read says what it deleted once, in its own completion line over every page (`sync/tombstone-reread.ts`): a line
    // per page here would state the same deletions a second time.
    if (!opts.repair) saidDeletions(where, 'record', localSpaceId, out.deleted);
  } catch (err) {
    failed = true;
    failure = err;
  }

  warnArrivalsNotStored(where, localSpaceId, 'tombstone', 'refused', out.refused);
  // A standing decline is the same ones every cycle: said once per (peer, space, reason) window, counted every time.
  sayDeclines(where, localSpaceId, 'tombstone', delivery, ledger.declinedBy);
  if (failed) throw failure;
  return out;
}

/** A tombstone to store: what the apply decided about the store of one admitted element (see `applyPeerTombstones`). */
interface StoreEntry { readonly t: TombstoneDoc; readonly via?: string; readonly ground: DeletionGround | 'absent'; readonly proven: boolean }

/**
 * The ONE write of an arriving tombstone: a version-guarded upsert (bundle-81, design rev 8 §6c, decisions 1 and 13).
 *
 *  - **No tombstone held**: it is inserted — the arriving document, `issuedHere: false` (the mark is a local writer's, never a peer's), and a fresh position
 *    of THIS instance's stream, so every hop below is served it whatever the issuer's version was.
 *  - **One held at a LOWER version** (a newer deletion of the same id): the filter `{ _id, seq < arriving }` matches and the `$set` takes `seq`, `deletedAt`,
 *    `originalSeq` and a fresh position ONLY. The stored `instanceId`, `storedVia` and `issuedHere` are kept — a peer's text never changes who issued a
 *    deletion — unless the deletion authority PROVED the issuer (the deliverer is the issuer, ground `issuer`): then the issuer text is stored and
 *    `issuedHere` is false. `storedVia` is set when the ground is the upstream and never cleared by a replace.
 *  - **One held at the same version or higher**: the filter misses, the upsert tries to insert the id and fails with a duplicate key, which the caller reads
 *    back as "already newer here". Nothing is written, so no position and no version are spent on a copy that is not newer.
 *
 * `$set` and `$setOnInsert` never name the same path (the server refuses it), so the issuer pair sits in the one that fits what was proven.
 */
function guardedUpsertOf({ t, via, proven }: StoreEntry, landing: { pos: number; posAtSeq: number }) {
  const set: Record<string, unknown> = {
    seq: t.seq, deletedAt: t.deletedAt, ...(t.originalSeq !== undefined ? { originalSeq: t.originalSeq } : {}),
    pos: landing.pos, posAtSeq: landing.posAtSeq,
    ...(via !== undefined ? { storedVia: via } : {}),
    ...(proven ? { instanceId: t.instanceId, issuedHere: false } : {}),
  };
  const onInsert: Record<string, unknown> = { type: t.type, spaceId: t.spaceId, ...(proven ? {} : { instanceId: t.instanceId, issuedHere: false }) };
  return { updateOne: { filter: { _id: t._id, seq: { $lt: t.seq } }, update: { $set: set, $setOnInsert: onInsert }, upsert: true } };
}

/**
 * The tombstones whose guarded write failed on a duplicate key, from the failure `writeInOneCommands` raised — or THROWS when it was anything else.
 *
 * The write is unordered and sliced, so a failed slice arrives wrapped in `SlicedBulkWriteError.failures[]`, each failure a `MongoBulkWriteError` whose
 * `writeErrors` name their operations by their place in THAT slice (decision 31): the slice is read back from `slices`, which the caller filled in the
 * order the slices were written. A failure that is not a per-operation duplicate (the store, a bound that ended the write, a document the store
 * refuses) is the page's, and is rethrown as it is.
 */
function duplicateKeysOf(err: unknown, slices: ReadonlyArray<ReadonlyArray<{ entry: StoreEntry }>>): Array<{ t: TombstoneDoc; ground: string }> {
  if (!(err instanceof SlicedBulkWriteError)) throw err;
  const out: Array<{ t: TombstoneDoc; ground: string }> = [];
  for (const { slice, error } of err.failures) {
    const failures = bulkWriteFailures(error);
    if (failures === null) throw err;
    for (const f of failures) {
      const item = slices[slice]?.[f.index];
      if (f.code !== DUPLICATE_KEY || item === undefined) throw err;
      out.push({ t: item.entry.t, ground: item.entry.ground });
    }
  }
  return out;
}

/**
 * The forks of every tombstoned subject that is no longer held here, removed with NO tombstone (Q-624 §7, R7): every instance that holds the subject
 * applies the same tombstone and removes its own forks, so nothing crosses. Keyed on the TOMBSTONED ids, not the rows this page deleted, so an
 * `absent` subject's stored forks go too; minus every subject still held (a delete the bound refused, a re-creation the re-read kept), whose forks are
 * still its unresolved versions. Idempotent, so a re-delivery repeats it at no cost.
 */
async function cascadeToForks(spaceId: string, cascade: ReadonlyArray<{ type: TombstoneDoc['type']; id: string }>): Promise<void> {
  const byType = new Map<TombstoneDoc['type'], string[]>();
  for (const c of cascade) {
    if (!byType.has(c.type)) byType.set(c.type, []);
    byType.get(c.type)!.push(c.id);
  }
  for (const [type, ids] of byType) {
    const family = TOMBSTONE_COLLECTION[type];
    const still = await readStoredById<object>(spaceCollection(spaceId, family), ids, { _id: 1 });
    const forks = await forkRowsUnder(spaceId, family, ids.filter(id => !still.has(id)));
    if (forks.length === 0) continue;
    // A delete frees each fork's local fields with it, the write guard included.
    await col<{ _id: string }>(spaceCollection(spaceId, family)).deleteMany(asFilter<{ _id: string }>({ _id: { $in: forks.map(f => f._id) } }));
  }
}

/**
 * Remove the face labels of the entities this page deleted. Every id when the bulk deleted as many as it was handed; else
 * only the ones no longer held — a delete the bound refused left its entity here, and its faces keep their label.
 */
async function unlabelRemoved(spaceId: string, ids: readonly string[], deleted: number): Promise<void> {
  if (deleted === 0) return;
  let gone = [...ids];
  if (deleted < ids.length) {
    const left = await readStoredById<object>(spaceCollection(spaceId, 'entities'), ids, { _id: 1 });
    gone = ids.filter(id => !left.has(id));
  }
  await unlabelFacesForEntities(spaceId, gone);
}
