/**
 * A file record the absent-bytes sweep removed on one instance comes back WHOLE from a peer that still holds the file — its bytes by the file
 * pull, its tags by the merkle re-read — and a record no peer has bytes for is offered back by the merkle re-read and waits again, never
 * erasing anything elsewhere (bundle-70, Q-337, slice S4: the two sync-suite cases the design owed).
 *
 * ## What it prevents
 *
 * The sweep removes a record HERE only: a feed marker carrying `retiredBy: 'bytes-lost'`, no tombstone. Two promises rest on that and only an
 * exchange between real instances can show them:
 *
 *  - **re-delivery restores the record whole.** File sync fetches any file this side lacks (`decideFilePull(undefined, remote) = 'write'`), but
 *    an arrival of bytes makes a row with no tags. What a person wrote on the record (its tags) comes back through the merkle mismatch the
 *    missing row causes and the re-read it triggers. A removal that wrote a tombstone, or a marker the re-read skipped, would lose them.
 *  - **the merkle bounce is bounded and harmless.** A peer that keeps a record whose bytes NOBODY has offers it back through the re-read; it lands
 *    here as a live record, waits out its window, and goes again. It must never make the PEER lose its row (no tombstone travels).
 *
 * ## How it is driven
 *
 * Two instances on one mirrored network. The sweep's removal is produced on B directly in its database, exactly as the sweep leaves it (the bytes
 * unlinked, the row replaced by a `bytes-lost` feed marker, no tombstone): the sweep's own decision is a day's window and is held by the
 * standalone suites (`the-absent-bytes-sweep-removes-only-real-orphans-db`); this file holds what the network does with its result.
 *
 * Written, not run, by the slice that added it: it needs the instance stack (CI runs it).
 *
 * Run: node --test testing/sync/a-record-the-absent-bytes-sweep-removed-comes-back-whole-from-its-peer.test.js (with the sync stack up)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTANCES, createTestSpace, mirroredNetwork, post, dockerExec, waitFor } from './helpers.js';
import { mongoEval } from '../_shared/space-footprint.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const read = (x) => fs.readFileSync(path.join(CONFIGS, x, 'token.txt'), 'utf8').trim();

let tA, tB, space, net;

async function upload(base, token, p, content, tags) {
  const r = await fetch(`${base}/api/files/${space.id}?path=${encodeURIComponent(p)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ content }),
  });
  assert.ok(r.status < 300, `upload ${p}: ${r.status}`);
  if (tags) {
    const t = await fetch(`${base}/api/brain/spaces/${space.id}/files?path=${encodeURIComponent(p)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ tags }),
    });
    assert.ok(t.status < 300, `tag ${p}: ${t.status}`);
  }
}
const hasBytes = async (base, token, p) => (await fetch(`${base}/api/files/${space.id}?path=${encodeURIComponent(p)}`, { headers: { Authorization: `Bearer ${token}` } })).status === 200;
const rowOn = (x, p) => mongoEval(x, `print(JSON.stringify(d.getCollection(${JSON.stringify(`${space.id}_files`)}).findOne({ _id: ${JSON.stringify(p)} })))`);
const tombstonesOn = (x, p) => mongoEval(x, `print(JSON.stringify(d.getCollection(${JSON.stringify(`${space.id}_file_tombstones`)}).find({ path: ${JSON.stringify(p)} }).toArray()))`);

/**
 * What the sweep leaves on `x` for `p`: the bytes gone, the row a `bytes-lost` feed marker, no tombstone. The marker is written
 * into the database directly, which does not move the server's Merkle cache stamp ("a write this process makes, or a database
 * replaced under it, moves the stamp": brain/merkle.ts, db/space-generation.ts); the real sweep writes through its own process.
 * So one write through `x`'s server follows, as the sweep's own write would, or `x` answers the check from its cached rows.
 */
async function sweptOn(x, base, token, container, p) {
  dockerExec(`docker exec ${container} rm -f ${JSON.stringify(`/data/files/${space.id}/${p}`)}`);
  mongoEval(x, `
    const c = d.getCollection(${JSON.stringify(`${space.id}_files`)});
    const r = c.findOne({ _id: ${JSON.stringify(p)} });
    c.replaceOne({ _id: r._id }, { _id: r._id, spaceId: r.spaceId, path: r._id, deletedAt: new Date().toISOString(), feedMarker: true, pos: r.pos, posAtSeq: r.seq ?? 0, retiredBy: 'bytes-lost' });
    print('null');
  `);
  await upload(base, token, `stamp-${p}`, 'moves the files stamp the way the sweep\'s own write does');
}
async function round() {
  for (const [base, token] of [[INSTANCES.a, tA], [INSTANCES.b, tB]]) await post(base, token, `/api/networks/${net.networkId}/sync?wait=true`, {});
}

describe('a record the absent-bytes sweep removed, between two instances', () => {
  before(async () => {
    [tA, tB] = ['a', 'b'].map(read);
    space = await createTestSpace('absent-bytes', [[INSTANCES.a, tA], [INSTANCES.b, tB]]);
    // The Merkle check is opt-in, and the re-read both cases rest on runs only after a check found the roots differ (`sync/file-meta-reread.ts`).
    net = await mirroredNetwork({ label: `absent-bytes-${RUN}`, spaces: [space.id], a: [INSTANCES.a, tA], b: [INSTANCES.b, tB], merkle: true });
  });
  after(async () => { await net?.remove?.().catch(() => {}); await space?.remove?.().catch(() => {}); });

  it('peer re-delivery brings the bytes back, and the merkle re-read brings the tags back: the record is whole again', async () => {
    const p = `kept-${RUN}.txt`;
    await upload(INSTANCES.a, tA, p, 'bytes A still holds', ['person-wrote-this']);
    await waitFor(async () => { await round(); return (await hasBytes(INSTANCES.b, tB, p)) && (rowOn('b', p)?.tags ?? []).includes('person-wrote-this'); },
      120_000, 1_000, 'B never received the file with its tags');

    await sweptOn('b', INSTANCES.b, tB, 'ythril-b', p);
    assert.equal(rowOn('b', p)?.feedMarker, true, 'fixture: the sweep\'s removal was not produced on B');

    await waitFor(async () => { await round(); const r = rowOn('b', p); return (await hasBytes(INSTANCES.b, tB, p)) && r && r.feedMarker !== true && (r.tags ?? []).includes('person-wrote-this'); },
      180_000, 1_000, () => `B's record did not come back whole: ${JSON.stringify(rowOn('b', p))}`);
    assert.deepEqual(tombstonesOn('a', p), [], 'a tombstone reached A: the sweep\'s removal was published as a delete');
    assert.ok(await hasBytes(INSTANCES.a, tA, p), 'A lost its own copy');
  });

  it('the merkle bounce: a record whose bytes nobody has is offered back to B, lands live, and A keeps its row', async () => {
    const p = `bounced-${RUN}.txt`;
    await upload(INSTANCES.a, tA, p, 'bytes that will be lost everywhere', ['bounce']);
    await waitFor(async () => { await round(); return hasBytes(INSTANCES.b, tB, p); }, 120_000, 1_000, 'B never received the file');
    // The bytes go on A too, behind the sync's back (a lost volume): A keeps a record nobody has bytes for.
    dockerExec(`docker exec ythril-a rm -f ${JSON.stringify(`/data/files/${space.id}/${p}`)}`);
    await sweptOn('b', INSTANCES.b, tB, 'ythril-b', p);

    await waitFor(async () => { await round(); const r = rowOn('b', p); return r && r.feedMarker !== true; },
      180_000, 1_000, () => `A's record was not offered back to B by the re-read: ${JSON.stringify(rowOn('b', p))}`);
    const a = rowOn('a', p);
    assert.ok(a && a.feedMarker !== true && a.deletedAt === undefined, `A lost its row: ${JSON.stringify(a)}`);
    assert.deepEqual(tombstonesOn('a', p), [], 'a tombstone reached A');
    assert.equal(await hasBytes(INSTANCES.b, tB, p), false, 'fixture: bytes appeared on B though nobody had them');
  });
});
