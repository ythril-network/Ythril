/**
 * The leaked-rows repair, held to what the pre-ship sweep found (bundle-113: DI-1, DI-2, REP-1, REP-2, REP-3, O3, O4, O5, and the privacy
 * finding on the space answer).
 *
 * ## What is held, one case each
 *
 *  - **DI-1: a derived link source is asked about its FILE.** `a.jpg#face-chunk0` has no tombstone of its own (the delete wrote one for
 *    `a.jpg`), so asked as itself it read "no tombstone" and its links stayed for ever. A file whose own name holds a `#` and has a live
 *    row is a file of its own and keeps its links.
 *  - **DI-2: the job at the gone file's path is not cancelled.** A file uploaded there since has a job of its own queued; the repair cancels
 *    the jobs of the rows it removes and of the derived rows above them, nothing at the path of the file that is gone.
 *  - **REP-2: one batched cancel for a page**, never a command per row.
 *  - **REP-1: the derived-row page reads the next rows by `_id` of ANY kind and advances to the last row READ**, so a long run of rows with
 *    no parent cannot hold the scan on one page or, on a timeout, never advance.
 *  - **REP-3: the cursor is written down** (through `changeSpaceEntries`, coalesced): the config on disk holds it after a flush.
 *  - **O3: the pending-spaces gauge is written when the sweep starts and however a pass ends**, never a false 0 before the first pass.
 *  - **O4: a pass that removed anything writes ONE audit entry** (`file.leaked_rows.repair`, the space, no token); a pass that removed
 *    nothing writes none.
 *  - **O5: a final page with a path whose bytes could not be looked at does not complete the scan.**
 *  - **P1 (privacy): the cursor is not answered.** `leakedRowScan` carries the last file path the link phase read; the space routes
 *    shape their answer through `spaceForWire`, which removes it and leaves the live entry alone.
 *
 * Run: node --test testing/standalone/the-leaked-rows-repair-reads-and-reports-what-it-did-db.test.js
 * (requires a prior `npm run build:server`, and the test MongoDB)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { seedClaim, jobOf } from './_media-claim.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { sleep } from '../_shared/sleep.mjs';
import { NOW, METRICS, fileRow, derivedRow, runPass, metricValue, repairSteps, spaceEntry, addedKeys, fileTombstoneRow, repairCountersOrZero, repairCounters, counterDelta } from './_leaked-rows-repair.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'leakreport';

let acts, SELF, knownKeys, loader;
const files = () => acts.door.coll(S, 'files');
const links = () => acts.door.coll(S, 'links');
const auditRows = () => acts.door.mongo.getDb().collection('audit_log').find({ spaceId: S, operation: 'file.leaked_rows.repair' }).toArray();

describe('the leaked-rows repair reads and reports what it did (real MongoDB)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'leakreport', space: S });
    SELF = (await import('../../server/dist/config/author.js')).authorRef().instanceId;
    loader = await import('../../server/dist/config/loader.js');
    knownKeys = Object.keys(await spaceEntry(S));
  });
  after(async () => { (await repairSteps().catch(() => null))?.(null); await acts?.close(); });
  beforeEach(async () => {
    await acts.reset();
    for (const part of ['links', 'media_jobs', 'tombstones']) await acts.door.coll(S, part).deleteMany({});
    await acts.door.mongo.getDb().collection('audit_log').deleteMany({ spaceId: S }).catch(() => {});
    const entry = await spaceEntry(S);
    for (const k of addedKeys(entry, knownKeys)) delete entry[k];
  });
  afterEach(async () => { (await repairSteps().catch(() => null))?.(null); });

  it('DI-1: the links of a derived source (face and media chunks) go with the file this instance deleted; a file named with a # and a live row keeps its own', async () => {
    await acts.door.coll(S, 'file_tombstones').insertOne(fileTombstoneRow(S, 'a.jpg', { issuer: SELF }));
    await files().insertOne(fileRow(S, 'x#y.txt'));                    // a live file whose own name holds a #: not a derived row of x
    await acts.door.coll(S, 'file_tombstones').insertOne(fileTombstoneRow(S, 'x', { issuer: SELF }));
    const gone = [await acts.links.put('a.jpg', 'e1'), await acts.links.put('a.jpg#face-chunk0', 'e1'), await acts.links.put('a.jpg#media-chunk0', 'e2')];
    const kept = [await acts.links.put('x#y.txt', 'e1'), await acts.links.put('live.jpg#face-chunk0', 'e1')];
    await files().insertOne(fileRow(S, 'live.jpg'));
    await acts.door.coll(S, 'file_tombstones').insertOne(fileTombstoneRow(S, 'live.jpg', { issuer: SELF }));   // a tombstone, and the file is back

    await runPass();

    const left = new Set(await acts.links.ids());
    assert.deepEqual(gone.filter(id => left.has(id)), [], 'a link whose source is a derived id of a file this instance deleted was kept: it has no tombstone of its own, and was asked as itself');
    assert.deepEqual(kept.filter(id => !left.has(id)), [], 'a link of a file that stands (a name with a # of its own, a re-uploaded file\'s derived id) was removed');
    assert.ok(addedKeys(await spaceEntry(S), knownKeys).length >= 1, 'fixture: the scan left no cursor');
  });

  it('DI-2: the repair cancels the jobs of the rows it removes and never the job queued at the gone file\'s own path (a re-upload\'s)', async () => {
    await files().insertMany([derivedRow(S, 'gone.pdf#chunk0', 'gone.pdf'), derivedRow(S, '_extracted/gone.pdf/img.png', 'gone.pdf')]);
    const reupload = await seedClaim(S, 'gone.pdf', { mediaType: 'text', mimeType: 'application/pdf', status: 'pending', claimToken: null });
    const ofLeaked = await seedClaim(S, '_extracted/gone.pdf/img.png', { mediaType: 'image', mimeType: 'image/png' });

    await runPass();

    assert.equal(await files().findOne({ _id: 'gone.pdf#chunk0' }), null, 'fixture: the leaked row stayed');
    assert.equal(await jobOf(S, ofLeaked.jobId), null, 'the job of a leaked row (an extracted image\'s) was not cancelled');
    assert.ok(await jobOf(S, reupload.jobId), 'the job queued at the gone file\'s own path was cancelled: a file uploaded there since loses its queued job');
  });

  it('REP-2: a page\'s jobs are cancelled in one batched command, not one per row', async () => {
    const N = 30;
    await files().insertMany(Array.from({ length: N }, (_, i) => derivedRow(S, `many${i}.pdf#chunk0`, `many${i}.pdf`)));
    for (let i = 0; i < N; i++) await seedClaim(S, `many${i}.pdf#chunk0`, { mediaType: 'text', mimeType: 'text/plain' });
    const proto = Object.getPrototypeOf(acts.door.mongo.col('probe'));
    const originals = { deleteOne: proto.deleteOne, deleteMany: proto.deleteMany };
    const issued = { deleteOne: 0, deleteMany: 0 };
    for (const op of Object.keys(originals)) {
      proto[op] = function counted(...args) { if (this.collectionName === `${S}_media_jobs`) issued[op]++; return originals[op].apply(this, args); };
    }
    try { await runPass(); } finally { for (const op of Object.keys(originals)) proto[op] = originals[op]; }

    assert.equal(await files().countDocuments({}), 0, 'fixture: the leaked rows stayed');
    assert.equal(await acts.door.coll(S, 'media_jobs').countDocuments({}), 0, 'a job of a leaked row was left');
    assert.deepEqual(issued, { deleteOne: 0, deleteMany: 1 }, `${N} jobs were cancelled by ${JSON.stringify(issued)}: one command per row, not one batched cancel for the page`);
  });

  it('REP-1: a page reads the next rows by _id of any kind and advances to the last row READ, though none of them is derived', async () => {
    const lead = Array.from({ length: 6 }, (_, i) => fileRow(S, `a${i}.txt`));
    await files().insertMany([...lead, derivedRow(S, 'zleak.pdf#chunk0', 'zleak.pdf')]);
    (await repairSteps())({ pageSize: 2, pagesPerTick: 1 });

    await runPass();

    const state = (await spaceEntry(S)).leakedRowScan;
    assert.deepEqual(state, { phase: 'rows', after: 'a1.txt' },
      `after one page of two rows (none derived) the cursor is ${JSON.stringify(state)}: a page is the next rows by _id, and the cursor passes the last one READ`);
    assert.ok(await files().findOne({ _id: 'zleak.pdf#chunk0' }), 'the leaked row was reached in the first page: the page was a query for derived rows, which a long gap of other rows can stall');
    for (let pass = 0; pass < 8 && await files().findOne({ _id: 'zleak.pdf#chunk0' }); pass++) await runPass();
    assert.equal(await files().findOne({ _id: 'zleak.pdf#chunk0' }), null, 'the scan never reached the leaked row one page at a time');
  });

  it('REP-3: the cursor is written down: the config on disk holds it after a flush', async () => {
    await files().insertOne(derivedRow(S, 'gone.pdf#chunk0', 'gone.pdf'));
    (await repairSteps())({ pageSize: 1, pagesPerTick: 1 });

    await runPass();
    await loader.flushConfig();

    const onDisk = JSON.parse(fs.readFileSync(process.env['CONFIG_PATH'], 'utf8')).spaces.find(s => s.id === S);
    assert.ok(onDisk?.leakedRowScan?.phase, `the cursor is not in the config file after a pass and a flush: ${JSON.stringify(onDisk?.leakedRowScan)}`);
  });

  it('O3: the gauge is written when the sweep starts (never a false 0), and when a pass fails before the repair', async () => {
    const { register } = await import('../../server/dist/metrics/registry.js');
    const gauge = register.getSingleMetric(METRICS.pending);
    const ttl = await import('../../server/dist/brain/ttl-sweep.js');
    const entry = await spaceEntry(S);
    delete entry.leakedRowScan;       // this space owes a scan
    gauge.set(-7);
    try { ttl.startTtlSweep(); } finally { ttl.stopTtlSweep(); }
    const atStart = await metricValue(METRICS.pending);
    assert.ok(atStart >= 1, `the gauge reads ${atStart} after the sweep started with a space that owes a scan: it was not written from the config`);

    // A pass that throws before it reaches the repair still writes the gauge: the config's space list fails to read once.
    gauge.set(-7);
    const cfg = loader.getConfig();
    const real = cfg.spaces;
    let armed = true;
    Object.defineProperty(cfg, 'spaces', { configurable: true, enumerable: true, get() { if (armed) { armed = false; throw new Error('the config could not be read'); } return real; } });
    try {
      await assert.rejects(() => runPass(), /the config could not be read/);
    } finally { Object.defineProperty(cfg, 'spaces', { configurable: true, enumerable: true, writable: true, value: real }); }
    assert.ok(await metricValue(METRICS.pending) >= 1, 'a pass that failed before the repair left the gauge at its last value');
  });

  it('O4: a pass that removed rows writes one audit entry for the space, and a pass that removed nothing writes none', async () => {
    await runPass();     // nothing to remove
    await sleep(300);   // an absence: the audit write is not awaited by the pass, so its window has to elapse in full
    assert.deepEqual(await auditRows(), [], 'a pass that removed nothing was audited');

    await files().insertMany([derivedRow(S, 'gone.pdf#chunk0', 'gone.pdf'), derivedRow(S, 'gone2.pdf#chunk0', 'gone2.pdf')]);
    const entry = await spaceEntry(S);
    for (const k of addedKeys(entry, knownKeys)) delete entry[k];
    await runPass();

    await waitFor(async () => (await auditRows()).length >= 1, 5000, 50, 'no audit entry', { what: 'the repair\'s audit entry' }).catch(() => {});
    const audit = await auditRows();
    assert.equal(audit.length, 1, `a pass that removed rows wrote ${audit.length} audit entries (one per space per pass): ${JSON.stringify(audit)}`);
    assert.equal(audit[0].operation, 'file.leaked_rows.repair');
    assert.ok(!audit[0].tokenId, 'the entry names a token: the instance did this work, no request asked');
  });

  it('O5: a final page with a link source whose bytes cannot be looked at does not complete the scan', async () => {
    // A path out of the space cannot be looked at (the sandbox refuses it), whatever the tombstone says.
    await acts.door.coll(S, 'file_tombstones').insertOne(fileTombstoneRow(S, '../outside.txt', { issuer: SELF }));
    await acts.links.put('../outside.txt', 'e1');
    const before = await repairCountersOrZero();

    await runPass();

    const state = (await spaceEntry(S)).leakedRowScan;
    assert.equal(state?.completedAt, undefined, `the scan was recorded complete (${JSON.stringify(state)}) though a path of its last page could not be looked at`);
    assert.equal(state?.phase, 'links', 'the scan left its links phase');
    assert.equal((await acts.links.idsFrom('../outside.txt')).length, 1, 'a link whose path could not be looked at was removed: it is kept and named');
    assert.equal(counterDelta(before, await repairCounters())['removed.link'] ?? 0, 0);

    await runPass();     // the next tick reads the empty end and completes: nothing was left unseen
    assert.ok((await spaceEntry(S)).leakedRowScan?.completedAt, 'the scan never completed after the pass that could not look at a path');
  });

  it('P1: the space routes answer a space without its scan cursor, and the live entry keeps it', async () => {
    const { spacesRouter } = await import('../../server/dist/api/spaces.js');
    const entry = await spaceEntry(S);
    entry.leakedRowScan = { phase: 'links', after: 'a/private/path.txt' };
    const layer = spacesRouter.stack.find(l => l.route?.path === '/:id/schema' && l.route.methods['put']);
    assert.ok(layer, 'no PUT /:id/schema on the spaces router — re-anchor');
    const res = { code: 200, body: undefined, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
    await layer.route.stack.at(-1).handle({ method: 'PUT', params: { id: S }, query: {}, body: { typeSchemas: {} }, headers: {}, get: () => undefined,
      authToken: { id: 't', name: 'test', rights: { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: null } } }, res);

    assert.equal(res.code, 200, `the schema replacement was refused: ${JSON.stringify(res.body)}`);
    assert.ok(res.body?.space?.id === S, `no space in the answer: ${JSON.stringify(res.body)}`);
    assert.equal(JSON.stringify(res.body).includes('private/path.txt'), false, 'the answer carries the file path of the scan cursor');
    assert.equal('leakedRowScan' in res.body.space, false, 'the answer carries leakedRowScan');
    assert.deepEqual(entry.leakedRowScan, { phase: 'links', after: 'a/private/path.txt' }, 'shaping the answer changed the live entry');
  });
});
