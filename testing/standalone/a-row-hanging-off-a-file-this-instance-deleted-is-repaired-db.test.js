/**
 * A derived row that hangs off a file this instance deleted is removed by a recurring repair, and nothing a person can still reach
 * is (bundle-113, Q-465; vet rulings reliability S8-S10 / data S1, S2, S6, S7, security S9, observability S2-S3, T-S13).
 *
 * ## The defect it prevents
 *
 * A file delete removed the rows derived from the file by reading one level of `parentFileId` for years, and a move re-rooted rows
 * its plan did not name: both left chunk, converted, extracted, caption and face rows whose chain ends at a file that has no row,
 * has a flagged one, or is not the file the row's own id names. Nothing selects them again: they are searchable, belong to nothing,
 * and no later delete reaches them. The fix for the delete went forward only; the rows already there need a repair.
 *
 * ## The rule, over every shape a leaked row takes
 *
 * A derived row (one with a `parentFileId`) is REMOVED when its chain, followed up to `MAX_ANCESTRY` levels, ends at a file that
 *  - has no row (an absent parent),
 *  - has a flagged row (a deleted file's audit record), or
 *  - is not the file the row belongs to (`a.pdf#chunk0` hanging under `b.pdf`: not its own root).
 * It is KEPT when
 *  - its chain is deeper than `MAX_ANCESTRY` (the walk cannot say, and a row that cannot be explained is not deleted),
 *  - it is NEWER than the pass's scan stamp (a re-upload is writing it now: the stamp is in the DELETE's filter, so a row that
 *    arrives between the decision and the delete survives it), or
 *  - its chain ends at a live file (every sidecar and caption row of a live file is a control below).
 * Top-level rows (no parent) are never the repair's: an arrived `_converted/x.md` row is a file of its own.
 *
 * ## What else it holds
 *
 *  - the media jobs' claims are revoked BEFORE the first row is removed (`every-remover-of-file-rows-revokes-claims-first` holds
 *    the call order in source; this holds the effect against a claimed job);
 *  - a second pass changes and counts nothing, and a row leaked AFTER a completed scan waits for the day to pass (the scan wraps no
 *    sooner than daily): the mark is written (mutate the cursor write and "second run does nothing" goes red);
 *  - the cursor lives in the space's CONFIG entry, never in its meta (meta replicates; the cursor is local bookkeeping);
 *  - a re-upload racing a page keeps its new rows (`setRepairStepsForTest({ beforeRemove })`);
 *  - a kept row never blocks a page (`setRepairStepsForTest({ pageSize })`: the cursor passes it);
 *  - the counters and the gauge: `ythril_leaked_rows_removed_total{kind=derived}`, `ythril_leaked_rows_kept_total{reason=...}` and
 *    `ythril_leaked_rows_repair_pending_spaces`, the last POISONED before the pass so a pass that does not write it fails.
 *
 * ## The entry point driven, and why it is a guess
 *
 * The plan puts the repair inside the TTL sweep, so every case runs `sweepExpired(now)` (`_leaked-rows-repair.mjs`). The seam and the
 * metric names are the contract spelled in that module's docblock.
 *
 * Run: node --test testing/standalone/a-row-hanging-off-a-file-this-instance-deleted-is-repaired-db.test.js
 * (requires a prior `npm run build:server`, and the test MongoDB)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { seedClaim } from './_media-claim.mjs';
import {
  NOW, FUTURE, hoursAfter, METRICS, fileRow, derivedRow, runPass, metricValue, repairCounters, repairCountersOrZero, counterDelta, repairSteps, spaceEntry,
  addedKeys, maxAncestry,
} from './_leaked-rows-repair.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'leakrows';
const FLAGGED_AT = '2026-06-02T00:00:00.000Z';

let acts, knownKeys;
const files = () => acts.door.coll(S, 'files');
const ids = async () => (await files().find({}).toArray()).map(r => String(r._id)).sort();
const byId = (rows) => Object.fromEntries(rows.map(r => [String(r._id), r]));

/**
 * The rows of the space, and the verdict on each. A FIXTURE, literal on purpose: the verdict is the product's rule, written here
 * once, and the cases derive their expectations from this table and not from the code under test.
 *
 * `leaked` are removed, `kept` stay. `deepTop` is the id of the chain's first row, which is as deep as the walk cannot follow.
 */
async function seed() {
  const levels = await maxAncestry();
  const rows = [];
  const leaked = [];
  const kept = [];
  const add = (row, verdict) => { rows.push(row); (verdict === 'leaked' ? leaked : kept).push(row._id); };

  // A live file with everything a conversion makes of it, at every level: nothing here may be touched.
  add(fileRow(S, 'live.pdf'), 'kept');
  add(derivedRow(S, 'live.pdf#chunk0', 'live.pdf'), 'kept');
  add(derivedRow(S, '_converted/live.pdf.md', 'live.pdf'), 'kept');
  add(derivedRow(S, '_extracted/live.pdf/img.png', 'live.pdf'), 'kept');
  add(derivedRow(S, '_extracted/live.pdf/img.png#media-chunk0', '_extracted/live.pdf/img.png'), 'kept');
  add(derivedRow(S, '_extracted/live.pdf/img.png#face-chunk0', '_extracted/live.pdf/img.png'), 'kept');
  // A top-level row at a sidecar path (it arrived from a peer): a file of its own, not a derived row.
  add(fileRow(S, '_converted/arrived.pdf.md'), 'kept');

  // The leaked shapes.
  add(derivedRow(S, 'gone.pdf#chunk0', 'gone.pdf', { content: 'OLD' }), 'leaked');                  // an absent parent
  add(derivedRow(S, '_extracted/gone.pdf/img.png', 'gone.pdf'), 'leaked');                          // ... and the rows two levels down
  add(derivedRow(S, '_extracted/gone.pdf/img.png#media-chunk0', '_extracted/gone.pdf/img.png'), 'leaked');
  add(fileRow(S, 'flag.pdf', { deletedAt: FLAGGED_AT }), 'kept');                                   // a flagged parent (its own row stays)
  add(derivedRow(S, 'flag.pdf#chunk0', 'flag.pdf'), 'leaked');
  add(fileRow(S, 'b.pdf'), 'kept');
  add(derivedRow(S, 'b.pdf#chunk0', 'b.pdf'), 'kept');
  add(derivedRow(S, 'a.pdf#chunk0', 'b.pdf'), 'leaked');                                            // `A#chunkN` under `B`: not its own root

  // A chain one level deeper than the walk reads, ending at an absent file: the walk cannot say, so the first row stays.
  const chain = Array.from({ length: levels + 1 }, (_, i) => `_extracted/deep.pdf/level${i}.png`);
  chain.forEach((id, i) => rows.push(derivedRow(S, id, i + 1 < chain.length ? chain[i + 1] : 'deep.pdf')));
  kept.push(chain[0]);
  // The rows BELOW the top of that chain are leaked by the rule like any other: each one's chain does end, within the levels read, at the
  // absent file (the walk reads one level per row, so the second row of the chain has three to go). Only the first is beyond the walk.
  leaked.push(...chain.slice(1));
  // A row newer than the scan stamp, under an absent parent: a re-upload is writing it.
  add(derivedRow(S, 'fresh.pdf#chunk0', 'fresh.pdf', { createdAt: FUTURE }), 'kept');

  await files().insertMany(rows);
  return { rows, leaked, kept, deepTop: chain[0], deepChain: chain };
}

describe('a derived row hanging off a file this instance deleted is repaired (real MongoDB)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'leakrows', space: S });
    knownKeys = Object.keys(await spaceEntry(S));
  });
  after(async () => { (await repairSteps().catch(() => null))?.(null); await acts?.close(); });
  beforeEach(async () => {
    await acts.reset();
    for (const part of ['links', 'media_jobs', 'tombstones']) await acts.door.coll(S, part).deleteMany({});
    // The cursor is config: a previous case's pass must not make this case's first pass a second one.
    const entry = await spaceEntry(S);
    for (const k of addedKeys(entry, knownKeys)) delete entry[k];
  });
  afterEach(async () => { (await repairSteps().catch(() => null))?.(null); });

  it('removes every derived row whose chain ends at an absent file, a flagged file or another file, and nothing else', async () => {
    const { rows, leaked, kept } = await seed();

    await runPass();

    const left = byId(await files().find({}).toArray());
    assert.deepEqual(leaked.filter(id => id in left), [], 'a derived row whose file is gone (absent, flagged or another file) is still stored after the repair pass');
    const seeded = byId(rows);
    for (const id of kept) {
      assert.deepEqual(left[id], seeded[id], `the repair changed or removed ${id}, a row a person can still reach (a live file's row, a flagged parent, a row it cannot explain, a row newer than the scan)`);
    }
  });

  it('keeps a chain deeper than MAX_ANCESTRY and a row newer than the scan stamp, and counts each as kept', async () => {
    const { deepTop } = await seed();
    const before = await repairCountersOrZero();

    await runPass();

    assert.ok(await files().findOne({ _id: deepTop }), `${deepTop}: a chain the walk cannot follow to its end was removed — depth exhausted must mean KEEP`);
    assert.ok(await files().findOne({ _id: 'fresh.pdf#chunk0' }), 'a row newer than the scan stamp was removed');
    const moved = counterDelta(before, await repairCounters());
    assert.ok((moved['kept.depth'] ?? 0) >= 1, `no row was counted kept{reason=depth}: ${JSON.stringify(moved)}`);
    assert.ok((moved['kept.recent'] ?? 0) >= 1, `no row was counted kept{reason=recent}: ${JSON.stringify(moved)}`);
  });

  it('counts exactly the rows it removed as removed{kind=derived}, and no link', async () => {
    const { leaked } = await seed();
    const before = await repairCountersOrZero();

    await runPass();

    const moved = counterDelta(before, await repairCounters());
    assert.equal(moved['removed.derived'], leaked.length, `removed{kind=derived} moved by ${moved['removed.derived']} for ${leaked.length} leaked rows: ${JSON.stringify(moved)}`);
    assert.equal(moved['removed.link'] ?? 0, 0, 'a link was counted removed in a space that holds no link');
  });

  it('a second pass changes nothing and counts nothing', async () => {
    const { leaked } = await seed();
    await runPass();
    const first = await ids();
    assert.ok(leaked.every(id => !first.includes(id)), 'fixture: the first pass did not remove the leaked rows, so a second has nothing to leave alone');
    const before = await repairCountersOrZero();

    await runPass();

    assert.deepEqual(await ids(), first, 'a second pass changed the rows the first had settled');
    assert.deepEqual(counterDelta(before, await repairCounters()), {},
      'a second pass counted what it removed or kept: it scanned again, so the scan\'s completion was not recorded');
  });

  it('a row leaked after a completed scan waits for the next day\'s pass', async () => {
    await seed();
    await runPass();
    await files().insertOne(derivedRow(S, 'late.pdf#chunk0', 'late.pdf'));

    await runPass(hoursAfter(1));
    assert.ok(await files().findOne({ _id: 'late.pdf#chunk0' }), 'a scan that had completed an hour ago ran again: the scan must wrap no sooner than daily');

    await runPass(hoursAfter(25));
    assert.equal(await files().findOne({ _id: 'late.pdf#chunk0' }), null, 'a day later the scan did not run again: a row leaked after the first scan is never repaired');
  });

  it('keeps its cursor in the space\'s config entry and writes nothing to its meta', async () => {
    await seed();
    const entry = await spaceEntry(S);
    const metaBefore = JSON.stringify(entry.meta ?? null);

    await runPass();

    const after = await spaceEntry(S);
    assert.ok(addedKeys(after, knownKeys).length >= 1,
      `the pass wrote nothing to the space's config entry (keys now ${Object.keys(after)}): where is the scan's cursor kept?`);
    assert.equal(JSON.stringify(after.meta ?? null), metaBefore,
      'the pass changed the space\'s META, which replicates: the cursor is local bookkeeping, and belongs on the config entry');
  });

  it('revokes the claims of the jobs of a leaked row\'s file BEFORE it removes the first row', async () => {
    await seed();
    const claim = await seedClaim(S, 'gone.pdf', { mediaType: 'text', mimeType: 'application/pdf' });
    const proto = Object.getPrototypeOf(acts.door.mongo.col('probe'));
    const originals = { deleteMany: proto.deleteMany, bulkWrite: proto.bulkWrite, findOne: proto.findOne };
    let claimAtFirstRemoval;
    const sawJob = async () => {
      if (claimAtFirstRemoval !== undefined) return;
      const job = await originals.findOne.call(acts.door.mongo.col(`${S}_media_jobs`), { _id: 'gone.pdf' });
      claimAtFirstRemoval = job?.claimToken === claim.claimToken ? 'still claimed' : 'revoked';
    };
    for (const op of ['deleteMany', 'bulkWrite']) {
      proto[op] = async function observed(...args) {
        if (this.collectionName === `${S}_files`) await sawJob();
        return originals[op].apply(this, args);
      };
    }
    try { await runPass(); } finally { for (const op of ['deleteMany', 'bulkWrite']) proto[op] = originals[op]; }

    assert.notEqual(claimAtFirstRemoval, undefined, 'fixture: the pass removed no file row, so there was no first removal to look before');
    assert.equal(claimAtFirstRemoval, 'revoked', 'the first leaked row was removed while the claim of its file\'s job was still held: a run that read its parent live writes after the children went');
  });

  it('a re-upload racing a page keeps its new rows (the stamp is in the delete\'s filter)', async () => {
    await seed();
    const seen = [];
    const set = await repairSteps();
    set({
      beforeRemove: async ({ spaceId, ids: page }) => {
        seen.push(...page);
        // The file is uploaded again between the page's decision and its delete: its parent row exists and its chunk is rewritten NOW.
        if (!page.includes('gone.pdf#chunk0') || await files().findOne({ _id: 'gone.pdf' })) return;
        assert.equal(spaceId, S);
        await files().insertOne(fileRow(S, 'gone.pdf', { createdAt: FUTURE }));
        await files().replaceOne({ _id: 'gone.pdf#chunk0' }, derivedRow(S, 'gone.pdf#chunk0', 'gone.pdf', { createdAt: FUTURE, content: 'NEW' }));
      },
    });

    await runPass();

    assert.ok(seen.includes('gone.pdf#chunk0'), `fixture: the seam never saw the row it re-uploads (${JSON.stringify(seen)}): it ran after the delete, or not at all`);
    assert.equal((await files().findOne({ _id: 'gone.pdf#chunk0' }))?.content, 'NEW',
      'the repair deleted a chunk a re-upload had just written, because it decided on the row it read before the re-upload');
    assert.ok(await files().findOne({ _id: 'gone.pdf' }), 'the re-uploaded file\'s own row was removed');
    assert.equal(await files().findOne({ _id: 'flag.pdf#chunk0' }), null, 'the race kept a row it did not touch');
  });

  it('a kept row never blocks a page: with a page of two and six kept rows ahead of it, a leaked row is still reached', async () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => derivedRow(S, `0kept${i}.pdf#chunk0`, `0kept${i}.pdf`, { createdAt: FUTURE })),
      derivedRow(S, 'zleak.pdf#chunk0', 'zleak.pdf'),
    ];
    await files().insertMany(rows);
    (await repairSteps())({ pageSize: 2 });

    // A scan is budgeted per tick: it may take several passes to reach the end, never more than one per page.
    for (let pass = 0; pass < rows.length && await files().findOne({ _id: 'zleak.pdf#chunk0' }); pass++) await runPass();

    assert.equal(await files().findOne({ _id: 'zleak.pdf#chunk0' }), null, 'the scan stopped at the kept rows: a page of rows it will not remove held the cursor back');
    assert.equal(await files().countDocuments({ _id: /^0kept/ }), 6, 'a row newer than the scan was removed on its way past');
  });

  it('PIN: the embed path still reads at most one row per level of a chain (the walk it shares with the repair costs it no extra read)', async () => {
    await files().insertMany([
      fileRow(S, 'pin.pdf'),
      derivedRow(S, '_extracted/pin.pdf/img.png', 'pin.pdf'),
      derivedRow(S, '_extracted/pin.pdf/img.png#media-chunk0', '_extracted/pin.pdf/img.png'),
    ]);
    const { fileEmbeddingSuppressed } = await import('../../server/dist/brain/suppress-embeddings.js');
    const entry = await spaceEntry(S);
    const was = entry.meta.suppressEmbeddings;
    entry.meta.suppressEmbeddings = false;   // the space's own setting short-circuits the question before any row is read
    const proto = Object.getPrototypeOf(acts.door.mongo.col('probe'));
    // `findOne` is a `find` underneath, so counting both would count each read twice.
    const originals = Object.fromEntries(['find', 'aggregate'].map(n => [n, proto[n]]));
    let reads = 0;
    for (const n of Object.keys(originals)) {
      proto[n] = function counted(...args) { if (this.collectionName === `${S}_files`) reads++; return originals[n].apply(this, args); };
    }
    let suppressed;
    try { suppressed = await fileEmbeddingSuppressed(S, { _id: '_extracted/pin.pdf/img.png#media-chunk0', parentFileId: '_extracted/pin.pdf/img.png' }); }
    finally { for (const n of Object.keys(originals)) proto[n] = originals[n]; entry.meta.suppressEmbeddings = was; }

    assert.equal(suppressed, false, 'a row whose chain ends at a live, unsuppressed file was read as suppressed');
    assert.ok(reads >= 1 && reads <= 2, `the chain of two ancestors took ${reads} reads of the files collection: the embed path pays one per level at most`);
  });

  it('publishes how many spaces still owe a scan, and writes it every pass (the gauge is poisoned first)', async () => {
    await seed();
    const { register } = await import('../../server/dist/metrics/registry.js');
    const gauge = register.getSingleMetric(METRICS.pending);
    assert.ok(gauge, `metrics/registry.ts declares no \`${METRICS.pending}\``);
    gauge.set(-7);

    await runPass();

    assert.equal(await metricValue(METRICS.pending), 0, 'after a pass that finished the scan of the only space, the gauge was not written (it still reads the poison) or did not say 0');
  });
});
