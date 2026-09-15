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
 *   - **introduced** — not present before this patch. The patch caused it.
 *   - **pre-existing** — present before and still present. The patch did not cause it, and did not fix it.
 *
 * Both block, in a `strict` space. That is deliberate rather than a half-measure: the merged record is what
 * gets stored, and storing a known-invalid record because it was already invalid is how a space drifts
 * permanently out of conformance. And the record is not trapped — validation is of the *merged* result, so
 * a patch that repairs the pre-existing violation passes. The error names exactly what to include.
 */
import { validateEntity, validateEdge, validateChrono, validateMemory, type SchemaViolation } from '../spaces/schema-validation.js';
import type { SpaceMeta, ChronoEntry } from '../config/types.js';
import { col, asFilter } from '../db/mongo.js';
import { resolveMemberSpaces } from '../spaces/proxy.js';
import { applyValidation, getSpaceMeta } from '../spaces/schema-validation.js';
import type { ResolvedEdgeEnds } from '../spaces/schema-validation.js';
import { mergeTagsAndProperties, mergePropertiesOrKeep } from './merge-fields.js';

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
 * Classify the merged record's violations against the record's prior ones.
 *
 * `beforeViolations` is what the SAME validator says about the record as it stands now. Recomputing it
 * rather than trusting a stored flag matters: the space's meta can have tightened since the record was
 * written, and the question here is not "was this record valid when created" but "is this field's failure
 * something this patch is responsible for".
 */
export function classifyUpdateViolations(
  meta: SpaceMeta | undefined,
  beforeViolations: SchemaViolation[],
  afterViolations: SchemaViolation[],
): UpdateValidation {
  const before = new Set(beforeViolations.map(key));
  const introduced = afterViolations.filter(v => !before.has(key(v)));
  const preExisting = afterViolations.filter(v => before.has(key(v)));

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

  /** The machine-readable body an MCP tool result carries beside the prose. */
  toStructured(): Record<string, unknown> {
    return {
      error: 'schema_violation',
      message: this.check.message,
      introduced: this.check.introduced,
      preExisting: this.check.preExisting,
      violations: this.check.all,
    };
  }
}

export function assertUpdateAllowed(check: UpdateValidation): void {
  if (check.blocked) throw new SchemaViolationError(check);
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
  const names = (vs: SchemaViolation[]) => [...new Set(vs.map(v => v.field))].join(', ');

  if (introduced.length > 0 && preExisting.length === 0) {
    return `The change violates this space's schema: ${names(introduced)}.`;
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
    return `The change violates this space's schema: ${names(introduced)}. `
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
  incoming: { name: string; type: string; properties?: Record<string, string | number | boolean>; tags?: string[] },
): UpdateValidation {
  const merged = mergeTagsAndProperties(existing, incoming);
  const after = validateEntity(meta ?? {}, {
    name: incoming.name, type: incoming.type, properties: merged.properties,
  });
  const before = existing
    ? validateEntity(meta ?? {}, {
      name: existing.name, type: existing.type, properties: existing.properties ?? {},
    })
    : INSERT_HAS_NO_PRIOR;
  return classifyUpdateViolations(meta, before, after);
}

/** As above, for an edge. Its identity is `(from, to, label)`, so only the properties can merge. */
export function classifyEdgeUpsertAgainst(
  meta: SpaceMeta | undefined,
  existing: { label: string; properties?: Record<string, string | number | boolean> } | null,
  incoming: { label: string; properties?: Record<string, string | number | boolean> },
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
): UpdateValidation {
  const after = validateEdge(meta ?? {}, {
    label: incoming.label, properties: mergePropertiesOrKeep(existing?.properties, incoming.properties) ?? {},
  }, resolved);
  const before = existing
    ? validateEdge(meta ?? {}, { label: existing.label, properties: existing.properties ?? {} }, resolved)
    : INSERT_HAS_NO_PRIOR;
  return classifyUpdateViolations(meta, before, after);
}


/**
 * As above, for a memory. The one that did not exist.
 *
 * Entities, edges and chrono each had a classifier; memory never did, so the memory write paths validated the
 * INCOMING payload rather than the record it would produce. That is the same defect the chrono classifier was
 * written for and it fails in both directions: a required property present on the stored record and absent
 * from a patch reads as a violation the merge would have supplied, and a property the patch removes is never
 * checked because it was not in the payload.
 *
 * `type` replaces rather than merges — it is a scalar, and re-typing a memory has to be validated against the
 * NEW type's schema, which is what `#1047` fixed on the update route and what this brings inside.
 */
export function classifyMemoryUpsertAgainst(
  meta: SpaceMeta | undefined,
  existing: { type?: string; properties?: Record<string, string | number | boolean> } | null,
  incoming: { type?: string; properties?: Record<string, string | number | boolean> },
): UpdateValidation {
  const after = validateMemory(meta ?? {}, {
    type: incoming.type ?? existing?.type,
    properties: mergePropertiesOrKeep(existing?.properties, incoming.properties) ?? {},
  });
  const before = existing
    ? validateMemory(meta ?? {}, { type: existing.type, properties: existing.properties ?? {} })
    : INSERT_HAS_NO_PRIOR;
  return classifyUpdateViolations(meta, before, after);
}

/** As above, for a chrono entry. Its identity is a supplied `_id`, so type and properties both merge in. */
export function classifyChronoUpsertAgainst(
  meta: SpaceMeta | undefined,
  existing: { type: string; properties?: Record<string, string | number | boolean> } | null,
  incoming: { type: string; properties?: Record<string, string | number | boolean> },
): UpdateValidation {
  const after = validateChrono(meta ?? {}, {
    type: incoming.type, properties: mergePropertiesOrKeep(existing?.properties, incoming.properties) ?? {},
  });
  const before = existing
    ? validateChrono(meta ?? {}, { type: existing.type, properties: existing.properties ?? {} })
    : INSERT_HAS_NO_PRIOR;
  return classifyUpdateViolations(meta, before, after);
}


