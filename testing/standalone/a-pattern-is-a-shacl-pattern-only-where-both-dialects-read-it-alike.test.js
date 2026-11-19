/**
 * A stored pattern reaches the schema export as `sh:pattern` only where SHACL's regular expressions read it as the server does; its own text
 * always travels as `ythril:pattern`; OWL carries no pattern facet (Q-751, bundle-269 slice S; standards review row 7, decided by the parent).
 *
 * ## The defect this prevents
 *
 * The server checks `pattern` (and `namingPattern`) as an ECMAScript regular expression, unanchored, no flags
 * (`spaces/schema-validation.ts`). Slice C wrote it as-is into `sh:pattern` and into an OWL `xsd:pattern` facet. But `sh:pattern` is SPARQL
 * `REGEX`, the XPath dialect (XQuery 1.0 and XPath 2.0 Functions and Operators §7.6), and an XSD facet is implicitly anchored with `^` and `$`
 * as literal characters: `\d` matches every Unicode digit there and only ASCII ones here, `(?=...)`, `(?:...)`, named groups and back-references
 * do not exist there, and `[a-z-[aeiou]]` subtracts there and is a literal there. A consumer validating with such a shape refuses records the
 * server accepted, or accepts what it refused.
 *
 * So `patternReadsAlike(pattern)` (`server/src/rdf/portable-pattern.ts`, pure) says whether a pattern lies in the subset both dialects read
 * alike, and the table below holds it: anchors, `.`, classes and ranges, alternation, groups and the quantifiers pass; lookaround, named and
 * non-capturing groups, back-references, the class escapes `\d \w \s \b` and `\p{}`, class subtraction and anything the XPath grammar
 * refuses do not. A pattern that passes is `sh:pattern`; every pattern is `ythril:pattern` on its shape, the server's own text; the OWL range
 * has no `xsd:pattern` facet.
 *
 * Run: node --test testing/standalone/a-pattern-is-a-shacl-pattern-only-where-both-dialects-read-it-alike.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FP, META, iriOf, treeAt, termAt, shapeAt, L } from './_schema-export-fixture.mjs';

const portable = await import('../../server/dist/rdf/portable-pattern.js').catch(() => ({}));
const mod = await import('../../server/dist/rdf/schema-owl-shacl.js').catch(() => ({}));
const reads = (p) => {
  assert.equal(typeof portable.patternReadsAlike, 'function', 'patternReadsAlike is not exported by server/src/rdf/portable-pattern.ts');
  return portable.patternReadsAlike(p);
};

describe('the subset both dialects read alike', () => {
  const pass = [
    ['anchors and a class with a range', '^[A-Za-z ]+$'],
    ['a start anchor alone', '^A'],
    ['plain text', 'abc'],
    ['alternation', 'red|green'],
    ['a group with a quantifier', '(ab)+'],
    ['counted quantifiers', '^[0-9]{3}-[0-9]{4}$'],
    ['an open count and a lazy star', 'a{2,}b*?'],
    ['a negated class', '^[^@]+@[^@]+$'],
    ['the dot', '^.+$'],
    ['escaped metacharacters', '\\.\\$\\^\\(\\)\\[\\]\\{\\}\\|\\*\\+\\?\\\\'],
    ['an escaped dash inside a class, a dash first and last', '[a\\-z][-a][a-]'],
    ['a tab and a newline escape', 'a\\tb\\nc'],
  ];
  for (const [what, p] of pass) it(`passes: ${what} (${p})`, () => assert.equal(reads(p), true));
  const fail = [
    ['a lookahead', '(?=a)b'],
    ['a negative lookahead', '(?!a)b'],
    ['a lookbehind', '(?<=a)b'],
    ['a named group', '(?<year>[0-9]{4})'],
    ['a non-capturing group (not in XPath 2.0)', '(?:ab)+'],
    ['a back-reference', '(a)\\1'],
    ['a digit escape (Unicode digits in XPath)', '^\\d+$'],
    ['a word escape', '\\w+'],
    ['a space escape', '\\s'],
    ['a word boundary (none in XPath)', '\\bword'],
    ['a property escape (a literal p in ECMAScript without the u flag)', '\\p{L}'],
    ['a code unit escape', '\\u0041'],
    ['an escaped slash (no such escape in XPath)', 'a\\/b'],
    ['class subtraction', '[a-z-[aeiou]]'],
    ['a dash between two ranges', '[a-c-e]'],
    ['an empty class', '[]a'],
    ['a class of everything', '[^]'],
    ['a lone brace', 'a{'],
    ['a lone closing brace', 'a}'],
    ['a lone closing bracket', 'a]'],
    ['a character outside the Basic Multilingual Plane', 'x\u{1F600}+'],
    ['no ECMAScript pattern at all', '(a'],
  ];
  for (const [what, p] of fail) it(`fails: ${what} (${p})`, () => assert.equal(reads(p), false));
});

describe('the schema export writes a pattern by the subset', () => {
  const graph = (meta) => {
    assert.equal(typeof mod.schemaGraph, 'function', 'schemaGraph is not exported by server/src/rdf/schema-owl-shacl.ts');
    return mod.schemaGraph(meta, FP).quads;
  };
  const XSD_PATTERN = iriOf('xsd:pattern');
  const SH_PATTERN = iriOf('sh:pattern');
  const meta = { rdf: META.rdf, typeSchemas: { entity: { item: {
    namingPattern: '^\\w+$',
    propertySchemas: { sku: { type: 'string', pattern: '^[A-Z]{3}-[0-9]+$' }, isbn: { type: 'string', pattern: '^\\d{13}$' } },
  } } } };

  it('OWL carries no pattern facet, in the fixture space or here', () => {
    for (const quads of [graph(META), graph(meta)]) assert.ok(!quads.some(q => q.predicate.value === XSD_PATTERN), 'an xsd:pattern facet is written');
  });
  it('a pattern in the subset is sh:pattern (inside its guard) and ythril:pattern', () => {
    const quads = graph(meta);
    const shape = treeAt(quads, shapeAt('entity', 'item', 'sku'));
    assert.deepEqual(shape['ythril:pattern'], [L('^[A-Z]{3}-[0-9]+$')]);
    assert.ok(JSON.stringify(shape['sh:or']).includes('sh:pattern'), 'the guarded sh:pattern is written');
  });
  it('a pattern outside the subset is ythril:pattern alone: no sh:pattern that would read it otherwise', () => {
    const quads = graph(meta);
    const shape = treeAt(quads, shapeAt('entity', 'item', 'isbn'));
    assert.deepEqual(shape['ythril:pattern'], [L('^\\d{13}$')]);
    assert.ok(!JSON.stringify(shape).includes('sh:pattern'), 'no sh:pattern for a pattern SHACL reads otherwise');
    assert.equal(treeAt(quads, termAt('entity', 'item', 'isbn'))['rdfs:range']?.length, 1, 'the own property still has its range');
  });
  it('a naming pattern outside the subset is ythril:namingPattern alone, never an sh:pattern on the label', () => {
    const quads = graph(meta);
    assert.deepEqual(treeAt(quads, shapeAt('entity', 'item'))['ythril:namingPattern'], [L('^\\w+$')]);
    assert.ok(!quads.some(q => q.predicate.value === SH_PATTERN && q.object.value === '^\\w+$'), 'the naming pattern is no sh:pattern');
  });
});
