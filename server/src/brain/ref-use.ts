/**
 * How a caller NAMES a correlation key of the same bulk call: `"$ref:post-1"`.
 *
 * ## The question it answers
 *
 * "Is this value a use of a bulk correlation key rather than a stored id?" One definition of the prefix, and no imports, so the
 * reference check (`entity-refs.ts`, which every write door reaches) and the resolver (`batch-refs.ts`, which pulls in the write
 * plan) can both ask it without the first one joining the second's import cycle.
 *
 * ## What it prevents
 *
 * Two spellings of the prefix drifting apart, so that the resolver accepts a value the refusal sentence does not recognise
 * (Q-952: a `$ref:` key refused in a link field was blamed on "a name is not a reference").
 */

/** The prefix a use of a key carries. */
export const REF_USE_PREFIX = '$ref:';

/** Is this value a use of a correlation key of the same call, rather than a stored id? */
export function isRefUse(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(REF_USE_PREFIX);
}
