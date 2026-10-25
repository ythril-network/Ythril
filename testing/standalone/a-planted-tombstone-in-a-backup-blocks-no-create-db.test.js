/**
 * A backup holding a planted tombstone restores it unmarked, below the cap, blocking nothing (bundle-81 test 7, the restore act; decision 53; design rev 8 section 1a
 * "Why the plant is now harmless", section 6e).
 *
 * ## What the other file cannot hold
 *
 * `a-planted-tombstone-blocks-no-create-db` drives every door that APPLIES a tombstone (`applyPeerTombstones`). The restore act is not one: it loads the collections of a
 * backup raw, so a tombstone a peer planted at `MAX_INGEST_SEQ` on a guessable id (`edgeIdFor`) and that this instance stored before it was backed up comes back as it was.
 * The three things a plant must not do hold across a restore as they do across a push:
 *
 *  - **It is never marked issued here** (`issuedHere` is a local mark the local tombstone writer stamps; the backup of a peer's row carries none, and the restore adds none), so
 *    it is not pushed on a mesh as this instance's own.
 *  - **It never lifts the counter above `VERSION_FLOOR_CAP`**: the restore raises the counter to the highest version stored AT OR BELOW the cap (`raiseVersionTo` clamps), and a row
 *    at the ceiling is not a candidate.
 *  - **It blocks no create**: a create of that edge afterwards is written, stamped at most `VERSION_FLOOR_CAP + 1`, and does not move V above the cap.
 *
 * A planted row with a blank issuer cannot be REFUSED here (the backup is this instance's own data, which a build that did not refuse them may have stored it in): it is stored like
 * the others and is harmless for the same three reasons. One restore covers every issuer spelling, each in a space of its own.
 *
 * Database `b81tC_plantedbackup`, dropped on entry and exit. Run: node --test testing/standalone/a-planted-tombstone-in-a-backup-blocks-no-create-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mongoSkipReason, testMongoUri } from './_mongo-harness.mjs';
import { openB81cDoor } from './_b81c-door.mjs';
import { build } from './_push-door.mjs';
import { restoreModules, restoreToTheEnd } from './_restore-act.mjs';

const skip = await mongoSkipReason();
const seq = await import('../../server/dist/util/seq.js');
const { edgeIdFor } = await import('../../server/dist/brain/edge-id.js');
const CEILING = seq.MAX_INGEST_SEQ;
const CAP = seq.MAX_INGEST_SEQ - seq.SEQ_CEILING_RESERVE;
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const END1 = U(1); const END2 = U(2);
const SELF = 'b81c-plantedbackup';
const EDGE_ID = edgeIdFor(END1, END2, 'knows');
const ISSUERS = [
  { name: 'absent', value: undefined },
  { name: "''", value: '' },
  { name: "' '", value: ' ' },
  { name: 'an unrelated instance', value: 'planting-peer' },
  { name: 'this instance', value: SELF },
];
const SPACES = ISSUERS.map((_, i) => `r-backup-${i}`);

describe('a backup holding a planted tombstone blocks no create', { skip }, () => {
  let door; let edges; let mods;
  before(async () => {
    door = await openB81cDoor({ name: 'plantedbackup', spaces: SPACES, instanceId: SELF });
    edges = await import('../../server/dist/brain/edges.js');
    mods = await restoreModules();
    for (const [i, issuer] of ISSUERS.entries()) {
      const space = SPACES[i];
      await door.coll(space, 'entities').insertMany([
        build.entity(space, END1, 1, { author: { instanceId: SELF, instanceLabel: 'Self' } }),
        build.entity(space, END2, 1, { author: { instanceId: SELF, instanceLabel: 'Self' } }),
      ]);
      await door.coll(space, 'tombstones').insertOne({
        _id: EDGE_ID, type: 'edge', spaceId: space, deletedAt: '2026-09-01T00:00:00.000Z', seq: CEILING,
        ...(issuer.value === undefined ? {} : { instanceId: issuer.value }),
      });
    }
    // One backup of the whole database, then the tombstones are lost, then ONE restore brings every space back from it.
    const id = `b81c-planted-backup-${Date.now()}`;
    await mods.dump.dumpDatabase(testMongoUri('b81tC_plantedbackup'), path.join(mods.loader.getDataRoot(), 'backups', id));
    for (const space of SPACES) await door.coll(space, 'tombstones').deleteMany({});
    await restoreToTheEnd(mods, { backupId: id });
  });
  after(async () => { await door?.close(); });

  for (const [i, issuer] of ISSUERS.entries()) {
    it(`issuer ${issuer.name}: restored unmarked, V at or below the cap, and a create of the edge is written at most one above it`, async () => {
      const space = SPACES[i];
      const row = await door.coll(space, 'tombstones').findOne({ _id: EDGE_ID });
      assert.ok(row, 'the restore did not bring the planted tombstone back, so there is nothing to check');
      assert.notEqual(row.issuedHere, true, 'a restored planted tombstone is marked issued here');
      assert.ok(await door.counter(space) <= CAP, `the restore left the counter at ${await door.counter(space)}, above VERSION_FLOOR_CAP (${CAP})`);
      await edges.upsertEdge(space, END1, END2, 'knows');
      const created = await door.coll(space, 'edges').findOne({ _id: EDGE_ID });
      assert.ok(created, 'the create of the planted id was not written after the restore');
      assert.ok(created.seq <= CAP + 1, `the create was stamped ${created.seq}, above VERSION_FLOOR_CAP + 1 (${CAP + 1})`);
      assert.ok(await door.counter(space) <= CAP, 'the create moved V above VERSION_FLOOR_CAP');
    });
  }
});
