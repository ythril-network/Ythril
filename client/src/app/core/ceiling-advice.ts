/**
 * Which form field a shortened answer's advice names (`Q-116`) — one question, answered from the SERVER's words.
 *
 * The recall form has three fields labelled "Max response size" — characters, tokens, bytes — and the advice used to
 * say "raise Max response size", which is all three. The server now names the parameter whose ceiling refused the
 * next match (`budgetBoundBy`, from the admission meter in `brain/result-budget.ts`). This maps those names to the
 * labels of the fields that set them, and does nothing else: the client does not work out which ceiling bit from
 * `budgetChars` / `budgetBytes`, because that would be a second copy of the admission rule, and one that cannot
 * decide when both ceilings are set and the byte one is the larger.
 *
 * - A walk that ran out (`walk_budget`, `deadline`) is not a size ceiling: `null`, and the notice gives no size advice.
 * - A budget cut whose names this client does not know (a newer server) falls back to the character field — the
 *   ceiling every answer has — rather than to no advice at all.
 */

/** The label key of the form field that sets each size parameter, in the order the advice lists them. */
export const CEILING_FIELD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  maxChars: 'brain.query.maxChars',
  maxTokens: 'brain.query.maxTokens',
  maxBytes: 'brain.query.recallMaxBytes',
});

/**
 * The label keys to name in the advice, or `null` when the answer was not cut by its size budget.
 */
export function ceilingFieldKeys(truncatedBy: string | null | undefined, budgetBoundBy: unknown): string[] | null {
  // An answer from before `truncatedBy` existed was always cut by its size budget.
  if (truncatedBy && truncatedBy !== 'budget') return null;
  const named = Array.isArray(budgetBoundBy)
    ? Object.keys(CEILING_FIELD_LABELS).filter(p => budgetBoundBy.includes(p)).map(p => CEILING_FIELD_LABELS[p]!)
    : [];
  return named.length ? named : [CEILING_FIELD_LABELS['maxChars']!];
}
