/**
 * The update an arriving document is written with is BUILT once per document (bundle-56 round S, R10).
 *
 * ## What it prevents
 *
 * `writeArrivals` (`sync/arrivals.ts`) sizes each operation to slice the page by bytes (`inOneCommandChunks`, `bytesOf`),
 * and then builds the same operation again to write it — and a third time for a document written on its own after a bulk
 * failure. The update is `replacementFor` (a full copy of the document with the receiver's own fields carried) or
 * `fileMetaUpdate`, a page's worth of document copies and key walks done twice or three times over a page of 500. The cost is
 * quiet: nothing reports it, and the result is identical, which is why it survived the commit that introduced the slicing.
 *
 * ## What is held
 *
 * The builder (`updateOf`) has ONE call site in the writer, and it is the memo every other reader goes through
 * (`updateFor`); the two things it builds from (`replacementFor`, `fileMetaUpdate`) are called there and nowhere else in
 * the file. Read from the source with comments stripped, over the structure rather than a character window.
 *
 * Run: node --test testing/standalone/a-arrival-update-is-built-once-per-document.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { parseSource, ts } from '../_shared/syntax-tree.mjs';

const code = stripComments(readFileSync(join(REPO_ROOT, 'server/src/sync/arrivals.ts'), 'utf8'));
const callsOf = (name) => [...code.matchAll(new RegExp(`(?<![\\w.])(?<!function )${name}\\(`, 'g'))].length;

describe('the update of an arriving document', () => {
  it('has the builder called from ONE place, the memo the sizing and the writes both read', () => {
    assert.equal(callsOf('updateOf'), 1, 'updateOf is called from more than one place: a document\'s update is built more than once');
    assert.ok(callsOf('updateFor') >= 3, `updateFor (the memo) is read from ${callsOf('updateFor')} place(s): the sizing, the bulk write and the one-by-one write should all go through it`);
  });

  it('builds from replacementFor and fileMetaUpdate in one place each', () => {
    assert.equal(callsOf('replacementFor'), 1, 'replacementFor is called from more than one place in the writer');
    assert.equal(callsOf('fileMetaUpdate'), 1, 'fileMetaUpdate is called from more than one place in the writer');
  });
});

/**
 * ## And it is let go once its chunk is written (round V, S6)
 *
 * `bytesOf` runs over the whole page before the first chunk, so every document's update exists up front. A memo that lives
 * to the end of the function holds the page twice over (the documents and a copy of each); freed per chunk, only the chunks
 * still to come are held. Held over the structure: the `for (const chunk of chunks)` loop's `finally` deletes each of its
 * documents from the memo, so the entry goes whether the chunk landed, was refused or stopped the page.
 */
describe('the memo of those updates', () => {
  const sf = parseSource('arrivals.ts', readFileSync(join(REPO_ROOT, 'server/src/sync/arrivals.ts'), 'utf8'));
  /** The `for (const x of chunks)` loops over the sliced page. */
  const chunkLoops = () => {
    const loops = [];
    const visit = (n) => { if (ts.isForOfStatement(n) && n.expression.getText(sf) === 'chunks') loops.push(n); ts.forEachChild(n, visit); };
    visit(sf);
    return loops;
  };
  /** Does `node` hold a call `updates.delete(...)`? */
  const deletesFromMemo = (node) => {
    let found = false;
    const visit = (n) => {
      if (ts.isCallExpression(n) && n.expression.getText(sf) === 'updates.delete') found = true;
      ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
  };

  it('the scan finds the chunk loop (a floor: no loop checks nothing)', () => {
    assert.equal(chunkLoops().length, 1, `${chunkLoops().length} loop(s) over \`chunks\` found`);
  });

  it('the loop frees each document\'s entry in a `finally`, so it goes however the chunk ended', () => {
    for (const loop of chunkLoops()) {
      const tries = [];
      const visit = (n) => { if (ts.isTryStatement(n) && n.finallyBlock) tries.push(n); ts.forEachChild(n, visit); };
      visit(loop.statement);
      assert.ok(tries.some(t => deletesFromMemo(t.finallyBlock)), 'no `finally` of the chunk loop deletes from the updates memo: the page is held twice until the function returns');
    }
  });
});
