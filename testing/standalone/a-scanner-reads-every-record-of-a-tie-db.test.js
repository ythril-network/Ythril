/**
 * The duplicate scanner and the contradiction scanner read every record of a run that shares a seq — at a batch boundary, at the
 * per-run cap, and from a cursor an older build wrote (bundle-52, `Q-277`).
 *
 * ## The defect
 *
 * Both scanners keep one `cursorSeq` per space and type and read `seq > cursorSeq` in batches, moving the cursor to the seq of
 * each record they scan. Records from several authors share seqs, so a batch that ends inside a run — or a run that `maxPerRun`
 * cuts in two — leaves the rest of the run behind the cursor: those records are never scanned for duplicates or contradictions,
 * until each is next edited. Nothing says so; the scan reports a clean pass.
 *
 * ## The rules, for each scanner (the table below is the two scanners, read from nothing else)
 *
 *  1. A run split at the BATCH boundary: every record is scanned exactly once.
 *  2. A run split at `maxPerRun` (so across two runs of the scanner): every record is scanned exactly once, over the runs.
 *  3. **A cursor an older build wrote** (`cursorSeq` alone, no position inside the run) re-scans its own run once and nothing
 *     below it: the old cursor says the run at `cursorSeq` was read, and it may have been read only in part.
 *  4. **A rolled-back cursor**: `cursorSeq` lower than the position stored beside it means an older build moved it, so the
 *     position inside the run is stale; the scan re-reads from `cursorSeq` inclusive and skips nothing.
 *  5. The stored state keeps a NUMERIC `cursorSeq` (an older build reads it) and, after a stop inside a run, records where in the
 *     run it stopped as `cursorPos: { seq, id }` with `cursorPos.seq === cursorSeq`.
 *
 * ## How a scan is observed
 *
 * Neither scanner is stubbed. A record with no stored vector is skipped by its seed (`findSimilar` throws `NotFoundError`), which
 * is the cheapest honest stand-in for "not embedded yet" (`a-failing-space-does-not-stop-the-scanners-db.test.js` says the same),
 * and what a seed costs is ONE `findOne` of its record on `<space>_facts`: that call is recorded, by `_id`, and is what "scanned"
 * means here. The cursor is read from `ythril_dupe_scan_state`.
 *
 * ## What "red at base" is
 *
 * Rules 1 and 2 fail with the ids never scanned; rule 3 fails because the old cursor skips its own run (`seq >`); rule 4 fails
 * because the record AT the rolled-back `cursorSeq` is not re-read; rule 5 fails for want of `cursorPos`.
 *
 * Run: a Mongo with $vectorSearch (the harness's), then node --test testing/standalone/a-scanner-reads-every-record-of-a-tie-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { missingAndRepeated } from './_seq-tie-families.mjs';

const skip = await mongoSkipReason();
const S = 'scantie';

/** seqs 1, 2, THREE records at seq 3, then 4. Ids sort in this order. */
const SEQ_OF = { '1': 1, '2': 2, '3a': 3, '3b': 3, '3c': 3, '4': 4 };
const ALL = Object.keys(SEQ_OF);
const record = (id) => ({ _id: id, spaceId: S, fact: `fact ${id}`, seq: SEQ_OF[id], createdAt: '2025-01-01T00:00:00.000Z' });

/** The two scanners: how each is run, configured, and where it keeps its cursor for facts. */
const SCANNERS = [
  {
    name: 'dupe scanner',
    load: () => import('../../server/dist/brain/dupe-scanner.js'),
    configure: (cfg, tuning) => { cfg.dupeScanner = { types: ['fact'], ...tuning }; },
    cursorId: `${S}:fact`,
  },
  {
    name: 'contradiction scanner',
    load: () => import('../../server/dist/brain/contradiction-scanner.js'),
    configure: (cfg, tuning) => { cfg.contradictionScanner = { ...tuning }; },
    cursorId: `${S}:fact:contradiction`,
  },
];

describe('a scanner reads every record of a run that shares a seq', { skip }, () => {
  let door, loader, proto, realFindOne, scanned, bumpSeq;

  before(async () => {
    door = await openPushDoor({ suite: 'scantie', spaces: [{ id: S, label: S, folders: [] }] });
    const available = await door.mongo.checkVectorSearchAvailability();
    assert.equal(available.available, true, 'the harness Mongo has no $vectorSearch: the scanners return before reading anything, so every case below would pass for no reason');
    loader = await import('../../server/dist/config/loader.js');
    ({ bumpSeq } = await import('../../server/dist/util/seq.js'));
    proto = Object.getPrototypeOf(door.mongo.col('probe'));
    realFindOne = proto.findOne;
    proto.findOne = function recording(filter, ...rest) {
      if (this.collectionName === `${S}_facts` && typeof filter?._id === 'string') scanned.push(filter._id);
      return realFindOne.call(this, filter, ...rest);
    };
  });
  after(async () => {
    if (proto && realFindOne) proto.findOne = realFindOne;
    await door?.close();
  });
  beforeEach(async () => {
    scanned = [];
    await door.mongo.col('ythril_dupe_scan_state').deleteMany({});
    await door.coll(S, 'facts').deleteMany({});
    await door.coll(S, 'facts').insertMany(ALL.map(record));
    await bumpSeq(S, 100);
  });

  const stored = async (scanner) => door.mongo.col('ythril_dupe_scan_state').findOne({ _id: scanner.cursorId });
  const writeState = async (scanner, state) => door.mongo.col('ythril_dupe_scan_state').updateOne(
    { _id: scanner.cursorId }, { $set: { spaceId: S, type: 'fact', updatedAt: '2026-10-01T00:00:00.000Z', ...state } }, { upsert: true });

  /** Scan until a run finds nothing more, and say what each run covered. */
  async function scanToEnd(scanner, mod, tuning) {
    scanner.configure(loader.getConfig(), tuning);
    const runs = [];
    for (let i = 0; i < 20; i++) {
      const out = await mod.scanSpace(S);
      runs.push(out.scanned);
      if (out.scanned === 0) return runs;
    }
    assert.fail(`${scanner.name}: still scanning after 20 runs — a cursor that does not advance`);
  }

  for (const scanner of SCANNERS) {
    describe(scanner.name, () => {
      let mod;
      before(async () => { mod = await scanner.load(); });

      it('derives both scanners and a floor of records, so an empty run cannot pass', () => {
        assert.equal(SCANNERS.length, 2);
        assert.ok(ALL.length >= 6 && typeof mod.scanSpace === 'function');
      });

      it('a run split at the BATCH boundary: every record is scanned exactly once', async () => {
        // Batches of 2: [1, 2] [3a, 3b] [3c, 4] — the second ends inside the run at seq 3.
        const runs = await scanToEnd(scanner, mod, { batchSize: 2, maxPerRun: 100 });
        const { missing, repeated } = missingAndRepeated(ALL, scanned);
        assert.deepEqual({ missing, repeated }, { missing: [], repeated: [] },
          `${scanner.name}: ${missing.join(', ')} were never scanned (runs scanned ${runs.join(', ')}) — the batch ended inside the run at seq 3 and the next read excluded the rest of it`);
      });

      it('a run split at maxPerRun: every record is scanned exactly once, over the runs', async () => {
        // The first run is cut after four records: 1, 2, 3a, 3b. The next has to begin at 3c.
        const runs = await scanToEnd(scanner, mod, { batchSize: 200, maxPerRun: 4 });
        assert.equal(runs[0], 4, `${scanner.name}: the first run scanned ${runs[0]}, not the four maxPerRun allows — the fixture is broken`);
        const { missing, repeated } = missingAndRepeated(ALL, scanned);
        assert.deepEqual({ missing, repeated }, { missing: [], repeated: [] },
          `${scanner.name}: ${missing.join(', ')} were never scanned (runs scanned ${runs.join(', ')}); the cap ended a run inside seq 3`);
      });

      it('a cursor an older build wrote (cursorSeq alone) re-scans its own run once, and nothing below it', async () => {
        await writeState(scanner, { cursorSeq: 3 });
        await scanToEnd(scanner, mod, { batchSize: 200, maxPerRun: 100 });
        const { missing, repeated, unexpected } = missingAndRepeated(['3a', '3b', '3c', '4'], scanned);
        assert.deepEqual({ missing, repeated, unexpected }, { missing: [], repeated: [], unexpected: [] },
          `${scanner.name}: from a legacy cursor at 3 the scan covered ${scanned.join(', ') || 'nothing'}; the run at seq 3 may have been read in part, so it is read again, once`);
      });

      it('a rolled-back cursorSeq with a stale cursorPos re-reads from cursorSeq and skips nothing', async () => {
        // An older build moved cursorSeq back to 2 and left the position inside the run at 3 from the newer build's last run.
        await writeState(scanner, { cursorSeq: 2, cursorPos: { seq: 3, id: '3b' } });
        await scanToEnd(scanner, mod, { batchSize: 200, maxPerRun: 100 });
        const { missing, repeated, unexpected } = missingAndRepeated(['2', '3a', '3b', '3c', '4'], scanned);
        assert.deepEqual({ missing, repeated, unexpected }, { missing: [], repeated: [], unexpected: [] },
          `${scanner.name}: with cursorSeq 2 and a stale position at 3/3b the scan covered ${scanned.join(', ') || 'nothing'}; `
          + 'a position that does not belong to cursorSeq is not trusted, and the run AT cursorSeq is read again');
      });

      it('the stored cursor keeps a numeric cursorSeq and says where in a run a stop was', async () => {
        scanner.configure(loader.getConfig(), { batchSize: 200, maxPerRun: 4 });
        const first = await mod.scanSpace(S);
        assert.equal(first.scanned, 4, 'the cap did not stop the run after four records — the fixture is broken');
        const mid = await stored(scanner);
        assert.equal(typeof mid?.cursorSeq, 'number', `cursorSeq is ${JSON.stringify(mid?.cursorSeq)}: an older build reads it as a number`);
        assert.equal(mid.cursorSeq, 3, 'a stop inside the run at seq 3 stores that seq');
        assert.deepEqual(mid.cursorPos, { seq: 3, id: '3b' },
          `the run stopped after 3b and the stored position is ${JSON.stringify(mid.cursorPos)} — without it the next run cannot tell the rest of the run from a run that was finished`);

        scanned = [];
        const rest = await mod.scanSpace(S);
        assert.equal(rest.scanned, 2, `the next run scanned ${rest.scanned}: 3c and 4 remain`);
        assert.deepEqual(scanned.slice().sort(), ['3c', '4'], 'the next run did not begin at the rest of the run');
        const done = await stored(scanner);
        assert.equal(typeof done.cursorSeq, 'number');
        assert.equal(done.cursorSeq, 4);
        if (done.cursorPos !== undefined) assert.equal(done.cursorPos.seq, done.cursorSeq, 'a stored position that is not at cursorSeq is the stale shape rule 4 refuses');
      });
    });
  }
});
