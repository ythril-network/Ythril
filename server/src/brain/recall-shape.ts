/**
 * The pure shape of a recall answer: merge, rank, and the two text projections.
 *
 * ## Why these four live away from `recall.ts`
 *
 * None of them touch a database, a deadline, or an embedder. They take results and return results — which is
 * why they are the four functions in that file with real unit coverage, and why they were the four that could
 * be moved without a characterization pass: 81 existing assertions across three suites already pin them, and
 * they were green against the original code before this file existed.
 *
 * `recall.ts` had grown to 744 code lines and taken a god-file ratchet raise. A raise names a cost and defers
 * it; this pays part of it back. The remaining file is the part that genuinely needs a database.
 *
 * ## The import direction, and why it is not a cycle
 *
 * `recall.ts` imports these functions, and this module imports `RecallResult` and `RecallKnowledgeType` back
 * from it. That reads like a cycle and is not one: a type-only import is **erased** by TypeScript, so nothing
 * of it survives into the emitted JavaScript. At runtime the dependency is one-way.
 *
 * It is still the wrong shape to leave for ever. The repo already has the fix as precedent — `config/rights-shape.ts`
 * exists precisely because `types.ts` could not import from `auth/` while `auth/` imported `types.ts`, and a
 * leaf module both could import broke it. The follow-up is a `recall-types.ts` leaf holding `RecallResult`, its
 * five variants and `RecallKnowledgeType`; that is a change to every importer of those types and belongs on its
 * own, not bolted onto a file move.
 */
import type { RecallResult, RecallKnowledgeType } from './recall.js';

/**
 * The fields a recall result carries for the SYSTEM rather than for the caller.
 *
 * ## Why one list, and why it lives here
 *
 * REST returned all six and MCP returned none, and neither said so — MCP's tool description in fact listed
 * two of them among the fields a result "carries", which is how a caller ends up budgeting for a response
 * roughly twice its real size and hunting for the parameter that switches it off. Owner, 2026-08-16:
 * *"we did want to sync mcp and rest ... in general those fields should not be returned"*.
 *
 * So they are withheld by default on BOTH doors and `includeDiagnostics` restores them on both. One list,
 * because the alternative is an allowlist on one door and a denylist on the other agreeing by promise —
 * which is precisely the shape that let them drift for a release.
 *
 * ## Why the split into two groups
 *
 * They are diagnostics for one reason and belong in two PLACES. `matchedText`, `embeddingModel` and `seq`
 * are fields OF THE RECORD; the three scores describe how this result RANKED and sit beside `score`. REST
 * returns one flat object so the distinction is invisible there, but MCP nests the record inside the result
 * — putting `lexicalScore` in `record` would say it is a property of the fact, which it is not.
 */
export const RECALL_RECORD_DIAGNOSTICS = ['matchedText', 'embeddingModel', 'seq'] as const;

/**
 * The per-stage ranking scores. **RETURNED BY DEFAULT, on both doors — they are the ORDERING, not payload.**
 *
 * ## Why they left the `includeDiagnostics` bundle
 *
 * The canary operator 2026-08-17T1549Z, correcting their own 1540Z, and the argument is mine turned around
 * correctly. I wrote that the six bundled fields are not where a large response comes from — the bodies are.
 * **Three floats per result are not a cost, so they do not belong behind a flag whose purpose is removing
 * cost.** Bundling a passage-sized field with three numbers under one switch was the actual error.
 *
 * ## And `score` is not the number that ranked the result
 *
 * Precedence in a fused recall is `rerankScore > fusedScore > score`. So on any instance with a cross-encoder,
 * the value in the response did not decide the position in the response, and the value that did was
 * unavailable. Their reranker has been live since 2026-08-03, which makes `rerankScore` the operative number
 * on every recall they make.
 *
 * It compounds with our own documented behaviour: `minScore` filters on `score` ALONE, never on the fused or
 * rerank ordering. A caller could threshold on a number that did not order the results while being unable to
 * see the one that did. Either half alone is survivable.
 *
 * ## Absent still means "that stage did not run"
 *
 * These are emitted only when present, so an instance with no reranker returns no `rerankScore` and a
 * lexical-free query returns no `lexicalScore`. That was already the contract and it is unchanged — what
 * changed is that a caller no longer has to ask.
 *
 * Beside `score`, never inside `record`: a score describes how the result RANKED, not what the record is.
 */
export const RECALL_RANKING_DIAGNOSTICS = ['lexicalScore', 'fusedScore', 'rerankScore'] as const;

/*
 * `RECALL_DIAGNOSTIC_FIELDS` WAS HERE — the union of both groups — AND IS DELETED.
 *
 * It was the strip list for both doors, which is precisely what made the ordering scores conditional. With
 * the ranking half now unconditional, a union constant has no caller that should want it: a stripper wants
 * `RECALL_RECORD_DIAGNOSTICS`, and a test asserting on "the six that used to be bundled" can spread the two
 * itself and say why. Keeping it would leave a name that reads like the withheld set and is not one.
 */

/**
 * Stripped always, restorable by nothing — deliberately NOT part of `RECALL_DIAGNOSTIC_FIELDS`.
 *
 * "The vector is never returned" is stated on both doors and in the guides, and it was very nearly false:
 * the graph traversal fetched edge documents with no projection at all, so `_graph[].edge.embedding` was a
 * float array per hop. That query now projects it out, and this is the second line of defence — a claim that
 * absolute should not rest on one projection being remembered at every fetch site.
 */
export const NEVER_RETURNED_FIELDS: readonly string[] = ['embedding'];

/**
 * The named fields that are actually present, or `{}` when the caller did not ask for them.
 *
 * Spread into a result. `undefined` values are omitted rather than emitted as explicit nulls, matching how
 * every other optional field on a recall result behaves — a key that is always present and usually null is
 * a key readers learn to skip.
 */
export function diagnosticFields(
  src: Record<string, unknown>,
  keys: readonly string[],
  include: boolean,
): Record<string, unknown> {
  if (!include) return {};
  const out: Record<string, unknown> = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

/**
 * Recall results with the diagnostic fields removed unless the caller asked for them — the REST shape.
 *
 * Copies rather than mutating, for the same reason `stripContentIfAsked` does: the same array is handed to
 * the traverse builder and to the audit outcome, and deleting a field in place would change what those saw.
 */
export function withoutDiagnostics<T extends object>(results: T[], include: boolean): T[] {
  // `RECALL_RECORD_DIAGNOSTICS` and NOT the old union: the three ranking scores are the ORDERING and are now
  // unconditional, so stripping them here is what made the number that ranked a result unavailable to the
  // caller who wanted to know why it ranked there. The vector is still removed either way.
  if (include) return results.map(r => {
    const out = { ...r } as Record<string, unknown>;
    for (const k of NEVER_RETURNED_FIELDS) delete out[k];
    return out as T;
  });
  return results.map(r => {
    const out = { ...r } as Record<string, unknown>;
    for (const k of [...RECALL_RECORD_DIAGNOSTICS, ...NEVER_RETURNED_FIELDS]) delete out[k];
    return out as T;
  });
}

/**
 * The ranking scores a result actually carries — always, and only the ones whose stage ran.
 *
 * Separate from `diagnosticFields` because that helper takes an `include` flag, and passing it a literal
 * `true` at four call sites would read as "this is still conditional, we just always say yes". It is not
 * conditional: there is no parameter that removes these, by design.
 */
export function rankingFields(src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of RECALL_RANKING_DIAGNOSTICS) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

/**
 * The keys a flat REST recall result carries as ENVELOPE rather than as record content.
 *
 * A projection names record fields. On MCP that distinction is structural — the record sits under `record`
 * and `score` sits beside it — but REST returns one flat object, so without this a caller projecting
 * `{name: 1}` would lose the score their search was for and the `spaceId` that says where the record lives.
 *
 * So the envelope survives every projection on the REST door, which is what makes the two doors carry the
 * same content under the same parameter. `_graph` survives too and is projected INSIDE, per node and per edge.
 */
export const RECALL_ENVELOPE_KEYS: readonly string[] = [
  'score', 'spaceId', 'type', '_graph',
  ...RECALL_RANKING_DIAGNOSTICS,
];

/** Roughly a 2k-token window at ~4 chars/token, which every current reranker comfortably accepts. */
export const RERANK_TEXT_MAX_CHARS = 8_000;

/**
 * Combine the floor-guaranteed results with the global ones, honour `topK`, and apply `minScore`.
 *
 * Pure, and extracted so it can be tested at all: the surrounding function is two `await`s into
 * MongoDB on either side, so this logic previously had no reachable seam — which is exactly why the
 * standalone test that "covered" it was a hand-written copy that had drifted from it.
 *
 * The order matters and is easy to get subtly wrong:
 *   1. guaranteed results are already deduped by the caller and always survive `topK`;
 *   2. the global results fill whatever slots remain, skipping anything already guaranteed;
 *   3. the combined list is sorted by score — a floor result may legitimately outrank a global one;
 *   4. `minScore` filters LAST, so it can drop a guaranteed result. That is deliberate: a floor is a
 *      request for coverage, not a licence to return matches the caller called too weak to want.
 *
 * `maxPerType` is the CEILING to `minPerType`'s floor, and it is applied here rather than by fetching less.
 * Phase 2 over-fetches on purpose so a cross-encoder has something to reorder; capping the fetch instead
 * would hand the reranker the top-N by vector similarity rather than the best N after reranking — a worse
 * answer for the same cost. The cap's whole value is in step 2: a candidate whose type is already full is
 * SKIPPED and the walk continues, so the slot it would have taken goes to another type. Without that, a
 * ceiling would only shorten the list, and the caller's actual complaint — one long chunk crowding out four
 * one-line principles — would be unaddressed.
 *
 * A ceiling never drops a floor result: `minPerType.x > maxPerType.x` is refused at both API surfaces, so
 * the two cannot contradict by the time they reach here. Guaranteed results still COUNT toward the ceiling,
 * or a floor of 2 plus a ceiling of 2 would return four.
 */
export function mergeRecallResults(
  guaranteed: RecallResult[],
  allResults: RecallResult[],
  topK: number,
  minScore?: number | null,
  maxPerType?: Partial<Record<RecallKnowledgeType, number>>,
): RecallResult[] {
  /*
   * THE THRESHOLD IS APPLIED TO THE CANDIDATES, and it used to be applied to the answer.
   *
   * `final.filter(…)` ran at the end, on a list already cut to `topK` — so `topK: 10, minScore: 0.7` could
   * return three while forty records cleared the threshold: the ten-record window was chosen from the
   * UNFILTERED ranking and then thinned. A caller filtering hard got a short answer with no indication that
   * asking for more would have helped.
   *
   * `topK` is now filled from records that satisfy the threshold, which is the guarantee `filter` already
   * makes and states in as many words: *"topK is filled from records that SATISFY the filter — it is never
   * applied to an already-truncated shortlist."* Two parameters that narrow the same answer should not
   * disagree about when they narrow it.
   *
   * It also settles a divergence between two tools: `find_similar` applies its threshold inside its
   * selection loop, so the same parameter behaved differently there, and the integration guide documented
   * the `find_similar` behaviour for both.
   *
   * Still on `score` and never on `rerankScore` — the two are different scales, and a caller's threshold was
   * written against vector similarity. Reinterpreting it against a cross-encoder's logit would change which
   * records a fixed threshold returns without anyone touching the threshold.
   */
  const clears = (r: RecallResult): boolean =>
    minScore == null || minScore <= 0 || (r.score ?? 0) >= minScore;
  guaranteed = guaranteed.filter(clears);
  allResults = allResults.filter(clears);

  const guaranteedIds = new Set(guaranteed.map(r => r._id));
  const fillSlots = Math.max(0, topK - guaranteed.length);

  // Per-type usage starts from the floor results, which are already in the output.
  const used = new Map<RecallKnowledgeType, number>();
  if (maxPerType) for (const r of guaranteed) used.set(r.type, (used.get(r.type) ?? 0) + 1);
  const capOf = (t: RecallKnowledgeType): number =>
    maxPerType?.[t] ?? Number.POSITIVE_INFINITY;

  // Rank BEFORE selecting, not after.
  //
  // This function used to walk `allResults` in the order it was handed and sort only at the end, which was
  // harmless while selection was "take the first `fillSlots`" — the sort fixed the order of whatever came
  // out. It stops being harmless the moment a ceiling exists: with `{file: 1}`, the cap keeps the FIRST file
  // it walks past and skips the rest, so an unranked walk keeps a 0.1 hit and discards a 0.99 one. Its own
  // test caught exactly that.
  //
  // It also fixes the same latent problem in plain `topK` truncation, which picked the first N of the input
  // rather than the best N. Both were masked by every production caller sorting first — and `applyRerank`
  // and `applyLexicalFusion` mutate the scores AFTER that sort, so "the caller sorted" was not even reliably
  // true. A copy, because reordering an argument is a side effect a caller cannot see.
  const ranked = [...allResults].sort(byRankThenId);

  const fill: RecallResult[] = [];
  for (const r of ranked) {
    if (fill.length >= fillSlots) break;
    if (guaranteedIds.has(r._id)) continue;
    if (maxPerType) {
      const seen = used.get(r.type) ?? 0;
      if (seen >= capOf(r.type)) continue;   // full — keep walking, do not stop
      used.set(r.type, seen + 1);
    }
    fill.push(r);
  }

  const final = [...guaranteed, ...fill];
  // Order by the cross-encoder when it answered, otherwise by vector similarity. `??` rather than a
  // separate branch so a partial rerank — a provider that scored some passages and not others — still
  // orders sensibly instead of collapsing the unscored ones to the bottom.
  final.sort(byRankThenId);
  // The threshold was applied to the candidates at the top, so nothing here can be below it.
  return final;
}

/**
 * Sort key, most-precise signal first.
 *
 * Cross-encoder > RRF fusion > raw vector similarity. The order is the order of how much each one
 * actually knows: the reranker read the query and the passage together, fusion only saw two rankings,
 * and the vector score saw one. `??` rather than branches so a partial signal — some records reranked,
 * some not — still orders sensibly instead of collapsing the unscored ones to the bottom.
 */
/**
 * The tie-break every ranking sort in recall ends with: `_id` ascending.
 *
 * ## Why a ranked answer needs one at all
 *
 * `Array.prototype.sort` is stable, so a comparator that returns 0 for two results leaves them in the order
 * the INPUT happened to have — and that input is whatever the database returned. Two identical recalls over an
 * unchanged corpus could therefore come back in different orders, and nothing anywhere said which.
 *
 * That was tolerable while an answer was always whole. It stopped being tolerable when `skip` arrived: a
 * caller continues from `returned`, so a permutation between two pages repeats some matches and drops others,
 * silently, with no way to detect it. Caught by the paging E2E on 28 near-identically-scored records — page
 * two was entirely contained in page one.
 *
 * `_id` rather than `seq` or `createdAt`: it is present on every result type, it is unique by construction, and
 * it is the only one of the three that cannot tie in turn.
 */
export function byIdAsc(a: { _id: string }, b: { _id: string }): number {
  return a._id < b._id ? -1 : a._id > b._id ? 1 : 0;
}

/**
 * THE ranking comparator — effective rank descending, then `_id`.
 *
 * One implementation rather than the eleven hand-written comparators this replaced — seven in `recall.ts`, two
 * here, and one member-space merge on each door. Exactly the shape `CLAUDE.md` names as this codebase's
 * most-produced defect: one rule, several copies, and the copy that forgets is the one that decides an answer.
 *
 * The two door-side merges are the ones a sweep would miss. They are the LAST sort before the response, and
 * they live in `api/brain/search.ts` and `mcp/tools/search.ts` rather than anywhere named after ranking.
 */
export function byRankThenId(a: RecallResult, b: RecallResult): number {
  return rankOf(b) - rankOf(a) || byIdAsc(a, b);
}

export function rankOf(r: RecallResult): number {
  return r.rerankScore ?? r.fusedScore ?? r.score ?? 0;
}

/**
 * The text a cross-encoder is asked to judge against the query.
 *
 * Deliberately NOT `summariseRecall`, which truncates a fact to 120 characters for a one-line log or
 * tool response. A reranker scoring a 117-character stub of the passage would be judging a different
 * text from the one that gets returned — worse than not reranking, because the error is invisible.
 * Capped anyway: cross-encoders have a token window, and a runaway document would be silently truncated
 * by the provider at a point we do not control.
 */
export function rerankTextOf(r: RecallResult): string {
  const raw = (() => {
    switch (r.type) {
      case 'fact': return r.fact;
      case 'entity': return [r.name, r.entityType, r.description].filter(Boolean).join(' — ');
      case 'edge':   return [`${r.from} → ${r.label} → ${r.to}`, r.description].filter(Boolean).join(' — ');
      case 'chrono': return [r.title, r.description].filter(Boolean).join(' — ');
      case 'file':   return [r.path, r.description].filter(Boolean).join(' — ');
    }
  })();
  return raw.length > RERANK_TEXT_MAX_CHARS ? raw.slice(0, RERANK_TEXT_MAX_CHARS) : raw;
}

/** One-line human summary of a recall result, for duplicate feedback. */
export function summariseRecall(r: RecallResult): string {
  switch (r.type) {
    case 'fact': return r.fact.length > 120 ? `${r.fact.slice(0, 117)}…` : r.fact;
    case 'entity': return `${r.name} (${r.entityType})`;
    case 'edge': return `${r.from} → ${r.label} → ${r.to}`;
    case 'chrono': return r.title;
    case 'file': return r.path;
  }
}
