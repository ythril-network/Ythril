/**
 * A wipe's per-collection counts are built in ONE place, `wipeResultOf` in `spaces/lifecycle.ts`, and its keys come from the collection list
 * (bundle-106 PR A, the duplicate-rule sweep of the diff).
 *
 * ## What it prevents
 *
 * The zero result and the summed result were each written out with the six keys by hand — in the tool's answer, in the wipe body and in the vote's
 * sum — so a collection added to a space was a key two of the three forgot, and a door answered `undefined` for it with nothing failing. The
 * builder reads its keys from `WIPE_COLLECTION_TYPES`, and no site names a `WipeResult` literal of its own.
 *
 * ## Seen red
 *
 * Against 72f2a5d3 `wipeResultOf` is not exported and the source has three hand-listed literals, so every case here fails.
 *
 * Run: node --test testing/standalone/a-wipe-result-has-one-builder.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const { wipeResultOf, WIPE_COLLECTION_TYPES } = await import('../../server/dist/spaces/lifecycle.js');

describe('wipeResultOf', () => {
  it('has exactly one key per collection a wipe covers, in their order, all zero by default', () => {
    assert.deepEqual(Object.keys(wipeResultOf()), [...WIPE_COLLECTION_TYPES]);
    assert.ok(Object.values(wipeResultOf()).every(n => n === 0));
    assert.ok(WIPE_COLLECTION_TYPES.length >= 6, 'the collection list the keys come from is shorter than the six a wipe covers');
  });

  it('keeps the counts it is given, zeroes the ones it is not, and drops what is no collection', () => {
    const result = wipeResultOf({ facts: 3, links: 2, notACollection: 9 });
    assert.equal(result.facts, 3);
    assert.equal(result.links, 2);
    assert.equal(result.entities, 0);
    assert.equal('notACollection' in result, false);
  });

  it('answers a fresh object each time, so a caller that sums into it cannot change the next zero', () => {
    const a = wipeResultOf();
    a.facts = 7;
    assert.equal(wipeResultOf().facts, 0);
  });
});

describe('no site writes a WipeResult of its own', () => {
  const sources = trackedSources('server/src', { untracked: true, floor: 300 });
  const text = (f) => stripComments(readFileSync(`${REPO_ROOT}/${f}`, 'utf8'));

  it('no object literal is typed as a WipeResult', () => {
    const offenders = sources.filter(f => /:\s*WipeResult\s*=\s*\{/.test(text(f)) || /\)\s*:\s*WipeResult\s*=>\s*\(\s*\{/.test(text(f)));
    assert.deepEqual(offenders, [], 'these spell the wipe result\'s keys by hand: use wipeResultOf(counts?) from spaces/lifecycle.ts');
  });

  it('the three places that needed one ask the builder', () => {
    for (const f of ['server/src/spaces/lifecycle.ts', 'server/src/spaces/delete-space-data.ts', 'server/src/spaces/wipe-vote.ts']) {
      assert.match(text(f), /\bwipeResultOf\(/, `${f} does not ask wipeResultOf`);
    }
  });
});
