/**
 * Recall filter DSL — the `FilterExpression` grammar and its translations.
 *
 * Split out of brain/fact.ts (A17.4). Self-contained: validates a caller-supplied filter, and
 * lowers it either to a Mongo filter (post-vector-search) or to a native $vectorSearch prefilter.
 */

import { unsafeFilterKey } from './filter-sanitizer.js';

// ── Prefiltered recall ────────────────────────────────────────────────────

/**
 * A single filter operator applied to one field.
 * Multiple operators on the same field are AND-ed together (e.g. gt+lt for a range).
 */
export interface FilterOperator {
  eq?: string | number | boolean;
  ne?: string | number | boolean;
  in?: Array<string | number | boolean>;
  exists?: boolean;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}

/**
 * Map of dot-notation field paths to their filter operator(s).
 * Keys must start with `properties.`, `tags`, `type`, `name`, `status`, or `label`.
 */
export type FilterExpression = Record<string, FilterOperator>;

/**
 * The field paths a filter can be PUSHED INTO THE INDEX for — not the paths it may reach.
 *
 * ## It used to be a refusal, and that was a capability gap wearing a safety label
 *
 * This list refused any other key. `filter` — the structured-read door — has never had the restriction and
 * accepts any field, so a caller could predicate on `description` through one door and was refused through
 * the other. That is the split `CLAUDE.md` names as this repo's commonest defect, and the recall/query
 * filter pair is the example it was written FROM.
 *
 * Owner, 2026-09-17: *"same for the recall with filter — should accept the same filtering … they need to
 * be the same."*
 *
 * **The restriction was about SPEED, and the slow path already existed.** A key in this set, on a declared
 * schema property, becomes a native `$vectorSearch` pre-filter; anything else scores the space
 * exhaustively and filters after. Both keep the guarantee — `topK` is filled from records that satisfy the
 * filter, so a filtered recall cannot silently miss a match. Refusing the key never made a query fast; it
 * made the capability absent.
 *
 * So the list stays, and what it decides changed: it now picks the PATH, and the result discloses which
 * one ran. A caller who buys an exhaustive scan is told they bought one.
 *
 * ## Why this is exported, and why the predicate below is too
 *
 * `recall-filter.ts` held a byte-identical copy of both — the same six prefixes and the same three-clause
 * matching rule — while already importing `validateFilterExpression` from this file. Two implementations of
 * one rule is the defect this codebase produces most, and the recall/query filter pair is the example
 * `CLAUDE.md` was written from: a caller reaches one grammar or the other depending on which door they
 * happened to pick, and the weaker copy is invisible from both sides.
 *
 * The stake is not injection alone. A key outside this set is one the index cannot serve, so widening it in
 * one copy is a performance cliff wearing a feature's clothes.
 */
export const ALLOWED_FILTER_KEY_PREFIXES =
  ['properties.', 'tags', 'type', 'name', 'status', 'label', 'superseded'] as const;

/**
 * Does this key reach an allowed path? The three clauses are the rule, and they are not obvious:
 * an exact match, a dotted path under a bare prefix, and a `properties.`-style prefix that already ends in
 * a dot. A copy that dropped the third would silently refuse every property filter.
 */
export const filterKeyAllowed = (key: string): boolean =>
  ALLOWED_FILTER_KEY_PREFIXES.some(
    p => key === p || key.startsWith(p + '.') || (p.endsWith('.') && key.startsWith(p)),
  );

/** The prefixes as an operator reads them, built from the list so the refusal cannot describe a stale set. */
export const allowedFilterKeysSentence = (): string =>
  ALLOWED_FILTER_KEY_PREFIXES.map((p, i, all) => (i === all.length - 1 ? `or ${p}` : p)).join(', ');

/*
 * The key-shape guard lives in `brain/filter-sanitizer.ts`, with the operator refusals and the ReDoS
 * check, because all three answer one question — *what may this filter do to the database?* — and both
 * grammars have to answer it the same way. It was written here first and moved the same day: a guard
 * defined in the module of one of its two callers is a guard the other caller's author does not find.
 */

/**
 * Validate a filter expression.
 *
 * **It no longer refuses a key for being an undeclared FIELD**, and the reason the check went rather than
 * being relaxed: the field prefixes were never an injection boundary. Values are passed as a Mongo
 * document, not interpolated. What the prefixes decided was whether the filter could be pushed into the
 * index — a speed question, answered by `filterKeyAllowed` at the call site now, and disclosed to the
 * caller rather than enforced against them.
 *
 * What it still refuses is the shape that cannot be a field at all. A `$`-prefixed key here would mean a
 * caller wrote raw MongoDB and was read as the operator-object grammar — `{$where: {eq: 'x'}}` is the case,
 * and it used to build `{$where: {$eq: 'x'}}` and hand it to the database, because the expression path has
 * no `sanitizeFilter` between it and Mongo. `grammarOf` now routes anything with a `$` to the raw path
 * where that sanitizer lives; this is the floor under it, so the hole cannot reopen by a classifier change.
 */
export function validateFilterExpression(filter: FilterExpression): string | null {
  for (const key of Object.keys(filter)) {
    const unsafe = unsafeFilterKey(key);
    if (unsafe) return unsafe;
    if (key.startsWith('$')) {
      return `Filter key '${key}' is not allowed in the operator-object grammar. Write the whole filter as `
        + 'raw MongoDB instead — mixing the two is refused rather than guessed at.';
    }
  }
  return null;
}

/** Convert a FilterExpression to a MongoDB match document. */
export function buildMongoFilter(filter: FilterExpression): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, op] of Object.entries(filter)) {
    const mongoOp: Record<string, unknown> = {};
    if (op.eq !== undefined) mongoOp['$eq'] = op.eq;
    if (op.ne !== undefined) mongoOp['$ne'] = op.ne;
    if (op.in !== undefined) mongoOp['$in'] = op.in;
    if (op.exists !== undefined) mongoOp['$exists'] = op.exists;
    if (op.gt !== undefined) mongoOp['$gt'] = op.gt;
    if (op.gte !== undefined) mongoOp['$gte'] = op.gte;
    if (op.lt !== undefined) mongoOp['$lt'] = op.lt;
    if (op.lte !== undefined) mongoOp['$lte'] = op.lte;
    if (Object.keys(mongoOp).length > 0) {
      result[key] = mongoOp;
    }
  }
  return result;
}

/**
 * Operators we are confident `$vectorSearch` accepts inside its native `filter`. `$ne`/`$nin` and
 * `$exists` are deliberately excluded — a filter using them routes to the exhaustive-scan path
 * instead (correct, just slower), which avoids a wasted native attempt that Atlas would reject.
 */
const NATIVE_VECTOR_FILTER_OPS = ['eq', 'in', 'gt', 'gte', 'lt', 'lte'] as const;

/**
 * Build a `$vectorSearch` native `filter` document from the recall `tags` + `filter` inputs — but
 * ONLY if every referenced field is a declared filter field on the index and every operator is
 * natively supported (P6). Returns `null` when the request can't be fully expressed natively, in
 * which case the caller falls back to the exhaustive `exact:true` scan + post-`$match`.
 *
 * `tags` uses "must contain all" semantics; on an array filter field an equality match means
 * "array contains this value", so N tags become an `$and` of N equalities.
 */
/**
 * The same question for a RAW Mongo filter: can the index serve it, and if so as what?
 *
 * ## Why this exists, and what it is fixing
 *
 * `toNativeVectorFilter` speaks the operator-object grammar (`{type: {eq: 'note'}}`) and a raw filter was
 * sent straight down the exhaustive path with the note *"a raw filter is never declarable"*. That was true
 * of the interesting ones — `$or` has no `$vectorSearch` equivalent — and false of the common one:
 * `{type: 'note'}` is an equality on a declared field and pushes natively without ceremony.
 *
 * **It stopped being acceptable the day the raw grammar became the recommended one.** 2026-09-17 opened the
 * filter to any MongoDB query, and the `filterPath` disclosure added in the same change immediately showed
 * what that cost: every caller writing the grammar we now recommend bought an exhaustive scan, while the
 * older operator-object form stayed fast. "The two doors accept the same filter" is not much use if one
 * SPELLING of a filter is always the slow one.
 *
 * ## What converts, and why the rest must not
 *
 * Only a flat conjunction of field constraints whose operators the index can push. `$or`, `$not`, `$nor`,
 * `$regex`, `$exists`, `$elemMatch` and anything nested return `null`, which sends the whole request down
 * the exhaustive path — correct, and the reason a partial conversion is not attempted: half a filter
 * pushed natively and half applied after would restrict the candidate set BEFORE scoring and silently
 * change which records `topK` is filled from. That is the one failure this path must never have.
 */
export function rawToNativeVectorFilter(
  raw: Record<string, unknown>,
  declaredFields: Set<string>,
): Record<string, unknown> | null {
  const clauses: Record<string, unknown>[] = [];

  for (const [key, val] of Object.entries(raw)) {
    // A top-level `$and`/`$or`/anything: not a field constraint, so the whole filter goes exhaustive.
    if (key.startsWith('$')) return null;
    if (!declaredFields.has(key)) return null;

    // A scalar is an equality. This is the case the old code missed, and the commonest filter there is.
    if (val === null || typeof val !== 'object' || Array.isArray(val)) {
      clauses.push({ [key]: { $eq: val } });
      continue;
    }

    const ops = Object.keys(val as Record<string, unknown>);
    // A nested document that is not an operator object is a sub-document equality; the index cannot serve it.
    if (ops.length === 0 || !ops.every(o => o.startsWith('$'))) return null;
    if (!ops.every(o => NATIVE_VECTOR_FILTER_OPS.includes(o.slice(1) as typeof NATIVE_VECTOR_FILTER_OPS[number]))) {
      return null;
    }
    clauses.push({ [key]: val as Record<string, unknown> });
  }

  if (clauses.length === 0) return null;
  return clauses.length === 1 ? clauses[0]! : { $and: clauses };
}

export function toNativeVectorFilter(
  tags: string[] | undefined,
  filter: FilterExpression | undefined,
  declaredFields: Set<string>,
): Record<string, unknown> | null {
  const clauses: Record<string, unknown>[] = [];

  if (tags && tags.length > 0) {
    if (!declaredFields.has('tags')) return null;
    for (const t of tags) clauses.push({ tags: { $eq: t } });
  }

  if (filter) {
    for (const [key, op] of Object.entries(filter)) {
      if (!declaredFields.has(key)) return null;
      const mongoOp: Record<string, unknown> = {};
      for (const name of NATIVE_VECTOR_FILTER_OPS) {
        const v = (op as Record<string, unknown>)[name];
        if (v !== undefined) mongoOp['$' + name] = v;
      }
      // An operator we can't push natively (e.g. `ne`, `exists`) → whole request is non-native.
      const requestedOps = Object.keys(op).filter(k => (op as Record<string, unknown>)[k] !== undefined);
      if (requestedOps.some(k => !NATIVE_VECTOR_FILTER_OPS.includes(k as typeof NATIVE_VECTOR_FILTER_OPS[number]))) {
        return null;
      }
      if (Object.keys(mongoOp).length > 0) clauses.push({ [key]: mongoOp });
    }
  }

  if (clauses.length === 0) return null;
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}


/** Derive the text to embed for a fact (tags + entity names + fact + description + properties). */
