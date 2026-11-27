/**
 * Q-942: what a saved RDF export says at its end, read from the document (a browser's fetch never hands a page the trailers): the record
 * count, whether it is whole, and the values left out, in the shapes the server writes (`rdf/export-act.ts`, `rdf/serialize.ts`).
 */
import { describe, it, expect } from 'vitest';
import { rdfExportEnding } from './rdf-export-ending';

const TURTLE = [
  '@prefix ythril: <https://ythril.dev/ns#> .',
  '<https://w3id.org/acme/platform/entity/svc-billing> a ythril:Entity .',
  '# ythril-export: 131442 records; complete, nothing is left; 3 property values left out: svc-billing (owners: not a plain value), f-2291 (observedAt: does not fit its declared type), c-118 (budget: does not fit its declared type); shapes: <https://w3id.org/acme/platform/schema/3f2a>',
  '',
].join('\n');

describe('rdfExportEnding', () => {
  it('reads the closing comment of Turtle, TriG and N-Quads: records, complete, the values left out with their reasons', () => {
    for (const format of ['turtle', 'trig', 'nquads'] as const) {
      const e = rdfExportEnding(TURTLE, format)!;
      expect(e.complete).toBe(true);
      expect(e.records).toBe(131442);
      expect(e.leftOutCount).toBe(3);
      expect(e.leftOut).toEqual([
        { record: 'svc-billing', key: 'owners', reason: 'notPlain', reasonText: 'not a plain value' },
        { record: 'f-2291', key: 'observedAt', reason: 'notFit', reasonText: 'does not fit its declared type' },
        { record: 'c-118', key: 'budget', reason: 'notFit', reasonText: 'does not fit its declared type' },
      ]);
    }
  });

  it('counts more values than it names ("and N more")', () => {
    const text = '# ythril-export: 10 records; complete, nothing is left; 2344 property values left out: a (k: not a plain value), and 2343 more\n';
    const e = rdfExportEnding(text, 'turtle')!;
    expect(e.leftOutCount).toBe(2344);
    expect(e.leftOut).toHaveLength(1);
  });

  it('an export that could not finish, or one cut before its ending, is never a result', () => {
    expect(rdfExportEnding('# ythril-export: 5 records; INCOMPLETE, the export could not finish: store; 0 property values left out\n!ythril-export-incomplete\n', 'turtle')?.complete).toBe(false);
    expect(rdfExportEnding('<a> <b> <c> .\n', 'nquads')).toBeNull();
    expect(rdfExportEnding(`${TURTLE}<a> <b> <c> .\n`, 'turtle')).toBeNull();
  });

  it('reads the report node of a JSON-LD document, its last @graph item on one line', () => {
    const report = {
      '@id': 'urn:ythril:export-report:9c1e',
      '@graph': [
        { '@id': 'urn:ythril:export-report:9c1e', 'ythril:complete': { '@value': 'true', '@type': 'xsd:boolean' }, 'ythril:recordCount': { '@value': '42', '@type': 'xsd:integer' },
          'ythril:leftOutCount': { '@value': '1', '@type': 'xsd:integer' }, 'ythril:leftOutValue': [{ '@id': '_:b0' }] },
        { '@id': '_:b0', 'ythril:leftOutRecord': { '@id': 'https://w3id.org/acme/platform/entity/svc-billing' }, 'ythril:leftOutKey': 'owners', 'ythril:leftOutReason': 'not a plain value' },
      ],
    };
    const doc = `{\n  "@context": {},\n  "@graph": [\n    {"@id":"x"},\n    ${JSON.stringify(report)}\n  ]\n}\n`;
    const e = rdfExportEnding(doc, 'jsonld')!;
    expect(e).toEqual({ complete: true, records: 42, leftOutCount: 1, leftOut: [{ record: 'https://w3id.org/acme/platform/entity/svc-billing', key: 'owners', reason: 'notPlain', reasonText: 'not a plain value' }] });
    expect(rdfExportEnding(doc.slice(0, -4), 'jsonld')).toBeNull();
  });

  it('reads the endings the real server writer wrote (captured from a scratch instance at 3e9c7b590, bundle-358 drive)', () => {
    // The last lines of GET /api/brain/spaces/rdf-on/export/rdf in Turtle and in TriG, byte for byte. The full guard, over every format and a
    // view, runs the real writer: `testing/standalone/the-client-reads-the-ending-of-every-rdf-export-the-server-writes-db.test.js`.
    const shapes = '<http://b358-app:3361/ld/rdf-on/schema/49bea0b1b287256c8bf200fb74fabfa5505e43634da1aba9ec7e44717c868186>';
    const turtle = `prov:wasAttributedTo <http://b358-app:3361/ld/rdf-on/agent/915a> .\n\n# ythril-export: 303 records; complete, nothing is left; 0 property values left out; shapes: ${shapes}\n`;
    expect(rdfExportEnding(turtle, 'turtle')).toEqual({ complete: true, records: 303, leftOutCount: 0, leftOut: [] });
    const trig = [
      '<urn:ythril:export-report:0b9b7cc6>', '    a ythril:ExportReport ;', '    dcterms:hasPart <http://b358-app:3361/ld/rdf-on/> ;',
      '    ythril:complete "true"^^xsd:boolean ;', '    ythril:leftOutCount "0"^^xsd:integer ;', '    ythril:recordCount "303"^^xsd:integer .', '', '}',
      `# ythril-export: 303 records; complete, nothing is left; 0 property values left out; shapes: ${shapes}`, '',
    ].join('\n');
    expect(rdfExportEnding(trig, 'trig')).toEqual({ complete: true, records: 303, leftOutCount: 0, leftOut: [] });
  });
});
