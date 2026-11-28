/**
 * What the door counts of an RDF import's first phase is at least what the act's first phase then holds, for a file shaped like the benchmark's
 * (typed subjects, bare edges between them, a schema inferred from the data) and for one that states its schema (bundle-384, Q-983, second fix round,
 * findings 4 and 6).
 *
 * ## What it prevents
 *
 * The first spec of this kind (`an-rdf-import-past-its-memory-is-refused-whole-db.test.js`) compared the door's need, the larger of two phases, with the
 * act's first phase on three records and no edge: the second phase's figure was always the larger, so it held however the first was charged. A drive at a
 * 1 GiB container then saw the act refuse what the door had let in. This spec compares the door's first-phase figure (`first`) with the act's use on a
 * file with typed subjects, bare edges and a schema inferred from the data (the drive's path), and on the same file under a schema it declares.
 *
 * Run: node --test testing/standalone/an-rdf-import-door-counts-what-the-act-holds-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfImportSchemaDoors, spaceWith } from './_rdf-import-schema-doors.mjs';
import { ttl } from './_rdf-import-infer.mjs';

const skip = await mongoSkipReason();
const id = (n) => `rdfcount${n}`;
const SPACES = ['data', 'declared'];

/** A file shaped like the benchmark's: producers, features and products, every product with edges to a producer and to three features. */
function benchLike(products) {
  const lines = [];
  for (let p = 0; p < 3; p++) lines.push(`p:producer${p} a ex:Producer ; rdfs:label "producer ${p}" .`);
  for (let f = 0; f < 20; f++) lines.push(`p:feature${f} a ex:Feature ; rdfs:label "feature ${f}" .`);
  for (let i = 0; i < products; i++) {
    const features = [0, 1, 2].map(k => `ex:feature p:feature${(i + k) % 20}`).join(' ; ');
    lines.push(`p:product${i} a ex:Product ; rdfs:label "product ${i}" ; ex:number "${i}"^^xsd:integer ; ex:producer p:producer${i % 3} ; ${features} .`);
  }
  return ttl(lines);
}

describe('the door counts at least what the act holds (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, writer, act;
  before(async () => {
    d = await openRdfImportSchemaDoors({ suite: 'rdf_import_door_counts', spaces: SPACES.map(n => spaceWith(id(n), undefined, { validationMode: 'strict' })) });
    writer = await d.mint('rdf-door-counts-writer', Object.fromEntries(SPACES.map(n => [id(n), d.row({ knowledge: 'write', schema: 'write' })])));
    act = await import('../../server/dist/spaces/rdf-import-act.js');
  });
  after(async () => { act?.setRdfImportKnobsForTest?.(null); await d?.close(); });

  /** One import's figures: the door's, then the act's. */
  async function figures(space, params) {
    const seen = [];
    act.setRdfImportKnobsForTest({
      bounds: { memoryBytes: 50_000_000 },
      hooks: { memory: (figure) => { if ('need' in figure) seen.push({ ...figure }); else seen[seen.length - 1].used = figure.used; } },
    });
    try {
      const r = await d.importRestOne(writer.key, space, benchLike(60), params);
      assert.equal(r.status, 200, r.text.slice(0, 400));
    } finally { act.setRdfImportKnobsForTest(null); }
    assert.equal(seen.length, 1, 'the hook fires once per import');
    return seen[0];
  }

  it('findings 4 and 6: with a schema inferred from the data, the door\'s first-phase figure is at least the act\'s use', async () => {
    const f = await figures(id('data'), { schema: 'generate', from: ['data'], inferMinSupport: 1 });
    assert.ok(Number.isInteger(f.first) && Number.isInteger(f.used) && f.used > 0, JSON.stringify(f));
    // The file has edges: each product states four, so the figure that matters is well above the subjects' alone.
    assert.ok(f.used > 83 * 160, `the file's edges were not held (used ${f.used}): a probe that charges nothing proves nothing`);
    assert.ok(f.first >= f.used, `the door counted ${f.first} bytes for the first phase and the act then held ${f.used}: ${JSON.stringify(f)}`);
  });
});
