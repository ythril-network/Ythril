/**
 * A peer's file metadata is queued for embedding exactly where this instance holds the bytes (Q-263).
 *
 * ## The rule, in one sentence
 *
 * A peer's file metadata is queued for embedding when this instance holds the file's bytes (its row has a size or a hash), or
 * on a restore; never for a row this instance suppresses, and never for a row it flagged as deleted.
 *
 * Metadata can arrive before the bytes do. A row with no bytes has nothing to embed but its path and words, and the bytes that
 * land later enqueue the file themselves (`recordArrivedFile`); so queueing on the metadata alone would spend a model call on
 * a file this instance cannot read. A restore is the opposite case: the export carries no bytes, and its promise is that search
 * comes back on its own.
 *
 * ## Why this is a behaviour test
 *
 * The rule was pinned only by a source regex (`a-receiver-embeds-by-its-own-rules.test.js`), which passes for a `holdsBlob`
 * that always answers `true`, and was covered on its positive half only by an incidental control. Here the rule is the
 * table's predicate, written independently of the code from the sentence above, and every row asserts the `embed_jobs` rows
 * for the id equal it.
 *
 * ## The table
 *
 * Stored row: none (a first arrival) / holds neither size nor hash / size only / hash only / both. Doors: push (`/batch-upsert`)
 * and pull, which share one writer and are asked anyway; the admin import (a restore) as its own rows. Plus: a suppressed
 * arrival whose stored row holds bytes (no job; the vectors of the file's passages are dropped) and a flagged stored row that
 * holds bytes (no job).
 *
 * Run: node --test testing/standalone/a-peers-file-metadata-is-queued-only-where-its-bytes-are-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const SPACE = 'bytes-open';
const TOKEN = Object.freeze({ rights: { perSpace: {}, spaceAdmin: { floor: true, spaces: [] } }, peerInstanceId: PEER });
const HASH = 'b'.repeat(64);

/** The stored row's bytes, per case: what the receiver derived from bytes it holds. */
const STORED = {
  'none': null,
  'neither size nor hash': {},
  'size only': { sizeBytes: 11 },
  'hash only': { sha256: HASH },
  'size and hash': { sizeBytes: 11, sha256: HASH },
};

/**
 * THE RULE, as the sentence says it, independent of the code: queued when the bytes are held (a size or a hash on the stored row) or
 * on a restore; never when suppressed or flagged.
 */
function queuedBy({ restore = false, stored, suppressed = false, flagged = false }) {
  if (flagged || suppressed) return false;
  if (restore) return true;
  return stored !== null && (stored.sizeBytes !== undefined || stored.sha256 !== undefined);
}

let door, importMod, n = 0;
const jobsFor = (id) => door.coll(SPACE, 'embed_jobs').countDocuments({ recordId: id });
const freshId = (tag) => `bytes/${tag}-${++n}.md`;

const storedRow = (id, bytes, extra = {}) => ({
  ...build.filemeta(SPACE, id, 5, { author: { ...PEER_AUTHOR }, description: 'the stored words' }), ...bytes, ...extra,
});
const arriving = (id, seq, extra = {}) => build.filemeta(SPACE, id, seq, { author: { ...PEER_AUTHOR }, description: 'the arriving words', ...extra });

async function deliver(via, doc) {
  if (via === 'push') {
    const r = await door.push('/batch-upsert', { filemeta: [doc] }, { spaceId: SPACE, networkId: door.NET, token: TOKEN });
    assert.equal(r.code, 200, JSON.stringify(r.body));
  } else if (via === 'pull') {
    door.state.records[SPACE] = { filemeta: [doc] };
    await door.sync();
  } else {
    await importMod.importDocuments(SPACE, { files: [doc] });
  }
  await door.settled();
}

describe('a peer\'s file metadata is queued only where its bytes are (Q-263)', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'file-meta-queue', spaces: [SPACE], meta: {} });
    importMod = await import('../../server/dist/api/admin-import.js');
  });
  after(async () => { await door?.close(); });

  it('the predicate is not vacuous: the table has rows that queue and rows that do not', () => {
    const rows = Object.values(STORED).map(stored => queuedBy({ stored }));
    assert.ok(rows.includes(true) && rows.includes(false), 'the table cannot tell the rule from "always" or "never"');
    assert.equal(Object.keys(STORED).length, 5);
  });

  for (const via of ['push', 'pull']) {
    for (const [name, bytes] of Object.entries(STORED)) {
      it(`${via}: ${bytes === null ? 'a first arrival' : `a newer arrival onto a row holding ${name}`} is queued exactly when the bytes are here`, async () => {
        await door.reset();
        const id = freshId(`${via}-${name.replace(/\W+/g, '-')}`);
        if (bytes !== null) await door.coll(SPACE, 'files').insertOne(storedRow(id, bytes));
        await deliver(via, arriving(id, bytes === null ? 1 : 6));
        const stored = await door.coll(SPACE, 'files').findOne({ _id: id });
        assert.ok(stored && stored.description === 'the arriving words', `fixture check: the arrival did not land (${JSON.stringify(stored)})`);
        assert.equal(await jobsFor(id), queuedBy({ stored: bytes }) ? 1 : 0,
          `${via}, stored ${name}: ${queuedBy({ stored: bytes }) ? 'the bytes are here and no job was queued' : 'no bytes are here and a job was queued'}`);
      });
    }
  }

  for (const [name, bytes] of Object.entries(STORED)) {
    it(`import (a restore): a file row over ${bytes === null ? 'nothing' : `a stored row holding ${name}`} is always queued`, async () => {
      await door.reset();
      const id = freshId(`import-${name.replace(/\W+/g, '-')}`);
      if (bytes !== null) await door.coll(SPACE, 'files').insertOne(storedRow(id, bytes));
      await deliver('import', arriving(id, 6));
      assert.ok(await door.coll(SPACE, 'files').findOne({ _id: id }), 'fixture check: the restore did not land');
      assert.equal(await jobsFor(id), queuedBy({ restore: true, stored: bytes }) ? 1 : 0, `import, stored ${name}: a restored file is not queued`);
    });
  }

  for (const via of ['push', 'pull']) {
    it(`${via}: a row this instance suppresses is not queued although it holds the bytes, and its passages lose their vectors`, async () => {
      await door.reset();
      const id = freshId(`${via}-suppressed`);
      const bytes = STORED['size and hash'];
      await door.coll(SPACE, 'files').insertMany([
        storedRow(id, bytes),
        { _id: `${id}#chunk0`, spaceId: SPACE, path: `${id}#chunk0`, parentFileId: id, content: 'a passage', tags: [],
          embedding: [0.9, 0.1], embeddingModel: 'receiver-model', matchedText: 'a passage' },
      ]);
      await deliver(via, arriving(id, 6, { suppressEmbeddings: true }));
      assert.equal(await jobsFor(id), queuedBy({ stored: bytes, suppressed: true }) ? 1 : 0, 'a suppressed file with bytes was queued, and the model would embed what the owner retired');
      const chunk = await door.coll(SPACE, 'files').findOne({ _id: `${id}#chunk0` });
      assert.equal(chunk.embedding, undefined, 'the passage of a suppressed file kept its vector');
    });

    it(`${via}: a row this instance flagged as deleted is not queued although it holds the bytes`, async () => {
      await door.reset();
      const id = freshId(`${via}-flagged`);
      const bytes = STORED['size and hash'];
      await door.coll(SPACE, 'files').insertOne(storedRow(id, bytes, { deletedAt: new Date('2026-10-01T00:00:00.000Z') }));
      await deliver(via, arriving(id, 6));
      assert.equal(await jobsFor(id), queuedBy({ stored: bytes, flagged: true }) ? 1 : 0, 'an arrival onto a deleted file\'s audit record queued a job for it');
    });
  }
});
