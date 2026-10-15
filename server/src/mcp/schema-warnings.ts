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
import { writeWarningFields, type UpdateValidation } from '../brain/write-validation.js';
import type { SchemaViolation } from '../spaces/schema-validation.js';
import type { ToolResult } from './tools/types.js';
import { answerCarriesUnknownFieldRows, answerLeftARecord } from '../api/decorate-json-answer.js';
import { unknownFieldLines, unknownFieldRowsAs, withUnknownFieldWarnings, type UnknownFieldRow } from '../contract/unknown-field-rows.js';
import { log, peerText } from '../util/log.js';
import { warnOnce } from '../util/warn-once.js';

/**
 * The sentence every write tool's `properties` description ends with, said once so the eleven places that carry it cannot
 * say it differently. It states what a caller needs — which of its keys are judged and what each validation mode does with
 * one — and nothing of how the check runs.
 */
export const UNDECLARED_KEY_RULE = 'A key the record\'s type does not declare is judged by the space\'s validation mode: '
  + '`off` stores it quietly, `warn` stores it and names it in `warnings`, `strict` refuses a key this write newly adds '
  + '(one already stored is left alone). Declare a key you mean to keep in the type\'s schema.';

/**
 * The sentence every record-write tool's DESCRIPTION carries about an argument the tool does not take (Q-320, bundle-128) — said once so
 * the eleven places that carry it cannot say it differently, beside {@link UNDECLARED_KEY_RULE} (a property of a record) as its
 * top-level twin. It states the GUARANTEE a caller needs while constructing arguments — what becomes of one, and that the answer always
 * names it — and nothing of how the check runs: a sentence that states the mechanism has to be revisited whenever the mechanism gains a
 * case, and nobody does. It lives here, in a leaf the tool modules already import for their descriptions, and not in the judge
 * (`contract/write-accepts.ts`), which imports the tool modules: a constant read at the top level of a tool module must not come from a
 * module that module's import cycle has not finished.
 */
export const UNKNOWN_ARGUMENT_RULE = 'After the target space is resolved, an argument this tool does not take is answered by how this '
  + 'instance is set for the space: by default the write is stored and the argument is named in `warnings`; a space set to refuse '
  + 'refuses the call and writes nothing. Either way the answer names it, with a suggestion when it looks like a misspelling. A retired '
  + 'name is refused everywhere.';

export interface SchemaWarningAnswer {
  /** Lines for the text answer, one per violation, without a leading newline. Empty when there is nothing to say. */
  lines: string[];
  /** Spread into `structuredContent`: `{ warnings }` when the mode reports any, `{}` otherwise. */
  structured: ReturnType<typeof writeWarningFields>;
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
  // The same bound the REST routes answer (`writeWarningFields`): at most twenty rows, each quoting the caller's choices bounded, and
  // `warningsTruncated` when rows were left out — the text lines above are the writer's whole list, as they always were.
  const warnings = [...(check?.warnings ?? []), ...inlineEdges];
  return { lines, structured: writeWarningFields(warnings) };
}

/** The structural part of a tool call's outcome this needs (`ToolCallOutcome` in `call-tool.ts` has more): the result and the status the REST door answers. */
interface DecoratableOutcome { result: ToolResult; status: number }

/** An outcome that could not be decorated is said once per reason, and passed through as it was. */
const undecoratedSaid = warnOnce<string>();

/**
 * Put the unknown-field rows (`contract/write-accepts.ts`) on an MCP call's outcome: one `⚠️ Unknown field: <name> — ignored|not accepted…`
 * text line per row, and the rows in `structuredContent.warnings` ahead of the write's own schema rows. The second half of this module's
 * job — the first is {@link schemaWarningAnswer}, the write's own warnings — and the one place an MCP outcome gets warning rows.
 *
 * ## What is inside, so the single exit of `callTool` can apply it to every outcome
 *
 * - **Every outcome, but not every status.** A success, a handler refusal, an argument refusal and a stored record whose connections
 *   failed carry the rows; a 5xx where nothing was stored does not (`answerCarriesUnknownFieldRows`, the predicate the REST decorator
 *   asks too).
 * - **Total, and a copy.** It never throws and never changes the outcome it is given: it builds a new one, and if building fails it
 *   returns the outcome as it was (said once). A decoration must not turn a write that landed into a failure.
 * - **The answer stays whole.** A result whose `structuredContent` carries the answer gets `warnings` merged in; a refusal with none
 *   gets `{ error, warnings }`, because a client that surfaces `structuredContent` in preference to the text would otherwise see no
 *   refusal at all. A SUCCESS without one gets the text lines only: `{ warnings }` alone would replace its answer.
 */
export function withUnknownFieldRows<T extends DecoratableOutcome>(outcome: T, judged: readonly UnknownFieldRow[]): T {
  if (judged.length === 0) return outcome;
  try {
    const { result } = outcome;
    if (!answerCarriesUnknownFieldRows(outcome.status, result.structuredContent)) return outcome;
    // The rows are worded for the write the judge let through; a call that FAILED for another reason was not stored with the field
    // ignored, so they are re-worded for it (and lose their value) — unless the failure left a record (`ConnectionsNotWritten`).
    const rows = unknownFieldRowsAs(judged, result.isError === true && !answerLeftARecord(result.structuredContent) ? 'refused' : 'stored');
    const lines = unknownFieldLines(rows).join('\n');
    const content = result.content.length === 0
      ? [{ type: 'text' as const, text: lines }]
      : result.content.map((c, i) => (i === result.content.length - 1 ? { ...c, text: `${c.text}\n${lines}` } : c));
    const held = result.structuredContent;
    let structuredContent: Record<string, unknown> | undefined;
    if (held) structuredContent = { ...held, warnings: withUnknownFieldWarnings(held['warnings'], rows) };
    else if (result.isError) {
      structuredContent = { error: (result.content[0]?.text ?? '').replace(/^Error(?: \(\d+\))?: /, ''), warnings: withUnknownFieldWarnings(undefined, rows) };
    }
    return { ...outcome, result: { ...result, content, ...(structuredContent ? { structuredContent } : {}) } };
  } catch (err) {
    const why = peerText(err instanceof Error ? err.message : err);
    undecoratedSaid('withUnknownFieldRows', () => {
      log.warn(`an MCP outcome could not carry the unknown-field rows and was answered without them: ${why}`);
    }, why);
    return outcome;
  }
}
