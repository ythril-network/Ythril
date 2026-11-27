/**
 * A batched read of a triple index holds at most one page of quad rows at once, however many rows its patterns match (bundle-273, Q-764,
 * pre-ship lens finding P1; contract row 1).
 *
 * ## The rule
 *
 * `matchMany` answers up to a hundred patterns of a join with one find of `rdf_quads`. It collected every row of that find (up to
 * `sparql.maxIndexRowsRead`, 4 000 000 by default) in one array and built a quad for each, so one join step held millions of rows per
 * concurrent query. It now reads the find in pages of at most `rowsPerCall` rows (100 000 by default), fits each page to the patterns and
 * lets it go, so the rows held at once never pass the page. What it answers does not change, and every row of every page counts against
 * the query's row cap, so the cap still ends a query whose pages add up past it.
 *
 * ## The cases
 *
 * 1. A free pattern and a label pattern over 1 500 people, read with `rowsPerCall` 100: the answers equal those of the default read, no
 *    more than 100 rows are held at once (`peakRowsHeld`), and the default read held more (so the bound is what held it).
 * 2. The same read with a cap one row under the rows it reads ends `too much`; with the cap at the rows it reads it answers, and
 *    `rowsRead` is the rows it read: the pages count across the whole call.
 *
 * ## Seen red
 *
 * On a075fa803: the answers are equal and the cap counts (both are the old behaviour), and the held-rows case fails first:
 * `read.peakRowsHeld is not a function`.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-batched-index-read-holds-a-bounded-page-of-rows-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta, baseOf } from './_sparql-doors.mjs';
import { landAll, followUntilReady, collectionsOf, entityDoc } from './_triple-index-read.mjs';
import { rebuildModule } from './_triple-index-rebuild.mjs';

const skip = await mongoSkipReason();
const S = 'tixp-page';
const PEOPLE = 1_500;
const PAGE = 100;
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
let d, read, N3, rowsInIndex;

const named = (value) => ({ termType: 'NamedNode', value });
const variable = (value) => ({ termType: 'Variable', value });
const graph = () => N3.DataFactory.namedNode(baseOf(S));
const PATTERNS = [[variable('s'), variable('p'), variable('o')], [variable('s'), named(LABEL), variable('o')]];

/** A reader over the index of S; `cap` and `extra` as the query source sets them. */
function reader(extra = {}) {
  return new read.IndexRead({ cap: 4_000_000, deadline: Date.now() + 120_000, check: () => undefined, tooMuch: () => new Error('too much'), ...extra });
}
const texts = (answers) => answers.map(quads => quads.map(q => `${q.subject.value} ${q.predicate.value} ${q.object.value}`).sort().join('\n'));

describe('a batched index read holds a bounded page of rows', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tixp-page', spaces: [{ id: S, meta: rdfMeta(S) }] });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    await landAll(d, S, Array.from({ length: PEOPLE }, (_, i) => ['entities', entityDoc(S, `p${i}`, `Person ${i}`, 'person')]));
    assert.equal((await (await rebuildModule()).rebuildTripleIndex(S)).outcome, 'built');
    await followUntilReady(d, S);
    rowsInIndex = await d.col((await collectionsOf(d, S)).quads).countDocuments({});
    read = await import('../../server/dist/rdf/triple-index/read.js');
    N3 = await import('n3');
  });
  after(async () => { await d?.close(); });

  it('reads a page of rows at a time, holds no more than a page, and answers what the unpaged read answers', async () => {
    assert.ok(rowsInIndex > 10 * PAGE, `the index holds many pages of rows: ${rowsInIndex}`);
    const free = reader();
    const want = texts(await free.matchMany(S, true, graph(), PATTERNS));
    assert.ok(want[0].split('\n').length >= rowsInIndex - 1, 'the free pattern answers every statement');
    const paged = reader({ rowsPerCall: PAGE });
    assert.deepEqual(texts(await paged.matchMany(S, true, graph(), PATTERNS)), want, 'the paged read answers the same statements for each pattern');
    assert.equal(paged.rowsRead(), free.rowsRead(), 'both read the same rows');
    assert.ok(paged.peakRowsHeld() <= PAGE, `no more than ${PAGE} rows are held at once: ${paged.peakRowsHeld()}`);
    assert.ok(free.peakRowsHeld() > PAGE, `the default page is larger than the read here, so the bound is what held it: ${free.peakRowsHeld()}`);
  });

  it('counts the rows of every page against the query cap', async () => {
    const all = reader({ rowsPerCall: PAGE });
    await all.matchMany(S, true, graph(), PATTERNS);
    const rows = all.rowsRead();
    assert.equal(rows, rowsInIndex, 'the call read every row of the index, page after page');
    await assert.rejects(reader({ rowsPerCall: PAGE, cap: rows - 1 }).matchMany(S, true, graph(), PATTERNS), /too much/);
    assert.equal((await reader({ rowsPerCall: PAGE, cap: rows }).matchMany(S, true, graph(), PATTERNS)).length, PATTERNS.length);
  });
});
