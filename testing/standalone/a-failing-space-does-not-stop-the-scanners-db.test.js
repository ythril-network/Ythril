/**
 * A failing or hung space does not stop either background scanner's pass over the others — `Q-274`, `Q-358`, bundle-53 G16.
 *
 * ## The defect it prevents
 *
 * The duplicate scanner (`brain/dupe-scanner.ts`) and the contradiction scanner (`brain/contradiction-scanner.ts`) each walk every
 * concrete space once a night, and each had its own answer to "what if one space fails": a `try`/`catch` in the loop that said
 * one line per pass, every pass, in words of its own — and no answer at all to "what if one read HANGS". A space whose read never
 * returned held the pass, and the schedule's single-flight guard (`runExclusive`) then skipped every later night against it.
 * Inside a seed the same shape hid one level down: a per-seed `catch {}` ("no stored vector, record merged away, or search
 * failed") read a TIMEOUT as one record's trouble, so a space that hung paid one bound for each of its records.
 *
 * ## What is held, for each scanner (the table below is derived from the scanners, not typed per case)
 *
 *  - a space whose read FAILS is reported once, in the shared reporter's words (`<step> failed for space '<id>': … — retried next
 *    cycle`), a second pass says nothing again inside the window, and the space after it is still scanned (its cursor moves);
 *  - a space whose read HANGS ends at the housekeeping bound, not at the stall, is reported once with the bound in the line, and
 *    the space after it is scanned;
 *  - a TIMEOUT inside a seed's own reads ends the SPACE: the space's remaining seeds are not asked (one bound spent, not one per
 *    record), and it is reported once. A record with no stored vector (`NotFoundError`) is the expected skip and is not a failure
 *    of its space; any OTHER failure of a seed is said once under its type (not once per seed, and no longer not at all), and the
 *    cursor still moves past it, so one record that fails every night cannot hold the scan.
 *
 * ## The stub, and why there is none
 *
 * Nothing here needs an embedder: the scan walks records by `seq` and a record with no stored vector is skipped per seed
 * (`findSimilar` throws `NotFoundError`), which is the cheapest honest stand-in for "the model has not embedded it yet". What the
 * test observes is the CURSOR (`ythril_dupe_scan_state`), which moves past a seed that was asked, and the log.
 *
 * ## What a stall costs
 *
 * `withStalledReads` makes a source document cost a read one sleep, but only for a document that matches the READER's filter; the
 * scanner's batch read is `{ spaceId, seq in the settled range }`, so the hung space's source is topped up with documents that
 * match it (the fixture's own seeds carry no `spaceId` and cost the scan nothing).
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-failing-space-does-not-stop-the-scanners-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { setWriteBoundForTest, settleWithin, withCollectionAsView, withStalledReads } from './_write-faults.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const skip = await mongoSkipReason();
const BOUND_MS = 1000;
const STALL_MS = 3000;
/** What `withStalledReads` costs one source document, ms (`_write-faults.mjs`). */
const STALL_STEP_MS = 200;
const SEEDS = 4;

/**
 * The scanners, as this file asks them. Each has its OWN spaces: a hung space is quarantined for a minute by the process-wide
 * walk, and a second scanner over the same id would be skipped instead of tried.
 */
const SCANNERS = [
  {
    name: 'dupe scanner', step: 'Dupe scan', prefix: 'dupe',
    load: () => import('../../server/dist/brain/dupe-scanner.js').then(m => m.runDupeScanAllSpaces),
    cursorId: (space) => `${space}:fact`,
    summary: (lines) => lines.some(l => /Dupe scan 'scan-ok': scanned 3, pairs 0$/.test(l)),
  },
  {
    name: 'contradiction scanner', step: 'Contradiction scan', prefix: 'contra',
    load: () => import('../../server/dist/brain/contradiction-scanner.js').then(m => m.runContradictionScanAllSpaces),
    cursorId: (space) => `${space}:fact:contradiction`,
    summary: (lines) => lines.some(l => /Contradiction scan: scanned 3, /.test(l)),
  },
];
const FAIL = (s) => `${s.prefix}-fail`;
const HANG = (s) => `${s.prefix}-hang`;
const SEEDTO = (s) => `${s.prefix}-seedto`;
const SEEDFAIL = (s) => `${s.prefix}-seedfail`;
/** Last in the config, so a pass that stops at the first failure leaves exactly this one unscanned. */
const OK = 'scan-ok';
const ALL = [...SCANNERS.flatMap(s => [FAIL(s), HANG(s), SEEDTO(s), SEEDFAIL(s)]), OK];

const fact = (space, i) => ({ _id: `${space}-f${i}`, spaceId: space, fact: `fact ${i} of ${space}`, seq: i, createdAt: '2025-01-01T00:00:00.000Z' });

describe('a failing or hung space does not stop the scanners', { skip }, () => {
  let door; let restoreBound; let proto; let realFindOne; let StoreTimeout;
  /** The `findOne` calls the patch saw, per collection, and the collections it is armed to answer with a timeout. */
  const findOneSeen = new Map();
  const armed = new Map();

  before(async () => {
    door = await openPushDoor({ suite: 'scanisol', spaces: ALL.map(id => ({ id, label: id, folders: [] })) });
    const available = await door.mongo.checkVectorSearchAvailability();
    assert.equal(available.available, true, 'the harness Mongo has no $vectorSearch: the scanners return before reading anything, so every case below would pass for no reason');
    ({ StoreTimeout } = await import('../../server/dist/db/write-timeout.js'));
    const { bumpSeq } = await import('../../server/dist/util/seq.js');
    for (const space of ALL) await bumpSeq(space, 20);
    restoreBound = await setWriteBoundForTest({ housekeepingOpMs: BOUND_MS });
    proto = Object.getPrototypeOf(door.mongo.col('probe'));
    realFindOne = proto.findOne;
    proto.findOne = function recording(filter, ...rest) {
      const name = this.collectionName;
      findOneSeen.set(name, (findOneSeen.get(name) ?? 0) + 1);
      if (armed.has(name)) return Promise.reject(armed.get(name)());
      return realFindOne.call(this, filter, ...rest);
    };
  });
  after(async () => {
    if (proto && realFindOne) proto.findOne = realFindOne;
    await restoreBound?.();
    await door?.close();
  });
  beforeEach(async () => {
    findOneSeen.clear();
    armed.clear();
    await door.mongo.col('ythril_dupe_scan_state').deleteMany({});
    await door.coll(OK, 'facts').deleteMany({});
    await door.coll(OK, 'facts').insertMany([1, 2, 3].map(i => fact(OK, i)));
  });

  const cursorOf = async (scanner, space) => (await door.mongo.col('ythril_dupe_scan_state').findOne({ _id: scanner.cursorId(space) }))?.cursorSeq ?? null;
  const said = (lines, step, space) => lines.filter(l => l.includes(`${step} failed for space '${space}'`));

  for (const scanner of SCANNERS) {
    describe(scanner.name, () => {
      let run;
      before(async () => { run = await scanner.load(); });

      it('a space whose read FAILS is reported once in the shared words, and the space behind it is scanned', { timeout: 60_000 }, async () => {
        const space = FAIL(scanner);
        const db = door.mongo.getDb();
        await db.collection(`${space}_facts_src`).insertOne({ _id: 'bad', spaceId: space, seq: 1, f: 'not a number' });
        let first; let second;
        try {
          // The stage sits on the SOURCE and the scanner's batch filter on the view: the read throws when the bad document reaches it.
          await withCollectionAsView(db, `${space}_facts`, `${space}_facts_src`, async () => {
            first = await logLinesDuring(() => run());
            second = await logLinesDuring(() => run());
          }, { pipeline: [{ $addFields: { _x: { $toInt: '$f' } } }] });
        } finally {
          await db.collection(`${space}_facts_src`).drop().catch(() => {});
        }
        assert.equal(await cursorOf(scanner, OK), 3, 'the space behind the failing one sits after it in the config and was not scanned');
        assert.ok(scanner.summary(first.lines), `the pass still reports what it scanned: ${first.lines.join(' | ')}`);
        const said1 = said(first.lines, scanner.step, space);
        assert.equal(said1.length, 1, `one line, in the reporter's words: ${first.lines.join(' | ')}`);
        assert.match(said1[0], /— retried next cycle$/, 'and when it is tried again');
        assert.equal(said(second.lines, scanner.step, space).length, 0, 'a failure that repeats is a rate, not a line, inside the reporter\'s window');
      });

      it('a space whose read HANGS ends at the housekeeping bound, is reported once, and the space behind it is scanned', { timeout: 60_000 }, async () => {
        const space = HANG(scanner);
        const db = door.mongo.getDb();
        const source = `${space}_facts_src`;
        // Documents the scanner's own batch filter lets through, so each one pays the sleep.
        await db.collection(source).insertMany(Array.from({ length: Math.ceil(STALL_MS / STALL_STEP_MS) }, (_, i) => fact(space, i + 1)));
        let outcome; let lines;
        try {
          await withStalledReads(db, `${space}_facts`, source, { ms: STALL_MS }, async () => {
            ({ lines, result: outcome } = await logLinesDuring(() => settleWithin(run(), STALL_MS - 500)));
            if (!outcome.settled) await outcome.rest;   // the stall's own end is waited for before the view is put back
          });
        } finally {
          await db.collection(source).drop().catch(() => {});
        }
        assert.ok(outcome.settled, `the pass was still waiting after ${outcome.elapsedMs} ms on a read that stalls for ${STALL_MS} ms: nothing ended it at the ${BOUND_MS} ms bound`);
        assert.equal(outcome.ok, true, `the pass returns for a hung space: ${outcome.error}`);
        assert.equal(await cursorOf(scanner, OK), 3, 'the space behind the hung one was not scanned');
        const said1 = said(lines, scanner.step, space);
        assert.equal(said1.length, 1, `reported once: ${lines.join(' | ')}`);
        assert.match(said1[0], new RegExp(`time bound of ${BOUND_MS} ms`), 'in the words of the bound it ran into');
      });

      it('a timeout inside a seed ends the SPACE after ONE read; a seed with no stored vector is merely skipped', { timeout: 60_000 }, async () => {
        const space = SEEDTO(scanner);
        await door.coll(space, 'facts').deleteMany({});
        await door.coll(space, 'facts').insertMany(Array.from({ length: SEEDS }, (_, i) => fact(space, i + 1)));
        armed.set(`${space}_facts`, () => new StoreTimeout(`the read of ${space}_facts`));
        let lines;
        try {
          ({ lines } = await logLinesDuring(() => run()));
        } finally {
          armed.clear();
          // Left behind, the seeds would be scanned (and counted) by the next scanner's pass.
          await door.coll(space, 'facts').deleteMany({});
        }

        assert.equal(findOneSeen.get(`${space}_facts`), 1,
          `the space's seeds were asked ${findOneSeen.get(`${space}_facts`)} times: a timeout was read as one record's trouble and the scan paid for each of its ${SEEDS} records`);
        const said1 = said(lines, scanner.step, space);
        assert.equal(said1.length, 1, `the space is reported once: ${lines.join(' | ')}`);
        assert.equal(await cursorOf(scanner, space), null, 'the cursor moved past a seed that was never answered');
        assert.equal(await cursorOf(scanner, OK), 3, 'the space behind it was scanned');
        assert.equal(said(lines, scanner.step, OK).length, 0, 'a record with no stored vector is skipped, not a failure of its space');
      });

      it('an ordinary failure of a seed is said ONCE under its type, the other seeds are still asked, and the cursor moves past them', { timeout: 60_000 }, async () => {
        const space = SEEDFAIL(scanner);
        await door.coll(space, 'facts').deleteMany({});
        await door.coll(space, 'facts').insertMany(Array.from({ length: SEEDS }, (_, i) => fact(space, i + 1)));
        armed.set(`${space}_facts`, () => new Error('this seed cannot be read'));
        let lines;
        try {
          ({ lines } = await logLinesDuring(() => run()));
        } finally {
          armed.clear();
          await door.coll(space, 'facts').deleteMany({});
        }
        const said1 = lines.filter(l => l.includes(`${scanner.step} failed for space '${space}' (fact)`));
        assert.equal(said1.length, 1, `one line naming the unit, not one per seed and not silence: ${lines.join(' | ')}`);
        assert.match(said1[0], /— retried next cycle$/);
        assert.ok(findOneSeen.get(`${space}_facts`) >= SEEDS, 'a seed that failed ended the scan of the seeds behind it');
        assert.equal(await cursorOf(scanner, space), SEEDS, 'a seed that fails every time would hold the cursor: it moves past it, as it always did');
        assert.equal(await cursorOf(scanner, OK), 3, 'the space behind it was scanned');
      });
    });
  }
});
