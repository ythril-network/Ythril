/**
 * The address of a SHACL shape the schema export writes (`<base>schema/shape/<kind>/<seg(type)>[#<frag(prop)>]`) reads back to the kind, the
 * type and the property it names (bundle-270, slice S8; `server/src/rdf/term-reverse.ts`, `shapeOfAddress`).
 *
 * ## The defect this prevents
 *
 * The schema reader decides what a shape is about from its address when the address is the space's own: a type whose class is an outside
 * address (`schema:Person`) has no other trace of its kind and its name than the shape's address, and an edge label's properties hang on
 * shapes that name no node shape at all. A reader that took the address apart by hand would read `shape/entity/a%2fb` and `shape/entity/a/b`
 * alike, or accept a spelling the export never writes. So the reverse is `shapeOfAddress(address, names)`, which answers only when the forward
 * rule (`shapeIri`) applied to what was decoded gives the very address back, exactly as the record and term reads of the same module do
 * (`every-address-the-export-writes-reads-back-to-its-record-and-term.test.js`).
 *
 * ## What it holds
 *
 * - **Every shape the export writes** (a node shape per type, a property shape per property, for each kind) reads back to its kind, type and
 *   property, under this space's base and under a source's base.
 * - **A spelling the export does not write** under the base is refused with a reason: another case of the kind, a slash, an escape the export
 *   does not write, an empty name, a part after the name, a kind that holds no shape (a file).
 * - **An address under no base** is foreign; an address under the base that is no shape address is foreign to this read.
 *
 * Run: node --test testing/standalone/a-shape-address-reads-back-to-its-type-and-property.test.js (after the server and schema builds)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { META, BASE, reverse, namesOf, exported, iriOf } from './_schema-from-rdf-doors.mjs';

const SOURCE = 'https://other.example.org/ld/space-9/';
const shapeOf = (address, names = namesOf()) => {
  assert.equal(typeof reverse.shapeOfAddress, 'function', 'shapeOfAddress is not exported by server/src/rdf/term-reverse.ts: a shape address cannot be read back');
  return reverse.shapeOfAddress(address, names);
};
const schemaPackage = await import('../../schema/dist/index.js');
const seg = schemaPackage.iriSegment;
const frag = schemaPackage.iriFragment;

describe('every shape the export writes', () => {
  const quads = exported(META);
  const shapes = [...new Set(quads.filter(q => q.subject.kind === 'iri' && q.subject.value.startsWith(`${BASE}schema/shape/`)).map(q => q.subject.value))];

  it('is found in the export (the fixture has node shapes and property shapes of every kind)', () => {
    assert.ok(shapes.some(a => a.includes('/entity/') && a.includes('#')));
    assert.ok(shapes.some(a => a.includes('/fact/')));
    assert.ok(shapes.some(a => a.includes('/chrono/')));
    assert.ok(shapes.some(a => a.includes('/edge/') && a.includes('#')));
    assert.ok(shapes.some(a => !a.includes('#')));
  });

  it('reads back to the kind, the type and the property it was written for', () => {
    const expected = [];
    for (const [kind, types] of Object.entries(META.typeSchemas)) {
      for (const [type, def] of Object.entries(types)) {
        expected.push({ address: `${BASE}schema/shape/${kind}/${seg(type)}`, kind, type });
        for (const prop of Object.keys(def.propertySchemas ?? {})) expected.push({ address: `${BASE}schema/shape/${kind}/${seg(type)}#${frag(prop)}`, kind, type, prop });
      }
    }
    for (const e of expected) {
      assert.ok(shapes.includes(e.address), `the export does not write ${e.address}`);
      const { address, ...want } = e;
      assert.deepEqual(shapeOf(address), { answer: 'shape', of: 'space', ...want });
    }
  });

  it('reads back under a source\'s base, as that source\'s', () => {
    const names = namesOf(META, { base: SOURCE });
    assert.deepEqual(shapeOf(`${SOURCE}schema/shape/edge/${seg('reports_to')}`, names), { answer: 'shape', of: 'source', kind: 'edge', type: 'reports_to' });
  });

  it('reads back a name that needs escaping and one that holds a slash, a hash and a space', () => {
    for (const type of ['a/b', 'a#b', 'a b', '100%', 'a?b']) {
      const read = shapeOf(`${BASE}schema/shape/entity/${seg(type)}#${frag(type)}`);
      assert.deepEqual(read, { answer: 'shape', of: 'space', kind: 'entity', type, prop: type });
    }
  });
});

describe('a shape address the export does not write', () => {
  const refused = (address) => {
    const read = shapeOf(address);
    assert.equal(read.answer, 'refused', `${address} was read as ${JSON.stringify(read)}`);
    assert.equal(read.of, 'space');
    assert.ok(!read.message.includes(address), 'the message repeats the address');
    return read.reason;
  };
  const S = `${BASE}schema/shape/`;

  for (const [why, address, reason] of [
    ['a kind the export writes no shape for', `${S}file/a`, 'unknown-kind'],
    ['a kind of another case', `${S}Entity/person`, 'unknown-kind'],
    ['no type', `${S}entity/`, 'empty-name'],
    ['no kind and no type', S, 'unknown-kind'],
    ['a slash in the type', `${S}entity/a/b`, 'trailing-part'],
    ['a query', `${S}entity/a?b`, 'trailing-part'],
    ['a second fragment', `${S}entity/a#b#c`, 'not-the-spelling-the-export-writes'],
    ['an empty fragment', `${S}entity/a#`, 'empty-name'],
    ['an escape the export does not write', `${S}entity/%65ntity`, 'not-the-spelling-the-export-writes'],
    ['a lower-case escape', `${S}entity/a%2fb`, 'not-the-spelling-the-export-writes'],
    ['an escape that is no UTF-8', `${S}entity/%FF`, 'bad-percent-encoding'],
    ['a character the export would escape', `${S}entity/a b`, 'not-the-spelling-the-export-writes'],
  ]) {
    it(`${why} is refused as ${reason}`, () => {
      assert.equal(refused(address), reason);
    });
  }

  it('an address under the base that names no shape is foreign to this read, and one under no base is foreign', () => {
    assert.deepEqual(shapeOf(`${BASE}entity/e1`), { answer: 'foreign' });
    assert.deepEqual(shapeOf(`${BASE}schema`), { answer: 'foreign' });
    assert.deepEqual(shapeOf('https://elsewhere.example.org/schema/shape/entity/a'), { answer: 'foreign' });
    assert.deepEqual(shapeOf(iriOf('rdfs:label')), { answer: 'foreign' });
  });

  it('of the bases an address lies under, the longest wins, as for records', () => {
    const names = namesOf(META, { base: `${BASE}a/` });
    assert.deepEqual(shapeOf(`${BASE}a/schema/shape/entity/x`, names), { answer: 'shape', of: 'source', kind: 'entity', type: 'x' });
  });
});
