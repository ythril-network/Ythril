/**
 * The embed worker and both embed walks ask "is this record suppressed?" through ONE function, `recordSuppressedMany`
 * (`server/src/brain/suppress-embeddings.ts`), never the two questions it chooses between (Q-656, bundle-211).
 *
 * ## What it prevents
 *
 * A FILE row's suppression is the file question (its two tiers, then its ancestors, `fileEmbeddingSuppressedMany`); every other kind's is
 * `embeddingSuppressedFor`. The worker, the reindex walk and the backfill walk each wrote `kind === 'file' ? fileQuestion :
 * recordQuestion`, and the first two spellings of it that forgot the file half re-queued a chunk of a suppressed file on every call for
 * ever. The kind split now lives in `recordSuppressedMany`; a caller that names either question itself brings the split back.
 *
 * ## What is asked, with the comments stripped
 *
 * - the detector flags each planted call of either question (the gate cannot pass because its pattern is broken), and leaves alone a
 *   word that only contains one (`recordSuppressedMany`, `storedFileEmbeddingSuppressed`) and a mention in a comment;
 * - neither `brain/embed-record.ts` nor `brain/queue-embed-sweep.ts` calls `embeddingSuppressedFor`, `fileEmbeddingSuppressed` or
 *   `fileEmbeddingSuppressedMany`, and both call `recordSuppressedMany` (the gate cannot pass because a file stopped asking at all).
 *
 * Run: node --test testing/standalone/the-embed-sweeps-and-the-worker-ask-suppression-through-one-module.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const ASKERS = ['server/src/brain/embed-record.ts', 'server/src/brain/queue-embed-sweep.ts'];
const QUESTION = /(?<![\w$.])(embeddingSuppressedFor|fileEmbeddingSuppressed|fileEmbeddingSuppressedMany)\s*\(/g;

const questionsIn = (src) => [...stripComments(src).matchAll(QUESTION)].map(m => m[1]);

describe('the worker and both walks ask suppression through recordSuppressedMany', () => {
  it('the detector flags each planted call and leaves what is not one alone', () => {
    assert.deepEqual(questionsIn('const s = embeddingSuppressedFor(spaceId, kind, doc);'), ['embeddingSuppressedFor']);
    assert.deepEqual(questionsIn('await fileEmbeddingSuppressed(spaceId, doc)'), ['fileEmbeddingSuppressed']);
    assert.deepEqual(questionsIn('await fileEmbeddingSuppressedMany (spaceId, page)'), ['fileEmbeddingSuppressedMany']);
    assert.deepEqual(questionsIn('await recordSuppressedMany(spaceId, kind, page);'), []);
    assert.deepEqual(questionsIn('await storedFileEmbeddingSuppressed(spaceId, id);'), []);
    assert.deepEqual(questionsIn('// asked embeddingSuppressedFor(spaceId, kind, doc) per record\nconst x = 1;'), []);
    assert.deepEqual(questionsIn("import { embeddingSuppressedFor } from './suppress-embeddings.js';"), []);
  });

  it('neither the worker nor the walks call either question themselves, and each asks recordSuppressedMany', () => {
    for (const file of ASKERS) {
      const src = readFileSync(file, 'utf8');
      assert.deepEqual(questionsIn(src), [], `${file} asks a suppression question itself instead of recordSuppressedMany`);
      assert.match(stripComments(src), /\brecordSuppressedMany\(/, `${file} no longer asks recordSuppressedMany`);
    }
  });
});
