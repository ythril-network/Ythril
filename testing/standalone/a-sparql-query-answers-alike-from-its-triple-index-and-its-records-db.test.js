/**
 * A SPARQL query answers alike whether its members are read from their triple indexes or from their records, also while writes run beside
 * it (bundle-273, Q-764 slice S3; design-r2 R9; contract row 6). The index is worth nothing if it answers differently: this is the floor.
 *
 * ## What is compared
 *
 * Each query runs twice in this process through the one engine (`runSparql`): once over a quad source that reads the index where it may
 * (the default), once over one held to the records (`index: false`, the path every query took before S3). A SELECT's rows are compared
 * sorted, with their multiplicity; an ASK's boolean; a CONSTRUCT's or DESCRIBE's statements as a set (the record form writes no blank node,
 * so two graphs are isomorphic exactly when their statements are equal; a blank node in an answer fails the case).
 *
 * The queries: the shapes of bundle-271's ten fixed queries (type match, property filter, edge join, a fact about an entity, a chrono range,
 * an RDF-star annotation, two members each their own graph, OPTIONAL, an aggregate), and BSBM's Explore mix Q1-Q5 and Q7-Q12 written over
 * a small BSBM-shaped dataset in the space's own vocabulary (products with features, producers, offers by vendors, reviews by reviewers).
 *
 * ## The interleaved cases
 *
 * 1. a positioned write held open (its band not yet released);
 * 2. two overlapping writes to one record;
 * 3. a schema change, and its revert;
 * 4. a delete a 5.6 build makes, through the driver's own client (no position, no journal row, no tombstone), found by the re-upgrade
 *    detector, which holds the member's index to its records until a rebuild;
 * 5. a lagging member (its index behind and its follower held by another process).
 *
 * ## An answer from the index is checked as one from the index (review finding G4)
 *
 * A comparison of two answers that both came from the records proves nothing, so every case that ends with the index ready asserts
 * `readPaths` says `index` for the member after `followUntilReady` (or after the rebuild a stale index needs), and every case that holds
 * the member to its records asserts `records`. The index is made by a rebuild first: an index no rebuild wrote is never read (G1).
 *
 * ## Duplicates (review point V6)
 *
 * The records path states a statement once per record, the index once per space. The data holds the cases that could differ: one author on
 * every record (the agent's statements), edges that share an end, and a record whose tags repeat a word. A SELECT without DISTINCT over all
 * of them compares with its multiplicity. Two edges of one label between one pair cannot be stored (`edge_identity` is unique on
 * `from, to, label, fromKind, toKind`), so the records path's edge rule has no second edge to see.
 *
 * ## Seen red
 *
 * On bcb4d7d63 (no index read): the first comparison fails at the check that the default source read the member from its index
 * (`readPaths` is not a function). On d5192c4f6 (the corrected cases): the delete a 5.6 build makes is not seen (case 4 answers the record
 * the index still states) and the index is read after no rebuild wrote it.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-sparql-query-answers-alike-from-its-triple-index-and-its-records-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason, openFixtureMongo } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta, baseOf } from './_sparql-doors.mjs';
import { landAll, followUntilReady, bendState, holdLease, restore, entityDoc, edgeDoc } from './_triple-index-read.mjs';
import { rebuildModule } from './_triple-index-rebuild.mjs';

const skip = await mongoSkipReason();
const A = 'tixe-a';
const B = 'tixe-b';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const YT = 'https://w3id.org/ythril/ns#';
const STAMP = '2026-03-04T05:06:07.000Z';
const SCHEMA = {
  entity: {
    Person: { propertySchemas: { age: { type: 'number' }, nick: { type: 'string' }, country: { type: 'string' } } },
    Org: { propertySchemas: { size: { type: 'number' } } },
    product: { propertySchemas: { num1: { type: 'number' }, num2: { type: 'number' }, num3: { type: 'number' }, comment: { type: 'string' } } },
    feature: { propertySchemas: {} },
    producer: { propertySchemas: { country: { type: 'string' } } },
    vendor: { propertySchemas: { country: { type: 'string' } } },
    offer: { propertySchemas: { price: { type: 'number' }, deliveryDays: { type: 'number' }, validTo: { type: 'string' } } },
    review: { propertySchemas: { rating1: { type: 'number' }, rating2: { type: 'number' }, title: { type: 'string' }, text: { type: 'string' } } },
  },
  fact: { note: { propertySchemas: { weight: { type: 'number' } } } },
  edge: { knows: {}, worksFor: {}, productFeature: {}, producer: {}, product: {}, vendor: {}, reviewFor: {}, reviewer: {} },
};

const v = (s, rest) => `<${baseOf(s)}vocab/${rest}>`;
const e = (s, id) => `<${baseOf(s)}entity/${id}>`;

let d, engine, quadSource;
/** The caller every comparison reads as: an instance admin reads every member, files included. */
const ADMIN = { id: 'tixe-admin', admin: true, rights: { instanceAdmin: true } };

/** The dataset: the fixed queries' records and a small BSBM-shaped catalogue, all landed through the records stream. */
function dataset(s) {
  const docs = [];
  const ent = (id, name, type, properties = {}, extra = {}) => docs.push(['entities', entityDoc(s, id, name, type, properties, extra)]);
  const edge = (id, from, to, label, extra = {}) => docs.push(['edges', edgeDoc(s, id, from, to, label, extra)]);
  ent('ada', 'Ada', 'Person', { age: 36, nick: 'Enchantress', country: 'GB' });
  ent('charles', 'Charles', 'Person', { age: 79, country: 'GB' });
  ent('engines', 'Engines Ltd', 'Org', { size: 12 });
  edge('k1', 'ada', 'charles', 'knows', { properties: { since: 'friend' }, weight: 0.9 });
  edge('w1', 'charles', 'engines', 'worksFor');
  // V6: a record whose tags repeat a word states it once. (A second edge of one label between one pair cannot be stored: `edge_identity` is unique.)
  ent('twice', 'Twice', 'Person', { age: 5 }, { tags: ['dup', 'dup', 'solo'] });
  docs.push(['facts', { _id: 'f1', spaceId: s, seq: 1, fact: 'Ledger entry', type: 'note', properties: { weight: 2 }, tags: [], createdAt: STAMP, updatedAt: STAMP, author: { instanceId: 'tix-author', instanceLabel: 'Tix' } }]);
  docs.push(['links', { _id: 'l1', spaceId: s, from: 'f1', fromKind: 'fact', to: 'ada', toKind: 'entity', seq: 1 }]);
  docs.push(['chrono', { _id: 'c1', spaceId: s, seq: 1, title: 'Launch', type: 'event', status: 'upcoming', startsAt: '2026-07-04T10:00:00Z', endsAt: '2026-07-04T11:00:00Z', tags: [], createdAt: STAMP, updatedAt: STAMP, author: { instanceId: 'tix-author', instanceLabel: 'Tix' } }]);
  docs.push(['chrono', { _id: 'c2', spaceId: s, seq: 1, title: 'Draft', type: 'event', status: 'upcoming', startsAt: '2026-05-01T10:00:00Z', endsAt: '2026-05-01T11:00:00Z', tags: [], createdAt: STAMP, updatedAt: STAMP, author: { instanceId: 'tix-author', instanceLabel: 'Tix' } }]);
  for (let f = 0; f < 6; f++) ent(`feat${f}`, `Feature ${f}`, 'feature');
  for (let p = 0; p < 3; p++) ent(`producer${p}`, `Producer ${p}`, 'producer', { country: p === 0 ? 'DE' : 'US' });
  for (let p = 0; p < 3; p++) ent(`vendor${p}`, `Vendor ${p}`, 'vendor', { country: p === 1 ? 'DE' : 'FR' });
  for (let r = 0; r < 4; r++) ent(`reviewer${r}`, `Reviewer ${r}`, 'Person', { country: r % 2 ? 'DE' : 'US' });
  for (let i = 0; i < 30; i++) {
    ent(`product${i}`, `Product ${String(i).padStart(2, '0')}`, 'product', { num1: i % 10, num2: (i * 7) % 13, ...(i % 3 ? { num3: i } : {}), comment: `Comment on ${i}` });
    edge(`pf${i}a`, `product${i}`, `feat${i % 6}`, 'productFeature');
    edge(`pf${i}b`, `product${i}`, `feat${(i + 1) % 6}`, 'productFeature');
    edge(`pp${i}`, `product${i}`, `producer${i % 3}`, 'producer');
    for (let o = 0; o < 2; o++) {
      ent(`offer${i}_${o}`, `Offer ${i}/${o}`, 'offer', { price: 10 + ((i * 13 + o * 7) % 50), deliveryDays: 1 + ((i + o) % 6), validTo: `2026-0${1 + (i % 9)}-01` });
      edge(`op${i}_${o}`, `offer${i}_${o}`, `product${i}`, 'product');
      edge(`ov${i}_${o}`, `offer${i}_${o}`, `vendor${(i + o) % 3}`, 'vendor');
    }
    ent(`review${i}`, `Review ${i}`, 'review', { rating1: i % 10, ...(i % 2 ? { rating2: (i * 3) % 10 } : {}), title: `Title ${i}`, text: `Text ${i}` });
    edge(`rf${i}`, `review${i}`, `product${i}`, 'reviewFor');
    edge(`rr${i}`, `review${i}`, `reviewer${i % 4}`, 'reviewer');
  }
  return docs;
}

/** The queries, by name: the fixed queries' shapes and the BSBM Explore mix over `s` (and `t`, the second member). */
function queries(s, t) {
  const P = `PREFIX rdfs: <${RDFS}> PREFIX xsd: <${XSD}> PREFIX yt: <${YT}> `;
  const prod = (rest) => v(s, `entity/product#${rest}`);
  const label = 'rdfs:label';
  return {
    'fixed 1 type match': `${P} SELECT ?n WHERE { ?s a ${v(s, 'entity/Person')} ; ${label} ?n } ORDER BY ?n`,
    'fixed 2 property filter': `${P} SELECT ?s WHERE { ?s ${v(s, 'entity/Person#age')} ?age FILTER(?age > 50) }`,
    'fixed 3 edge join': `${P} SELECT ?a ?b WHERE { ?x ${v(s, 'edge/knows')} ?y . ?x ${label} ?a . ?y ${label} ?b }`,
    'fixed 4 fact about an entity': `${P} SELECT ?f ?p ?o WHERE { ?f a yt:Fact ; ?p ?o }`,
    'fixed 5 chrono range': `${P} SELECT ?c ?d WHERE { ?c ?dp ?d FILTER(isLiteral(?d) && datatype(?d) = xsd:dateTime && ?d >= "2026-07-01T00:00:00Z"^^xsd:dateTime) }`,
    'fixed 6 RDF-star annotation': `${P} SELECT ?r ?p ?o WHERE { ?r ?p ?o . ?r ?q << ${e(s, 'ada')} ${v(s, 'edge/knows')} ${e(s, 'charles')} >> }`,
    'fixed 7 two members, each its own graph': `${P} SELECT ?g ?n WHERE { GRAPH ?g { ?s a ${v(s, 'entity/Person')} ; ${label} ?n } }`,
    'fixed 7b both members by label': `${P} SELECT ?g ?n WHERE { GRAPH ?g { ?s ${label} ?n } }`,
    'fixed 8 OPTIONAL': `${P} SELECT ?n ?nick WHERE { ?s a ${v(s, 'entity/Person')} ; ${label} ?n OPTIONAL { ?s ${v(s, 'entity/Person#nick')} ?nick } }`,
    'fixed 9 aggregate': `${P} SELECT ?type (COUNT(?s) AS ?count) WHERE { ?s a ?type } GROUP BY ?type`,
    'every statement': 'SELECT ?s ?p ?o WHERE { ?s ?p ?o }',
    'ask': `ASK { ${e(s, 'ada')} ?p ?o }`,
    'BSBM Q1': `${P} SELECT DISTINCT ?product ?label WHERE { ?product ${label} ?label . ?product a ${v(s, 'entity/product')} . ?product ${v(s, 'edge/productFeature')} ${e(s, 'feat1')} . ?product ${v(s, 'edge/productFeature')} ${e(s, 'feat2')} . ?product ${prod('num1')} ?value1 . FILTER (?value1 > 1) } ORDER BY ?label LIMIT 10`,
    'BSBM Q2': `${P} SELECT ?label ?comment ?producer ?f ?p1 ?p3 WHERE { ${e(s, 'product3')} ${label} ?label . ${e(s, 'product3')} ${prod('comment')} ?comment . ${e(s, 'product3')} ${v(s, 'edge/producer')} ?p . ?p ${label} ?producer . ${e(s, 'product3')} ${v(s, 'edge/productFeature')} ?f . ${e(s, 'product3')} ${prod('num1')} ?p1 . OPTIONAL { ${e(s, 'product3')} ${prod('num3')} ?p3 } }`,
    'BSBM Q3': `${P} SELECT ?product ?label WHERE { ?product ${label} ?label . ?product a ${v(s, 'entity/product')} . ?product ${v(s, 'edge/productFeature')} ${e(s, 'feat1')} . ?product ${prod('num1')} ?p1 . FILTER (?p1 > 2) OPTIONAL { ?product ${v(s, 'edge/productFeature')} ${e(s, 'feat2')} . ?product ${label} ?testVar } FILTER (!bound(?testVar)) } ORDER BY ?label LIMIT 10`,
    'BSBM Q4': `${P} SELECT DISTINCT ?product ?label ?propertyTextual WHERE { { ?product ${label} ?label . ?product a ${v(s, 'entity/product')} . ?product ${v(s, 'edge/productFeature')} ${e(s, 'feat1')} . ?product ${prod('comment')} ?propertyTextual . ?product ${prod('num1')} ?p1 . FILTER (?p1 > 3) } UNION { ?product ${label} ?label . ?product a ${v(s, 'entity/product')} . ?product ${v(s, 'edge/productFeature')} ${e(s, 'feat3')} . ?product ${prod('comment')} ?propertyTextual . ?product ${prod('num2')} ?p2 . FILTER (?p2 > 5) } } ORDER BY ?label OFFSET 2 LIMIT 10`,
    'BSBM Q5': `${P} SELECT DISTINCT ?product ?productLabel WHERE { ?product ${label} ?productLabel . FILTER (${e(s, 'product4')} != ?product) ${e(s, 'product4')} ${v(s, 'edge/productFeature')} ?prodFeature . ?product ${v(s, 'edge/productFeature')} ?prodFeature . ${e(s, 'product4')} ${prod('num1')} ?origProperty1 . ?product ${prod('num1')} ?simProperty1 . FILTER (?simProperty1 < (?origProperty1 + 3) && ?simProperty1 > (?origProperty1 - 3)) } ORDER BY ?productLabel LIMIT 5`,
    'BSBM Q7': `${P} SELECT ?productLabel ?offer ?price ?vendor ?vendorTitle ?review ?revTitle ?r1 WHERE { ${e(s, 'product5')} ${label} ?productLabel . OPTIONAL { ?offer ${v(s, 'edge/product')} ${e(s, 'product5')} . ?offer ${v(s, 'entity/offer#price')} ?price . ?offer ${v(s, 'edge/vendor')} ?vendor . ?vendor ${label} ?vendorTitle . ?vendor ${v(s, 'entity/vendor#country')} "DE" } OPTIONAL { ?review ${v(s, 'edge/reviewFor')} ${e(s, 'product5')} . ?review ${v(s, 'entity/review#title')} ?revTitle . OPTIONAL { ?review ${v(s, 'entity/review#rating1')} ?r1 } } }`,
    'BSBM Q8': `${P} SELECT ?title ?text ?reviewer ?reviewerName ?r1 ?r2 WHERE { ?review ${v(s, 'edge/reviewFor')} ${e(s, 'product7')} . ?review ${v(s, 'entity/review#title')} ?title . ?review ${v(s, 'entity/review#text')} ?text . ?review ${v(s, 'edge/reviewer')} ?reviewer . ?reviewer ${label} ?reviewerName . OPTIONAL { ?review ${v(s, 'entity/review#rating1')} ?r1 } OPTIONAL { ?review ${v(s, 'entity/review#rating2')} ?r2 } } ORDER BY ?title LIMIT 20`,
    'BSBM Q9': `DESCRIBE ?x WHERE { ${e(s, 'review9')} ${v(s, 'edge/reviewer')} ?x }`,
    'BSBM Q10': `${P} SELECT DISTINCT ?offer ?price WHERE { ?offer ${v(s, 'edge/product')} ${e(s, 'product8')} . ?offer ${v(s, 'edge/vendor')} ?vendor . ?vendor ${v(s, 'entity/vendor#country')} ?c . ?offer ${v(s, 'entity/offer#deliveryDays')} ?dd . FILTER (?dd <= 6) ?offer ${v(s, 'entity/offer#price')} ?price . } ORDER BY xsd:double(str(?price)) LIMIT 10`,
    'BSBM Q11': `SELECT ?property ?hasValue ?isValueOf WHERE { { ${e(s, 'offer2_1')} ?property ?hasValue } UNION { ?isValueOf ?property ${e(s, 'offer2_1')} } }`,
    'BSBM Q12': `${P} CONSTRUCT { ${e(s, 'offer3_0')} <urn:x:product> ?productLabel . ${e(s, 'offer3_0')} <urn:x:price> ?price . ${e(s, 'offer3_0')} <urn:x:vendor> ?vendorName } WHERE { ${e(s, 'offer3_0')} ${v(s, 'edge/product')} ?p . ?p ${label} ?productLabel . ${e(s, 'offer3_0')} ${v(s, 'edge/vendor')} ?v . ?v ${label} ?vendorName . ${e(s, 'offer3_0')} ${v(s, 'entity/offer#price')} ?price }`,
    'second member': `${P} SELECT ?n WHERE { ?s a ${v(t, 'entity/product')} ; ${label} ?n }`,
  };
}

/** A term as text; a blank node fails the comparison (the record form writes none). */
function termText(t) {
  if (t === undefined) return '-';
  if (t.termType === 'BlankNode') throw new Error('an answer holds a blank node, which the record form never writes');
  if (t.termType === 'Quad') return `<<${termText(t.subject)} ${termText(t.predicate)} ${termText(t.object)}>>`;
  if (t.termType === 'Literal') return `"${t.value}"@${t.language ?? ''}^^${t.datatype?.value ?? ''}`;
  return `<${t.value}>`;
}

/** The answer of `text` over `members`, read from the index where it may (`index` true) or from the records alone, as sorted texts. */
async function answer(text, members, index) {
  const checked = await engine.checkSparqlAlgebra(text);
  assert.ok(checked.algebra, `the query is checked: ${JSON.stringify(checked.refusal ?? {})}`);
  const deadline = Date.now() + 60_000;
  const source = quadSource.createQuadSource({ members, caller: ADMIN }, { deadline, ...(index ? {} : { index: false }) });
  const result = await engine.runSparql(checked.algebra, source, { deadline });
  let texts;
  if (result.kind === 'boolean') texts = [String(await result.rows())];
  else {
    const rows = await result.rows(100_000, 256 * 1024 * 1024);
    texts = result.kind === 'bindings'
      ? rows.map(r => Object.keys(r).sort().map(k => `${k}=${termText(r[k])}`).join(' '))
      : [...new Set(rows.map(q => `${termText(q.subject)} ${termText(q.predicate)} ${termText(q.object)}`))];
  }
  assert.equal(source.failure(), null, `the query read without a refusal: ${source.failure()?.message}`);
  return { texts: texts.sort(), source };
}

/** Every query of `names` (all when absent) answers alike from the index and from the records; answers the index sources' read paths. */
async function alike(why, names) {
  const all = queries(A, B);
  const paths = [];
  for (const name of names ?? Object.keys(all)) {
    const fromIndex = await answer(all[name], [A, B], true);
    const fromRecords = await answer(all[name], [A, B], false);
    assert.deepEqual(fromIndex.texts, fromRecords.texts, `${why}: ${name} answers alike from the index and from the records`);
    paths.push(...fromIndex.source.readPaths());
    // A floor: an empty answer on both sides compares equal, so the queries every case asks must answer something.
    if (name === 'every statement' || name === 'fixed 1 type match') assert.ok(fromRecords.texts.length > 0, `${why}: ${name} answers something`);
    if (name === 'fixed 1 type match') assert.ok(fromRecords.texts.some(t => t.includes('"Ada"')), `${why}: the type match names Ada`);
  }
  return paths;
}

/** Every read of `space` in `paths` took `path`, and there was one (an answer compared with itself proves nothing: review finding G4). */
function readAll(paths, space, path, why) {
  const mine = paths.filter(p => p.space === space);
  assert.ok(mine.length > 0, `${why}: ${space} was read at all`);
  assert.deepEqual(mine.filter(p => p.path !== path), [], `${why}: ${space} was read from its ${path}`);
}

describe('a SPARQL query answers alike from its triple index and its records', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tixe', spaces: [{ id: A, meta: rdfMeta(A, { typeSchemas: SCHEMA }) }, { id: B, meta: rdfMeta(B, { typeSchemas: SCHEMA }) }] });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: A }, { id: B }]);
    engine = await import('../../server/dist/rdf/sparql-engine.js');
    quadSource = await import('../../server/dist/rdf/quad-source.js');
    await landAll(d, A, dataset(A));
    await landAll(d, B, dataset(B).filter(([c]) => c === 'entities'));
    // An index no rebuild wrote is never read (review finding G1): the rebuild makes both, the follower keeps them caught up.
    for (const space of [A, B]) assert.equal((await (await rebuildModule()).rebuildTripleIndex(space)).outcome, 'built');
    await followUntilReady(d, A);
    await followUntilReady(d, B);
  });
  after(async () => { await d?.close(); });

  it('every fixed query and the BSBM mix answer alike, and the default source read both members from their indexes', async () => {
    const paths = await alike('caught up');
    for (const space of [A, B]) {
      assert.ok(paths.some(p => p.space === space && p.path === 'index'), `${space} was read from its index: ${JSON.stringify(paths.slice(0, 4))}`);
      assert.ok(!paths.some(p => p.space === space && p.path === 'records'), `${space}, caught up, was never read from its records`);
    }
  });

  it('a positioned write held open answers alike', async () => {
    const stream = await import('../../server/dist/sync/record-position-stream.js');
    let release;
    const gate = new Promise(r => { release = r; });
    let inside;
    const landed = new Promise(r => { inside = r; });
    const held = stream.withLandingStamp(A, [stream.localRow(1)], async ([patch]) => {
      await d.col(d.spaceCollection(A, 'entities')).insertOne({ ...entityDoc(A, 'held1', 'Held One', 'Person', { age: 51 }), ...patch });
      inside();
      await gate;
    }, 'test.held');
    await landed;
    try { await alike('a write held open', ['fixed 1 type match', 'fixed 2 property filter', 'every statement']); } finally { release(); await held; }
    await followUntilReady(d, A);
    readAll(await alike('after the held write', ['fixed 1 type match', 'fixed 2 property filter']), A, 'index', 'after the held write');
  });

  it('two overlapping writes to one record answer alike', async () => {
    const admin = await d.mint('tixe-admin', {}, { admin: true });
    const made = await d.rest(admin.key, 'POST', `/api/brain/spaces/${A}/entities`, { name: 'Overlap', type: 'Person', properties: { age: 20, nick: 'o0' } });
    assert.equal(made.status, 201, made.text);
    const id = made.body._id ?? made.body.id;
    const writes = [1, 2, 3, 4].map(n => d.rest(admin.key, 'PATCH', `/api/brain/spaces/${A}/entities/${id}`, { properties: { age: 20 + n, nick: `o${n}` } }));
    // While the writes run the answer moves, so a comparison holds only between two records reads that agree (a sandwich: records, index,
    // records); a pass where the records moved under it compares nothing.
    const all = queries(A, B);
    let compared = 0;
    for (let i = 0; i < 6; i++) {
      const before_ = await answer(all['fixed 8 OPTIONAL'], [A, B], false);
      const fromIndex = await answer(all['fixed 8 OPTIONAL'], [A, B], true);
      const after_ = await answer(all['fixed 8 OPTIONAL'], [A, B], false);
      if (JSON.stringify(before_.texts) !== JSON.stringify(after_.texts)) continue;
      assert.deepEqual(fromIndex.texts, before_.texts, 'two writes to one record in flight: the index answers what the records answer on both sides of it');
      compared++;
    }
    assert.ok(compared > 0, 'at least one pass compared while the records stood still');
    for (const w of await Promise.all(writes)) assert.ok(w.status === 200 || w.status === 409, w.text);
    await followUntilReady(d, A);
    readAll(await alike('after the overlapping writes', ['fixed 8 OPTIONAL', 'fixed 2 property filter', 'every statement']), A, 'index', 'after the overlapping writes');
  });

  it('a schema change and its revert answer alike', async () => {
    const meta = (cfg) => cfg.spaces.find(s => s.id === A).meta;
    let before_;
    await d.loader.mutateConfig(cfg => { before_ = JSON.parse(JSON.stringify(meta(cfg))); meta(cfg).typeSchemas.entity.Person.propertySchemas.shoe = { type: 'number' }; });
    try {
      readAll(await alike('a schema change', ['fixed 1 type match', 'fixed 8 OPTIONAL', 'every statement']), A, 'records', 'a schema change');
    } finally {
      await d.loader.mutateConfig(cfg => { cfg.spaces.find(s => s.id === A).meta = before_; });
    }
    // The follower met the other form and marked the index stale: a rebuild is what makes it ready again (design-r2 R3).
    assert.equal((await d.col(`${A}_rdf_state`).findOne({ _id: 'state' })).status, 'stale', 'the index built for another form is stale');
    assert.equal((await (await rebuildModule()).rebuildTripleIndex(A)).outcome, 'built');
    await followUntilReady(d, A);
    readAll(await alike('its revert', ['fixed 1 type match', 'fixed 8 OPTIONAL', 'every statement']), A, 'index', 'its revert');
  });

  it('a delete a 5.6 build makes through its own client answers alike once the re-upgrade detector has run', async () => {
    const owed = await import('../../server/dist/sync/positions-owed.js');
    // The driver's own client is not the server's door: no journal row, no tombstone, no position (what a 5.6 build writes).
    const raw = await openFixtureMongo('b273-tixe');
    try {
      await raw.col(d.spaceCollection(A, 'entities')).deleteOne({ _id: 'product29' });
      // The counter moved under a 5.6 allocation (`seq` above `seqSeenBy6`), which the detector reads as a re-upgrade of the space.
      await raw.col('ythril_counters').updateOne({ _id: A }, { $set: { seq: 987654, seqSeenBy6: 1, positionsReadyAt: '2026-10-01T00:00:00.000Z' }, $unset: { positionsOwed: '' } }, { upsert: true });
    } finally { await raw.close(); }
    await d.loader.mutateConfig((cfg) => { cfg.positionsSince ??= '2026-10-01T00:00:00.000Z'; });
    await owed.detectReupgrade();
    assert.equal((await d.col('ythril_counters').findOne({ _id: A })).positionsOwed, 'repair', 'the detector found the space');
    readAll(await alike('a delete a 5.6 build made', ['BSBM Q1', 'every statement', 'fixed 9 aggregate']), A, 'records', 'a delete a 5.6 build made');
    // Its edges still name it (they are records of their own); its own label is gone.
    assert.deepEqual((await answer(`SELECT ?n WHERE { ${e(A, 'product29')} <${RDFS}label> ?n }`, [A], false)).texts, [], 'the records no longer state the label of product29');
    assert.equal((await (await rebuildModule()).rebuildTripleIndex(A)).outcome, 'built');
    await followUntilReady(d, A);
    readAll(await alike('after the rebuild', ['BSBM Q1', 'every statement', 'fixed 9 aggregate']), A, 'index', 'after the rebuild');
    await d.col('ythril_counters').updateOne({ _id: A }, { $set: { positionsReadyAt: '2026-10-01T00:00:00.000Z' }, $unset: { positionsOwed: '' }, $max: { seqSeenBy6: 987654 } });
  });

  it('a lagging member answers alike', async () => {
    const was = await bendState(d, B, { appliedPos: 0 });
    await holdLease(d, B);
    try {
      const paths = await alike('a lagging member', ['second member', 'fixed 7b both members by label']);
      assert.ok(paths.some(p => p.space === B && p.path === 'records'), 'the lagging member is read from its records');
    } finally { await restore(d, B, was); }
  });
});
