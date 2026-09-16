/**
 * The contradiction judge (F-REVIEW slice 3a) — decides whether a candidate pair actually DISAGREES.
 *
 * Pure: it takes two already-paired records and returns a verdict. Finding the pairs is the scanner's job
 * (embedding search over the same subject), and persisting them is the candidate collection's. Keeping the
 * decision separate from the plumbing is deliberate — this is the part with the subtle failure modes, and
 * it is unit-testable without a database or a model.
 *
 * Two judges, cheapest first:
 *
 *  1. **Structured** — the two records set the same property key to different values. Deterministic, free,
 *     no egress, and the same rule `computeMergePlan` uses to raise a merge conflict. If a schema declares
 *     the property multi-valued this is NOT a contradiction: "tags: [a]" vs "tags: [b]" is two facts, not
 *     two claims. Only single-valued (functional) properties can contradict.
 *  2. **NLI** — an entailment model reading the two texts. Used only when the structured pass found
 *     nothing, because a deterministic answer beats a probabilistic one and costs nothing.
 *
 * **The verdict has three states, not two.** `contradiction` / `agree` / **`unjudged`**. That third state
 * carries the weight: when the NLI endpoint is unset, unreachable or unreadable, the pair is UNJUDGED and
 * must be re-examined on a later scan. Folding it into "agree" would let an outage silently mark every pair
 * as fine — permanently, since a scanner that records a verdict does not revisit it — and the Review queue
 * would look clean precisely when the judge was broken.
 */
import { classify, nliConfigured } from './nli-client.js';
import type { TypeSchema } from '../config/types.js';

/** One record as the judge sees it. Collection-agnostic on purpose: facts, entities and chrono entries
 *  all reduce to "some text, and some properties". */
export interface JudgeableRecord {
  id: string;
  /** The record's free text — a fact's fact, an entity's description, a chrono title. May be empty. */
  text: string;
  properties?: Record<string, string | number | boolean>;
}

export interface PropertyDisagreement {
  key: string;
  aValue: string | number | boolean;
  bValue: string | number | boolean;
}

export type ContradictionBasis = 'structured-field' | 'nli';

/**
 * Character length past which an encoder NLI model has almost certainly not seen the whole text.
 *
 * Reported by an operator running their own judge: encoder cross-encoders cap at **512 tokens**, their entity
 * descriptions run to several thousand characters, and a pair is therefore judged on its opening paragraphs —
 * with a completely normal-looking confidence. Nothing errors, so a verdict about the first page is
 * indistinguishable from a verdict about the record.
 *
 * **This is a PROXY and is reported as one.** We cannot know the configured model's tokenizer, so the flag
 * says "long enough that a 512-token window was probably exceeded", never "we truncated it" — we do not
 * truncate; the model does, invisibly. 1,800 characters is a deliberately conservative stand-in for 512
 * tokens at the ~3.5–4 chars/token that English prose runs to: it under-reports rather than cries wolf,
 * because a flag that fires on ordinary records is one reviewers learn to ignore.
 */
export const NLI_LIKELY_TRUNCATED_CHARS = 1_800;

export type Verdict =
  | { kind: 'contradiction'; basis: ContradictionBasis; confidence: number; fields?: PropertyDisagreement[]; truncated?: true }
  | { kind: 'agree'; basis: ContradictionBasis; confidence: number; truncated?: true }
  /** No judgement was possible. NOT "they agree" — the pair must be re-examined on a later scan. */
  /**
   * No judgement was recorded. NOT "they agree".
   *
   * The reasons are not interchangeable, and the scanner's cursor depends on the difference:
   *   - `low-confidence`     the judge ANSWERED, just weakly. Re-running gives the same answer, so the
   *                          scan may move past this pair.
   *   - `judge-unavailable`  the judge could not answer (unreachable, unreadable). Re-running later may
   *                          well succeed, so the scan must NOT treat this pair as settled.
   *   - `no-judge-configured` / `no-text` — nothing to ask, or nothing to ask about.
   *   - `model-not-consulted` the caller asked for the deterministic pass ONLY and it found nothing. A
   *                          judge may well be configured and reachable; we chose not to spend it.
   */
  | { kind: 'unjudged'; reason: 'no-judge-configured' | 'judge-unavailable' | 'low-confidence' | 'no-text' | 'model-not-consulted' };

/**
 * Did reaching this verdict cost a call to the NLI endpoint?
 *
 * Lives here, next to the code that decides, because it is a statement about `judgePair`'s internals and a
 * second copy in the scanner would drift the moment a branch moved. The scanner needs it to report what a
 * sweep actually SPENT — which is not the same as what it settled:
 *
 *   - a `low-confidence` answer was paid for in full and then discarded;
 *   - `judge-unavailable` means the record text left the instance and the response was unusable — egress
 *     happened, so a caller counting cost must count it;
 *   - a `structured-field` contradiction, `no-text`, `no-judge-configured` and `model-not-consulted` all
 *     reach no endpoint at all.
 */
export function consultedModel(v: Verdict): boolean {
  if (v.kind === 'unjudged') return v.reason === 'low-confidence' || v.reason === 'judge-unavailable';
  return v.basis === 'nli';
}

/** Multi-valued properties hold a set of facts, so two different values are additive, not contradictory. */
function isSingleValued(key: string, schemas?: Record<string, TypeSchema>): boolean {
  for (const schema of Object.values(schemas ?? {})) {
    const prop = schema?.propertySchemas?.[key];
    if (!prop) continue;
    // An enum or a scalar type is single-valued; anything the schema marks as a list is not.
    if (prop.type === 'string' || prop.type === 'number' || prop.type === 'boolean' || prop.type === 'date') return true;
  }
  // Unknown to every schema: treat as single-valued. A free-form property set twice to different values is
  // the ordinary case a reviewer wants to see; missing it is worse than showing one they dismiss.
  return true;
}

/**
 * Properties both records set, to different values. The deterministic half of the judge — same rule as
 * `computeMergePlan`'s property conflicts, minus the merge-resolution machinery.
 */
export function findPropertyDisagreements(
  a: JudgeableRecord,
  b: JudgeableRecord,
  schemas?: Record<string, TypeSchema>,
): PropertyDisagreement[] {
  const ap = a.properties ?? {};
  const bp = b.properties ?? {};
  const out: PropertyDisagreement[] = [];
  for (const key of Object.keys(ap)) {
    if (!(key in bp)) continue;              // only one record makes a claim — nothing to disagree with
    if (ap[key] === bp[key]) continue;       // same claim
    if (!isSingleValued(key, schemas)) continue;
    out.push({ key, aValue: ap[key], bValue: bp[key] });
  }
  return out;
}

/**
 * Judge a candidate pair.
 *
 * @param minConfidence NLI verdicts below this are treated as `unjudged` rather than reported — a
 *   low-confidence contradiction is noise, and noise in a review queue is what makes people stop reading it.
 * @param structuredOnly Run the deterministic pass and stop. **This is the only way to not spend the model.**
 *   Passing an unreachable `minConfidence` does NOT work: the threshold is applied to the RESPONSE, so the
 *   call is made, the text egresses, the endpoint is billed, and only then is the answer thrown away. The
 *   scanner's structured pass did exactly that, which is where an operator's "judgedPairs: 6 against my
 *   judge's counter of 12" came from — every pair was judged twice, and the free half was not free.
 */
export async function judgePair(
  a: JudgeableRecord,
  b: JudgeableRecord,
  opts: { schemas?: Record<string, TypeSchema>; minConfidence?: number; structuredOnly?: boolean } = {},
): Promise<Verdict> {
  // 1. Deterministic pass first: free, no egress, and not a guess.
  const fields = findPropertyDisagreements(a, b, opts.schemas);
  if (fields.length > 0) {
    return { kind: 'contradiction', basis: 'structured-field', confidence: 1, fields };
  }
  // Asked for the deterministic answer only, and there isn't one. Return BEFORE anything that could reach
  // the endpoint — including the checks below, which would otherwise report a judge problem to a caller that
  // never wanted a judge.
  if (opts.structuredOnly) return { kind: 'unjudged', reason: 'model-not-consulted' };

  // 2. Fall back to the entailment model over the free text.
  if (!a.text?.trim() || !b.text?.trim()) return { kind: 'unjudged', reason: 'no-text' };
  if (!nliConfigured()) return { kind: 'unjudged', reason: 'no-judge-configured' };

  const verdict = await classify(a.text, b.text);
  // classify() returns null for "could not answer" — an outage must never read as agreement.
  if (!verdict) return { kind: 'unjudged', reason: 'judge-unavailable' };

  const min = opts.minConfidence ?? 0.6;
  // A weak answer is still an answer — distinct from an absent one. See the Verdict note.
  if (verdict.score < min) return { kind: 'unjudged', reason: 'low-confidence' };

  // Was either side long enough that the model's window probably cut it? Reported on the verdict rather than
  // logged, because the person who needs it is the reviewer deciding whether to trust this finding — a
  // confident verdict on the first page of a long record reads exactly like a confident verdict on the record.
  // Only set when true, so its absence is not a claim that the text fitted.
  const likelyTruncated = a.text.length > NLI_LIKELY_TRUNCATED_CHARS || b.text.length > NLI_LIKELY_TRUNCATED_CHARS;
  const trunc = likelyTruncated ? { truncated: true as const } : {};

  return verdict.label === 'contradiction'
    ? { kind: 'contradiction', basis: 'nli', confidence: verdict.score, ...trunc }
    : { kind: 'agree', basis: 'nli', confidence: verdict.score, ...trunc };
}
