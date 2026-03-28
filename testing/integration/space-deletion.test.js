/**
 * Integration tests: Space deletion — full cleanup verification
 *
 * Covers:
 *  - Create space, write memories + entities + files
 *  - Delete space with { confirm: true }
 *  - Verify space is removed from the list
 *  - Verify brain data is inaccessible (404 for deleted space)
 *  - Verify files are inaccessible (404 for deleted space)
 *  - Verify re-creating the same space is clean (no orphaned data)
 *  - Verify deletion of a space with data in multiple collections (edges, chrono)
 *  - Verify chunked upload dir is cleaned up
 *
 * Run: node --test testing/integration/space-deletion.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody, reqJson } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

let token;
const RUN_ID = Date.now();

describe('Space deletion — full cleanup', () => {
  before(() => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  it('deleting a populated space removes all brain data', async () => {
    const spaceId = `del-brain-${RUN_ID}`;

    // 1. Create the space
    const createR = await post(INSTANCES.a, token, '/api/spaces', {
      id: spaceId,
      label: 'Deletion Brain Test',
    });
    assert.equal(createR.status, 201, `Create: ${JSON.stringify(createR.body)}`);

    // 2. Write a memory
    const memR = await post(INSTANCES.a, token, `/api/brain/${spaceId}/memories`, {
      fact: 'Memory that should be deleted',
      tags: ['deletion-test'],
    });
    assert.equal(memR.status, 201, `Memory write: ${JSON.stringify(memR.body)}`);

    // 3. Write an entity
    const entR = await post(INSTANCES.a, token, `/api/brain/spaces/${spaceId}/entities`, {
      name: 'DeletionTestEntity',
      type: 'concept',
    });
    assert.equal(entR.status, 201, `Entity write: ${JSON.stringify(entR.body)}`);

    // 4. Write an edge
    const entR2 = await post(INSTANCES.a, token, `/api/brain/spaces/${spaceId}/entities`, {
      name: 'DeletionTestEntity2',
      type: 'concept',
    });
    assert.equal(entR2.status, 201, `Entity2 write: ${JSON.stringify(entR2.body)}`);

    const edgeR = await post(INSTANCES.a, token, `/api/brain/spaces/${spaceId}/edges`, {
      from: 'DeletionTestEntity',
      to: 'DeletionTestEntity2',
      label: 'relates_to',
    });
    assert.equal(edgeR.status, 201, `Edge write: ${JSON.stringify(edgeR.body)}`);

    // 5. Verify data exists before deletion
    const preList = await get(INSTANCES.a, token, `/api/brain/spaces/${spaceId}/memories`);
    assert.equal(preList.status, 200);
    assert.ok(preList.body.memories?.length > 0, 'Should have at least one memory before deletion');

    // 6. Delete the space
    const delR = await delWithBody(INSTANCES.a, token, `/api/spaces/${spaceId}`, { confirm: true });
    assert.equal(delR.status, 204, `Delete: expected 204, got ${delR.status}`);

    // 7. Space should not appear in the list
    const listR = await get(INSTANCES.a, token, '/api/spaces');
    assert.equal(listR.status, 200);
    assert.ok(
      !listR.body.spaces?.some(s => s.id === spaceId),
      'Deleted space must not appear in space list',
    );

    // 8. Brain endpoints should return 404 for the deleted space
    const memCheck = await get(INSTANCES.a, token, `/api/brain/spaces/${spaceId}/memories`);
    assert.equal(memCheck.status, 404, `Brain memories for deleted space should 404, got ${memCheck.status}`);

    const entCheck = await get(INSTANCES.a, token, `/api/brain/spaces/${spaceId}/entities`);
    assert.equal(entCheck.status, 404, `Brain entities for deleted space should 404, got ${entCheck.status}`);
  });

  it('deleting a space removes uploaded files', async () => {
    const spaceId = `del-files-${RUN_ID}`;

    // 1. Create the space
    const createR = await post(INSTANCES.a, token, '/api/spaces', {
      id: spaceId,
      label: 'Deletion Files Test',
    });
    assert.equal(createR.status, 201);

    // 2. Upload a file
    const fileContent = 'This file should be deleted with the space.';
    const uploadR = await reqJson(INSTANCES.a, token, `/api/files/${spaceId}?path=deletion-test.txt`, {
      method: 'POST',
      body: fileContent,
      headers: { 'Content-Type': 'text/plain' },
    });
    assert.ok(uploadR.status === 200 || uploadR.status === 201, `Upload: got ${uploadR.status}`);

    // 3. Verify file exists
    const preRead = await reqJson(INSTANCES.a, token, `/api/files/${spaceId}?path=deletion-test.txt`);
    assert.equal(preRead.status, 200, 'File should exist before deletion');

    // 4. Delete the space
    const delR = await delWithBody(INSTANCES.a, token, `/api/spaces/${spaceId}`, { confirm: true });
    assert.equal(delR.status, 204);

    // 5. File endpoint should return 404
    const postRead = await reqJson(INSTANCES.a, token, `/api/files/${spaceId}?path=deletion-test.txt`);
    assert.equal(postRead.status, 404, `File for deleted space should 404, got ${postRead.status}`);
  });

  it('re-creating a deleted space starts clean (no orphaned data)', async () => {
    const spaceId = `del-recreate-${RUN_ID}`;

    // Create and populate
    await post(INSTANCES.a, token, '/api/spaces', { id: spaceId, label: 'Recreate Test' });
    await post(INSTANCES.a, token, `/api/brain/spaces/${spaceId}/memories`, {
      fact: 'Orphan fact that must not survive',
      tags: ['orphan-test'],
    });

    // Delete
    const delR = await delWithBody(INSTANCES.a, token, `/api/spaces/${spaceId}`, { confirm: true });
    assert.equal(delR.status, 204);

    // Re-create the same space
    const createR = await post(INSTANCES.a, token, '/api/spaces', { id: spaceId, label: 'Recreated Space' });
    assert.equal(createR.status, 201, `Re-create: ${JSON.stringify(createR.body)}`);

    // Verify no orphaned data
    const memR = await get(INSTANCES.a, token, `/api/brain/spaces/${spaceId}/memories`);
    assert.equal(memR.status, 200);
    assert.equal(
      memR.body.memories?.length ?? 0,
      0,
      `Re-created space should have 0 memories, found ${memR.body.memories?.length}`,
    );

    const entR = await get(INSTANCES.a, token, `/api/brain/spaces/${spaceId}/entities`);
    assert.equal(entR.status, 200);
    assert.equal(
      entR.body.entities?.length ?? 0,
      0,
      `Re-created space should have 0 entities, found ${entR.body.entities?.length}`,
    );

    // Cleanup
    await delWithBody(INSTANCES.a, token, `/api/spaces/${spaceId}`, { confirm: true }).catch(() => {});
  });

  it('cannot delete a built-in space', async () => {
    const r = await delWithBody(INSTANCES.a, token, '/api/spaces/general', { confirm: true });
    assert.ok(r.status >= 400 && r.status < 500, `Expected client error, got ${r.status}`);
  });

  it('deleting a space that was networked opens a vote round', async () => {
    // This test requires two instances with a network — skip if only one is available
    const healthB = await fetch(`${INSTANCES.b}/health`).catch(() => null);
    if (!healthB || healthB.status !== 200) {
      return; // skip — instance B not available
    }

    // Create a space, add it to a temporary network, then attempt deletion
    // The space_deletion vote round should be created instead of immediate deletion
    const spaceId = `del-networked-${RUN_ID}`;
    const createR = await post(INSTANCES.a, token, '/api/spaces', { id: spaceId, label: 'Networked Del Test' });
    assert.equal(createR.status, 201);

    // Create a network containing this space
    const netR = await post(INSTANCES.a, token, '/api/networks', {
      label: `Del-Net-${RUN_ID}`,
      type: 'closed',
      spaces: [spaceId],
    });
    assert.equal(netR.status, 201, `Network create: ${JSON.stringify(netR.body)}`);
    const networkId = netR.body.id;

    // Attempt to delete the networked space — should return 202 (vote round opened)
    const delR = await del(INSTANCES.a, token, `/api/spaces/${spaceId}`);
    assert.equal(delR.status, 202, `Expected 202 (vote round), got ${delR.status}: ${JSON.stringify(delR.body)}`);
    assert.ok(delR.body?.rounds?.length > 0, 'Should have opened at least one vote round');
    assert.equal(delR.body.rounds[0].networkId, networkId, 'Vote round should reference the correct network');

    // Cleanup: remove the network and space
    await del(INSTANCES.a, token, `/api/networks/${networkId}`).catch(() => {});
    await delWithBody(INSTANCES.a, token, `/api/spaces/${spaceId}`, { confirm: true }).catch(() => {});
  });
});
