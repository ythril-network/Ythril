/**
 * The mark a fork row carries when another instance resolved its own copy and this instance's deletion authority declined the removal
 * (Q-624, design rev 4 §9a): the one shape of the mark, its bound, and its one writer.
 *
 * ## The question it answers
 *
 * "Another instance says it decided this unchosen version; record that, here, for this instance's user to decide." It never deletes anything:
 * a peer's word about a row another author wrote is not obeyed (`sync/deletion-authority.ts`), it is shown to the user who holds the row
 * (owner, 2026-10-25: my instance, my data).
 *
 * ## What is inside, so no caller can drop it
 *
 *  - **The bound.** One entry per issuer, holding that issuer's highest version, and at most {@link MAX_RESOLVED_ELSEWHERE} entries, the
 *    highest versions kept. It is computed by the store in the update itself, so no writer can grow the array past it.
 *  - **The fork-only filter.** The write matches `{ _id, forkOf: { $exists: true } }`: a row that is no fork is never marked, whoever asks.
 *  - **No version and no position.** The field is local-only (`RESOLVED_ELSEWHERE`, `sync/local-only-fields.ts`), never hashed and never
 *    served, so writing it is not a change of the record.
 *
 * Its two callers are the two halves of one rule, so arrival order does not decide the outcome: the decline branch of `applyPeerTombstones`
 * (the fork is held, its tombstone arrives) and the arrival writer (the tombstone is held, a relayed fork arrives, `planArrivals` admits it
 * with the mark it builds from the held tombstone).
 */
import { col, asBulk } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { inChunks, ROWS_PER_BULK_COMMAND } from '../util/chunks.js';
import { RESOLVED_ELSEWHERE } from './local-only-fields.js';
import { forksResolvedElsewhereTotal } from '../metrics/registry.js';
import { assertSpaceTakesWrites } from '../spaces/space-write-gate.js';

/** The most entries one fork's mark holds: past it, the lowest versions are dropped. A peer that names issuers it is not can add at most this many hints. */
export const MAX_RESOLVED_ELSEWHERE = 16;

/** One entry of the mark: who resolved the fork elsewhere, when, at which version, whether the delivery proved it, and who relayed it when not the issuer. */
export interface ResolvedElsewhereEntry {
  by: string;
  at: string;
  seq: number;
  proven: boolean;
  via?: string;
}

/**
 * The entry a declined (or not-governing) tombstone makes: from its issuer, its deletion time and its version. `proven` is what the delivery
 * proved about the issuer; `via` the deliverer when it is not the issuer. Built here, so the two callers cannot spell the entry differently.
 */
export function resolvedElsewhereEntry(
  tombstone: { instanceId?: string; deletedAt: string; seq: number }, delivery: { proven: boolean; deliverer?: string },
): ResolvedElsewhereEntry {
  const by = tombstone.instanceId ?? '';
  return {
    by, at: tombstone.deletedAt, seq: tombstone.seq, proven: delivery.proven,
    ...(delivery.deliverer !== undefined && delivery.deliverer !== by ? { via: delivery.deliverer } : {}),
  };
}

/**
 * The update pipeline that merges `entry` into a row's mark: the issuer's older entry is replaced, a newer one kept, and the array is cut to the
 * {@link MAX_RESOLVED_ELSEWHERE} highest versions. Every peer value is a `$literal`, so a text that looks like an operator is only text.
 */
export function resolvedElsewhereUpdate(entry: ResolvedElsewhereEntry): Record<string, unknown>[] {
  const held = { $ifNull: [`$${RESOLVED_ELSEWHERE}`, []] };
  const sameIssuer = { $eq: ['$$m.by', { $literal: entry.by }] };
  return [{
    $set: {
      [RESOLVED_ELSEWHERE]: {
        $let: {
          vars: {
            others: { $filter: { input: held, as: 'm', cond: { $not: [sameIssuer] } } },
            prior: { $first: { $filter: { input: held, as: 'm', cond: sameIssuer } } },
          },
          in: {
            $slice: [{
              $sortArray: {
                input: {
                  $concatArrays: ['$$others', [{
                    $cond: [{ $gte: [{ $ifNull: ['$$prior.seq', -1] }, entry.seq] }, '$$prior', { $literal: entry }],
                  }]],
                },
                sortBy: { seq: -1 },
              },
            }, MAX_RESOLVED_ELSEWHERE],
          },
        },
      },
    },
  }];
}

/** One mark to write: the fork row of `collection` it is for, and the entry. */
export interface ResolvedElsewhereMark {
  collection: string;
  kind: string;
  id: string;
  entry: ResolvedElsewhereEntry;
}

/**
 * Write the marks, one bulk per collection (sliced), each filtered to a FORK row. Called inside the caller's admitted write unit; counted on
 * `ythril_forks_resolved_elsewhere_total{kind}` by the rows it marked.
 */
export async function writeResolvedElsewhere(spaceId: string, marks: readonly ResolvedElsewhereMark[]): Promise<void> {
  if (marks.length === 0) return;
  // Its callers write inside an admitted unit; the gate is asked here too, so a mark never lands in a space a standing act refuses.
  assertSpaceTakesWrites(spaceId);
  const byCollection = new Map<string, ResolvedElsewhereMark[]>();
  for (const m of marks) {
    if (!byCollection.has(m.collection)) byCollection.set(m.collection, []);
    byCollection.get(m.collection)!.push(m);
  }
  for (const [collection, list] of byCollection) {
    const coll = col<{ _id: string }>(spaceCollection(spaceId, collection as never));
    for (const chunk of inChunks(list, ROWS_PER_BULK_COMMAND)) {
      const res = await coll.bulkWrite(asBulk<{ _id: string }>(chunk.map(m => ({
        updateOne: { filter: { _id: m.id, forkOf: { $exists: true } }, update: resolvedElsewhereUpdate(m.entry) },
      }))), { ordered: false });
      const kind = chunk[0]!.kind;
      if ((res.matchedCount ?? 0) > 0) forksResolvedElsewhereTotal.labels({ kind }).inc(res.matchedCount);
    }
  }
}
