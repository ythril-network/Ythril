/**
 * Every writer of a space's file tree that asks the write gate is COUNTED by the fence from that moment (bundle-106 PR A, lens finding F1's
 * other sites; X2, §2.6b, §3.3a). The file door's four writers are held by `a-registered-space-act-closes-every-writer-db` (R-X2h); this holds
 * the others the derivation in `every-transfer-enters-the-fence` found: a chunked upload's staging and its assembly, and a conflict
 * resolution's two placements into the tree.
 *
 * ## The rule, and where it was broken
 *
 * A deletion or wipe registers, waits for the write units ADMITTED before it, then empties the tree. A writer that asked the gate, awaited
 * its path resolution or its staging directory, and entered no fence was admitted and invisible: the act saw no unit in flight, deleted, and
 * the write landed in what it had just emptied. Each row stands inside that window (the writer's first await after its check is parked on a
 * latch), registers a wipe there, and asserts what the drain does: it WAITS for the write, the write admitted before the registration
 * completes, a write begun after is refused `409` and leaves no count.
 *
 * ## How a writer's first await is parked
 *
 * By the file system's own function, one shot, matched on the path the writer is working on, so an earlier step of the same request (the
 * route resolving the conflict's own copy) does not take the latch. The real function is put back in a `finally`.
 *
 * ## Seen red
 *
 * On the base none of the four enters the fence: the count read inside the window is 0 for each.
 *
 * Run: node --test testing/standalone/a-file-tree-write-that-asks-the-gate-is-counted-db.test.js (a Mongo the harness accepts; a prior `npm run build:server`)
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { seedActEntry, clearActEntries, deferred } from './_space-act-harness.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
const S = 'treecount';

/** Park the NEXT call of `fsp[name]` whose first argument contains `marker`, behind a latch; every other call goes through. One shot. */
function parkNext(name, marker) {
  const real = fsp[name];
  const latch = deferred();
  let armed = true;
  fsp[name] = async function parked(...args) {
    if (armed && String(args[0]).replace(/\\/g, '/').includes(marker)) { armed = false; latch.arrive(); await latch.promise; }
    return real.apply(this, args);
  };
  return { reached: latch.reached, release: latch.release, restore() { fsp[name] = real; latch.release(); } };
}

describe('a file-tree writer that asks the gate is counted from its check', { skip }, () => {
  let acts, loader, gate, fence, chunks;
  before(async () => {
    acts = await openFileActDoors({ suite: 'treecount', space: S });
    loader = await import('../../server/dist/config/loader.js');
    gate = await import('../../server/dist/spaces/space-write-gate.js');
    fence = await import('../../server/dist/sync/space-transfer-fence.js');
    chunks = await import('../../server/dist/files/chunks.js');
  });
  after(async () => { await acts?.close(); });
  afterEach(() => clearActEntries(loader));

  /**
   * One row: `setup` stages what the writer needs, `run` is the writer (it returns a promise), `marker`/`fsName` name the first await to park.
   * `lateRun` is the same writer begun after the registration; it must be refused 409 and leave no count.
   */
  async function row({ name, fsName, marker, run, lateRun, outcomeOf }) {
    const park = parkNext(fsName, marker);
    try {
      const writing = run().then((r) => ({ r }), (err) => ({ err }));
      await park.reached;   // inside the writer's first await: past the gate, before it wrote anything
      assert.equal(fence.spaceTransfersRunning(S), 1, `${name} was admitted by the gate and is not counted by the fence: an act registered now would drain at once and delete under it`);
      await seedActEntry(loader, { kind: 'wipe', localId: S, state: 'registered' });
      let drained = false;
      const drain = fence.awaitSpaceTransfersDrained(S, 60_000).then((r) => { drained = r === 'drained'; return r; });
      for (let i = 0; i < 25; i++) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(drained, false, `the act's drain ended while ${name} was still in flight`);
      park.release();
      assert.equal(await drain, 'drained', 'the drain never ended once the write did');
      const done = await writing;
      assert.equal(outcomeOf(done), true, `the write admitted before the registration did not complete: ${done.err?.message ?? JSON.stringify(done.r)?.slice(0, 200)}`);
      assert.equal(fence.spaceTransfersRunning(S), 0, `${name} left its count behind`);
      const late = await lateRun().then((r) => ({ r }), (err) => ({ err }));
      const refused = late.err ?? (late.r?.code === 409 ? Object.assign(new Error(JSON.stringify(late.r.body)), { code: late.r.body?.code, answered: true }) : null);
      assert.ok(refused, `${name} began after the registration and was not refused: ${JSON.stringify(late.r)?.slice(0, 200)}`);
      if (!refused.answered) assert.ok(gate.isSpaceNotWritable(refused), `${name}'s refusal is not the space-closed refusal: ${refused.message}`);
      assert.equal(refused.code, 'space_being_wiped');
      assert.equal(fence.spaceTransfersRunning(S), 0, `a refused ${name} left a count behind`);
    } finally { park.restore(); }
  }

  it('storeChunk (a chunked upload staging a range)', async () => {
    await row({
      name: 'storeChunk', fsName: 'mkdir', marker: '/.chunks/',
      run: () => chunks.storeChunk(S, 'up/staged.bin', Buffer.from('abc'), 0, 6),
      lateRun: () => chunks.storeChunk(S, 'up/staged2.bin', Buffer.from('abc'), 0, 6),
      outcomeOf: ({ r }) => r?.received === 3,
    });
  });

  it('assembleChunks (a chunked upload writing its assembled file into the tree)', async () => {
    const complete = await chunks.storeChunk(S, 'up/whole.bin', Buffer.from('abc'), 0, 3);
    assert.equal(complete.complete, true, 'the staging that the assembly needs did not complete');
    const complete2 = await chunks.storeChunk(S, 'up/whole2.bin', Buffer.from('abc'), 0, 3);
    assert.equal(complete2.complete, true);
    await row({
      name: 'assembleChunks', fsName: 'readdir', marker: '/.chunks/',
      run: () => chunks.assembleChunks(S, 'up/whole.bin', 3, path.join(acts.rootOf(S), 'up/whole.bin')),
      lateRun: () => chunks.assembleChunks(S, 'up/whole2.bin', 3, path.join(acts.rootOf(S), 'up/whole2.bin')),
      outcomeOf: ({ r }) => typeof r === 'string' && r.length === 64,
    });
  });

  for (const [action, input, marker] of [
    ['keep-both', { rename: 'parked-rename.txt' }, 'parked-rename'],
    ['keep-incoming', {}, 'parked-original'],
  ]) {
    it(`a conflict resolution's placing into the tree (${action}) is counted, answered 200 once admitted and 409 after`, async () => {
      const original = action === 'keep-incoming' ? 'parked-original.txt' : 'doc.txt';
      // The copies' names carry no marker: the route resolves the copy's path before the writer resolves the destination's, and only the
      // destination's is the await being parked.
      const first = await acts.conflicts.seed({ id: `tree-${action}-1`, original, conflict: `copy-${action}-1.conflict-peer.txt` });
      const second = await acts.conflicts.seed({ id: `tree-${action}-2`, original, conflict: `copy-${action}-2.conflict-peer.txt` });
      await row({
        name: `a conflict's ${action}`, fsName: 'realpath', marker,
        run: () => acts.conflicts.resolve(first, action, input),
        lateRun: () => acts.conflicts.resolve(second, action, input),
        outcomeOf: ({ r }) => r?.code === 200,
      });
    });
  }
});
