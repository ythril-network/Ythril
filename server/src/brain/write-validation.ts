/**
 * Schema validation on WRITE — of the record as it will be, and honest about whose fault a violation is.
 *
 * ## The hole
 *
 * Creates were validated. Updates were validated **only when the patch used `deleteFields`** — the branch
 * that exists because removing a required property is an obvious way to break a record. Every other patch
 * skipped validation entirely, so `PATCH { properties: { status: "nonsense" } }` wrote a value the same
 * space would have rejected at create time, in a space explicitly set to `strict`. The stricter a space's
 * schema, the wider the gap: the write path an operator relies on to keep records conformant was the one
 * path that did not check.
 *
 * Validating the **merged** record rather than the patch is what makes this correct. A patch is a fragment;
 * "does this fragment satisfy the schema" is not a question with a useful answer, because a required
 * property the patch does not mention is present in the record and absent from the patch.
 *
 * ## Whose fault
 *
 * Once the merged record is validated, a second problem appears immediately: a record that was **already**
 * non-compliant — written before the schema tightened, imported, or synced from a peer with different
 * meta — now fails validation on any edit, including an edit that has nothing to do with the offending
 * field. Reporting that as "your change is invalid" is false, and it is the kind of false that costs an
 * afternoon: the operator stares at a field they did not touch.
 *
 * So violations are split against the record's prior state:
 *
 *   - **introduced** — not present before this patch, or present before and about a path THIS WRITE CHANGED (R6-3: a stored bad
 *     `status` does not shelter a new bad `status` a write puts in its place). The patch caused it.
 *   - **pre-existing** — present before, still present, and about something the write left alone. The patch did not cause it,
 *     and did not fix it.
 *
 * Only what the patch INTRODUCES refuses it in a `strict` space (owner ruling P-6 = B, 2026-08-15; `classifyUpdateViolations`
 * says why, and the first version of this header said the opposite — it called both blocking, which was the freeze P-6 removed).
 * A record that was already broken is still REPORTED as broken on every write that touches it, and a patch that repairs the
 * violation passes: validation is of the *merged* result, and the answer names exactly what to include.
 *
 * ## A key the type does not declare (`Q-93`)
 *
 * A type that declares at least one property is a closed list, and a write that ADDS a key outside it is refused in a `strict` space
 * (flagged in `warn`, ignored in `off`). "Adds" is the P-6 split: a key already stored on the record is the record's own history and
 * is never refused — changing its VALUE is not adding it. A retype is judged against the type it leaves and the type it lands on, so a
 * key the new type does not declare is introduced by the retype when the old type declared it, or declared nothing at all; a key
 * undeclared on both is pre-existing. The rows a refusal LISTS are bounded after this split, never before it (`SchemaViolationError`),
 * or a new key sorted behind twenty stored ones would be cut off and the write would pass.
 */
import { validateEntity, validateEdge, validateChrono, validateFact, type SchemaViolation } from '../spaces/schema-validation.js';
import { recordViewOf, type RecordView } from './record-view.js';
import type { SpaceMeta } from '../config/types.js';
import { isDeepStrictEqual } from 'node:util';
import { NAME_QUOTED, peerList, peerText } from '../util/log.js';
import { resolveMemberSpaces } from '../spaces/proxy.js';
import { applyValidation, getSpaceMeta } from '../spaces/schema-validation.js';
import type { ResolvedEdgeEnds } from '../spaces/schema-validation.js';
import { ruleReadsChanged } from '../spaces/schema-rules.js';
import { mergeTags, mergePropertiesOrKeep } from './merge-fields.js';
import { ReferenceRefusal } from './entity-refs.js';
import { WriteConflict } from './write-plan/types.js';
import { tallySchemaRefusal, type SchemaRefusalDoor } from './schema-refusal-tally.js';

/**
 * Identity of a violation for before/after comparison.
 *
 * Field **and** reason, not field alone. One field can fail two ways at once — a property that is both
 * the wrong type and outside its enum — and keying on the field would let a patch introduce a second,
 * different violation on an already-failing field and have it reported as pre-existing. The value is
 * deliberately excluded: an unchanged violation whose value the patch altered (`"a"` → `"b"`, both outside
 * the enum) is the same defect, still the record's own, and calling it newly introduced would blame the
 * patch for a constraint it did not break.
 */
const key = (v: SchemaViolation) => `${v.field}\u0000${v.reason}`;

export interface UpdateValidation {
  /** True when the write must be refused (strict space, at least one violation of the merged record). */
  blocked: boolean;
  /** Violations this patch caused. */
  introduced: SchemaViolation[];
  /** Violations the record already had, which this patch neither caused nor fixed. */
  preExisting: SchemaViolation[];
  /** Everything, for the `violations` field of the response — warn mode reports without blocking. */
  all: SchemaViolation[];
  /**
   * The violations to SURFACE, per the space's validation mode: the full list under `warn` or `strict`,
   * empty when validation is `off`. `all` is what the validator found; this is what the mode says to
   * tell the caller about. Keeping the two apart is what let the create routes adopt this classifier
   * without starting to emit warnings in spaces that had deliberately switched validation off.
   */
  warnings: SchemaViolation[];
  /** Ready-to-send message naming which of the two situations applies. */
  message: string;
}

/**
 * What the write changed about the record, asked of one violation's `field` (R6-3).
 *
 * A violation that was there before and is there after is the write's own when the write changed the path it is about — a stored bad
 * `status` replaced by ANOTHER bad `status` is the write's break, where the same bad `status` sent back (a round-tripping editor) or
 * left alone is not. The default says nothing changed, which is what every caller that has no before and after to compare means.
 */
export interface WriteDelta { changedPath(row: SchemaViolation): boolean }
const NOTHING_CHANGED: WriteDelta = { changedPath: () => false };

/**
 * The delta between the record as stored (`null`: nothing, an insert) and as the write leaves it.
 *
 * A schema row is asked about its `field`; a RULE's row (`rules.<name>`, `meta.rules.<name>`) names a rule and not a path, so it is asked
 * about the paths that rule reads (`ruleReadsChanged`) — the one place that knows them.
 */
export function deltaBetween(before: RecordView | null, after: RecordView): WriteDelta {
  if (!before) return { changedPath: () => true };
  return {
    changedPath(row) {
      const reads = ruleReadsChanged(row, before, after);
      if (reads !== undefined) return reads;
      const field = row.field;
      // A property: its VALUE, own keys only — a key named like something on `Object.prototype` is not on the record because the prototype has it.
      if (field.startsWith('properties.')) {
        const name = field.slice('properties.'.length);
        const was = Object.hasOwn(before.properties, name) ? before.properties[name] : undefined;
        const is = Object.hasOwn(after.properties, name) ? after.properties[name] : undefined;
        return !isDeepStrictEqual(was, is);
      }
      if (field === 'name') return before.title !== after.title;
      // Everything else is about the type (or the label) the record sits under: the allowlist, the unresolved reference, the ends.
      return (before.type ?? before.label) !== (after.type ?? after.label);
    },
  };
}

/** A row that says a property KEY is not declared: judged by whether the write ADDED the key, never by its value (`Q-93`). */
const isUndeclaredKey = (v: SchemaViolation): boolean => Array.isArray(v.declared);

/**
 * Classify the merged record's violations against the record's prior ones.
 *
 * `beforeViolations` is what the SAME validator says about the record as it stands now. Recomputing it
 * rather than trusting a stored flag matters: the space's meta can have tightened since the record was
 * written, and the question here is not "was this record valid when created" but "is this field's failure
 * something this patch is responsible for".
 *
 * A violation is INTRODUCED when the record after the write breaks it AND (the record before did not, OR the write changed the path
 * the violation is about — `wrote`). A row about an undeclared KEY is the one exception to the second half: its path is the key's
 * PRESENCE, and the owner's Q-93 ruling is that only a key the write ADDS is refused, so writing a new value to a stored undeclared
 * key stays pre-existing.
 */
export function classifyUpdateViolations(
  meta: SpaceMeta | undefined,
  beforeViolations: SchemaViolation[],
  afterViolations: SchemaViolation[],
  wrote: WriteDelta = NOTHING_CHANGED,
): UpdateValidation {
  const before = new Set(beforeViolations.map(key));
  const introduced = afterViolations.filter(v => !before.has(key(v)) || (!isUndeclaredKey(v) && wrote.changedPath(v)));
  const introducedSet = new Set(introduced);
  const preExisting = afterViolations.filter(v => !introducedSet.has(v));

  // Two verdicts from one mode, and the split IS the P-6 ruling (owner, 2026-08-15: B).
  //
  // `blocked` is decided by what the patch INTRODUCED. `warnings` still reports everything the merged record
  // fails, because a caller that wants to insist on full compliance needs to be able to see it — and
  // `preExisting` is in the response either way.
  //
  // ## Why blocking on the full list was wrong
  //
  // Reported by the canary operator as *"freezes records"*, and reproduced:
  //
  //     write an entity with properties.status = "retired"   (the enum allows it)  -> 201
  //     remove "retired" from the enum                                             -> 200
  //     PATCH that record's DESCRIPTION only                                       -> 422
  //
  // The record became uneditable until an unrelated field was repaired in the same request, and any schema
  // tightening did that retroactively to every record that no longer fit. The violation is ALREADY STORED:
  // refusing the patch does not improve the data, it only blocks maintenance. Strictness is about what a
  // write introduces.
  //
  // It is also what `16-mcp.md` promised integrators before the code was found to disagree, so B is the
  // behaviour some of them may already have built against.
  //
  // What this does NOT weaken: a patch that introduces a violation is refused exactly as before, and a
  // record that was already broken is still reported as broken on every write that touches it.
  const surfaced = applyValidation(meta, afterViolations);
  const blocking = applyValidation(meta, introduced);

  return {
    blocked: blocking.blocked,
    warnings: surfaced.warnings,
    introduced,
    preExisting,
    all: afterViolations,
    message: describeUpdateViolations(introduced, preExisting),
  };
}

/**
 * Find which member space holds the record, and that space's meta.
 *
 * On a proxy space the record lives in exactly one member, and the schema that governs it is **that
 * member's**, not the proxy's. Resolving the two together is the only way an MCP tool can validate
 * against the right meta without re-implementing member resolution per tool — four copies of which is how
 * three of them would end up validating against the proxy.
 */
export async function locateForUpdate<T>(
  writeTarget: string,
  load: (memberId: string) => Promise<T | null | undefined>,
): Promise<{ memberId: string; record: T; meta: SpaceMeta | undefined } | undefined> {
  // `writeTarget`, not `spaceId`, and the rename is the point: every one of the four callers passes `wt.target`
  // from `resolveWriteTarget`, which is ALWAYS a real space. A non-proxy resolves to itself, and a proxy demands an
  // explicit `targetSpace` that must be one of its members — and members cannot be proxies, since nesting is not
  // allowed. So this loop is provably single-element.
  //
  // It was called `spaceId`, which is what made it read as a proxy fan-out during the Q-6 sweep and put it on the
  // list of sites to narrow. There is nothing here to narrow: the caller already chose one space. A misnamed
  // parameter is invisible — it gets classified by its name rather than by what reaches it.
  //
  // The loop stays rather than becoming a direct lookup: it is what makes `load` free to return nothing, and
  // collapsing it would be a behaviour bet on the reasoning above rather than a description of it.
  for (const memberId of resolveMemberSpaces(writeTarget)) {
    const record = await load(memberId);
    if (record != null) return { memberId, record, meta: getSpaceMeta(memberId) };
  }
  return undefined;
}

/**
 * The MCP-side gate. Same verdict, thrown rather than returned — MCP tools report failure by throwing.
 *
 * It exists so the two surfaces cannot drift. `update_chrono` already shipped once without the type
 * allowlist that `save_chrono` enforced, and this is the same shape of hole one layer down: an agent
 * writing through MCP would otherwise store values the REST route now refuses for the identical record.
 */
/**
 * A refusal that keeps its own structure on the way out.
 *
 * `assertUpdateAllowed` threw a plain `Error`, so by the time the MCP router turned it into a tool result
 * the `introduced` / `preExisting` split existed only inside an English sentence. The REST routes answer with
 * the arrays; the MCP callers — which are the primary write path for this product — got prose. A caller that
 * wants to repair a pre-existing violation and retry had to parse the message to find out which of its
 * fields were even at fault.
 *
 * The classification travels on the error, so every thrower gets it without changing its call shape, and the
 * router attaches it once. Reported by the canary as a minor point; it is the same "structured detail
 * flattened at the boundary" shape as the audit-log gap, one layer out.
 */
export class SchemaViolationError extends Error {
  constructor(readonly check: UpdateValidation) {
    super(`schema_violation: ${check.message}`);
    this.name = 'SchemaViolationError';
  }

  /**
   * The machine-readable body an MCP tool result carries beside the prose — and the body a REST refusal answers.
   *
   * Every row list is cut to {@link MAX_ROWS} AFTER the classification, never before it, and `truncated` says how many were left
   * out of `introduced` and `preExisting`: a record carrying a hundred undeclared keys answers twenty rows and `truncated: 80`, and which twenty is the classifier's (`introduced` first, in the order the
   * validator found them). A row quotes what the caller sent through the one bounded renderer (R6-11): a key was bounded when the
   * validator named it, and a value is bounded here.
   */
  toStructured(): Record<string, unknown> {
    const { introduced, preExisting, all } = this.check;
    // HOW MANY rows were left out of `introduced` and `preExisting`, the two lists a reader reads (`violations` is their union, cut to the
    // same number): a count, because a caller that is told "some rows" cannot say how many to expect, and the client prints the number.
    const truncated = Math.max(0, introduced.length - MAX_ROWS) + Math.max(0, preExisting.length - MAX_ROWS);
    return {
      error: 'schema_violation',
      message: this.check.message,
      introduced: boundedRows(introduced),
      preExisting: boundedRows(preExisting),
      violations: boundedRows(all),
      ...(truncated > 0 ? { truncated } : {}),
    };
  }

  /**
   * The same refusal as ONE ROW of a batch's answer carries it (`bulk.ts`, `Q-315`): `toStructured()` without `violations`. Every row
   * of `introduced` and `preExisting` is already in it, and the second list is the bloat a five-hundred-item batch would pay for five
   * hundred times. Derived from `toStructured()`, so a row cannot say something a single-record caller does not read.
   */
  toRowViolation(): Record<string, unknown> {
    return Object.fromEntries(Object.entries(this.toStructured()).filter(([k]) => k !== 'violations'));
  }
}

/**
 * The `warnings` fields of a SUCCESSFUL write's answer — the violations the space's mode says to report, and the keys the route did not
 * understand — bounded like a refusal's rows (R6-11): at most {@link MAX_ROWS} of them, each quoting the caller's `field` and string
 * `value` through the one renderer, and `warningsTruncated: true` when rows were left out. `{}` when there are none, so a caller spreads
 * it and a write with nothing to say answers no key. Both doors: every REST create and update route and the MCP tools' structured
 * answer say it through this, so a record carrying a hundred undeclared keys does not answer a hundred rows on one door and twenty on
 * the other.
 */
export function writeWarningFields(rows: readonly SchemaViolation[]): { warnings?: SchemaViolation[]; warningsTruncated?: true } {
  if (rows.length === 0) return {};
  return { warnings: boundedRows(rows), ...(rows.length > MAX_ROWS ? { warningsTruncated: true as const } : {}) };
}

/** How many violation rows one refusal lists per list. The classification is of every row; only what is SAID is cut. */
export const MAX_ROWS = 20;

/**
 * A violation's value as a refusal quotes it: a STRING through the one bounded renderer (cut, credential-redacted, line breaks
 * escaped), anything else exactly as it came. A number, a boolean, `null`, an array or an object is the caller's structured value, and
 * stringifying it would change what a caller that compares it sees (R5-4).
 */
function boundedValue(value: unknown): unknown {
  return typeof value === 'string' ? peerText(value) : value;
}

/**
 * At most {@link MAX_ROWS} rows, each quoting the caller's choices bounded: the `field` (a property key the caller chose) at
 * `NAME_QUOTED`, a string `value` by `peerText`. The one place a refusal's rows are rendered, so `introduced`, `preExisting`
 * and `violations` cannot differ in what they quote.
 */
function boundedRows(rows: readonly SchemaViolation[]): SchemaViolation[] {
  return rows.slice(0, MAX_ROWS).map(v => {
    const row: SchemaViolation = { ...v, field: peerText(v.field, { max: NAME_QUOTED }) };
    // A row with no value stays without one: a `value: undefined` key is a field the row never had.
    if (Object.hasOwn(v, 'value')) row.value = boundedValue(v.value);
    return row;
  });
}

export function assertUpdateAllowed(check: UpdateValidation): void {
  if (check.blocked) throw new SchemaViolationError(check);
}

/**
 * An edge write refused — by the space's schema, or by an end that names nothing — carrying the whole classification.
 *
 * It is a `SchemaViolationError`, one class family with the record's own refusal, and that is the point (`Q-170`): every
 * catch and mapper that already answers a record's schema refusal (the REST record routes' `connectionRefusalAnswer`,
 * `callTool`'s structured 422) answers an INLINE edge's refusal with the same status and the same body, with no branch of
 * its own to forget. When it stood alone the routes did not know it, and a refused inline edge was a `500` on REST and a
 * plain `400` on MCP.
 *
 * `at` names the edge of a body it was asked about (`edges[1]`) once a caller that knows the position has said so
 * (`named`); a refusal raised for one edge on its own (a `POST /edges`) has none.
 */
export class EdgeSchemaViolation extends SchemaViolationError {
  constructor(check: UpdateValidation, readonly at?: string) {
    super(check);
    this.name = 'EdgeSchemaViolation';
  }

  /** The same refusal, saying which edge of the body it is about: every violation's field and the sentence gain the position. */
  named(at: string): EdgeSchemaViolation {
    const prefixed = (vs: SchemaViolation[]) => vs.map(v => ({ ...v, field: `${at}.${v.field}` }));
    return new EdgeSchemaViolation({
      ...this.check,
      introduced: prefixed(this.check.introduced),
      preExisting: prefixed(this.check.preExisting),
      all: prefixed(this.check.all),
      warnings: prefixed(this.check.warnings),
      message: `${at}: ${this.check.message}`,
    }, at);
  }
}

/**
 * The classification of a reference that names nothing: one blocking violation on the field that holds it.
 *
 * Existence is a different question from the schema's, and a different rule (`strictLinkage`, not `validationMode`), but
 * it is refused as the same kind of thing — the caller named something the space does not hold — so it travels in the
 * same body. `message` is the one sentence every door gives for a missing reference (`missingRefsRefusal`).
 */
export function danglingReferenceCheck(field: string, value: string, message: string): UpdateValidation {
  const violation: SchemaViolation = { field, value, reason: message };
  return { blocked: true, introduced: [violation], preExisting: [], all: [violation], warnings: [violation], message };
}

/**
 * The status a schema refusal answers with, from the verb alone: a create is `400`, an update `422`. The two have always differed, and a
 * status is part of a caller's contract even when the pair looks inconsistent — so it is spelled here and nowhere else, and a door that
 * needs only the status (`callTool`, which answers a tool call as an edit of what the caller named) asks this and does not run the
 * answering mapper, which COUNTS the refusal.
 */
export function schemaRefusalStatus(verb: 'create' | 'update'): 400 | 422 {
  return verb === 'create' ? 400 : 422;
}

/**
 * Count one schema refusal at the door that answered it (`ythril_schema_refusals_total`, R6-13), once per refusal and by what blocked
 * the write: the first violation it INTRODUCED. Called by every mapper that answers one — `connectionRefusalAnswer` (REST),
 * `callTool` (MCP and `POST /api/<tool>`), `mergeRefusal` and the bulk row's reason — so a door cannot answer without it.
 */
export function countSchemaRefusal(door: SchemaRefusalDoor, err: SchemaViolationError): void {
  const first = err.check.introduced[0] ?? err.check.all[0];
  tallySchemaRefusal(door, first && isUndeclaredKey(first) ? 'undeclared' : 'property');
}

/**
 * What a record write refused for its connections, or its own schema, answers on REST — the status and the body, from
 * ONE place; `null` when the failure is none of those and the route answers it as it always has.
 *
 * - **A schema refusal** (the record's own, or an inline edge's, which is the same class family): the documented body
 *   (`toStructured`), and the status the verb gives it — a create answers `400`, an update `422`. The two have always
 *   differed, and a status is part of a caller's contract even when the pair looks inconsistent.
 * - **A reference refusal** (a link id or a shape the connection fields cannot honour): `400`, `{ error }`.
 *
 * Nine routes each built that body by hand and the smallest of them left three keys out, which is how a refused fact
 * answered differently from every other record.
 */
export function connectionRefusalAnswer(
  err: unknown, verb: 'create' | 'update',
): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof SchemaViolationError) {
    countSchemaRefusal('rest', err);
    return { status: schemaRefusalStatus(verb), body: err.toStructured() };
  }
  if (err instanceof ReferenceRefusal) return { status: 400, body: { error: err.message } };
  return null;
}

/**
 * What a write that did not land answers when the cause is a refusal OR a conflict — the status, from ONE place.
 *
 * `connectionRefusalAnswer`'s two refusals, and a {@link WriteConflict} (another write kept moving the record; nothing was
 * written; retry) as `409`, `{ error }`. The app's error handler, `callTool`'s catch and `connectionsNotWrittenAnswer`
 * each spelled this mapping, so a status changed in one was changed in two of three. A route that answers its own
 * conflict differently keeps calling `connectionRefusalAnswer`; this is the question the three SHARED mappers ask.
 */
export function writeRefusalAnswer(
  err: unknown, verb: 'create' | 'update',
): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof WriteConflict) return { status: 409, body: { error: err.message } };
  return connectionRefusalAnswer(err, verb);
}

/**
 * The type an entity has AFTER a patch: the one it names, else the one it has. One expression, because it decides which
 * type schema the record is validated against (`updateEntityById`) and which type an inline edge's `endpoints` rule is
 * judged by (`connectionSubject`) — a patch that re-types a record and attaches an edge in one call has to be judged by
 * the type it LEAVES, and two spellings of "the new type" are two chances to judge by the type it is leaving.
 */
export function resultingEntityType(stored: { type: string }, patch: { type?: string }): string {
  return patch.type ?? stored.type;
}

/**
 * The sentence an operator reads.
 *
 * Three distinct situations, because collapsing them is what makes a validation error useless:
 *   - only introduced   → the patch is wrong; fix the patch
 *   - only pre-existing → the patch is fine; the record was already broken here, and this write is the
 *                         moment to repair it
 *   - both              → say both, and say which is which, or the operator debugs the wrong one first
 */
export function describeUpdateViolations(
  introduced: SchemaViolation[],
  preExisting: SchemaViolation[],
): string {
  // The names are fields the CALLER chose (a property key), so the list is bounded in count and in each name: a megabyte key, or a hundred
  // of them, is a sentence, not a megabyte of one (R6-11).
  const names = (vs: SchemaViolation[]) => peerList([...new Set(vs.map(v => v.field))], ', ', { count: 10, each: NAME_QUOTED });

  // A caller who read only the prose (an MCP tool's error text) must still learn WHY a property key is refused: the row's reason says
  // "not declared", and the sentence is all of it that reaches them.
  const undeclared = introduced.filter(isUndeclaredKey);
  const undeclaredNote = undeclared.length > 0
    ? ` Not declared on this type: ${peerList([...new Set(undeclared.map(v => v.field.replace(/^properties\./, '')))], ', ', { count: 10, each: NAME_QUOTED })}.`
    : '';

  if (introduced.length > 0 && preExisting.length === 0) {
    return `The change violates this space's schema: ${names(introduced)}.${undeclaredNote}`;
  }
  if (introduced.length === 0 && preExisting.length > 0) {
    // Reported, not refused (owner ruling P-6 = B). This sentence used to end "so the write is refused until
    // those field(s) are fixed", which was true and was the freeze itself: an operator could not correct a
    // typo in a description without also resolving a field their edit never touched.
    return `This record was already non-compliant before your change: ${names(preExisting)}. `
      + 'Your edit did not cause it and is not refused for it, but the record still does not fit the current '
      + 'schema — include those field(s) in a write to repair it.';
  }
  if (introduced.length > 0 && preExisting.length > 0) {
    return `The change violates this space's schema: ${names(introduced)}.${undeclaredNote} `
      + `Separately, this record was already non-compliant before your change: ${names(preExisting)} — `
      + 'that part is reported rather than refused; include those field(s) in a write to repair them.';
  }
  return 'The merged record satisfies this space\'s schema.';
}

/**
 * ## The same hole, on the other write path
 *
 * Everything above fixes UPDATE. An upsert has exactly the same shape and was missed: `upsertEntity`
 * merges `{ ...stored.properties, ...incoming }`, and `upsertEdge` does too — but the six call sites
 * validated the INCOMING payload. A partial upsert against a complete record was refused for required
 * properties the record already had and would keep.
 *
 * Reported by an operator whose agent could not patch one field of a conformant record in a strict
 * space. It is worse for edges than for entities: an edge is identified by `(from, to, label)` with no
 * id anywhere in the call, so EVERY repeat upsert merges and there is nothing in the payload to suggest
 * it might.
 *
 * The classification is the update one, unchanged — an upsert onto an existing record IS an update, and
 * a record that was already non-compliant should not blame the caller for it either.
 */

/** An upsert onto nothing is an insert: no prior record, so nothing can be pre-existing. */
const INSERT_HAS_NO_PRIOR: SchemaViolation[] = [];

/** The record fields a write may state beside its identity — every one a rule can read, so none may fall out of the after-view. */
interface StatedFields {
  description?: string | null;
  tags?: string[] | null;
  properties?: Record<string, string | number | boolean>;
}

/**
 * The record an upsert LEAVES — the one thing the after-view is built from (R6-3: the view is of the MERGED record).
 *
 * The stored record (nothing, on an insert), with every field the write states laid over it — a `null` is a field the write REMOVES and
 * reads as absent — then tags unioned and properties merged the way every writer stores them (`merge-fields.ts`).
 *
 * It exists because each classifier built its after-view from a literal of the fields it had in hand: an edge and a fact lost their
 * tags, a fact and a chrono entry their title and description, an entity its description. The before-view was the whole stored record,
 * so a rule reading `self.description` blamed a write that never touched it, and a write that set a refused description was judged on
 * `''` and passed as the record's old break (`a-rule-reads-the-record-the-write-leaves`).
 */
export function recordAfterUpsert(existing: object | null, incoming: object): Record<string, unknown> {
  const stored = (existing ?? {}) as Record<string, unknown> & StatedFields;
  const stated = incoming as Record<string, unknown> & StatedFields;
  return {
    ...stored,
    // A key the write does not state (`undefined`) leaves the stored value; one it states, `null` included, replaces it.
    ...Object.fromEntries(Object.entries(stated).filter(([, v]) => v !== undefined)),
    tags: mergeTags(stored.tags, stated.tags ?? undefined),
    properties: mergePropertiesOrKeep(stored.properties, stated.properties) ?? {},
  };
}

/**
 * The fields a PATCH states, as an upsert's incoming fields: what `$set` writes, and `null` for a field `$unset` removes — so the
 * after-view of an update is {@link recordAfterUpsert} of the stored record and this, and a removed description reads as none.
 */
export function patchedFields($set: Record<string, unknown>, $unset: Record<string, unknown>): Record<string, unknown> {
  return { ...$set, ...Object.fromEntries(Object.keys($unset).map(k => [k, null])) };
}

/**
 * The whole decision, given the record the upsert lands on — no database.
 *
 * Split from the loading wrapper below so the rule can be tested for what it IS: which record gets
 * validated. A test that has to stand up MongoDB to ask "did you validate the merged form?" is a test
 * that will be written once and never extended, and this defect survived precisely because the merge
 * was invisible from where validation ran.
 *
 * `existing` null means insert: nothing to merge, and nothing that could be pre-existing.
 */
export function classifyEntityUpsertAgainst(
  meta: SpaceMeta | undefined,
  existing: { name: string; type: string; properties?: Record<string, string | number | boolean>; tags?: string[] } | null,
  incoming: { name: string; type: string } & StatedFields,
  /** The property keys the instance itself writes on this kind — handed in by the one writer that owns them (`INSTANCE_WRITTEN_PROPERTY_KEYS`); never a caller's. */
  instanceWrittenKeys: readonly string[] = [],
): UpdateValidation {
  return classifyViews(
    meta, view => validateEntity(meta ?? {}, view, instanceWrittenKeys),
    existing ? recordViewOf('entity', existing) : null,
    recordViewOf('entity', recordAfterUpsert(existing, incoming)),
  );
}

/**
 * What a MERGE's write introduces: the survivor as it is stored, against the survivor as the merge leaves it (`mergedProperties` — what
 * `mergeProperties` resolved, with the absorbed's keys brought in). A merge is a write of the survivor, so it is judged as one: a key the
 * survivor already stores is not one the merge adds, and a key brought in from the absorbed that the survivor lacks is.
 *
 * It exists so the merge path asks the question the write path asks. It judged the whole merged record, so a survivor with a stored
 * undeclared key refused every merge in a strict space and the refusal blamed the key the merge never added. The merge runs the
 * validator itself, on the merged values, and hands both row lists here: this decides which of them the merge is answerable for.
 */
export function classifyMergedEntity(
  meta: SpaceMeta | undefined,
  survivor: { name: string; type: string; properties?: Record<string, string | number | boolean>; tags?: string[] },
  mergedProperties: Record<string, string | number | boolean>,
  beforeRows: SchemaViolation[],
  afterRows: SchemaViolation[],
): UpdateValidation {
  // Only the survivor's stored UNDECLARED KEYS are carried as its own. Every other break of the merged record is the merge's to answer for,
  // as it always was: `mergeProperties` applies each property's `mergeFn`, so the survivor lands on a value neither input had, and a
  // strict space that refuses it on a direct write refuses it here (`a-refused-merge-answers-alike-on-every-door-db`).
  return classifyUpdateViolations(
    meta, beforeRows.filter(isUndeclaredKey), afterRows,
    deltaBetween(recordViewOf('entity', survivor), recordViewOf('entity', { ...survivor, properties: mergedProperties })),
  );
}

/**
 * The classification both validations of one upsert make: the record as stored (`null` on an insert, which has nothing pre-existing) and
 * as the write leaves it, each judged by the same validator, then split by `classifyUpdateViolations` with what the write changed.
 */
function classifyViews(
  meta: SpaceMeta | undefined,
  validate: (view: RecordView) => SchemaViolation[],
  before: RecordView | null,
  after: RecordView,
): UpdateValidation {
  return classifyUpdateViolations(meta, before ? validate(before) : INSERT_HAS_NO_PRIOR, validate(after), deltaBetween(before, after));
}

/** As above, for an edge. Its identity is `(from, to, label)`, so only the properties can merge. */
export function classifyEdgeUpsertAgainst(
  meta: SpaceMeta | undefined,
  existing: { label: string; properties?: Record<string, string | number | boolean> } | null,
  incoming: { label: string } & StatedFields,
  /**
   * What the caller resolved about the endpoints — the entity type at each end, and how many OTHER edges carry
   * this label from the same subject.
   *
   * Optional, and an absent field is never a violation: this module is pure and synchronous, two gates import
   * it from `dist` with plain objects, and the bulk importer legitimately cannot resolve a reference to a
   * record created earlier in the same payload. See `ResolvedEdgeEnds`.
   *
   * The SAME object goes to both validations, and that is what keeps a pre-existing violation pre-existing: an
   * upsert lands on the `(from, to, label)` triplet, so `before` and `after` have the same two endpoints. A
   * space that declares a rule on a label it has already used must not become a space where nobody can fix a
   * description.
   */
  resolved: ResolvedEdgeEnds = {},
  /** As for an entity: the keys the instance itself writes on an edge, handed in by the writer that owns them. */
  instanceWrittenKeys: readonly string[] = [],
): UpdateValidation {
  return classifyViews(
    meta, view => validateEdge(meta ?? {}, view, resolved, instanceWrittenKeys),
    existing ? recordViewOf('edge', existing) : null,
    recordViewOf('edge', recordAfterUpsert(existing, incoming)),
  );
}


/**
 * As above, for a fact. The one that did not exist.
 *
 * Entities, edges and chrono each had a classifier; fact never did, so the fact write paths validated the
 * INCOMING payload rather than the record it would produce. That is the same defect the chrono classifier was
 * written for and it fails in both directions: a required property present on the stored record and absent
 * from a patch reads as a violation the merge would have supplied, and a property the patch removes is never
 * checked because it was not in the payload.
 *
 * `type` replaces rather than merges — it is a scalar, and re-typing a fact has to be validated against the
 * NEW type's schema, which is what `#1047` fixed on the update route and what this brings inside.
 */
export function classifyFactUpsertAgainst(
  meta: SpaceMeta | undefined,
  existing: { type?: string; properties?: Record<string, string | number | boolean> } | null,
  incoming: { type?: string; fact?: string } & StatedFields,
  /** As for an entity: the keys the instance itself writes on a fact, handed in by the writer that owns them. */
  instanceWrittenKeys: readonly string[] = [],
): UpdateValidation {
  return classifyViews(
    meta, view => validateFact(meta ?? {}, view, instanceWrittenKeys),
    existing ? recordViewOf('fact', existing) : null,
    recordViewOf('fact', recordAfterUpsert(existing, incoming)),
  );
}

/** As above, for a chrono entry. Its identity is a supplied `_id`, so type and properties both merge in. */
export function classifyChronoUpsertAgainst(
  meta: SpaceMeta | undefined,
  existing: { type: string; properties?: Record<string, string | number | boolean> } | null,
  incoming: { type: string; title?: string } & StatedFields,
): UpdateValidation {
  // The instance writes no property on a chrono entry, so there is no exemption to take (`INSTANCE_WRITTEN_PROPERTY_KEYS` has no row for it).
  return classifyViews(
    meta, view => validateChrono(meta ?? {}, view),
    existing ? recordViewOf('chrono', existing) : null,
    recordViewOf('chrono', recordAfterUpsert(existing, incoming)),
  );
}


