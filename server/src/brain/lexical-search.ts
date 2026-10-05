/**
 * The lexical half of hybrid retrieval — a BM25-family `$text` channel beside the vector one.
 *
 * **Why a second channel at all.** The vector search compares *meaning*, which is exactly the wrong tool
 * for the tokens enterprise knowledge is most precise about: article numbers, form ids, part codes, clause
 * names, proper nouns. A query for `NMK-240C` has no useful semantic neighbourhood — the embedding of an
 * opaque identifier is nearly arbitrary — so the right chunk can rank below plausible-looking prose and
 * fall outside `topK` entirely. Nothing errors; the answer is just assembled from the wrong passages.
 *
 * **What is indexed, and why it is `matchedText`.** `matchedText` is the exact pre-embedding source string
 * stored on every knowledge type. Indexing it means the lexical channel reads *precisely the text the
 * vector channel embedded* — the two channels disagree about ranking, never about what the document says.
 * Indexing the display fields instead would let a record be lexically findable through text that was never
 * part of its vector, which is a subtler and much harder-to-explain inconsistency.
 *
 * **This is NOT the list filter.** `text-search.ts` provides an escaped `$regex` substring filter that
 * narrows *which records are eligible* on the list endpoints. This decides *how eligible records rank*.
 * Two axes, deliberately not merged (owner, 2026-07-29) — a filter that also scored would make
 * `?search=` silently change result ordering.
 */
import { col } from '../db/mongo.js';
import { RECORD_COLLECTION as COLLECTION_SUFFIX } from '../config/types.js';
import { log, peerText } from '../util/log.js';
import type { RecallKnowledgeType } from './recall.js';
import { byIdAsc } from './recall-shape.js';

/** One document's lexical relevance, as MongoDB's `textScore`. */
export interface LexicalHit {
  _id: string;
  lexicalScore: number;
}

/** Suffix per knowledge type — same mapping `recallByType` uses. */
// The record-to-collection map is imported: it was declared here and in four other modules, all five
// byte-identical, beside a sixth in `brain/ttl.ts` whose own comment said the mapping "was open-coded in
// five places". It had been extracted once and the copies came back.

/**
 * The RRF constant. 60 is the value from the original Cormack et al. rank-fusion work and is the de-facto
 * default; it damps the difference between the top few ranks so one channel's rank-1 cannot dominate the
 * other channel's rank-2 outright.
 */
export const RRF_K = 60;

/** Ceiling on lexical candidates per type, mirroring the vector channel's over-fetch. */
export const LEXICAL_LIMIT_MULTIPLIER = 2;

/**
 * Is hybrid retrieval switched on?
 *
 * Env-only, and deliberately so: this is a rollback lever for when a retrieval regression has to be
 * isolated to one change, not an operator preference. Same reasoning that keeps
 * `allowPrivateModelEndpoints` off the admin API. Default is on — a text index that exists should be
 * used, and an instance without one degrades on its own (see `lexicalSearch`).
 */
export function hybridSearchEnabled(): boolean {
  return process.env['YTHRIL_HYBRID_SEARCH'] !== 'off';
}

/**
 * Rank one type's records lexically.
 *
 * Returns `[]` — never throws — when there is no lexical opinion to be had: no text index on the
 * collection (an instance that has not been re-initialised since this shipped), an empty query, or any
 * driver error. The caller then keeps the pure-vector order, so hybrid degrades to today's behaviour
 * rather than failing the search. A reranker outage and a missing text index must both be survivable.
 */
export async function lexicalSearch(
  spaceId: string,
  knowledgeType: RecallKnowledgeType,
  query: string,
  limit: number,
  /** The caller's eligibility match (tags / filter). Applied by the QUERY — a lexical channel that
   *  skipped it would resurrect records the caller filtered out. */
  eligibility: Record<string, unknown> = {},
): Promise<LexicalHit[]> {
  const q = query.trim();
  if (!q || limit <= 0) return [];
  const collName = `${spaceId}_${COLLECTION_SUFFIX[knowledgeType]}`;

  try {
    const rows = await col(collName)
      .find({ ...eligibility, $text: { $search: q } }, { projection: { _id: 1, lexicalScore: { $meta: 'textScore' } } })
      // `_id` ends the sort, like every other ranking sort in recall (`byIdAsc`). A text score depends only on the
      // matched terms and the field length, so records written from one template tie EXACTLY, and the database
      // orders a tie differently on every call. This order is the lexical RANK, a term of the fused score, so
      // without a tie-break two identical recalls ranked the same records differently and `skip` paging repeated
      // some matches and dropped others (b56).
      .sort({ lexicalScore: { $meta: 'textScore' }, _id: 1 })
      .limit(limit)
      .toArray() as unknown as Array<{ _id: string; lexicalScore?: number }>;

    const out: LexicalHit[] = [];
    for (const r of rows) {
      // A non-finite score would sort unpredictably against the vector ranks. Drop rather than default:
      // a defaulted 0 reads as "scored and irrelevant", which is a claim, not a gap.
      if (typeof r.lexicalScore !== 'number' || !Number.isFinite(r.lexicalScore)) continue;
      out.push({ _id: String(r._id), lexicalScore: r.lexicalScore });
    }
    return out;
  } catch (err) {
    // The common case is "text index required for $text query" on a space created before this shipped.
    // Logged at debug volume, not per query, because it is a degradation and not an error.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/text index required/i.test(msg)) {
      log.warn(`Lexical search on ${peerText(collName)} failed — keeping the vector order: ${peerText(msg)}`);
    }
    return [];
  }
}

/**
 * Reciprocal Rank Fusion: `score(d) = Σ 1/(k + rank_d,channel)`, 1-based ranks.
 *
 * **Rank, never raw score, and that is the whole point.** Cosine similarity and MongoDB's `textScore` are
 * on unrelated scales — `textScore` is unbounded and grows with term rarity and document length, cosine
 * sits in a fixed range. Normalising one against the other requires a calibration that shifts with corpus
 * size and would silently drift as a space grows. RRF needs no calibration because it discards magnitude
 * entirely: only position within each channel counts.
 *
 * A document ranked well by BOTH channels beats one that wins a single channel outright — which is
 * exactly the behaviour wanted, since agreement between an exact-token match and a semantic match is the
 * strongest signal either can give.
 *
 * Pure and total: an id in one channel only is fused as if absent from the other, so a channel returning
 * nothing (missing text index, no vector hits) reduces cleanly to the other channel's order.
 */
export function rrfFuse(channels: Array<readonly string[]>, k: number = RRF_K): Map<string, number> {
  const fused = new Map<string, number>();
  for (const ranked of channels) {
    for (let i = 0; i < ranked.length; i++) {
      const id = ranked[i]!;
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + i + 1));
    }
  }
  return fused;
}

/** What fusion reads and writes on a candidate — structural, so this module needs nothing from recall. */
export interface FusableResult {
  _id: string;
  score?: number;
  fusedScore?: number;
  /**
   * The two ranks `fusedScore` was computed from, 1-based (`Q-159`): the result's place by meaning among the answer
   * candidates, and by text among records of its own type — absent when the text search did not find it. A fused
   * score alone cannot be checked by whoever reads it; `1/(60 + vectorRank) + 1/(60 + lexicalRank)` can.
   */
  vectorRank?: number;
  lexicalRank?: number;
}

/**
 * Fuse the vector order of EVERY answer candidate with the lexical ranking, and stamp `fusedScore` on each
 * copy. Returns whether anything was fused — `false` when the lexical channel found nothing, and then the
 * candidates are left exactly as they were.
 *
 * **The floor results are candidates too, and that is why they are a parameter.** A `minPerType` floor comes
 * from its own search, as separate objects, and fusion used to run over the pool alone: a floor copy kept
 * only its cosine `score` while the pool around it carried RRF scores near 0.03, so the two were ranked
 * against each other on unrelated scales (`Q-79`). Deduped by `_id`, so a record in both lists has one
 * rank and every copy the same score.
 */
export function stampFusion(
  pool: FusableResult[], floors: readonly FusableResult[],
  /**
   * ONE LEXICAL RANKING PER RECORD TYPE, each its own RRF channel (`Q-159`). Each type's text index scores against
   * its own collection's field lengths and is unbounded, so sorting every type's hits together by raw text score was
   * the cross-scale comparison RRF exists to avoid: a fact outranked an entity only because facts are longer. A
   * record appears in one type's list, so its lexical term is `1/(k + its rank within its type)`.
   */
  lexicalPerType: ReadonlyArray<readonly string[]>,
): boolean {
  if (!lexicalPerType.some(l => l.length > 0)) return false;
  const refsById = new Map<string, FusableResult[]>();
  for (const r of [...pool, ...floors]) {
    const refs = refsById.get(r._id);
    if (refs) refs.push(r); else refsById.set(r._id, [r]);
  }
  const vectorRanked = [...refsById.values()].map(refs => refs[0]!)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || byIdAsc(a, b)).map(r => r._id);
  // Ranks are the LEXICAL ranks within each type, not re-numbered after dropping out-of-pool ids: a document that
  // placed 5th among its type genuinely placed 5th, and compressing the ranks would overstate it.
  const fused = rrfFuse([vectorRanked, ...lexicalPerType]);
  const vectorRank = new Map(vectorRanked.map((id, i) => [id, i + 1]));
  const lexicalRank = new Map<string, number>();
  for (const ranked of lexicalPerType) ranked.forEach((id, i) => { if (!lexicalRank.has(id)) lexicalRank.set(id, i + 1); });
  for (const [id, refs] of refsById) {
    const f = fused.get(id);
    if (f === undefined) continue;
    const lex = lexicalRank.get(id);
    for (const r of refs) {
      r.fusedScore = f;
      r.vectorRank = vectorRank.get(id);
      if (lex !== undefined) r.lexicalRank = lex;
    }
  }
  return true;
}

/** One space's answer as a cross-space merge receives it: its results, and the lexical ranking that fused them. */
export interface SpaceAnswer<T extends FusableResult = FusableResult> {
  results: T[];
  /** The space's per-type lexical rankings, as `stampFusion` took them — empty when its text search found nothing. */
  lexicalPerType: ReadonlyArray<readonly string[]>;
}

/**
 * Merge several spaces' answers and fuse them ONCE, so every merged result is ranked on the same scale (`Q-82`).
 *
 * ## Why the per-space fusion cannot simply be kept
 *
 * `stampFusion` stamps every candidate of a space when that space's lexical channel found something, and none
 * when it found nothing. So the per-space answers arrive on two scales: fused rank scores (at most about 0.033)
 * and cosine similarities (about 0.3 to 0.9). Ordered by `byRankThenId`, every result of a space whose text
 * search missed outranked every result of one whose text search hit — whole spaces came back as blocks, the
 * spaces that matched the query's words best came last — and two fused spaces interleaved round-robin, because
 * each space's ranks start at 1.
 *
 * ## What the one fusion is
 *
 * `stampFusion` itself, over the merged pool — not a second implementation of RRF. Its vector channel becomes
 * every merged candidate by cosine score, which IS comparable across spaces (one query vector, one model), and
 * each space's per-type lexical ranking stays its own channel: the rule `Q-159` set for types within a space,
 * one level up, because raw text scores of two collections are not comparable either. A result its space's text
 * search did not find keeps the vector term alone, exactly as inside one space.
 *
 * When no space's text search found anything, nothing is stamped and the cosine order stands.
 */
export function fuseAcrossSpaces<T extends FusableResult>(answers: ReadonlyArray<SpaceAnswer<T>>): { merged: T[]; fused: boolean } {
  const merged = answers.flatMap(a => a.results);
  const fused = stampFusion(merged, [], answers.flatMap(a => a.lexicalPerType));
  return { merged, fused };
}
