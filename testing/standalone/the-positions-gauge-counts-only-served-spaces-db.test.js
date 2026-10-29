/**
 * The positions-building gauge counts only the spaces this instance serves, and a space created over a kept counter is ready when
 * its create answers (Q-648).
 *
 * ## The defect it closes
 *
 * A space's counter document outlives the space on purpose: decision 16 keeps it so a reused id continues above every version it
 * handed out. The first 6.0 boot marked EVERY counter document without markers as owing its first carry, kept ones included; the owed
 * job visits only configured spaces, and the gauge counted every owing document. So after the 6.0.1 upgrade the canary's
 * `ythril_positions_building_spaces{kind="carry"}` stood at 14 for good on an instance whose every served space was ready — the
 * documents of spaces deleted before the upgrade — while the operator's docs read a value above 0 as a carry that does not finish.
 * And a space CREATED over such a kept, owing document stayed owing until the next tick, answering sync `503 positions_building`
 * after its create had said it was ready.
 *
 * ## What is held
 *
 * 1. After the first carry is marked and after a tick, the gauge counts the served space alone; the kept document still owes and is
 *    left as it is (its space is not served; a space restored to the config is carried by the job then).
 * 2. A kept document `whatFiveSixLeft` marks for repair is not counted either.
 * 3. A space created over a kept, owing document is ready when the create returns, and its counter continues from the kept version.
 * 4. Guard (green at the base, keeps the half of the report that did not reproduce closed): a served space with a 5.6 counter and no
 *    collections finishes its carry in one tick, and a served space with no counter document reads ready.
 *
 * ## Seen red
 *
 * At 5fd65a290: rule 1 reads carry 3 after the detector (two served, one kept); rule 2 reads repair 1; rule 3 reads not ready.
 *
 * Run: node --test testing/standalone/the-positions-gauge-counts-only-served-spaces-db.test.js
 * (requires the harness Mongo and a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason, closeTestMongo } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';

const skip = await mongoSkipReason();

const SERVED = 'gaugeserved';
const EMPTY = 'gaugeempty';
const NO_COUNTER = 'gaugenocounter';
const KEPT = 'gaugekept';
const sp = (id) => ({ id, label: id, folders: [] });

let door, counters, cfgm, owed, registry, lifecycle;

/** The gauge's value per kind, as a scrape reads it. */
async function gauge() {
  const values = (await registry.positionsBuildingSpaces.get()).values;
  return Object.fromEntries(['carry', 'repair'].map(k => [k, values.find(v => v.labels.kind === k)?.value ?? 0]));
}

/** The first 6.0 boot again: no `positionsSince`, the ready cache emptied, the detector run. */
async function firstBoot() {
  const cfg = cfgm.getConfig();
  delete cfg.positionsSince;
  cfgm.saveConfig(cfg);
  owed.forgetPositionsReady();
  await owed.detectReupgrade();
}

describe('the positions gauge counts only the spaces this instance serves (Q-648)', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'gaugeserved', spaces: [sp(SERVED), sp(EMPTY), sp(NO_COUNTER)] });
    const mongo = await import('../../server/dist/db/mongo.js');
    counters = mongo.getDb().collection('ythril_counters');
    cfgm = await import('../../server/dist/config/loader.js');
    owed = await import('../../server/dist/sync/positions-owed.js');
    registry = await import('../../server/dist/metrics/registry.js');
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
  });
  after(async () => {
    await counters?.deleteMany({}).catch(() => {});
    await door?.close?.();
    await closeTestMongo().catch(() => {});
  });
  beforeEach(async () => {
    await counters.deleteMany({});
    // As 5.6 leaves them: a served space with a version and no marker, an empty served space the same, and the kept document of a
    // space deleted before the upgrade. NO_COUNTER never wrote, so 5.6 gave it no document at all.
    await counters.insertMany([{ _id: SERVED, seq: 5 }, { _id: EMPTY, seq: 7 }, { _id: KEPT, seq: 40 }]);
  });

  it('after the first carry is marked and after a tick, only served spaces are counted; the kept document is left owing', async () => {
    await firstBoot();
    assert.equal((await gauge()).carry, 2,
      `the gauge counted a document whose space this instance does not serve: ${JSON.stringify(await gauge())}`);
    await owed.runPositionsOwedTick();
    assert.equal((await gauge()).carry, 0,
      `every served space finished its carry and the gauge still reads above 0: ${JSON.stringify(await gauge())} — an operator reads that as a carry that never ends`);
    const kept = await counters.findOne({ _id: KEPT });
    assert.equal(kept.positionsOwed, 'carry', 'the kept document is not served, so it still owes: a space restored to the config is carried then');
    assert.equal(kept.seq, 40);
  });

  it('a kept document marked for repair is not counted either', async () => {
    await firstBoot();
    await owed.runPositionsOwedTick();
    // A 5.6 build ran again after the first carry: it left a kept document with neither marker, which the detector marks for repair.
    await counters.insertOne({ _id: `${KEPT}2`, seq: 3 });
    owed.forgetPositionsReady();
    await owed.detectReupgrade();
    await owed.runPositionsOwedTick();
    assert.equal((await gauge()).repair, 0, `a document of a space not served was counted as a repair: ${JSON.stringify(await gauge())}`);
  });

  it('a space created over a kept, owing document is ready when the create returns, and continues from the kept version', async () => {
    await firstBoot();
    await owed.runPositionsOwedTick();
    await lifecycle.createSpace({ id: KEPT, label: KEPT }, { tokenId: null });
    try {
      assert.equal(await owed.positionsReady(KEPT), true,
        'the created space still owes its carry, so its sync doors answer 503 positions_building after its create said it was ready');
      const doc = await counters.findOne({ _id: KEPT });
      assert.ok(doc.seq >= 40, `the counter went back below the version the kept document holds: ${JSON.stringify(doc)}`);
    } finally {
      await lifecycle.removeSpace(KEPT).catch(() => {});
    }
  });

  it('guard: an empty served space finishes in one tick, and a served space with no counter document reads ready', async () => {
    await firstBoot();
    await owed.runPositionsOwedTick();
    assert.equal(await owed.positionsOwed(EMPTY), undefined, 'the empty served space still owes after a tick');
    assert.equal(await owed.positionsReady(EMPTY), true);
    assert.equal(await owed.positionsReady(NO_COUNTER), true, 'a served space 5.6 never wrote to reads as owing');
  });
});
