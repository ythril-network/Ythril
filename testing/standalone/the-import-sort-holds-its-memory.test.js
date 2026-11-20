/**
 * The import's sort holds its memory to its run size: a file many times the run size is sorted and read back in groups while the live heap
 * stays under a ceiling far below the file (bundle-270 S5, plan question (b)).
 *
 * ## The rule
 *
 * An uploaded file may be larger than memory; the sort on disk exists so the import never holds it. The run size bounds what one run keeps
 * (its lines and their keys), and the merge keeps one line per run and its streams' buffers. The case sorts about 32 MiB of quads, 64 times
 * its run size of 512 KiB, its subjects spread over the whole file so every run holds a part of each, and reads every group back. The live
 * heap (after a full collection, sampled every 50 ms through the sort and the read) must stay under 24 MiB above where it started: 16 run sizes
 * for a run's line text, its parsed keys and the sort's array (each a few times the text), plus 16 MiB for the merge's 64 open streams and
 * their buffers (64 KiB each, twice over with a decryptor) and the group in hand. A sort that kept the file, or even a quarter of it, in memory
 * crosses the ceiling, since the file's quads held as objects take several times its 32 MiB.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { spoolModule, tempFolder, cleanupFolders, namesAt, quadChars, iri, lit, q } from './_rdf-import-spool-doors.mjs';

after(cleanupFolders);

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
const MiB = 1024 * 1024;
const RUN_BYTES = 512 * 1024;
const FILE_CHARS = 64 * RUN_BYTES;
const CEILING = 16 * RUN_BYTES + 16 * MiB;
const BASE = 'https://data.example.org/ld/s5/';

describe('the import sort holds its memory', () => {
  it(`sorts and reads back ${FILE_CHARS / MiB} MiB of quads with the live heap under ${CEILING / MiB} MiB above its start`, async () => {
    const { sortedSpool, openImportFolder } = await spoolModule();
    assert.equal(typeof sortedSpool, 'function', 'import-spool.ts exports no sortedSpool');
    const folder = await openImportFolder(tempFolder('memory'));
    const names = await namesAt(BASE);
    gc(); gc();
    const start = process.memoryUsage().heapUsed;
    let peak = 0;
    const sample = setInterval(() => { gc(); peak = Math.max(peak, process.memoryUsage().heapUsed - start); }, 50);
    let written = 0;
    let quads = 0;
    async function* file() {
      for (let k = 0; written < FILE_CHARS; k += 1) {
        const quad = q(iri(`${BASE}entity/e${(k * 7919) % 20_000}`), iri(`https://vocab.example.org/p${k % 13}`), lit(`value ${k} ${'v'.repeat(40)}`));
        written += quadChars(quad);
        quads += 1;
        yield quad;
      }
    }
    let read = 0;
    try {
      const spool = await sortedSpool(file(), folder, { names, bounds: { runBytes: RUN_BYTES } });
      for await (const group of spool.groups()) read += group.quads.length;
    } finally {
      clearInterval(sample);
    }
    console.log(`sort: ${quads} quads, ${(written / MiB).toFixed(1)} MiB of terms, live heap peak ${(peak / MiB).toFixed(1)} MiB above start`);
    assert.equal(read, quads, 'the groups did not give back every quad');
    assert.ok(peak > 0, 'the heap was never sampled during the sort');
    assert.ok(peak < CEILING, `the live heap rose ${(peak / MiB).toFixed(1)} MiB during the sort`);
    await folder.remove();
  });
});
