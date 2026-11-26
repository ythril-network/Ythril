/**
 * A bind join over a member read from its triple index looks its bindings up in batches: a hundred bindings of one join take one find of
 * the index, and their ids are turned back into terms in batches (bundle-273, Q-764 slice S3; design-r2 R8; contract row 5).
 *
 * ## The rule
 *
 * Comunica 5.5.0's bind join asks its source for one binding at a time, at most four at once (the `MultiTransformIterator` default,
 * asynciterator.js:856): a hundred bindings were a hundred finds. Over the index, the join hands its source up to 100 bindings at once, and
 * the source answers them with one find of `rdf_quads`; the terms of the rows it read are looked up in `rdf_terms` together, once per query.
 *
 * The query joins 100 probe entities (`?e a <Probe>`, the small side) with every label of the space (2 400 more entities, so the large side
 * is more than twenty times the small one and the engine binds rather than hashes). The store's own command log counts the finds.
 *
 * ## Seen red
 *
 * On bcb4d7d63 (no index read): no find reaches `rdf_quads` at all; the join reads the record collections once per binding.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-sparql-join-looks-up-a-hundred-bindings-in-one-find-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta, baseOf, rowTexts } from './_sparql-doors.mjs';
import { landAll, followUntilReady, collectionsOf, findsOn, readsOn, entityDoc } from './_triple-index-read.mjs';
import { rebuildModule } from './_triple-index-rebuild.mjs';

const skip = await mongoSkipReason();
const S = 'tixj-join';
const SCHEMA = { entity: { probe: { propertySchemas: {} }, filler: { propertySchemas: {} } } };

let d, admin, names;

describe('a SPARQL join looks up a hundred bindings in one find', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tixj', spaces: [{ id: S, meta: rdfMeta(S, { typeSchemas: SCHEMA }) }], monitorCommands: true });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    admin = await d.mint('tixj-admin', {}, { admin: true });
    const docs = [];
    for (let i = 0; i < 100; i++) docs.push(['entities', entityDoc(S, `probe${i}`, `Probe ${String(i).padStart(3, '0')}`, 'probe')]);
    for (let i = 0; i < 2_400; i++) docs.push(['entities', entityDoc(S, `fill${i}`, `Filler ${i}`, 'filler')]);
    await landAll(d, S, docs);
    // An index no rebuild wrote is never read (review finding G1): the rebuild makes it.
    assert.equal((await (await rebuildModule()).rebuildTripleIndex(S)).outcome, 'built');
    await followUntilReady(d, S);
    names = await collectionsOf(d, S);
  });
  after(async () => { await d?.close(); });

  it('100 bindings of one join are looked up with one find of the index', async () => {
    const q = `SELECT ?e ?n WHERE { ?e a <${baseOf(S)}vocab/entity/probe> . ?e <http://www.w3.org/2000/01/rdf-schema#label> ?n }`;
    let r;
    const commands = await d.door.commandsDuring(async () => { r = await d.sparqlPost(admin.key, S, q); });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    const rows = rowTexts(r.body);
    assert.equal(rows.length, 100, 'every probe is answered with its label');
    assert.ok(rows.every(t => /n=literal:Probe \d{3}/.test(t)), `each row binds a probe's label: ${rows.slice(0, 3).join(' | ')}`);
    const quadFinds = findsOn(commands, names.quads);
    assert.ok(quadFinds.length >= 1, `the join reads the index: ${commands.join('; ')}`);
    // One find for the small side, one for the hundred bindings, one more at most for a page the planner reads to size a side.
    assert.ok(quadFinds.length <= 3, `the hundred bindings take one find, not one each: ${quadFinds.length} finds of ${names.quads}`);
    const termFinds = findsOn(commands, names.terms);
    // A term lookup per binding would be a hundred or more; the planner's counts, each side's first page and the batch take a handful.
    assert.ok(termFinds.length <= 10, `the ids are turned back into terms in batches: ${termFinds.length} finds of ${names.terms}`);
    assert.deepEqual(names.records.flatMap(c => readsOn(commands, c)), [], 'no record collection is read');

    // The join bound its large side (a hash join would read every label: 2 500 rows and more): read in this process, the source counts the
    // index rows the query read: the hundred probes' types and their hundred labels.
    const engine = await import('../../server/dist/rdf/sparql-engine.js');
    const { createQuadSource } = await import('../../server/dist/rdf/quad-source.js');
    const checked = await engine.checkSparqlAlgebra(q);
    const deadline = Date.now() + 60_000;
    const source = createQuadSource({ members: [S], caller: { id: 'tixj', admin: true, rights: { instanceAdmin: true } } }, { deadline });
    const bound = await (await engine.runSparql(checked.algebra, source, { deadline })).rows(1_000);
    assert.equal(bound.length, 100);
    assert.ok(source.indexRowsRead() >= 200 && source.indexRowsRead() < 1_000, `the label side was read for the hundred bindings only: ${source.indexRowsRead()} index rows read`);
  });
});
