/**
 * A query pins the build of each member it reads from an index and checks it again at its end; a member whose index was swapped meanwhile
 * is read again from its records, so the answer is the records' (bundle-273, Q-764 slice S4; design-r2 R5; contract row 2).
 *
 * ## The rules
 *
 * 1. **The pin is checked.** A quad source that read a member from its index answers no swapped member while the build is the same, and
 *    names the member once a rebuild swapped its index (`indexesSwapped`). A source told to read that member from its records
 *    (`recordsFor`) reads its records and answers alike.
 * 2. **The door answers the records' answer across swaps.** Queries asked while the index is rebuilt and swapped again and again all
 *    answer 200 with the answer the records give.
 *
 * ## Seen red
 *
 * On 65080cae3 (no rebuild, no pin): both cases fail at the import of `server/dist/rdf/triple-index/rebuild.js` (ERR_MODULE_NOT_FOUND).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-sparql-query-across-a-triple-index-swap-reads-the-records-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta, baseOf, rowTexts } from './_sparql-doors.mjs';
import { landAll, followUntilReady, entityDoc } from './_triple-index-read.mjs';
import { rebuildModule } from './_triple-index-rebuild.mjs';

const skip = await mongoSkipReason();
const S = 'tixb-swap';
const ADMIN = { id: 'tixb-swap-admin', admin: true, rights: { instanceAdmin: true } };
const NAMES = `SELECT ?n WHERE { ?s a <${baseOf(S)}vocab/entity/person> ; <http://www.w3.org/2000/01/rdf-schema#label> ?n } ORDER BY ?n`;
let d, admin;

/** Run `text` on a fresh quad source over S (`opts` its options) and answer the source and the sorted label texts. */
async function runOn(text, opts = {}) {
  const engine = await import('../../server/dist/rdf/sparql-engine.js');
  const { createQuadSource } = await import('../../server/dist/rdf/quad-source.js');
  const checked = await engine.checkSparqlAlgebra(text);
  const deadline = Date.now() + 60_000;
  const source = createQuadSource({ members: [S], caller: ADMIN }, { deadline, ...opts });
  const result = await engine.runSparql(checked.algebra, source, { deadline });
  const rows = await result.rows(100_000, 64 * 1024 * 1024);
  assert.equal(source.failure(), null, `the query read without a refusal: ${source.failure()?.message}`);
  return { source, texts: rows.map(r => r.n.value).sort() };
}

describe('a SPARQL query across a triple index swap reads the records', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tixb-swap', spaces: [{ id: S, meta: rdfMeta(S) }] });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    admin = await d.mint('tixb-swap-admin', {}, { admin: true });
    const docs = [];
    for (let i = 0; i < 120; i++) docs.push(['entities', entityDoc(S, `p${i}`, `Person ${String(i).padStart(3, '0')}`, 'person')]);
    await landAll(d, S, docs);
    const { rebuildTripleIndex } = await rebuildModule();
    assert.equal((await rebuildTripleIndex(S)).outcome, 'built');
    await followUntilReady(d, S);
  });
  after(async () => { await d?.close(); });

  it('a source that read an index names the member once its index is swapped, and one told so reads the records', async () => {
    const { rebuildTripleIndex } = await rebuildModule();
    const first = await runOn(NAMES);
    assert.deepEqual(first.source.readPaths(), [{ space: S, path: 'index' }], 'the member is read from its index');
    assert.equal(first.texts.length, 120);
    assert.deepEqual(await first.source.indexesSwapped(), [], 'no swap while the build is the same');
    assert.equal((await rebuildTripleIndex(S)).outcome, 'built');
    assert.deepEqual(await first.source.indexesSwapped(), [S], 'the member whose index was swapped is named');
    const again = await runOn(NAMES, { recordsFor: [S] });
    assert.deepEqual(again.source.readPaths(), [{ space: S, path: 'records' }], 'the member named is read from its records');
    assert.deepEqual(again.texts, first.texts, 'and answers alike');
    await followUntilReady(d, S);
  });

  it('queries asked while the index is swapped again and again answer what the records answer', async () => {
    const { rebuildTripleIndex } = await rebuildModule();
    const want = rowTexts((await d.sparqlPost(admin.key, S, NAMES)).body);
    assert.equal(want.length, 120);
    let swapping = true;
    const swaps = (async () => {
      let n = 0;
      for (; n < 4; n++) await rebuildTripleIndex(S);
      swapping = false;
      return n;
    })();
    const answers = [];
    while (swapping) {
      const batch = await Promise.all(Array.from({ length: 4 }, () => d.sparqlPost(admin.key, S, NAMES)));
      answers.push(...batch);
    }
    assert.equal(await swaps, 4);
    assert.ok(answers.length >= 4, `queries were asked while the index was swapped: ${answers.length}`);
    for (const r of answers) {
      assert.equal(r.status, 200, r.text.slice(0, 300));
      assert.deepEqual(rowTexts(r.body), want, 'a query across a swap answers what the records answer');
    }
    await followUntilReady(d, S);
  });
});
