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
 * Now the boot sweep is `eachSpace` (one at a time, inside the housekeeping bound), and `sweepLatestMeta` — still the one catch,
 * because `sweepAfterMetaWrite` has no walk above it and the coalescing runner re-runs its job without a caller to throw to —
 * reports through `reportSpaceFailure`, which is synchronous and never throws.
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
import { waitFor } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();

const STEP = 'Suppression sweep';
const SUPPRESSING = { suppressEmbeddings: true };
const SPACES = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
const HEALTHY = ['bravo', 'charlie'];
const VECTOR = { embedding: [0.1, 0.2, 0.3], embeddingModel: 'test-model' };
const STALL_MS = 3000;
const BOUND_MS = 800;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-g18-'));
// The loader reads CONFIG_PATH when it is first imported: set before any import below.
process.env['CONFIG_PATH'] = path.join(tmp, 'config.json');

let mongo;
let sweep;
let signals;
let unsubscribeLog = () => {};
let unsubscribeSignals = () => {};
const lines = [];
const failures = [];
const unhandled = [];
const onUnhandled = (err) => { unhandled.push(err); };

const warnsFor = (space) => lines.filter(l => l.includes('WARN') && l.includes(STEP) && l.includes(`'${space}'`));
const hasVector = async (space) => (await mongo.col(`${space}_facts`).findOne({ _id: `${space}-1` }))?.embedding !== undefined;

describe('the suppression sweep isolates a failing space', { skip }, () => {
  before(async () => {
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'g18-sweep', instanceName: 'G18', tokens: [], networks: [],
      spaces: SPACES.map(id => ({ id, name: id, meta: SUPPRESSING })),
    }));
    mongo = await openTestMongo('g18sweep');
    sweep = await import('../../server/dist/brain/suppression-sweep.js');
    signals = await import('../../server/dist/util/housekeeping-signals.js');
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
      await new Promise(r => setTimeout(r, 300));
    }, { pipeline: [{ $addFields: { _x: { $toInt: '$a' } } }] });

    const said = warnsFor('delta');
    assert.equal(said.length, 1, `${said.length} lines, expected one:\n${said.join('\n')}`);
    assert.match(said[0], new RegExp(`${STEP} failed for space 'delta': .* — retried with the next meta write$`), said[0]);
    assert.deepEqual(failures, [{ type: 'space-failure', step: STEP, kind: 'failure' }], 'the failure was not counted exactly once under the step');
    assert.deepEqual(unhandled, [], 'the sweep rejected unhandled');
  });

  it('a space whose read hangs is ended by the housekeeping bound, reported, and the others are swept', async () => {
    lines.length = 0;
    failures.length = 0;
    for (const space of HEALTHY) {
      await mongo.col(`${space}_facts`).updateOne({ _id: `${space}-1` }, { $set: VECTOR });
    }
    const restore = await setWriteBoundForTest({ housekeepingOpMs: BOUND_MS });
    const db = mongo.getDb();
    let ms;
    // The sweep reads with a filter, and the server may test the filter before the stalling stage: documents the sweep's filter
    // MATCHES are what must reach the stage, so the source holds as many of them as the fixture seeds stalling ones.
    const matching = Array.from({ length: Math.ceil(STALL_MS / 200) }, (_, i) => ({ _id: `g18-match-${i}`, ...VECTOR, suppressEmbeddings: true }));
    await db.collection('g18_stall_src').insertMany(matching);
    try {
      await withStalledReads(db, 'echo_facts', 'g18_stall_src', { ms: STALL_MS }, async () => {
        const started = Date.now();
        await sweep.sweepEverySpaceAtBoot();
        ms = Date.now() - started;
      });
    } finally {
      restore();
      await db.collection('g18_stall_src').deleteMany({ _id: { $in: matching.map(d => d._id) } });
    }

    assert.ok(ms < STALL_MS - 1000, `the boot sweep took ${ms} ms: the hung read ran to its end (${STALL_MS} ms) instead of the ${BOUND_MS} ms bound`);
    assert.equal(warnsFor('echo').length, 1, `the hung space was not reported once:\n${lines.join('\n')}`);
    for (const space of HEALTHY) assert.equal(await hasVector(space), false, `'${space}' was not swept after the hung space`);
    assert.equal(failures.length, 1, 'the hung space was not counted exactly once');
  });
});
