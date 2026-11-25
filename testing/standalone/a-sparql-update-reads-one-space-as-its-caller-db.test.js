/**
 * A SPARQL Update's WHERE reads one space, the one it changes, with its caller's rights exactly as a query's, and the read is recorded record
 * by record so a record that changed under the evaluation is seen (bundle-272, Q-965; design r2 R5, vet-1 S6, vet-2 S8).
 *
 * ## The rules
 *
 * 1. **Files.** A token without `files: read` cannot copy a file's statements (its path, its description) into a record: the WHERE never
 *    sees a file row, and the change set says the files were withheld. A token with `files: read` can (the control).
 * 2. **One space.** The evaluation reads only the space it changes, even when the caller reads another space too; a GRAPH naming the other
 *    space is refused `400 sparql_graph_management_refused`.
 * 3. **Seqs.** The quad source records each record it reads with its `seq`; the change set carries them. A record read at two seqs in one
 *    evaluation is flagged a lost race, naming the record; two reads at one seq are not.
 *
 * ## Seen red
 *
 * On 3f48206ac: `server/src/rdf/sparql-update-eval.ts` does not exist, and the quad source exports no seq of what it read (`readRecords`,
 * `lostRace`). Mutations after: the file filter of the quad source's finds dropped (rule 1); `members` widened to every space the caller
 * reads (rule 2); the seq left out of the projection (rule 3).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-sparql-update-reads-one-space-as-its-caller-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { loadDistModule, needModule } from './_load-dist-module.mjs';
import { openRdfExportDoors, rdfMeta, baseOf } from './_rdf-export-doors.mjs';
import { drain } from './_quad-source-fixture.mjs';

const skip = await mongoSkipReason();
const A = 'qupd-own';
const B = 'qupd-other';
const FILE_PATH = 'docs/plan.txt';
const SECRET = 'OtherSpaceSecret';
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const COPIED = `${baseOf(A)}vocab/copied`;
const ADA = `${baseOf(A)}entity/e-ada`;
const named = (value) => ({ termType: 'NamedNode', value });

let d, evalMod, quadSource, filesCaller, knowledgeCaller;
const deadline = () => Date.now() + 60_000;

async function evaluate(text, caller) {
  const { evaluateSparqlUpdate } = needModule(evalMod, ['evaluateSparqlUpdate'], 'the update evaluation');
  return evaluateSparqlUpdate(text, { spaceId: A, caller }, { deadline: deadline() });
}

describe('a SPARQL Update reads one space as its caller', { skip }, () => {
  before(async () => {
    d = await openRdfExportDoors({ suite: 'q965-scope', spaces: [{ id: A, meta: rdfMeta(A) }, { id: B, meta: rdfMeta(B) }] });
    await d.seed(A, 'entity', [{ _id: 'e-ada', name: 'Ada', type: 'Person', seq: 7 }]);
    await d.seed(A, 'file', [{ _id: FILE_PATH, path: FILE_PATH, sizeBytes: 42, sha256: 'ab'.repeat(32), description: 'a plan', createdAt: '2026-01-02T03:04:05.000Z', updatedAt: '2026-01-02T03:04:05.000Z' }]);
    await d.seed(B, 'entity', [{ _id: 'b-1', name: SECRET, type: 'Person', seq: 3 }]);
    filesCaller = (await d.mint('qupd-files', { [A]: d.row({ knowledge: 'read', files: 'read' }), [B]: d.row({ knowledge: 'read', files: 'read' }) })).record;
    knowledgeCaller = (await d.mint('qupd-knowledge', { [A]: d.row({ knowledge: 'read' }) })).record;
    evalMod = await loadDistModule('../../server/dist/rdf/sparql-update-eval.js', import.meta.url);
    quadSource = await loadDistModule('../../server/dist/rdf/quad-source.js', import.meta.url);
  });
  after(async () => { await d?.close(); });

  const COPY_FILES = `INSERT { <${ADA}> <${COPIED}> ?o } WHERE { ?f ?p ?o FILTER(STRSTARTS(STR(?f), "${baseOf(A)}file/")) }`;

  it('a token without files: read cannot copy a file\'s statements into a record, and is told they were withheld', async () => {
    const got = await evaluate(COPY_FILES, knowledgeCaller);
    assert.equal(got.refusal, undefined, JSON.stringify(got.refusal));
    assert.deepEqual(got.changes.inserted, [], 'a file statement reached an Update of a token without files: read');
    assert.equal(got.changes.filesWithheld, true, 'the change set does not say the files were withheld');
  });

  it('a token with files: read copies them (the control)', async () => {
    const got = await evaluate(COPY_FILES, filesCaller);
    assert.equal(got.refusal, undefined, JSON.stringify(got.refusal));
    assert.ok(got.changes.inserted.some(q => q.object.value === FILE_PATH || q.object.value === 'a plan'),
      `the file's statements are missing: ${got.changes.inserted.map(q => q.object.value).join(', ')}`);
    assert.equal(got.changes.filesWithheld, false);
  });

  it('the evaluation reads only the space it changes, and a GRAPH naming another space is refused', async () => {
    const got = await evaluate(`INSERT { <${ADA}> <${COPIED}> ?n } WHERE { ?s <${LABEL}> ?n }`, filesCaller);
    assert.equal(got.refusal, undefined, JSON.stringify(got.refusal));
    const copied = got.changes.inserted.map(q => q.object.value);
    assert.ok(copied.includes('Ada'), `the space's own label is missing: ${copied.join(', ')}`);
    assert.ok(!copied.includes(SECRET), 'the evaluation read a space it does not change');
    const other = await evaluate(`INSERT { <${ADA}> <${COPIED}> ?n } WHERE { GRAPH <${baseOf(B)}> { ?s <${LABEL}> ?n } }`, filesCaller);
    assert.equal(other.refusal?.code, 'sparql_graph_management_refused', JSON.stringify(other.refusal ?? other.changes?.inserted));
  });

  it('the change set carries each record read with its seq', async () => {
    const got = await evaluate(`DELETE { ?s <${LABEL}> ?n } WHERE { ?s <${LABEL}> ?n }`, knowledgeCaller);
    assert.equal(got.refusal, undefined, JSON.stringify(got.refusal));
    assert.deepEqual(got.changes.reads.filter(r => r.kind === 'entity'), [{ space: A, kind: 'entity', id: 'e-ada', seq: 7 }]);
    assert.equal(got.changes.lostRace, null);
  });

  it('a record read at two seqs in one evaluation is flagged a lost race; two reads at one seq are not', async () => {
    const { createQuadSource } = needModule(quadSource, ['createQuadSource'], 'the quad source');
    const s = createQuadSource({ members: [A], caller: knowledgeCaller }, { deadline: deadline() });
    needModule({ mod: s, path: 'the quad source' }, ['readRecords', 'lostRace'], 'the quad source\'s record of what it read');
    const pattern = () => s.match(named(ADA), undefined, undefined, undefined);
    assert.ok((await drain(pattern())).length > 0, 'the record was not read');
    assert.ok((await drain(pattern())).length > 0);
    assert.equal(s.lostRace(), null, 'two reads at one seq were flagged');
    await d.col(d.spaceCollection(A, 'entities')).updateOne({ _id: 'e-ada' }, { $set: { seq: 8 } });
    try {
      await drain(pattern());
      assert.deepEqual(s.lostRace(), { space: A, kind: 'entity', id: 'e-ada', seqs: [7, 8] });
    } finally {
      await d.col(d.spaceCollection(A, 'entities')).updateOne({ _id: 'e-ada' }, { $set: { seq: 7 } });
    }
  });
});
