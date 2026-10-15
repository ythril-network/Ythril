/**
 * The functions that validate a record against a space's schema, and the classifiers that judge a write by them —
 * DERIVED from the modules that export them, so a gate over "who calls a validator" cannot go stale when a kind is renamed.
 *
 * ## What it prevents
 *
 * Two sweeps named the kinds in a regular expression: `classify(?:Entity|Memory|Chrono|Edge)Upsert` and
 * `validate(Memory|Entity|Edge|Chrono)`. The knowledge type "memory" was renamed "fact" (the validator is `validateFact`,
 * the classifier `classifyFactUpsertAgainst`), and neither expression was touched: a call to either placed in a door matched
 * nothing, so the fact doors were covered by a gate that could not see them. A gate that reaches for a literal list of the
 * kinds is the same defect with a later expiry date (CLAUDE.md, "A gate concludes about MORE than it checks").
 *
 * ## The two sets
 *
 * - `validators`: every export of `spaces/schema-validation` named `validate<Kind>` — the per-kind validators. (Not
 *   `validationRefuses`, which is a question about a mode, and not `resolveMetaRefs`, which prepares a meta.)
 * - `classifiers`: every export of `brain/write-validation` named `classify...` — the verdicts a writer asks (`classify<Kind>
 *   UpsertAgainst` and `classifyUpdateViolations`).
 *
 * Each is asserted against a FLOOR, because an empty set passes every loop written over it: four kinds have properties, so
 * there are at least four validators and four per-kind classifiers.
 *
 * `callsOf(names, text)` is the one spelling of "this source calls one of them": the name followed by `(`, on a word
 * boundary, so `validateFact` is found and `revalidateFactory` is not. Callers strip comments first.
 */

const FLOOR_PER_KIND = 4;

/** @returns {Promise<{ validators: string[], classifiers: string[], all: string[] }>} */
export async function validationEntryPoints() {
  const schema = await import('../../server/dist/spaces/schema-validation.js');
  const write = await import('../../server/dist/brain/write-validation.js');
  const validators = Object.keys(schema).filter(n => /^validate[A-Z]\w*$/.test(n));
  const classifiers = Object.keys(write).filter(n => /^classify[A-Z]\w*$/.test(n));
  if (validators.length < FLOOR_PER_KIND) {
    throw new Error(`only ${validators.length} validate<Kind> export(s) found in spaces/schema-validation (${validators}) — the derivation is broken, `
      + 'and every sweep over it would pass over nothing');
  }
  const perKind = classifiers.filter(n => /Upsert/.test(n));
  if (perKind.length < FLOOR_PER_KIND) {
    throw new Error(`only ${perKind.length} classify<Kind>UpsertAgainst export(s) found in brain/write-validation (${classifiers}) — the derivation is broken`);
  }
  return { validators, classifiers, all: [...validators, ...classifiers] };
}

/** The call sites of any of `names` in `text` (comments already stripped), each as the matched `name(`. */
export function callsOf(names, text) {
  const re = new RegExp(`\\b(?:${names.join('|')})\\s*\\(`, 'g');
  return [...text.matchAll(re)].map(m => m[0]);
}
