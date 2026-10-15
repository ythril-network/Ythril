/**
 * How an unknown top-level field is WORDED, and where it sits on an answer — the half of the unknown-write-field rule that is not the
 * decision (Q-320, bundle-128).
 *
 * ## The question this answers
 *
 * "What does a row that says a write carried a field it does not take look like, and how does it get onto an answer that already has
 * `warnings`?" The judge (`write-accepts.ts`) decides WHETHER a write carried one; three more places put the answer on the wire — the REST
 * decorator, the MCP outcome wrapper, and a bulk batch's `errors[]` — and each would otherwise spell the wording, the `code` and the
 * placement its own way. Wording is by OUTCOME, never one string for both: a stored write says the field was ignored, a refused one says
 * it was not accepted, and a caller reading either knows what happened to its write.
 *
 * ## What it does not let a caller drop
 *
 * - **A refusal carries no received value** (`03-auth-and-limits.md`): {@link boundedUnknownFieldRows} omits `value` itself for a
 *   `refused` outcome, so a caller cannot forget.
 * - **Unknown rows come FIRST and sit outside the 20-row schema cut** ({@link withUnknownFieldWarnings}): twenty schema rows must not push
 *   them out, and they do not count toward it. The caller's own `warnings` rows follow, as they were bounded by the writer.
 * - **Placement is idempotent**: a row this module already put on an answer is replaced, never repeated, so a route that returns the
 *   judge's whole refusal and a decorator that adds the rows again cannot say each one twice.
 */
import { boundedRows, MAX_ROWS } from '../brain/write-validation.js';
import type { SchemaViolation } from '../spaces/schema-validation.js';
import { peerText } from '../util/log.js';

/** The stable code on an unknown-field row. Clients branch on it; the wording beside it may change. */
export const UNKNOWN_FIELD_CODE = 'unknown_field';

/** What happened to the write whose body carried the field: the judge let it proceed (`stored`) or the write was refused (`refused`). */
export type UnknownFieldOutcome = 'stored' | 'refused';

/** A row naming one unknown field (or the `…(+N more)` row that counts the rest): a violation row with the stable `code`. */
export type UnknownFieldRow = SchemaViolation & { code: typeof UNKNOWN_FIELD_CODE };

/** How the wording of a row begins; the MCP text line is the same words after its own label. */
const LEAD = 'unknown field — ';
const BY_OUTCOME: Record<UnknownFieldOutcome, string> = { stored: 'ignored', refused: 'not accepted' };

/** What became of the write, in the one word a row says it with: `ignored` (stored) or `not accepted` (refused). */
export function unknownFieldOutcomeWords(outcome: UnknownFieldOutcome): string {
  return BY_OUTCOME[outcome];
}

/**
 * The reason of one row: `unknown field — ignored` for a write that was stored, `unknown field — not accepted` for one that was refused
 * (by the judge, or for another reason the call failed); then, on the FIRST row of an answer only, `. This write accepts: a, b, c`
 * (`accepted`, from {@link acceptedKeysSentence}: said once per answer, never per row); then ` — did you mean '<key>'?` when the name is a
 * near miss of an accepted key. In that order, so a reader that wants the list reads up to the first ` — `.
 */
export function unknownFieldReason(outcome: UnknownFieldOutcome, { accepted, nearMiss }: { accepted?: string; nearMiss?: string } = {}): string {
  return `${LEAD}${BY_OUTCOME[outcome]}${accepted === undefined ? '' : `. ${accepted}`}${nearMiss === undefined ? '' : nearMissSuffix(nearMiss)}`;
}

/** ` — did you mean '<key>'?`, the suffix a near miss carries on either outcome. */
export function nearMissSuffix(accepted: string): string {
  return ` — did you mean '${accepted}'?`;
}

/** The one sentence that says what a write accepts, said once per answer: `This write accepts: a, b, c`. */
export function acceptedKeysSentence(accepted: Iterable<string>): string {
  return `This write accepts: ${[...accepted].sort().join(', ')}`;
}

/**
 * The summary row for the names that were not rowed: `…(+N more)`, its own sentence and no accepted list. `value` is the count on a
 * stored answer, as the single row's is the received value, and is omitted on a refusal by {@link boundedUnknownFieldRows}.
 */
export function unknownFieldMoreRow(left: number, outcome: UnknownFieldOutcome, shown: number): UnknownFieldRow {
  return {
    field: `…(+${left} more)`,
    code: UNKNOWN_FIELD_CODE,
    value: left,
    reason: `${left} more unknown field(s) — ${BY_OUTCOME[outcome]}; the first ${shown} are named above`,
  };
}

/**
 * Rows as an answer carries them: every name cut at `NAME_QUOTED` and every string value bounded (`boundedRows`, the one renderer of a
 * violation row), and **no `value` at all when the outcome is `refused`**. The rows are built from the caller's names, so this is the
 * bound the judge puts on them and no caller can skip.
 */
export function boundedUnknownFieldRows(rows: readonly UnknownFieldRow[], outcome: UnknownFieldOutcome): UnknownFieldRow[] {
  return boundedRows(rows, { value: outcome === 'stored' }) as UnknownFieldRow[];
}

/**
 * The same rows, worded for the outcome of the answer they ride on.
 *
 * The judge decides BEFORE the write runs, so the rows it hands back say what happens to a write that goes through (`ignored`, with the
 * received value). An answer decides later: the same call can end in a 400 for a missing field, a 404 for a record that is not there or a
 * 412 for a stale precondition, and then nothing was ignored — the write failed, and a refusal reflects no received value. This puts the
 * outcome's own words on a copy and drops `value` when it is `refused`, so a door that decorates its answers after the fact cannot say
 * `ignored` about a write that did not happen. Idempotent: rows already worded for the outcome come back as they were.
 */
export function unknownFieldRowsAs(rows: readonly UnknownFieldRow[], outcome: UnknownFieldOutcome): UnknownFieldRow[] {
  const words = new RegExp(`^(unknown field|\\d+ more unknown field\\(s\\)) — (?:${Object.values(BY_OUTCOME).join('|')})`);
  // The rows were bounded once, by the judge that built them; bounding them again would cut an already-cut name a second
  // time. Re-wording only changes the outcome's words and, for a refusal, drops the value the stored wording carried.
  return rows.map(r => {
    const { value, ...rest } = r;
    const reworded = { ...rest, reason: r.reason.replace(words, `$1 — ${BY_OUTCOME[outcome]}`) } as UnknownFieldRow;
    if (outcome === 'stored' && Object.hasOwn(r, 'value')) reworded.value = value;
    return reworded;
  });
}

/** How much of a string value a stored answer's row echoes: enough to tell which of several sends produced it. */
const RECEIVED_STRING_MAX = 80;

/**
 * A received value small enough to put in a STORED answer's row: primitives as they are, a string through the bounded renderer, anything
 * else named by its type. A warning is not a place to reflect a payload back, and a refusal's row carries none at all.
 */
export function receivedValueSummary(v: unknown): unknown {
  if (v === null) return null;
  if (Array.isArray(v)) return `[array of ${v.length}]`;
  if (typeof v === 'object') return '[object]';
  if (typeof v === 'string') return peerText(v, { max: RECEIVED_STRING_MAX });
  return v;
}

const isRow = (row: unknown): row is { code?: unknown } => row !== null && typeof row === 'object';

/**
 * An answer's `warnings` with the unknown-field rows in front: `[...rows, ...the rows the answer already carried]`, those cut at the
 * schema bound they were already under. Rows of this module already on the answer are dropped first, so placing the same rows twice is
 * placing them once. Returns the new array; nothing it is given is changed.
 */
export function withUnknownFieldWarnings(existing: unknown, rows: readonly UnknownFieldRow[]): unknown[] {
  const own = Array.isArray(existing) ? existing.filter(r => !(isRow(r) && r.code === UNKNOWN_FIELD_CODE)) : [];
  return [...rows, ...own.slice(0, MAX_ROWS)];
}

/**
 * One row as a line of text after a label: `<name> — ignored|not accepted…`, the row's own words without the `unknown field — ` lead its
 * `reason` begins with (the name stands where the lead did). The one reading of a row as prose: an MCP text line puts a label in front of
 * it ({@link unknownFieldLines}) and a bulk item's `errors[]` row joins several after its own (`brain/bulk-unknown-fields.ts`).
 */
export function unknownFieldText(row: Pick<UnknownFieldRow, 'field' | 'reason'>): string {
  return `${row.field} — ${row.reason.startsWith(LEAD) ? row.reason.slice(LEAD.length) : row.reason}`;
}

/** The text lines an MCP answer carries for the rows, one per row: `⚠️ Unknown field: <name> — ignored|not accepted…`. */
export function unknownFieldLines(rows: readonly UnknownFieldRow[]): string[] {
  return rows.map(r => `⚠️ Unknown field: ${unknownFieldText(r)}`);
}
