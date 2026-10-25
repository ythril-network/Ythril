/**
 * The one text of a JSON-shaped value whatever order its keys were written in — and the content hash of that text.
 *
 * ## What it prevents
 *
 * Two copies of "sort the keys at every level, then serialise" lived in `brain/merkle.ts` (`canonicalize`, the space
 * hash two instances compare) and `spaces/library-ref-expansion.ts` (`canonical`, whether a type beside its `$ref` is the
 * library entry's definition), and bundle-23 was about to write a third for a content hash. They differed already: the
 * merkle copy built a sorted object and let `JSON.stringify` write it, the library copy wrote the text itself — so an
 * `undefined` value was a dropped key in one and the word `undefined` in the other. A hash written a third way would be a
 * third answer to "are these the same", and for the space hash a different answer is `MERKLE_DIVERGENCE` every cycle
 * between two instances on different builds, for data that is identical.
 *
 * ## What is inside, so no caller can drop it
 *
 * - **The bytes merkle has always hashed.** The text is `JSON.stringify` of a copy with keys sorted (UTF-16 order, the
 *   default `sort`) at every level, so every rule of `JSON.stringify` holds: a key whose value is `undefined`, a function
 *   or a symbol is left out, the same in an array is `null`, a non-finite number is `null`. A value with no own
 *   enumerable keys (a `Date`, a `Map`) is `{}`, because the copy is rebuilt key by key and `toJSON` is never reached.
 *   An integer-like key (`"2"`, `"10"`) is written first, in ascending numeric order, because that is how an object
 *   enumerates — deterministic, so equal values still give equal texts, but not plain lexicographic order.
 *   An own `__proto__` key is ASSIGNED into the copy and so falls out of the text — kept on purpose, because the space
 *   hash has always been computed that way and any change to the bytes is a divergence between builds.
 *   `canonical-json-is-made-once-and-keeps-the-merkle-bytes.test.js` compares this against the copy it replaced over a
 *   corpus.
 * - **No key is ever left out.** There used to be an `omitKeys` option that dropped keys at EVERY level, which the space hash
 *   used for its derived fields (`embedding`, `spaceId`, `syncBase`...). Those are fields of the RECORD, so a record's own `properties`
 *   (free-form, authored) that held a key spelled the same was invisible to the hash: two instances that differed there agreed they matched
 *   for ever. A caller that has a top-level field to leave out removes it from the TOP LEVEL before it asks for the text
 *   (`brain/merkle.ts` `withoutTopLevel`, `sync/authored-content.ts`), so a nested key is content whatever it is called (Q-624).
 * - **The hash** is `sha256Hex` (`util/sha256-hex.ts`) of the text as UTF-8, so a content hash is made one way.
 */
import { sha256Hex } from './sha256-hex.js';

function sortedCopy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(v => sortedCopy(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortedCopy((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * The canonical text of `value`: keys sorted at every level, serialised by `JSON.stringify`. `undefined` exactly when
 * `JSON.stringify` has no text for the value itself (`undefined`, a function).
 */
export function canonicalJson(value: unknown): string | undefined {
  return JSON.stringify(sortedCopy(value)) as string | undefined;
}

/** The lowercase hex SHA-256 of a document's canonical text — equal for two documents that differ only in key order. */
export function canonicalJsonHash(doc: object): string {
  return sha256Hex(canonicalJson(doc) as string);
}
