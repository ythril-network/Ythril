/**
 * A directory delete announces one `file.deleted` per file it removed — a live top-level file, never a sidecar, a derived row or a row an
 * earlier delete had already flagged — and a delete nobody made announces nothing (bundle-113, Q-469).
 *
 * ## The report
 *
 * `delete_file` on a directory removed every file under it and told no subscriber: the cascade took no actor, so the integrator that
 * mirrors a space by its `file.deleted` events kept the files for ever, while the same files deleted one at a time were announced. The
 * docs said "a directory delete fires no webhook". Whether it fires is the product's decision (N events, the existing event's contract),
 * and the decision is: one `file.deleted` per live top-level row the cascade retires.
 *
 * ## What is held, on every door that deletes a directory
 *
 *  - REST `DELETE`, `POST /api/delete_file` and MCP `delete_file` each announce EXACTLY the live top-level files that were under the
 *    directory, each once, as a webhook dispatch AND on the in-process bus that drives the live Files page. Not the conversion sidecar
 *    (`_converted/…`), not a derived row (`path#chunk-0`), not a row a soft delete had already flagged: those are not files a subscriber
 *    was ever told about, or were told were gone. Read by the PATH in the payload, so one subscription tells every file apart and a
 *    duplicate is a failure.
 *  - With soft deletion of file records ON (the rows are flagged, not removed) the same set is announced.
 *  - A delete a failure stopped between the tree and the rows, and its retry, announce each file once between them: at-most-once, as the
 *    single-file delete is (a retry of a delete that completed is not a second announcement).
 *  - A directory delete made with NO actor (the shape every internal caller has) announces nothing, on the webhook and on the bus.
 *
 * The negatives are read only after a control dispatch has been seen (`acts.webhooks().control()`), so "nothing was announced" cannot
 * be a read that came before the dispatcher's own asynchronous hop. The subscription points at an address the SSRF guard refuses at once,
 * so a dispatch leaves a retry row that carries the payload: that row is the dispatch's own record (`a-byte-arrival-emits-nothing-db`).
 *
 * ## Seen red
 *
 * On the base a directory delete dispatches and publishes nothing, so every positive case fails; the no-actor case and the one-file
 * control are green on it (they state what the change must keep).
 *
 * Run: node --test testing/standalone/a-directory-delete-announces-each-file-it-removed-db.test.js
 * (requires the harness Mongo and a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { driverWriteFailures, failWrites } from './_write-faults.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'dirannounce';
const FILES = `${S}_files`;
const DOORS = ['REST', 'TOOL', 'MCP'];
const T0 = '2026-09-01T00:00:00.000Z';
/** The live top-level files of the directory the cases delete: what a subscriber must be told, once each. */
const ANNOUNCED = Object.freeze(['t/a.txt', 't/c.pdf', 't/sub/b.txt']);

let acts, cap, loader, cascade, F, faults;
const files = () => acts.door.coll(S, 'files');

/** One directory delete through `via`, confirmed. */
const del = (via, p) => via === 'REST' ? acts.rest('DELETE', { path: p }, { confirm: true })
  : via === 'TOOL' ? acts.tool('delete_file', { path: p, confirm: true })
  : acts.mcp('delete_file', { path: p, confirm: true });

/**
 * What was announced, read after it has all arrived: a control dispatch is made and waited for, then every announcement the act owed
 * (the dispatcher's hops are asynchronous per event, so the control's row can land before an earlier event's), then a second control, so
 * a late duplicate has had its chance to land before the set is read. Returns the paths dispatched and published as `file.deleted`, with
 * the two controls' paths in them.
 */
async function announced(owed) {
  const first = await cap.control();
  await waitFor(async () => (await cap.pathsOf('file.deleted')).length >= owed.length + 1, 15_000, 50,
    async () => `${owed.length} announcements were owed and the dispatches are ${JSON.stringify(await cap.pathsOf('file.deleted'))}`, { what: 'every announcement the act owed' });
  const second = await cap.control();
  return { dispatched: await cap.pathsOf('file.deleted'), published: cap.busPathsOf('file.deleted'), controls: [first, second] };
}

/**
 * A directory `t` of three live files, a converted file's sidecar, a derived row, and the audit row of a file an earlier delete flagged:
 * the rows a directory delete meets, of which exactly the live top-level files are announced.
 */
async function seedDirectory() {
  for (const p of ANNOUNCED) await acts.seed(p);
  await acts.seed('_converted/t/c.pdf.md', { parentFileId: 't/c.pdf' });
  await files().insertOne({ _id: 't/a.txt#chunk-0', spaceId: S, path: 't/a.txt#chunk-0', parentFileId: 't/a.txt', content: 'c', tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 1 });
  await files().insertOne({ _id: 't/old.txt', spaceId: S, path: 't/old.txt', tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 3, deletedAt: '2026-08-01T00:00:00.000Z' });
}

describe('a directory delete announces each file it removed (Q-469)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'dirannounce', space: S });
    cap = await acts.webhooks();
    loader = await import('../../server/dist/config/loader.js');
    cascade = await import('../../server/dist/files/delete-cascade.js');
    F = await driverWriteFailures('ythril_harness_dirannounce');
    faults = failWrites(Object.getPrototypeOf(acts.door.mongo.col('probe')), ['insertMany', 'deleteOne', 'deleteMany']);
  });
  after(async () => {
    faults?.restore();
    if (loader) loader.getConfig().softDeleteFileMeta = false;
    await cap?.close();
    await acts?.close();
  });
  beforeEach(async () => {
    faults.clear();
    await acts.reset();
    await acts.links.reset();
    await acts.door.mongo.col('_webhook_retry_queue').deleteMany({});
    cap.clear();
  });
  afterEach(() => { faults.clear(); loader.getConfig().softDeleteFileMeta = false; });

  for (const softDelete of [false, true]) {
    for (const via of DOORS) {
      it(`${via}${softDelete ? ' (file records are soft-deleted)' : ''}: one file.deleted per live top-level file, each once, as a dispatch and on the bus — not sidecars, derived rows or flagged rows`, async () => {
        loader.getConfig().softDeleteFileMeta = softDelete;
        await seedDirectory();

        const a = await del(via, 't');
        assert.ok(!acts.failed(a), `the delete was refused: ${JSON.stringify(a.body ?? a.sc ?? a.text)}`);
        assert.equal(acts.onDisk('t'), false, 'fixture: the directory was not deleted');

        const { dispatched, published, controls } = await announced(ANNOUNCED);

        assert.deepEqual(dispatched, [...ANNOUNCED, ...controls].sort(),
          'the dispatches are not exactly the live top-level files of the directory, each once (a sidecar, a derived or a flagged row announced, a file missed, or one announced twice)');
        assert.deepEqual(published, [...ANNOUNCED, ...controls].sort(), 'the live Files page was told of something else than the files the delete removed');
      });
    }
  }

  it('a delete a store failure stopped between the tree and the rows, and its retry, announce each file once between them', async () => {
    await seedDirectory();
    // The rows are the last thing a directory delete removes: the failure takes the delete there, with the tree gone and the rows kept.
    faults.fail('deleteMany', FILES, F.storeGone.single);
    const first = await del('REST', 't');
    assert.equal(faults.fired('deleteMany', FILES), 1, 'the fault was never reached: the case is not the one it is about');
    assert.equal(acts.statusOf(first), 503, `the delete was not stopped by the store: ${JSON.stringify(first.body)}`);
    faults.clear();
    const retry = await del('REST', 't');
    assert.ok(!acts.failed(retry), `the retry was refused: ${JSON.stringify(retry.body)}`);

    const { dispatched, controls } = await announced(ANNOUNCED);

    assert.deepEqual(dispatched, [...ANNOUNCED, ...controls].sort(),
      'the two attempts did not announce each file exactly once between them (a file announced by the attempt that failed and again by the retry, or by neither)');
  });

  it('a delete made with no actor — every internal caller — announces nothing, on the webhook and on the bus', async () => {
    await seedDirectory();
    const kind = await cascade.deletePath(S, 't', { confirm: true });
    assert.equal(kind, 'directory', 'fixture: the directory was not deleted');
    assert.equal(acts.onDisk('t'), false, 'fixture: the directory is still on disk');

    const { dispatched, published, controls } = await announced([]);

    assert.deepEqual(dispatched, [...controls].sort(), 'a directory delete nobody made dispatched a file.deleted');
    assert.deepEqual(published, [...controls].sort(), 'a directory delete nobody made was published to the live view');
  });

  it('control: a file deleted by itself is still announced once (the rule the directory delete follows)', async () => {
    await acts.seed('solo.txt');
    const a = await del('MCP', 'solo.txt');
    assert.ok(!acts.failed(a), a.text);
    const { dispatched, controls } = await announced(['solo.txt']);
    assert.deepEqual(dispatched, ['solo.txt', ...controls].sort());
  });
});
