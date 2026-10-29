/**
 * The file-tombstone clock says, once, that its seed could not be read, whatever the failure was (Q-415 item 4).
 *
 * ## The defect it would otherwise be
 *
 * The file stream's seed failure policy is `wall-clock`: a seed that cannot be read stamps from the wall clock alone, and the clock
 * is bound to say so (`util/position-clock.ts`). The report used to say it only for a failure the store did not cause (a status
 * under 500), so the one case that matters most, a store that answers the write and not the read before it, was the one case
 * with no line and no count: a restart guarantee that is quietly off, with nothing to read.
 *
 * ## The rule this file holds
 *
 *  1. **A store-side seed failure is said**, through the shared reporter (`reportSpaceFailure`, step `File tombstone clock seed`):
 *     one line in the window, and the write still lands.
 *  2. **It is counted**: `ythril_file_tombstone_seed_fallback_total{space}` moves, once per seed that could not be read (the line is one per window, the count is every one).
 *
 * ## The failure
 *
 * Injected at the seed read only (`_b81c-seed-fault.mjs`, the `positionAt` descending read), as the driver's own network error, in
 * a space this process has never stamped in: a seeded stream never reads again.
 *
 * Run: node --test testing/standalone/the-tombstone-clock-says-a-store-side-seed-failure-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoNetworkError } from 'mongodb';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { failTheSeedRead } from './_b81c-seed-fault.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'tombclockseed';
const COUNTER = 'ythril_file_tombstone_seed_fallback_total';
const STEP = 'File tombstone clock seed';

const seen = { lines: [], published: undefined, before: undefined, after: undefined, metricMissing: false };

/** The counter's value for `space`: 0 when the series is absent, 'missing' when there is no such metric. */
async function countFor(register, space) {
  const m = register.getSingleMetric(COUNTER);
  if (!m) return 'missing';
  const { values } = await m.get();
  return values.find(v => v.labels?.space === space)?.value ?? 0;
}

describe('the file-tombstone clock says a store-side seed failure', { skip }, () => {
  let acts, restore = () => {}, unsubscribe = () => {};

  before(async () => {
    acts = await openFileActDoors({ suite: 'tombclockseed', space: S });
    const tombstones = await import('../../server/dist/files/tombstones.js');
    const { register } = await import('../../server/dist/metrics/registry.js');
    const { subscribeLogLines } = await import('../../server/dist/util/log.js');
    await acts.seed('seeded.txt');
    seen.before = await countFor(register, S);
    unsubscribe = subscribeLogLines(l => { seen.lines.push(l); });
    restore = failTheSeedRead(acts.door.mongo, S, { field: 'positionAt', error: new MongoNetworkError('connection reset') });
    const pending = await tombstones.writePendingFileTombstones(S, ['seeded.txt']);
    await tombstones.confirmFileTombstones(pending);
    seen.published = await acts.door.mongo.col(`${S}_file_tombstones`).findOne({ _id: pending.docs[0]._id });
    seen.after = await countFor(register, S);
    restore(); restore = () => {};
  });
  after(async () => { restore(); unsubscribe(); await acts?.close(); });

  it('the write still lands: the stamp comes from the wall clock alone', () => {
    assert.ok(typeof seen.published?.positionAt === 'string', `the tombstone row holds no published position: ${JSON.stringify(seen.published)}`);
  });

  it(`says it once, through the shared reporter (${STEP})`, () => {
    const hits = seen.lines.filter(l => l.includes(STEP));
    assert.equal(hits.length, 1, `expected one line naming '${STEP}' for a store-side seed failure; the log held ${seen.lines.length} line(s): ${JSON.stringify(seen.lines.slice(-5))}`);
  });

  it(`counts it in ${COUNTER}{space}`, () => {
    assert.notEqual(seen.before, 'missing', `no metric named ${COUNTER} is registered`);
    assert.ok(seen.after > seen.before, `${COUNTER}{space="${S}"} moved from ${seen.before} to ${seen.after}`);
  });
});
