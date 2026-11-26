/**
 * The engine's planning count of a pattern read from a member's triple index costs the store nothing while the index has not changed, and
 * is never 0 while the pattern has statements (bundle-378, Q-976 S2, contract row 3).
 *
 * ## The rule
 *
 * The engine asks the source to count each pattern whose subject and object are both free before it plans a join. Over the index that was a
 * term lookup and a count of `rdf_quads` per pattern, per query, and repeated within a query: BSBM Q1 paid forty round trips, most of them
 * counts. A count is now kept under the index's write counter (`writes` on the state row, contract row 1) and reused while the state row
 * reads that counter, so a query whose patterns were counted before sends no count at all.
 *
 * ## What it must not lose
 *
 * - **A false 0.** The engine skips a pattern it is told is empty, which drops answers. A pattern with statements answers at least 1,
 *   counted or kept.
 * - **A count of an index that changed.** A write the follower applied raises the counter, so the next count is made again: the kept
 *   count of a predicate grows with the statements added.
 *
 * ## Seen red
 *
 * On d97660409 the second run of the same query counts `rdf_quads` again (an `aggregate` of the quads collection per free pattern).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-planning-count-of-the-triple-index-is-kept-until-it-changes-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DataFactory } from 'n3';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta, rowTexts } from './_sparql-doors.mjs';
import { landAll, followUntilReady, collectionsOf, entityDoc } from './_triple-index-read.mjs';
import { rebuildModule } from './_triple-index-rebuild.mjs';

const skip = await mongoSkipReason();
const S = 'tixc-counts';
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const QUERY = `SELECT ?e ?n ?t WHERE { ?e <${LABEL}> ?n . ?e a ?t }`;

let d, admin, names;

/** The count the source gives the engine for `?s <label> ?o` now, in this process. */
async function labelCount() {
  const { createQuadSource } = await import('../../server/dist/rdf/quad-source.js');
  const source = createQuadSource({ members: [S], caller: { id: 'tixc', admin: true, rights: { instanceAdmin: true } } }, { deadline: Date.now() + 60_000 });
  const n = await source.countQuads(undefined, DataFactory.namedNode(LABEL), undefined, undefined);
  assert.deepEqual(source.readPaths(), [{ space: S, path: 'index' }], 'the count is made over the index');
  return n;
}

describe('a planning count of the triple index is kept until it changes', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b378-tixc', spaces: [{ id: S, meta: rdfMeta(S) }], monitorCommands: true });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    admin = await d.mint('tixc-admin', {}, { admin: true });
    const docs = [];
    for (let i = 0; i < 20; i++) docs.push(['entities', entityDoc(S, `c${i}`, `Counted ${i}`, 'thing')]);
    await landAll(d, S, docs);
    assert.equal((await (await rebuildModule()).rebuildTripleIndex(S)).outcome, 'built');
    await followUntilReady(d, S);
    names = await collectionsOf(d, S);
  });
  after(async () => { await d?.close(); });

  it('a query run again counts nothing of the index', async () => {
    const first = await d.sparqlPost(admin.key, S, QUERY);
    assert.equal(first.status, 200, first.text.slice(0, 300));
    let again;
    const commands = await d.door.commandsDuring(async () => { again = await d.sparqlPost(admin.key, S, QUERY); });
    assert.equal(again.status, 200, again.text.slice(0, 300));
    assert.deepEqual(rowTexts(again.body).sort(), rowTexts(first.body).sort(), 'the second run answers what the first did');
    const counts = commands.filter(c => c === `aggregate ${names.quads}` || c === `count ${names.quads}`);
    assert.deepEqual(counts, [], `the second run counts the index again: ${commands.join('; ')}`);
  });

  it('the count is never 0 while the pattern has statements, and follows a write the index applied', async () => {
    const before = await labelCount();
    assert.ok(before >= 20, `the label pattern counts its twenty statements: ${before}`);
    assert.equal(await labelCount(), before, 'a kept count answers what the count did');
    const more = [];
    for (let i = 20; i < 30; i++) more.push(['entities', entityDoc(S, `c${i}`, `Counted ${i}`, 'thing')]);
    await landAll(d, S, more);
    await followUntilReady(d, S);
    const after = await labelCount();
    assert.ok(after >= before + 10, `the count follows the ten statements the index applied: ${before} then ${after}`);
  });

  it('a pattern with statements is never told 0, even under a kept count', async () => {
    // A predicate whose statements are all gone answers 0 only when no find can answer it; a pattern that has rows answers at least 1.
    for (let i = 0; i < 3; i++) assert.ok(await labelCount() >= 1, 'a pattern with statements answers at least 1');
  });
});
