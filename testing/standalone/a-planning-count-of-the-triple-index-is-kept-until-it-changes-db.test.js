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
 * - **A count that keeps the query's text, or outlives its space (fix round A, L3.2).** The key holds a hash of the pattern, never a bound
 *   term's text; a deleted space's counts go with it; every lookup is counted (`ythril_cache_lookups_total{cache="planning_count",result}`)
 *   and the entries held are a gauge (`ythril_cache_entries{cache="planning_count"}`) (L2.2).
 *
 * ## Seen red
 *
 * On d97660409 the second run of the same query counts `rdf_quads` again (an `aggregate` of the quads collection per free pattern). On
 * f91569511 the key is `JSON.stringify([space, build, writes, files, the bound terms' keys])`, so a pattern's IRI is in it; the counts of a
 * deleted space stay; and no metric of these counts exists.
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

/** The count the source gives the engine for `?s <iri> ?o` now (a quad source of its own, so nothing is kept for the query). */
async function predicateCount(iri) {
  const { createQuadSource } = await import('../../server/dist/rdf/quad-source.js');
  const source = createQuadSource({ members: [S], caller: { id: 'tixc', admin: true, rights: { instanceAdmin: true } } }, { deadline: Date.now() + 60_000 });
  return source.countQuads(undefined, DataFactory.namedNode(iri), undefined, undefined);
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

  it('a count is kept under a hash: the text of the pattern asked is in no key', async () => {
    const kept = await import('../../server/dist/rdf/triple-index/kept-counts.js').catch(() => null);
    assert.ok(kept?.keptCountKeys, 'there is no kept-counts module (server/dist/rdf/triple-index/kept-counts.js, keptCountKeys)');
    // Only a predicate the space's records state is counted over the index (an address no record uses is told 0 with no count), so the pattern's
    // text is the label predicate's address.
    assert.ok(await predicateCount(LABEL) >= 1, 'fixture: the label pattern was not counted over the index');
    const keys = kept.keptCountKeys();
    assert.ok(keys.length > 0, 'the count was not kept, so the case proves nothing');
    assert.deepEqual(keys.filter(k => k.includes('rdf-schema') || k.includes('w3.org')), [], 'a kept count\'s key holds the text of the pattern asked');
    assert.deepEqual(keys.filter(k => k.length > 200), [], 'a kept count\'s key is longer than a hash and a space name');
  });

  it('every lookup of the counts is counted, hit or miss, and the entries held are a gauge', async () => {
    const { register } = await import('../../server/dist/metrics/registry.js');
    const series = async () => {
      const out = { hit: null, miss: null, entries: null };
      for (const line of (await register.metrics()).split('\n')) {
        const n = Number(line.slice(line.lastIndexOf(' ') + 1));
        if (/^ythril_cache_lookups_total\{[^}]*cache="planning_count"/.test(line)) out[/result="(hit|miss)"/.exec(line)?.[1]] = n;
        if (/^ythril_cache_entries\{[^}]*cache="planning_count"/.test(line)) out.entries = n;
      }
      return out;
    };
    const before = await series();
    assert.notEqual(before.hit, null, 'ythril_cache_lookups_total{cache="planning_count",result="hit"} is not declared');
    assert.notEqual(before.miss, null, 'ythril_cache_lookups_total{cache="planning_count",result="miss"} is not declared');
    assert.notEqual(before.entries, null, 'ythril_cache_entries{cache="planning_count"} is not declared');
    // The type pattern was last counted before the ten statements the index took above; at this write counter it is counted for the first time.
    const probe = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    await predicateCount(probe);
    await predicateCount(probe);
    const after = await series();
    assert.equal(after.miss, before.miss + 1, 'the first count of a pattern is one miss');
    assert.equal(after.hit, before.hit + 1, 'its repeat is one hit');
    assert.equal(after.entries, before.entries + 1, 'the count the miss kept is counted in the gauge');
  });

  it('the counts of a deleted space are dropped with it', async () => {
    const kept = await import('../../server/dist/rdf/triple-index/kept-counts.js').catch(() => null);
    assert.ok(kept?.keptCountKeys, 'there is no kept-counts module');
    await labelCount();
    assert.ok(kept.keptCountKeys().length > 0, 'fixture: no count was kept, so its removal proves nothing');
    const { removeSpace } = await import('../../server/dist/spaces/lifecycle.js');
    assert.equal(await removeSpace(S), true, 'fixture: the space was not removed');
    assert.deepEqual(kept.keptCountKeys(), [], 'a deleted space\'s planning counts outlived it, taking slots of the bounded cache');
  });

});
