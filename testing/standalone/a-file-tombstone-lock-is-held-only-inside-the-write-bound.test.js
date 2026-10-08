/**
 * Everything a space's file-tombstone publish lock runs is bounded, so one slow store call cannot hold every deletion of
 * the space behind it.
 *
 * ## What was broken
 *
 * A publish, a settle and a wipe of a space take one lock per space (`publishLock`, `files/tombstones.ts`), and a delete
 * awaits its publish. The writes inside were bounded (the position hold runs them inside the write bound), but the reads
 * before them were plain `find()`s with no deadline: one read that hung held the lock for as long as the store took, and
 * every DELETE and move of that space queued behind it, where before an act failed alone (bundle-71 pre-ship lens sweep,
 * reliability). Inside `withinWriteBound` every operation, read or write, carries the per-operation bound and the scope's
 * deadline (`db/write-bound.ts`), so the holder ends, and a waiter waits at most that long.
 *
 * The rule is asserted over every call of the lock, derived from the source, so a new caller of it is held to it too.
 *
 * Run: node --test testing/standalone/a-file-tombstone-lock-is-held-only-inside-the-write-bound.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { argumentsOf } from './_structural-window.mjs';

const SRC = readFileSync('server/src/files/tombstones.ts', 'utf8');

/** Each `publishLock.run(` call: its index, and the callback it hands the lock. */
function lockCalls(src) {
  return [...src.matchAll(/\bpublishLock\.run\s*\(/g)].map(m => {
    const args = argumentsOf(src, m.index + m[0].length - 1, 'publishLock.run');
    return { at: m.index, callback: args[1] ?? '' };
  });
}

describe('a file-tombstone lock is held only inside the write bound', () => {
  const calls = lockCalls(SRC);

  it('finds the lock and its callers (the scan still works)', () => {
    assert.match(SRC, /const\s+publishLock\s*=\s*keyedLock\(/, 'the per-space lock is a keyedLock named publishLock');
    assert.ok(calls.length >= 2, `found ${calls.length} publishLock.run( calls; the publish and the wipe both take it`);
  });

  it('every callback the lock runs is a write-bound scope', () => {
    const unbounded = calls.filter(c => !/^(?:async\s*)?\(\s*\)\s*=>\s*withinWriteBound\s*\(/.test(c.callback.trim()));
    assert.deepEqual(unbounded.map(c => SRC.slice(0, c.at).split('\n').length), [],
      'a publishLock.run( callback whose body is not withinWriteBound(...) can hold the lock for as long as an unbounded read takes (lines listed)');
  });

  it('the check sees an unbounded callback (red case)', () => {
    const bad = 'const publishLock = keyedLock();\nawait publishLock.run(spaceId, async () => { await x.find({}).toArray(); });\n';
    const found = lockCalls(bad).filter(c => !/^(?:async\s*)?\(\s*\)\s*=>\s*withinWriteBound\s*\(/.test(c.callback.trim()));
    assert.equal(found.length, 1);
  });
});
