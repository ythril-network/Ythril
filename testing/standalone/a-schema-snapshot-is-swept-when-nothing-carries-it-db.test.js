/**
 * A schema snapshot row is removed once nothing here uses it: no stored record of the space carries its fingerprint, it is not the current variation's
 * nor a network layer's, and no row that stays links it. It is marked when the sweep first finds it unused and removed no sooner than the grace after
 * that, and every way a row comes back into use clears the mark (Q-739, bundle-266; design r2 D2-D5 as r3 amends them).
 *
 * ## The interface these cases fix (design r3 names the module and the verdict; the seam names are this file's)
 *
 * - `server/src/spaces/schema-snapshot-sweep.ts` exports `sweepSchemaSnapshots({ now })`: one pass over every configured space (`eachSpace`), the time
 *   seam as `sweepOwnerlessViews` takes it (config/views.ts). The housekeeping cycle (`sweepExpired`) runs it after `ensureSchemaSnapshots`.
 * - It also exports `setSchemaSnapshotSweepHooksForTest({ beforeDelete(spaceId, fps), afterDelete(spaceId, fps) } | null)`: hooks run INSIDE the pass,
 *   right before and right after its conditional delete (as `setSpaceActHooksForTest` does for the act runner); a hook that throws fails the pass there.
 * - `server/src/spaces/schema-snapshot.ts` exports `SNAPSHOT_REMOVAL_GRACE_MS` (24 h).
 * - A row's mark is `orphanSince`, the ISO time of the pass that found it unused.
 *
 * ## The masking channels are held off
 *
 * Three channels write snapshot rows on their own and would hide a removal: the housekeeping cycle (`ensureSchemaSnapshots`; this door runs no timer,
 * and only the last case calls the cycle, on purpose), the per-write backstop (only a stamping write runs it; the race cases use one on purpose) and the
 * fetch (no space here is shared with a member). Rows are seeded straight into the store, and the held cache is set or read through `noteHeld` /
 * `knownHeld`.
 *
 * ## Seen red at 82208a6b
 *
 * `spaces/schema-snapshot-sweep.js` does not exist: every sweep case fails at the loader. Three cases are about writers that exist and fail on their
 * behaviour: a `fetched` row whose fingerprint becomes a layer or the current variation keeps origin `fetched` (store :96-97, `$setOnInsert`), and an
 * `ensureSnapshot` in flight while `forgetHeld` runs marks the row held when it lands (store :103).
 *
 * Run: a Mongo the harness accepts, `npm run build -w @ythril/server`, then
 * node --test testing/standalone/a-schema-snapshot-is-swept-when-nothing-carries-it-db.test.js
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { eventually, parkWrites, settleWithin } from './_write-faults.mjs';
import { seedActEntry, clearActEntries, metricSample } from './_space-act-harness.mjs';
import { logLinesDuring } from './_log-lines.mjs';
import { clone } from './_schema-fingerprint.mjs';

const skip = await mongoSkipReason();
const SUITE = 'b266sweep';
const NET = 'net-sweep';
const T = { timeout: 60_000 };

const X_META = { typeSchemas: { entity: { thing: { propertySchemas: { n: { type: 'string' } } } } } };
const Y_META = { typeSchemas: { entity: { thing: { propertySchemas: { n: { type: 'string' }, y: { type: 'number' } } } } } };
const Z_META = { typeSchemas: { entity: { thing: { propertySchemas: { n: { type: 'string' }, z: { type: 'boolean' } } } } } };
const LAYER = { typeSchemas: { entity: { shared: { propertySchemas: { s: { type: 'string' } } } } } };
const OLD_LAYER = { typeSchemas: { entity: { shared: { propertySchemas: { s: { type: 'string' }, old: { type: 'string' } } } } } };
const SPACE_IDS = ['fork', 'lay', 'linked', 'grace', 'gone', 'back', 'acted', 'closed', 'race', 'between', 'throws', 'rev', 'upg', 'upgown', 'gen', 'cycle', 'probe'];

let door, loader, spaces, effective, stampMod, store, owedMod, sweepMod, loadedGrace;

const fpHex = (c, i = 0) => (c + i.toString(16)).padEnd(64, c).slice(0, 64);
const snaps = (id) => door.coll(id, 'schema_snapshots');
const rowOf = (id, fp) => snaps(id).findOne({ _id: fp });
const until = async (check, what, ms = 15_000) => assert.ok(await eventually(check, ms, 50), `${what} within ${ms} ms`);
/** The stamp of a meta, asked of the server on a scratch space. */
const stampOf = (meta) => { loader.getConfig().spaces.find(s => s.id === 'probe').meta = clone(meta); return stampMod.readMetaForWrite('probe').stamp; };
const T0 = Date.parse('2026-11-13T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

/** A row straight into the store (no writer, no held cache), as an older pass or a restore leaves it. */
async function seedRow(space, fp, over = {}) {
  await snaps(space).insertOne({ _id: fp, text: `{"format":1,"rules":{},"typeSchemas":{"t${fp.slice(0, 6)}":{}}}`, origin: 'own', links: null, at: iso(T0 - 86_400_000 * 30), ...over });
}
/** A stored record carrying `fp`: a fact, or with `fork` an entity fork row. */
async function carry(space, fp, { id = `rec-${fp.slice(0, 8)}`, fork = false, deliveredBy } = {}) {
  const common = { _id: id, spaceId: space, tags: [], seq: 1, createdAt: iso(T0), updatedAt: iso(T0), author: { instanceId: 'x', instanceLabel: 'X' },
    [stampMod.SCHEMA_FINGERPRINT_FIELD]: fp, ...(deliveredBy ? { deliveredBy } : {}) };
  if (fork) await door.coll(space, 'entities').insertOne({ ...common, name: 'forked', type: 'thing', properties: {}, forkOf: 'the-subject' });
  else await door.coll(space, 'facts').insertOne({ ...common, fact: `carries ${fp.slice(0, 8)}` });
}
/** The sweep is built: its module loads and the grace is one. A failure naming what is missing, before any fixture uses the grace. */
const built = () => {
  assert.ok(!sweepMod.__missing, `server/dist/spaces/schema-snapshot-sweep.js does not load (${sweepMod.__missing?.code ?? sweepMod.__missing})`);
  assert.equal(typeof sweepMod.sweepSchemaSnapshots, 'function', 'spaces/schema-snapshot-sweep.js exports no sweepSchemaSnapshots');
  assert.ok(Number.isFinite(loadedGrace) && loadedGrace > 60 * 60_000, `SNAPSHOT_REMOVAL_GRACE_MS is ${loadedGrace}: no grace longer than any write's read-to-land window`);
};
/** `SNAPSHOT_REMOVAL_GRACE_MS`, once the sweep is built. */
const grace = () => { built(); return loadedGrace; };
/** One pass at `now`. */
const sweep = (now) => { built(); return sweepMod.sweepSchemaSnapshots({ now }); };
/** The test seam of the pass (see the docblock). */
const setHooks = (hooks) => {
  assert.equal(typeof sweepMod.setSchemaSnapshotSweepHooksForTest, 'function', 'spaces/schema-snapshot-sweep.js exports no setSchemaSnapshotSweepHooksForTest');
  sweepMod.setSchemaSnapshotSweepHooksForTest(hooks);
};

describe('a schema snapshot is swept when nothing here carries it, after a grace (real MongoDB)', { skip }, () => {
  before(async () => {
    door = await openPushDoor({
      suite: SUITE,
      spaces: SPACE_IDS.map(id => ({ id, label: id, folders: [], ...(id === 'lay' || id === 'upg' ? { meta: clone(LAYER) } : {}) })),
      networks: [{
        id: NET, label: 'Net', type: 'club', origin: 'created', syncSchedule: '', spaces: ['lay', 'upg'], votingDeadlineHours: 24,
        createdAt: '2026-01-01T00:00:00.000Z', members: [], pendingRounds: [], schemaLayers: { lay: clone(LAYER) },
      }],
    });
    loader = await import('../../server/dist/config/loader.js');
    spaces = await import('../../server/dist/spaces/spaces.js');
    effective = await import('../../server/dist/spaces/effective-meta.js');
    stampMod = await import('../../server/dist/spaces/schema-stamp.js');
    store = await import('../../server/dist/spaces/schema-snapshot-store.js');
    owedMod = await import('../../server/dist/sync/schema-snapshot-owed.js');
    // Loaded without failing the file: the cases about writers that exist must fail on their behaviour, not on a module the sweep adds.
    sweepMod = await import('../../server/dist/spaces/schema-snapshot-sweep.js').catch(err => ({ __missing: err }));
    ({ SNAPSHOT_REMOVAL_GRACE_MS: loadedGrace } = await import('../../server/dist/spaces/schema-snapshot.js'));
  });
  afterEach(() => { sweepMod?.setSchemaSnapshotSweepHooksForTest?.(null); });
  after(async () => { await door?.close(); });

  describe('what is kept', () => {
    it('a row one fork row carries is kept and never marked', T, async () => {
      const F = fpHex('f');
      await seedRow('fork', F);
      await carry('fork', F, { fork: true });
      await sweep(T0);
      await sweep(T0 + grace() + 1);
      const row = await rowOf('fork', F);
      assert.ok(row, 'a row a fork row carries was removed: a fork is a stored record like any other');
      assert.equal(row.orphanSince, undefined, 'a carried row was marked unused');
    });

    it('the current variation\'s row and every layer row, the current layer and an old one, are kept', T, async () => {
      await store.ensureSchemaSnapshots();
      const current = stampMod.readMetaForWrite('lay').stamp.fp;
      const old = stampOf(OLD_LAYER).fp;
      await seedRow('lay', old, { origin: 'layer', networkId: NET });
      await until(async () => !!(await rowOf('lay', current)), 'the cycle wrote no row for the current layer');
      await sweep(T0);
      await sweep(T0 + grace() + 1);
      assert.ok(await rowOf('lay', current), 'the current variation\'s row was removed');
      const oldRow = await rowOf('lay', old);
      assert.ok(oldRow, 'an old layer row was removed: behindVerdict reads every layer this instance ever held');
      assert.equal(oldRow.orphanSince, undefined, 'a layer row was marked');
    });

    it('a row a kept row links is kept, and so is the row that one links', T, async () => {
      const K = fpHex('1'); const L = fpHex('2'); const M = fpHex('3');
      await seedRow('linked', K, { links: { own: L, layers: [], served: [] } });
      await seedRow('linked', L, { links: { own: fpHex('9'), layers: [{ networkId: NET, fp: M }], served: [] } });
      await seedRow('linked', M, { origin: 'fetched', from: 'peer-x' });
      await carry('linked', K);
      await sweep(T0);
      await sweep(T0 + grace() + 1);
      assert.deepEqual((await snaps('linked').find({}).toArray()).map(r => r._id).sort(), [K, L, M].sort(), 'a linked row was removed while the row linking it stays');
    });
  });

  describe('mark, then remove after the grace', () => {
    it('a first pass marks an unused row; a second pass inside the grace keeps it and its first mark', T, async () => {
      const O = fpHex('4');
      await seedRow('grace', O);
      await sweep(T0);
      assert.equal((await rowOf('grace', O))?.orphanSince, iso(T0), 'the first pass did not mark the unused row with its own time');
      await sweep(T0 + grace() - 1000);
      const row = await rowOf('grace', O);
      assert.ok(row, 'a row was removed inside its grace');
      assert.equal(row.orphanSince, iso(T0), 'a later pass moved the mark: the grace would never run out');
      // A pass sweeps every space: left here, this row would be removed by the next case's pass and counted in its global metric.
      await snaps('grace').deleteMany({});
    });

    it('a pass past the grace removes the rows, forgets them as held, counts each removed and names the first five', T, async () => {
      const gone = Array.from({ length: 6 }, (_, i) => fpHex('5', i));
      for (const fp of gone) { await seedRow('gone', fp); stampMod.noteHeld('gone', fp); }
      await sweep(T0);
      const before = await metricSample('ythril_schema_snapshot_total', { outcome: 'removed' });
      const { lines } = await logLinesDuring(() => sweep(T0 + grace() + 1));
      assert.equal(await snaps('gone').countDocuments({}), 0, 'a row past its grace was not removed');
      assert.deepEqual(gone.filter(fp => stampMod.knownHeld('gone', fp)), [], 'a removed row is still known held: the backstop and the gap scan would skip it');
      assert.equal(await metricSample('ythril_schema_snapshot_total', { outcome: 'removed' }) - before, 6, 'the metric does not count each removed row');
      const said = lines.filter(l => l.includes("'gone'"));
      assert.equal(said.length, 1, `want one line for the space's pass: ${JSON.stringify(lines)}`);
      const named = gone.filter(fp => said[0].includes(fp.slice(0, 12)));
      assert.equal(named.length, 5, `the line names ${named.length} fingerprint prefixes, want the first five: ${said[0]}`);
    });

    it('a marked row that is carried again loses its mark and is not removed', T, async () => {
      const O = fpHex('6');
      await seedRow('back', O);
      await sweep(T0);
      assert.ok((await rowOf('back', O))?.orphanSince, 'fixture: the first pass did not mark the row');
      await carry('back', O);
      await sweep(T0 + 1000);
      assert.equal((await rowOf('back', O))?.orphanSince, undefined, 'a row a record carries again kept its mark');
      await sweep(T0 + grace() + 1);
      assert.ok(await rowOf('back', O), 'a carried row was removed');
    });
  });

  describe('the pass is one gated unit and fails closed', () => {
    it('an import act standing on the space defers the whole pass: no mark, no clear, no removal; the next pass after the act acts', T, async () => {
      const marked = fpHex('7'); const fresh = fpHex('8');
      await seedRow('acted', marked, { orphanSince: iso(T0 - 2 * grace()) });
      await seedRow('acted', fresh);
      await seedActEntry(loader, { kind: 'import', localId: 'acted', state: 'registered' });
      try {
        await sweep(T0);
        assert.ok(await rowOf('acted', marked), 'the sweep removed a row while an import act stood on the space');
        assert.equal((await rowOf('acted', fresh)).orphanSince, undefined, 'the sweep marked a row while an import act stood on the space');
      } finally { clearActEntries(loader); }
      await sweep(T0);
      assert.equal(await rowOf('acted', marked), null, 'once the act was gone, the next pass did not remove the row past its grace');
    });

    it('one record collection whose read fails leaves every row and mark of the space untouched', T, async () => {
      const { ensureTtlIndexes } = await import('../../server/dist/spaces/space-indexes.js');
      assert.deepEqual((await ensureTtlIndexes('closed')).failed, [], 'fixture: the stamp index did not build');
      const marked = fpHex('a'); const fresh = fpHex('b');
      const mark = iso(T0 - 2 * grace());
      await seedRow('closed', marked, { orphanSince: mark });
      await seedRow('closed', fresh);
      // A real failure: the read hints the stamp's partial index, and on one collection it is gone.
      await door.coll('closed', 'edges').dropIndex(`${stampMod.SCHEMA_FINGERPRINT_FIELD}_present`);
      try {
        await sweep(T0);
        const after = await rowOf('closed', marked);
        assert.ok(after, 'a row was removed though one collection could not be read: it might have carried it');
        assert.equal(after.orphanSince, mark, 'a mark was moved by a pass that could not read every collection');
        assert.equal((await rowOf('closed', fresh)).orphanSince, undefined, 'a row was marked by a pass that could not read every collection');
      } finally { assert.deepEqual((await ensureTtlIndexes('closed')).failed, []); }
    });
  });

  describe('the races the grace and the held cache close', () => {
    it('probe experiment 1, through the real write path: a write that read X lands after a schema edit and a sweep, and X is still there', T, async () => {
      spaces.updateSpace('race', { meta: clone(X_META) });
      const X = stampOf(X_META).fp;
      await until(async () => !!(await rowOf('race', X)), 'no row for X');
      const { upsertEntity } = await import('../../server/dist/brain/entities.js');
      const park = parkWrites(Object.getPrototypeOf(door.coll('race', 'entities')));
      let write;
      try {
        const gate = park.arm('race_entities');
        write = upsertEntity('race', 'read under X', 'thing', [], { n: 'x' });
        await gate.reached;
        spaces.updateSpace('race', { meta: clone(Y_META) });
        await until(async () => !!(await rowOf('race', stampOf(Y_META).fp)), 'no row for Y');
        const first = await settleWithin(sweep(T0), 5_000);
        gate.release();
        if (!first.settled) await first.rest;
        await write;
      } finally { park.restore(); }
      const stored = await door.coll('race', 'entities').findOne({ name: 'read under X' });
      assert.equal(stored?.[stampMod.SCHEMA_FINGERPRINT_FIELD], X, 'fixture: the write did not land stamped with the schema it read');
      await sweep(T0 + grace() + 1);
      const row = await rowOf('race', X);
      assert.ok(row, 'the version a landed record carries was removed: probe experiment 1 loses its text');
      assert.equal(row.orphanSince, undefined, 'the carried row kept its mark');
    });

    it('a record that lands between the verdict and the delete: the row goes, it is not known held, and the next gap scan owes it', T, async () => {
      const O = fpHex('c');
      await seedRow('between', O, { orphanSince: iso(T0 - 2 * grace()) });
      stampMod.noteHeld('between', O);
      setHooks({ beforeDelete: async (spaceId) => { if (spaceId === 'between') await carry('between', O, { deliveredBy: 'peer-late' }); } });
      await sweep(T0);
      setHooks(null);
      assert.equal(await rowOf('between', O), null, 'fixture: the delete did not run (the hook ran after it, or not at all)');
      assert.equal(stampMod.knownHeld('between', O), false, 'a removed row is still known held');
      owedMod.forgetOwedSchemaSnapshots();
      await owedMod.scanOwedSchemaSnapshots();
      assert.deepEqual(owedMod.owedTo('between', 'peer-late', ['peer-late'], Date.now()), [O], 'the gap scan does not owe the version the late record carries');
    });

    it('a delete that throws after it applied: the removed row is not known held', T, async () => {
      const O = fpHex('d');
      await seedRow('throws', O, { orphanSince: iso(T0 - 2 * grace()) });
      stampMod.noteHeld('throws', O);
      setHooks({ afterDelete: (spaceId) => { if (spaceId === 'throws') throw new Error('the answer to the delete was lost'); } });
      await sweep(T0).catch(() => { /* the pass may say its failure; the case is about what it left */ });
      assert.equal(await rowOf('throws', O), null, 'fixture: the delete did not apply');
      assert.equal(stampMod.knownHeld('throws', O), false, 'a row whose delete applied and then failed is still known held for the life of the process');
    });

    it('a revert to a marked X and away again within one cycle, with a write under X in flight: X is kept', T, async () => {
      spaces.updateSpace('rev', { meta: clone(X_META) });
      const X = stampOf(X_META).fp;
      await until(async () => !!(await rowOf('rev', X)), 'no row for X');
      spaces.updateSpace('rev', { meta: clone(Y_META) });
      await sweep(T0);
      assert.equal((await rowOf('rev', X))?.orphanSince, iso(T0), 'fixture: the pass after the edit away did not mark X');
      // Back to X: X is current again, so its mark goes, whatever the held cache says.
      spaces.updateSpace('rev', { meta: clone(X_META) });
      await until(async () => (await rowOf('rev', X))?.orphanSince === undefined, 'X became current again and kept its old mark');
      const { upsertEntity } = await import('../../server/dist/brain/entities.js');
      const park = parkWrites(Object.getPrototypeOf(door.coll('rev', 'entities')));
      let write;
      try {
        const gate = park.arm('rev_entities');
        write = upsertEntity('rev', 'in flight under X', 'thing', [], { n: 'x' });
        await gate.reached;
        spaces.updateSpace('rev', { meta: clone(Y_META) });
        const second = await settleWithin(sweep(T0 + grace() + 1), 5_000);
        gate.release();
        if (!second.settled) await second.rest;
        await write;
      } finally { park.restore(); }
      assert.ok(await rowOf('rev', X), 'X was removed on its OLD mark while a write built under X was landing');
      const stored = await door.coll('rev', 'entities').findOne({ name: 'in flight under X' });
      assert.equal(stored?.[stampMod.SCHEMA_FINGERPRINT_FIELD], X, 'fixture: the write did not land stamped X');
    });

    it('an ensureSnapshot in flight while forgetHeld runs does not mark the row held when it lands', T, async () => {
      const stamp = stampOf(Z_META);
      const park = parkWrites(Object.getPrototypeOf(snaps('gen')));
      let kept;
      try {
        const gate = park.arm('gen_schema_snapshots');
        kept = store.ensureSnapshot('gen', stamp, { origin: 'own', links: null });
        await gate.reached;
        stampMod.forgetHeld('gen', stamp.fp);
        gate.release();
        await kept;
      } finally { park.restore(); }
      assert.ok(await rowOf('gen', stamp.fp), 'fixture: the upsert did not land');
      assert.equal(stampMod.knownHeld('gen', stamp.fp), false, 'a keep that started before a removal marked the row held after it: the backstop would never write it again');
    });
  });

  describe('a row whose fingerprint becomes current or a layer takes the right origin', () => {
    it('a fetched row whose fingerprint becomes a network layer is upgraded to origin layer, its text untouched', T, async () => {
      const NEXT = { typeSchemas: { entity: { shared: { propertySchemas: { s: { type: 'string' }, next: { type: 'number' } } } } } };
      const layerStamp = stampMod.layerStampOf(clone(NEXT));
      assert.equal(await store.ensureSnapshot('upg', layerStamp, { origin: 'fetched', from: 'peer-x', links: null }), 'written');
      effective.storeNetworkLayer(NET, 'upg', clone(NEXT));
      await until(async () => (await rowOf('upg', layerStamp.fp))?.origin === 'layer', 'a fetched row whose fingerprint became a layer kept origin fetched');
      const row = await rowOf('upg', layerStamp.fp);
      assert.equal(row.networkId, NET);
      assert.equal(row.from, undefined, 'the upgraded row still names the member it was fetched from');
      assert.equal(row.links, null);
      assert.equal(row.text, layerStamp.text);
    });

    it('a fetched row whose fingerprint becomes the current variation is upgraded to origin own with its links', T, async () => {
      const stamp = stampOf(Z_META);
      assert.equal(await store.ensureSnapshot('upgown', stamp, { origin: 'fetched', from: 'peer-x', links: null }), 'written');
      spaces.updateSpace('upgown', { meta: clone(Z_META) });
      await until(async () => (await rowOf('upgown', stamp.fp))?.origin === 'own', 'a fetched row whose fingerprint became current kept origin fetched');
      const row = await rowOf('upgown', stamp.fp);
      assert.deepEqual(row.links, { own: stamp.fp, layers: [], served: [] });
      assert.equal(row.from, undefined);
    });
  });

  describe('the housekeeping cycle runs the sweep', () => {
    it('sweepExpired removes a row marked more than the grace ago and nothing carries', T, async () => {
      const O = fpHex('e');
      await seedRow('cycle', O, { orphanSince: iso(Date.now() - 2 * grace()) });
      const { sweepExpired } = await import('../../server/dist/brain/ttl-sweep.js');
      await sweepExpired();
      assert.equal(await rowOf('cycle', O), null, 'the housekeeping cycle does not run the snapshot sweep');
    });
  });
});
