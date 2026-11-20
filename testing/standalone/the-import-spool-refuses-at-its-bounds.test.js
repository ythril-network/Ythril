/**
 * The import's sorted spool refuses a file over any of its bounds before its pass returns, and leaves nothing behind; every file it makes is
 * removed by one call, also after a crash (bundle-270 S5, amendment A6).
 *
 * ## The rule
 *
 * An import into a strict space is planned whole before anything is stored, so "too large" must be the door's answer (413), found in the pass
 * that reads the file, before an act is registered and its space held. Each bound (the quads of the file, its distinct subjects, the quads
 * and the characters of one subject) passes a file exactly at it and refuses one over it, naming the bound; a subject's quads are counted
 * after the sort, so quads of one subject scattered over many runs, and a chrono's time nodes, count toward that one subject. After a refusal,
 * and after the reader throws, the folder is empty. A crash between the sort and the read leaves files that `removeImportFolder` removes
 * without the handle that wrote them; it removes nothing in a folder that holds a file the module did not write.
 *
 * The run size is cut to a few kilobytes so every count crosses runs.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  spoolModule, indexModule, tempFolder, cleanupFolders, namesIn, namesAt, quadChars,
  iri, lit, q, streamOf, groupsOf, refusalOf, assertBound,
} from './_rdf-import-spool-doors.mjs';

after(cleanupFolders);

const BASE = 'https://data.example.org/ld/s5/';
const P = (local) => iri(`https://vocab.example.org/${local}`);
const RUN = 2048;

/** `count` subjects of `each` quads, each subject's quads spread over the whole file (subject i % count). */
function spread(count, each, filler = 'x'.repeat(30)) {
  const out = [];
  for (let k = 0; k < count * each; k += 1) out.push(q(iri(`${BASE}entity/e${k % count}`), P(`p${k}`), lit(`${filler} ${k}`)));
  return out;
}

async function sort(quads, label, bounds) {
  const { sortedSpool, openImportFolder } = await spoolModule();
  assert.equal(typeof sortedSpool, 'function', 'import-spool.ts exports no sortedSpool');
  const dir = tempFolder(label);
  const folder = await openImportFolder(dir);
  return { dir, folder, run: sortedSpool(streamOf(quads), folder, { names: await namesAt(BASE), bounds: { runBytes: RUN, ...bounds } }) };
}

/** The file passes at `limit` (yielding every quad) and is refused one under it, naming `bound`, with the folder left empty. */
async function holdsAt(label, quads, field, bound, limit) {
  const at = await sort(quads, `${label}-at`, { [field]: limit });
  const spool = await at.run;
  assert.equal((await groupsOf(spool)).flatMap(g => g.quads).length, quads.length, `a file exactly at ${bound} was not read whole`);
  const over = await sort(quads, `${label}-over`, { [field]: limit - 1 });
  assertBound(await refusalOf(over.run, `a file one over ${bound}`), bound, limit - 1);
  assert.deepEqual(namesIn(over.dir), [], `the refused pass left ${namesIn(over.dir).join(', ')} behind`);
}

describe('the import spool refuses at its bounds', () => {
  it('the quads of the file: passes at the bound, refused one over it', async () => {
    const quads = spread(40, 5);
    await holdsAt('quads', quads, 'maxQuads', 'RDF_IMPORT_MAX_QUADS', quads.length);
  });

  it('the distinct subjects: passes at the bound, refused one over it; a chrono and its time nodes are one subject', async () => {
    const quads = spread(60, 3);
    const chrono = `${BASE}chrono/c1`;
    quads.splice(17, 0, q(iri(`${chrono}#start`), P('t'), lit('2026-01-01')));
    quads.splice(91, 0, q(iri(chrono), P('label'), lit('c1')));
    quads.push(q(iri(`${chrono}#end`), P('t'), lit('2026-02-01')));
    await holdsAt('subjects', quads, 'maxSubjects', 'RDF_IMPORT_MAX_SUBJECTS', 61);
  });

  it('the quads of one subject, scattered over many runs: passes at the bound, refused one over it', async () => {
    const quads = spread(30, 4);
    for (let k = 0; k < 25; k += 1) quads.splice(k * 5, 0, q(iri(`${BASE}entity/big`), P(`b${k}`), lit(`big ${k} ${'y'.repeat(30)}`)));
    await holdsAt('subject-quads', quads, 'maxSubjectQuads', 'RDF_IMPORT_MAX_SUBJECT_QUADS', 25);
  });

  it('a chrono\'s time nodes count toward the chrono\'s quads', async () => {
    const chrono = `${BASE}chrono/c9`;
    const quads = spread(10, 2).concat([q(iri(chrono), P('a'), lit('1')), q(iri(`${chrono}#start`), P('t'), lit('2')), q(iri(`${chrono}#end`), P('t'), lit('3'))]);
    await holdsAt('part-quads', quads, 'maxSubjectQuads', 'RDF_IMPORT_MAX_SUBJECT_QUADS', 3);
  });

  it('the characters of one subject: passes at the bound, refused one over it', async () => {
    const quads = spread(20, 2);
    const big = [q(iri(`${BASE}entity/long`), P('a'), lit('z'.repeat(9000))), q(iri(`${BASE}entity/long`), P('b'), lit('w'.repeat(7000), { language: 'de' }))];
    quads.splice(5, 0, big[0]);
    quads.push(big[1]);
    const chars = big.reduce((n, x) => n + quadChars(x), 0);
    await holdsAt('subject-chars', quads, 'maxSubjectChars', 'RDF_IMPORT_MAX_SUBJECT_CHARS', chars);
  });

  it('a reader that throws halfway: its own error comes through, and the folder is empty', async () => {
    const { sortedSpool, openImportFolder } = await spoolModule();
    const dir = tempFolder('throws');
    const folder = await openImportFolder(dir);
    const failing = new Error('the reader refused line 900');
    async function* source() { for (const x of spread(50, 20)) yield x; throw failing; }
    const err = await refusalOf(sortedSpool(source(), folder, { names: await namesAt(BASE), bounds: { runBytes: RUN } }), 'a reader that throws');
    assert.equal(err, failing, `the reader's error was replaced by ${err?.message}`);
    assert.deepEqual(namesIn(dir), []);
  });

  it('a crash between the sort and the read leaves files that one call removes, with no handle; a missing folder is no failure', async () => {
    const { sortedSpool, openImportFolder, openOperationSpool, removeImportFolder } = await spoolModule();
    const { ImportIndex } = await indexModule();
    const dir = tempFolder('crash');
    const folder = await openImportFolder(dir);
    await sortedSpool(streamOf(spread(40, 5)), folder, { names: await namesAt(BASE), bounds: { runBytes: RUN } });
    const ops = await openOperationSpool(folder);
    await ops.append('entity', { id: 'x' });
    await ops.close();
    const index = new ImportIndex();
    index.set('k', { kind: 'entity', id: 'x', stored: false });
    await index.write(folder);
    assert.ok(namesIn(dir).length >= 3, `the spool, the operations and the index left only ${namesIn(dir).join(', ')}`);
    await removeImportFolder(dir);
    assert.equal(fs.existsSync(dir), false, `the cleanup left ${namesIn(dir).join(', ')}`);
    await removeImportFolder(dir);
  });

  it('the cleanup refuses a folder holding a file it did not write, and removes nothing there', async () => {
    const { sortedSpool, openImportFolder, removeImportFolder } = await spoolModule();
    const dir = tempFolder('foreign');
    const folder = await openImportFolder(dir);
    await sortedSpool(streamOf(spread(10, 2)), folder, { names: await namesAt(BASE), bounds: { runBytes: RUN } });
    const written = namesIn(dir);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine');
    await refusalOf(removeImportFolder(dir), 'a folder with a foreign file');
    await refusalOf(folder.remove(), 'the handle\'s removal of a folder with a foreign file');
    assert.deepEqual(namesIn(dir), [...written, 'notes.txt'].sort(), 'the refused cleanup removed something');
  });

  it('the handle removes its folder after a refusal', async () => {
    const over = await sort(spread(10, 2), 'handle', { maxQuads: 5 });
    await refusalOf(over.run, 'a file over its quads');
    await over.folder.remove();
    assert.equal(fs.existsSync(over.dir), false);
  });
});
