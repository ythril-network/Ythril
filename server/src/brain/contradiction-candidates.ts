/**
 * Persistence for contradiction candidates (F-REVIEW slice 3b).
 *
 * The scan loop that finds pairs is separate; this owns what happens to a pair once the judge has spoken.
 * It reuses the duplicate machinery deliberately rather than growing a parallel one:
 *
 *   - the same canonical pair id (`aId:bId`, lexicographically ordered) so one pair is one row however it
 *     was encountered;
 *   - `pairContentHash` for the dismissal fingerprint;
 *   - **`decideDismissed`** — the sticky-dismissal policy from the #415 fix — unchanged. A dismissed
 *     contradiction must survive a re-embed or a peer re-sync (seq bumps that change no content) and must
 *     re-open when the text materially changes. That rule was hard to get right once; deriving a second
 *     copy for contradictions is how the two would drift apart.
 *
 * **An `unjudged` verdict writes nothing.** Not an "unjudged" row, not a "clean" row — nothing. The pair
 * simply stays unsettled and is re-examined on a later scan. Persisting it in any form would make an
 * outage look like a review: every status query filters on `open`/`dismissed`/`resolved`, so a row that is
 * none of those either hides the pair forever or, worse, reads as reviewed-and-fine.
 */
import { col, asFilter, asDoc, asUpdate } from '../db/mongo.js';
import { pairContentHash, decideDismissed } from './dupe-scanner.js';
import type { ContradictionCandidateDoc, DupeScanType } from '../config/types.js';
import type { Verdict, PropertyDisagreement } from './contradiction-judge.js';
import { spaceCollection } from '../db/space-collection.js';

const collectionFor = (spaceId: string) => col<ContradictionCandidateDoc>(spaceCollection(spaceId, 'contradictionCandidates'));

/** Canonical pair id — order-independent, so A-vs-B and B-vs-A are the same candidate. */
export function contradictionPairId(aId: string, bId: string): string {
  return aId < bId ? `${aId}:${bId}` : `${bId}:${aId}`;
}

export interface PairSide {
  id: string;
  summary: string;
  seq: number;
}

export type RecordOutcome = 'created' | 'updated' | 'kept-dismissed' | 'reopened' | 'skipped-unjudged';

/** What a judged pair should do to the store. Separated from the writing so it is exhaustively
 *  unit-testable with no database — the same reason `decideDismissed` is pure. */
export type CandidateAction =
  | { do: 'nothing'; outcome: 'skipped-unjudged' }
  | { do: 'delete'; outcome: 'updated' }
  | { do: 'insert'; outcome: 'created' }
  | { do: 'refresh-dismissed'; outcome: 'kept-dismissed' }
  | { do: 'keep'; outcome: 'kept-dismissed' }
  | { do: 'reopen'; outcome: 'reopened' }
  | { do: 'update'; outcome: 'updated' };

/**
 * Decide what a verdict means for the stored candidate. Pure.
 *
 * `dismissalDecision` is `decideDismissed`'s answer for this pair, or null when the stored row is not
 * dismissed — passed in rather than computed here so this stays free of the content-hash lookup.
 */
export function decideCandidateAction(
  existing: Pick<ContradictionCandidateDoc, 'status'> | null,
  verdict: Verdict,
  dismissalDecision: 'keep' | 'refresh' | 'reopen' | null,
): CandidateAction {
  // The judge could not answer: write nothing, settle nothing, look again later.
  if (verdict.kind === 'unjudged') return { do: 'nothing', outcome: 'skipped-unjudged' };

  // They agree. Any OPEN finding is stale and must leave the reviewer's list; a dismissed or resolved row
  // is a human decision about this pair and is left alone.
  if (verdict.kind === 'agree') {
    return existing?.status === 'open'
      ? { do: 'delete', outcome: 'updated' }
      : { do: 'nothing', outcome: 'skipped-unjudged' };
  }

  if (!existing) return { do: 'insert', outcome: 'created' };

  if (existing.status === 'dismissed') {
    if (dismissalDecision === 'keep') return { do: 'keep', outcome: 'kept-dismissed' };
    if (dismissalDecision === 'reopen') return { do: 'reopen', outcome: 'reopened' };
    return { do: 'refresh-dismissed', outcome: 'kept-dismissed' };
  }

  // Open or resolved: refresh the evidence, but never silently re-open what a human resolved.
  return { do: 'update', outcome: 'updated' };
}

/**
 * Re-attribute a verdict's per-field values to the sides as they are STORED.
 *
 * `findPropertyDisagreements` reports `aValue` for its first argument; the row stores `aId` as the
 * lexicographically lower of the two ids. Those coincide only when the caller happened to pass them in id
 * order — a coin flip — so for half of all structured findings the stored row attributed each value to the
 * wrong record, and the review card read "srv-a claims 8080" about the record claiming 443. Nothing errors,
 * the finding is real, and only its evidence is inverted, which is the hardest kind of wrong to notice.
 *
 * Pure, and exported, so it can be enumerated without a database.
 */
export function fieldsInStoredOrder(fields: PropertyDisagreement[], swapped: boolean): PropertyDisagreement[] {
  if (!swapped) return fields;
  return fields.map(f => ({ key: f.key, aValue: f.bValue, bValue: f.aValue }));
}

/**
 * Record (or update) a judged pair.
 *
 * Returns what it did, so a scan can report honestly rather than counting every pair it looked at as a
 * finding.
 */
export async function recordContradiction(
  spaceId: string,
  type: DupeScanType,
  a: PairSide,
  b: PairSide,
  verdict: Verdict,
): Promise<RecordOutcome> {
  if (verdict.kind === 'unjudged') return 'skipped-unjudged';   // see the module note

  const swapped = a.id >= b.id;
  const [lo, hi] = swapped ? [b, a] : [a, b];
  const _id = contradictionPairId(a.id, b.id);
  const coll = collectionFor(spaceId);
  const existing = await coll.findOne(asFilter<ContradictionCandidateDoc>({ _id })) as ContradictionCandidateDoc | null;
  const now = new Date().toISOString();

  // The dismissal policy needs the content fingerprint, so it is resolved only for a dismissed row.
  let hash: string | undefined;
  let dismissal: 'keep' | 'refresh' | 'reopen' | null = null;
  if (existing?.status === 'dismissed') {
    hash = await pairContentHash(spaceId, type, lo.id, hi.id);
    dismissal = decideDismissed(existing, lo.seq, hi.seq, hash);
  }

  // ONE source of truth for what a verdict means — the pure decision, exhaustively unit-tested.
  const action = decideCandidateAction(existing, verdict, dismissal);

  const base = {
    spaceId, type,
    aId: lo.id, aSummary: lo.summary, aSeq: lo.seq,
    bId: hi.id, bSummary: hi.summary, bSeq: hi.seq,
    ...(verdict.kind === 'contradiction'
      ? {
          basis: verdict.basis,
          confidence: verdict.confidence,
          // Re-attributed to the sides as stored — see `fieldsInStoredOrder`. The verdict names values by
          // ARGUMENT position; `aId` above is the lower id.
          ...(verdict.basis === 'structured-field' && verdict.fields
            ? { fields: fieldsInStoredOrder(verdict.fields, swapped) }
            : {}),
          // Carried onto the stored finding, because the reviewer who has to act on it is the one who needs
          // to know the judge may have read only the opening of a long record. Set only when true, so its
          // absence is not a claim that the whole text fitted the model's window.
          ...(verdict.truncated ? { truncated: true as const } : {}),
        }
      : {}),
    updatedAt: now,
  };

  switch (action.do) {
    case 'nothing':
    case 'keep':
      break;
    case 'delete':
      await coll.deleteOne(asFilter<ContradictionCandidateDoc>({ _id }));
      break;
    case 'insert':
      await coll.insertOne(asDoc<ContradictionCandidateDoc>({ _id, ...base, status: 'open', detectedAt: now } as ContradictionCandidateDoc));
      break;
    case 'refresh-dismissed':
      await coll.updateOne(asFilter<ContradictionCandidateDoc>({ _id }),
        asUpdate<ContradictionCandidateDoc>({ $set: { ...base, dismissedContentHash: hash } }));
      break;
    case 'reopen':
      await coll.updateOne(asFilter<ContradictionCandidateDoc>({ _id }),
        asUpdate<ContradictionCandidateDoc>({ $set: { ...base, status: 'open' }, $unset: { dismissedContentHash: '' } }));
      break;
    case 'update':
      await coll.updateOne(asFilter<ContradictionCandidateDoc>({ _id }), asUpdate<ContradictionCandidateDoc>({ $set: base }));
      break;
  }
  return action.outcome;
}
