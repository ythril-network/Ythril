/**
 * A re-upgrade repairs exactly what 5.6 changed while it ran on a 6.0 database, and runs no repair when nothing did
 * (bundle-81 test 10; design rev 8 section 3 "Re-upgrade", observability S4, reliability S1).
 *
 * ## What 5.6 does to a 6.0 database
 *
 * A 5.6 build knows no `pos`. A local `$set` edit keeps the row's old `pos` and changes `seq`; an arrival REPLACE drops `pos`; a file-meta
 * merge at a seq at or below the counter keeps `pos` and moves `seq` without moving the counter. Every one of them leaves a row that
 * peers' position marks have already passed, so it would never be offered again: Q-278's shadow, made by a downgrade. The row says so
 * itself: `posAtSeq` records the version a position was taken for, and a row whose `posAtSeq` differs from `seq` (or that has no `pos`)
 * changed without a position. The detector finds the SPACES that need looking (the counter moved under a 5.6 allocation, `seq !=
 * seqSeenBy6`; or a member's `lastSyncAt` differs from `lastSyncAtBy6`, a 5.6 build having synced with it), marks them owing `'repair'`,
 * and the owed job gives each such row a fresh CLOCK position (never the identity band: peers' marks for this instance are in the clock
 * band after a rollback) and a recomputed `writtenHere`.
 *
 * ## The rule, over the whole set it governs
 *
 * - **Repaired:** every row of every seq-carrying collection (derived from `util/seq.ts`, with a floor) that 5.6 changed in each of the three
 *   ways, found by identity: it ends with a position above every position held before, in the clock band, `posAtSeq` equal to `seq`.
 * - **Not touched:** every row 5.6 did not change keeps its stored document EXACTLY, `pos` as seeded (a sentinel), so a repair that
 *   re-positioned everything is red.
 * - **Readiness:** the space ends ready, not owing, `seqSeenBy6` equal to `seq`; and a space is not ready while it owes (the readiness read
 *   is asked inside the reader, section 3 step 6).
 * - **A member trip marks every space of that member's network** owing `'repair'`, and the owed job repairs each.
 * - **A counter doc with neither field**, after `positionsSince` is set, owes `'repair'` (a 5.6-renamed or 5.6-created space).
 * - **No false trip** (observability S4), from a healthy 6.0 state, each leaving every row byte for byte as it was and nothing owing: the
 *   detector with nothing changed; an announce-only member (`stampLastSync`, which stamps both fields); a renamed space (the real
 *   `renameSpace`, which moves the counter doc whole); a restored space (the real restore act, over a 6.0 backup).
 *
 * The functions that trigger the detector and the owed job are not named by the plan; `_b81d-owed-driver.mjs` is the one place that
 * assumes them, and the report says so.
 *
 * Run: node --test testing/standalone/a-re-upgrade-repairs-what-5-6-changed-db.test.js  (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor } from './_pull-door.mjs';
import { restoreModules, takeBackup, restoreToTheEnd } from './_restore-act.mjs';
import { owedDriver, stampLastSyncOf, CLOCK_BAND } from './_b81d-owed-driver.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const SUITE = 'b81tD_reupgrade';
const S = 'ru-one';
const T = 'ru-two';
const R = 'ru-renamed';
const T_OLD = '2026-10-01T00:00:00.000Z';
const T_NEW = '2026-10-20T00:00:00.000Z';

describe('a re-upgrade repairs what 5.6 changed', { skip }, () => {
  let door; let owed; let stampLastSync; let seqMod; let PARTS; let mods;
  const col = (space, part) => door.coll(space, part);

  before(async () => {
    door = await openPullDoor({ suite: SUITE, spaces: [S, T], extraSpaces: ['ru-spare'] });
    seqMod = await import('../../server/dist/util/seq.js');
    PARTS = [...seqMod.SEQ_CARRYING];
    assert.ok(PARTS.length >= 7, `only ${PARTS.length} seq-carrying parts derived`);
    owed = await owedDriver();
    stampLastSync = await stampLastSyncOf();
    mods = await restoreModules();
  });
  after(async () => { await door?.close(); });

  /** A row of `part` in a healthy 6.0 state: a position in the clock band, `posAtSeq` equal to `seq`, authored here. */
  const healthy = (space, part, n, seq) => {
    const make = { facts: build.fact, entities: build.entity, edges: build.edge, chrono: build.chrono, links: build.link, files: build.filemeta, tombstones: (s, id, q, x) => build.tombstone(s, id, 'facts', q, x) }[part];
    return make(space, `${space}-${part}-${n}`, seq, { author: { instanceId: door.instanceId, instanceLabel: 'self' }, pos: CLOCK_BAND + seq, posAtSeq: seq, writtenHere: true });
  };
  async function seedHealthy(space, counterSeq = 50) {
    for (const part of PARTS) {
      await col(space, part).deleteMany({});
      await col(space, part).insertMany([1, 2, 3].map(n => healthy(space, part, n, 10 * n)));
    }
    await door.mongo.col('ythril_counters').updateOne({ _id: space }, { $set: { seq: counterSeq, seqSeenBy6: counterSeq, positionsReadyAt: T_OLD }, $unset: { positionsOwed: '' } }, { upsert: true });
  }
  const rowsOf = async (space) => Object.fromEntries(await Promise.all(PARTS.map(async p => [p, await col(space, p).find({}).sort({ _id: 1 }).toArray()])));
  const counterOf = (space) => door.mongo.col('ythril_counters').findOne({ _id: space });
  const member = () => door.member();

  beforeEach(async () => {
    await door.reset();
    const cfg = door.config();
    delete cfg.positionsSince;
    const m = member();
    m.lastSyncAt = T_OLD; m.lastSyncAtBy6 = T_OLD;
    await seedHealthy(S); await seedHealthy(T);
  });

  describe('what 5.6 changed is repaired, and only that', () => {
    /** The three ways, in each seq-carrying collection that can carry them, and the counter a 5.6 allocation moved. */
    async function fiveSixRuns(space) {
      const changed = [];
      for (const part of PARTS) {
        const [a, b, c] = await col(space, part).find({}).sort({ _id: 1 }).toArray();
        // (1) an arrival REPLACE: a new document at a new seq, with no position of its own.
        const { pos: _p, posAtSeq: _a, writtenHere: _w, ...bare } = a;
        await col(space, part).replaceOne({ _id: a._id }, { ...bare, seq: 100 });
        // (2) a `$set` edit: the seq moves, the position stays.
        await col(space, part).updateOne({ _id: b._id }, { $set: { seq: 101 } });
        changed.push(a._id, b._id);
        void c; // the third row of every collection is left alone, to be asserted untouched
      }
      await door.mongo.col('ythril_counters').updateOne({ _id: space }, { $set: { seq: 150 } }); // a 5.6 allocation: `seq` moves, `seqSeenBy6` does not
      return changed;
    }

    it('re-positions every changed row with a fresh clock position, leaves every other row exactly as it was, and the space ends ready', async () => {
      const before = await rowsOf(S);
      const changed = await fiveSixRuns(S);
      const heldTop = Math.max(...Object.values(before).flat().map(r => r.pos));
      await owed.detectReupgrade();
      assert.equal((await counterOf(S)).positionsOwed, 'repair', 'the counter moved under 5.6 and the space does not owe a repair');
      await owed.tick();
      const after = await rowsOf(S);
      for (const part of PARTS) {
        for (const row of after[part]) {
          if (changed.includes(row._id)) {
            assert.ok(row.pos > heldTop, `${part} ${row._id}: pos ${row.pos} is not above every position held before (${heldTop}): a fresh clock position was not taken`);
            assert.ok(row.pos > 2 ** 50, `${part} ${row._id}: pos ${row.pos} is in the legacy band; a repair takes clock positions (peers' marks are in the clock band)`);
            assert.equal(row.posAtSeq, row.seq, `${part} ${row._id}: posAtSeq ${row.posAtSeq} does not name the version ${row.seq} the position was taken for`);
          } else {
            const was = before[part].find(r => r._id === row._id);
            assert.deepEqual(row, was, `${part} ${row._id}: a row 5.6 did not change was rewritten by the repair`);
          }
        }
      }
      const counter = await counterOf(S);
      assert.equal(counter.positionsOwed, undefined, 'the space still owes after its repair');
      assert.ok(counter.positionsReadyAt, 'the space is not marked ready after its repair');
      assert.equal(counter.seqSeenBy6, counter.seq, 'seqSeenBy6 does not equal seq: the next boot would repair the space again');
      assert.ok(changed.length >= PARTS.length * 2, 'the fixture changed too few rows to say anything');
    });

    it('a second detector pass and a second tick after a repair change nothing', async () => {
      await fiveSixRuns(S);
      await owed.detectReupgrade(); await owed.tick();
      const once = await rowsOf(S);
      await owed.detectReupgrade(); await owed.tick();
      assert.deepEqual(await rowsOf(S), once, 'a repaired space was repaired again');
      assert.equal((await counterOf(S)).positionsOwed, undefined);
    });

    it('a member whose lastSyncAt differs from lastSyncAtBy6 marks EVERY space of its network owing, and the owed job repairs each', async () => {
      // 5.6 synced with the member (it writes `lastSyncAt` only) and replaced a row in the SECOND space without moving its counter.
      member().lastSyncAt = T_NEW;
      const [row] = await col(T, 'facts').find({}).sort({ _id: 1 }).toArray();
      await col(T, 'facts').updateOne({ _id: row._id }, { $set: { seq: 77 } });
      await owed.detectReupgrade();
      for (const space of [S, T]) assert.equal((await counterOf(space)).positionsOwed, 'repair', `${space}: a member trip did not mark the space owing`);
      await owed.tick();
      const fixed = await col(T, 'facts').findOne({ _id: row._id });
      assert.equal(fixed.posAtSeq, 77, 'the row 5.6 changed in the second space was not repaired');
      assert.ok(fixed.pos > CLOCK_BAND + 30, 'the repaired row did not take a fresh position');
      for (const space of [S, T]) assert.equal((await counterOf(space)).positionsOwed, undefined, `${space}: still owing after the tick`);
      assert.equal(member().lastSyncAtBy6, member().lastSyncAt, 'the member still reads as synced by 5.6: the next boot would trip again');
    });

    it('a counter doc with neither marker field, once this instance has started its first carry, owes a repair', async () => {
      door.config().positionsSince = T_OLD;
      await door.mongo.col('ythril_counters').replaceOne({ _id: S }, { _id: S, seq: 50 }); // what a 5.6 rename or a 5.6-created space leaves
      await owed.detectReupgrade();
      assert.equal((await counterOf(S)).positionsOwed, 'repair');
    });
  });

  describe('no false trip: from a healthy 6.0 state nothing is repaired', () => {
    async function assertQuiet(what, spaces) {
      const before = Object.fromEntries(await Promise.all(spaces.map(async s => [s, await rowsOf(s)])));
      await owed.detectReupgrade();
      for (const s of spaces) assert.equal((await counterOf(s))?.positionsOwed, undefined, `${what}: ${s} was marked owing`);
      await owed.tick();
      for (const s of spaces) {
        assert.deepEqual(await rowsOf(s), before[s], `${what}: a row of ${s} was rewritten by a repair that had nothing to repair`);
        assert.equal((await counterOf(s)).positionsOwed, undefined, `${what}: ${s} owes after the tick`);
      }
    }

    it('the detector with nothing changed', async () => { await assertQuiet('a healthy state', [S, T]); });

    it('an announce-only member: stampLastSync stamps both fields, so the member does not trip', async () => {
      stampLastSync(member(), T_NEW);
      assert.equal(member().lastSyncAtBy6, member().lastSyncAt, 'stampLastSync wrote lastSyncAt and not lastSyncAtBy6');
      await assertQuiet('an announce-only member', [S, T]);
    });

    it('a renamed space: the counter doc moves whole, with its markers, and the space is not repaired', async () => {
      const { renameSpace } = await import('../../server/dist/spaces/rename.js');
      await seedHealthy('ru-spare');
      const before = await rowsOf('ru-spare');
      await renameSpace('ru-spare', R);
      const moved = await counterOf(R);
      assert.ok(moved?.positionsReadyAt && moved.seqSeenBy6 === moved.seq, `the rename did not carry the counter doc's markers: ${JSON.stringify(moved)}`);
      await owed.detectReupgrade();
      assert.equal((await counterOf(R)).positionsOwed, undefined, 'a renamed space was marked owing');
      await owed.tick();
      const after = await rowsOf(R);
      for (const part of PARTS) assert.deepEqual(after[part].map(r => ({ ...r, _id: r._id, spaceId: undefined })).map(r => r.pos), before[part].map(r => r.pos), `${part}: the rename moved positions`);
    });

    it('a restored space: a 6.0 backup keeps its positions, and the restore is not repaired', async () => {
      const backup = await takeBackup(SUITE, `ru-${Date.now()}`);
      const before = await rowsOf(S);
      await restoreToTheEnd(mods, { backupId: backup.id });
      await owed.detectReupgrade();
      assert.equal((await counterOf(S))?.positionsOwed, undefined, 'a restored space was marked owing');
      await owed.tick();
      const after = await rowsOf(S);
      for (const part of PARTS) assert.deepEqual(after[part].map(r => [r._id, r.pos, r.posAtSeq]), before[part].map(r => [r._id, r.pos, r.posAtSeq]), `${part}: the restore changed positions`);
    });
  });
});
