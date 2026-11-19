/**
 * One encoder names every segment of an RDF address, and it encodes only what IRI syntax needs (Q-748, bundle-269 slice A).
 *
 * ## The defect this prevents
 *
 * A type name, a property name or a record id may hold any character (`schema/src/space-meta.ts`, `brain/write-connections.ts`). An
 * address built from one by hand either breaks (a space or a `>` in an IRI ends it, and a writer that meets one throws mid-export) or
 * injects (`a> <p> "x" . <b` writes extra triples). An encoder that encodes too much (`é`, `~`) gives an address no human reads, and
 * two encoders that disagree give two members two addresses for one term. So one function, `iriSegment` in the schema package:
 *
 * - every code point `isegment` (RFC 3987) disallows, and `/`, `?`, `#`, `%`, is percent-encoded as uppercase-hex UTF-8 (owner,
 *   2026-11-19; the sub-delims, `:` and `@` stay);
 * - a segment that is `.` or `..` is encoded (a resolver would otherwise collapse it);
 * - the empty segment is refused: it has no address;
 * - a lone surrogate is encoded as U+FFFD.
 *
 * The validators beside it: a base ends in `/` and holds no `#`; a namespace ends in `/` and holds no `#`; a prefix is a short name and not a
 * reserved one (the standard vocabularies and the URI schemes).
 *
 * Run: node --test testing/standalone/an-rdf-iri-is-encoded-only-where-syntax-needs-it.test.js (after `npm run build -w schema`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as schema from '../../schema/dist/index.js';

const fn = (name) => {
  assert.equal(typeof schema[name], 'function', `${name} is not exported by the schema package: the one encoder has no home`);
  return schema[name];
};
const zod = (name) => {
  assert.equal(typeof schema[name]?.safeParse, 'function', `${name} is not exported by the schema package`);
  return schema[name];
};

describe('iriSegment encodes only what IRI syntax needs', () => {
  const rows = [
    ['plain', 'person', 'person'],
    ['space', 'a b', 'a%20b'],
    ['slash', 'a/b', 'a%2Fb'],
    ['hash', 'a#b', 'a%23b'],
    ['percent', '100%', '100%25'],
    ['angle bracket', 'a>b', 'a%3Eb'],
    ['quote', 'a"b', 'a%22b'],
    ['an injection attempt', 'x> <p> "evil" . <y', 'x%3E%20%3Cp%3E%20%22evil%22%20.%20%3Cy'],
    ['dot inside a segment is kept', 'v1.2', 'v1.2'],
    ['tilde is kept', 'a~b', 'a~b'],
    ['underscore and hyphen are kept', 'a_b-c', 'a_b-c'],
    ['a letter outside ASCII is kept', 'café', 'café'],
    ['a colon is a path character and stays (owner, 2026-11-19: only what isegment disallows is encoded)', 'kind:Type', 'kind:Type'],
    ['a control character, in upper-case hex', '\u007f', '%7F'],
    ['a curly brace, in upper-case hex', '{', '%7B'],
    ['a segment that is one dot', '.', '%2E'],
    ['a segment that is two dots', '..', '%2E%2E'],
    ['a lone surrogate', 'a\uD800b', 'a%EF%BF%BDb'],
    ['a non-character outside ucschar is encoded', 'a￿b', 'a%EF%BF%BFb'],
  ];
  for (const [what, input, want] of rows) {
    it(`${what}: ${JSON.stringify(input)} -> ${want}`, () => assert.equal(fn('iriSegment')(input), want));
  }
  it('the empty segment has no address: it is refused, never written as some stand-in', () => {
    assert.throws(() => fn('iriSegment')(''), TypeError);
  });
  it('two calls on one input give one address (the same IRI on every member)', () => {
    const s = 'Über / Größe #1';
    assert.equal(fn('iriSegment')(s), fn('iriSegment')(s));
    assert.match(fn('iriSegment')(s), /^[^ /#]+$/);
  });
});

describe('the address validators', () => {
  it('a base ends in "/" and holds no "#"', () => {
    const BaseIriZ = zod('BaseIriZ');
    assert.ok(BaseIriZ.safeParse('https://example.org/ld/space/').success);
    assert.ok(!BaseIriZ.safeParse('https://example.org/ld/space').success, 'a base without a trailing "/" is refused');
    assert.ok(!BaseIriZ.safeParse('https://example.org/ld/space#').success, 'a base ending in "#" is refused');
    assert.ok(!BaseIriZ.safeParse('https://example.org/a#b/').success, 'a base holding "#" is refused');
    assert.ok(!BaseIriZ.safeParse('not an iri/').success, 'a base with no scheme is refused');
    assert.ok(!BaseIriZ.safeParse('https://example.org/a b/').success, 'a base with a space is refused');
  });
  it('a namespace ends in "/" and holds no "#" (a type is a document under it, its property a fragment)', () => {
    const NamespaceIriZ = zod('NamespaceIriZ');
    assert.ok(NamespaceIriZ.safeParse('https://example.org/vocab/').success);
    assert.ok(!NamespaceIriZ.safeParse('https://example.org/vocab#').success, 'a namespace ending in "#" would put a type in a fragment');
    assert.ok(!NamespaceIriZ.safeParse('https://example.org/vocab').success);
  });
  it('an IRI is absolute, has no character IRIREF forbids, and is bounded', () => {
    const IriZ = zod('IriZ');
    assert.ok(IriZ.safeParse('https://schema.org/Person').success);
    assert.ok(IriZ.safeParse('urn:isbn:0451450523').success);
    for (const bad of ['Person', 'https://x.org/a>b', 'https://x.org/a"b', 'https://x.org/{a}', `https://x.org/${'a'.repeat(2001)}`]) {
      assert.ok(!IriZ.safeParse(bad).success, `${JSON.stringify(bad.slice(0, 40))} is refused`);
    }
  });
  it('a prefix is a short name and never a reserved one', () => {
    const PrefixZ = zod('PrefixZ');
    assert.ok(PrefixZ.safeParse('acme').success);
    assert.ok(PrefixZ.safeParse('acme_v2-x').success);
    for (const bad of ['', '1acme', 'a b', 'a'.repeat(51)]) assert.ok(!PrefixZ.safeParse(bad).success, `${JSON.stringify(bad)} is refused`);
    const reserved = schema.RESERVED_PREFIXES;
    assert.ok(Array.isArray(reserved), 'RESERVED_PREFIXES is exported');
    for (const name of ['rdf', 'rdfs', 'owl', 'xsd', 'sh', 'schema', 'time', 'dcterms', 'prov', 'ythril', 'vocab', 'urn', 'http', 'https',
      'mailto', 'tag', 'did', 'file', 'data', 'entity', 'fact', 'chrono', 'edge']) {
      assert.ok(reserved.includes(name), `${name} is reserved`);
      assert.ok(!PrefixZ.safeParse(name).success, `the reserved prefix ${name} is refused`);
    }
  });
});
