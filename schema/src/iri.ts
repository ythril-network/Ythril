/**
 * Web addresses (IRIs) in a space schema: the validators of an address a caller writes, and the ONE encoder of a path segment (Q-748).
 *
 * ## What it prevents
 *
 * A type name, a property name and a record id may hold any character. An RDF address built from one by hand either breaks (a space or a
 * `>` ends an IRI, and a writer that meets one throws mid-export) or injects (`a> <p> "x" . <b` writes triples of its own). An encoder that
 * encodes too much (`é`, `~`) gives addresses nobody reads, and two encoders that disagree give two members two addresses for one term. So
 * {@link iriSegment} is the only encoder, and the server's resolver (`server/src/rdf/term-iri.ts`) is its only caller; a source gate
 * (`a-term-iri-is-one-rule-for-every-type-and-property.test.js`) refuses a second one.
 *
 * A leaf: it imports only zod.
 */
import { z } from 'zod';

/** The longest address a schema or a setting may carry: far above any real one, and a bound on what a caller can make the server store. */
export const IRI_MAX = 2000;

/** A character IRIREF forbids (RDF 1.1 Turtle §6.4): controls and space, and `<>"{}|^`\`. */
const IRIREF_FORBIDDEN = /[\u0000- <>"{}|^`\\]/;

/** An absolute IRI: a scheme, then anything IRIREF allows, bounded. */
export const IriZ = z.string().max(IRI_MAX).refine(
  s => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(s) && !IRIREF_FORBIDDEN.test(s),
  { message: 'an IRI is absolute (it starts with a scheme such as https:) and holds no space and none of < > " { } | ^ ` \\' },
);

/** A namespace: an IRI ending in `/` or `#`, so a name appended to it is a path segment or a fragment. */
export const NamespaceIriZ = IriZ.refine(s => s.endsWith('/') || s.endsWith('#'), { message: 'a namespace IRI ends in "/" or "#"' });

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
  'urn', 'http', 'https', 'mailto', 'tag', 'did', 'file', 'data',
]);

/** A prefix for a namespace: a letter, then letters, digits, `_` or `-`, at most 50 characters, and not a reserved one. */
export const PrefixZ = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,49}$/, 'a prefix is a letter, then letters, digits, "_" or "-", at most 50 characters')
  .refine(p => !RESERVED_PREFIXES.includes(p), { message: `a prefix may not be one of ${RESERVED_PREFIXES.join(', ')}` });

/** Is `cp` in RFC 3987 `iunreserved`: ALPHA / DIGIT / "-" / "." / "_" / "~" / ucschar? */
function isIunreserved(cp: number): boolean {
  if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0x30 && cp <= 0x39)) return true;
  if (cp === 0x2d || cp === 0x2e || cp === 0x5f || cp === 0x7e) return true;
  if ((cp >= 0xa0 && cp <= 0xd7ff) || (cp >= 0xf900 && cp <= 0xfdcf) || (cp >= 0xfdf0 && cp <= 0xffef)) return true;
  // ucschar above the BMP: each plane but its last two code points (U+xFFFE, U+xFFFF), up to plane 14.
  if (cp >= 0x10000 && cp <= 0xeffff) return (cp & 0xffff) <= 0xfffd;
  return false;
}

/** The replacement character's UTF-8, for a lone surrogate (which no UTF-8 encodes). */
const REPLACEMENT = '%EF%BF%BD';

/**
 * One path segment of an address, encoded only where IRI syntax needs it: every code point outside `iunreserved` becomes its UTF-8 bytes
 * in upper-case `%XX`; a segment that is `.` or `..` is encoded (a resolver would collapse it); the empty segment is `%00` (an untyped
 * entity's type segment, which must stay a segment); a lone surrogate is encoded as U+FFFD. A pure function: one input, one address, on
 * every member.
 */
export function iriSegment(s: string): string {
  if (s === '') return '%00';
  if (s === '.') return '%2E';
  if (s === '..') return '%2E%2E';
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    let cp = unit;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { cp = 0x10000 + ((unit - 0xd800) << 10) + (next - 0xdc00); i++; } else { out += REPLACEMENT; continue; }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) { out += REPLACEMENT; continue; }
    const ch = String.fromCodePoint(cp);
    if (isIunreserved(cp)) { out += ch; continue; }
    for (const byte of new TextEncoder().encode(ch)) out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}
