/**
 * Database-level test: the suppression sweep, walked over the spaces at boot and asked for after a meta write, says a
 * failing space ONCE and goes on (Q-274, bundle-53 G18).
 *
 * ## What it pins
 *
 * `sweepEverySpaceAtBoot` was a bare `for` over `concreteSpaces()`. The per-space catch lived in `sweepLatestMeta`, the
 * non-loop caller, as an ad-hoc `log.warn`: no shared words, no counter (`ythril_housekeeping_space_failures_total`), no step
 * name the registry could pre-declare, and nothing bounding a space whose read hangs — the sweep is an unindexed scan per record
 * kind, so a hung space held the whole boot sweep for as long as the driver waited.
 *
 * Now the boot sweep is `eachSpace` (one at a time, inside the housekeeping bound) and a space's failure REACHES the walk, so it
 * is said in the walk's words and the walk's rules apply: a hung space is worded as running past its bound and quarantined, a
 * store that does not answer stops the walk after the first space. A sweep with no walk above it (`sweepAfterMetaWrite`, and the
 * coalescing runner's un-awaited rerun) says its own failure through `reportSpaceFailure`, which is synchronous and never
 * throws. One report per failure either way: a boot walk that JOINS a running sweep is handed that run's failure, and the rerun
 * the join queued says its own.
 *
 * ## How the failure is made, and why it is real
 *
 * A VIEW named like the space's facts collection, over a source document whose pipeline stage cannot convert a string: every read
 * of it is refused by the server (code 241) while the store answers every other call. A space that fails and a store that does
 * not. The stalled space is `withStalledReads`, ended by the housekeeping bound at under a second.
 *
 * Mutations seen red (restored by hand): the boot loop put back to a bare `for`, the report put back to a bare `log.warn`, the
 * step undeclared, the walk's bound removed (the stall runs to its end).
 *
 * Run: `npm run test:up` first, then  node --test testing/standalone/the-boot-suppression-sweep-isolates-a-failing-space-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { withCollectionAsView, withStalledReads, setWriteBoundForTest } from './_write-faults.mjs';
import { MongoNetworkError } from 'mongodb';
import { waitFor } from '../_shared/wait-for.mjs';
import { sleep } from '../_shared/sleep.mjs';

const skip = await mongoSkipReason();

const STEP = 'Suppression sweep';
const SUPPRESSING = { suppressEmbeddings: true };
// One failing space per case: the report's throttle is process-wide, so a space that failed in one case would say nothing in the next.
const SPACES = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india'];
const HEALTHY = ['bravo', 'charlie'];
const VECTOR = { embedding: [0.1, 0.2, 0.3], embeddingModel: 'test-model' };
const STALL_MS = 1000;
const BOUND_MS = 400;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-g18-'));
// The loader reads CONFIG_PATH when it is first imported: set before any import below.
process.env['CONFIG_PATH'] = path.join(tmp, 'config.json');

let mongo;
let sweep;
let signals;
let walk;
let unsubscribeLog = () => {};
let unsubscribeSignals = () => {};
const lines = [];
const failures = [];
const unhandled = [];
const onUnhandled = (err) => { unhandled.push(err); };

const warnsFor = (space) => lines.filter(l => l.includes('WARN') && l.includes(STEP) && l.includes(`'${space}'`));
/**
 * Reads of `collName` fail with `makeError()` once `gate` (a promise) opens: `find(...).toArray()` is what the sweep reads with.
 * Returns the restore. A failure made at the call, not by the store, so the CLASS of the error is the test's to choose.
 */
function failReadsOf(proto, collName, makeError, gate = Promise.resolve()) {
  const original = proto.find;
  proto.find = function patched(...args) {
    if (this.collectionName !== collName) return original.apply(this, args);
    return { toArray: async () => { await gate; throw makeError(); } };
  };
  return () => { proto.find = original; };
}
const hasVector = async (space) => (await mongo.col(`${space}_facts`).findOne({ _id: `${space}-1` }))?.embedding !== undefined;

/**
 * Run `fn` while EVERY collection of `space` hangs past the bound. The sweep reads with a filter, and the server may test the filter
 * before the stalling stage: documents the sweep's filter MATCHES are what must reach the stage, so `seed` is as many of them as the
 * fixture would seed stalling ones, and `readerFilter` is the filter the sweep reads that collection with: `suppressedWithVectorFilter`
 * for a record kind (the sweep's own function, over the meta the config gives this space), and the space tier's
 * `{ embedding: { $exists: true } }` for files (`sweepFiles`, which is not exported). The kinds are derived from the sweep's own, with a
 * floor, so a sweep that went on past the first timeout would pay one bound per kind. Returns how many collections hung.
 *
 * A hung collection is a VIEW for the duration and comes back EMPTY (`withCollectionAsView` drops and recreates it), so the space's
 * own records are put back afterwards: without that, a hung healthy space would read as swept because its record is simply gone.
 */
async function withEveryCollectionHung(space, fn) {
  const db = mongo.getDb();
  const own = await db.collection(`${space}_facts`).find({}).toArray();
  const { COLLECTION_SUFFIX } = await import('../../server/dist/config/types.js');
  const parts = [
    ...Object.entries(COLLECTION_SUFFIX).map(([kind, suffix]) => ({ suffix, readerFilter: sweep.suppressedWithVectorFilter(SUPPRESSING, kind) })),
    { suffix: 'files', readerFilter: { embedding: { $exists: true } } },
  ];
  assert.ok(parts.length >= 5, `only ${parts.length} collections derived for the sweep's kinds`);
  const seed = Array.from({ length: Math.ceil(STALL_MS / 200) }, (_, i) => ({ _id: `g18-match-${i}`, ...VECTOR, suppressEmbeddings: true }));
  const putBack = (suffix) => (suffix === 'facts' && own.length > 0 ? () => db.collection(`${space}_facts`).insertMany(own) : undefined);
  const stalled = (rest) => rest.length === 0 ? fn()
    : withStalledReads(db, `${space}_${rest[0].suffix}`, `g18_stall_src_${rest[0].suffix}`,
      { ms: STALL_MS, readerFilter: rest[0].readerFilter, seed, restore: putBack(rest[0].suffix) },
      () => stalled(rest.slice(1)));
  await stalled(parts);
  return parts.length;
}

/** The spaces the walk SAID failed, each by the shared report's words. */
const spacesSaidToFail = () => new Set(lines.map(l => new RegExp(`${STEP} failed for space '([^']+)'`).exec(l)?.[1]).filter(Boolean));

/**
 * The healthy spaces were swept after the hung one — EXCEPT one the walk itself said ran past the bound. On a slow host (a shared CI
 * runner) a healthy space can time out too: the walk then reports it in the bound's words and quarantines it, exactly as it does the
 * hung one, and it is not swept. Requiring it swept made this assertion a statement about the host (Q-455, CI run 37962407565). Only
 * that verdict excuses a space: one that failed in other words, or said nothing and stayed unswept, still fails. And at least one
 * healthy space must have been swept, or the case shows nothing about the walk going on past a hung space.
 */
async function assertHealthySpacesSwept() {
  const said = spacesSaidToFail();
  const swept = [];
  for (const space of HEALTHY) {
    if (said.has(space)) {
      assert.ok(warnsFor(space).some(l => new RegExp(`ran past its time bound of ${BOUND_MS} ms .*retried after quarantine`).test(l)),
        `'${space}' failed for a reason other than the bound, so it is not excused:\n${warnsFor(space).join('\n')}`);
      assert.ok(walk.quarantinedSpaces().includes(space), `'${space}' timed out but was not quarantined`);
      continue;
    }
    assert.equal(await hasVector(space), false, `'${space}' was not swept after the hung space`);
    swept.push(space);
  }
  assert.ok(swept.length >= 1, `no healthy space was swept (every one timed out), so the walk going on past the hung space is not shown`);
}

describe('the suppression sweep isolates a failing space', { skip }, () => {
  before(async () => {
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'g18-sweep', instanceName: 'G18', tokens: [], networks: [],
      spaces: SPACES.map(id => ({ id, name: id, meta: SUPPRESSING })),
    }));
    mongo = await openTestMongo('g18sweep');
    sweep = await import('../../server/dist/brain/suppression-sweep.js');
    signals = await import('../../server/dist/util/housekeeping-signals.js');
    walk = await import('../../server/dist/util/housekeeping-walk.js');
    const { subscribeLogLines } = await import('../../server/dist/util/log.js');
    unsubscribeLog = subscribeLogLines(l => lines.push(l));
    unsubscribeSignals = signals.onHousekeepingSignal(e => { if (e.type === 'space-failure' && e.step === STEP) failures.push(e); });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    process.on('unhandledRejection', onUnhandled);

    const db = mongo.getDb();
    for (const space of HEALTHY) await db.collection(`${space}_facts`).insertOne({ _id: `${space}-1`, spaceId: space, type: 'note', fact: 'f', seq: 1, ...VECTOR });
    // The source a failing view reads: one document the view's stage cannot convert, that the sweep's filter matches.
    await db.collection('g18_src').insertOne({ _id: 'bad', a: 'not-a-number', ...VECTOR });
  });

  after(async () => {
    process.off('unhandledRejection', onUnhandled);
    unsubscribeLog();
    unsubscribeSignals();
    await closeTestMongo();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('declares its step, so its failure counter starts at 0 before the first failure', () => {
    assert.ok(signals.declaredSteps().includes(STEP), `the step '${STEP}' is not declared: the counter has no series until the first failure`);
  });

  it('a failing space at boot is reported ONCE and counted, and the spaces after it are swept', async () => {
    lines.length = 0;
    failures.length = 0;
    const db = mongo.getDb();
    await withCollectionAsView(db, 'alpha_facts', 'g18_src', async () => {
      await sweep.sweepEverySpaceAtBoot();
    }, { pipeline: [{ $addFields: { _x: { $toInt: '$a' } } }] });

    for (const space of HEALTHY) assert.equal(await hasVector(space), false, `'${space}' still holds its vector: the failing space before it stopped the sweep`);
    const said = warnsFor('alpha');
    assert.equal(said.length, 1, `${said.length} lines for the failing space, expected one:\n${lines.join('\n')}`);
    assert.match(said[0], new RegExp(`${STEP} failed for space 'alpha': .* — retried with the next meta write$`),
      `the line is not the shared report's wording: ${said[0]}`);
    for (const space of HEALTHY) assert.equal(warnsFor(space).length, 0, `a healthy space was reported: ${warnsFor(space)[0]}`);
    assert.deepEqual(failures, [{ type: 'space-failure', step: STEP, kind: 'failure' }], 'the failure was not counted exactly once under the step');
  });

  it('a space reached through sweepAfterMetaWrite logs and counts, and neither throws nor rejects unhandled', async () => {
    lines.length = 0;
    failures.length = 0;
    unhandled.length = 0;
    const db = mongo.getDb();
    await withCollectionAsView(db, 'delta_facts', 'g18_src', async () => {
      assert.doesNotThrow(() => sweep.sweepAfterMetaWrite('delta', SUPPRESSING), 'asking for the sweep threw into the meta write');
      assert.ok(await waitFor(() => warnsFor('delta').length > 0, 10_000, 50, undefined, { what: 'the failed meta-write sweep to be said' }));
      // Room for an unhandled rejection or a second line to show itself.
      await sleep(300);
    }, { pipeline: [{ $addFields: { _x: { $toInt: '$a' } } }] });

    const said = warnsFor('delta');
    assert.equal(said.length, 1, `${said.length} lines, expected one:\n${said.join('\n')}`);
    assert.match(said[0], new RegExp(`${STEP} failed for space 'delta': .* — retried with the next meta write$`), said[0]);
    assert.deepEqual(failures, [{ type: 'space-failure', step: STEP, kind: 'failure' }], 'the failure was not counted exactly once under the step');
    assert.deepEqual(unhandled, [], 'the sweep rejected unhandled');
  });

  it('a store that stops answering at boot stops the walk after the first space and says so once', async () => {
    lines.length = 0;
    failures.length = 0;
    for (const space of HEALTHY) await mongo.col(`${space}_facts`).updateOne({ _id: `${space}-1` }, { $set: VECTOR });
    // A network error is the store's CONDITION by its class, so the verdict is store-down without a ping.
    const restore = failReadsOf(Object.getPrototypeOf(mongo.col('probe')), 'alpha_facts', () => new MongoNetworkError('connection 7 closed'));
    try { await sweep.sweepEverySpaceAtBoot(); } finally { restore(); }

    for (const space of HEALTHY) assert.equal(await hasVector(space), true, `'${space}' was swept after the store stopped answering: the walk went on`);
    assert.equal(lines.filter(l => l.includes('WARN') && l.includes(`${STEP} stopped: the store is not answering`)).length, 1, `no single stop line:\n${lines.join('\n')}`);
    assert.equal(warnsFor('alpha').length, 0, 'the first space was reported as its own failure, not the store\'s');
    assert.deepEqual(failures, [{ type: 'space-failure', step: STEP, kind: 'store_down' }], 'the stop was not counted once as store_down');
  });

  it('with no walk above it, a failure on the meta-write path is said once per sweep, a rerun included, and never rejects unhandled', async () => {
    lines.length = 0;
    failures.length = 0;
    unhandled.length = 0;
    let open;
    const gate = new Promise(r => { open = r; });
    const restore = failReadsOf(Object.getPrototypeOf(mongo.col('probe')), 'foxtrot_facts', () => new Error('foxtrot read refused'), gate);
    try {
      sweep.sweepAfterMetaWrite('foxtrot', SUPPRESSING);
      await sleep(50); // the first sweep is now held at its read
      sweep.sweepAfterMetaWrite('foxtrot', SUPPRESSING); // joins it and queues one rerun, which nobody awaits
      open();
      assert.ok(await waitFor(() => failures.length >= 2, 10_000, 50, undefined, { what: 'the sweep and its rerun to fail' }));
      await sleep(300);
    } finally { restore(); }

    assert.equal(failures.length, 2, `${failures.length} failures counted for one sweep and one rerun: a failure was said twice or lost`);
    assert.equal(warnsFor('foxtrot').length, 1, `the line is said once per window:\n${lines.join('\n')}`);
    assert.deepEqual(unhandled, [], 'a sweep rejected unhandled');
  });

  it('a boot walk that joins a sweep already running is handed its failure, and it is said once', async () => {
    lines.length = 0;
    failures.length = 0;
    unhandled.length = 0;
    let open;
    const gate = new Promise(r => { open = r; });
    const restore = failReadsOf(Object.getPrototypeOf(mongo.col('probe')), 'golf_facts', () => new Error('golf read refused'), gate);
    let boot;
    try {
      sweep.sweepAfterMetaWrite('golf', SUPPRESSING);
      await sleep(50); // held at its read
      boot = sweep.sweepEverySpaceAtBoot(); // reaches golf, joins the held sweep
      await sleep(300);
      open();
      await boot;
      await sleep(300);
    } finally { restore(); }

    // The held sweep failed once (the walk, which awaited it, says it) and the rerun the join queued failed once (nobody
    // awaited it, so it says itself): two failures, two reports, never three.
    assert.equal(failures.length, 2, `${failures.length} failures counted for one sweep and its rerun`);
    assert.equal(warnsFor('golf').length, 1, `the line is said once per window:\n${lines.join('\n')}`);
    assert.deepEqual(unhandled, [], 'a sweep rejected unhandled');
  });

  it('a refusal on one record kind goes on to the others, and says what failed', async () => {
    const db = mongo.getDb();
    await db.collection('hotel_entities').insertOne({ _id: 'hotel-1', spaceId: 'hotel', type: 'concept', name: 'e', seq: 1, ...VECTOR });
    let thrown;
    await withCollectionAsView(db, 'hotel_facts', 'g18_src', async () => {
      try { await sweep.sweepSuppressedVectors('hotel', SUPPRESSING); } catch (err) { thrown = err; }
    }, { pipeline: [{ $addFields: { _x: { $toInt: '$a' } } }] });

    assert.ok(thrown, 'a refused kind was swallowed: nothing says the sweep did not finish');
    assert.equal((await db.collection('hotel_entities').findOne({ _id: 'hotel-1' })).embedding, undefined, 'a refusal on one kind stopped the others: the entity kept its vector');
    assert.doesNotMatch(thrown.message, /not reached/, 'a plain refusal was taken for a reason to stop');
  });

  it('a timeout or an unreachable store on one record kind stops the space there and carries the rest as not reached', async () => {
    const { StoreTimeout } = await import('../../server/dist/db/write-timeout.js');
    const db = mongo.getDb();
    // The kinds AFTER facts, in the sweep's own order (derived: the order is the sweep's, not this file's).
    const { COLLECTION_SUFFIX } = await import('../../server/dist/config/types.js');
    const kinds = Object.keys(COLLECTION_SUFFIX);
    const after = kinds.slice(kinds.indexOf('fact') + 1);
    assert.ok(after.length >= 1, 'no record kind is swept after facts: this case has nothing to show');
    const coll = `india_${COLLECTION_SUFFIX[after[0]]}`;
    await db.collection(coll).insertOne({ _id: 'india-1', spaceId: 'india', ...VECTOR });
    for (const makeError of [() => new StoreTimeout('a read'), () => new MongoNetworkError('connection 3 closed')]) {
      await db.collection(coll).updateOne({ _id: 'india-1' }, { $set: VECTOR });
      const restore = failReadsOf(Object.getPrototypeOf(mongo.col('probe')), 'india_facts', makeError);
      let thrown;
      try { await sweep.sweepSuppressedVectors('india', SUPPRESSING); } catch (err) { thrown = err; } finally { restore(); }

      assert.ok(thrown, 'the failure was swallowed');
      for (const kind of [...after, 'file']) assert.match(thrown.message, new RegExp(`${kind} \\(not reached\\)`), `'${kind}' is not named as not reached: ${thrown.message}`);
      assert.equal((await db.collection(coll).findOne({ _id: 'india-1' })).embedding !== undefined, true, 'the sweep went on past a timeout / an unreachable store');
    }
  });

  it('a space whose read hangs is ended by the housekeeping bound, reported, and the others are swept', async () => {
    lines.length = 0;
    failures.length = 0;
    for (const space of HEALTHY) {
      await mongo.col(`${space}_facts`).updateOne({ _id: `${space}-1` }, { $set: VECTOR });
    }
    const restore = await setWriteBoundForTest({ housekeepingOpMs: BOUND_MS });
    // The cost of a hung space is the number of reads it was made to wait out, one bound each. COUNTED, not timed: the boot sweep
    // walks every space of the file and a slow store (a shared CI host) stretches the wall clock of the healthy ones, so a time
    // figure here was a statement about the host (seen at 0.1 CPU on the store: 1399 ms against 3 bounds with ONE bound paid).
    let echoReads = 0;
    let hungCollections = 0;
    const proto = Object.getPrototypeOf(mongo.col('probe'));
    const originalFind = proto.find;
    try {
      hungCollections = await withEveryCollectionHung('echo', async () => {
        proto.find = function counted(...args) {
          if (String(this.collectionName).startsWith('echo_')) echoReads++;
          return originalFind.apply(this, args);
        };
        await sweep.sweepEverySpaceAtBoot();
      });
    } finally {
      proto.find = originalFind;
      restore();
    }

    // ONE bound, not one per kind: the stop at the first timeout is what keeps a hung space from costing (kinds x bound) — 24
    // minutes at the production figure — before it is quarantined.
    assert.equal(echoReads, 1, `the hung space was read ${echoReads} times over ${hungCollections} hung collections: more than one bound (${BOUND_MS} ms) was paid`);
    const hung = warnsFor('echo');
    assert.equal(hung.length, 1, `the hung space was not reported once:\n${lines.join('\n')}`);
    // The walk read the failure: the bound's own words, and the space is in quarantine (a hung space is not retried at once).
    assert.match(hung[0], new RegExp(`ran past its time bound of ${BOUND_MS} ms .*retried after quarantine \\(\\d+s\\)`), `not the walk's wording for a timeout: ${hung[0]}`);
    assert.ok(walk.quarantinedSpaces().includes('echo'), 'the hung space was not quarantined');
    await assertHealthySpacesSwept();
    // One count per failing SPACE. The rule is not "one failure in this file": the boot sweep walks every space, and on a slow store
    // a healthy one can run past a 400 ms bound too (the CI run that showed it: 'hotel' timed out beside 'echo', each its own failure,
    // each its own line). So the counts are matched to the spaces that SAID a failure — a space counted twice has one line and two
    // counts, and a failure counted but never said has a count and no line.
    const said = spacesSaidToFail();
    const counted = failures.filter(f => f.kind === 'failure' || f.kind === 'timeout');
    assert.ok(said.has('echo'), 'the hung space said nothing');
    assert.equal(counted.length, said.size, `${counted.length} failures counted for ${said.size} failing space(s) (${[...said].join(', ')}): a failure was counted twice or not said`);
  });

  // Q-455: a healthy space can run past the bound on a slow host (CI run 37962407565 saw it). Made to happen here on purpose: one
  // HEALTHY space hangs, so the rule for the healthy spaces is exercised on the host this runs on, not only on a slow one. ('echo' is
  // in quarantine from the case above, so this walk skips it.)
  it('a healthy space that runs past the bound beside the others is reported and counted, and the rest are still swept', async () => {
    lines.length = 0;
    failures.length = 0;
    for (const space of HEALTHY) await mongo.col(`${space}_facts`).updateOne({ _id: `${space}-1` }, { $set: VECTOR });
    const [slow] = HEALTHY;
    const restore = await setWriteBoundForTest({ housekeepingOpMs: BOUND_MS });
    try {
      await withEveryCollectionHung(slow, () => sweep.sweepEverySpaceAtBoot());
    } finally {
      restore();
    }
    assert.ok(spacesSaidToFail().has(slow), `the slow healthy space said nothing:\n${lines.join('\n')}`);
    await assertHealthySpacesSwept();
  });
});
