/**
 * Regex helpers for a pattern a caller supplies. The ReDoS heuristic and its refusal are `@ythril/schema`'s
 * (`schema/src/redos.ts`), because a schema's `pattern` and `namingPattern` are refused by it at save; re-exported here for the
 * structured query tool (`$regex` filters), which asks the same question.
 */
export { MAX_PATTERN_LENGTH, hasReDoSRisk, REDOS_REFUSAL } from '@ythril/schema';

/**
 * Escape a string for safe literal use inside a RegExp (e.g. building a `^prefix`
 * anchor for a Mongo `$regex`). Single source of truth — every call site that
 * hand-rolled `s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` should use this.
 */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
