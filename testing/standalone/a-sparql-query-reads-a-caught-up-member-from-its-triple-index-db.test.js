/**
 * A SPARQL query reads a member from its triple index when that index is ready, of the member's form and caught up, and from the records
 * otherwise, with the same answer (bundle-273, Q-764 slice S3; contract rows 1, 2, 4).
 *
 * ## The rules
 *
 * 1. **A ready, caught-up member is read from its index.** While the query runs, no record collection of the member is read, and its
 *    `rdf_quads` collection is (the store's own command log is the probe, not a counter of the code under test).
 * 2. **Anything else reads the records.** A member whose index lags behind a visible record and cannot catch up (another process holds the
 *    follower's lease), whose index is `stale`, whose form key is not the member's form now, or that has a journal row still outstanding is
 *    read from its record collections, and answers alike.
 * 3. **Rights are the records path's.** A caller without `files: read` on the member reads no file statement from the index either.
 * 4. **The index read has its own cap.** `sparql.maxIndexRowsRead` set below the statements a query reads ends it with
 *    `413 sparql_too_much_read`; the same query under the default answers.
 *
 * ## Seen red
 *
 * On bcb4d7d63 (no index read): rule 1 fails at its first query (`find` commands on the record collections, none on `rdf_quads`); rule 4
 * fails at the config load (`sparql.maxIndexRowsRead` is an unknown key).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-sparql-query-reads-a-caught-up-member-from-its-triple-index-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta, baseOf, rowTexts } from './_sparql-doors.mjs';
import { landAll, followUntilReady, collectionsOf, readsOn, bendState, holdLease, restore, entityDoc } from './_triple-index-read.mjs';

const skip = await mongoSkipReason();
const S = 'tixr-member';
const SCHEMA = { entity: { person: { propertySchemas: { nick: { type: 'string' } } } } };
const NAMES = `SELECT ?n WHERE { ?s a <${baseOf(S)}vocab/entity/person> ; <http://www.w3.org/2000/01/rdf-schema#label> ?n } ORDER BY ?n`;

let d, admin, names;
const setLimits = (sparql) => d.loader.mutateConfig(cfg => { cfg.sparql = sparql; });

/** One query's answer and the store commands it sent. */
async function asked(key, query) {
  let r;
  const commands = await d.door.commandsDuring(async () => { r = await d.sparqlPost(key, S, query); });
  return { r, commands };
}

/** Assert the query read the records (and not only the index), and answered `want`. */
async function readsRecords(why, want) {
  const { r, commands } = await asked(admin.key, NAMES);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(rowTexts(r.body), want, `${why}: the records answer what the index answered`);
  const read = names.records.flatMap(c => readsOn(commands, c));
  assert.ok(read.length > 0, `${why}: the member is read from its records, yet no record collection was read (${commands.join('; ')})`);
}

describe('a SPARQL query reads a caught-up member from its triple index', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tixr', spaces: [{ id: S, meta: rdfMeta(S, { typeSchemas: SCHEMA }) }], monitorCommands: true });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    admin = await d.mint('tixr-admin', {}, { admin: true });
    const docs = [];
    for (let i = 0; i < 150; i++) docs.push(['entities', entityDoc(S, `p${i}`, `Person ${String(i).padStart(3, '0')}`, 'person', { nick: `n${i}` })]);
    docs.push(['files', { _id: 'docs/a.txt', spaceId: S, path: 'docs/a.txt', sizeBytes: 12, sha256: 'ab'.repeat(32), createdAt: '2026-03-04T05:06:07.000Z', updatedAt: '2026-03-04T05:06:07.000Z', tags: ['f'], seq: 1 }]);
    await landAll(d, S, docs);
    await followUntilReady(d, S);
    names = await collectionsOf(d, S);
  });
  after(async () => { await d?.close(); });

  it('a ready, caught-up member is read from its index and not from its records', async () => {
    const { r, commands } = await asked(admin.key, NAMES);
    assert.equal(r.status, 200, r.text);
    assert.equal(rowTexts(r.body).length, 150, 'every person is named once');
    const recordReads = names.records.flatMap(c => readsOn(commands, c));
    assert.deepEqual(recordReads, [], `no record collection is read for a member whose index is caught up: ${commands.join('; ')}`);
    assert.ok(readsOn(commands, names.quads).length > 0, `the member's statements are read from ${names.quads}: ${commands.join('; ')}`);
  });

  it('a lagging member that cannot catch up, a stale one, one of another form and one with a journal row outstanding read the records', async () => {
    const want = rowTexts((await d.sparqlPost(admin.key, S, NAMES)).body);
    assert.equal(want.length, 150);

    let was = await bendState(d, S, { appliedPos: 0 });
    await holdLease(d, S);
    try { await readsRecords('a lagging member whose follower another process holds', want); } finally { await restore(d, S, was); }

    was = await bendState(d, S, { status: 'stale' });
    try { await readsRecords('a stale member', want); } finally { await restore(d, S, was); }

    was = await bendState(d, S, { formKey: 'another-form' });
    try { await readsRecords('a member indexed for another form', want); } finally { await restore(d, S, was); }

    await d.col(`${S}_rdf_dirty`).insertOne({ _id: 'tixr-open-write', key: 'entity:p1', done: false, at: Date.now() });
    try { await readsRecords('a member with a journal row outstanding', want); } finally { await d.col(`${S}_rdf_dirty`).deleteOne({ _id: 'tixr-open-write' }); }

    // Put back, the member is read from its index again.
    const { commands } = await asked(admin.key, NAMES);
    assert.deepEqual(names.records.flatMap(c => readsOn(commands, c)), [], 'the member caught up is read from its index again');
  });

  it('a caller without files: read reads no file statement from the index', async () => {
    const reader = await d.mint('tixr-knowledge-only', { [S]: d.row({ knowledge: 'read' }) });
    const FILES = `SELECT DISTINCT ?s WHERE { ?s ?p ?o FILTER(STRSTARTS(STR(?s), "${baseOf(S)}file/")) }`;
    const all = await d.sparqlPost(admin.key, S, FILES);
    assert.equal(all.status, 200, all.text);
    assert.ok(rowTexts(all.body).length > 0, `the admin reads the file statements: ${all.text.slice(0, 300)}`);
    let r;
    const commands = await d.door.commandsDuring(async () => { r = await d.sparqlPost(reader.key, S, FILES); });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(rowTexts(r.body), [], 'a caller without files: read is answered no file statement');
    assert.deepEqual(names.records.flatMap(c => readsOn(commands, c)), [], `and it was answered from the index: ${commands.join('; ')}`);
  });

  it('sparql.maxIndexRowsRead below what a query reads ends it with 413 sparql_too_much_read', async () => {
    const ALL = 'SELECT ?s ?p ?o WHERE { ?s ?p ?o }';
    await setLimits({ maxIndexRowsRead: 1_000 });
    try {
      const over = await d.sparqlPost(admin.key, S, ALL);
      assert.equal(over.status, 413, over.text);
      assert.equal(over.body?.code, 'sparql_too_much_read', over.text);
    } finally { await setLimits(undefined); }
    const fits = await d.sparqlPost(admin.key, S, ALL);
    assert.equal(fits.status, 200, fits.text.slice(0, 300));
    assert.ok(rowTexts(fits.body).length > 1_000, `the query refused reads more than 1 000 statements: ${rowTexts(fits.body).length}`);
  });
});
