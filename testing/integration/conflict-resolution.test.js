/**
 * Integration tests: Conflict Resolution Actions  (/api/conflicts/:id/resolve)
 *
 * Covers:
 *  - POST /api/conflicts/:id/resolve  { action: "keep-local" }
 *  - POST /api/conflicts/:id/resolve  { action: "keep-incoming" }
 *  - POST /api/conflicts/:id/resolve  { action: "keep-both" }
 *  - POST /api/conflicts/:id/resolve  { action: "keep-both", rename }
 *  - POST /api/conflicts/:id/resolve  { action: "save-to-space", targetSpaceId }
 *  - POST /api/conflicts/:id/resolve  { action: "save-to-space", targetSpaceId, rename }
 *  - POST /api/conflicts/bulk-resolve  { ids, action }
 *  - Validation: missing action → 400
 *  - Validation: invalid action → 400
 *  - Validation: save-to-space without targetSpaceId → 400
 *  - Validation: save-to-space with inaccessible targetSpaceId → 403
 *  - Validation: resolve non-existent conflict → 404
 *  - Validation: bulk-resolve empty ids → 400
 *
 * Strategy: seed ConflictDoc records directly into MongoDB via the sync
 * batch-upsert endpoint (which writes to <space>_conflicts), and create
 * corresponding files via the file upload API. This avoids needing actual
 * cross-instance sync for predictable, fast testing.
 *
 * Run: node --test testing/integration/conflict-resolution.test.js
 * Pre-requisite: docker compose -f testing/docker-compose.test.yml up && node testing/sync/setup.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');

let tokenA;
const RUN = Date.now();
let targetSpaceId; // created per test suite for save-to-space tests

// ── Helpers ──────────────────────────────────────────────────────────

/** Upload a text file to a space on instance A */
async function uploadFile(spaceId, filePath, content) {
  const url = `${INSTANCES.a}/api/files/${spaceId}?path=${encodeURIComponent(filePath)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ content, encoding: 'utf8' }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** Download a file from a space on instance A. Returns text body. */
async function downloadFile(spaceId, filePath) {
  const url = `${INSTANCES.a}/api/files/${spaceId}?path=${encodeURIComponent(filePath)}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  if (r.status !== 200) return { status: r.status, body: null };
  const ct = r.headers.get('content-type') || '';
  const body = ct.includes('application/json') ? await r.json() : await r.text();
  return { status: r.status, body };
}

/** Check if a file exists (200) or not (404) */
async function fileExists(spaceId, filePath) {
  const r = await downloadFile(spaceId, filePath);
  return r.status === 200;
}

/** Seed a conflict record via /api/conflicts/seed */
async function seedConflict(spaceId, originalPath, conflictPath) {
  const id = `conflict-${RUN}-${randomUUID().slice(0, 8)}`;
  const r = await post(INSTANCES.a, tokenA, '/api/conflicts/seed', {
    _id: id,
    spaceId,
    originalPath,
    conflictPath,
    peerInstanceId: 'test-peer',
    peerInstanceLabel: 'Test Peer',
    detectedAt: new Date().toISOString(),
  });
  if (r.status !== 201) return null;
  return id;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Conflict Resolution Actions', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();

    // Create a target space for save-to-space tests
    const r = await post(INSTANCES.a, tokenA, '/api/spaces', {
      label: `CR Target Space ${RUN}`,
    });
    assert.equal(r.status, 201, `Create target space: ${JSON.stringify(r.body)}`);
    targetSpaceId = r.body.space?.id;
    assert.ok(targetSpaceId, 'Target space ID must be returned');
  });

  describe('Validation', () => {
    it('resolve with missing action → 400', async () => {
      const r = await post(INSTANCES.a, tokenA, '/api/conflicts/fake-id/resolve', {});
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.ok(r.body.error, 'Should have error message');
    });

    it('resolve with invalid action → 400', async () => {
      const r = await post(INSTANCES.a, tokenA, '/api/conflicts/fake-id/resolve', {
        action: 'delete-everything',
      });
      assert.equal(r.status, 400, JSON.stringify(r.body));
    });

    it('resolve non-existent conflict → 404', async () => {
      const r = await post(INSTANCES.a, tokenA, '/api/conflicts/nonexistent-id/resolve', {
        action: 'keep-local',
      });
      assert.equal(r.status, 404, JSON.stringify(r.body));
    });

    it('save-to-space without targetSpaceId → 400', async () => {
      const r = await post(INSTANCES.a, tokenA, '/api/conflicts/fake-id/resolve', {
        action: 'save-to-space',
      });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error, /targetSpaceId/i);
    });

    it('bulk-resolve with empty ids → 400', async () => {
      const r = await post(INSTANCES.a, tokenA, '/api/conflicts/bulk-resolve', {
        ids: [],
        action: 'keep-local',
      });
      assert.equal(r.status, 400, JSON.stringify(r.body));
    });

    it('bulk-resolve without action → 400', async () => {
      const r = await post(INSTANCES.a, tokenA, '/api/conflicts/bulk-resolve', {
        ids: ['some-id'],
      });
      assert.equal(r.status, 400, JSON.stringify(r.body));
    });
  });

  describe('keep-local', () => {
    it('deletes conflict file, keeps original, removes record', async (t) => {
      const origPath = `cr-local-orig-${RUN}.txt`;
      const confPath = `cr-local-conf-${RUN}.txt`;

      // Create both files
      const u1 = await uploadFile('general', origPath, 'local version');
      assert.ok([201, 202].includes(u1.status), `Upload original: ${JSON.stringify(u1.body)}`);
      const u2 = await uploadFile('general', confPath, 'incoming version');
      assert.ok([201, 202].includes(u2.status), `Upload conflict: ${JSON.stringify(u2.body)}`);

      // Seed conflict record
      const conflictId = await seedConflict('general', origPath, confPath);
      if (!conflictId) { t.skip('Could not seed conflict'); return; }

      // Resolve: keep-local
      const r = await post(INSTANCES.a, tokenA, `/api/conflicts/${conflictId}/resolve`, {
        action: 'keep-local',
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.status, 'resolved');

      // Verify: original still exists with local content
      const orig = await downloadFile('general', origPath);
      assert.equal(orig.status, 200);
      assert.equal(orig.body, 'local version');

      // Verify: conflict file deleted
      const conf = await fileExists('general', confPath);
      assert.equal(conf, false, 'Conflict file should be deleted');

      // Verify: conflict record gone
      const check = await get(INSTANCES.a, tokenA, `/api/conflicts/${conflictId}`);
      assert.equal(check.status, 404);
    });
  });

  describe('keep-incoming', () => {
    it('replaces original with conflict copy, removes record', async (t) => {
      const origPath = `cr-incoming-orig-${RUN}.txt`;
      const confPath = `cr-incoming-conf-${RUN}.txt`;

      await uploadFile('general', origPath, 'local version');
      await uploadFile('general', confPath, 'incoming version');

      const conflictId = await seedConflict('general', origPath, confPath);
      if (!conflictId) { t.skip('Could not seed conflict'); return; }

      const r = await post(INSTANCES.a, tokenA, `/api/conflicts/${conflictId}/resolve`, {
        action: 'keep-incoming',
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.status, 'resolved');

      // Verify: original now has incoming content
      const orig = await downloadFile('general', origPath);
      assert.equal(orig.status, 200);
      assert.equal(orig.body, 'incoming version');

      // Verify: conflict file deleted
      const conf = await fileExists('general', confPath);
      assert.equal(conf, false, 'Conflict file should be deleted');

      // Verify: record gone
      const check = await get(INSTANCES.a, tokenA, `/api/conflicts/${conflictId}`);
      assert.equal(check.status, 404);
    });
  });

  describe('keep-both', () => {
    it('keeps both files, removes record', async (t) => {
      const origPath = `cr-both-orig-${RUN}.txt`;
      const confPath = `cr-both-conf-${RUN}.txt`;

      await uploadFile('general', origPath, 'local version');
      await uploadFile('general', confPath, 'incoming version');

      const conflictId = await seedConflict('general', origPath, confPath);
      if (!conflictId) { t.skip('Could not seed conflict'); return; }

      const r = await post(INSTANCES.a, tokenA, `/api/conflicts/${conflictId}/resolve`, {
        action: 'keep-both',
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));

      // Verify: both files still exist
      const orig = await downloadFile('general', origPath);
      assert.equal(orig.status, 200);
      assert.equal(orig.body, 'local version');

      const conf = await downloadFile('general', confPath);
      assert.equal(conf.status, 200);
      assert.equal(conf.body, 'incoming version');

      // Verify: record gone
      const check = await get(INSTANCES.a, tokenA, `/api/conflicts/${conflictId}`);
      assert.equal(check.status, 404);
    });

    it('with rename: renames conflict file', async (t) => {
      const origPath = `cr-both-rename-orig-${RUN}.txt`;
      const confPath = `cr-both-rename-conf-${RUN}.txt`;
      const renameTo = `cr-both-renamed-${RUN}.txt`;

      await uploadFile('general', origPath, 'local version');
      await uploadFile('general', confPath, 'incoming version');

      const conflictId = await seedConflict('general', origPath, confPath);
      if (!conflictId) { t.skip('Could not seed conflict'); return; }

      const r = await post(INSTANCES.a, tokenA, `/api/conflicts/${conflictId}/resolve`, {
        action: 'keep-both',
        rename: renameTo,
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));

      // Verify: original untouched
      const orig = await downloadFile('general', origPath);
      assert.equal(orig.status, 200);
      assert.equal(orig.body, 'local version');

      // Verify: conflict file renamed
      const oldConf = await fileExists('general', confPath);
      assert.equal(oldConf, false, 'Old conflict path should not exist');

      const renamed = await downloadFile('general', renameTo);
      assert.equal(renamed.status, 200);
      assert.equal(renamed.body, 'incoming version');

      // Verify: record gone
      const check = await get(INSTANCES.a, tokenA, `/api/conflicts/${conflictId}`);
      assert.equal(check.status, 404);
    });
  });

  describe('save-to-space', () => {
    it('copies conflict file to target space, deletes from source, removes record', async (t) => {
      const origPath = `cr-save-orig-${RUN}.txt`;
      const confPath = `cr-save-conf-${RUN}.txt`;

      await uploadFile('general', origPath, 'local version');
      await uploadFile('general', confPath, 'incoming version');

      const conflictId = await seedConflict('general', origPath, confPath);
      if (!conflictId) { t.skip('Could not seed conflict'); return; }

      // Resolve: save conflict copy to target space
      const r = await post(INSTANCES.a, tokenA, `/api/conflicts/${conflictId}/resolve`, {
        action: 'save-to-space',
        targetSpaceId,
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.status, 'resolved');

      // Verify: original still in source space
      const orig = await downloadFile('general', origPath);
      assert.equal(orig.status, 200);
      assert.equal(orig.body, 'local version');

      // Verify: conflict file removed from source space
      const confGone = await fileExists('general', confPath);
      assert.equal(confGone, false, 'Conflict file should be removed from source space');

      // Verify: conflict file now in target space at same relative path
      const saved = await downloadFile(targetSpaceId, confPath);
      assert.equal(saved.status, 200);
      assert.equal(saved.body, 'incoming version');

      // Verify: record gone
      const check = await get(INSTANCES.a, tokenA, `/api/conflicts/${conflictId}`);
      assert.equal(check.status, 404);
    });

    it('with rename: saves to target space under new name', async (t) => {
      const origPath = `cr-save-rename-orig-${RUN}.txt`;
      const confPath = `cr-save-rename-conf-${RUN}.txt`;
      const renameTo = `cr-save-renamed-${RUN}.txt`;

      await uploadFile('general', origPath, 'local version');
      await uploadFile('general', confPath, 'incoming version');

      const conflictId = await seedConflict('general', origPath, confPath);
      if (!conflictId) { t.skip('Could not seed conflict'); return; }

      const r = await post(INSTANCES.a, tokenA, `/api/conflicts/${conflictId}/resolve`, {
        action: 'save-to-space',
        targetSpaceId,
        rename: renameTo,
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));

      // Verify: saved under the rename path in target space
      const saved = await downloadFile(targetSpaceId, renameTo);
      assert.equal(saved.status, 200);
      assert.equal(saved.body, 'incoming version');

      // Verify: conflict file removed from source space
      const confGone = await fileExists('general', confPath);
      assert.equal(confGone, false);
    });

    it('rejects inaccessible targetSpaceId → 403', async (t) => {
      const origPath = `cr-save-noaccess-orig-${RUN}.txt`;
      const confPath = `cr-save-noaccess-conf-${RUN}.txt`;

      await uploadFile('general', origPath, 'local version');
      await uploadFile('general', confPath, 'incoming version');

      const conflictId = await seedConflict('general', origPath, confPath);
      if (!conflictId) { t.skip('Could not seed conflict'); return; }

      // Use a non-existent space name
      const r = await post(INSTANCES.a, tokenA, `/api/conflicts/${conflictId}/resolve`, {
        action: 'save-to-space',
        targetSpaceId: 'nonexistent-space-xyz',
      });
      assert.equal(r.status, 403, JSON.stringify(r.body));
    });
  });

  describe('bulk-resolve', () => {
    it('resolves multiple conflicts with keep-local', async (t) => {
      const conflicts = [];
      for (let i = 0; i < 3; i++) {
        const origPath = `cr-bulk-orig-${i}-${RUN}.txt`;
        const confPath = `cr-bulk-conf-${i}-${RUN}.txt`;
        await uploadFile('general', origPath, `local-${i}`);
        await uploadFile('general', confPath, `incoming-${i}`);
        const id = await seedConflict('general', origPath, confPath);
        if (!id) { t.skip(`Could not seed conflict ${i}`); return; }
        conflicts.push({ id, origPath, confPath });
      }

      const r = await post(INSTANCES.a, tokenA, '/api/conflicts/bulk-resolve', {
        ids: conflicts.map(c => c.id),
        action: 'keep-local',
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.resolved, 3);
      assert.ok(Array.isArray(r.body.failed));
      assert.equal(r.body.failed.length, 0);

      // Verify all conflict files are deleted, originals untouched
      for (const c of conflicts) {
        const orig = await downloadFile('general', c.origPath);
        assert.equal(orig.status, 200, `Original ${c.origPath} should still exist`);
        const conf = await fileExists('general', c.confPath);
        assert.equal(conf, false, `Conflict ${c.confPath} should be deleted`);
      }
    });

    it('returns partial results when some conflicts fail', async (t) => {
      const origPath = `cr-bulk-partial-orig-${RUN}.txt`;
      const confPath = `cr-bulk-partial-conf-${RUN}.txt`;
      await uploadFile('general', origPath, 'local');
      await uploadFile('general', confPath, 'incoming');
      const validId = await seedConflict('general', origPath, confPath);
      if (!validId) { t.skip('Could not seed conflict'); return; }

      const r = await post(INSTANCES.a, tokenA, '/api/conflicts/bulk-resolve', {
        ids: [validId, 'nonexistent-conflict-id'],
        action: 'keep-local',
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.resolved, 1);
      assert.equal(r.body.failed.length, 1);
      assert.equal(r.body.failed[0].id, 'nonexistent-conflict-id');
    });
  });
});
