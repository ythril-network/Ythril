/**
 * Whether a stored record's text is stale is asked in ONE place (`textIsStale`, `brain/derived-text-on-write.ts`).
 *
 * ## What it prevents
 *
 * The repair sweep (`reembed.ts`, its stale pass) and the dupe scanner's hold on a dismissed pair asked the same question
 * in two hand-written conditions, and they already disagreed on a text the batch could not build (`undefined`): one
 * skipped it, the other counted it stale. A third copy is a third answer.
 *
 * ## What is asked
 *
 * - the predicate's answers, `undefined` and `null` included;
 * - no code in `server/src` outside its module compares a stored `matchedText` with `!==`, which is the shape every copy
 *   took. (The embed job's `unchanged` test compares with `===` beside the vector and the model: a different question.)
 *
 * Run: node --test testing/standalone/a-stale-text-is-asked-in-one-place.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const HOME = 'server/src/brain/derived-text-on-write.ts';

describe('a stale text is asked in one place', () => {
  it('textIsStale: a current text that is not the stored one, and nothing without a current text', async () => {
    const { textIsStale } = await import('../../server/dist/brain/derived-text-on-write.js');
    assert.equal(textIsStale({ matchedText: 'old' }, 'new'), true);
    assert.equal(textIsStale({}, 'new'), true, 'a record with no stored text owes its job');
    assert.equal(textIsStale({ matchedText: 'same' }, 'same'), false);
    assert.equal(textIsStale({ matchedText: 'old' }, null), false, 'a record with no text to build owes nothing');
    assert.equal(textIsStale({ matchedText: 'old' }, undefined), false, 'a text the batch could not build owes nothing');
  });

  it('no other module compares a stored matchedText with !==', () => {
    const COPY = /matchedText['"]?\]?\s*!==/;
    const copies = trackedSources('server/src', { floor: 200 })
      .filter(f => f !== HOME && COPY.test(stripComments(readFileSync(f, 'utf8'))));
    assert.deepEqual(copies, [], 'a module asks whether a stored text is stale itself instead of calling textIsStale');
  });
});
