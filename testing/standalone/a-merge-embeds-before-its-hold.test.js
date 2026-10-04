/**
 * A merge computes the survivor's new vector BEFORE it takes its seq hold, never inside it (bundle-30 I8, a promise
 * the pre-ship testing lens found unpinned).
 *
 * The merge transaction holds every sync reader of the space for its whole length (`inHeldTransaction`), and an
 * embed is a model call that can take seconds — or, with a remote model, as long as the network takes. Inside the
 * hold, that wait is every reader's. So the embed runs first and its result is handed to the transaction as a field.
 *
 * Read from the source, because a store fixture cannot tell a fast embed outside the hold from one inside it.
 *
 * Run: node --test testing/standalone/a-merge-embeds-before-its-hold.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const SRC = stripComments(readFileSync('server/src/brain/merge.ts', 'utf8'));

describe('a merge embeds before its hold', () => {
  it('the survivor is embedded before the held transaction starts, in the function that starts it', () => {
    const body = bodyOf(SRC, 'executeMerge');
    const embedAt = body.search(/await embed\(/);
    const holdAt = body.search(/inHeldTransaction\(/);
    assert.ok(holdAt > 0, 'executeMerge no longer takes the hold through inHeldTransaction — re-anchor this gate');
    assert.ok(embedAt > 0, 'executeMerge no longer embeds the survivor — re-anchor this gate (or the vector is never recomputed)');
    assert.ok(embedAt < holdAt, 'the survivor is embedded after the hold is taken');
  });

  it('nothing the transaction runs embeds', () => {
    // The transaction's work is relinkAndAbsorb and what it calls in this module; none of it may reach the model.
    const inside = ['relinkAndAbsorb', 'storedEdgeIdentities'].map(n => bodyOf(SRC, n)).join('\n');
    assert.ok(inside.length > 500, 'the transaction\'s functions were not found — re-anchor this gate');
    assert.doesNotMatch(inside, /\bembed\(|\bembedText\(|\bembedBatch\(/, 'the merge transaction calls the model while it holds every reader');
  });
});
