/**
 * Heuristics for detecting regex patterns susceptible to catastrophic backtracking (ReDoS). Shared by schema validation
 * (a property's `pattern`, a type's `namingPattern`) and, through `server/src/util/redos.ts`, the structured query tool
 * (`$regex` filters).
 */

/** Maximum length accepted for a user-supplied regex pattern. */
export const MAX_PATTERN_LENGTH = 500;


/**
 * Rejects patterns with nested quantifiers like (a+)+, (a*)*b, (a|a)+, etc.
 * This is a conservative heuristic — it may block some safe patterns, which
 * is the correct fail-safe direction for user-supplied regexes.
 *
 * Groups that begin with a mandatory literal separator character (-, /, :)
 * that is not itself optional are excluded because the separator forces unique
 * iteration boundaries and prevents exponential backtracking.
 * e.g. (-[a-z0-9]+)+ is safe — each iteration must start with a literal '-'
 * that cannot be matched by [a-z0-9], so there is no ambiguous partitioning.
 */
const NESTED_QUANTIFIER_RE = /\((?:\?:)?(?![-/:](?![?*{]))([^)]*[+*])\)([+*?]|\{)/;
const ALTERNATION_QUANTIFIER_RE = /\([^)]*\|[^)]*\)([+*?]|\{)/;

export function hasReDoSRisk(pattern: string): boolean {
  return NESTED_QUANTIFIER_RE.test(pattern) || ALTERNATION_QUANTIFIER_RE.test(pattern);
}

/**
 * What to tell an author whose pattern will not be evaluated, in one place so every door says the same thing.
 *
 * `Q-7`. This exists because the refusal used to be invisible: a risky pattern was accepted when the schema
 * was saved, and then `safeRegexTest` returned `false` for every value — the same answer it gives for a value
 * that genuinely does not match. So the schema silently rejected every record of its type, for ever, with an
 * error naming the operator's DATA.
 *
 * The message names the construct rather than saying "unsafe", because the author has to be able to rewrite
 * the pattern, and "unsafe" does not tell them which part to change.
 */
export const REDOS_REFUSAL = 'this pattern cannot be evaluated: a quantified group that contains a quantifier '
  + '(or an alternation) can backtrack exponentially, so it would never be applied and every value would be '
  + 'rejected. Rewrite it without the quantified group — a character class usually does the same job.';
