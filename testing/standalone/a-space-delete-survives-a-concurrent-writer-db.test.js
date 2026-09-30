/**
 * Deleting a space completes while something is still writing under its files directory, and one delete that
 * did not complete never blocks every later space operation until a restart.
 *
 * ## How this was found
 *
 * A Docker integration run of bundle-27, 13:30:47Z: a test space was deleted while the media worker was still
 * converting its transcripts. `dropSpaceData` dropped every collection, then `fs.rm(filesDir, {recursive, force})`
 * failed `ENOTEMPTY … rmdir '/data/files/<space>/transcripts'` — the worker was writing conversion artifacts under
 * it at that moment, and logged doing so 0.6 s later. `force` ignores only a missing path; nothing retried.
 *
 * The failure kept the `pendingSpaceOp` marker, as it must — a delete is forward-only. But the marker was only ever
 * resumed at BOOT, so from then on every space delete and rename on the instance answered "Cannot delete space 'X':
 * a delete of '<space>' is still pending … It resumes automatically on restart" — sixteen integration failures from
 * one racy file write.
 *
 * ## The three halves, and what this holds for each
 *
 *   1. The directory removal does not lose a race with a writer: every removal of a space's directories goes
 *      through `removeSpaceTree`, which retries what a concurrent writer causes (ENOTEMPTY, EBUSY, EPERM).
 *   2. A space being deleted takes no more file writes: `writeFile`/`writeFileBytes` refuse a space that is going
 *      away, and the media worker treats that refusal as an abandonment — as it does a moved file's lost claim.
 *   3. A pending op is resumed by the next space operation that meets it, not only at boot; the refusal stays only
 *      if it still cannot complete, and then says why.
 *
 * Run: node --test testing/standalone/a-space-delete-survives-a-concurrent-writer-db.test.js
 * (requires a prior `npm run build` in server/, and the test Mongo)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-delete-race-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');

const space = id => ({ id, label: id, folders: [], completeLinkage: true });

describe('a space delete and a concurrent writer', { skip }, () => {
  let mongo, loader, lifecycle, files;

  before(async () => {
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'delete-race', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [space('victim'), space('ghost'), space('other'), space('closing')],
    }, null, 2), { mode: 0o600 });
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    mongo = await openTestMongo('deleterace');
    for (const id of ['victim', 'ghost', 'other', 'closing']) {
      await mongo.col(`${id}_facts`).insertOne({ _id: `${id}-f`, spaceId: id, fact: 'x' });
      await fsp.mkdir(path.join(process.env['DATA_ROOT'], 'files', id, 'transcripts'), { recursive: true });
    }
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
    files = await import('../../server/dist/files/files.js');
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('1. the delete completes while a writer keeps adding files under the space', async () => {
    const dir = path.join(process.env['DATA_ROOT'], 'files', 'victim', 'transcripts');
    // Seed a tree deep enough that the removal takes a while, then keep writing into it — past every gate, as a
    // writer that started before the delete does.
    for (let i = 0; i < 200; i++) {
      await fsp.mkdir(path.join(dir, `d${i}`), { recursive: true });
      await fsp.writeFile(path.join(dir, `d${i}`, 'part.md'), 'x');
    }
    let stop = false;
    const writer = (async () => {
      const until = Date.now() + 1500;
      for (let n = 0; !stop && Date.now() < until; n++) {
        try {
          await fsp.mkdir(path.join(dir, `w${n % 20}`), { recursive: true });
          await fsp.writeFile(path.join(dir, `w${n % 20}`, `a${n}.md`), 'x');
        } catch { /* the tree is going away under it — the writer does not care */ }
      }
    })();
    let outcome;
    try { outcome = await lifecycle.removeSpace('victim'); } catch (err) { outcome = err; }
    stop = true;
    await writer;
    assert.equal(outcome, true, `the delete did not complete: ${outcome instanceof Error ? outcome.message : outcome}`);
    const cfg = loader.getConfig();
    assert.equal(cfg.pendingSpaceOp, undefined, 'the delete left its marker behind');
    assert.ok(!cfg.spaces.some(s => s.id === 'victim'));
  });

  it('2. a space that is being deleted takes no more file writes', async () => {
    const cfg = loader.getConfig();
    cfg.pendingSpaceOp = { type: 'delete', spaceId: 'closing', startedAt: new Date().toISOString() };
    try {
      await assert.rejects(files.writeFile('closing', 'transcripts/late.md', 'late'),
        err => /closing/.test(err.message) && /deleted|being|going/i.test(err.message),
        'a write into a space being deleted was accepted');
      assert.equal(fs.existsSync(path.join(process.env['DATA_ROOT'], 'files', 'closing', 'transcripts', 'late.md')), false);
      const lease = await import('../../server/dist/files/media/lease.js');
      const refusal = await files.writeFile('closing', 'x.md', 'x').catch(e => e);
      assert.equal(lease.isAbandonment(refusal), true,
        'the media worker would record a refused write into a closing space as a failed job, not an abandonment');
    } finally {
      delete cfg.pendingSpaceOp;
    }
    const worker = fs.readFileSync('server/src/files/media/worker.ts', 'utf8');
    assert.match(worker, /isAbandonment\(err\)/, 'the media worker does not abandon on a closing space');
  });

  it('3. a pending delete is resumed by the next space operation, which then proceeds', async () => {
    const cfg = loader.getConfig();
    // What the failed delete left: the marker, the space still in config, its data half-dropped.
    cfg.pendingSpaceOp = { type: 'delete', spaceId: 'ghost', startedAt: new Date().toISOString() };
    loader.saveConfig(cfg);
    let outcome;
    try { outcome = await lifecycle.removeSpace('other'); } catch (err) { outcome = err; }
    assert.equal(outcome, true, `the next delete was refused behind the pending one: ${outcome instanceof Error ? outcome.message : outcome}`);
    const after = loader.getConfig();
    assert.equal(after.pendingSpaceOp, undefined, 'the pending delete was not resumed');
    assert.ok(!after.spaces.some(s => s.id === 'ghost'), 'the pending delete did not finish');
    assert.ok(!after.spaces.some(s => s.id === 'other'), 'the delete that met it did not proceed');
    assert.equal(fs.existsSync(path.join(process.env['DATA_ROOT'], 'files', 'ghost')), false);
  });
});
