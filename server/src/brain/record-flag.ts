/**
 * The per-record boolean flags a brain write accepts, and the one reader both doors use for them.
 *
 * ## What this prevents, which is not "duplicated code"
 *
 * There was one such flag, and its parser was written twice — REST refused a non-boolean with a `400`
 * while MCP tested `typeof === 'boolean'` and **silently dropped** anything else. Same field, same rule,
 * two answers, and which one a caller got depended on the door they happened to pick. That was fixed by
 * giving `suppressEmbeddings` a single parser.
 *
 * `superseded` is the SECOND such flag, which is the point at which that parser stops being one field's
 * helper and becomes this module. A hand-written copy for the second flag would drop exactly what the
 * first one's copy dropped — **the refusal** — because a `typeof` test reads like the whole rule and the
 * coercion it hides is invisible until a caller sends `"false"`.
 *
 * So the refusal lives in here and cannot be left out of a caller. There is no variant that coerces.
 *
 * ## The registry is here so a gate can derive it
 *
 * `record-flags-reachable-on-every-surface.test.js` asserts that a flag reaches all four record types on
 * both doors, or none — and its title says *"a per-record write flag"* while its body used to read one
 * name. A gate whose title claims a set and whose body names a member passes for ever on the member it
 * knows. {@link RECORD_FLAGS} is what it derives the set from, so the second flag was checked the day it
 * was declared rather than the day somebody remembered to add a case.
 *
 * Adding a third flag means adding it here. Nothing else in the gate changes.
 */

/**
 * Retire this record from meaning-ranked search — the record tier of `record > schema > space`.
 *
 * The full account of the tiers, the rename, and why the flag is the ABSENCE of a vector rather than a
 * read-time exclusion is in `suppress-embeddings.ts`, which owns the behaviour. This file owns only the
 * name, so that the registry below can be a list of names rather than a list of imports.
 */
export const RECORD_SUPPRESS_FIELD = 'suppressEmbeddings';

/**
 * This record is no longer true.
 *
 * ## It does NOT touch the vector, and that is the whole decision
 *
 * Owner, 2026-09-19: *"superseded status and a supersedes edge win i think"* — rejecting a proposal that a
 * retired record be stored unembedded the way an attributed claim is, with the question that settles it:
 *
 * > *"what if you ask 'where did ada work?' or 'list all workplaces' - A kills that."*
 *
 * It does. A record with no vector cannot be ranked even deliberately, so suppressing a retired fact buys
 * a fix for the present-tense question by making every historical one unanswerable. A superseded record
 * therefore embeds, ranks and is returned exactly as before, carrying one field that says it has been
 * overtaken. **Retrieval does not decide what that means; the caller does.**
 *
 * That is also why this is not a spelling of {@link RECORD_SUPPRESS_FIELD}. The two look alike — both are
 * per-record booleans about how much to trust a record — and they do opposite things to its reachability.
 *
 * ## What it does NOT say, and each absence is deliberate
 *
 * - **Not "delete me".** `_expireAt` means *remove this record when the retention window passes*. A record
 *   that is merely out of date must never be swept: the history is the reason it was kept rather than
 *   edited, and conflating the two would silently delete what this flag exists to preserve.
 * - **Not "replaced by X".** A `supersedes` edge says which record replaced this one. Writing the winner's
 *   id into a field as well would be a second copy of one fact, and the copy that goes stale when the
 *   winner is itself retired. The two are kept apart because either can be true alone: *"Ada left Acme"*
 *   with no new employer is a retirement with no successor, and it must still be sayable.
 * - **Not "wrong".** A superseded record was true, or was believed. `contradiction_candidates` records a
 *   disagreement; this records an outcome.
 */
export const RECORD_SUPERSEDED_FIELD = 'superseded';

/**
 * Every per-record boolean flag, in one place, because a gate derives its subject from this.
 *
 * A corrected list is the same defect with a later expiry date — so nothing else in this repo writes these
 * names as a set. Add a flag here and the consistency gate covers it without being edited.
 */
export const RECORD_FLAGS = [RECORD_SUPPRESS_FIELD, RECORD_SUPERSEDED_FIELD] as const;

/** One of the per-record boolean flags. */
export type RecordFlag = typeof RECORD_FLAGS[number];

/** The one refusal text for a bad value, so both doors say the same thing for the same mistake. */
export function recordFlagTypeError(field: RecordFlag): string {
  return `\`${field}\` must be a boolean`;
}

/**
 * Read a per-record boolean flag out of a request body or a set of MCP tool args.
 *
 * `undefined` means the caller said nothing, which is not the same as `false` — a flag with tiers below it
 * must fall through rather than override them, and a flag without tiers still distinguishes "leave it as
 * it is" from "set it to false" on a PATCH.
 *
 * **A non-boolean is refused, never coerced.** `"false"` is truthy, so a flag that quietly took whatever it
 * was given would turn a caller's mistake into the opposite of what they asked for, on a field whose whole
 * job is to be believed.
 */
export function parseRecordFlag(
  body: unknown,
  field: RecordFlag,
): { ok: true; value: boolean | undefined } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) return { ok: true, value: undefined };
  const raw = (body as Record<string, unknown>)[field];
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'boolean') return { ok: false, error: recordFlagTypeError(field) };
  return { ok: true, value: raw };
}

/**
 * Read the `superseded` mark off a request body or MCP args.
 *
 * A named wrapper rather than a bare `parseRecordFlag(body, 'superseded')` at eight call sites: the gate
 * detects the forward by this name on both doors, and a call site spelling the field as a string literal
 * is one a rename would leave behind.
 */
export function parseRecordSuperseded(
  body: unknown,
): { ok: true; value: boolean | undefined } | { ok: false; error: string } {
  return parseRecordFlag(body, RECORD_SUPERSEDED_FIELD);
}

/**
 * Copy whichever per-record flags a create stated onto the document it is about to write.
 *
 * ## Why this is a function and not two lines in each writer
 *
 * It WAS two lines in each writer, four times, which is one rule with four implementations — the defect
 * this codebase produces most. Each copy is a line that looks like boilerplate, so the fourth is the one
 * that gets written without the second flag and nothing says so: the write succeeds, the field is missing,
 * and the gate that checks the ROUTES forwarded it passes because they did.
 *
 * With this, a third flag reaches all four record types by being added to the branch below. Without it, a
 * third flag is four edits and a chance to miss one.
 *
 * `undefined` is skipped rather than written, on purpose: for `suppressEmbeddings` an absent key means
 * "not stated" and must fall through to the schema and space tiers, and writing `undefined` would store a
 * key that reads as a stated `false`.
 */
export type RecordFlags = { [K in RecordFlag]?: boolean | undefined };

export function applyRecordFlags(doc: RecordFlags, opts?: RecordFlags): void {
  for (const flag of RECORD_FLAGS) {
    if (opts?.[flag] !== undefined) doc[flag] = opts[flag];
  }
}


/**
 * Every per-record flag a body states, each read by `parseRecordFlag` — for a door that takes them all at once.
 *
 * A batch item is the case: the single-record doors name each flag at its own call site (the gate detects the
 * forward by name there), while a batch loop that named them would be the fourth copy of a list this file
 * already holds. Iterating `RECORD_FLAGS` is what makes a third flag reach the batch door by being declared,
 * and the first non-boolean refuses the item rather than being dropped.
 */
export function parseRecordFlags(body: unknown): { ok: true; flags: RecordFlags } | { ok: false; error: string } {
  const flags: RecordFlags = {};
  for (const flag of RECORD_FLAGS) {
    const r = parseRecordFlag(body, flag);
    if (!r.ok) return r;
    if (r.value !== undefined) flags[flag] = r.value;
  }
  return { ok: true, flags };
}
