/**
 * A stamping write whose fingerprint has no known snapshot row keeps that snapshot (the per-write backstop of `stampOp`), in a process that loaded only
 * the stamp module, and a burst of such writes sends ONE upsert (bundle-265 lens sweep A1, P3).
 *
 * ## A1: no hook installed by an import
 *
 * The backstop was a module-level hook the snapshot writer (`spaces/schema-snapshot-store.ts`) installed as a side effect of being imported, called with
 * `?.`: a process that had not loaded the writer stamped records and kept no snapshot, silently. The stamp module now imports the writer itself when a
 * stamp first needs it (a static import back would be a runtime cycle), so nothing has to be installed and nothing can be forgotten. This file imports
 * `schema-stamp.js` and the config loader, never the writer.
 *
 * ## P3: one upsert per fingerprint in flight
 *
 * Until the first upsert of a new fingerprint lands and notes it held, every stamping write of it scheduled another identical upsert. `keepSnapshot`
 * now runs one per (space, fingerprint) at a time.
 *
 * ## Seen red
 *
 * At c244852b the burst below sends one upsert per stamping write (20), and, if the writer is not otherwise loaded, none at all and no row.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-stamping-write-keeps-its-snapshot-once-without-a-hook-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mongoSkipReason, openTestMongo, closeTestMongo } from './_mongo-harness.mjs';
import { waitFor, holdsWithin } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-stamp-backstop-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = tmpDir;

const SPACE = 'stampbackstop';
const BURST = 20;

let mongo;
const rows = () => mongo.col(`${SPACE}_schema_snapshots`);

describe('a stamping write keeps its snapshot, once, with no hook to install', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('stampbackstop', { query: '&monitorCommands=true' });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'stamp-backstop-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: SPACE, folders: [], meta: { typeSchemas: { entity: { backstop: { propertySchemas: { note: { type: 'string' } } } } } } }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it(`${BURST} stamping writes of a new fingerprint keep its row with one upsert`, async () => {
    const upserts = [];
    const listen = (ev) => { if (ev.commandName === 'update' && ev.command?.update === `${SPACE}_schema_snapshots`) upserts.push(ev.requestId); };
    const client = mongo.getMongo();
    client.on('commandStarted', listen);
    try {
      const stamp = await import('../../server/dist/spaces/schema-stamp.js');
      let fp;
      for (let i = 0; i < BURST; i++) {
        const write = stamp.readMetaForWrite(SPACE);
        fp = write.stamp.fp;
        assert.notEqual(fp, stamp.EMPTY_SCHEMA_FINGERPRINT, 'the space has a schema, so its stamp is not the empty one');
        const op = stamp.stampOp(write, { all: [] });
        assert.equal(op.$set?.schemaFingerprint, fp, 'a conforming write is stamped');
      }
      await waitFor(async () => (await rows().findOne({ _id: fp })) !== null, 15_000, 100,
        () => 'no snapshot row appeared: the stamping writes kept nothing (the backstop is a hook nobody installed in this process)');
      // A late duplicate would arrive after the row: give the detached writes a second to show themselves.
      const duplicated = await holdsWithin(() => upserts.length > 1, 1_000, 100);
      assert.equal(duplicated || upserts.length !== 1, false, `${upserts.length} upserts for one fingerprint: each stamping write scheduled its own until the first landed`);
    } finally { client.off('commandStarted', listen); }
  });
});
