/**
 * Integration: a space's records and schema leave a LIVE instance as RDF and come back as what was written (Q-750, Q-751, design r4 §8 IN).
 *
 * Against the integration stack's instance A (`testing/sync/helpers.js` `INSTANCES.a`, its token in `testing/sync/configs/a/token.txt`):
 * a space created here with RDF switched on (an explicit `example.org` base, never resolved), records written through the ordinary REST
 * doors (entities, three edges of one label, two links, a fact), then:
 *
 * - `GET /api/brain/spaces/:id/export/rdf` with no page parameters answers the whole space in each of the four formats, read back by the
 *   independent parsers (n3; jsonld then n3), with every record written, the same statements in every format, and the report saying
 *   `complete true`.
 * - `GET /api/spaces/:id/schema-rdf` answers shapes that the export conforms to (rdf-validate-shacl), found at the version address the
 *   export's description graph names (`sh:shapesGraph`).
 * - A record address under `/ld/` sends a browser to the app (`303`, no token asked) and, read by a machine with a token, answers a 404
 *   problem body: the space's base is an `example.org` address, not the instance's default base, and only the default base resolves.
 *
 * What it needs up: the integration stack (`npm run test:up`), with instance A built from this checkout. Unrun by the slice that wrote it;
 * the bundle's Full run in CI runs it.
 *
 * Run: node --test testing/integration/an-rdf-export-round-trips-through-a-live-instance.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, DataFactory } from 'n3';
import jsonld from 'jsonld';
import datasetFactory from '@rdfjs/dataset';
import SHACLValidator from 'rdf-validate-shacl';
import { INSTANCES, post, patch } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `rdf-round-trip-${RUN}`;
const BASE = `https://rdf.example.org/ld/${SPACE}/`;
const YTHRIL_NS = 'https://w3id.org/ythril/ns#';
const N3_FORMAT = { turtle: 'text/turtle', trig: 'application/trig', nquads: 'application/n-quads' };

let token;
const written = [];

async function exportText(pathAndQuery) {
  const r = await fetch(`${INSTANCES.a}${pathAndQuery}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, headers: r.headers, text: await r.text() };
}

async function parse(format, text) {
  if (format === 'jsonld') {
    const nquads = await jsonld.toRDF(JSON.parse(text), {
      format: 'application/n-quads', documentLoader: async (url) => { throw new Error(`no remote document (${url})`); },
    });
    return new Parser({ format: 'application/n-quads' }).parse(nquads);
  }
  return new Parser({ format: N3_FORMAT[format] }).parse(text);
}

const term = (t) => (t.termType === 'Literal' ? `"${t.value}"^^${t.datatype?.value}` : t.termType === 'BlankNode' ? '_:' : `<${t.value}>`);
const reportGraphs = (quads) => new Set(quads.filter(q => q.object.value === `${YTHRIL_NS}ExportReport`).map(q => q.graph.value));
const statements = (quads) => {
  const skip = reportGraphs(quads);
  return [...new Set(quads.filter(q => !skip.has(q.graph.value)).map(q => `${term(q.subject)} ${term(q.predicate)} ${term(q.object)}`))].sort();
};

before(async () => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const sp = await post(INSTANCES.a, token, '/api/spaces', { id: SPACE, label: `RDF round trip ${RUN}` });
  assert.equal(sp.status, 201, `create space: ${JSON.stringify(sp.body)}`);
  const on = await patch(INSTANCES.a, token, `/api/spaces/${SPACE}`, { meta: {
    rdf: { enabled: true, base: BASE },
    typeSchemas: { entity: { Person: { propertySchemas: { age: { type: 'number', minimum: 0 } } } } },
  } });
  assert.ok(on.status < 300, `switch RDF on: ${on.status} ${JSON.stringify(on.body)}`);
  const P = (p, body) => post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}${p}`, body);
  const ids = [];
  for (const name of ['Ada', 'Charles', 'Mary', 'Grace']) {
    const r = await P('/entities', { name: `${name} ${RUN}`, type: 'Person', properties: { age: 30 } });
    assert.ok(r.status < 300 && r.body?._id, `entity: ${r.status} ${JSON.stringify(r.body)}`);
    ids.push(r.body._id);
    written.push(`${BASE}entity/${r.body._id}`);
  }
  for (const to of ids.slice(1)) {
    const r = await P('/edges', { from: ids[0], to, label: 'knows' });
    assert.ok(r.status < 300, `edge: ${r.status} ${JSON.stringify(r.body)}`);
  }
  const fact = await P('/facts', { fact: `A fact ${RUN}` });
  assert.ok(fact.status < 300 && fact.body?._id, `fact: ${JSON.stringify(fact.body)}`);
  written.push(`${BASE}fact/${fact.body._id}`);
  for (const to of ids.slice(0, 2)) {
    const r = await P('/links', { from: fact.body._id, fromKind: 'fact', to, toKind: 'entity' });
    assert.ok(r.status < 300, `link: ${r.status} ${JSON.stringify(r.body)}`);
  }
});

after(async () => {
  await fetch(`${INSTANCES.a}/api/spaces/${SPACE}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
});

describe('an RDF export round-trips through a live instance', () => {
  it('the whole space in each format, read back alike, every record written, complete', async () => {
    const sets = {};
    for (const format of ['turtle', 'trig', 'nquads', 'jsonld']) {
      const r = await exportText(`/api/brain/spaces/${SPACE}/export/rdf?format=${format}&edgeDetails=reification`);
      assert.equal(r.status, 200, `${format}: ${r.text.slice(0, 300)}`);
      assert.equal(r.headers.get('link'), null, `${format}: the whole export has no next page`);
      const quads = await parse(format, r.text);
      for (const s of written) assert.ok(quads.some(q => q.subject.value === s), `${format}: ${s} is exported`);
      const knows = quads.filter(q => q.predicate.value === `${BASE}vocab/edge/knows`);
      assert.equal(knows.length, 3, `${format}: three edges of one label are the predicate three times`);
      if (format !== 'turtle') assert.ok(quads.some(q => q.predicate.value === `${YTHRIL_NS}complete` && q.object.value === 'true'), `${format}: complete`);
      sets[format] = statements(quads);
    }
    assert.deepEqual(sets.trig, sets.turtle);
    assert.deepEqual(sets.nquads, sets.turtle);
    assert.deepEqual(sets.jsonld, sets.turtle);
  });

  it('the export conforms to the shapes its description graph names', async () => {
    const data = await exportText(`/api/brain/spaces/${SPACE}/export/rdf?format=trig&edgeDetails=reification`);
    const quads = await parse('trig', data.text);
    const shapesAt = quads.find(q => q.predicate.value === 'http://www.w3.org/ns/shacl#shapesGraph')?.object.value;
    assert.ok(shapesAt?.startsWith(`${BASE}schema/`), `the shapes graph is named: ${shapesAt}`);
    const schema = await exportText(`/api/spaces/${SPACE}/schema-rdf`);
    assert.equal(schema.status, 200, schema.text.slice(0, 300));
    const shapes = await parse('turtle', schema.text);
    assert.ok(shapes.some(q => q.subject.value === `${BASE}schema` && q.predicate.value === 'http://www.w3.org/2002/07/owl#versionIRI' && q.object.value === shapesAt),
      'the schema export answers at the version address the records export names');
    const skip = reportGraphs(quads);
    const report = await new SHACLValidator(datasetFactory.dataset(shapes)).validate(
      datasetFactory.dataset(quads.filter(q => !skip.has(q.graph.value)).map(q => DataFactory.quad(q.subject, q.predicate, q.object))));
    assert.equal(report.conforms, true, JSON.stringify(report.results.map(x => [x.focusNode?.value, x.path?.value])));
  });

  it('a record address sends a browser to the app, and under a base that is not the default one answers a 404 problem body', async () => {
    const page = await fetch(`${INSTANCES.a}/ld/${SPACE}/entity/x`, { headers: { Accept: 'text/html' }, redirect: 'manual' });
    assert.equal(page.status, 303);
    assert.equal(page.headers.get('location'), `/brain?space=${SPACE}&tab=entities`);
    const r = await fetch(`${INSTANCES.a}/ld/${SPACE}/entity/x`, { headers: { Accept: 'text/turtle', Authorization: `Bearer ${token}` }, redirect: 'manual' });
    assert.equal(r.status, 404);
    assert.match(String(r.headers.get('content-type')), /^application\/problem\+json/);
  });
});
