/**
 * Integration tests: Space rename
 *
 * Covers:
 *  - Rename a solo (non-networked) space — collections, files, config updated
 *  - Data survives rename — memories queryable under new ID
 *  - Files survive rename — accessible under new path
 *  - Rename updates network references (spaces[] and spaceMap)
 *  - Rename updates token scopes
 *  - Built-in space rename rejected
 *  - Rename to existing ID rejected (409)
 *  - Invalid new ID rejected (400)
 *  - Rename non-existent space (404)
 *
 * Run: node --test testing/integration/space-rename.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, patch, delWithBody } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');

let tokenA;
const createdSpaceIds = [];
const RUN_ID = Date.now();

describe('Space rename', () => {
  before(() => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  });

  after(async () => {
    for (const id of createdSpaceIds) {
      await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
    }
  });

  it('Rename a solo space — returns 200 with updated space', async () => {
    const oldId = `rename-src-${RUN_ID}`;
    const newId = `rename-dst-${RUN_ID}`;
    const r = await post(INSTANCES.a, tokenA, '/api/spaces', { id: oldId, label: 'Rename Source' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    createdSpaceIds.push(newId); // track the renamed one (old is gone)

    const renameR = await patch(INSTANCES.a, tokenA, `/api/spaces/${oldId}/rename`, { newId });
    assert.equal(renameR.status, 200, `Expected 200, got ${renameR.status}: ${JSON.stringify(renameR.body)}`);
    assert.equal(renameR.body.space?.id, newId);
  });

  it('Data survives rename — memories queryable under new ID', async () => {
    const oldId = `data-rename-${RUN_ID}`;
    const newId = `data-renamed-${RUN_ID}`;
    await post(INSTANCES.a, tokenA, '/api/spaces', { id: oldId, label: 'Data Rename' });

    // Write a memory
    const writeR = await post(INSTANCES.a, tokenA, `/api/brain/${oldId}/memories`, {
      fact: 'Rename survival test fact',
      tags: ['rename-test'],
    });
    assert.equal(writeR.status, 201);
    const memId = writeR.body._id;

    // Rename
    const renameR = await patch(INSTANCES.a, tokenA, `/api/spaces/${oldId}/rename`, { newId });
    assert.equal(renameR.status, 200, JSON.stringify(renameR.body));
    createdSpaceIds.push(newId);

    // Old ID should 404
    const oldR = await get(INSTANCES.a, tokenA, `/api/brain/${oldId}/memories`);
    assert.ok(oldR.status === 403 || oldR.status === 404, `Old space should be gone, got ${oldR.status}`);

    // New ID should have the memory
    const newR = await get(INSTANCES.a, tokenA, `/api/brain/${newId}/memories`);
    assert.equal(newR.status, 200);
    const found = newR.body.memories?.some(m => m._id === memId);
    assert.ok(found, 'Memory should exist under the renamed space');
  });

  it('Files survive rename — accessible under new path', async () => {
    const oldId = `file-rename-${RUN_ID}`;
    const newId = `file-renamed-${RUN_ID}`;
    await post(INSTANCES.a, tokenA, '/api/spaces', { id: oldId, label: 'File Rename' });

    // Write a file via query-param API
    const writeR = await post(INSTANCES.a, tokenA, `/api/files/${oldId}?path=${encodeURIComponent('test-file.txt')}`, {
      content: 'file rename test content',
    });
    assert.ok([200, 201, 202].includes(writeR.status), `File write: ${JSON.stringify(writeR.body)}`);

    // Rename
    const renameR = await patch(INSTANCES.a, tokenA, `/api/spaces/${oldId}/rename`, { newId });
    assert.equal(renameR.status, 200, JSON.stringify(renameR.body));
    createdSpaceIds.push(newId);

    // File should be accessible under new space
    const fileR = await get(INSTANCES.a, tokenA, `/api/files/${newId}?path=${encodeURIComponent('test-file.txt')}`);
    assert.equal(fileR.status, 200, `File should be readable under new space, got ${fileR.status}`);
  });

  it('Rename updates network spaces[] and adds spaceMap entry', async () => {
    const oldId = `net-rename-${RUN_ID}`;
    const newId = `net-renamed-${RUN_ID}`;
    await post(INSTANCES.a, tokenA, '/api/spaces', { id: oldId, label: 'Net Rename' });

    // Create a network with this space
    const netR = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: `Rename Test Net ${RUN_ID}`,
      type: 'closed',
      spaces: [oldId],
      votingDeadlineHours: 24,
    });
    assert.equal(netR.status, 201, JSON.stringify(netR.body));
    const networkId = netR.body.id ?? netR.body.network?.id;

    // Rename space
    const renameR = await patch(INSTANCES.a, tokenA, `/api/spaces/${oldId}/rename`, { newId });
    assert.equal(renameR.status, 200, JSON.stringify(renameR.body));
    createdSpaceIds.push(newId);

    // Network should now reference newId in spaces[]
    const netListR = await get(INSTANCES.a, tokenA, '/api/networks');
    assert.equal(netListR.status, 200);
    const net = netListR.body.networks?.find(n => n.id === networkId);
    assert.ok(net, 'Network should still exist');
    assert.ok(net.spaces.includes(newId), `Network spaces should include '${newId}', got: ${JSON.stringify(net.spaces)}`);
    assert.ok(!net.spaces.includes(oldId), `Network spaces should NOT include '${oldId}'`);

    // spaceMap should map oldId → newId (so peers still referencing the old ID can resolve)
    assert.ok(net.spaceMap, 'Network should have spaceMap after rename');
    assert.equal(net.spaceMap[oldId], newId, `spaceMap should map '${oldId}' → '${newId}'`);

    // Cleanup network
    const delNet = await delWithBody(INSTANCES.a, tokenA, `/api/networks/${networkId}`, { confirm: true }).catch(() => {});
  });

  it('Rename updates token scopes', async () => {
    const oldId = `token-rename-${RUN_ID}`;
    const newId = `token-renamed-${RUN_ID}`;
    await post(INSTANCES.a, tokenA, '/api/spaces', { id: oldId, label: 'Token Rename' });

    // Create a space-scoped token
    const tokenR = await post(INSTANCES.a, tokenA, '/api/tokens', {
      name: `Scoped token ${RUN_ID}`, spaces: [oldId],
    });
    assert.equal(tokenR.status, 201, JSON.stringify(tokenR.body));
    const tokenId = tokenR.body.token?.id;

    // Rename space
    const renameR = await patch(INSTANCES.a, tokenA, `/api/spaces/${oldId}/rename`, { newId });
    assert.equal(renameR.status, 200, JSON.stringify(renameR.body));
    createdSpaceIds.push(newId);

    // Token should now reference the new space ID
    const tokensR = await get(INSTANCES.a, tokenA, '/api/tokens');
    assert.equal(tokensR.status, 200);
    const tok = tokensR.body.tokens?.find(t => t.id === tokenId);
    assert.ok(tok, 'Token should still exist');
    assert.ok(tok.spaces?.includes(newId), `Token spaces should include '${newId}'`);
    assert.ok(!tok.spaces?.includes(oldId), `Token spaces should NOT include '${oldId}'`);
  });

  it('Rename built-in general space is rejected', async () => {
    const r = await patch(INSTANCES.a, tokenA, '/api/spaces/general/rename', { newId: 'new-general' });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}`);
  });

  it('Rename to existing space ID is rejected (409)', async () => {
    const srcId = `conflict-src-${RUN_ID}`;
    await post(INSTANCES.a, tokenA, '/api/spaces', { id: srcId, label: 'Conflict Src' });
    createdSpaceIds.push(srcId);

    const r = await patch(INSTANCES.a, tokenA, `/api/spaces/${srcId}/rename`, { newId: 'general' });
    assert.equal(r.status, 409, `Expected 409, got ${r.status}`);
  });

  it('Rename with invalid new ID is rejected (400)', async () => {
    const srcId = `invalid-rename-${RUN_ID}`;
    await post(INSTANCES.a, tokenA, '/api/spaces', { id: srcId, label: 'Invalid Rename' });
    createdSpaceIds.push(srcId);

    const r = await patch(INSTANCES.a, tokenA, `/api/spaces/${srcId}/rename`, { newId: 'UPPER_CASE!' });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}`);
  });

  it('Rename non-existent space returns 404', async () => {
    const r = await patch(INSTANCES.a, tokenA, '/api/spaces/does-not-exist/rename', { newId: 'whatever' });
    assert.equal(r.status, 404, `Expected 404, got ${r.status}`);
  });
});
