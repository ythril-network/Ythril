/**
 * A backup never carries a read spill, and a restore never touches the live ones.
 *
 * ## Why (Q-92, design point 5)
 *
 * A read spill is a copy of a caller's search result, owned by that caller's token for up to a day. It is local
 * on EVERY transport, and a backup is a transport: `db/dump.ts` walks every collection in the database, so
 * without an exclusion a spill would land in every scheduled backup and every offsite copy — search results
 * nobody asked to keep, kept for as long as the backups are.
 *
 * The restore half is the one that bites silently. `db/restore.ts` DROPS every collection its dump names and
 * re-inserts the documents, and a dropped collection loses its indexes. A dump that named `_read_spills` would
 * therefore take the TTL index with it on restore, and every spill written after that would live for ever.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/a-backup-never-carries-a-read-spill-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason, testMongoUri } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const SUITE = 'spilldump';
const HEADERS = '_read_spills';
const PAGES = '_read_spill_pages';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-spill-dump-'));

let mongo, dumpMod, restoreMod;

describe('a backup never carries a read spill', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo(SUITE);
    dumpMod = await import('../../server/dist/db/dump.js');
    restoreMod = await import('../../server/dist/db/restore.js');

    const expiresAt = new Date(Date.now() + 86_400_000);
    await mongo.col(HEADERS).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await mongo.col(PAGES).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await mongo.col(HEADERS).insertOne({
      _id: 'spill-1', kind: 'results', issuedTo: 'tok', memberSpaceIds: ['general'], items: 1, rawBytes: 10,
      createdAt: new Date(), expiresAt,
    });
    await mongo.col(PAGES).insertOne({ spillId: 'spill-1', index: 0, count: 1, body: Buffer.from('x'), rawBytes: 10, expiresAt });
    // Neighbours that MUST be in a backup, so an exclusion that dropped everything cannot pass.
    await mongo.col('general_facts').insertOne({ _id: 'f1', spaceId: 'general', fact: 'kept', tags: [], seq: 1 });
    await mongo.col('_audit').insertOne({ _id: 'a1', operation: 'recall', timestamp: new Date().toISOString() });
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('the dump names neither spill collection and writes no file for either', async () => {
    const dest = path.join(tmpDir, 'dump');
    const manifest = await dumpMod.dumpDatabase(testMongoUri(`ythril_harness_${SUITE}`), dest);
    const names = manifest.collections.map(c => c.name);

    assert.ok(names.includes('general_facts') && names.includes('_audit'),
      `the dump must still carry the space and the instance collections: ${names.join(', ')}`);
    for (const spill of [HEADERS, PAGES]) {
      assert.ok(!names.includes(spill), `the backup carries \`${spill}\` — a caller's search result, kept as long as the backup`);
      assert.ok(!fs.existsSync(path.join(dest, `${spill}.ndjson`)), `\`${spill}.ndjson\` was written`);
    }
  });

  it('a restore leaves the live spills and their TTL index alone', async () => {
    const dest = path.join(tmpDir, 'dump-for-restore');
    await dumpMod.dumpDatabase(testMongoUri(`ythril_harness_${SUITE}`), dest);
    await restoreMod.restoreDatabase(testMongoUri(`ythril_harness_${SUITE}`), dest);

    for (const spill of [HEADERS, PAGES]) {
      const ttl = (await mongo.col(spill).indexes()).find(ix => JSON.stringify(ix.key) === '{"expiresAt":1}');
      assert.equal(ttl?.expireAfterSeconds, 0,
        `\`${spill}\` lost its TTL index to the restore — every spill after it would live for ever`);
    }
    assert.equal(await mongo.col(HEADERS).countDocuments({ _id: 'spill-1' }), 1, 'the live spill is still there');
    assert.equal(await mongo.col('general_facts').countDocuments({ _id: 'f1' }), 1, 'and the restore did restore');
  });
});
