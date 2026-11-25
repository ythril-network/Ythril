/**
 * A SPARQL answer holds only what its caller may read, and says what it left out where a standard client is not misled by it (bundle-271,
 * Q-757; design r2 R1.1, R1.2).
 *
 * ## The rules
 *
 * 1. **Files.** A token without `files: read` is answered no statement of a file row, on REST `GET`, REST `POST` and MCP alike, and is told
 *    so: the header `X-Ythril-File-Triples-Withheld` names the member on REST, `warnings` on MCP. A token with `files: read` gets the file
 *    statements and no such word.
 * 2. **Members left out.** A view whose member has RDF off answers from the other members, naming the one left out in
 *    `X-Ythril-Members-Left-Out` (MCP: `warnings`); the result body itself carries no extra key. The space alone answers the export's own
 *    refusal for it (`409 rdf_not_enabled`).
 *
 * ## Seen red
 *
 * On db66e206d no route answers `/api/brain/spaces/:spaceId/sparql` (404) and no tool `sparql_query` exists. Mutation: dropping the files
 * predicate of the quad source (`member.files` in `findsOf`): the file statement reaches the knowledge-only token on every door.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-sparql-answer-withholds-what-the-caller-cannot-read-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, baseOf, MEMBERS_LEFT_OUT, FILE_TRIPLES_WITHHELD } from './_sparql-doors.mjs';

const skip = await mongoSkipReason();
const R = 'spq-rights';
const OFF = 'spq-rights-off';
const FILE_PATH = 'docs/plan.txt';
const ALL = 'SELECT ?s ?p ?o WHERE { ?s ?p ?o }';
const STAMP = '2026-03-04T05:06:07.000Z';

let d, filesTok, knowledgeTok;
const fmt = (a) => `${a.status} ${(a.text ?? '').slice(0, 300)}`;
const fileRows = (body) => (body?.results?.bindings ?? []).filter(b => b.s?.value?.startsWith(`${baseOf(R)}file/`));

describe('a SPARQL answer withholds what the caller cannot read, and says so', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'q757-rights', spaces: [{ id: R }, { id: OFF, meta: { suppressEmbeddings: true } }] });
    await d.seed(R, 'entity', [{ _id: 'e-ada', name: 'Ada', type: 'Person', createdAt: STAMP, updatedAt: STAMP }]);
    await d.seed(R, 'file', [{ _id: FILE_PATH, path: FILE_PATH, sizeBytes: 42, sha256: 'ab'.repeat(32), description: 'a plan', createdAt: STAMP, updatedAt: STAMP }]);
    await d.seed(OFF, 'entity', [{ _id: 'off-1', name: 'Off', type: 'Person', createdAt: STAMP, updatedAt: STAMP }]);
    filesTok = await d.mint('spq-files', { [R]: d.row({ knowledge: 'read', files: 'read' }), [OFF]: d.row({ knowledge: 'read', files: 'read' }) });
    knowledgeTok = await d.mint('spq-knowledge', { [R]: d.row({ knowledge: 'read' }), [OFF]: d.row({ knowledge: 'read' }) });
  });
  after(async () => { await d?.close(); });

  it('a token with files: read gets the file statements and no withheld word', async () => {
    const a = await d.sparqlGet(filesTok.key, R, ALL);
    assert.equal(a.status, 200, fmt(a));
    assert.ok(fileRows(a.body).length > 0, 'the file row\'s statements are missing for a token that reads files');
    assert.equal(a.headers[FILE_TRIPLES_WITHHELD], undefined, 'the header names a member whose files the caller reads');
    const m = await d.sparqlMcp(filesTok.key, { space: R, query: ALL });
    assert.ok(!m.isError, m.text.slice(0, 300));
    assert.ok(fileRows(m.body).length > 0, 'MCP: the file statements are missing');
    assert.equal(m.summary?.warnings, undefined, 'MCP warns of nothing withheld');
  });

  it('a knowledge-only token gets no file statement on REST GET, REST POST and MCP, and is told on each', async () => {
    const get = await d.sparqlGet(knowledgeTok.key, R, ALL);
    const post = await d.sparqlPost(knowledgeTok.key, R, ALL);
    for (const [door, a] of [['GET', get], ['POST', post]]) {
      assert.equal(a.status, 200, `${door}: ${fmt(a)}`);
      assert.ok(a.body.results.bindings.length > 0, `${door}: the entity's statements are missing`);
      assert.deepEqual(fileRows(a.body), [], `${door}: a file statement reached a token without files: read`);
      assert.equal(a.headers[FILE_TRIPLES_WITHHELD], R, `${door}: ${FILE_TRIPLES_WITHHELD}`);
    }
    const m = await d.sparqlMcp(knowledgeTok.key, { space: R, query: ALL });
    assert.ok(!m.isError, m.text.slice(0, 300));
    assert.deepEqual(fileRows(m.body), [], 'MCP: a file statement reached a token without files: read');
    assert.deepEqual(m.summary?.warnings, [{ code: 'file_triples_withheld', members: [R] }], 'MCP warnings');
    assert.deepEqual(m.structured?.warnings, m.summary?.warnings, 'MCP structured half warns alike');
  });

  it('a view with an RDF-off member answers from the others and names it; the space alone answers 409 rdf_not_enabled', async () => {
    const view = await d.rest(filesTok.key, 'POST', '/api/views', { name: 'spqmix', members: [R, OFF] });
    assert.equal(view.status, 201, `POST /api/views: ${view.status} ${view.text.slice(0, 200)}`);
    const a = await d.sparqlGet(filesTok.key, '@spqmix', ALL);
    assert.equal(a.status, 200, fmt(a));
    assert.equal(a.headers[MEMBERS_LEFT_OUT], OFF, MEMBERS_LEFT_OUT);
    assert.ok(a.body.results.bindings.some(b => b.s.value === `${baseOf(R)}entity/e-ada`), 'the RDF member\'s statements are missing');
    assert.equal(Object.keys(a.body).sort().join(','), 'head,results', 'the result body carries a key of its own');
    const m = await d.sparqlMcp(filesTok.key, { space: '@spqmix', query: ALL });
    assert.ok(!m.isError, m.text.slice(0, 300));
    assert.deepEqual(m.summary?.warnings, [{ code: 'members_left_out', members: [OFF] }], 'MCP warnings');
    const alone = await d.sparqlGet(filesTok.key, OFF, ALL);
    assert.equal(alone.status, 409, fmt(alone));
    assert.equal(alone.body?.code, 'rdf_not_enabled');
    const aloneMcp = await d.sparqlMcp(filesTok.key, { space: OFF, query: ALL });
    assert.ok(aloneMcp.isError && aloneMcp.text.includes('rdf_not_enabled'), `MCP alone: ${aloneMcp.text.slice(0, 300)}`);
  });
});
