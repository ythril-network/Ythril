/**
 * Database-level test: a backup actually restores. Every collection, every document, every value.
 *
 * ## Why this did not exist
 *
 * `dumpDatabase` and `restoreDatabase` have shipped since the migration feature, and the endpoints that drive
 * them are exercised by the integration suite — which proves they answer, not that the data survives. The
 * Data-Integrity lens names the gap exactly: *backup/restore round-trip actually verified*. A backup nobody has
 * restored is a belief, not a backup, and the failure mode is the worst kind: discovered when it is needed.
 *
 * ## What is asserted
 *
 * Seed a populated space, dump, **destroy the database**, restore, and compare document-for-document — including
 * the two things a naive round-trip loses without anyone noticing:
 *
 *   - **BSON types.** `_expireAt` is a `Date`, and NDJSON has no date type. A round-trip through
 *     `JSON.stringify` turns it into a string, the TTL index stops matching it, and records that should expire
 *     never do — silently, for as long as the instance runs.
 *   - **Embeddings.** A vector is an array of ~768 floats. Precision loss or truncation there does not throw; it
 *     degrades recall, which nobody attributes to a restore weeks later.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/backup-restore-round-trip-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason, testMongoUri } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const SPACE = 'roundtrip';
const DB = 'ythril_harness_roundtrip';

let mongo, dumpDatabase, restoreDatabase, dir, uri;

/** A populated space: records with a vector, a Date, unicode, and an empty-but-present collection. */
const SEED = {
  [`${SPACE}_facts`]: [
    {
      _id: 'm1', spaceId: SPACE, fact: 'Ünïcode — em dash, quotes "x", emoji 🌍', tags: ['a', 'b'],
      seq: 1, createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-01T10:00:00.000Z',
      embedding: Array.from({ length: 768 }, (_, i) => (i % 17) / 17 - 0.5),
      _expireAt: new Date('2026-12-01T00:00:00.000Z'),
    },
    { _id: 'm2', spaceId: SPACE, fact: '', tags: [], seq: 2, createdAt: 'x', updatedAt: 'x' },
  ],
  [`${SPACE}_entities`]: [
    { _id: 'e1', spaceId: SPACE, name: 'Acme', type: 'org', seq: 3, properties: { nested: { deep: [1, 2, 3] } } },
  ],
  [`${SPACE}_edges`]: [
    { _id: 'g1', spaceId: SPACE, from: 'e1', to: 'e1', label: 'self', seq: 4 },
  ],
  [`${SPACE}_tombstones`]: [],   // present but empty — the manifest must still carry it
};

describe('backup → restore round-trip', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('roundtrip');
    ({ dumpDatabase } = await import('../../server/dist/db/dump.js'));
    ({ restoreDatabase } = await import('../../server/dist/db/restore.js'));
    uri = testMongoUri(DB);
    dir = mkdtempSync(join(tmpdir(), 'ythril-roundtrip-'));

    for (const [name, docs] of Object.entries(SEED)) {
      await mongo.getDb().createCollection(name);
      if (docs.length) await mongo.col(name).insertMany(docs.map(d => ({ ...d })));
    }
  });

  after(async () => {
    await closeTestMongo();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('dumps every seeded collection, with counts', async () => {
    const manifest = await dumpDatabase(uri, dir);
    const named = new Map(manifest.collections.map(c => [c.name, c.count]));
    for (const [name, docs] of Object.entries(SEED)) {
      assert.ok(named.has(name), `${name} is missing from the manifest — it would not be restored`);
      assert.equal(named.get(name), docs.length, `${name} count`);
    }
    assert.ok(existsSync(join(dir, 'manifest.json')));
  });

  it('restores after the database is DESTROYED — the case a backup exists for', async () => {
    // Dropping the whole database is the point: restoring over live data proves far less, because a collection
    // the dump forgot would still be there and the comparison would pass.
    await dumpDatabase(uri, dir);
    await mongo.getDb().dropDatabase();
    assert.equal((await mongo.getDb().listCollections().toArray()).length, 0, 'the database must be empty first');

    await restoreDatabase(uri, dir);
    const after = (await mongo.getDb().listCollections().toArray()).map(c => c.name).sort();
    assert.deepEqual(after, Object.keys(SEED).sort(), 'every collection must come back, including the empty one');
  });

  it('brings every document back byte-for-byte, including unicode and an empty string', async () => {
    for (const [name, docs] of Object.entries(SEED)) {
      const restored = await mongo.col(name).find({}).sort({ _id: 1 }).toArray();
      assert.equal(restored.length, docs.length, `${name} document count`);
      for (const original of docs) {
        const got = restored.find(r => r._id === original._id);
        assert.ok(got, `${name}/${original._id} did not come back`);
        for (const [k, v] of Object.entries(original)) {
          if (k === '_expireAt' || k === 'embedding') continue;   // asserted with their own rules below
          assert.deepEqual(got[k], v, `${name}/${original._id}.${k}`);
        }
      }
    }
  });

  it('keeps `_expireAt` a Date — a string there silently disables the TTL', async () => {
    // NDJSON has no date type. Through a naive JSON round-trip this becomes a string, the TTL index stops
    // matching it, and records that should expire never do. Nothing errors, ever.
    const m = await mongo.col(`${SPACE}_facts`).findOne({ _id: 'm1' });
    assert.ok(m._expireAt instanceof Date, `_expireAt came back as ${typeof m._expireAt}`);
    assert.equal(m._expireAt.toISOString(), '2026-12-01T00:00:00.000Z');
  });

  it('keeps the embedding intact, to full precision', async () => {
    // Truncation or precision loss here does not throw — it degrades recall, which nobody attributes to a
    // restore weeks later.
    const m = await mongo.col(`${SPACE}_facts`).findOne({ _id: 'm1' });
    assert.equal(m.embedding.length, 768, 'vector width');
    const expected = SEED[`${SPACE}_facts`][0].embedding;
    for (let i = 0; i < expected.length; i++) {
      assert.equal(m.embedding[i], expected[i], `embedding[${i}]`);
    }
  });

  it('keeps nested structures, not a flattened copy', async () => {
    const e = await mongo.col(`${SPACE}_entities`).findOne({ _id: 'e1' });
    assert.deepEqual(e.properties, { nested: { deep: [1, 2, 3] } });
  });

  it('is idempotent — restoring twice leaves one copy, not two', async () => {
    // Each collection is dropped before insert. If that ever stops being true, a re-run doubles every record and
    // the duplicate-detector inherits the mess.
    await restoreDatabase(uri, dir);
    assert.equal(await mongo.col(`${SPACE}_facts`).countDocuments({}), 2);
  });

  it('refuses a directory with no manifest instead of restoring nothing quietly', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'ythril-nomanifest-'));
    try {
      await assert.rejects(restoreDatabase(uri, empty), /manifest/i);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('the dump is readable NDJSON, one document per line', async () => {
    // If the format ever changes, this says so here rather than at the moment someone needs the backup.
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    assert.ok(manifest.collections.length >= Object.keys(SEED).length);
    const file = join(dir, `${SPACE}_entities.ndjson`);
    assert.ok(existsSync(file), `expected ${file}`);
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0])._id, 'e1');
  });
});
