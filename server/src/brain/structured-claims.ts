/**
 * What a record CLAIMS, for the structured contradiction judge.
 *
 * The judge compares two records key-by-key: same key, different value, single-valued ⇒ they disagree. For
 * facts and entities that map is simply `properties`. Chrono entries are the reason this module exists —
 * their most contradictable claim is not in `properties` at all but in a top-level column, so without this
 * the structured judge would have had nothing to compare and chrono would have been swept by a judge that
 * could only ever return "no structured conflict".
 *
 * ── Why `status` and NOT the dates ──────────────────────────────────────────────────────────────────────
 *
 * `status` is a genuine single-valued claim: one entry says the thing is `completed`, the other says it is
 * `cancelled`. Only one can be true, and because status is part of a chrono entry's embedded text, two
 * entries reaching the ≥0.92 near-duplicate threshold *while disagreeing about it* are near-certainly the
 * same event logged twice. That is a high-signal pair worth a reviewer's time.
 *
 * `startsAt` / `endsAt` are deliberately EXCLUDED, and this is not an oversight to be "completed" later:
 *
 *   - The dates are not embedded, so two occurrences of a repeating event ("Team sync", weekly, logged by
 *     hand rather than with a `recurrence` block) have near-identical embed text and pair at ~1.0 — with
 *     different dates, every single time. Reporting those as contradictions would fill the queue with the
 *     one thing that is definitely NOT a contradiction, and a review queue that cries wolf stops being read.
 *   - A pair that similar is already reported by the DUPLICATE scanner. Adding a date "contradiction" would
 *     re-report the same two records in a second queue under a second name.
 *
 * Same reasoning that deferred edges: a detector without the semantics to tell "two facts" from "two claims"
 * is worse than no detector. The trigger for revisiting is a way to know an entry is a unique occurrence
 * rather than one of a series — not simply someone deciding dates ought to count.
 *
 * Both the write path (`insert-contradictions.ts`) and the sweep (`contradiction-scanner.ts`) read claims
 * through here, on purpose: if the two disagreed about what a contradiction IS, an insert would warn about
 * something the nightly scan then never flagged (or the reverse), which is the sort of inconsistency nobody
 * reports as a bug and everybody stops trusting.
 */
import { col, asFilter } from '../db/mongo.js';
import { RECORD_COLLECTION as COLLECTION_SUFFIX } from '../config/types.js';

/** A record's single-valued claims, keyed by field name. */
export type ClaimMap = Record<string, string | number | boolean>;

// The record-to-collection map is imported. The copy here was typed `Record<string, string>`, which is a
// map with no keys: a typo for a record kind read as `undefined` and built a collection name ending in
// "undefined". Two of the five copies were spelled that way.

/** Top-level stored columns that count as claims, beyond `properties`. Empty for most types. */
const EXTRA_CLAIM_FIELDS: Record<string, readonly string[]> = {
  chrono: ['status'],
};

export function extraClaimFields(type: string): readonly string[] {
  return EXTRA_CLAIM_FIELDS[type] ?? [];
}

/**
 * The claim map for one record: its `properties`, plus any type-specific top-level columns.
 *
 * A top-level column WINS over a same-named entry in `properties` — the column is the field the rest of the
 * system reads and writes, so letting a stray property shadow it would judge against a value nothing else
 * honours.
 */
export function structuredClaims(
  type: string,
  record: { properties?: ClaimMap } & Record<string, unknown>,
): ClaimMap | undefined {
  const extras = extraClaimFields(type);
  if (extras.length === 0) return record.properties;

  const out: ClaimMap = { ...(record.properties ?? {}) };
  for (const key of extras) {
    const v = record[key];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Read the claim maps of `ids` straight from the collection, in one round trip.
 *
 * Callers must use this rather than whatever the vector search handed back, because a recall result is not
 * always the stored value: `RecallChrono.status` is DERIVED — `overdue` is computed from the clock at read
 * time and never stored — so judging on it would produce a verdict that changes as the day passes while the
 * records themselves sit untouched. A persisted contradiction candidate has to mean the same thing tomorrow.
 *
 * Best-effort: returns an empty map rather than throwing, since every caller is on a path (a write, or a
 * background sweep) where failing to judge must not fail the operation.
 */
export async function fetchStructuredClaims(
  spaceId: string, type: string, ids: string[],
): Promise<Map<string, ClaimMap | undefined>> {
  const out = new Map<string, ClaimMap | undefined>();
  // `type` is an unvalidated string on purpose — every caller is on a best-effort path and holds one
  // too. So the widening is HERE and visible, in one line, rather than being a map declared without keys:
  // an unknown type yields `undefined` and the guard below returns nothing, which is the contract.
  const suffix = (COLLECTION_SUFFIX as Record<string, string | undefined>)[type];
  if (!suffix || ids.length === 0) return out;

  const projection: Record<string, number> = { _id: 1, properties: 1 };
  for (const f of extraClaimFields(type)) projection[f] = 1;

  try {
    const docs = await col<{ _id: string }>(`${spaceId}_${suffix}`)
      .find(asFilter<{ _id: string }>({ _id: { $in: ids } }), { projection })
      .toArray() as Array<{ _id: string } & Record<string, unknown>>;
    for (const d of docs) out.set(d._id, structuredClaims(type, d as { properties?: ClaimMap } & Record<string, unknown>));
  } catch { /* best-effort — an unjudged pair is recoverable, a failed write is not */ }
  return out;
}
