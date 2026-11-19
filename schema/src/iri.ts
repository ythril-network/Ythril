/**
 * Web addresses (IRIs) in a space schema: the validators of an address a caller writes, and the ONE encoder of a path segment and the ONE
 * encoder of a fragment (Q-748; the Direct Mapping shape, owner 2026-11-19).
 *
 * ## What it prevents
 *
 * A type name, a property name and a record id may hold any character. An RDF address built from one by hand either breaks (a space or a
 * `>` ends an IRI, and a writer that meets one throws mid-export) or injects (`a> <p> "x" . <b` writes triples of its own). An encoder that
 * encodes too much (`é`, `~`) gives addresses nobody reads, and two encoders that disagree give two members two addresses for one term. So
 * {@link iriSegment} (a type, a label, a record id) and {@link iriFragment} (a property, after its type's `#`) are the only encoders, and
 * the server's resolver (`server/src/rdf/term-iri.ts`) is their only caller; a source gate
 * (`a-term-iri-is-one-rule-for-every-type-and-property.test.js`) refuses a second one.
 *
 * A leaf: it imports only zod.
 */
import { z } from 'zod';

/** The longest address a schema or a setting may carry: far above any real one, and a bound on what a caller can make the server store. */
export const IRI_MAX = 2000;

/** The highest `baseEpoch` a setting or a rebase round may carry: far above any number of deliberate base changes, and a bound on a peer's value. */
export const RDF_BASE_EPOCH_MAX = 1_000_000;

/** A character IRIREF forbids (RDF 1.1 Turtle §6.4): controls and space, and `<>"{}|^`\`. */
const IRIREF_FORBIDDEN = /[\u0000- <>"{}|^`\\]/;

/** An absolute IRI: a scheme, then anything IRIREF allows, bounded. */
export const IriZ = z.string().max(IRI_MAX).refine(
  s => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(s) && !IRIREF_FORBIDDEN.test(s),
  { message: 'an IRI is absolute (it starts with a scheme such as https:) and holds no space and none of < > " { } | ^ ` \\' },
);

/**
 * A namespace (a space's `vocab`, a library group's namespace): an IRI ending in `/` and holding no `#`. A type is a document under it
 * (`<ns><type>`) and its property a fragment of that document (`<ns><type>#<prop>`, the W3C Direct Mapping's shape); a namespace holding
 * a `#` would put the type inside a fragment, and the property after a second `#` is no IRI.
 */
export const NamespaceIriZ = IriZ.refine(s => s.endsWith('/') && !s.includes('#'), { message: 'a namespace IRI ends in "/" and holds no "#"' });

/**
 * A space's base: an IRI ending in `/` and holding no `#`. Every record address is `<base><kind>/<id>`, so a base ending in `#` would put
 * every record in one document's fragments, and a `#` inside it would cut every address there.
 */
export const BaseIriZ = IriZ.refine(s => s.endsWith('/') && !s.includes('#'), { message: 'a base IRI ends in "/" and holds no "#"' });

/**
 * The prefixes no library group may take: the standard vocabularies an export declares, the space's own `vocab`, and the URI schemes a
 * prefixed name could be mistaken for (`urn:x` written as a prefixed name would be read as the scheme).
 */
export const RESERVED_PREFIXES: readonly string[] = Object.freeze([
  'rdf', 'rdfs', 'owl', 'xsd', 'sh', 'schema', 'time', 'dcterms', 'prov', 'ythril', 'vocab',
  // The prefixes an export declares for the space vocab's kind documents (`<vocab>entity/`, ...).
  'entity', 'fact', 'chrono', 'edge',
  'urn', 'http', 'https', 'mailto', 'tag', 'did', 'file', 'data',
]);

/** A prefix for a namespace: a letter, then letters, digits, `_` or `-`, at most 50 characters, and not a reserved one. */
export const PrefixZ = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,49}$/, 'a prefix is a letter, then letters, digits, "_" or "-", at most 50 characters')
  .refine(p => !RESERVED_PREFIXES.includes(p), { message: `a prefix may not be one of ${RESERVED_PREFIXES.join(', ')}` });

/** RFC 3987 `iunreserved` in ASCII: ALPHA / DIGIT / "-" / "." / "_" / "~". */
const ASCII_UNRESERVED = /^[A-Za-z0-9._~-]$/;
/** What `isegment` allows beside `iunreserved` (RFC 3987 `ipchar`): the sub-delims, `:` and `@`. Never `/`, `?`, `#` or a bare `%`. */
const SEGMENT_KEPT = /^[!$&'()*+,;=:@]$/;
/** What `ifragment` allows beside `iunreserved`: `ipchar`'s sub-delims, `:` and `@`, plus `/` and `?`. Never `#` or a bare `%`. */
const FRAGMENT_KEPT = /^[!$&'()*+,;=:@/?]$/;
/** The `ucschar` ranges inside the Basic Multilingual Plane (RFC 3987 §2.2). */
const BMP_UCSCHAR: readonly (readonly [number, number])[] = [[0xa0, 0xd7ff], [0xf900, 0xfdcf], [0xfdf0, 0xffef]];
/** `ucschar` above the BMP: planes 1 to 14, each but its last two code points (U+xFFFE, U+xFFFF). */
const ASTRAL_FIRST = 0x10000;
const ASTRAL_LAST = 0xeffff;
const PLANE_MASK = 0xffff;
const PLANE_LAST_UCSCHAR = 0xfffd;
/** A surrogate code point on its own: what iterating a string by code point yields for an unpaired half. */
const LONE_SURROGATE = /^[\u{D800}-\u{DFFF}]$/u;
/** `%XX`: a byte in upper-case hex, two digits. */
const HEX_RADIX = 16;
const HEX_BYTE_WIDTH = 2;

/** Is the code point `cp` (the character `ch`) in RFC 3987 `iunreserved`? */
function isIunreserved(ch: string, cp: number): boolean {
  if (ASCII_UNRESERVED.test(ch)) return true;
  if (BMP_UCSCHAR.some(([lo, hi]) => cp >= lo && cp <= hi)) return true;
  return cp >= ASTRAL_FIRST && cp <= ASTRAL_LAST && (cp & PLANE_MASK) <= PLANE_LAST_UCSCHAR;
}

/** The replacement character's UTF-8, for a lone surrogate (which no UTF-8 encodes). */
const REPLACEMENT = '%EF%BF%BD';

/** `s` with every code point that is neither `iunreserved` nor `kept` written as its UTF-8 bytes in upper-case `%XX`; an empty `s` throws. */
function encodeOutside(s: string, kept: RegExp, what: string): string {
  if (s === '') throw new TypeError(`an empty ${what} has no address`);
  let out = '';
  for (const ch of s) {
    if (LONE_SURROGATE.test(ch)) { out += REPLACEMENT; continue; }
    if (isIunreserved(ch, ch.codePointAt(0)!) || kept.test(ch)) { out += ch; continue; }
    for (const byte of new TextEncoder().encode(ch)) out += `%${byte.toString(HEX_RADIX).toUpperCase().padStart(HEX_BYTE_WIDTH, '0')}`;
  }
  return out;
}

/**
 * One path segment of an address (a type, an edge label, a record id), encoded only where IRI syntax needs it (owner, 2026-11-19): every
 * character `isegment` disallows, and `/`, `?`, `#`, `%`, becomes its UTF-8 bytes in upper-case `%XX`; a segment that is exactly `.` or `..`
 * is `%2E` / `%2E%2E` (a resolver would collapse it); a lone surrogate is encoded as U+FFFD; no unreserved character is ever encoded, so
 * the address is already normalised. An empty name throws: it has no address. A pure function: one input, one address, on every member.
 */
export function iriSegment(s: string): string {
  if (s === '.') return '%2E';
  if (s === '..') return '%2E%2E';
  return encodeOutside(s, SEGMENT_KEPT, 'name');
}

/**
 * One fragment of an address (a property, after its type's `#`), encoded only where IRI syntax needs it (owner, 2026-11-19): `#`, `%`,
 * spaces, control characters and every other character `ifragment` disallows become UTF-8 `%XX`; `/`, `?` and dots stay (a fragment is no
 * path). An empty key throws: it has no address.
 */
export function iriFragment(s: string): string {
  return encodeOutside(s, FRAGMENT_KEPT, 'key');
}
