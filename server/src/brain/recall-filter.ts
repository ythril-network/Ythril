/**
 * One entry point for a recall filter, in EITHER grammar.
 *
 * The fleet integrator, 2026-08-13T1035Z §2: `recall`'s filter is one operator object per key, ANDed — no `$or`, no `$regex`, no
 * nesting — while `query`'s takes the full allowlisted Mongo grammar to depth 8. Their case is the mailbox query in this
 * very board's usage notes: *a message is ours if `from`, `to` or `alsoFor` names us, and separately our own asks are live
 * while `status` is open.* One `query` filter expresses it; in recall's filter it is not expressible at any length. So they
 * ran `query` first and fed ids into something else.
 *
 * ## Why both grammars, rather than replacing the old one
 *
 * `{"properties.status": {"eq": "accepted"}}` is **not valid raw Mongo** — `eq` has no `$`. Swapping parsers would break
 * every existing caller, including our own client. So the shape decides which grammar a filter is in; see `grammarOf`,
 * and note that the discriminator is the VALUES rather than the presence of a `$`, for a reason that cost a 200 with
 * an unfiltered answer.
 *
 * A MIXED filter is refused rather than resolved. `{"$or": [...], "type": {"eq": "message"}}` is a caller who believes one
 * thing and would get another; a 400 naming both costs them one round trip and saves a wrong answer.
 *
 * ## THE KEY ALLOWLIST IS GONE, and this section is kept to say so
 *
 * It read *"a recall filter still reaches only `properties.*`, `tags`, `type`, `name`, `status` and `label`"*. That
 * stopped being true on 2026-09-17: `filter` — the structured-read door — never had the restriction, so the pair the
 * parity rule was written FROM was the pair that disagreed. Owner: *"same for the recall with filter … they need to be
 * the same."*
 *
 * The keys now decide the PATH, not admission: an index-servable key becomes a native `$vectorSearch` pre-filter, and
 * anything else scores the space exhaustively and filters after. Both keep the guarantee that `topK` is filled from
 * records that satisfy the filter, and the response says which one ran when it was the slow one.
 */
import { sanitizeFilter } from './query.js';
import { validateFilterExpression, buildMongoFilter, type FilterExpression } from './filter.js';

/**
 * The operator-object grammar's complete vocabulary. A value object using only these is the old form.
 *
 * Written out rather than derived from `filter.ts`: that module holds two overlapping sets — the operators
 * the TRANSLATION understands and the narrower `NATIVE_VECTOR_FILTER_OPS` the index can push — and neither
 * is the right answer to *"which spelling did the caller mean"*. Deriving from either would make a grammar
 * decision follow a performance decision.
 */
const EXPRESSION_OPS = new Set(['eq', 'ne', 'in', 'exists', 'gt', 'gte', 'lt', 'lte']);

/** A value in the operator-object grammar: `{eq: 'x'}`, `{gt: 1, lte: 9}`. Not `'x'`, not `{$eq: 'x'}`. */
function isOperatorObject(v: unknown): boolean {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v as Record<string, unknown>);
  return keys.length > 0 && keys.every(k => EXPRESSION_OPS.has(k));
}

/**
 * Which grammar is this? **Decided by the VALUES, not by the presence of a `$`.**
 *
 * ## The rule this replaces, and the wrong answer it gave
 *
 * It used to be *"a `$` on any key, at any depth, means raw Mongo"* — so anything without one was read as
 * the operator-object form. `{type: 'note'}` has no `$`, and it is the commonest filter anybody writes.
 *
 * Read as an operator object, its value `'note'` holds no `eq`, so the translation produced NOTHING and the
 * recall answered 200 with the unfiltered ranking. **Accepted, ignored, and indistinguishable from
 * working** — the fleet integrator's `/query` report word for word, on a spelling the schema description
 * now recommends. It had been bounded by the old key allowlist to six field names and was let loose across
 * every field when the keys were opened up on 2026-09-17.
 *
 * ## So the discriminator is the shape of the values
 *
 * The operator-object grammar is a narrow, fully enumerable thing: every value is an object whose keys all
 * come from `EXPRESSION_OPS`. Everything else — a scalar, an array, a `$`-operator, a sub-document — is
 * ordinary MongoDB, which is what the owner asked for: *"make it work like a normal mongoquery"*.
 *
 * Defined by what the OLD grammar is rather than by what Mongo is, deliberately. Mongo's surface grows; the
 * operator-object form is frozen and has eight operators. A rule written against the growing side would
 * have to be revisited every time MongoDB adds something, and the revision nobody makes is the one that
 * silently reclassifies a caller's filter.
 */
function grammarOf(raw: Record<string, unknown>): 'expression' | 'mongo' | 'mixed' {
  const entries = Object.entries(raw);
  /*
   * A `$` at the TOP LEVEL means raw MongoDB whatever the values look like, and that is a security
   * boundary rather than a nicety.
   *
   * `{$where: {eq: 'x'}}` has an operator-object value, so the value-shape rule alone would call it the old
   * grammar — and the old grammar's path has no `sanitizeFilter` between it and the database. It built
   * `{$where: {$eq: 'x'}}` and sent it. Anything `$`-prefixed goes to the raw path, where the sanitizer
   * that refuses the three JavaScript-executing operators lives.
   */
  const hasOperatorKey = entries.some(([k]) => k.startsWith('$'));

  // The old grammar: every value is an object whose keys all come from `EXPRESSION_OPS`, and no top-level
  // operator. `{type: 'note'}` is NOT this — see the docblock; reading it as this cost a 200 with an
  // unfiltered answer.
  if (!hasOperatorKey && entries.every(([, v]) => isOperatorObject(v))) return 'expression';

  /*
   * Mixed: a FIELD whose value carries a bare operator name, beside something that is not the old grammar.
   * The caller believes one thing and would get another, so it is refused rather than resolved — a 400
   * costs one round trip and a guess costs a wrong answer nobody can see.
   *
   * `$`-prefixed keys are excluded from this test on purpose: their values are operator ARGUMENTS, not
   * field constraints, so `{$where: {eq: 1}}` is not a caller mixing grammars — it is raw MongoDB with a
   * refused operator, and it must reach the sanitizer to be told so.
   */
  const partial = entries.some(([k, v]) =>
    !k.startsWith('$') && v !== null && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v as Record<string, unknown>).some(op => EXPRESSION_OPS.has(op)));
  return partial ? 'mixed' : 'mongo';
}

/**
 * The result says WHICH grammar it was, and that is not bookkeeping.
 *
 * An operator-object filter can be pushed into `$vectorSearch` as a native pre-filter; a raw filter with `$or` cannot, and
 * has to take the exhaustive path. Collapsing both to "a Mongo filter" would silently move every existing caller off the
 * fast path — a performance regression delivered as a refactor.
 */
export type ResolvedRecallFilter =
  | { ok: true; kind: 'none' }
  /** The original grammar, untouched, so the native pre-filter path stays available. */
  | { ok: true; kind: 'expression'; expression: FilterExpression }
  /** Raw Mongo. Pushed into the index when it is a flat conjunction of servable fields; exhaustive otherwise. */
  | { ok: true; kind: 'mongo'; filter: RawMongoFilter }
  | { ok: false; error: string };

/**
 * Turn a caller's filter — either grammar — into a Mongo filter, or into the message explaining why not.
 *
 * `kind: 'none'` means no filter, which every caller already treats as unfiltered.
 */
export function resolveRecallFilter(raw: unknown): ResolvedRecallFilter {
  if (raw === undefined || raw === null) return { ok: true, kind: 'none' };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'filter must be an object' };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return { ok: true, kind: 'none' };

  const grammar = grammarOf(raw as Record<string, unknown>);
  if (grammar === 'expression') {
    // The original grammar, unchanged: same validator, same translation, same errors.
    const err = validateFilterExpression(raw as FilterExpression);
    if (err) return { ok: false, error: err };
    return { ok: true, kind: 'expression', expression: raw as FilterExpression };
  }

  // Mixed: some key uses the operator-object form while another does not. Refuse, naming the old-form side.
  if (grammar === 'mixed') {
    const legacyKeys = entries
      .filter(([k, v]) => !k.startsWith('$') && v !== null && typeof v === 'object' && !Array.isArray(v)
        && Object.keys(v as Record<string, unknown>).some(op => EXPRESSION_OPS.has(op)))
      .map(([k]) => k);
    return {
      ok: false,
      error: `filter mixes both grammars: ${legacyKeys.join(', ')} use the operator-object form (eq, ne, in, …) while `
        + 'the rest is raw MongoDB. Pick one — raw MongoDB accepts everything the operator form does, spelled `$eq`, '
        + '`$ne`, `$in`.',
    };
  }

  /*
   * NOT REFUSED ANY MORE — the keys decide the PATH, not admission.
   *
   * A key outside the index-servable set means the recall scores the space exhaustively and filters after,
   * which is correct and slower. Refusing it made the capability absent on one door while the other door
   * accepted it, which is the split this change closes.
   */

  try {
    return { ok: true, kind: 'mongo', filter: { __raw: sanitizeFilter(raw) as Record<string, unknown> } };
  } catch (err: unknown) {
    // `sanitizeFilter` throws on a disallowed operator, excessive depth, or an unsafe regex. Its message is the one
    // `query` gives for the same filter, which is the point of sharing it.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A validated raw-MongoDB filter, wrapped so it can travel in the SAME parameter as the operator-object form.
 *
 * Threading a second `mongoFilter` argument through `recall` → `recallByType` → `applyLexicalFusion` cost three signature
 * lines and pushed `recall.ts` past the god-file ratchet. That gate was right to object, and the smaller design is better
 * anyway: there is ONE filter channel carrying two grammars, which is exactly what the feature is, rather than two channels
 * a reader has to know are mutually exclusive.
 */
export interface RawMongoFilter { __raw: Record<string, unknown> }

/** Is this the raw grammar? The wrapper exists so this question has one answer instead of a convention. */
export function isRawFilter(f: unknown): f is RawMongoFilter {
  return f !== null && typeof f === 'object' && '__raw' in (f as Record<string, unknown>);
}

/** Either grammar, in one channel — the type `recall` and its helpers take for their `filter` parameter. */
export type RecallFilter = FilterExpression | RawMongoFilter;

/**
 * The Mongo predicate a recall applies: its `tags` and its `filter`, in either grammar, as one document.
 *
 * ## Why this is a function and not two lines at each site
 *
 * There are two sites and they are easy to miss as a pair. The exhaustive `$vectorSearch` pipeline pushes
 * `{tags: {$all: …}}` and the translated filter as separate `$match` stages; the fresh-write scan needs the
 * same constraint inside the one `$match` it has. They were written independently, and the second one was
 * written WITHOUT the filter at all — so a recall with `filter: {type: 'x'}` returned fresh records whose
 * type is not `x`, at 200. That is this repo's commonest defect exactly: one rule, two implementations, and
 * the weaker one winning silently.
 *
 * The forgettable part is inside: a caller cannot construct the tag clause and forget the filter, because
 * there is one thing to call and it returns both.
 *
 * Returns `undefined` rather than `{}` for an unconstrained recall, so a caller can tell "no predicate" from
 * "a predicate that happens to be empty" without inspecting the object.
 */
export function recallPredicate(
  tags: string[] | undefined,
  filter: RecallFilter | undefined,
): Record<string, unknown> | undefined {
  const p: Record<string, unknown> = {
    ...(tags && tags.length > 0 ? { tags: { $all: tags } } : {}),
    ...(filter == null ? {}
      : isRawFilter(filter) ? filter.__raw
        : buildMongoFilter(filter as FilterExpression)),
  };
  return Object.keys(p).length > 0 ? p : undefined;
}
