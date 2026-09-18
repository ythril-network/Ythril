/**
 * Is this caller-supplied filter safe to hand to MongoDB, and what does it become on the way?
 *
 * ## One question, one module, both doors
 *
 * Every filter a caller writes reaches the database through here: `query` and `filter` (the structured-read
 * surface), `recall` (meaning-ranked search, raw grammar), and `recall`'s older operator-object grammar via
 * {@link unsafeFilterKey}. Before this file the answer lived in two places — the operator refusals and the
 * regex guard inside `brain/query.ts`, the key-shape guard inside `brain/filter.ts` — and the two grammars
 * were therefore protected by different subsets of one rule. That is the split `CLAUDE.md` names as this
 * repo's commonest defect, on the exact pair its parity section was written from.
 *
 * Owner, 2026-09-17: *"add the sanitizer and make it a real module."*
 *
 * ## What it guards, and what it deliberately does not
 *
 * **It is not a field allowlist.** Filtering on an unusual field is slow, not unsafe — that allowlist was
 * removed the same day, because it made `recall` refuse predicates `filter` accepted. What remains are the
 * three ways a filter can do something other than match documents:
 *
 * | refused | because |
 * |---|---|
 * | `$where`, `$function`, `$accumulator` | they execute JavaScript in the database process |
 * | `__proto__`, `constructor`, `prototype` as KEYS | `out[key] = …` would rewrite the object being built rather than add a constraint, so the predicate silently vanishes and the query answers 200 unfiltered |
 * | a `$regex` that is not a bounded, non-catastrophic string | one pattern pins Mongo CPU for the whole `maxTimeMS`, multiplied per member space on a proxy |
 *
 * Everything else MongoDB offers is accepted. The reasoning for that inversion — a find filter cannot name
 * another collection, so an unanticipated operator can match documents or error but never cross a space
 * boundary — lives on {@link REFUSED_OPERATORS}, and is why aggregation PIPELINES stay allowlisted instead.
 *
 * ## The seam this leaves open on purpose
 *
 * {@link sanitizeFilter} walks every key and every value, so it is also the only place that sees a value in
 * context — which is where VALUE COERCION belongs when it arrives. The case already named for it: a caller
 * writes `{_id: "65f1…"}` as a JSON string, and a collection storing `ObjectId`s matches nothing and says
 * nothing. Casting that here fixes it once for every door rather than per route. It is not implemented yet
 * and this paragraph is not a promise that it is — it is here so the next person adds it to the walk
 * instead of to their own caller.
 */
import { hasReDoSRisk, MAX_PATTERN_LENGTH } from '../util/redos.js';

/**
 * The operators a filter may NOT use — a denylist, which is the opposite of how this started and needs its
 * reasoning stated because the inversion is normally the wrong move.
 *
 * ## What it was, and why it changed
 *
 * An eighteen-operator ALLOWLIST. Owner, 2026-09-17: *"sounds like still complications instead of just
 * taking it as a mongo-query … allow for ANY-CORRECT-MONGODB-QUERY"*. The allowlist refused `$text`,
 * `$bitsAllSet`, `$geoWithin`, `$jsonSchema` and every operator MongoDB adds next — none of which can do
 * anything a caller could not already do with `$or` and `$regex`, only slower.
 *
 * ## Why a denylist is SAFE here and would not be for a pipeline
 *
 * The argument turns entirely on blast radius, and it differs between the two surfaces:
 *
 * - **A find filter cannot name another collection.** `$lookup`, `$unionWith`, `$graphLookup`, `$out` and
 *   `$merge` are aggregation STAGES; no find operator reads or writes outside the collection being queried.
 *   So an operator nobody anticipated can, at worst, match documents here or error — it cannot cross a
 *   space boundary, which is the isolation this product rests on.
 * - **A new STAGE can.** That is why pipelines stay allowlisted and are deferred as `F-26`: the set grows,
 *   and each addition is a fresh chance to read a space the token was never granted.
 *
 * So: three operators are refused, and they are refused because they EXECUTE CODE in the database process
 * rather than because they match documents. Everything else is a resource question, bounded by `limit`,
 * `maxTimeMS` and the depth cap.
 *
 * ## Nested, not top-level
 *
 * `$expr: { $function: … }` is why this is checked at every depth. A top-level scan would pass it, and
 * `$expr` is otherwise a perfectly good operator there is no reason to refuse.
 */
export const REFUSED_OPERATORS: ReadonlySet<string> = new Set([
  // Server-side JavaScript, all three. An arbitrary function in the database process is not a filter.
  '$where', '$function', '$accumulator',
]);

/**
 * Keys no filter may use in EITHER grammar, whatever fields it is otherwise allowed to reach.
 *
 * Not fields — the names that make a plain-object assignment do something other than add a key:
 *
 *     const out = {}; out['__proto__'] = { ... };   // sets the PROTOTYPE, adds no key
 *
 * Both filter builders assign exactly like that, so one of these keys does not reach the database as a
 * constraint at all: it **silently vanishes from the filter** and mutates the object being built. That is
 * the accepted-and-ignored failure this area keeps producing, with prototype pollution on top.
 */
const UNSAFE_FILTER_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** The refusal for one such key, or `null`. One sentence, one place, so both grammars answer identically. */
export function unsafeFilterKey(key: string): string | null {
  return UNSAFE_FILTER_KEYS.has(key)
    ? `Filter key '${key}' is not allowed: it names an object's internals rather than a field, so it would `
      + 'change the filter being built instead of constraining anything.'
    : null;
}

/** Valid MongoDB regex flags (i=case-insensitive, m=multiline, s=dotAll, x=extended). */
const VALID_OPTIONS_RE = /^[imsx]+$/;

/**
 * How deep a CALLER's filter may nest. A bound on the walk, and on what the database is asked to plan.
 *
 * **It bounds the caller's filter and nothing else, which is a correction rather than a clarification.**
 * The check used to run at the last moment before Mongo, by which point the caller's filter had the
 * server's own clauses composed around it and the two were counted against one budget. The budget was
 * already spent: a derived chrono `overdue` clause is itself depth 8, so `deriveStatus` plus any
 * convenience reached 9 and was refused — naming a depth the caller had not used. See
 * `CallerCheckedFilter` below for where it runs now and what keeps it there.
 *
 * **8 STAYS.** Owner, 2026-09-18, on being told the derived clause spends the whole budget: *"Keep as is
 * while it works"*. So this is not a number to raise the next time something composes one level deeper —
 * the thing to fix then is the composition, or to come back and ask.
 */
export const MAX_FILTER_DEPTH = 8;

/**
 * Walk a caller's filter, refusing what must not run and returning what may.
 *
 * Shared by every door on purpose. The fleet integrator, 2026-08-13T1035Z §2: recall's filter was one
 * operator object per key, ANDed, while query's took `$or`/`$and`/`$not`/`$regex`/`$elemMatch` nested to
 * depth 8 — so a caller wanting meaning-ranking AND a real predicate had to make two calls. Two filter
 * languages against one store is a fork of the same policy, and the narrower one keeps being the reason a
 * caller reaches for the wrong tool.
 *
 * One parser, not two similar ones. Throws on refusal, because a filter that cannot run is not a filter
 * that matches nothing — and returning an empty object for it would be the silent version of this module's
 * entire subject.
 */
export function sanitizeFilter(filter: unknown, depth = 0): unknown {
  if (depth > MAX_FILTER_DEPTH) throw new Error('Filter too deeply nested');
  if (Array.isArray(filter)) return filter.map(v => sanitizeFilter(v, depth + 1));
  /*
   * A `Date` IS A VALUE, not a document to walk, and the walk below DESTROYS one.
   *
   * `Object.entries(new Date())` is empty, so a Date rebuilt key by key comes out as `{}` — silently,
   * and the comparison it was part of then matches the wrong set with a 200. Found 2026-09-18 by a
   * server-built clause: `B-19` puts `$gte: [<dueMoment>, now]` into a chrono predicate, and the
   * sanitiser flattened `now` to `{}` so every stored-active entry came back, overdue or not.
   *
   * **No caller could have hit it, which is why it survived**: a filter arriving over HTTP is JSON, so
   * its dates are strings. It bites the moment a predicate is built in-process, and this module is on
   * the path of every one of those.
   *
   * The general rule this stands for: a sanitiser that REWRITES a value it does not recognise is worse
   * than one that refuses it. Everything else here throws; this used to quietly return something else.
   */
  if (filter instanceof Date) return filter;
  if (filter !== null && typeof filter === 'object') {
    const entries = Object.entries(filter as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [key, val] of entries) {
      // The key-shape guard, before anything is assigned — `out[key] = …` below is the assignment it exists
      // to stop, so checking afterwards would be checking the damage.
      const unsafe = unsafeFilterKey(key);
      if (unsafe) throw new Error(unsafe);
      if (REFUSED_OPERATORS.has(key)) {
        throw new Error(`Operator '${key}' is not allowed: it executes JavaScript in the database process. `
          + 'Every other MongoDB query operator is accepted.');
      }
      // `$regex` must be a plain string and pass the shared ReDoS heuristic — a catastrophic pattern would
      // otherwise pin Mongo CPU for the full maxTimeMS budget per call, multiplied per member space on
      // proxies.
      if (key === '$regex') {
        if (typeof val !== 'string') {
          throw new Error("'$regex' must be a string pattern");
        }
        if (val.length > MAX_PATTERN_LENGTH) {
          throw new Error(`'$regex' pattern exceeds ${MAX_PATTERN_LENGTH} characters`);
        }
        if (hasReDoSRisk(val)) {
          throw new Error("'$regex' pattern rejected: potential catastrophic backtracking (nested or alternating quantifiers)");
        }
      }
      out[key] = sanitizeFilter(val, depth + 1);
    }
    // `$options` must only appear alongside `$regex` and contain valid flags.
    if ('$options' in out) {
      if (!('$regex' in out)) {
        throw new Error("'$options' is only allowed alongside '$regex'");
      }
      if (typeof out['$options'] !== 'string' || !VALID_OPTIONS_RE.test(out['$options'] as string)) {
        throw new Error("'$options' must be a string of valid regex flags (i, m, s, x)");
      }
    }
    return out;
  }
  return filter;
}

declare const CALLER_CHECKED: unique symbol;

/**
 * A predicate whose CALLER-SUPPLIED part has been through `sanitizeFilter`.
 *
 * ## Why a brand rather than a convention
 *
 * `MAX_FILTER_DEPTH` bounds what a CALLER may ask for. It was enforced at the last moment before Mongo —
 * inside `queryBrain` and `countBrain` — which is the safest-looking place and the wrong one, because by
 * then the predicate is the caller's filter with the SERVER's clauses composed around it. The two were
 * counted against one budget.
 *
 * That budget turned out to be entirely spent. A derived chrono `overdue` clause is itself depth 8: an
 * `$or` over a `$expr` over a `$toDate` over an `$ifNull`. So `deriveStatus: true` plus ANY convenience —
 * which the list route served as `?status=overdue&search=…` — composed to depth 9 and was refused with
 * `Filter too deeply nested`, about a filter the caller had written one level deep.
 *
 * So the check moved to where the caller's filter is still identifiable, and this type is what stops it
 * drifting back: `queryBrain` cannot be handed a plain object any more. A future read path either passes
 * something `sanitizeFilter` produced, or it does not compile.
 */
export type CallerCheckedFilter = Record<string, unknown> & { readonly [CALLER_CHECKED]?: true };

/**
 * The caller's filter, checked — or the refusal, worded once for both doors.
 *
 * `sanitizeFilter` throws, which is right for a programming error and wrong for a caller's input: each
 * door would have to catch it and turn it into its own status code, which is two chances to word one
 * refusal differently. This returns it.
 */
export function checkCallerFilter(
  raw: Record<string, unknown>,
): { predicate: CallerCheckedFilter } | { error: string } {
  try {
    return { predicate: sanitizeFilter(raw) as CallerCheckedFilter };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The server's own clauses, composed around a checked filter.
 *
 * The ONE place the brand is applied to something `sanitizeFilter` did not produce, and it is safe for the
 * reason the brand exists: what this wraps is already checked, and what wraps it is ours. A second such
 * function would be the hole — if you are reaching for one, the thing you are composing is probably the
 * caller's and belongs on the other side of `checkCallerFilter`.
 */
export function composedByServer(predicate: Record<string, unknown>): CallerCheckedFilter {
  return predicate as CallerCheckedFilter;
}
