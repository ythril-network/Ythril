/**
 * A scan hold that lasts is WARNED, by its age, and nothing but a pass that ended without a hold clears the clock (Q-697, b235
 * design v3 item 10; security S4/S5/S6, data-integrity S4/S5, observability S1/S7, integration S5).
 *
 * ## The defect
 *
 * A hold keeps a type's position where it was, and the next run reads the same records again. When the index stays unready the hold
 * repeats every run, and nothing said so: each run logged one line at info, a held contradiction scan read as a clean result in the
 * Review tab, and a hold that lasted a week looked like one that had just begun. The duplicate hold had the same blind spot since Q-326.
 *
 * ## The rules (`brain/scan-cursor.ts`)
 *
 *  - `noteScanHold(cursorId, { scanner, spaceId, type, now })` records the hold on the cursor's own row in `ythril_dupe_scan_state`:
 *    `heldSince`, the FIRST time it held, kept by `$min` (a later hold never moves it). It is an UPSERT: a type held before any position
 *    was ever written has no row yet, and the row it creates carries the fields the row type requires (`$setOnInsert`: space, type,
 *    `cursorSeq` 0, `updatedAt`) so `readScanStart`, `carryScanCursors` and `moveScanCursors` handle it like any other.
 *  - It counts `ythril_scan_holds_total{scanner}` per hold, declared at zero for every scanner, the label values one list.
 *  - It WARNS when the hold is at least `HOLD_WARN_AFTER_MS` (20 h, below the daily period, so the second daily run in a row warns
 *    despite the jitter of a schedule) old, once per window. Below it, no warning: a hold of one run is the ordinary case of an index
 *    that is being built. The clock is injected (`now`), so the boundary is asserted at 20 h less 1 ms, 20 h and 20 h plus 1 ms.
 *  - A position write NEVER clears it, and a RESET keeps it: a hold is about the index, not the position, so the held pass's own
 *    write of the seeds before the held one, and an operator's manual rescan (`reset: true` on the dupe route), cannot hide it.
 *  - `clearScanHold(cursorId)` unsets it. Each scanner calls it once per PASS, when the pass ended WITHOUT a hold for that cursor, an
 *    empty batch included (a type whose records were all deleted has nothing to hold), and only when the row read at the pass start
 *    carried `heldSince`: no write per seed, and no write at all on a healthy instance. A poisoned `heldSince` (a value that is no
 *    time) is therefore cleared by the first clean pass instead of warning for ever.
 *  - A rename moves it with the cursor (`moveScanCursors`).
 *
 * ## What is injected
 *
 * Only the clock, and the refusal of the search for the scans that must hold (`_mongot-refusals.mjs`). The rows are the real
 * collection; the scanners are the real ones.
 *
 * "Seen red" on the base: `noteScanHold` and `clearScanHold` are not exported, and no scan writes `heldSince`.
 *
 * Needs a MongoDB with mongot (atlas-local): `npm run test:up`.
 *
 * Run: node --test testing/standalone/a-scan-hold-keeps-its-clock-until-a-pass-ends-without-one-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { unitAt, startStubEmbedder, queryAxis, createSpaceCollections } from './_vector-harness.mjs';
import { REFUSALS, refuseVectorSearch } from './_mongot-refusals.mjs';
import { logLinesDuring } from './_log-lines.mjs';
import { scanHoldSeries, scanHoldSum, scannerLabelsOf } from './_scan-holds.mjs';

const skip = await mongoSkipReason();

const S = 'holdclock';
const DIMS = 8;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-holdclock-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
process.env['YTHRIL_HYBRID_SEARCH'] = 'off';

/** The design's threshold: 20 hours, written as the one number the doc-cited-constants gate reads. */
const HOLD_WARN_AFTER_MS = 72_000_000;
const T0 = Date.parse('2026-11-01T00:00:00.000Z');
/** The clock the scan-cursor functions take: milliseconds since the epoch. (The design leaves the type of `now` open; this is the one place a test names it.) */
const clock = (ms) => ms;
/** What a stored `heldSince` says, as milliseconds whatever type the row keeps it in (an ISO string, a Date or a number). */
const sinceMs = (v) => (typeof v === 'number' ? v : new Date(v).getTime());

const OLD = new Date(Date.now() - 3_600_000).toISOString();
const entity = (id, i) => ({
  _id: id, spaceId: S, name: id, type: 'thing', tags: [], properties: {}, description: `record ${id}`,
  embedding: unitAt(10 * (i + 1), DIMS), embeddingModel: 'stub', seq: i + 1, pos: i + 1, posAtSeq: i + 1, createdAt: OLD, updatedAt: OLD,
});
const IDS = ['e1', 'e2', 'e3'];

let mongo, cursorMod, dupe, contradiction, registry, stub;
const row = (id) => mongo.col('ythril_dupe_scan_state').findOne({ _id: id });
const warningsOf = (lines) => lines.filter(l => /\[WARN\s*\]/.test(l));
const declaredScanner = async () => scannerLabelsOf(await scanHoldSeries(registry))[0] ?? 'unknown-until-the-counter-is-declared';

describe('a scan hold keeps its clock until a pass ends without one', { skip }, () => {
  before(async () => {
    stub = await startStubEmbedder(() => queryAxis(DIMS));
    delete process.env['NLI_URL'];   // the contradiction scanner runs its structured pass only: one cursor per type
    fs.mkdirSync(process.env['DATA_ROOT'], { recursive: true });
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify(
      { instanceId: 'holdclock', instanceLabel: 'test', tokens: [], networks: [], spaces: [{ id: S, label: S, folders: [] }] }, null, 2), { mode: 0o600 });
    mongo = await openTestMongo('holdclock');
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    loader.getConfig().dupeScanner = { types: ['entity'], batchSize: 2, maxPerRun: 100 };
    loader.getConfig().contradictionScanner = { batchSize: 10, maxPerRun: 100 };
    cursorMod = await import('../../server/dist/brain/scan-cursor.js');
    dupe = await import('../../server/dist/brain/dupe-scanner.js');
    contradiction = await import('../../server/dist/brain/contradiction-scanner.js');
    registry = await import('../../server/dist/metrics/registry.js');
    const { raiseVersionTo } = await import('../../server/dist/util/version-stamp.js');
    const available = await mongo.checkVectorSearchAvailability();
    assert.equal(available.available, true, 'the harness Mongo has no $vectorSearch: the scanners return before reading anything, so every case would pass for no reason');
    await createSpaceCollections(mongo, S);
    await raiseVersionTo(S, 100);
  });

  after(async () => {
    await closeTestMongo();
    await stub?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    await mongo.col('ythril_dupe_scan_state').deleteMany({});
    await mongo.col(`${S}_entities`).deleteMany({});
  });

  /** One hold noted on `cursorId` at `ms`, and the warning lines it emitted. */
  async function hold(cursorId, ms, scanner = undefined) {
    assert.equal(typeof cursorMod.noteScanHold, 'function', 'scan-cursor exports no noteScanHold: a hold leaves no clock behind');
    // A scanner the registry declares (the first of them), never one named here: a label outside the declared set is a series nobody scrapes at zero.
    scanner ??= await declaredScanner();
    const { lines } = await logLinesDuring(() => cursorMod.noteScanHold(cursorId, { scanner, spaceId: S, type: 'entity', now: clock(ms) }));
    return warningsOf(lines);
  }

  describe('the warning, by the hold\'s age', () => {
    it('a hold of 20 h less 1 ms is not warned', async () => {
      const id = `${S}:below`;
      const scanner = await declaredScanner();
      assert.deepEqual(await hold(id, T0, scanner), [], 'the first hold of a type was warned');
      assert.deepEqual(await hold(id, T0 + HOLD_WARN_AFTER_MS - 1, scanner), [], 'a hold one millisecond younger than the threshold was warned');
      assert.equal(sinceMs((await row(id))?.heldSince), T0, 'heldSince moved: it is the FIRST time the type held, and a later hold never moves it');
    });

    for (const [name, offset] of [['20 h', 0], ['20 h plus 1 ms', 1]]) {
      it(`a hold of ${name} is warned, once per window`, async () => {
        const id = `${S}:at-${offset}`;
        const scanner = await declaredScanner();
        await hold(id, T0, scanner);
        const warned = await hold(id, T0 + HOLD_WARN_AFTER_MS + offset, scanner);
        assert.equal(warned.length, 1, `a hold ${name} old was warned ${warned.length} time(s): ${warned.join(' | ')}`);
        assert.ok(warned[0].includes(S), `the warning does not name the space: ${warned[0]}`);
        // The same hold, run after run inside the window: said once, as every warning that would otherwise repeat each run is.
        assert.deepEqual(await hold(id, T0 + HOLD_WARN_AFTER_MS + offset + 60_000, scanner), [], 'a hold already warned was warned again inside the window');
      });
    }

    it('every hold is a line at info, and a young one is not a warning', async () => {
      const id = `${S}:info`;
      assert.equal(typeof cursorMod.noteScanHold, 'function', 'scan-cursor exports no noteScanHold');
      const scanner = await declaredScanner();
      const { lines } = await logLinesDuring(() => cursorMod.noteScanHold(id, { scanner, spaceId: S, type: 'entity', now: clock(T0) }));
      assert.ok(lines.some(l => /\[INFO\s*\]/.test(l) && l.includes(S)), `a hold said nothing at info: ${lines.join(' | ')}`);
      assert.deepEqual(warningsOf(lines), []);
    });
  });

  describe('the counter', () => {
    it('ythril_scan_holds_total is declared at zero for every scanner, and each hold raises its own scanner\'s series by one', async () => {
      const declared = await scanHoldSeries(registry);
      assert.ok(declared, 'ythril_scan_holds_total is not declared: a scrape before the first hold says nothing, which reads as "no metric", not "no holds"');
      const scanners = scannerLabelsOf(declared);
      assert.ok(scanners.length >= 2, `only ${scanners.length} scanner label(s) declared (${JSON.stringify(declared)}): the duplicate and the contradiction scanner each hold`);
      assert.equal(new Set(scanners).size, scanners.length, 'a scanner is declared twice');
      for (const scanner of scanners) {
        const was = await scanHoldSeries(registry);
        await hold(`${S}:count-${scanner}`, T0, scanner);
        await hold(`${S}:count-${scanner}`, T0 + 1, scanner);
        const now = await scanHoldSeries(registry);
        const rose = Object.keys(now).filter(k => now[k] !== was[k]);
        assert.equal(rose.length, 1, `two holds by '${scanner}' moved ${rose.length} series: ${JSON.stringify(rose)}`);
        assert.ok(rose[0].includes(`scanner="${scanner}"`), `the hold of '${scanner}' was counted under ${rose[0]}`);
        assert.equal(now[rose[0]] - was[rose[0]], 2, 'each hold is counted: two holds, two increments');
      }
    });
  });

  describe('the row a hold writes', () => {
    it('a hold of a type with no position yet creates a row with every field the row type requires', async () => {
      const id = `${S}:fresh`;
      await hold(id, T0);
      const doc = await row(id);
      assert.ok(doc, 'the hold wrote no row: a type held before it ever wrote a position loses its clock');
      assert.equal(doc.spaceId, S);
      assert.equal(doc.type, 'entity');
      assert.equal(doc.cursorSeq, 0, 'the row has no numeric cursorSeq: carryScanCursors and an older build read it as a position');
      assert.equal(typeof doc.updatedAt, 'string');
      assert.equal(sinceMs(doc.heldSince), T0);
      assert.deepEqual(await cursorMod.readScanStart(id), { pos: 0 }, 'a held row with no position starts the scan from the beginning');
      await cursorMod.carryScanCursors();
      const carried = await row(id);
      assert.equal(carried.cursorPos, undefined, 'the carry invented a position for a row that holds none');
      assert.equal(sinceMs(carried.heldSince), T0);
    });

    it('carryScanCursors keeps heldSince on a legacy cursor it carries', async () => {
      const id = `${S}:legacy`;
      await mongo.col('ythril_dupe_scan_state').insertOne({ _id: id, spaceId: S, type: 'entity', cursorSeq: 5, updatedAt: new Date(T0).toISOString() });
      await hold(id, T0);
      await cursorMod.carryScanCursors();
      const doc = await row(id);
      assert.deepEqual(doc.cursorPos, { seq: 5, id: '' });
      assert.equal(sinceMs(doc.heldSince), T0, 'the carry dropped the clock');
    });

    it('a rename moves heldSince with the cursor', async () => {
      const old = `${S}:entity`;
      await hold(old, T0);
      await cursorMod.moveScanCursors(S, `${S}renamed`);
      assert.equal(await row(old), null, 'the old row is still there');
      const moved = await row(`${S}renamed:entity`);
      assert.ok(moved, 'the cursor did not move');
      assert.equal(sinceMs(moved.heldSince), T0, 'the clock stayed behind with the old name');
    });

    it('a position write never clears it, and a reset keeps it', async () => {
      const id = `${S}:entity`;
      await hold(id, T0);
      await cursorMod.writeScanPosition(id, { spaceId: S, type: 'entity' }, { pos: 3, id: 'e3' });
      assert.equal(sinceMs((await row(id)).heldSince), T0, 'a position write cleared the clock: the held pass writes the seeds before the held one, and that would hide the hold');
      await cursorMod.writeScanPosition(id, { spaceId: S, type: 'entity' }, null);
      const reset = await row(id);
      assert.equal(reset.cursorSeq, 0);
      assert.equal(sinceMs(reset.heldSince), T0, 'a reset cleared the clock: a manual rescan would hide a hold that is about the index and not the position');
    });

    it('clearScanHold unsets it, and creates no row for a cursor that has none', async () => {
      const id = `${S}:entity`;
      await hold(id, T0);
      assert.equal(typeof cursorMod.clearScanHold, 'function', 'scan-cursor exports no clearScanHold');
      await cursorMod.clearScanHold(id);
      const doc = await row(id);
      assert.ok(doc, 'clearing the clock removed the row, and with it the position');
      assert.equal(doc.heldSince, undefined);
      await cursorMod.clearScanHold(`${S}:never-written`);
      assert.equal(await row(`${S}:never-written`), null, 'a clear created a row');
    });
  });

  describe('through the scanners', () => {
    const heldScan = async (scan, opts) => {
      const fault = refuseVectorSearch(REFUSALS.notInitialized);
      try { return await scan(S, opts); } finally { fault.restore(); }
    };
    const advancingScan = async (scan, opts) => {
      const fault = refuseVectorSearch(REFUSALS.dimensionMismatch);
      try { return await scan(S, opts); } finally { fault.restore(); }
    };

    it('a held dupe scan starts the clock on its cursor and counts one hold; a reset rescan that holds again keeps the clock', async () => {
      await mongo.col(`${S}_entities`).insertMany(IDS.map(entity));
      const before = scanHoldSum(await scanHoldSeries(registry));
      await heldScan(dupe.scanSpace);
      const first = await row(`${S}:entity`);
      assert.ok(first?.heldSince !== undefined, 'a held dupe scan left no clock on its cursor');
      assert.equal(scanHoldSum(await scanHoldSeries(registry)) - before, 1, 'one held type was not counted as one hold');
      assert.equal(first.cursorSeq, 0, 'the held scan claimed a position it did not settle');
      await heldScan(dupe.scanSpace, { reset: true });
      const again = await row(`${S}:entity`);
      assert.equal(sinceMs(again.heldSince), sinceMs(first.heldSince), 'a reset rescan that held again moved the clock: the operator\'s manual scan hid how long the index has been unready');
    });

    it('a pass that ends without a hold clears it: records scanned past an index that advances, and an empty batch', async () => {
      await mongo.col(`${S}_entities`).insertMany(IDS.map(entity));
      await hold(`${S}:entity`, T0);
      await advancingScan(dupe.scanSpace);
      assert.equal((await row(`${S}:entity`)).heldSince, undefined, 'a clean pass over records left the clock running');
      assert.equal((await row(`${S}:entity`)).cursorSeq, IDS.length, 'the clean pass did not advance');
      await hold(`${S}:entity`, T0);
      await mongo.col(`${S}_entities`).deleteMany({});
      await dupe.scanSpace(S);
      assert.equal((await row(`${S}:entity`)).heldSince, undefined, 'an empty batch left the clock running: a type whose records were all deleted has nothing to hold');
    });

    it('a poisoned heldSince is cleared by the first clean pass, and does not stop it', async () => {
      await mongo.col(`${S}_entities`).insertMany(IDS.map(entity));
      await mongo.col('ythril_dupe_scan_state').insertOne({ _id: `${S}:entity`, spaceId: S, type: 'entity', cursorSeq: 0, updatedAt: new Date(T0).toISOString(), heldSince: 'not a time' });
      await advancingScan(dupe.scanSpace);
      assert.equal((await row(`${S}:entity`)).heldSince, undefined, 'a heldSince that is no time survived a clean pass: it would warn for ever');
    });

    it('the contradiction scanner clears the clock of each cursor whose pass ended without a hold', async () => {
      const ids = ['fact', 'entity'].map(t => contradiction.cursorKey(S, t, 'structured'));
      for (const id of ids) await hold(id, T0);
      await contradiction.scanSpace(S);
      for (const id of ids) assert.equal((await row(id)).heldSince, undefined, `${id}: an empty batch left the clock running`);
    });
  });
});
