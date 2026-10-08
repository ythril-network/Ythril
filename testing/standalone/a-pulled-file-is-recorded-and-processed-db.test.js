/**
 * A file the PULL delivers is recorded completely and processed by the receiver's own rules, or it is not kept
 * (bundle-48, Q-254, Q-260, Q-356; plan D1, the pull side).
 *
 * ## The defect
 *
 * The manifest pull (`sync/file-sync.ts`) writes a peer's bytes and then records them with `recordArrivedFile(...).catch(() => {})`:
 *
 *  - Q-260: it never DISPATCHES the file. The upload door's `recordStoredFile` queues a document's text job and a media file's
 *    media job; the pull stores size and hash and stops, so a pulled `.html` is never converted and never found by a search, and
 *    a pulled CHANGED version leaves the previous version's passages in the index beside nothing new.
 *  - Q-254: a record write that FAILS after the bytes landed is swallowed. The bytes stay on disk, no row names them, and the
 *    next cycle sees the same hash on both sides and skips the file for ever — recorded by nobody, with no line saying so.
 *  - Q-356: files an earlier release pulled (bytes and row, no processing state) are never processed, because the skip branch
 *    treats "same hash" as "done". It needs a lazy repair that works them off a few per cycle, never a boot walk.
 *  - a pull is not asked about the space quota at all: the body is fetched and written whatever the space holds.
 *
 * ## The rule, over every document class and every cycle
 *
 *  1. every file the pull delivers whose class is processed has a queued job and a `pending` state when the cycle ends, and the
 *     row names the peer that delivered it; a class that is not processed has neither
 *  2. a pulled CHANGED version removes what the previous version left (its passages and its sidecar rows) and resets the job
 *     (a `complete` job with attempts is replaced by a fresh `pending` one); a neighbour that did not change is untouched
 *  3. a failed record write leaves nothing behind: the bytes the pull wrote are removed, no sync base is written, the failure is
 *     said once with the space and the path, and the next cycle delivers the file again, recorded with its true deliverer
 *  4. a row that was never processed is processed on a later cycle, and a row that was processed is not queued again; a cycle
 *     works off a bounded number (`MAX_FILE_REPAIRS_PER_CYCLE`), the rest waits its turn
 *  5. a pull over the space quota is refused BEFORE the body is fetched (the peer serves no download) and the file arrives once
 *     there is room
 *
 * ## Seen red
 *
 * On the base: 1 and 2 fail on the missing job and the surviving passages, 3 on the bytes left on disk and the silent log, 4 on
 * the file never processed (and on the cap not existing), 5 on a download that is served and a file that is written. The controls
 * (a plain-text file queues nothing, a neighbour keeps its passages, a processed row is not requeued, a file under the quota is
 * pulled) are green on the base: they hold what the fix must not break.
 *
 * Run: node --test testing/standalone/a-pulled-file-is-recorded-and-processed-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

// Models are offline: a stored file is queued and never embedded, so only what the PULL does is observed.
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'pulledfile';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const GiB = 1024 ** 3;

/**
 * The extensions whose class is a DOCUMENT (converted by the worker), derived from the resolver the dispatcher asks, and the
 * one class that is plain text (no processing). Candidates are names, the class of each is the code's. Filled in `before`:
 * the server modules are imported only AFTER the door has set the config path (an earlier import reads `C:\config`).
 */
let DOC_EXTS = [];
const PLAIN_EXT = 'log';

let door, resolveInputFormat, invalidateUsageCache;

const rowOf = (id) => door.coll(S, 'files').findOne({ _id: id });
const jobOf = (id) => door.coll(S, 'media_jobs').findOne({ _id: id });
const onDisk = (rel) => door.localFileExists(S, rel);
const readLocal = (rel) => fsp.readFile(path.join(door.localFilesRoot(S), rel), 'utf8');
/** The file rows only (no chunk or sidecar row), by id. */
const topIds = async () => (await door.coll(S, 'files').find({ parentFileId: { $exists: false } }).toArray()).map(r => r._id).sort();
const downloaded = () => door.state.fileDownloads.map(d => d.path).sort();

/** What an earlier arrival of `rel` left: the bytes, the row (with its sync base), as the pull of that release stored them. */
async function seedHeld(rel, content, extra = {}) {
  door.writeLocalFile(S, rel, content);
  await door.coll(S, 'files').insertOne(build.filemeta(S, rel, 0, {
    author: PEER_AUTHOR, deliveredBy: PEER, sizeBytes: Buffer.byteLength(content), sha256: sha(content),
    syncBase: { [PEER]: sha(content) }, ...extra,
  }));
}

/** Source of the repair cap: derived from the code, never written here (a copied number is a second fact). */
function repairCap() {
  const hits = [];
  for (const file of trackedSources('server/src', { floor: 100, untracked: true })) {
    const src = stripComments(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
    const m = /\bexport\s+const\s+MAX_FILE_REPAIRS_PER_CYCLE\b[^=]*=\s*(\d[\d_]*)/.exec(src);
    if (m) hits.push({ file, value: Number(m[1].replace(/_/g, '')) });
  }
  return hits;
}

describe('a file the pull delivers is recorded and processed, or it is not kept', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'g2pulledfile', spaces: [S], files: true });
    const pipeline = await import('../../server/dist/files/converters/pipeline.js');
    ({ resolveInputFormat } = pipeline);
    ({ invalidateUsageCache } = await import('../../server/dist/quota/quota.js'));
    DOC_EXTS = ['html', 'htm', 'md', 'markdown', 'txt', 'pdf', 'docx', 'epub']
      .filter(e => { const f = resolveInputFormat(`x.${e}`); return f !== 'text' && !pipeline.isMediaFormat(f); });
    assert.ok(DOC_EXTS.length >= 3, `the document classes derived from the resolver are ${DOC_EXTS}: the rule below ranges over too few`);
    assert.equal(resolveInputFormat(`x.${PLAIN_EXT}`), 'text', 'fixture: the plain-text control is not plain text');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); invalidateUsageCache(); });
  afterEach(() => { delete door.config().storage; invalidateUsageCache(); });

  describe('a pulled document is dispatched (Q-260)', () => {
    it('every document class has a queued text job, a pending state and its deliverer; plain text has no job', async () => {
      const names = [...DOC_EXTS.map(e => `pulled.${e}`), `plain.${PLAIN_EXT}`];
      for (const n of names) door.seedPeerFile(S, n, `bytes of ${n}`);
      await door.sync();
      const wrong = [];
      for (const n of names) {
        const row = await rowOf(n);
        if (!row) { wrong.push(`${n}: the pull recorded no row`); continue; }
        if (row.sha256 !== sha(`bytes of ${n}`)) wrong.push(`${n}: the row's hash is not the bytes' (${row.sha256})`);
        if (row.deliveredBy !== PEER) wrong.push(`${n}: deliveredBy is ${JSON.stringify(row.deliveredBy)}, want ${PEER}`);
        const job = await jobOf(n);
        if (n.endsWith(`.${PLAIN_EXT}`)) {
          if (job) wrong.push(`${n}: a plain-text file was queued (${JSON.stringify(job)})`);
          continue;
        }
        if (!job) wrong.push(`${n}: no text job was queued — the pulled document is never converted, so no search finds it`);
        else if (job.status !== 'pending' || job.mediaType !== 'text') wrong.push(`${n}: its job is ${job.status}/${job.mediaType}, want pending/text`);
        if (row.embeddingStatus !== 'pending') wrong.push(`${n}: embeddingStatus is ${JSON.stringify(row.embeddingStatus)}, want "pending"`);
      }
      assert.deepEqual(wrong, [], 'what the pull did against the rule');
    });
  });

  describe('a pulled CHANGED version replaces what the previous one left (Q-260)', () => {
    it('its passages and sidecar rows go, its job is a fresh pending one, and a neighbour that did not change keeps all of it', async () => {
      const V1 = (n) => `first version of ${n}`;
      const V2 = (n) => `SECOND version of ${n}, which says something else`;
      const names = DOC_EXTS.map(e => `chg.${e}`);
      for (const n of names) {
        await seedHeld(n, V1(n), { embeddingStatus: 'complete' });
        await door.coll(S, 'files').insertMany([
          build.filemeta(S, `${n}#chunk-0`, 4, { parentFileId: n, content: `OLD PASSAGE of ${n}` }),
          build.filemeta(S, `_converted/${n}.md`, 4, { parentFileId: n, content: `OLD CONVERSION of ${n}` }),
        ]);
        // A finished job with attempts on it: poison, so a job that merely exists is not taken for a fresh one.
        await door.coll(S, 'media_jobs').insertOne({ _id: n, spaceId: S, filePath: n, mediaType: 'text', status: 'complete', attempts: 7 });
        door.seedPeerFile(S, n, V2(n));
      }
      // The neighbour: same bytes on both sides, processed — nothing of it may move.
      await seedHeld('keep.html', 'unchanged bytes', { embeddingStatus: 'complete' });
      await door.coll(S, 'files').insertOne(build.filemeta(S, 'keep.html#chunk-0', 4, { parentFileId: 'keep.html', content: 'KEPT PASSAGE' }));
      await door.coll(S, 'media_jobs').insertOne({ _id: 'keep.html', spaceId: S, filePath: 'keep.html', mediaType: 'text', status: 'complete', attempts: 7 });
      door.seedPeerFile(S, 'keep.html', 'unchanged bytes');

      await door.sync();

      const wrong = [];
      for (const n of names) {
        const row = await rowOf(n);
        if (row?.sha256 !== sha(V2(n))) wrong.push(`${n}: the pull did not take the new version (row hash ${row?.sha256})`);
        if ((await readLocal(n)) !== V2(n)) wrong.push(`${n}: the bytes on disk are not the new version`);
        if (await rowOf(`${n}#chunk-0`)) wrong.push(`${n}: the previous version's passage row is still there`);
        if (await rowOf(`_converted/${n}.md`)) wrong.push(`${n}: the previous version's sidecar row is still there`);
        const job = await jobOf(n);
        if (!job || job.status !== 'pending' || job.attempts !== 0) wrong.push(`${n}: the job is ${JSON.stringify(job && { status: job.status, attempts: job.attempts })}, want a fresh pending one`);
        if (row?.embeddingStatus !== 'pending') wrong.push(`${n}: embeddingStatus is ${JSON.stringify(row?.embeddingStatus)}, want "pending"`);
      }
      if (!(await rowOf('keep.html#chunk-0'))) wrong.push('keep.html: a neighbour that did not change lost its passage');
      const keepJob = await jobOf('keep.html');
      if (keepJob?.status !== 'complete' || keepJob?.attempts !== 7) wrong.push(`keep.html: its job was touched: ${JSON.stringify(keepJob)}`);
      if ((await rowOf('keep.html'))?.embeddingStatus !== 'complete') wrong.push('keep.html: its processing state was reset');
      assert.deepEqual(wrong, [], 'what the pull of a changed version did against the rule');
    });
  });

  describe('a failed record write leaves nothing behind and is redone (Q-254)', () => {
    const F = 'fail.html';
    const FAILING = 'bytes whose record write the database refuses';
    const SIBLING = 'ok.html';

    const settle = async () => {
      door.seedPeerFile(S, F, FAILING);
      door.seedPeerFile(S, SIBLING, 'bytes of the sibling, whose record is written');
      await door.failRecordWrite(S, sha(FAILING));
    };
    const aboutIt = (lines) => lines.filter(l => l.includes(S) && l.includes(F));
    const anySyncBase = async () => (await door.coll(S, 'files').find({}).toArray()).filter(r => r.syncBase !== undefined && r._id === F);

    it('the bytes the pull wrote are removed, no sync base is written, the failure is said with space and path, and a sibling is unaffected', async () => {
      await settle();
      const { lines } = await door.logsDuring(() => door.sync());
      assert.ok(aboutIt(lines).length >= 1, `the failed record write was not said (a line naming "${S}" and "${F}"): ${JSON.stringify(lines)}`);
      assert.equal(onDisk(F), false, 'the bytes stay on disk with no row naming them: the next cycle sees the same hash and skips the file for ever');
      assert.equal(await rowOf(F), null, 'fixture: the validator did not refuse the record write');
      assert.deepEqual(await anySyncBase(), [], 'a sync base was written for a file that was never recorded');
      assert.ok(await rowOf(SIBLING), 'one file\'s failure stopped another file being recorded');
      assert.equal(onDisk(SIBLING), true);
    });

    it('the next cycle delivers it again and records it with its true deliverer, its base and its job', async () => {
      await settle();
      await door.sync();
      await door.clearRecordFault();
      await door.sync();
      const row = await rowOf(F);
      assert.ok(row, 'the file is recorded by nobody: the bytes were skipped as already held, and no cycle records them');
      assert.equal(row.deliveredBy, PEER, 'the row does not name the peer that delivered the file');
      assert.equal(row.sha256, sha(FAILING));
      assert.equal(row.syncBase?.[PEER], sha(FAILING), 'the agreed version was not recorded once the file was');
      assert.equal(await readLocal(F), FAILING);
      assert.ok(await jobOf(F), 'the redone arrival was not dispatched');
    });

    it('a failure that repeats is said once per window, not once per cycle', async () => {
      await settle();
      const first = await door.logsDuring(() => door.sync());
      const again = await door.logsDuring(() => door.sync());
      assert.equal(aboutIt([...first.lines, ...again.lines]).length, 1,
        `the failure for the same space and path was said ${aboutIt([...first.lines, ...again.lines]).length} times in two cycles: ${JSON.stringify([...first.lines, ...again.lines])}`);
    });
  });

  describe('a row that was never processed is processed on a later cycle (Q-356)', () => {
    const CYCLES = 4;

    it('every unprocessed document row gets its job, a processed row is not queued again, and plain text queues nothing', async () => {
      const todo = DOC_EXTS.map(e => `old.${e}`);
      for (const n of todo) { await seedHeld(n, `held bytes of ${n}`); door.seedPeerFile(S, n, `held bytes of ${n}`); }
      await seedHeld('done.html', 'processed already', { embeddingStatus: 'complete' });
      door.seedPeerFile(S, 'done.html', 'processed already');
      await seedHeld(`plain.${PLAIN_EXT}`, 'plain bytes');
      door.seedPeerFile(S, `plain.${PLAIN_EXT}`, 'plain bytes');

      let cycles = 0;
      for (; cycles < CYCLES; cycles++) {
        await door.sync();
        if ((await Promise.all(todo.map(jobOf))).every(Boolean)) { cycles++; break; }
      }
      const wrong = [];
      for (const n of todo) {
        if (!(await jobOf(n))) wrong.push(`${n}: still no job after ${cycles} cycles — a file pulled before processing existed is never processed`);
        const row = await rowOf(n);
        if (row?.embeddingStatus !== 'pending') wrong.push(`${n}: embeddingStatus is ${JSON.stringify(row?.embeddingStatus)}`);
      }
      if (await jobOf('done.html')) wrong.push('done.html: a processed row was queued again');
      if ((await rowOf('done.html'))?.embeddingStatus !== 'complete') wrong.push('done.html: its processing state was reset');
      if (await jobOf(`plain.${PLAIN_EXT}`)) wrong.push('plain: a plain-text row was queued');
      assert.deepEqual(wrong, [], 'what the repair did against the rule');
      // The repair is the pull's and the bytes are held already: nothing was fetched for it.
      assert.deepEqual(downloaded(), [], 'the repair downloaded bytes it already held');
    });

    it('at most MAX_FILE_REPAIRS_PER_CYCLE are worked off in one cycle, and the rest on the cycles after', async () => {
      const found = repairCap();
      assert.equal(found.length, 1, `MAX_FILE_REPAIRS_PER_CYCLE is exported by ${found.length} modules (${found.map(f => f.file)}), want exactly one: `
        + 'without a cap a repair that touches every held file is a boot-sized walk inside one cycle');
      const cap = found[0].value;
      assert.ok(cap >= 1 && cap <= 500, `the cap is ${cap}: the case seeds cap+3 files and needs a value it can seed`);
      const total = cap + 3;
      const names = Array.from({ length: total }, (_, i) => `bulk/r${String(i).padStart(4, '0')}.html`);
      for (const n of names) door.seedPeerFile(S, n, `held bytes of ${n}`);
      for (const n of names) door.writeLocalFile(S, n, `held bytes of ${n}`);
      await door.coll(S, 'files').insertMany(names.map(n => build.filemeta(S, n, 0, {
        author: PEER_AUTHOR, deliveredBy: PEER, sizeBytes: Buffer.byteLength(`held bytes of ${n}`), sha256: sha(`held bytes of ${n}`),
        syncBase: { [PEER]: sha(`held bytes of ${n}`) },
      })));
      const queued = async () => (await Promise.all(names.map(jobOf))).filter(Boolean).length;

      await door.sync();
      const first = await queued();
      assert.ok(first >= 1, 'no unprocessed row was repaired in the first cycle');
      assert.ok(first <= cap, `${first} rows were repaired in one cycle, the cap is ${cap}`);
      assert.ok(first < total, 'the whole backlog was worked off in one cycle');
      for (let i = 0; i < Math.ceil(total / cap) + 1 && (await queued()) < total; i++) await door.sync();
      assert.equal(await queued(), total, 'the rest did not wait its turn: some rows were never repaired');
    });
  });

  describe('the quota is asked before the body is fetched', () => {
    const LIMIT_BYTES = 4000;
    const setQuota = () => { door.config().storage = { files: { hardLimitGiB: LIMIT_BYTES / GiB } }; invalidateUsageCache(); };

    it('a file that would pass the hard limit is refused with no download, nothing recorded, and arrives once there is room', async () => {
      const BIG = 'x'.repeat(2 * LIMIT_BYTES);
      door.seedPeerFile(S, 'big.html', BIG);
      setQuota();
      const { lines } = await door.logsDuring(() => door.sync());
      assert.deepEqual(downloaded(), [], 'the body of a file over the quota was fetched before the quota was asked');
      assert.equal(onDisk('big.html'), false, 'a file over the quota was written');
      assert.deepEqual(await topIds(), [], 'a file over the quota was recorded');
      assert.ok(lines.some(l => /quota/i.test(l)), `the refusal was not said: ${JSON.stringify(lines)}`);

      delete door.config().storage;
      invalidateUsageCache();
      await door.sync();
      assert.equal(onDisk('big.html'), true, 'the file never arrived once the quota allowed it: the refusal was remembered as a delivery');
      assert.equal((await rowOf('big.html'))?.sha256, sha(BIG));
    });

    it('a file under the limit is pulled with the same limit set', async () => {
      door.seedPeerFile(S, 'small.html', 'a hundred bytes or so');
      setQuota();
      await door.sync();
      assert.deepEqual(downloaded(), ['small.html'], 'the quota refused a file that fits');
      assert.equal(onDisk('small.html'), true);
    });
  });
});
