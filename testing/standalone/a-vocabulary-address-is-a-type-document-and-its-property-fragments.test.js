/**
 * A space vocabulary names a type as a document and each of its properties as a fragment of it: the W3C Direct Mapping's shape (Q-748,
 * bundle-269 slice S; owner, 2026-11-19, standards review row 4).
 *
 * ## The defect this prevents
 *
 * Slice A named a property `<vocab><kind>/<type>/<prop>`, a slash under its type. The owner asked for the most universal shape: the Direct
 * Mapping (table `<base>People`, column `<base>People#fname`; CSV on the Web does the same). So a type is `<vocab><kind>/<seg(type)>` and its
 * property `<vocab><kind>/<seg(type)>#<frag(prop)>`; an edge label and its properties alike; a library group's namespace names a type
 * `<ns><seg(type)>` and its property `<ns><seg(type)>#<frag(prop)>`; a shape `<base>schema/shape/<kind>/<seg(type)>[#<frag(prop)>]`.
 * A shape changed after the first export left an instance cannot be changed again, so the encoders are held to the owner's exact rule:
 *
 * - **path segment** (a type or a label): percent-encode, UTF-8, uppercase hex, every character the IRI path-segment syntax (`isegment`,
 *   RFC 3987) disallows, plus `/`, `?`, `#`, `%`; a segment that is exactly `.` or `..` becomes `%2E` / `%2E%2E`;
 * - **fragment** (a property): encode `#`, `%`, spaces, control characters and whatever `ifragment` disallows;
 * - no unreserved character is ever encoded, so every address is already normalised; an empty name is refused (it throws).
 *
 * A namespace or a vocab that holds a `#` would put a type inside a fragment, and its property after a second `#` is no IRI: such a
 * namespace is refused (`NamespaceIriZ`: ends in `/`, holds no `#`).
 *
 * Run: node --test testing/standalone/a-vocabulary-address-is-a-type-document-and-its-property-fragments.test.js (after both builds)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Parser } from 'n3';
import * as schema from '../../schema/dist/index.js';

const termIri = await import('../../server/dist/rdf/term-iri.js').catch(() => ({}));
const fn = (mod, name, where) => {
  assert.equal(typeof mod[name], 'function', `${name} is not exported by ${where}`);
  return mod[name];
};
const seg = (s) => fn(schema, 'iriSegment', 'the schema package')(s);
const frag = (s) => fn(schema, 'iriFragment', 'the schema package (the fragment encoder beside iriSegment)')(s);
const term = (...a) => fn(termIri, 'resolveTermIri', 'server/src/rdf/term-iri.ts')(...a);

const BASE = 'https://ythril.example.org/ld/space-1/';
const VOCAB = `${BASE}vocab/`;
const rdfOn = (typeSchemas) => ({ rdf: { enabled: true, base: BASE, vocab: VOCAB, baseEpoch: 0 }, typeSchemas });

describe('the two encoders follow the owner\'s rule exactly', () => {
  const segmentRows = [
    ['plain', 'Person', 'Person'],
    ['a dot inside a segment stays', 'a.b', 'a.b'],
    ['a slash is encoded', 'a/b', 'a%2Fb'],
    ['a question mark is encoded', 'a?b', 'a%3Fb'],
    ['a hash is encoded', 'a#b', 'a%23b'],
    ['a percent is encoded', '100%', '100%25'],
    ['a space is encoded', 'a b', 'a%20b'],
    ['a segment that is one dot', '.', '%2E'],
    ['a segment that is two dots', '..', '%2E%2E'],
    ['three dots are a name, not a step', '...', '...'],
    ['a letter outside ASCII stays', 'café', 'café'],
    ['tilde, underscore and hyphen stay', 'a~b_c-d', 'a~b_c-d'],
    ['a colon and an at sign are path characters and stay', 'kind:Type@x', 'kind:Type@x'],
    ['the sub-delims are path characters and stay', "a!$&'()*+,;=b", "a!$&'()*+,;=b"],
    ['what isegment disallows is encoded', 'a<>"{}|^`\\[]b', 'a%3C%3E%22%7B%7D%7C%5E%60%5C%5B%5Db'],
    ['a control character, uppercase hex', 'a\u007fb', 'a%7Fb'],
  ];
  for (const [what, input, want] of segmentRows) it(`segment, ${what}: ${JSON.stringify(input)} -> ${want}`, () => assert.equal(seg(input), want));

  const fragmentRows = [
    ['plain', 'name', 'name'],
    ['a dot stays', 'b.c', 'b.c'],
    ['a hash is encoded', 'a#b', 'a%23b'],
    ['a percent is encoded', '5%', '5%25'],
    ['a space is encoded', 'nick name', 'nick%20name'],
    ['a control character is encoded', 'a\nb', 'a%0Ab'],
    ['a slash and a question mark are fragment characters and stay', 'a/b?c', 'a/b?c'],
    ['one dot and two dots are names in a fragment', '..', '..'],
    ['a letter outside ASCII stays', 'größe', 'größe'],
    ['what ifragment disallows is encoded', 'a<>"{}|^`\\[]b', 'a%3C%3E%22%7B%7D%7C%5E%60%5C%5B%5Db'],
  ];
  for (const [what, input, want] of fragmentRows) it(`fragment, ${what}: ${JSON.stringify(input)} -> ${want}`, () => assert.equal(frag(input), want));

  it('an empty name is refused by both encoders', () => {
    assert.throws(() => seg(''), 'an empty type name has no address');
    assert.throws(() => frag(''), 'an empty property key has no address');
  });
  it('no unreserved character is ever encoded', () => {
    const unreserved = 'ABCXYZabcxyz0189-._~';
    assert.equal(seg(unreserved), unreserved);
    assert.equal(frag(unreserved), unreserved);
  });
});

describe('the addresses take the Direct Mapping shape', () => {
  const META = rdfOn({
    entity: { Person: { propertySchemas: { name: { type: 'string' }, 'nick name': { type: 'string' } } } },
    edge: { worksAt: { propertySchemas: { since: { type: 'date' } } } },
  });
  it('a type is a document under its kind, its property a fragment of it; an edge label alike', () => {
    assert.equal(term(META, 'entity', 'Person'), `${VOCAB}entity/Person`);
    assert.equal(term(META, 'entity', 'Person', 'name'), `${VOCAB}entity/Person#name`);
    assert.equal(term(META, 'entity', 'Person', 'nick name'), `${VOCAB}entity/Person#nick%20name`);
    assert.equal(term(META, 'edge', 'worksAt'), `${VOCAB}edge/worksAt`);
    assert.equal(term(META, 'edge', 'worksAt', 'since'), `${VOCAB}edge/worksAt#since`);
  });
  it('a property of an untyped record, and of a file, is a fragment of its kind\'s document', () => {
    assert.equal(term(META, 'entity', null, 'colour'), `${VOCAB}entity#colour`);
    assert.equal(term(META, 'file', null, 'camera model'), `${VOCAB}file#camera%20model`);
  });
  it('a library group\'s namespace names a type <ns><seg(type)> and its property <ns><seg(type)>#<frag(prop)>', () => {
    const lib = fn(termIri, 'libraryTermIri', 'server/src/rdf/term-iri.ts');
    assert.equal(lib('https://acme.example/ns/', 'Person'), 'https://acme.example/ns/Person');
    assert.equal(lib('https://acme.example/ns/', 'Person', 'nick name'), 'https://acme.example/ns/Person#nick%20name');
  });
  it('a shape follows the same pattern, from the resolver itself (shapeIri)', () => {
    const shape = fn(termIri, 'shapeIri', 'server/src/rdf/term-iri.ts');
    assert.equal(shape(META, 'entity', 'Person'), `${BASE}schema/shape/entity/Person`);
    assert.equal(shape(META, 'entity', 'Person', 'nick name'), `${BASE}schema/shape/entity/Person#nick%20name`);
    assert.equal(shape(META, 'edge', 'a/b', 'x#y'), `${BASE}schema/shape/edge/a%2Fb#x%23y`);
  });
  it('a namespace or a vocab that holds a "#" is refused: a type would sit in a fragment and its property after a second "#"', () => {
    const NamespaceIriZ = schema.NamespaceIriZ;
    assert.ok(NamespaceIriZ.safeParse('https://acme.example/ns/').success);
    assert.ok(!NamespaceIriZ.safeParse('https://acme.example/ns#').success, 'a namespace ending in "#" is refused');
    assert.ok(!NamespaceIriZ.safeParse('https://acme.example/a#b/').success, 'a namespace holding "#" is refused');
  });
});

describe('the collision pairs give distinct addresses, each a valid IRI that round-trips through n3 as a prefixed name', () => {
  const NAMES = ['a', 'b', 'a.b', 'a/b', 'a#b', '.', '..', 'a b', 'café', 'b.c', 'b#c', 'x/y'];
  const typeSchemas = { entity: {}, edge: {} };
  for (const kind of ['entity', 'edge']) for (const t of NAMES) typeSchemas[kind][t] = { propertySchemas: Object.fromEntries(NAMES.map(p => [p, { type: 'string' }])) };
  const META = rdfOn(typeSchemas);
  const owners = [];
  for (const kind of ['entity', 'edge']) {
    for (const t of NAMES) {
      owners.push({ kind, type: t });
      for (const p of NAMES) owners.push({ kind, type: t, prop: p });
    }
    for (const p of NAMES) owners.push({ kind, type: null, prop: p });
  }
  for (const p of NAMES) owners.push({ kind: 'file', type: null, prop: p });
  const addressOf = (o) => (o.prop === undefined ? term(META, o.kind, o.type) : term(META, o.kind, o.type, o.prop));

  it('the named pairs differ: a.b against a + b, a/b against a + b, a#b, ., .., a space, a letter outside ASCII', () => {
    assert.notEqual(term(META, 'entity', 'a.b'), term(META, 'entity', 'a', 'b'));
    assert.notEqual(term(META, 'entity', 'a/b'), term(META, 'entity', 'a', 'b'));
    assert.notEqual(term(META, 'entity', 'a#b'), term(META, 'entity', 'a', 'b'));
    assert.notEqual(term(META, 'entity', 'a', 'b.c'), term(META, 'entity', 'a.b', 'c'));
    assert.notEqual(term(META, 'entity', 'a', 'b#c'), term(META, 'entity', 'a#b', 'c'));
    assert.notEqual(term(META, 'entity', '.'), `${VOCAB}entity`);
    assert.notEqual(term(META, 'entity', '..'), VOCAB);
  });
  it(`every one of the ${owners.length} types and properties has its own address`, () => {
    const seen = new Map();
    for (const o of owners) {
      const address = addressOf(o);
      assert.equal(seen.get(address), undefined, `${JSON.stringify(o)} and ${JSON.stringify(seen.get(address))} share ${address}`);
      seen.set(address, o);
    }
  });
  it('each address is an absolute IRI the schema package accepts, with at most one "#"', () => {
    for (const o of owners) {
      const address = addressOf(o);
      assert.ok(schema.IriZ.safeParse(address).success, `${address} is no valid IRI`);
      assert.ok(address.split('#').length <= 2, `${address} holds two "#"`);
    }
  });

  /** A local name as Turtle writes it: every PN_LOCAL_ESC character but `%` (which only ever starts a `%XX` here) gets a backslash. */
  const pnLocal = (s) => s.replace(/[_~.\-!$&'()*+,;=/?#@]/g, c => `\\${c}`);
  it('each type round-trips as entity:<local> from a prefix ending "entity/", each property as <type>:<local> from a prefix ending "<Type>#"', () => {
    const prefixes = fn(termIri, 'prefixesFor', 'server/src/rdf/term-iri.ts')(META);
    const nsOf = Object.fromEntries(Object.entries(prefixes).map(([name, ns]) => [ns, name]));
    const lines = [];
    const want = [];
    for (const o of owners.filter(x => x.type !== null)) {
      const address = addressOf(o);
      const cut = o.prop === undefined ? address.lastIndexOf('/') + 1 : address.indexOf('#') + 1;
      const name = nsOf[address.slice(0, cut)];
      assert.ok(name !== undefined, `prefixesFor declares no prefix for ${address.slice(0, cut)} (where ${address} is written)`);
      lines.push(`<urn:x:s> <urn:x:p> ${name}:${pnLocal(address.slice(cut))} .`);
      want.push(address);
    }
    const text = `${Object.entries(prefixes).map(([n, ns]) => `@prefix ${n}: <${ns}> .`).join('\n')}\n${lines.join('\n')}\n`;
    const back = new Parser({ format: 'Turtle' }).parse(text).map(q => q.object.value);
    assert.deepEqual(back, want);
  });
  it('the prefix names are the type\'s name, deterministic and collision-free, never a standard or reserved one', () => {
    const p = fn(termIri, 'prefixesFor', 'server/src/rdf/term-iri.ts');
    const m = rdfOn({ entity: { Person: { propertySchemas: { name: { type: 'string' } } } }, edge: { person: { propertySchemas: { since: { type: 'date' } } } } });
    const a = p(m);
    assert.equal(a.entity, `${VOCAB}entity/`);
    assert.equal(a.edge, `${VOCAB}edge/`);
    assert.equal(a.person, `${VOCAB}entity/Person#`, 'person:name from a prefix ending Person#');
    const names = Object.keys(a);
    assert.equal(new Set(Object.values(a)).size, names.length, 'one namespace, one prefix');
    assert.ok(Object.values(a).includes(`${VOCAB}edge/person#`), 'the second "person" gets a prefix of its own');
    for (const name of names) {
      assert.match(name, /^[A-Za-z][A-Za-z0-9_-]*$/, `${name} is a prefix name a writer and a parser accept`);
      assert.ok(name.length <= 50, `${name} is no longer than the 50 characters PrefixZ allows`);
    }
    const reordered = rdfOn({ edge: m.typeSchemas.edge, entity: m.typeSchemas.entity });
    assert.deepEqual(p(reordered), a, 'two members holding one schema in another key order declare the same prefixes');
  });
  it('two members derive the same addresses: the same schema in another key order names every term alike', () => {
    const reversed = { entity: {}, edge: {} };
    for (const kind of ['edge', 'entity']) for (const t of [...NAMES].reverse()) reversed[kind][t] = typeSchemas[kind][t];
    const other = rdfOn(reversed);
    for (const o of owners) assert.equal(o.prop === undefined ? term(other, o.kind, o.type) : term(other, o.kind, o.type, o.prop), addressOf(o));
  });
});
