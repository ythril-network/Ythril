/**
 * Reading a value someone else shaped — a caller's body, a peer's meta, a stored document — as a plain object, and one key of it.
 *
 * ## What it prevents
 *
 * `!!v && typeof v === 'object' && !Array.isArray(v)` was written as a private `isObj` in module after module (four of them in one
 * bundle), and "the value at this key, if it is the object's OWN key" beside several of them. Each copy is one line, and each is the line a
 * reader skims: `typeof null === 'object'` and an array being an object are the two halves a copy drops, and reading `o[key]` for a
 * key a caller or a peer chose reads `toString` off the prototype when the object has no such key — a property that is "there"
 * because every object has it.
 *
 * Two questions, both about one plain object, asked here and nowhere else.
 */

/** Is `v` a plain object — not `null`, not an array — whose keys can be read as a map? */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `o[key]` when `o` is a plain object holding `key` as its OWN key; `undefined` otherwise — never a value inherited from a prototype. */
export function ownValue(o: unknown, key: string | undefined): unknown {
  return isPlainObject(o) && key !== undefined && Object.hasOwn(o, key) ? o[key] : undefined;
}
