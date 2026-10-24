/**
 * One cache for every `Intl` object the client builds, and the outcome of a locale the platform rejected.
 *
 * Constructing an `Intl.DateTimeFormat`, `PluralRules` or `NumberFormat` is the expensive half of using it, and a table re-renders them on
 * every change-detection pass through an impure pipe. The cost was paid per call in two places before this: the date formatter kept its own
 * map, and the plural sentence built a `PluralRules` and a `NumberFormat` on every call. What a hand copy drops, and this does not: a
 * locale the platform rejects (an unknown tag from a browser setting) is tried ONCE, and its fallback is the cached answer - not a second
 * attempt, and a throw, on every render of every row.
 *
 * The caller owns the key (it names the kind, the locale and whatever else shapes the object) and says how to build the object and what
 * to answer when building throws. `fallback` may answer `null`: "no object, use the plain behaviour" is an outcome worth caching too.
 */
const cache = new Map<string, unknown>();

export function cachedIntl<T>(key: string, build: () => T, fallback: () => T): T {
  if (cache.has(key)) return cache.get(key) as T;
  let made: T;
  try { made = build(); } catch { made = fallback(); }
  cache.set(key, made);
  return made;
}
