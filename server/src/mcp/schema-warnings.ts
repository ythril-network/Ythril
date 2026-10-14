/**
 * What a record write's MCP answer says about the schema violations it did NOT refuse — the text lines and the structured
 * field, together, for every write tool.
 *
 * ## What it prevents
 *
 * `save_entity`, `save_fact`, `save_edge` and `save_chrono` each wrote the same `⚠️ Schema: <field> — <reason>` line behind
 * their own `validationMode === 'warn'` test, and each put the violations in its structured answer its own way: edge as
 * `violations` (every violation the validator found, even with validation `off`), entity, fact and chrono not at all. The
 * REST twin of every one of them answers `warnings` — the violations the space's mode says to report — so an agent that
 * read the structured answer saw a different thing, or nothing, depending on which tool it called; and `violations` on a
 * SUCCESS is the key every refusal uses, which a caller that treats it as failure reads as a refused write. Bundle-23 was
 * about to write a fifth copy.
 *
 * ## What is inside, so no caller can drop it
 *
 * - **The mode test for the text.** The lines are said in a `warn` space only, from every violation the writer found,
 *   exactly as the four copies said them; a `strict` write that went through (its violations were already stored) has
 *   always been reported in its structured answer and not in its text, and still is.
 * - **The structured field and its name.** `warnings`, the REST twin's key, holding the writer's own `warnings` (what the
 *   space's mode says to tell the caller: empty with validation `off`), present only when it is not empty — the same
 *   rule as the REST create routes.
 *
 * The writer's classification is handed back by `onValidation`; this re-derives nothing.
 */
import type { UpdateValidation } from '../brain/write-validation.js';
import type { SchemaViolation } from '../spaces/schema-validation.js';

/**
 * The sentence every write tool's `properties` description ends with, said once so the eleven places that carry it cannot
 * say it differently. It states what a caller needs — which of its keys are judged and what each validation mode does with
 * one — and nothing of how the check runs.
 */
export const UNDECLARED_KEY_RULE = 'A key the record\'s type does not declare is judged by the space\'s validation mode: '
  + '`off` stores it quietly, `warn` stores it and names it in `warnings`, `strict` refuses a key this write newly adds '
  + '(one already stored is left alone). Declare a key you mean to keep in the type\'s schema.';

export interface SchemaWarningAnswer {
  /** Lines for the text answer, one per violation, without a leading newline. Empty when there is nothing to say. */
  lines: string[];
  /** Spread into `structuredContent`: `{ warnings }` when the mode reports any, `{}` otherwise. */
  structured: { warnings?: SchemaViolation[] };
}

/**
 * The schema-warning part of a write tool's answer, from the space's resolved meta and the writer's classification — and, when the
 * write also made inline edges, theirs (`inlineEdges`, each row already naming its edge: `applyConnections` says them). Create AND
 * update say the same thing: an `update_*` tool used to print nothing under `warn` and return no structured warnings, so an agent
 * that edited a record into breaking the schema was told "updated".
 */
export function schemaWarningAnswer(
  meta: { validationMode?: string } | undefined,
  check: UpdateValidation | undefined,
  inlineEdges: readonly SchemaViolation[] = [],
): SchemaWarningAnswer {
  const lines = meta?.validationMode === 'warn'
    ? [...(check?.all ?? []), ...inlineEdges].map(v => `⚠️ Schema: ${v.field} — ${v.reason}`)
    : [];
  const warnings = [...(check?.warnings ?? []), ...inlineEdges];
  return { lines, structured: warnings.length > 0 ? { warnings } : {} };
}
