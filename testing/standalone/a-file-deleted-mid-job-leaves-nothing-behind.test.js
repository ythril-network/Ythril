/**
 * A file deleted while its media job runs leaves no metadata behind.
 *
 * A text conversion inserts its chunk records at the END of the job. A folder deleted mid-job removes the
 * file and then its metadata by prefix, so chunks inserted after that prefix delete stayed as orphans. The
 * integration run caught it once: `files.test.js` "Deleting a directory removes metadata for all files inside
 * it" found one record left, and the server log showed the text job for that file finishing 0.5s after the
 * folder delete.
 *
 * The worker now re-checks the source AFTER the embedder's writes and reconciles if it is gone. The order is
 * the whole fix: checked before the writes, the same race stays open. So this asserts the order in the
 * worker, and the integration test asserts the outcome.
 *
 * The reconcile takes the run's CLAIM rather than the file id: a file missing from its path may have been MOVED,
 * and a run whose claim a move took must not clean up what the move is carrying
 * (`a-moved-file-leaves-nothing-at-its-old-path-db.test.js`).
 *
 * Run: node --test testing/standalone/a-file-deleted-mid-job-leaves-nothing-behind.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const src = stripComments(readFileSync('server/src/files/media/worker.ts', 'utf8'));
const body = src.slice(src.indexOf('async function processJob('), src.indexOf('async function reconcileDeletedSource('));

describe('the worker reconciles a source deleted during its job', () => {
  it('found processJob and the end of its embedder dispatch', () => {
    assert.ok(body.length > 1000, 'processJob not found — the shape changed');
    assert.ok(body.includes('Unknown mediaType'), 'the embedder switch was not found');
  });

  it('re-checks the source after the embedder has written, and before the job completes', () => {
    const embedderDone = body.indexOf('Unknown mediaType');
    // Asked of `bytesPresent`, the one answer to "are the bytes here" (bundle-30 I16, preship-4 P4-5).
    const recheck = body.indexOf('bytesPresent(absolutePath)', embedderDone);
    const complete = body.indexOf('await completeJob(', embedderDone);
    assert.ok(recheck > embedderDone, 'no source re-check after the embedder: chunks written after a delete stay as orphans');
    assert.ok(complete > recheck, 'the re-check must come before the job is completed');
    const between = body.slice(recheck, complete);
    assert.match(between, /reconcileDeletedSource\(spaceId, claim\)/, 'a missing source must be reconciled, not only logged');
  });
});
