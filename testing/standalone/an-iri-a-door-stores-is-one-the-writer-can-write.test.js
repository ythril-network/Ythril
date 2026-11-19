/**
 * An address a door stores is an address the RDF writer can write: one rule for both (bundle-269 review, finding 1).
 *
 * ## The defect it prevents
 *
 * The schema validator `IriZ` accepted U+007F and an unpaired surrogate while the writer's own check refused both. A schema admin could
 * store `meta.rdf.vocab = "https://ex.org/v\u007f/"`; every export of the space then threw while building its prefixes, and the whole-stream
 * path left its export slot taken for good (two such requests filled the instance's two slots until a restart).
 *
 * ## What it holds
 *
 * One table of characters is fed to the validator (`IriZ`, schema package) and to the writer (Turtle and N-Quads, server): for every
 * character the two answer alike, and the forbidden ones (C0 controls, space, `<>"{}|^\``, backslash, U+007F, the C1 controls, an unpaired
 * surrogate) are refused by both, while letters outside ASCII, `~` and a paired surrogate pass both.
 *
 * Run: node --test testing/standalone/an-iri-a-door-stores-is-one-the-writer-can-write.test.js (after the schema and server builds)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { IriZ, BaseIriZ, NamespaceIriZ } = await import('../../schema/dist/index.js');
const { createRdfWriter } = await import('../../server/dist/rdf/serialize.js');

const TABLE = [
  ['\u0000', false], ['\u001f', false], [' ', false], ['<', false], ['>', false], ['"', false], ['{', false], ['|', false], ['^', false],
  ['`', false], ['\\', false], ['\u007f', false], ['\u0080', false], ['\u0085', false], ['\u009f', false], ['\uD800', false], ['\uDC00', false],
  [String.fromCharCode(0xa0), true], ['é', true], ['~', true], ['😀', true], ['%41', true],
];

/** Whether the writer writes `value` as an IRI, in `format`. */
function writerTakes(format, value) {
  const w = createRdfWriter(format);
  try {
    w.write({ quads: [{ subject: { kind: 'iri', value }, predicate: { kind: 'iri', value: 'https://ex.org/p' }, object: { kind: 'literal', value: 'x' } }] });
    return true;
  } catch (err) {
    if (err?.code !== 'rdf_unwritable') throw err;
    return false;
  }
}

describe('an IRI a door stores is one the writer can write', () => {
  for (const [ch, ok] of TABLE) {
    const label = `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}${ch.length > 1 && ch !== '%41' ? ' (pair)' : ''}`;
    it(`${label}: the validator and the writer answer alike, and ${ok ? 'take' : 'refuse'} it`, () => {
      const iri = `https://ex.org/a${ch}b/`;
      const stored = IriZ.safeParse(iri).success;
      assert.equal(stored, writerTakes('nquads', iri), `the validator says ${stored}, the N-Quads writer says otherwise`);
      assert.equal(stored, writerTakes('turtle', iri), `the validator says ${stored}, the Turtle writer says otherwise`);
      assert.equal(stored, ok);
      // What a peer offers (served rdfBases, a rebase round) is parsed by these two: the same rule, so a peer cannot plant such a base.
      assert.equal(BaseIriZ.safeParse(iri).success, ok, 'BaseIriZ, the parser of a peer\'s offered base');
      assert.equal(NamespaceIriZ.safeParse(iri).success, ok, 'NamespaceIriZ, the parser of a peer\'s offered vocab');
    });
  }
});
