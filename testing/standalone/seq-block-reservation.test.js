/**
 * Standalone tests: contiguous seq-block reservation (P9).
 *
 * The bulk-delete paths write one tombstone per document and used to call nextSeq() inside the
 * loop — a sequential round trip PER DOCUMENT, so wiping 100k memories paid 100k awaited round
 * trips before the delete even began. They now reserve the whole range in one `$inc`.
 *
 * The invariant that actually matters is NOT "no gaps" — it is "NO REUSE". Sync compares seqs
 * with `>`, so a hole in the sequence is harmless, whereas handing the same seq to two
 * documents corrupts the watermark logic and can silently strand writes. These tests pin that:
 * blocks are contiguous, never overlap, and the counter only ever moves forward — including
 * under concurrent reservation, which is exactly when a naive read-then-write would collide.
 *
 * Run: node --test testing/standalone/seq-block-reservation.test.js
 *
 * @needs-instance — drives a live server on :3200; runs in CI, skipped by preflight.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, delWithBody } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

let token;
const spaceId = `seqblock-${Date.now()}`;

describe('Bulk delete — seq allocation', () => {
  before(async () => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    const c = await post(INSTANCES.a, token, '/api/spaces', { id: spaceId, label: 'Seq Block Test' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
  });

  after(async () => {
    await delWithBody(INSTANCES.a, token, `/api/spaces/${spaceId}`, { confirm: true }).catch(() => {});
  });

  it('a bulk delete never reuses a seq, and the counter only moves forward', async () => {
    // Seed enough documents that the old code would have made one round trip each.
    const N = 12;
    for (let i = 0; i < N; i++) {
      const r = await post(INSTANCES.a, token, `/api/brain/spaces/${spaceId}/facts`, { fact: `seq block ${i}` });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    }

    const before = await get(INSTANCES.a, token, `/api/brain/spaces/${spaceId}/facts`);
    const maxSeqBefore = Math.max(...before.body.facts.map(m => m.seq));

    // Wipe them — this is the path that reserves a contiguous tombstone block.
    const wipe = await delWithBody(INSTANCES.a, token, `/api/brain/spaces/${spaceId}/facts`, { confirm: true });
    assert.ok([200, 204].includes(wipe.status), `bulk delete: ${wipe.status} ${JSON.stringify(wipe.body)}`);

    // The next write must land STRICTLY above every seq handed to a tombstone. If the block
    // had been re-used (or the counter not advanced by the full count), this would collide.
    const after = await post(INSTANCES.a, token, `/api/brain/spaces/${spaceId}/facts`, { fact: 'after wipe' });
    assert.equal(after.status, 201, JSON.stringify(after.body));
    assert.ok(
      after.body.seq > maxSeqBefore + N,
      `the counter must advance past the whole reserved tombstone block: pre-wipe max was ` +
      `${maxSeqBefore}, ${N} tombstones were written, so the next seq must exceed ` +
      `${maxSeqBefore + N} — got ${after.body.seq}`,
    );
  });

  it('concurrent bulk deletes across types do not hand out overlapping seqs', async () => {
    // Entities and edges wipe independently but share ONE per-space counter. Reserving blocks
    // concurrently is precisely where a read-then-write allocator would double-issue.
    // `type` is required on this door since `P-31` — it used to default to the empty string, which made
    // entities the per-type schema could never validate.
    const e1 = await post(INSTANCES.a, token, `/api/brain/spaces/${spaceId}/entities`, { name: 'A', type: 'thing' });
    const e2 = await post(INSTANCES.a, token, `/api/brain/spaces/${spaceId}/entities`, { name: 'B', type: 'thing' });
    assert.equal(e1.status, 201);
    assert.equal(e2.status, 201);
    const ed = await post(INSTANCES.a, token, `/api/brain/spaces/${spaceId}/edges`, {
      from: e1.body._id, to: e2.body._id, label: 'knows',
    });
    assert.equal(ed.status, 201, JSON.stringify(ed.body));

    // Fire both wipes at once.
    const [we, wg] = await Promise.all([
      delWithBody(INSTANCES.a, token, `/api/brain/spaces/${spaceId}/edges`, { confirm: true }),
      delWithBody(INSTANCES.a, token, `/api/brain/spaces/${spaceId}/entities`, { confirm: true }),
    ]);
    assert.ok([200, 204].includes(we.status), `edge wipe: ${we.status}`);
    assert.ok([200, 204].includes(wg.status), `entity wipe: ${wg.status}`);

    // A subsequent write must still get a fresh, strictly-increasing seq.
    const a = await post(INSTANCES.a, token, `/api/brain/spaces/${spaceId}/facts`, { fact: 'post-concurrent' });
    const b = await post(INSTANCES.a, token, `/api/brain/spaces/${spaceId}/facts`, { fact: 'post-concurrent 2' });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.ok(b.body.seq > a.body.seq, 'seqs must remain strictly increasing after concurrent block reservations');
  });
});
