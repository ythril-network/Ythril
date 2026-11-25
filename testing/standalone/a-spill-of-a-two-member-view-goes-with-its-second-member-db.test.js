/**
 * The read spill of a SPARQL answer over a view goes with ANY member space it holds rows of, not only the first (bundle-271, Q-757,
 * review m4; design r2 R3.7).
 *
 * ## The rule
 *
 * A SPARQL row of a view's answer is joined from several members and the spill keeps it as `{spaceId, members, row}`; the store derives the
 * spill's member list from `members` as well as `spaceId` (`spacesOf` in `brain/read-spill-store.ts`). So deleting the SECOND member of a
 * two-member view drops the spill, and `read_spill` no longer answers it, while a spill of a view that never held that member stays.
 * The space is dropped by `dropSpaceData`, the step of a real space delete (not by the store's own drop).
 *
 * ## Seen red
 *
 * A mutation of the store's `spacesOf` that reads `spaceId` only (the `members` loop removed): the spill of the view outlives its second
 * member, and `read_spill` still answers rows read from the deleted space.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-spill-of-a-two-member-view-goes-with-its-second-member-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors } from './_sparql-doors.mjs';

const skip = await mongoSkipReason();
const A = 'spq-cascade-a';
const B = 'spq-cascade-b';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const ENTITY_LABELS = `?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://w3id.org/ythril/ns#Entity> ; <${RDFS_LABEL}> ?n`;
const LABELS = `SELECT ?s ?n WHERE { ${ENTITY_LABELS} } ORDER BY ?n`;
const STAMP = '2026-03-04T05:06:07.000Z';

let d, tok;
const names = (prefix) => Array.from({ length: 20 }, (_, i) => ({ _id: `${prefix}-${String(i).padStart(2, '0')}`, name: `${prefix} ${String(i).padStart(2, '0')} ${'w'.repeat(60)}`, type: 'Person', createdAt: STAMP, updatedAt: STAMP }));
const headers = (id) => d.door.mongo.getDb().collection('_read_spills').find({ _id: id }).toArray();

/** A query over `view` cut by a small budget: the spill id of its cut rows. */
async function spillOf(view) {
  const m = await d.sparqlMcp(tok.key, { space: view, query: LABELS, maxChars: 2_000 });
  assert.ok(!m.isError, m.text.slice(0, 300));
  assert.equal(m.summary?.truncated, true, `the answer of ${view} was not cut: ${m.blocks[1]?.slice(0, 300)}`);
  const id = m.summary?.remainder?.spillId;
  assert.ok(id, `no spill for ${view}: ${JSON.stringify(m.summary).slice(0, 300)}`);
  return id;
}

describe('the spill of a two-member view goes with its second member', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'q757-cascade', spaces: [{ id: A }, { id: B }] });
    await d.seed(A, 'entity', names('a'));
    await d.seed(B, 'entity', names('b'));
    tok = await d.mint('spq-cascade', { [A]: d.row({ knowledge: 'read' }), [B]: d.row({ knowledge: 'read' }) });
  });
  after(async () => { await d?.close(); });

  it('deleting the second member drops the spill of the pair, and not the spill of a view without it', async () => {
    for (const [name, members] of [['spqpair', [A, B]], ['spqsolo', [A]]]) {
      const v = await d.rest(tok.key, 'POST', '/api/views', { name, members });
      assert.equal(v.status, 201, `POST /api/views ${name}: ${v.status} ${v.text.slice(0, 200)}`);
    }
    const pair = await spillOf('@spqpair');
    const solo = await spillOf('@spqsolo');
    const stored = (await headers(pair))[0];
    assert.deepEqual(stored?.memberSpaceIds, [A, B], 'the pair\'s spill names both members');
    const read = await d.toolCall(tok.key, 'read_spill', { id: pair });
    assert.ok(!read.isError, `before the delete: ${read.text.slice(0, 300)}`);

    const { dropSpaceData } = await import('../../server/dist/spaces/lifecycle.js');
    assert.deepEqual(await dropSpaceData(B), [], 'the delete of the second member reported errors');

    assert.deepEqual(await headers(pair), [], 'the spill of the pair outlived its second member');
    assert.equal((await headers(solo)).length, 1, 'the spill of a view without the deleted member was dropped too');
    const gone = await d.toolCall(tok.key, 'read_spill', { id: pair });
    assert.ok(gone.isError, `read_spill still answers the pair's spill: ${gone.text.slice(0, 300)}`);
  });
});
