/**
 * A restore and an import restart the leaked-rows scan of the space they replaced (bundle-113, Q-465; vet T-S13, reliability S8,
 * integration S7).
 *
 * ## The defect it prevents
 *
 * The repair scans a space's derived rows by `_id` and wraps no sooner than a day; where it has got to, and when it last finished, is
 * kept in the space's config entry (local: not replicated, not exported, not restored). A restore DROPS every collection and loads
 * the backup's, and an import writes records the export carried, so a scan that had finished before either would sit out its day over
 * rows it never read — the backup's, which can hold exactly the leaks the repair exists for. So each resets the space's cursor BEFORE
 * it answers, and does not run the scan inline (the next sweep does, at the ordinary pace).
 *
 * ## The rule, held for both doors by one table
 *
 *  1. a scan that completed is NOT run again within the day (the control: the door under test is what changes that);
 *  2. after the door answered, what the pass had added to the space's config entry is not what it was (the cursor was reset);
 *  3. the very next sweep, an hour after the completed scan, removes a leaked row the scan had never read — and the door itself
 *     removed nothing (no inline run: the row is still there when it answers).
 *
 * The restore is driven through the data router's own `POST /restore` handler on a dump of the harness database made by the server's
 * own `dumpDatabase`; the import through `importDocuments`, the function behind the admin import route.
 *
 * Run: node --test testing/standalone/a-restore-and-an-import-restart-the-leaked-row-scan-db.test.js
 * (requires a prior `npm run build:server`, and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason, testMongoUri } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { runPass, hoursAfter, derivedRow, spaceEntry, addedKeys } from './_leaked-rows-repair.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'restartscan';
const SUITE = 'restartscan';

let acts, knownKeys, dumpMod, importMod, dataRouter, seq = 0;
const files = () => acts.door.coll(S, 'files');
const cursorOf = async () => {
  const entry = await spaceEntry(S);
  return JSON.stringify(Object.fromEntries(addedKeys(entry, knownKeys).map(k => [k, entry[k]])));
};

/** `POST /api/admin/data/restore` through the router's own handler, as an admin past the middleware. */
async function restore(backupId) {
  const layer = dataRouter.stack.find(l => l.route?.path === '/restore' && l.route.methods['post']);
  assert.ok(layer, 'no POST /restore on the data router — re-anchor this test');
  const req = { method: 'POST', params: {}, query: {}, body: { backupId }, headers: {}, ip: '127.0.0.1', authToken: { name: 'test' }, get: () => undefined };
  const res = { code: 200, body: undefined, headers: {}, headersSent: false,
    status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; } };
  await layer.route.stack.at(-1).handle(req, res);
  assert.equal(res.code, 200, `the restore was refused or failed: ${JSON.stringify(res.body)}`);
}

/** Every door that replaces a space's records: how it is driven, after the leaked row it will find is already stored. */
const DOORS = {
  restore: async () => {
    const { getDataRoot } = await import('../../server/dist/config/loader.js');
    const id = `backup-${Date.now()}`;
    const dir = path.join(getDataRoot(), 'backups', id);
    await dumpMod.dumpDatabase(testMongoUri(`ythril_harness_${SUITE}`), dir);
    await restore(id);
  },
  import: async () => {
    const author = { instanceId: 'origin', instanceLabel: 'Origin' };
    const out = await importMod.importDocuments(S, { facts: [{
      _id: 'imported-fact', spaceId: 'elsewhere', fact: 'a fact the export carried', tags: [], author,
      createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z', seq: 3,
    }] });
    assert.equal(out.results.facts.errors, 0, `the import refused its own fixture: ${JSON.stringify(out.results.facts)}`);
  },
};

describe('a restore and an import restart the leaked-rows scan (real MongoDB)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: SUITE, space: S });
    knownKeys = Object.keys(await spaceEntry(S));
    dumpMod = await import('../../server/dist/db/dump.js');
    importMod = await import('../../server/dist/api/admin-import.js');
    ({ dataRouter } = await import('../../server/dist/api/data.js'));
  });
  after(async () => { await acts?.close(); });
  beforeEach(async () => {
    await acts.reset();
    const entry = await spaceEntry(S);
    for (const k of addedKeys(entry, knownKeys)) delete entry[k];
  });

  for (const [door, drive] of Object.entries(DOORS)) {
    it(`${door}: the scan that had completed starts again, and the next sweep reaches rows it had never read`, async () => {
      seq++;
      const early = `early${seq}.pdf#chunk0`;
      const late = `late${seq}.pdf#chunk0`;
      await files().insertOne(derivedRow(S, early, `early${seq}.pdf`));
      await runPass();
      assert.equal(await files().findOne({ _id: early }), null, 'fixture: the first pass did not remove the leaked row, so there is no completed scan to restart');
      const completed = await cursorOf();
      assert.notEqual(completed, '{}', 'fixture: the completed scan left nothing on the space\'s config entry');

      // A row the completed scan never read, stored before the door replaces the space (a restore loads the backup's rows, which can hold it).
      await files().insertOne(derivedRow(S, late, `late${seq}.pdf`));
      await runPass(hoursAfter(1));
      assert.ok(await files().findOne({ _id: late }), 'control: a completed scan ran again within the day, so the door under test changes nothing');

      await drive();

      assert.notEqual(await cursorOf(), completed, `the ${door} answered with the scan's cursor as the completed scan left it: the next sweep would sit out the day over rows it never read`);
      assert.ok(await files().findOne({ _id: late }), `the ${door} ran the scan itself: the leaked row is gone before the next sweep`);
      await runPass(hoursAfter(2));
      assert.equal(await files().findOne({ _id: late }), null, `after the ${door}, the next sweep did not scan again: a leaked row the backup or the export carried waits out the day`);
    });
  }
});
