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
 *  4. **Authorised before it is stored**: a tombstone whose issuer is not the peer delivering it (unless a trusted
 *     admin relays it), or whose target here was written by another author, is refused and NOT stored. One whose
 *     target is absent, or carries no author (legacy), is stored and deletes.
 *  5. **One write per kind**: one `$in` read of the stored tombstones, one per target collection, one bulk upsert,
 *     one delete per target collection and issuer — a page costs the same whatever its size.
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
 * Refusals are named in ONE warning per page, through `warnArrivalsNotStored`, so a refusal reads the same from a
 * tombstone as from a record, and every peer value in it goes through `logSafe`.
 */
import { z } from 'zod';
import { col, asFilter, asBulk } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { readStoredById } from '../db/read-by-id.js';
import { TOMBSTONE_TYPES, TOMBSTONE_COLLECTION } from '../config/types.js';
import type { TombstoneDoc } from '../config/types.js';
import { advanceCounterPast } from './counter-after-page.js';
import { log, logSafe, peerList, peerText } from '../util/log.js';
import { seqRefusal, arrivalId, warnArrivalsNotStored, type ArrivalRefusal } from './arrivals.js';
import { retagToLocalSpace, tombstoneGoverns } from './upsert-plan.js';

/** Who delivered a page of tombstones — what authorises a tombstone's deletion of a local record. */
export interface TombstoneAuth {
  /** The instance id of the authenticated peer that delivered the page (the peer pulled from, or the pusher). */
  peerInstanceId?: string;
  /** True when the caller is a trusted local/admin token (no peer identity): it may relay any issuer's tombstone. */
  trustedRelay?: boolean;
}

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
  instanceId: z.string(),
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
  if (!parsed.success) {
    // A path names a peer's keys: bounded where the reason is built (`Q-270`).
    const fields = peerList(new Set(parsed.error.issues.map(i => i.path.join('.') || '(element)')), ', ');
    return { refused: { _id: arrivalId(raw), reason: `not a tombstone (${fields})` } };
  }
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
  /** Admitted elements refused on authorisation: NOT stored, nothing deleted. */
  declined: ArrivalRefusal[];
  /** Types this instance does not know. Non-empty: nothing of the page was applied and the counter did not move. */
  unknownTypes: string[];
  /** The highest admitted seq — what the counter was advanced to at least. */
  maxSeq: number;
}

/**
 * Apply a page of tombstones a peer delivered, to the space the door ADMITTED — see the module docblock.
 *
 * @param localSpaceId the local space the door admitted: `req.query.spaceId` after the alias middleware, or the
 *   space the sync cycle is on. Never a tombstone's own `spaceId`, and never the network's id for the space.
 * @param raw the elements as they arrived, unvalidated
 * @param where names the door and the peer, for the log lines only
 */
export async function applyPeerTombstones(
  localSpaceId: string, raw: readonly unknown[], auth: TombstoneAuth, where: string,
): Promise<TombstoneApplyOutcome> {
  const out: TombstoneApplyOutcome = { admitted: 0, refused: [], declined: [], unknownTypes: [], maxSeq: 0 };
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
    const store: TombstoneDoc[] = [];
    /** Per target collection and issuer: the ids to delete. */
    const deletes: Array<{ type: TombstoneDoc['type']; issuer: string; ids: string[] }> = [];
    for (const [type, list] of byCollection) {
      const targets = await readStoredById<{ author?: { instanceId?: string } }>(
        spaceCollection(localSpaceId, TOMBSTONE_COLLECTION[type]), list.map(t => t._id), { 'author.instanceId': 1 });
      const byIssuer = new Map<string, string[]>();
      for (const t of list) {
        const issuer = t.instanceId;
        // `issuer` is the sender's text: matching it against the record's author proves nothing on its own. The
        // delete is authorised only when the issuer IS the authenticated peer, or a trusted admin relays it.
        const authorised = auth.trustedRelay === true
          || (auth.peerInstanceId !== undefined && auth.peerInstanceId === issuer);
        if (!authorised) {
          // Both ids are text a peer chose: bounded where the reason is built (`Q-270`).
          out.declined.push({ _id: t._id, reason: `issuer '${peerText(issuer)}' is not the delivering peer `
            + `'${peerText(auth.peerInstanceId ?? '-')}' — possible cross-instance delete forgery` });
          continue;
        }
        const author = targets.get(t._id)?.author?.instanceId;
        if (!tombstoneGoverns(issuer, author)) {
          out.declined.push({ _id: t._id, reason: `the record here was written by '${peerText(author)}', not by the issuer '${peerText(issuer)}'` });
          continue;
        }
        store.push(t);
        // A stored tombstone at a higher seq means this one is stale: it is not stored over, and deletes nothing.
        const heldSeq = held.get(t._id)?.seq;
        if (typeof heldSeq === 'number' && heldSeq > t.seq) continue;
        if (!byIssuer.has(issuer)) byIssuer.set(issuer, []);
        byIssuer.get(issuer)!.push(t._id);
      }
      for (const [issuer, delIds] of byIssuer) deletes.push({ type, issuer, ids: delIds });
    }
    if (store.length > 0) {
      await col<TombstoneDoc>(spaceCollection(localSpaceId, 'tombstones')).bulkWrite(asBulk<TombstoneDoc>(store.map(t => ({
        updateOne: { filter: { _id: t._id }, update: { $setOnInsert: t }, upsert: true },
      }))), { ordered: false });
    }
    for (const d of deletes) {
      // Bounded to the issuer's records (or author-less ones) IN the delete, so a record another author wrote
      // between the read above and this write is not taken with it.
      await col(spaceCollection(localSpaceId, TOMBSTONE_COLLECTION[d.type])).deleteMany(asFilter({
        _id: { $in: d.ids }, 'author.instanceId': { $in: [d.issuer, null, ''] },
      }));
    }
  } catch (err) {
    failed = true;
    failure = err;
  }

  // Step 6, after the write whatever became of it: a page that half-landed must not leave the counter behind it.
  // The apply's own failure is the one thrown; a counter left behind fails the call only when nothing else did.
  const behind = await advanceCounterPast(localSpaceId, out.maxSeq, where);
  warnArrivalsNotStored(where, localSpaceId, 'tombstone', 'refused', [...out.refused, ...out.declined]);
  if (failed) throw failure;
  if (behind) throw behind;
  return out;
}
