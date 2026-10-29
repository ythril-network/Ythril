/**
 * The TTL settle says a path it cannot look at ONCE per window, however many passes meet it (bundle-88, Q-411 half 2).
 *
 * ## The defect
 *
 * `settleFromTheDisk` left a pending tombstone whose path cannot be looked at pending, which is right, and said so with a bare
 * `log.warn` per row per pass: a permanent fault (a mode on a directory) was a line per row per sweep for ever. Every other step of the
 * housekeeping says its failure through the shared reporter, once per window, and counts every one.
 *
 * ## The rule this file states
 *
 * Two settle passes over one unlookable pending row emit one line naming the path, and the reporter counts two failures. When the
 * path is looked at again, the next failure is news.
 *
 * ## Seen red
 *
 * On the base (1e430410c): two lines, and no failure counted.
 *
 * Run: node --test testing/standalone/the-settle-says-an-unlookable-path-once-per-window-db.test.js
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'settlelook';
const OLD = '2026-09-01T00:00:00.000Z';
const PAST_THE_WINDOW = () => new Date(Date.now() + 24 * 3_600_000);

let acts, tombstones, signals, unsubscribe;
const realLstat = fsp.lstat;
let unlookable = null;
const failures = [];

describe('the settle says an unlookable path once per window', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'settlelook', space: S });
    tombstones = await import('../../server/dist/files/tombstones.js');
    signals = await import('../../server/dist/util/housekeeping-signals.js');
    unsubscribe = signals.onHousekeepingSignal((e) => { if (e.type === 'space-failure') failures.push(e); });
    fsp.lstat = function (p, ...rest) {
      if (unlookable !== null && String(p).endsWith(`${path.sep}${unlookable}`)) {
        return Promise.reject(Object.assign(new Error(`EACCES: permission denied, lstat '${p}'`), { code: 'EACCES', syscall: 'lstat' }));
      }
      return realLstat.call(fsp, p, ...rest);
    };
  });
  after(async () => { fsp.lstat = realLstat; unsubscribe?.(); await acts?.close(); });
  beforeEach(async () => { await acts.reset(); failures.length = 0; unlookable = 'locked.txt'; });
  afterEach(() => { unlookable = null; });

  it('two passes over one unlookable pending row: one line, two counted failures', async () => {
    await acts.door.coll(S, 'file_tombstones').insertOne(
      { _id: 'pend', spaceId: S, path: 'locked.txt', deletedAt: OLD, writtenAt: OLD, settleAt: OLD, pending: true });
    const { lines } = await logLinesDuring(async () => {
      await tombstones.settleStalePendingFileTombstones(S, PAST_THE_WINDOW());
      await tombstones.settleStalePendingFileTombstones(S, new Date(PAST_THE_WINDOW().getTime() + 3_600_000));
    });
    const about = lines.filter(l => l.includes('locked.txt'));
    assert.equal(about.length, 1, `the settle said the path ${about.length} times: ${JSON.stringify(about)}`);
    const settleFailures = failures.filter(f => /settle/i.test(f.step));
    assert.equal(settleFailures.length, 2, `the reporter did not count each pass: ${JSON.stringify(failures)}`);
    assert.ok((await acts.raw()).some(t => t._id === 'pend' && t.pending), 'the unlookable row did not stay pending');
  });
});
