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
 *  6. **The counter**, after the write whatever became of it, awaited, over every ADMITTED seq (a tombstone
 *     refused on authorship still tells us where that peer's clock is). A counter that could not move fails the
 *     call when nothing else did (`CounterBehindError`, `sync/counter-after-page.ts` — the one post-step every page
 *     door ends with); under an apply error it is logged and the apply error
 *     is the one thrown. Why a tombstone moves the counter at all, in `bumpSeq`'s own words — "future local writes
 *     always get a seq higher than any document received from this peer":
 *
 *       a busy peer (counter 5001) deletes a record            -> tombstone, seq 5001
 *       a quiet peer (counter 300) receives it                 -> counter stays 300
 *       the quiet peer re-creates that record with the same id -> local seq 301
 *       it pushes back                                         -> refused as `tombstoned`, with a 200
 *
 *     Awaited before any answer (`Q-198`), so a sender is never told a page landed while the counter is behind it.
 *
 * An entity this apply deletes has its face labels removed (`unlabelFacesForEntities`, `Q-395`): the descriptor belongs
 * to the file and stays, the claim of whose face it is goes with the person.
 *
 * Refusals are named in ONE warning per page, through `warnArrivalsNotStored`, so a refusal reads the same from a
 * tombstone as from a record, and every peer value in it goes through `logSafe`.
 */
import { z } from 'zod';
import { col, asBulk, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { readStoredById } from '../db/read-by-id.js';
import { writeInOneCommands } from '../db/one-command.js';
import { inChunks, ROWS_PER_BULK_COMMAND } from '../util/chunks.js';
import { TOMBSTONE_TYPES, TOMBSTONE_COLLECTION } from '../config/types.js';
import type { TombstoneDoc } from '../config/types.js';
import { getConfig } from '../config/loader.js';
import { advanceCounterPast } from './counter-after-page.js';
import { log, logSafe, peerList, peerText } from '../util/log.js';
import { seqRefusal, arrivalId, refusedFieldsOf, warnArrivalsNotStored, type ArrivalRefusal } from './arrivals.js';
import { recordDecline, sayDeclines, saidDeletions } from './decline-report.js';
import { retagToLocalSpace } from './upsert-plan.js';
import { authorises, deleteBound, MAX_ISSUER, type Delivery, type DeletionGround, type DeletionTarget } from './deletion-authority.js';
import { unlabelFacesForEntities } from '../brain/entities.js';
import { syncTombstonesAppliedTotal } from '../metrics/registry.js';

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
  instanceId: z.string().max(MAX_ISSUER),
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
  if (!parsed.success) return { refused: { _id: arrivalId(raw), reason: `not a tombstone (${refusedFieldsOf(parsed.error)})` } };
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
type HeldTarget = DeletionTarget & { seq?: number };

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
    /** A stored tombstone, and the upstream it is stored for when it stood on that ground. */
    const store: Array<{ t: TombstoneDoc; via?: string }> = [];
    /**
     * Per target collection, ground and — on the issuer ground, whose bound names it — issuer: the rows to delete. Every
     * row of one group carries the same bound, so a group is ONE `deleteMany` (per `ROWS_PER_BULK_COMMAND` ids).
     */
    const deletes: Array<{ type: TombstoneDoc['type']; ground: DeletionGround; issuer: string; rows: TombstoneDoc[] }> = [];
    for (const [type, list] of byCollection) {
      const targets = await readStoredById<HeldTarget>(
        spaceCollection(localSpaceId, TOMBSTONE_COLLECTION[type]), list.map(t => t._id),
        { 'author.instanceId': 1, deliveredBy: 1, seq: 1 });
      const groups = new Map<string, { ground: DeletionGround; issuer: string; rows: TombstoneDoc[] }>();
      for (const t of list) {
        const target = targets.get(t._id);
        // `t.instanceId` is the sender's text: the authority decides what it is worth, never this loop.
        const verdict = authorises(delivery, t.instanceId, target ?? null, selfId);
        if (!verdict.ok) {
          recordDecline(ledger, { id: t._id, reason: verdict.reason, kind: type, what: 'record', issuer: t.instanceId, delivery, target });
          continue;
        }
        if (verdict.ground === 'absent') { store.push({ t }); continue; }
        // The re-read only: a record newer than the deletion is a re-creation. It is kept, and so is its tombstone
        // unstored — a held tombstone beside a live record would be served on as a deletion of it.
        if (opts.repair && typeof target?.seq === 'number' && target.seq > t.seq) continue;
        store.push(verdict.ground === 'upstream' && delivery.peerInstanceId ? { t, via: delivery.peerInstanceId } : { t });
        // A stored tombstone at a higher seq means this one is stale: it is not stored over, and deletes nothing.
        const heldSeq = held.get(t._id)?.seq;
        if (typeof heldSeq === 'number' && heldSeq > t.seq) continue;
        // The upstream bound names no issuer (it is the stamp and the self-exclusion), so every issuer shares its group.
        const issuer = verdict.ground === 'issuer' ? t.instanceId : '';
        const key = JSON.stringify([verdict.ground, issuer]);
        if (!groups.has(key)) groups.set(key, { ground: verdict.ground, issuer, rows: [] });
        groups.get(key)!.rows.push(t);
      }
      for (const g of groups.values()) deletes.push({ type, ...g });
    }
    if (store.length > 0) {
      // A page is a peer's: counted (`MAX_TOMBSTONES_PER_REQUEST`), not measured, and an id is text it chose, carried twice
      // by each operation. So the bulk is sliced to stay ONE wire command (`db/one-command.ts`): the driver would split a
      // larger one, and a second command carries a deadline of its own after the bound has answered the sender.
      const tombstones = col<TombstoneDoc>(spaceCollection(localSpaceId, 'tombstones'));
      const ops = store.map(({ t, via }) => ({
        updateOne: {
          filter: { _id: t._id },
          // `storedVia` is set whether or not the row existed: a deletion held before this delivery (an earlier one that
          // stood on no ground, or the same one re-sent) must carry the upstream it is now relayed for.
          update: via === undefined ? { $setOnInsert: t } : { $setOnInsert: t, $set: { storedVia: via } },
          upsert: true,
        },
      }));
      await writeInOneCommands(ops, (slice, { ordered }) => tombstones.bulkWrite(asBulk<TombstoneDoc>(slice), { ordered }), { ordered: false });
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
      if (deleted > 0) syncTombstonesAppliedTotal.labels({ kind: d.type, ground: d.ground }).inc(deleted);
      if (d.type === 'entity') await unlabelRemoved(localSpaceId, d.rows.map(t => t._id), deleted);
    }
    // The re-read says what it deleted once, in its own completion line over every page (`sync/tombstone-reread.ts`): a line
    // per page here would state the same deletions a second time.
    if (!opts.repair) saidDeletions(where, 'record', localSpaceId, out.deleted);
  } catch (err) {
    failed = true;
    failure = err;
  }

  // Step 6, after the write whatever became of it: a page that half-landed must not leave the counter behind it.
  // The apply's own failure is the one thrown; a counter left behind fails the call only when nothing else did.
  const behind = await advanceCounterPast(localSpaceId, out.maxSeq, where);
  warnArrivalsNotStored(where, localSpaceId, 'tombstone', 'refused', out.refused);
  // A standing decline is the same ones every cycle: said once per (peer, space, reason) window, counted every time.
  sayDeclines(where, localSpaceId, 'tombstone', delivery, ledger.declinedBy);
  if (failed) throw failure;
  if (behind) throw behind;
  return out;
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
