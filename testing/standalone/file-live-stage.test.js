/**
 * The live processing stage attached to a Files listing.
 *
 * The Files list used to say "embedding" with a spinner for the whole of a job, which looks identical
 * whether the job is working or wedged and says nothing about which of a document's stages is running.
 * The stage data and the bar that draws it both already existed — on a different endpoint and in an
 * unused component respectively — so what is new here is the join, and the join has two ways to be wrong
 * that a rendered row cannot distinguish:
 *
 *  1. **Querying for files that are finished.** Most listings are entirely finished files. Asserting on
 *     the returned rows cannot tell "did not query" from "queried and got nothing", so the lookup is
 *     injected and the calls themselves are asserted.
 *  2. **Asking the wrong space.** A media job lives in its OWN space's collection and its `_id` is the
 *     file record's `_id`. A proxy space's listing merges several members, so a lookup that ignored which
 *     member a file came from would silently find nothing for every file but the first member's.
 *
 * Run: node --test testing/standalone/file-live-stage.test.js
 * (requires a prior `npm run build` in server/ so server/dist exists)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let attachLiveStage, dirPrefix;

const file = (name, embeddingStatus) => ({ name, type: 'file', embeddingStatus });
const meta = (pairs) => new Map(pairs.map(([name, id, memberId]) => [name, { id, memberId }]));

/** A lookup that records every call and answers with a step for any id it is asked about. */
function spyLookup(answer = { step: 'vlm', steps: ['render', 'vlm'], done: 2, total: 9 }) {
  const calls = [];
  const fn = async (spaceId, ids) => {
    calls.push({ spaceId, ids: [...ids] });
    return new Map(ids.map(id => [id, { progress: answer, progressAt: '2026-07-27T12:00:00Z' }]));
  };
  fn.calls = calls;
  return fn;
}

/**
 * The prefix bug this feature tripped over.
 *
 * The client asks for the root as `path=/`, but the prefix was derived by comparing the RAW path against
 * `'.'` — so only the literal `.` was treated as the root, and `/` produced the prefix `'/'`. File records
 * store paths with NO leading slash, so the indexed range `['/', '/￿')` matched nothing: every root listing
 * came back with no status, no tags and no folder sizes. Nothing errored, the files were all still listed,
 * and an empty Status column just reads as "nothing has been processed yet". It had been that way the whole
 * time, which is exactly why a live-stage bar could not appear either.
 */
describe('directory prefix — the root has many spellings', () => {
  before(async () => {
    ({ dirPrefix } = await import('../../server/dist/files/merged-listing.js'));
  });

  it('treats every spelling of the root as the empty prefix', () => {
    // set-claim: the spellings of the ROOT a caller can send -- an input grammar this code normalises,
    // not a set anything in the source enumerates.
    for (const root of ['/', '.', '', '//', './', '/./']) {
      assert.equal(dirPrefix(root), '', `'${root}' must mean the root, not a folder literally named that`);
    }
  });

  it('still builds a real prefix for a sub-folder, with or without a trailing slash', () => {
    assert.equal(dirPrefix('reports'), 'reports/');
    assert.equal(dirPrefix('reports/'), 'reports/');
    assert.equal(dirPrefix('/reports'), 'reports/', 'a leading slash is how the client spells paths');
    assert.equal(dirPrefix('reports/q1'), 'reports/q1/');
    assert.equal(dirPrefix('reports\\q1'), 'reports/q1/', 'windows separators normalise too');
  });

  it('never emits a leading slash — stored paths do not have one', () => {
    // set-claim: sample paths, one per shape the prefix rule has to survive -- root, a plain directory,
    // a doubly-slashed one, a nested one.
    for (const p of ['/', '/reports', '//reports//', '/a/b']) {
      assert.ok(!dirPrefix(p).startsWith('/'), `'${p}' produced a prefix that can match no stored record`);
    }
  });
});

describe('live stage — only in-flight files cost a query', () => {
  before(async () => {
    ({ attachLiveStage } = await import('../../server/dist/files/merged-listing.js'));
  });

  it('issues NO lookup at all for a listing of finished files', async () => {
    const entries = [file('a.pdf', 'complete'), file('b.pdf', 'failed'), file('c.pdf', 'skipped')];
    const lookup = spyLookup();
    await attachLiveStage(entries, meta([['a.pdf', 'id-a', 's1'], ['b.pdf', 'id-b', 's1'], ['c.pdf', 'id-c', 's1']]), lookup);
    assert.equal(lookup.calls.length, 0, 'the common case — a page of finished files — must not pay for the rare one');
    assert.ok(entries.every(e => e.progress === undefined));
  });

  it('asks only about the files that are actually in flight', async () => {
    const entries = [file('done.pdf', 'complete'), file('busy.pdf', 'processing'), file('queued.pdf', 'pending')];
    const lookup = spyLookup();
    await attachLiveStage(entries, meta([['done.pdf', 'id-done', 's1'], ['busy.pdf', 'id-busy', 's1'], ['queued.pdf', 'id-q', 's1']]), lookup);
    assert.equal(lookup.calls.length, 1);
    assert.deepEqual(lookup.calls[0].ids.sort(), ['id-busy', 'id-q'], 'the finished file must not be in the query');
  });

  it('never queries a directory row', async () => {
    const entries = [{ name: 'folder', type: 'dir' }];
    const lookup = spyLookup();
    await attachLiveStage(entries, meta([['folder', 'id-f', 's1']]), lookup);
    assert.equal(lookup.calls.length, 0);
  });
});

describe('live stage — a proxy listing asks each member for its own jobs', () => {
  before(async () => {
    ({ attachLiveStage } = await import('../../server/dist/files/merged-listing.js'));
  });

  it('groups the lookup by the member space the file came from', async () => {
    // A job lives in its own space's collection; asking space A about space B's file finds nothing.
    const entries = [file('x.pdf', 'processing'), file('y.pdf', 'processing')];
    const lookup = spyLookup();
    await attachLiveStage(entries, meta([['x.pdf', 'id-x', 'alpha'], ['y.pdf', 'id-y', 'beta']]), lookup);
    const bySpace = Object.fromEntries(lookup.calls.map(c => [c.spaceId, c.ids]));
    assert.deepEqual(bySpace, { alpha: ['id-x'], beta: ['id-y'] });
    assert.ok(entries.every(e => e.progress?.step === 'vlm'), 'both rows decorated, each from its own member');
  });

  it('makes one call per member, not one per file', async () => {
    const entries = [file('x.pdf', 'processing'), file('y.pdf', 'processing'), file('z.pdf', 'pending')];
    const lookup = spyLookup();
    await attachLiveStage(entries, meta([['x.pdf', 'id-x', 'alpha'], ['y.pdf', 'id-y', 'alpha'], ['z.pdf', 'id-z', 'alpha']]), lookup);
    assert.equal(lookup.calls.length, 1, 'an N+1 walk over a directory would be a query per file');
    assert.equal(lookup.calls[0].ids.length, 3);
  });
});

describe('live stage — absence is preserved, not invented', () => {
  before(async () => {
    ({ attachLiveStage } = await import('../../server/dist/files/merged-listing.js'));
  });

  it('leaves the row undecorated when the job has not reported a step yet', async () => {
    // Claimed but silent so far. "We do not know yet" must stay distinct from "the route has no steps",
    // or the bar would draw an empty track that reads as zero progress.
    const entries = [file('new.pdf', 'processing')];
    const lookup = async () => new Map([['id-n', { progressAt: '2026-07-27T12:00:00Z' }]]);
    await attachLiveStage(entries, meta([['new.pdf', 'id-n', 's1']]), lookup);
    assert.equal(entries[0].progress, undefined);
  });

  it('survives a failing lookup — a listing must not fail over a progress bar', async () => {
    const entries = [file('busy.pdf', 'processing')];
    const boom = async () => { throw new Error('mongo is having a day'); };
    await assert.doesNotReject(() => attachLiveStage(entries, meta([['busy.pdf', 'id-b', 's1']]), boom));
    assert.equal(entries[0].progress, undefined);
  });

  it('skips a file whose metadata record was not found in the roll-up', async () => {
    // On disk but with no FileMeta row yet (just uploaded): there is no id to ask about.
    const entries = [file('orphan.pdf', 'processing')];
    const lookup = spyLookup();
    await attachLiveStage(entries, new Map(), lookup);
    assert.equal(lookup.calls.length, 0);
  });
});
