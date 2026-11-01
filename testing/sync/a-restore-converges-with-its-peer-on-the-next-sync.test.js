/**
 * Between real instances: a space restored from an older backup converges with its peer on the next sync, like an instance back from being offline
 * (bundle-40, `Q-266`, `Q-275`, D-69; plan 2R R5).
 *
 * ## The scenarios
 *
 * A and B share a space over a closed network. A takes a BACKUP (the admin export), then something happens at B that A has already received, and then
 * A restores the backup through the admin import:
 *
 *  1. **B (the record's author) deleted the record after the backup.** A applied B's deletion, so A holds B's tombstone; the restore brings the record back over it. On the
 *     next sync the record is deleted again on A (the network's current state, as for an instance offline since the backup) and B does not get it back.
 *  2. **B changed the record after the backup** (a newer version A had received). The restore replaces A's copy with the backup's older one. On the next
 *     sync A holds B's newer version again, and B still holds it.
 *
 * ## Why this is red on the base
 *
 * The import forgets nothing it received: A's receive mark for B stays past B's deletion and past B's newer version, so B never serves them again and A
 * keeps the restored record (scenario 1) and the backup's older text (scenario 2) for ever. The fix makes the import an act that forgets the space's
 * receive marks, so the next sync re-reads B from the start (the same cost as a re-read).
 *
 * Run:  node --test testing/sync/a-restore-converges-with-its-peer-on-the-next-sync.test.js
 * Pre-requisite: the A/B stack, built from this tree (`npm run test:up`), which runs testing/sync/setup.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import {
  INSTANCES, post, patch, del, req, readRecord, createTestSpace, mirroredNetwork, syncUntil, waitFor,
} from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

let tokenA, tokenB, space, net;

const holds = async (base, token, id) => (await readRecord(base, token, space.id, 'facts', id));
const textOn = async (base, token, id) => (await holds(base, token, id)).body?.fact;

/**
 * A fact written on one instance and synced to the other; resolves its id once both hold it. Its AUTHOR is the writer: only the author's deletion is
 * obeyed by the other instance (the deletion authority), so a test of a peer's deletion has the peer write the record.
 */
async function sharedFact(text, [writerBase, writerToken] = [INSTANCES.a, tokenA]) {
  const w = await post(writerBase, writerToken, `/api/brain/spaces/${space.id}/facts`, { fact: text, tags: ['restore-sync'] });
  assert.equal(w.status, 201, JSON.stringify(w.body));
  const id = w.body._id ?? w.body.id;
  await syncUntil(INSTANCES.a, tokenA, net.networkId,
    async () => (await holds(INSTANCES.a, tokenA, id)).status === 200 && (await holds(INSTANCES.b, tokenB, id)).status === 200, `A and B to hold ${id}`);
  return id;
}

/** The backup of A's space, exactly as the export door answers it. */
async function backupOfA() {
  const r = await req(INSTANCES.a, tokenA, `/api/admin/spaces/${space.id}/export`);
  assert.equal(r.status, 200, `export answered ${r.status}`);
  return r.text();
}

/** Restore a backup into A's space; resolves once the import ended (200 inline, or 202 and the act done). */
async function restoreIntoA(backup) {
  const r = await req(INSTANCES.a, tokenA, `/api/admin/spaces/${space.id}/import`, { method: 'POST', body: backup });
  assert.ok(r.status === 200 || r.status === 202, `import answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

describe('a restore converges with its peer on the next sync, between real instances', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
    space = await createTestSpace('restore-sync', [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB]]);
    net = await mirroredNetwork({ label: `Restore sync ${Date.now()}`, spaces: [space.id], a: [INSTANCES.a, tokenA], b: [INSTANCES.b, tokenB] });
  });
  after(async () => {
    await net?.remove();
    await space?.remove();
  });

  it('a record restored over its peer\'s deletion is deleted again by the next sync, and the peer does not get it back', async () => {
    const id = await sharedFact(`written and later deleted by B ${Date.now()}`, [INSTANCES.b, tokenB]);
    const backup = await backupOfA();
    assert.equal((await del(INSTANCES.b, tokenB, `/api/brain/spaces/${space.id}/facts/${id}`)).status, 204, 'delete the record on B');
    await syncUntil(INSTANCES.a, tokenA, net.networkId, async () => (await holds(INSTANCES.a, tokenA, id)).status === 404, 'B\'s deletion to reach A');

    await restoreIntoA(backup);
    await waitFor(async () => (await holds(INSTANCES.a, tokenA, id)).status === 200, 20_000, 500, () => 'the restore did not bring the record back on A', { what: 'the restore to land on A' });

    await syncUntil(INSTANCES.a, tokenA, net.networkId, async () => (await holds(INSTANCES.a, tokenA, id)).status === 404,
      'the next sync to delete the restored record on A again (B\'s deletion is the network\'s current state)', { timeoutMs: 40_000 });
    assert.equal((await holds(INSTANCES.b, tokenB, id)).status, 404, 'B was given the record back by the restore');
  });

  it('a newer version of a restored record held by the peer wins on the next sync', async () => {
    const id = await sharedFact(`version one ${Date.now()}`);
    const v1 = await textOn(INSTANCES.a, tokenA, id);
    const backup = await backupOfA();
    const newer = `version two, written at B after the backup ${Date.now()}`;
    assert.equal((await patch(INSTANCES.b, tokenB, `/api/brain/spaces/${space.id}/facts/${id}`, { fact: newer })).status, 200, 'update the record on B');
    await syncUntil(INSTANCES.a, tokenA, net.networkId, async () => (await textOn(INSTANCES.a, tokenA, id)) === newer, 'B\'s newer version to reach A');

    await restoreIntoA(backup);
    await waitFor(async () => (await textOn(INSTANCES.a, tokenA, id)) === v1, 20_000, 500, () => 'the restore did not put the backup\'s version back on A', { what: 'the restore to land on A' });

    await syncUntil(INSTANCES.a, tokenA, net.networkId, async () => (await textOn(INSTANCES.a, tokenA, id)) === newer,
      'the next sync to give A the peer\'s newer version again (the restore forgot what it had received)', { timeoutMs: 40_000 });
    assert.equal(await textOn(INSTANCES.b, tokenB, id), newer, 'B lost its newer version to the restored one');
  });
});
