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
 * The write side has the same trap: `o[key] = v` for a key a caller chose (`__proto__`) sets the prototype instead of a key. Both
 * readers of a hostile source that build objects from its names (the meta parse, the from-typescript reader) wrote the same private
 * `defineProperty` for it.
 *
 * Three questions, all about one key of a plain object someone else named, asked here and nowhere else.
 */

/** Is `v` a plain object — not `null`, not an array — whose keys can be read as a map? */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `o[key]` when `o` is a plain object holding `key` as its OWN key; `undefined` otherwise — never a value inherited from a prototype. */
export function ownValue(o: unknown, key: string | undefined): unknown {
  return isPlainObject(o) && key !== undefined && Object.hasOwn(o, key) ? o[key] : undefined;
}

/** Sets `key` on `into` as an OWN data property, never by assignment, so no name (`__proto__` included) reaches the prototype. */
export function setOwn(into: object, key: string, value: unknown): void {
  Object.defineProperty(into, key, { value, enumerable: true, writable: true, configurable: true });
}
