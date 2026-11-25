/**
 * Integration: the ticket's ten SPARQL queries over a strict space on a LIVE instance, each answering its expected results JSON exactly
 * (bundle-271, Q-757; design §2 "Test", r2 R9 "the integration twin of the fixed-query test is kept").
 *
 * Against the integration stack's instance A (`testing/sync/helpers.js` `INSTANCES.a`, its token in `testing/sync/configs/a/token.txt`):
 * two strict spaces with RDF switched on (an explicit `example.org` base, never resolved), records written through the ordinary REST doors,
 * a personal view of both, and a token whose rights on one member are taken away after its view is made. The queries:
 *
 *  1. type match; 2. property filter; 3. edge join; 4. fact about an entity; 5. chrono range; 6. RDF-star annotation (`<< s p o >> q ?v`);
 *  7. a view across two members, each its own graph; 8. OPTIONAL; 9. aggregate (GROUP BY, COUNT); 10. a view member narrowed by rights.
 *
 * Each answer is compared whole (`head` and every binding, in the query's ORDER BY), so a missing, an extra or a mistyped term fails.
 *
 * Seen red on db66e206d: every query answers 404 (no route). Mutations: dropping the `edges {from}` find of the subject rule (query 3 and 6
 * miss the edge); reading view members without the guard's narrowing (query 10 answers the removed member's rows).
 *
 * What it needs up: the integration stack (`npm run test:up`), with instance A built from this checkout.
 *
 * Run: node --test testing/integration/sparql-fixed-queries.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTANCES, post, patch } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SA = `sparql-fixed-a-${RUN}`;
const SB = `sparql-fixed-b-${RUN}`;
const VIEW = `sparqlfixed${RUN}`;
const base = (s) => `https://rdf.example.org/ld/${s}/`;
const vocab = (s) => `${base(s)}vocab/`;
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const YT = 'https://w3id.org/ythril/ns#';
const SCHEMA_ORG = 'http://schema.org/';
const DCTERMS = 'http://purl.org/dc/terms/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const PREFIXES = `PREFIX rdfs: <${RDFS}> PREFIX yt: <${YT}> PREFIX xsd: <${XSD}> PREFIX dcterms: <${DCTERMS}> `;
const SCHEMA = {
  entity: { Person: { propertySchemas: { age: { type: 'number' }, nick: { type: 'string' } } }, Org: { propertySchemas: { size: { type: 'number' } } } },
  fact: { note: { propertySchemas: { weight: { type: 'number' } } } },
  edge: { knows: {} },
};
const ROW = (rung) => ({ knowledge: rung, files: 'none', schema: 'none', dataQuality: 'none', networks: 'none' });

let admin, narrowed;
const ids = {};

const lit = (value) => ({ type: 'literal', value });
const int = (n) => ({ type: 'literal', datatype: `${XSD}integer`, value: String(n) });
const uri = (value) => ({ type: 'uri', value });
const entity = (s, id) => uri(`${base(s)}entity/${id}`);

async function query(token, space, text) {
  const r = await fetch(`${INSTANCES.a}/api/brain/spaces/${encodeURIComponent(space)}/sparql`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/sparql-query', Accept: 'application/sparql-results+json' }, body: text,
  });
  const raw = await r.text();
  let body = null; try { body = JSON.parse(raw); } catch { /* not JSON */ }
  return { status: r.status, body, raw };
}

async function expectAnswer(token, space, text, expected) {
  const a = await query(token, space, PREFIXES + text);
  assert.equal(a.status, 200, a.raw.slice(0, 400));
  assert.deepEqual(a.body, expected);
}

before(async () => {
  admin = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  for (const [s, schema] of [[SA, SCHEMA], [SB, { entity: { Person: {} } }]]) {
    const sp = await post(INSTANCES.a, admin, '/api/spaces', { id: s, label: s });
    assert.equal(sp.status, 201, `create ${s}: ${JSON.stringify(sp.body)}`);
    const on = await patch(INSTANCES.a, admin, `/api/spaces/${s}`, { meta: { validationMode: 'strict', typeSchemas: schema, rdf: { enabled: true, base: base(s) } } });
    assert.ok(on.status < 300, `RDF on ${s}: ${on.status} ${JSON.stringify(on.body)}`);
  }
  const P = async (s, rest, body) => {
    const r = await post(INSTANCES.a, admin, `/api/brain/spaces/${s}${rest}`, body);
    assert.ok(r.status < 300 && r.body?._id, `${rest}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body._id;
  };
  ids.ada = await P(SA, '/entities', { name: 'Ada', type: 'Person', properties: { age: 36, nick: 'Enchantress' } });
  ids.charles = await P(SA, '/entities', { name: 'Charles', type: 'Person', properties: { age: 79 } });
  ids.engines = await P(SA, '/entities', { name: 'Engines Ltd', type: 'Org', properties: { size: 12 } });
  ids.f1 = await P(SA, '/facts', { fact: 'Ledger entry', type: 'note', properties: { weight: 0.5 }, linkEntities: [ids.ada] });
  ids.c1 = await P(SA, '/chrono', { title: 'Lecture', type: 'event', startsAt: '2026-06-01T09:00:00Z', status: 'active' });
  ids.c2 = await P(SA, '/chrono', { title: 'Launch', type: 'milestone', startsAt: '2026-09-15T00:00:00Z', status: 'upcoming' });
  await P(SA, '/edges', { from: ids.ada, to: ids.charles, label: 'knows', weight: 0.7, type: 'friend' });
  ids.bea = await P(SB, '/entities', { name: 'Bea', type: 'Person' });

  const view = await post(INSTANCES.a, admin, '/api/views', { name: VIEW, members: [SA, SB] });
  assert.equal(view.status, 201, `view: ${JSON.stringify(view.body)}`);
  const t = await post(INSTANCES.a, admin, '/api/tokens', { name: `sparql-narrowed-${RUN}`, rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [SA]: ROW('read'), [SB]: ROW('read') } } });
  assert.equal(t.status, 201, `mint: ${JSON.stringify(t.body)}`);
  narrowed = { key: t.body.plaintext, id: t.body.token?.id ?? t.body.id };
  const nv = await post(INSTANCES.a, narrowed.key, '/api/views', { name: `${VIEW}n`, members: [SA, SB] });
  assert.equal(nv.status, 201, `narrowed view: ${JSON.stringify(nv.body)}`);
  const cut = await patch(INSTANCES.a, admin, `/api/tokens/${narrowed.id}`, { rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [SA]: ROW('read') } } });
  assert.ok(cut.status < 300, `narrow the token: ${cut.status} ${JSON.stringify(cut.body)}`);
});

after(async () => {
  for (const s of [SA, SB]) {
    await fetch(`${INSTANCES.a}/api/spaces/${s}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }),
    }).catch(() => {});
  }
});

describe('the ticket\'s ten SPARQL queries answer exactly', () => {
  it('1. type match', () => expectAnswer(admin, SA, 'SELECT ?n WHERE { ?s a <' + vocab(SA) + 'entity/Person> ; rdfs:label ?n } ORDER BY ?n',
    { head: { vars: ['n'] }, results: { bindings: [{ n: lit('Ada') }, { n: lit('Charles') }] } }));

  it('2. property filter', () => expectAnswer(admin, SA, 'SELECT ?s WHERE { ?s <' + vocab(SA) + 'entity/Person#age> ?age FILTER(?age > 50) }',
    { head: { vars: ['s'] }, results: { bindings: [{ s: entity(SA, ids.charles) }] } }));

  it('3. edge join', () => expectAnswer(admin, SA, 'SELECT ?a ?b WHERE { ?x <' + vocab(SA) + 'edge/knows> ?y . ?x rdfs:label ?a . ?y rdfs:label ?b }',
    { head: { vars: ['a', 'b'] }, results: { bindings: [{ a: lit('Ada'), b: lit('Charles') }] } }));

  it('4. fact about an entity', () => expectAnswer(admin, SA, `SELECT ?t WHERE { ?f a yt:Fact ; <${SCHEMA_ORG}text> ?t ; dcterms:references <${base(SA)}entity/${ids.ada}> }`,
    { head: { vars: ['t'] }, results: { bindings: [{ t: lit('Ledger entry') }] } }));

  it('5. chrono range', () => expectAnswer(admin, SA, `SELECT ?l WHERE { ?c <${SCHEMA_ORG}startDate> ?d ; rdfs:label ?l FILTER(?d >= "2026-07-01T00:00:00Z"^^xsd:dateTime) }`,
    { head: { vars: ['l'] }, results: { bindings: [{ l: lit('Launch') }] } }));

  it('6. RDF-star annotation', () => expectAnswer(admin, SA,
    `SELECT ?t WHERE { << <${base(SA)}entity/${ids.ada}> <${vocab(SA)}edge/knows> <${base(SA)}entity/${ids.charles}> >> yt:edgeType ?t }`,
    { head: { vars: ['t'] }, results: { bindings: [{ t: lit('friend') }] } }));

  it('7. a view across two members, each its own graph', () => expectAnswer(admin, `@${VIEW}`,
    'SELECT ?g ?n WHERE { GRAPH ?g { ?s a yt:Entity ; rdfs:label ?n } } ORDER BY ?n',
    { head: { vars: ['g', 'n'] }, results: { bindings: [
      { g: uri(base(SA)), n: lit('Ada') }, { g: uri(base(SB)), n: lit('Bea') }, { g: uri(base(SA)), n: lit('Charles') }, { g: uri(base(SA)), n: lit('Engines Ltd') },
    ] } }));

  it('8. OPTIONAL', () => expectAnswer(admin, SA, 'SELECT ?n ?nick WHERE { ?s a <' + vocab(SA) + 'entity/Person> ; rdfs:label ?n OPTIONAL { ?s <' + vocab(SA) + 'entity/Person#nick> ?nick } } ORDER BY ?n',
    { head: { vars: ['n', 'nick'] }, results: { bindings: [{ n: lit('Ada'), nick: lit('Enchantress') }, { n: lit('Charles') }] } }));

  it('9. aggregate', () => expectAnswer(admin, SA, `SELECT ?type (COUNT(?s) AS ?count) WHERE { ?s a ?type FILTER(STRSTARTS(STR(?type), "${vocab(SA)}entity/")) } GROUP BY ?type ORDER BY ?type`,
    { head: { vars: ['type', 'count'] }, results: { bindings: [{ type: uri(`${vocab(SA)}entity/Org`), count: int(1) }, { type: uri(`${vocab(SA)}entity/Person`), count: int(2) }] } }));

  it('10. a view member narrowed by rights answers only what the token still reads', () => expectAnswer(narrowed.key, `@${VIEW}n`,
    'SELECT ?g ?n WHERE { GRAPH ?g { ?s a yt:Entity ; rdfs:label ?n } } ORDER BY ?n',
    { head: { vars: ['g', 'n'] }, results: { bindings: [
      { g: uri(base(SA)), n: lit('Ada') }, { g: uri(base(SA)), n: lit('Charles') }, { g: uri(base(SA)), n: lit('Engines Ltd') },
    ] } }));
});
