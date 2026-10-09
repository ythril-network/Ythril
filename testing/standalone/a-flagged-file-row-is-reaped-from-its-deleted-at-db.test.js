/**
 * A file row a soft delete flagged is reaped on ITS OWN clock — `deletedAt` plus the space's FILE window — and never on the
 * clock of the file it used to be (bundle-89, E2, Q-418; plan items 12 and 13).
 *
 * ## The defect it prevents
 *
 * With `softDeleteFileMeta` on, a deleted file's row stays in the space's `files` collection FLAGGED with `deletedAt`: the
 * audit record. Nothing ever reaped one on a space with no file retention, and the first design of the reap anchored it on
 * `_expireAt`. That is wrong in a way no review of the reap alone shows: the TTL sweep flags a file BECAUSE its `_expireAt` has
 * passed, so a purge that asks "is `_expireAt` past" removes the audit record on the very next sweep (about five minutes after
 * it was made, `SWEEP_INTERVAL_MS`) — the record would be destroyed by design, which is the opposite of keeping it.
 *
 * ## The rule (docs/userguide/04-settings.md "Retention" and "Keeping a record of deleted files")
 *
 *  1. the sweep that FLAGS an expired file does not also reap it: the audit record outlives the cycle that made it
 *  2. a later sweep inside the window leaves it, however long ago the file's own `_expireAt` passed
 *  3. a sweep past `deletedAt` + the space's file window reaps it (the one case that is red on the base)
 *  4. a space with NO file window reaps nothing, ever: the record is kept (control). This is the reading of plan item 12
 *     ("retention runs from `deletedAt`, with the space's file window") together with the userguide's "keeping a record of
 *     deleted files": with no window there is nothing to count from, so nothing is reaped.
 *
 * Every sweep here is the real one (`sweepExpired(now)`), at a `now` the test chooses; `deletedAt` is read back from the row the
 * sweep wrote, so no clock is guessed. The window is the space's `recordTtlDays.file`, set on the live config the sweep reads.
 *
 * Run: node --test testing/standalone/a-flagged-file-row-is-reaped-from-its-deleted-at-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'b89e2dreap';
const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;
const LONG_PAST = new Date('2026-01-01T00:00:00.000Z');
const sha = (s) => createHash('sha256').update(s).digest('hex');

let acts, door, ttl, loader;

const rowOf = (id) => door.coll(S, 'files').findOne({ _id: id });
const spaceConfig = () => loader.getConfig().spaces.find(s => s.id === S);
const at = (iso, plusMs) => new Date(Date.parse(iso) + plusMs);

/** A file with bytes on disk and a row whose own `_expireAt` is long past; the sweep at `now` retires it. */
async function seedExpiredFile(f) {
  const bytes = `content of ${f}`;
  const abs = path.join(acts.root(), f);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  await door.coll(S, 'files').insertOne(
    build.filemeta(S, f, 3, { sizeBytes: bytes.length, sha256: sha(bytes), _expireAt: LONG_PAST }));
}

/** Seed an expired file and let the real sweep flag it: returns the `deletedAt` that sweep wrote and the `now` it ran at. */
async function flaggedBySweep(f) {
  await seedExpiredFile(f);
  const ranAt = new Date();
  await ttl.sweepExpired(ranAt);
  const row = await rowOf(f);
  assert.ok(row, `the sweep that flagged ${f} also removed its row: the audit record did not outlive the cycle that made it (a reap anchored on _expireAt)`);
  assert.equal(typeof row.deletedAt, 'string', `fixture: the sweep did not flag ${f} (softDeleteFileMeta is on and its _expireAt is past)`);
  return { deletedAt: row.deletedAt, ranAt };
}

describe('a flagged file row is reaped on deletedAt plus the space\'s file window', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'b89e2dreap', space: S });
    ({ door } = acts);
    ttl = await import('../../server/dist/brain/ttl-sweep.js');
    loader = await import('../../server/dist/config/loader.js');
  });
  after(async () => {
    if (loader) loader.getConfig().softDeleteFileMeta = false;
    await acts?.close();
  });
  beforeEach(async () => {
    await acts.reset();
    loader.getConfig().softDeleteFileMeta = true;
    spaceConfig().recordTtlDays = { file: WINDOW_DAYS };
  });

  it('the sweep that flags an expired file leaves the flagged row standing, and so does the next one minutes later', async () => {
    const f = 'docs/audit.txt';
    const { deletedAt, ranAt } = await flaggedBySweep(f);
    // The very next cycle: its _expireAt has been past since January, but the record was made five minutes ago.
    await ttl.sweepExpired(new Date(ranAt.getTime() + 5 * 60_000));
    const row = await rowOf(f);
    assert.equal(row?.deletedAt, deletedAt,
      'a sweep five minutes after the flag reaped (or re-flagged) the audit record: the reap clock is the file\'s _expireAt, not deletedAt');
  });

  it('a sweep inside the window keeps the flagged row, however long ago the file\'s own _expireAt passed', async () => {
    const f = 'docs/inside.txt';
    const { deletedAt } = await flaggedBySweep(f);
    await ttl.sweepExpired(at(deletedAt, (WINDOW_DAYS - 1) * DAY_MS));
    assert.equal((await rowOf(f))?.deletedAt, deletedAt,
      `a sweep ${WINDOW_DAYS - 1} days after the flag reaped a record the ${WINDOW_DAYS}-day file window keeps`);
  });

  it('a sweep past deletedAt plus the file window reaps the flagged row', async () => {
    const f = 'docs/reaped.txt';
    const neighbour = 'docs/neighbour.txt';
    const { deletedAt } = await flaggedBySweep(f);
    // A live file with no expiry sits beside it: a reap that clears the collection, or reads the wrong rows, takes it too.
    await door.coll(S, 'files').insertOne(build.filemeta(S, neighbour, 4, { sizeBytes: 3, sha256: sha('abc') }));
    await ttl.sweepExpired(at(deletedAt, WINDOW_DAYS * DAY_MS + 60_000));
    const left = (await door.coll(S, 'files').find({}, { projection: { _id: 1 } }).toArray()).map(r => r._id).sort();
    assert.deepEqual(left, [neighbour],
      'left = the rows still stored after a sweep one minute past deletedAt + the file window: the flagged audit record is never reaped (and the live neighbour must stay)');
  });

  it('control: a space with NO file window reaps no flagged row, however old (the audit record is kept)', async () => {
    delete spaceConfig().recordTtlDays;
    const f = 'docs/kept.txt';
    const old = 'docs/older.txt';
    // The row a delete flagged long ago, with no stamp of any kind (no window ever applied to it), and one the sweep flags now.
    await door.coll(S, 'files').insertOne(build.filemeta(S, old, 2, { deletedAt: '2016-01-01T00:00:00.000Z' }));
    const { deletedAt } = await flaggedBySweep(f);
    await ttl.sweepExpired(at(deletedAt, 3650 * DAY_MS));
    assert.deepEqual({ [f]: typeof (await rowOf(f))?.deletedAt, [old]: typeof (await rowOf(old))?.deletedAt },
      { [f]: 'string', [old]: 'string' },
      'a space that keeps files for ever reaped the record a deleted file left: with no file window there is nothing to reap by');
  });
});
