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
 * 3. **F8: the spec can fail.** Rebuilds of unchanged records are byte-identical, so a mixed read answered alike. A record with a new term
 *    lands between the rebuilds and the term ids are asserted to move; a mixed read planted on purpose (the previous build's dictionary
 *    over this build's statements) answers something else than the records do.
 *
 * ## Seen red
 *
 * On 65080cae3 (no rebuild, no pin): both cases fail at the import of `server/dist/rdf/triple-index/rebuild.js` (ERR_MODULE_NOT_FOUND).
 *
 * Finding F8 (review of S4, base 42c51f330): the case that asks queries while the index is swapped again and again passed there whatever
 * the read did, so the pin check was planted away by hand (`read-across-swaps.ts` stopped asking `indexesSwapped`): that case still
 * passed (a query seldom meets a swap), and the case that holds a query's read of the statements across a swap failed at its answer (`[]`
 * against the 120 names of the records): that case is what fails a mixed read. The last case plants the mixed read in the data and needs the
 * comparison to tell it from the records' answer.
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

/** The live dictionary's rows; a term row keeps its key in `k`, or in `v` when the key is long. */
const dictionary = async () => await d.col(`${S}_rdf_terms`).find({}).toArray();
const idsOf = (rows) => Object.fromEntries(rows.map(t => [t.v ?? t.k, t._id]));

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
      // A record with a new term lands before each rebuild (its `_id` sorts before every person's): the build's term ids move, so a read
      // that mixed two builds would answer something else (finding F8: rebuilds of unchanged records are byte-identical).
      for (; n < 4; n++) {
        await landAll(d, S, [['entities', entityDoc(S, `a-robot-${n}`, `Robot ${n}`, 'robot')]]);
        await rebuildTripleIndex(S);
      }
      swapping = false;
      return n;
    })();
    // One at a time: the instance runs one query per caller (`503 sparql_busy` for a second).
    const answers = [];
    while (swapping) answers.push(await d.sparqlPost(admin.key, S, NAMES));
    assert.equal(await swaps, 4);
    assert.ok(answers.length >= 4, `queries were asked while the index was swapped: ${answers.length}`);
    for (const r of answers) {
      assert.equal(r.status, 200, r.text.slice(0, 300));
      assert.deepEqual(rowTexts(r.body), want, 'a query across a swap answers what the records answer');
    }
    await followUntilReady(d, S);
  });

  it('F8: a query holding its read of the statements while the index is swapped is answered from the records', async () => {
    const { rebuildTripleIndex } = await rebuildModule();
    const { getDb } = await import('../../server/dist/db/mongo.js');
    const want = rowTexts((await d.sparqlPost(admin.key, S, NAMES)).body);
    assert.equal(want.length, 120);
    const proto = Object.getPrototypeOf(getDb().collection('probe'));
    const original = proto.find;
    let reached; const held = new Promise(r => { reached = r; });
    let open; const gate = new Promise(r => { open = r; });
    let armed = true;
    // The first read of the statements of the index stops before its first row: the query has resolved its terms in the old build.
    proto.find = function holding(...args) {
      const cursor = original.apply(this, args);
      if (!armed || this.collectionName !== `${S}_rdf_quads`) return cursor;
      armed = false;
      const iterate = cursor[Symbol.asyncIterator].bind(cursor);
      cursor[Symbol.asyncIterator] = () => {
        reached();
        const inner = iterate();
        return { next: async () => { await gate; return inner.next(); }, return: (v) => inner.return?.(v) ?? Promise.resolve({ done: true, value: v }), [Symbol.asyncIterator]() { return this; } };
      };
      return cursor;
    };
    let answered;
    try {
      answered = d.sparqlPost(admin.key, S, NAMES);
      await held;
      // Meanwhile a build with other term ids is swapped in.
      await landAll(d, S, [['entities', entityDoc(S, 'a-robot-held', 'Robot Held', 'robot')]]);
      assert.equal((await rebuildTripleIndex(S)).outcome, 'built');
      open();
    } finally { open(); proto.find = original; }
    const r = await answered;
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.deepEqual(rowTexts(r.body), want, 'the query that straddled the swap answers what the records answer');
    await followUntilReady(d, S);
  });

  it('F8: the term ids move between builds, and a read that mixed two builds answers something else than the records', async () => {
    const { rebuildTripleIndex } = await rebuildModule();
    const want = rowTexts((await d.sparqlPost(admin.key, S, NAMES)).body);
    assert.equal(want.length, 120);
    const before = await dictionary();
    await landAll(d, S, [['entities', entityDoc(S, 'a-robot-moved', 'Robot Moved', 'robot')]]);
    assert.equal((await rebuildTripleIndex(S)).outcome, 'built');
    await followUntilReady(d, S);
    const after = idsOf(await dictionary());
    const was = idsOf(before);
    const kept = Object.keys(was).filter(k => k in after);
    assert.ok(kept.length > 100, `most terms stand in both builds: ${kept.length}`);
    assert.ok(kept.some(k => was[k] !== after[k]), 'a term of both builds has another id in the second: the builds are not alike');
    assert.deepEqual(rowTexts((await d.sparqlPost(admin.key, S, NAMES)).body), want, 'the index of the second build answers what the records answer');
    // Plant the mixed read: the first build's dictionary over the second build's statements, the state saying `ready` all the while.
    await d.col(`${S}_rdf_terms`).deleteMany({});
    await d.col(`${S}_rdf_terms`).insertMany(before);
    const planted = await d.sparqlPost(admin.key, S, NAMES);
    const texts = planted.status === 200 ? rowTexts(planted.body) : null;
    assert.notDeepEqual(texts, want, 'a mixed read answers something else: the comparison of these cases can fail');
    assert.equal((await rebuildTripleIndex(S)).outcome, 'built');
    await followUntilReady(d, S);
  });
});
