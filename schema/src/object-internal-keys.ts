/**
 * Does this caller-supplied key name an object's INTERNALS rather than a field? — the one answer for every path, property
 * name or filter key that will be used as a plain-object key.
 *
 * ## What it prevents
 *
 * `out[key] = value` with `key === '__proto__'` does not add a key: it replaces the prototype of the object being built.
 * `constructor` and `prototype` reach the same machinery one step further along. Any code that assigns, traverses or
 * deletes by a key a caller or a peer sent has to refuse these three first, or the write silently goes somewhere other
 * than the record — and a filter key that vanishes this way answers 200 unfiltered.
 *
 * The set was written three times, identically, as `PROTO_KEYS` in `brain/delete-fields.ts` and `brain/merge.ts` and as
 * `UNSAFE_FILTER_KEYS` in `brain/filter-sanitizer.ts`. Identical today is the case a copy is most dangerous in: the one
 * that is extended next (a fourth key, a case-folding rule) leaves the others refusing less, and nothing says so.
 *
 * ## What is inside, so no caller can drop it
 *
 * The members. The set is not exported — a caller asks the question, it cannot hold (or `add` to, or forget a member of)
 * its own copy of the answer. What a caller does with a yes is the caller's: `delete-fields` refuses the path with a
 * message, `merge` skips the property and logs, `filter-sanitizer` refuses the filter with its own sentence.
 */
const OBJECT_INTERNAL_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** True when `key`, used as a plain-object key, would reach the object's internals instead of a data property. */
export function isObjectInternalKey(key: string): boolean {
  return OBJECT_INTERNAL_KEYS.has(key);
}

/**
 * True when `name` is one EVERY plain object already answers to — a key of `Object.prototype` (`toString`, `hasOwnProperty`,
 * `__proto__`, ...) or `prototype` — so a map read by name with `in` or `map[name]` would find it there whatever the map holds.
 *
 * A wider question than {@link isObjectInternalKey}: a rule's name (`spaces/schema-rules.ts`) is refused for it, because a rules map is
 * read by name. ASKED of the platform, never listed: a list is a second copy that misses the next name the platform adds. The editor
 * asks the same question in the same words (`client/src/app/shared/rule-limits.ts` `isReservedRuleName`), and
 * `client-limits-match-the-server.spec.ts` compares the two.
 */
export function isObjectPrototypeName(name: string): boolean {
  return name in Object.prototype || name === 'prototype';
}
