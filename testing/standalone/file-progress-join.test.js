/**
 * Joining step progress onto a page of file records.
 *
 * `MediaJobDoc._id` is the file `_id`, so this is an `$in` rather than an N+1 walk. What is worth
 * pinning is not the happy path but the ways it could quietly become expensive or wrong:
 *
 *  - a page with **nothing in flight** must issue no query at all — a listing of finished files is
 *    most listings, and it should not pay for the rare one;
 *  - a job that has been claimed but has **not reported a step yet** must not add an empty
 *    `progress` field, because the UI treats its presence as "the route is known" and would draw a
 *    bar with no sections instead of falling back to the spinner.
 *
 * The lookup is injected so the first claim can actually be OBSERVED. Asserting on the returned
 * records cannot tell "did not query" from "queried and got nothing" — an earlier version of this
 * file did exactly that and passed with the early return deleted.
 *
 * Run: node --test testing/standalone/file-progress-join.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Moved to `files/file-job-progress.ts` so `brain/` can reach it — `filter` with `collection: 'files'`
// needs the same join, and a `brain/` module must not import from `api/`.
const { attachJobProgress } = await import('../../server/dist/files/file-job-progress.js');

const file = (id, status, extra = {}) => ({ _id: id, path: id, embeddingStatus: status, ...extra });

/** A lookup that records how it was called and returns whatever it was seeded with. */
function spyLookup(rows = {}) {
  const calls = [];
  const fn = async (memberId, ids) => {
    calls.push({ memberId, ids });
    return new Map(Object.entries(rows).filter(([id]) => ids.includes(id)));
  };
  fn.calls = calls;
  return fn;
}

const PROGRESS = { step: 'vlm', steps: ['ocr', 'render', 'vlm'], done: 3, total: 10 };

describe('attachJobProgress — when it queries at all', () => {
  it('THE ONE THAT MATTERS: a page with nothing in flight issues no query', async () => {
    const lookup = spyLookup();
    const files = [file('a', 'complete'), file('b', 'failed'), file('c', 'skipped')];
    const out = await attachJobProgress('space', files, lookup);
    assert.equal(lookup.calls.length, 0, 'a finished page must not hit the job collection');
    assert.deepEqual(out, files);
  });

  it('an empty page issues no query either', async () => {
    const lookup = spyLookup();
    assert.deepEqual(await attachJobProgress('space', [], lookup), []);
    assert.equal(lookup.calls.length, 0);
  });

  it('queries ONCE, with only the in-flight ids', async () => {
    const lookup = spyLookup();
    await attachJobProgress('space', [
      file('a', 'processing'), file('b', 'complete'), file('c', 'pending'), file('d', 'failed'),
    ], lookup);
    assert.equal(lookup.calls.length, 1, 'one query for the whole page, not one per file');
    assert.deepEqual(lookup.calls[0].ids.sort(), ['a', 'c']);
  });

  it('passes the MEMBER id through, not the proxy space id', async () => {
    // On a proxy space the ids belong to that member's job collection; looking them up under the
    // proxy's name would silently find nothing and every bar would fall back to a spinner.
    const lookup = spyLookup();
    await attachJobProgress('member-2', [file('a', 'processing')], lookup);
    assert.equal(lookup.calls[0].memberId, 'member-2');
  });
});

describe('attachJobProgress — what it attaches', () => {
  it('attaches progress and progressAt to the in-flight record only', async () => {
    const lookup = spyLookup({ a: { progress: PROGRESS, progressAt: '2026-07-22T12:00:00.000Z' } });
    const out = await attachJobProgress('space', [file('a', 'processing'), file('b', 'complete')], lookup);
    assert.deepEqual(out[0].progress, PROGRESS);
    assert.equal(out[0].progressAt, '2026-07-22T12:00:00.000Z');
    assert.equal(out[1].progress, undefined);
  });

  it('a claimed job that has not reported a step yet adds NO progress field', async () => {
    // The UI reads the presence of `progress` as "the route is known". An empty object would draw a
    // segmented bar with no sections instead of falling back to the spinner.
    const lookup = spyLookup({ a: { progress: undefined, progressAt: '2026-07-22T12:00:00.000Z' } });
    const out = await attachJobProgress('space', [file('a', 'processing')], lookup);
    assert.ok(!('progress' in out[0]), 'progress must be absent, not empty');
  });

  it('a lookup that finds nothing leaves the page exactly as it was', async () => {
    const lookup = spyLookup();
    const files = [file('a', 'processing')];
    assert.deepEqual(await attachJobProgress('space', files, lookup), files);
  });

  it('never mutates the records it was handed', async () => {
    const lookup = spyLookup({ a: { progress: PROGRESS, progressAt: null } });
    const files = [file('a', 'processing'), file('b', 'complete')];
    const snapshot = JSON.parse(JSON.stringify(files));
    await attachJobProgress('space', files, lookup);
    assert.deepEqual(files, snapshot, 'the caller’s array was modified in place');
  });
});

describe('attachJobProgress — which statuses count as in flight', () => {
  it('pending and processing count; every finished state does not', async () => {
    // set-claim: a PARTITION of the job statuses written as two loops -- the in-flight pair here, every
    // finished state in the loop below -- so the case states the boundary rather than copying a set.
    // `pending` matters as much as `processing`: a queued job is exactly the case where someone is
    // staring at the row wondering whether anything is happening at all.
    for (const s of ['pending', 'processing']) {
      const lookup = spyLookup();
      await attachJobProgress('space', [file('x', s)], lookup);
      assert.equal(lookup.calls.length, 1, `${s} should be looked up`);
    }
    for (const s of ['complete', 'partial', 'failed', 'skipped', 'disabled', '', undefined]) {
      const lookup = spyLookup();
      await attachJobProgress('space', [file('x', s)], lookup);
      assert.equal(lookup.calls.length, 0, `${s} must not trigger a lookup`);
    }
  });
});
