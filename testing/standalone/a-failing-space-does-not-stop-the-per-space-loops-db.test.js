/**
 * One space whose step fails does not stop the spaces after it in a background loop (`Q-386`, the 5.6.6 patch).
 *
 * ## The defect it prevents
 *
 * Four loops walked the configured spaces with no `try` of their own: the legacy read-spill sweep (`files/legacy-spill-sweep.ts`, run in
 * every TTL cycle) and the embed queue's claim, stall-reset and revive (`brain/embed-queue.ts`). A throw from one space — a collection
 * that cannot be read, an index that is rebuilding — left the loop at that space. Every space AFTER it in the config was skipped, every
 * cycle, for as long as the first one failed: a spill never removed, a queued job never claimed, a stalled job never returned to the
 * pool. The claim loop is the worker's, so one bad space starved the embedding of all the others. And the failure named no space.
 *
 * ## What is held, for each loop
 *
 *  - the space AFTER the failing one is still served (the failing one is first in the config, so a loop that stops at it serves nothing);
 *  - the failure is said ONCE for that space and step — a recurring cycle names it again only after the report window — naming the space.
 *
 * ## How
 *
 * The real functions against the harness Mongo, with the driver call each loop makes on ONE space's collection refused (a rejecting
 * `find`, `findOneAndUpdate` or `updateMany`: the driver's own throw, from the first thing the loop does there).
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-failing-space-does-not-stop-the-per-space-loops-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const skip = await mongoSkipReason();
/** First in the config, so a loop that stops at the failing space serves nothing. */
const BAD = 'loopbad';
const OK = 'loopok';
const LONG_AGO = '2000-01-01T00:00:00.000Z';

describe('a failing space does not stop the per-space loops', { skip }, () => {
  let door; let queue; let sweepLegacySpills; let proto; let real; let armed;

  /** The log lines that name the failing space, for one step. */
  const namingBad = (lines, step) => lines.filter(l => l.includes(step) && l.includes(`'${BAD}'`));
  const spill = `_tmp/graph-${randomUUID()}.json`;
  const jobs = (space) => door.mongo.getDb().collection(`${space}_embed_jobs`);

  before(async () => {
    door = await openPushDoor({ suite: 'perspaceloops', spaces: [BAD, OK].map(id => ({ id, label: id, folders: [] })) });
    queue = await import('../../server/dist/brain/embed-queue.js');
    ({ sweepLegacySpills } = await import('../../server/dist/files/legacy-spill-sweep.js'));
    proto = Object.getPrototypeOf(door.mongo.col('probe'));
    real = { find: proto.find, findOneAndUpdate: proto.findOneAndUpdate, updateMany: proto.updateMany };
    const refused = (method) => function armedMethod(...args) {
      if (armed?.has(method) && this.collectionName.startsWith(`${BAD}_`)) {
        const failure = new Error(`${method} refused: simulated failure on ${this.collectionName}`);
        return method === 'find' ? { toArray: () => Promise.reject(failure) } : Promise.reject(failure);
      }
      return real[method].apply(this, args);
    };
    for (const method of Object.keys(real)) proto[method] = refused(method);
  });
  after(async () => {
    if (proto && real) Object.assign(proto, real);
    await door?.close();
  });
  beforeEach(async () => {
    armed = new Set();
    for (const space of [BAD, OK]) { await jobs(space).deleteMany({}); await door.coll(space, 'files').deleteMany({}); }
  });

  it('the legacy spill sweep removes the spill in the space after the failing one, and says the failure once', { timeout: 60_000 }, async () => {
    await door.coll(OK, 'files').insertOne(build.filemeta(OK, spill, 1));
    armed.add('find');
    const first = await logLinesDuring(() => sweepLegacySpills());
    const second = await logLinesDuring(() => sweepLegacySpills());
    assert.equal(first.result.removed, 1, 'the spill in the space behind the failing one was not removed');
    assert.equal(await door.coll(OK, 'files').countDocuments({ _id: spill }), 0);
    const said = [...namingBad(first.lines, 'Legacy spill sweep'), ...namingBad(second.lines, 'Legacy spill sweep')];
    assert.equal(said.length, 1, `the failing space is said ${said.length} time(s) across two cycles: ${said.join(' | ')}`);
  });

  it('the embed claim serves the space after the failing one, and says the failure once', { timeout: 60_000 }, async () => {
    await queue.enqueueEmbedJob(OK, 'fact', 'claim-me');
    armed.add('findOneAndUpdate');
    const { result: claimed, lines } = await logLinesDuring(() => queue.claimNextEmbedJob([BAD, OK]));
    assert.equal(claimed?.recordId, 'claim-me', 'the job queued in the space behind the failing one was not claimed');
    assert.equal(namingBad(lines, 'Embed claim').length, 1, `the failing space is not said exactly once: ${lines.join(' | ')}`);
  });

  it('the embed stall reset returns the stalled job in the space after the failing one, and says the failure once', { timeout: 60_000 }, async () => {
    await queue.enqueueEmbedJob(OK, 'fact', 'stalled');
    await jobs(OK).updateOne({ _id: 'fact:stalled' }, { $set: { status: 'processing', progressAt: LONG_AGO } });
    armed.add('updateMany');
    const first = await logLinesDuring(() => queue.resetStalledEmbedJobs([BAD, OK], 60_000));
    const second = await logLinesDuring(() => queue.resetStalledEmbedJobs([BAD, OK], 60_000));
    assert.equal(first.result, 1, 'the stalled job in the space behind the failing one was not returned to the pool');
    assert.equal((await jobs(OK).findOne({ _id: 'fact:stalled' }))?.status, 'pending');
    const said = [...namingBad(first.lines, 'Embed stall reset'), ...namingBad(second.lines, 'Embed stall reset')];
    assert.equal(said.length, 1, `the failing space is said ${said.length} time(s) across two cycles: ${said.join(' | ')}`);
  });

  it('the revive of failed jobs revives the job in the space after the failing one, and says the failure once', { timeout: 60_000 }, async () => {
    await queue.enqueueEmbedJob(OK, 'fact', 'dead');
    await jobs(OK).updateOne({ _id: 'fact:dead' }, { $set: { status: 'failed' } });
    armed.add('updateMany');
    const first = await logLinesDuring(() => queue.reviveFailedEmbedJobs([BAD, OK], '9.9.9'));
    const second = await logLinesDuring(() => queue.reviveFailedEmbedJobs([BAD, OK], '9.9.9'));
    assert.equal(first.result, 1, 'the failed job in the space behind the failing one was not revived');
    assert.equal((await jobs(OK).findOne({ _id: 'fact:dead' }))?.status, 'pending');
    const said = [...namingBad(first.lines, 'Embed revive'), ...namingBad(second.lines, 'Embed revive')];
    assert.equal(said.length, 1, `the failing space is said ${said.length} time(s) across two cycles: ${said.join(' | ')}`);
  });
});
