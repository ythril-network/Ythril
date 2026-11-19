/**
 * A prefix an export declares is never a URI scheme, so no absolute address of the document can be read as a prefixed name (bundle-269
 * review, finding 7). JSON-LD reads `geo:52.5,13.4` as the prefixed name `geo` + `52.5,13.4` when `geo` is declared; the writer refused
 * such a document, so a space with an entity type `Geo` and any `geo:` address could not be exported as JSON-LD at all.
 *
 * ## What it holds
 *
 * - The prefixes of a space with a type `Geo`, a property mapped to a `geo:` address and a type `Http` hold neither `geo` nor `http`
 *   (the schemes the document's own addresses use, and the well-known schemes `WELL_KNOWN_SCHEMES` names).
 * - The JSON-LD writer writes a record using those addresses with those prefixes.
 *
 * Run: node --test testing/standalone/a-prefix-is-never-a-scheme-an-address-uses.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const termIri = await import('../../server/dist/rdf/term-iri.js');
const { createRdfWriter } = await import('../../server/dist/rdf/serialize.js');

const BASE = 'https://rdf.example.org/ld/geo-space/';
const META = {
  rdf: { enabled: true, base: BASE, vocab: `${BASE}vocab/` },
  typeSchemas: { entity: {
    Geo: { propertySchemas: { at: { type: 'string', iri: 'geo:13.4,52.5' } } },
    Http: { propertySchemas: { url: { type: 'string' } } },
    Info: { iri: 'info:lccn/2002022641' },
  } },
};

describe('a prefix is never a scheme an address uses', () => {
  it('neither the document\'s schemes nor the well-known ones are declared as prefixes', () => {
    const prefixes = termIri.prefixesFor(META);
    for (const scheme of ['geo', 'http', 'https', 'info']) assert.ok(!Object.hasOwn(prefixes, scheme), `${scheme} is declared: ${JSON.stringify(Object.keys(prefixes))}`);
    assert.ok(Object.values(prefixes).includes(`${BASE}vocab/entity/Http#`), 'the Http type still has a prefix of its own, under another name');
  });

  it('the JSON-LD writer writes the addresses with those prefixes', () => {
    const w = createRdfWriter('jsonld', { prefixes: termIri.prefixesFor(META) });
    const s = { kind: 'iri', value: `${BASE}entity/e1` };
    assert.doesNotThrow(() => w.write({ quads: [
      { subject: s, predicate: { kind: 'iri', value: 'geo:13.4,52.5' }, object: { kind: 'literal', value: 'x' } },
      { subject: s, predicate: { kind: 'iri', value: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' }, object: { kind: 'iri', value: 'info:lccn/2002022641' } },
    ] }));
  });
});
