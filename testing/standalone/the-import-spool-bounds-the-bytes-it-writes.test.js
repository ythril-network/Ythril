/**
 * A small upload cannot make the import's sort fill the data disk (bundle-270 review F1, amendment A6).
 *
 * ## The rule
 *
 * The reader bounds a token at 16 384 characters, but a prefix declaration expands each prefixed name, so a file of about six input
 * characters per quad (`, p:oN`) makes quads whose subject, predicate and object are each 16 000 characters, and every one is written to the
 * spool as a line of about 64 000 characters. Counting the quads of the file did not bound that: the subject bounds are checked only in the
 * final merge, after every run is on disk. The pass therefore charges every spool line it writes (its bytes and its line end) against
 * `maxSpoolBytes` (`RDF_IMPORT_MAX_SPOOL_BYTES`), and refuses the file with the same `RdfImportBoundExceeded` as its other bounds, naming it,
 * the moment the lines would pass it, having removed what it wrote.
 *
 * The trigger is the review's own: a Turtle document with a long prefix and one subject's object list, read by the real parser. The run size is
 * cut to a few kilobytes so runs are on disk while the file is read; the bytes in the folder are measured after every quad the pass reads.
 * A pass at the bound writes its lines, one byte under it refuses. The spool is plain here (no master secret is set), so the bytes the pass
 * wrote are the file sizes it leaves.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  spoolModule, tempFolder, cleanupFolders, namesIn, bytesIn, namesAt, streamOf, groupsOf, refusalOf, assertBound,
} from './_rdf-import-spool-doors.mjs';
import { parseRdf, sourceOf, pieces } from './_rdf-parse-doors.mjs';

after(cleanupFolders);

const BASE = 'https://data.example.org/ld/f1/';
const RUN = 4096;
/** A prefix IRI under the parser's token bound (16 384): the quad it makes is still accepted by the reader. */
const PREFIX_CHARS = 16_000;

/** The review's trigger: one subject, `objects` objects in one list, every prefixed name expanding to PREFIX_CHARS characters. */
function trigger(objects) {
  const prefix = `https://p.example/${'a'.repeat(PREFIX_CHARS - 'https://p.example/'.length - 1)}/`;
  const list = Array.from({ length: objects }, (_, k) => `p:o${k}`).join(', ');
  return `@prefix p: <${prefix}> .\np:s p:x ${list} .\n`;
}

const savedSecrets = { key: process.env.YTHRIL_MASTER_KEY, pass: process.env.YTHRIL_MASTER_PASSPHRASE };
delete process.env.YTHRIL_MASTER_KEY;
delete process.env.YTHRIL_MASTER_PASSPHRASE;
after(() => {
  if (savedSecrets.key !== undefined) process.env.YTHRIL_MASTER_KEY = savedSecrets.key;
  if (savedSecrets.pass !== undefined) process.env.YTHRIL_MASTER_PASSPHRASE = savedSecrets.pass;
});

/** The quads of the trigger as the real reader yields them, counted, with the folder's bytes measured after each. */
function measured(dir, text, seen) {
  return (async function* () {
    for await (const quad of parseRdf(sourceOf(pieces(text, 1024)), 'turtle')) {
      seen.quads += 1;
      yield quad;
      const written = namesIn(dir).reduce((n, name) => n + fs.statSync(path.join(dir, name)).size, 0);
      seen.maxBytes = Math.max(seen.maxBytes, written);
    }
  })();
}

async function sortTrigger(label, text, bounds) {
  const { sortedSpool, openImportFolder } = await spoolModule();
  const dir = tempFolder(label);
  const folder = await openImportFolder(dir);
  const seen = { quads: 0, maxBytes: 0 };
  const run = sortedSpool(measured(dir, text, seen), folder, { names: await namesAt(BASE), bounds: { runBytes: RUN, ...bounds } });
  return { dir, seen, run };
}

describe('the import spool bounds the bytes it writes', { timeout: 120_000 }, () => {
  it('the review\'s trigger is refused as RDF_IMPORT_MAX_SPOOL_BYTES, with the bytes written never above it and the folder empty', async () => {
    const limit = 1_000_000;
    const text = trigger(300);
    assert.ok(text.length < 20_000, `the trigger must stay a small upload (${text.length} characters of input for lines of about 300 x 64 000)`);
    const at = await sortTrigger('trigger', text, { maxSpoolBytes: limit });
    assertBound(await refusalOf(at.run, 'the trigger of F1'), 'RDF_IMPORT_MAX_SPOOL_BYTES', limit);
    assert.ok(at.seen.maxBytes > 0, 'no run reached the disk before the refusal: the measure saw nothing');
    assert.ok(at.seen.maxBytes <= limit, `${at.seen.maxBytes} bytes were on disk, over the ceiling ${limit}`);
    assert.ok(at.seen.quads <= Math.ceil(limit / 48_000) + 2, `the refusal came after ${at.seen.quads} of 300 quads, not as the lines passed the bound`);
    assert.deepEqual(namesIn(at.dir), [], `the refusal left ${namesIn(at.dir).join(', ')} behind`);
  });

  it('a file whose lines are exactly the bound passes and one byte under it is refused', async () => {
    const text = trigger(12);
    const free = await sortTrigger('free', text, { maxSpoolBytes: Number.MAX_SAFE_INTEGER });
    const spool = await free.run;
    assert.equal((await groupsOf(spool)).flatMap(g => g.quads).length, 12);
    const bytes = bytesIn(free.dir).length;
    const exact = await sortTrigger('exact', text, { maxSpoolBytes: bytes });
    assert.equal((await groupsOf(await exact.run)).flatMap(g => g.quads).length, 12, 'a file exactly at the bound was not read whole');
    const over = await sortTrigger('over', text, { maxSpoolBytes: bytes - 1 });
    assertBound(await refusalOf(over.run, 'a file one byte over'), 'RDF_IMPORT_MAX_SPOOL_BYTES', bytes - 1);
    assert.deepEqual(namesIn(over.dir), []);
  });

  it('the default bound lets an ordinary file through and is one a hostile file meets', async () => {
    const { DEFAULT_IMPORT_SPOOL_BOUNDS, sortedSpool, openImportFolder } = await spoolModule();
    const limit = DEFAULT_IMPORT_SPOOL_BOUNDS.maxSpoolBytes;
    assert.ok(Number.isSafeInteger(limit), 'the default bounds carry no limit on the bytes written');
    const dir = tempFolder('ordinary');
    const folder = await openImportFolder(dir);
    const ordinary = Array.from({ length: 200 }, (_, k) => ({
      subject: { kind: 'iri', value: `${BASE}entity/e${k}` },
      predicate: { kind: 'iri', value: 'https://vocab.example.org/p' },
      object: { kind: 'literal', value: `value ${k}` },
    }));
    const spool = await sortedSpool(streamOf(ordinary), folder, { names: await namesAt(BASE), bounds: { runBytes: RUN } });
    assert.equal(spool.quads, 200);
    // What the parser admits: 1 GiB inflated, at most 10 000 000 quads; a quad's line is about four times its N-Quads text.
    assert.ok(limit >= 4 * 1024 ** 3, `a file the parser admits would be refused at ${limit} bytes`);
    // The sort holds its runs and its sorted file at once: twice the bound must still fit a data disk an instance runs on.
    assert.ok(2 * limit <= 32 * 1024 ** 3, `the default lets one import write ${2 * limit} bytes at once`);
  });
});
