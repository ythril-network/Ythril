/**
 * A Merkle leaf costs, on the heap, no more than the per-leaf ceiling the leaf cache's budget is written in (Q-336).
 *
 * ## Why
 *
 * `brain/merkle.ts` keeps every leaf of up to a few spaces and bounds them by a number of LEAVES
 * (`MERKLE_CACHE_MAX_LEAVES`), which is a bound on memory only while a leaf costs what the budget's docblock says. That
 * sentence is a measurement written as prose, and prose about a heap goes stale silently: a leaf that became an object
 * (a hash and a stamp) would make the "about 44 MB" several times that, with every number in the file still reading as
 * true. So the cost is measured here, built the way `collectionLeaves` builds a leaf (`docLeaf` of a document, pushed on
 * an array that is then sorted), and held to `MERKLE_LEAF_BYTES_CEILING`, which is the figure the budget multiplies.
 *
 * ## What is asserted
 *
 * - the heap grows by at most the ceiling per leaf over a few hundred thousand leaves, a collection forced either side;
 * - the budget the two constants make is the memory the docblock promises, read from the source's own numbers.
 *
 * Run: node --test testing/standalone/a-merkle-leaf-costs-what-its-ceiling-says.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import v8 from 'node:v8';
import vm from 'node:vm';

const merkle = await import('../../server/dist/brain/merkle.js');
const LEAVES = 200_000;

// A collection on demand, whatever flags the runner started node with: the flag is switched on and the function read
// out of a fresh context, so the measurement never skips for want of `--expose-gc`.
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');

/** The heap after two forced collections, so what was dropped does not count. */
function settledHeap() {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

describe('a merkle leaf costs what its ceiling says', () => {
  it('the heap holds a leaf in no more than the ceiling', () => {
    const docs = Array.from({ length: LEAVES }, (_, i) => ({ _id: randomUUID(), seq: i, content: `fact ${i}` }));
    // Hashed once and thrown away: the first hash of a document flattens its strings in place, which is a change of
    // the DOCUMENTS' size (tens of megabytes at this count) that must not be read as the leaves'.
    for (const doc of docs) merkle.docLeaf('facts', doc);
    const before = settledHeap();
    const leaves = [];
    for (const doc of docs) leaves.push(merkle.docLeaf('facts', doc));
    leaves.sort();
    const after = settledHeap();
    const perLeaf = (after - before) / LEAVES;
    // The documents are read here so they are still alive at the second reading: only the leaves may be what grew.
    assert.equal(docs.length, leaves.length);
    assert.ok(perLeaf <= merkle.MERKLE_LEAF_BYTES_CEILING,
      `a leaf costs ${perLeaf.toFixed(1)} bytes on the heap, over the ${merkle.MERKLE_LEAF_BYTES_CEILING} the cache budget `
      + 'is counted in — the leaf cache holds several times the memory its docblock says');
    assert.ok(perLeaf > 40, `a leaf cost ${perLeaf.toFixed(1)} bytes — the measurement is not measuring the leaves`);
  });

  it('the budget is the leaves times the ceiling, and that is tens of megabytes, not hundreds', () => {
    const bytes = merkle.MERKLE_CACHE_MAX_LEAVES * merkle.MERKLE_LEAF_BYTES_CEILING;
    assert.ok(bytes <= 64 * 1024 * 1024, `the budget allows ${(bytes / 1048576).toFixed(0)} MB of leaves`);
  });
});
