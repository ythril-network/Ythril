/**
 * The pull never records bytes it did not deliver, never lets a refused body pass unsaid, and bounds the work of its repair
 * (bundle-48 sweep: findings 1, 3, 7 and 8 of the pre-ship lens pass).
 *
 * ## The rule
 *
 *  1. BYTES HELD WITH NO ROW are taken back, not recorded. A file whose record failed in an earlier release was left on disk with
 *     no row (the failure was swallowed); the pull's repair used to INSERT a row for it with this instance as its author and its
 *     deliverer, which hands the derived-description guard (`author == self`) a file a peer authored and reads as authorless the
 *     file the origin may delete. The repair now removes the bytes, and the next cycle delivers the file as a normal arrival: the
 *     row names the PEER as its author and as its deliverer, at no cycle this instance
 *  2. a row that names OTHER bytes than the disk's (`stale_row`) is brought up to date in place, and its author and deliverer are
 *     the ones it had; counted `repaired_stale_row`
 *  3. a pulled body that fails verification (not the hash it declared, longer than its size, or shorter) leaves the stored file
 *     and its row as they were, is SAID once per window with the space and the path, and is COUNTED `refused_body`
 *  4. a repair candidate that a held tombstone shadows (or that cannot be looked at) costs a read, so it counts against the
 *     per-cycle cap: the reads of a cycle do not grow with the number of such paths
 *  5. `removeUnrecordedBytes` KEEPS the bytes when the lookup that would prove them unrecorded fails (the store is not answering),
 *     and says so once; it removes them only when the lookup answered "no row"
 *
 * ## Seen red
 *
 * On the base: 1 fails on a row authored and delivered by this instance, 3 on a line that names no space and a counter outcome that
 * does not exist, 4 on one read more per shadowed path, 5 on bytes removed under a failing lookup. 2 and its controls are green on
 * the base (the stale repair never touched the author): they pin what the fix must not change.
 *
 * Run: YTHRIL_TEST_MONGO_PORT=27219 YTHRIL_TEST_MONGO_CREDS=ythril:ythril-test-pw node --test testing/standalone/a-pull-takes-back-bytes-nothing-names-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { withCollectionAsView } from './_write-faults.mjs';

// Models are offline: a stored file is queued and never embedded, so only what the PULL does is observed.
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'takeback';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const HELD_AT = '2026-09-01T00:00:05.000Z';
const MODIFIED = '2026-10-01T00:00:00.000Z';
const CYCLES = 4;

let door, metrics, removeUnrecordedBytes, repairCap;

const rowOf = (id) => door.coll(S, 'files').findOne({ _id: id });
const onDisk = (rel) => door.localFileExists(S, rel);
const readLocal = (rel) => fs.readFileSync(path.join(door.localFilesRoot(S), rel), 'utf8');
const downloaded = () => door.state.fileDownloads.map(d => d.path).sort();

/** What `ythril_sync_file_arrivals_total{pull, <outcome>}` has counted so far. */
async function counted(outcome, doorName = 'pull') {
  const { values } = await metrics.syncFileArrivalsTotal.get();
  return values.find(v => v.labels.door === doorName && v.labels.outcome === outcome)?.value ?? 0;
}

/** Advertise one file with the size and hash the peer DECLARES, whatever its disk then serves. */
const advertise = (p, { sha256, size }) => {
  door.state.manifest = (_req, res) => { res.json({ spaceId: S, manifest: [{ path: p, sha256, size, modifiedAt: MODIFIED }] }); };
};

/** A held tombstone that shadows exactly these bytes at `p` (the tombstone an earlier delete of them left). */
const shadow = (p, content) => door.coll(S, 'file_tombstones').insertOne({
  _id: `held-${p}`, spaceId: S, path: p, deletedAt: HELD_AT, positionAt: HELD_AT, rowSeq: 5, contentHash: sha(content), issuer: PEER,
});

describe('the pull takes back what nothing names, and says what it refuses', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'takeback', spaces: [S], files: true, monitorCommands: true, meta: { [S]: { suppressEmbeddings: true } } });
    metrics = await import('../../server/dist/metrics/registry.js');
    ({ removeUnrecordedBytes } = await import('../../server/dist/files/unrecorded-bytes.js'));
    ({ MAX_FILE_REPAIRS_PER_CYCLE: repairCap } = await import('../../server/dist/sync/file-sync.js'));
    assert.ok(Number.isInteger(repairCap) && repairCap >= 1 && repairCap <= 500, `the cap is ${repairCap}: the cases seed more than it`);
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); });

  describe('bytes held with no row (rule 1)', () => {
    const FILES = [['orphan.html', 'bytes of a document whose record failed'], ['orphan.log', 'bytes of a plain file whose record failed']];

    it('are taken back, delivered again by the peer, and recorded as the PEER\'s: never as this instance\'s own', async () => {
      for (const [n, content] of FILES) { door.writeLocalFile(S, n, content); door.seedPeerFile(S, n, content); }
      const removed = await counted('repaired_missing_row');
      const wrong = [];
      let cycles = 0;
      for (; cycles < CYCLES; cycles++) {
        await door.sync();
        for (const [n] of FILES) {
          const row = await rowOf(n);
          if (row && row.author?.instanceId === door.instanceId) wrong.push(`${n}: after cycle ${cycles + 1} the row is authored by this instance (${JSON.stringify(row.author)})`);
          if (row && row.deliveredBy === door.instanceId) wrong.push(`${n}: after cycle ${cycles + 1} the row is delivered by this instance`);
        }
        if ((await Promise.all(FILES.map(([n]) => rowOf(n)))).every(Boolean)) { cycles++; break; }
      }
      for (const [n, content] of FILES) {
        const row = await rowOf(n);
        if (!row) { wrong.push(`${n}: still no row after ${cycles} cycles`); continue; }
        if (row.author?.instanceId !== PEER) wrong.push(`${n}: author is ${JSON.stringify(row.author)}, want the peer ${PEER}`);
        if (row.deliveredBy !== PEER) wrong.push(`${n}: deliveredBy is ${JSON.stringify(row.deliveredBy)}, want ${PEER}`);
        if (row.sha256 !== sha(content)) wrong.push(`${n}: the row names other bytes (${row.sha256})`);
        if (!onDisk(n) || readLocal(n) !== content) wrong.push(`${n}: the bytes are not on disk as the peer holds them`);
      }
      assert.deepEqual(wrong, [], 'what the pull did with bytes nothing named');
      assert.deepEqual(downloaded(), FILES.map(([n]) => n).sort(), 'the bytes were not delivered again: they were recorded as they lay');
      assert.equal(await counted('repaired_missing_row') - removed, FILES.length, 'each take-back is counted once, under the outcome the docs name');
    });

    it('a file the pull delivered itself is not touched: control, recorded once with its deliverer and no take-back', async () => {
      door.seedPeerFile(S, 'fresh.html', 'a file only the peer holds');
      const removed = await counted('repaired_missing_row');
      await door.sync();
      const row = await rowOf('fresh.html');
      assert.equal(row?.deliveredBy, PEER);
      assert.equal(row?.author?.instanceId, PEER);
      assert.equal(await counted('repaired_missing_row'), removed, 'a file that was never held was counted as taken back');
    });
  });

  describe('a row that names other bytes (rule 2)', () => {
    it('is brought up to date in place: the bytes stay, nothing is downloaded, and the author and deliverer are the row\'s own', async () => {
      const NOW = 'the bytes both instances hold now';
      door.writeLocalFile(S, 'stale.html', NOW);
      door.seedPeerFile(S, 'stale.html', NOW);
      await door.coll(S, 'files').insertOne(build.filemeta(S, 'stale.html', 3, {
        author: PEER_AUTHOR, deliveredBy: PEER, sizeBytes: 9, sha256: sha('the bytes a failed record never replaced'), syncBase: { [PEER]: sha(NOW) },
      }));
      const before = await counted('repaired_stale_row');
      await door.sync();
      const row = await rowOf('stale.html');
      assert.equal(row?.sha256, sha(NOW), 'the row still names the other bytes');
      assert.equal(row?.sizeBytes, Buffer.byteLength(NOW));
      assert.equal(row?.author?.instanceId, PEER, 'the repair changed the row\'s author');
      assert.equal(row?.deliveredBy, PEER, 'the repair changed the row\'s deliverer');
      assert.equal(row?.seq, 3, 'the repair stamped a seq on a row it did not author');
      assert.equal(readLocal('stale.html'), NOW, 'the bytes were taken back: a row that exists is brought up to date, not redelivered');
      assert.deepEqual(downloaded(), [], 'the repair downloaded bytes it already held');
      assert.equal(await counted('repaired_stale_row') - before, 1);
    });
  });

  describe('a body that fails verification (rule 3)', () => {
    const DECLARED = 'the bytes the manifest declared, exactly so';
    const WRONG = [
      { name: 'the declared size and another hash', served: DECLARED.replace('exactly so', 'exactly no') },
      { name: 'more than the declared size', served: `${DECLARED} and then some more that nobody declared` },
      { name: 'fewer than the declared size', served: DECLARED.slice(0, 12) },
    ];
    for (const [i, { name, served }] of WRONG.entries()) {
      it(`${name}: nothing is stored, the refusal is counted, and it is said once per window with the space and path`, async () => {
        if (name.startsWith('the declared size')) assert.equal(Buffer.byteLength(served), Buffer.byteLength(DECLARED), 'fixture: the served body is not the declared size');
        // A path of its own per case: the reporter's window outlives a case, so a shared path is said once for all three.
        const P = `refused-${i}.bin`;
        door.seedPeerFile(S, P, served);
        advertise(P, { sha256: sha(DECLARED), size: Buffer.byteLength(DECLARED) });
        const before = await counted('refused_body');
        const first = await door.logsDuring(() => door.sync());
        const again = await door.logsDuring(() => door.sync());
        const about = [...first.lines, ...again.lines].filter(l => l.includes(S) && l.includes(P));
        assert.equal(about.length, 1, `the refusal was said ${about.length} times over two cycles (want once): ${JSON.stringify([...first.lines, ...again.lines])}`);
        assert.equal(await counted('refused_body') - before, 2, 'each refused body is counted, once per cycle it was served');
        assert.deepEqual(downloaded(), [P, P], 'fixture: the body was not fetched twice');
        assert.equal(onDisk(P), false, 'a refused body was stored');
        assert.equal(await rowOf(P), null, 'a refused body was recorded');
      });
    }
  });

  describe('the work of a repair is bounded (rule 4)', () => {
    const STALE = 'stale/repair-me.html';
    const STALE_BYTES = 'bytes the row does not name yet';

    /**
     * One cycle with `n` shadowed paths held (bytes, no row, a tombstone for exactly those bytes) and, when `withStale`, one file
     * a repair can bring up to date (bytes here and at the peer, a row naming other bytes): the held-tombstone reads it made.
     */
    async function oneCycle(n, { withStale = false } = {}) {
      await door.reset();
      for (let i = 0; i < n; i++) {
        const p = `shadowed/s${String(i).padStart(4, '0')}.html`;
        const content = `bytes of ${p}`;
        door.writeLocalFile(S, p, content);
        door.seedPeerFile(S, p, content);
        await shadow(p, content);
      }
      if (withStale) {
        door.writeLocalFile(S, STALE, STALE_BYTES);
        door.seedPeerFile(S, STALE, STALE_BYTES);
        await door.mongo.getDb().collection(`${S}_files`).insertOne({
          _id: STALE, spaceId: S, path: STALE, tags: [], sizeBytes: 1, sha256: '0'.repeat(64),
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', seq: 1,
        });
      }
      const commands = await door.commandsDuring(() => door.sync());
      return commands.filter(c => /^find .*file_tombstones/.test(c) && c.includes(S)).length;
    }

    it('shadowed repair candidates are asked about together: more of them cost no more reads', async () => {
      const atCap = await oneCycle(repairCap);
      const pastCap = await oneCycle(repairCap + 10);
      assert.ok(atCap > 0, 'fixture: the shadowed candidates were never asked about, so the case measures nothing');
      assert.equal(pastCap, atCap, `${repairCap + 10} shadowed candidates cost ${pastCap} reads and ${repairCap} cost ${atCap}: the deletion question is asked per candidate`);
    });

    it('shadowed candidates do not use the cycle\'s repair budget: a repairable file behind more of them than the cap is repaired at once', async () => {
      const before = await counted('repaired_stale_row');
      await oneCycle(repairCap + 10, { withStale: true });
      assert.equal((await rowOf(STALE))?.sha256, sha(STALE_BYTES), 'the stale row was not brought up to date: the shadowed candidates used up the budget');
      assert.equal(await counted('repaired_stale_row') - before, 1, 'the repair was not counted once');
      for (let i = 0; i < 3; i++) {
        assert.equal(await rowOf(`shadowed/s${String(i).padStart(4, '0')}.html`), null, 'a shadowed path was recorded again');
      }
    });
  });

  describe('a lookup that fails keeps the bytes (rule 5)', () => {
    const KEPT = 'kept.html';
    const hasRowAfter = async () => (await rowOf(KEPT)) !== null;

    it('control: no row at all, the lookup answers, and the bytes are removed', async () => {
      door.writeLocalFile(S, KEPT, 'bytes with no row');
      const removed = await removeUnrecordedBytes(S, KEPT);
      assert.equal(onDisk(KEPT), false, 'bytes with no row stayed');
      assert.equal(removed, true, 'the answer does not say the bytes were taken back');
    });

    it('the lookup throws: the bytes stay on disk, nothing throws, and it is said once with the space and path', async () => {
      door.writeLocalFile(S, KEPT, 'bytes whose row nobody can read');
      const db = door.mongo.getDb();
      // The files collection becomes a view whose READS fail for the row of this path (a source document the stage cannot convert).
      await db.collection(`${S}_files_src`).drop().catch(() => {});
      await db.collection(`${S}_files_src`).insertOne({ _id: KEPT, junk: 'not a number' });
      const lines = [];
      let answer;
      await withCollectionAsView(db, `${S}_files`, `${S}_files_src`, async () => {
        const out = await door.logsDuring(async () => { answer = await removeUnrecordedBytes(S, KEPT); await removeUnrecordedBytes(S, KEPT); });
        lines.push(...out.lines);
      }, { pipeline: [{ $addFields: { _x: { $toInt: '$junk' } } }] });
      await db.collection(`${S}_files_src`).drop().catch(() => {});
      assert.equal(onDisk(KEPT), true, 'the bytes were removed although nothing proved they are unrecorded');
      assert.equal(answer, false, 'the answer says the bytes were taken back');
      const about = lines.filter(l => l.includes(S) && l.includes(KEPT));
      assert.equal(about.length, 1, `the failed lookup was said ${about.length} times for two calls (want once): ${JSON.stringify(lines)}`);
      assert.equal(await hasRowAfter(), false, 'fixture: the view was not put back');
    });
  });
});
