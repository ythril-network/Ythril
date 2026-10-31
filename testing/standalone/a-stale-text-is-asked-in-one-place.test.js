/**
 * Whether a stored record's text is stale is asked in ONE place (`textIsStale`, `brain/derived-text-on-write.ts`), and the worker's
 * own classifier (`embedOwed`, `brain/embed-record.ts`) is the only other that compares a stored `matchedText` (Q-656, bundle-211).
 *
 * ## What it prevents
 *
 * The repair sweep (`queue-embed-sweep.ts`, its stale pass) and the dupe scanner's hold on a dismissed pair asked the same question
 * in two hand-written conditions, `!==` in one and its inverse `===` in the other, and they already disagreed on a text the batch
 * could not build (`undefined`): one skipped it, the other counted it stale. A third copy is a third answer. The worker's
 * "nothing to do" test compares `matchedText` with `===` beside the vector and the model, which is a different question and
 * lives in `embedOwed`, the function the backfill's walk asks too.
 *
 * ## What is asked, with the comments stripped
 *
 * - the predicate's answers, `undefined` and `null` included;
 * - the classifier exists under the name the backfill and the worker share;
 * - the detector flags each planted comparison (`!==` and `===`, either operand order, dotted or bracketed) and leaves alone an
 *   assignment, an `in` test and a comparison of another field;
 * - no code in `server/src` outside the predicate's module, and outside the classifier's own body, compares a stored
 *   `matchedText` with `===` or `!==`.
 *
 * Run: node --test testing/standalone/a-stale-text-is-asked-in-one-place.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const HOME = 'server/src/brain/derived-text-on-write.ts';
const CLASSIFIER_FILE = 'server/src/brain/embed-record.ts';
const CLASSIFIER = 'embedOwed';

/** `matchedText` on either side of a strict (in)equality, as a property, an element or a bare name. */
const COPY = /matchedText['"]?\]?\s*[!=]==|[!=]==\s*[\w$.?]*(?:\[\s*['"])?matchedText\b/;

/** `src` without the body of the declared function `name`, when it is declared there at all. */
function withoutDeclaration(src, name) {
  const declared = new RegExp(`^(?:export\\s+)?(?:async\\s+function|function|const)\\s+${name}\\b`, 'm');
  return declared.test(src) ? src.replace(bodyOf(src, name), '') : src;
}

describe('a stale text is asked in one place', () => {
  it('textIsStale: a current text that is not the stored one, and nothing without a current text', async () => {
    const { textIsStale } = await import('../../server/dist/brain/derived-text-on-write.js');
    assert.equal(typeof textIsStale, 'function', 'derived-text-on-write.ts exports no textIsStale');
    assert.equal(textIsStale({ matchedText: 'old' }, 'new'), true);
    assert.equal(textIsStale({}, 'new'), true, 'a record with no stored text owes its job');
    assert.equal(textIsStale({ matchedText: 'same' }, 'same'), false);
    assert.equal(textIsStale({ matchedText: 'old' }, null), false, 'a record with no text to build owes nothing');
    assert.equal(textIsStale({ matchedText: 'old' }, undefined), false, 'a text the batch could not build owes nothing');
  });

  it(`embed-record.ts declares the worker's classifier as ${CLASSIFIER}`, () => {
    const src = stripComments(readFileSync(CLASSIFIER_FILE, 'utf8'));
    assert.ok(new RegExp(`^export (?:async )?function ${CLASSIFIER}\\b`, 'm').test(src),
      `${CLASSIFIER_FILE} exports no ${CLASSIFIER}: the backfill and the worker ask the one classifier`);
  });

  it('the detector flags each planted comparison and leaves other code alone', () => {
    for (const planted of [
      "return text !== null && doc['matchedText'] !== text;",
      "if (typeof id !== 'string' || doc['matchedText'] === text) return;",
      'return stored.matchedText !== text;',
      'if (text === doc.matchedText) return;',
      "if (text !== doc['matchedText']) owed.push(id);",
      'const same = doc?.matchedText === text;',
    ]) assert.ok(COPY.test(planted), `the detector missed: ${planted}`);
    for (const clean of [
      "const set = { matchedText: text };",
      "if ('matchedText' in doc) return;",
      "doc['embeddingModel'] === configuredModel",
      'const x = matchedTextOf(doc) === text;',
    ]) assert.ok(!COPY.test(clean), `the detector flagged: ${clean}`);
  });

  it('no other module compares a stored matchedText with === or !==', () => {
    const copies = [];
    for (const f of trackedSources('server/src', { floor: 200 })) {
      if (f === HOME) continue;
      let src = stripComments(readFileSync(f, 'utf8'));
      if (f === CLASSIFIER_FILE) src = withoutDeclaration(src, CLASSIFIER);
      if (COPY.test(src)) copies.push(f);
    }
    assert.deepEqual(copies, [], 'a module asks whether a stored text is stale itself instead of calling textIsStale (or the classifier, embedOwed)');
  });
});
