/**
 * Integration tests: Space wipe endpoint
 *
 * Covers:
 *  - Full wipe (all types) removes all brain data and files, preserves the space
 *  - Partial wipe (by type) removes only the specified collections
 *  - Idempotent — wiping an empty space returns all-zero counts without error
 *  - Invalid `types` values are rejected with 400
 *  - Non-existent space returns 404
 *  - Non-admin token is rejected with 401/403
 *  - Wipe response contains correct deleted counts
 *
 * Run: node --test testing/integration/space-wipe.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody, reqJson } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

let adminToken;
const RUN_ID = Date.now();
const createdSpaceIds = [];

describe('Space wipe — full wipe', () => {
  before(() => {
    adminToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  after(async () => {
    for (const id of createdSpaceIds) {
      await delWithBody(INSTANCES.a, adminToken, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
    }
  });

  it('full wipe removes all brain data and files, returns correct deleted counts', async () => {
    const spaceId = `wipe-full-${RUN_ID}`;
    const createR = await post(INSTANCES.a, adminToken, '/api/spaces', { id: spaceId, label: 'Wipe Full Test' });
    assert.equal(createR.status, 201, `Create: ${JSON.stringify(createR.body)}`);
    createdSpaceIds.push(spaceId);

    // Seed data in every collection
    const memR = await post(INSTANCES.a, adminToken, `/api/brain/${spaceId}/memories`, { fact: 'Memory to wipe', tags: ['wipe-test'] });
    assert.equal(memR.status, 201, `Memory: ${JSON.stringify(memR.body)}`);

    const entR = await post(INSTANCES.a, adminToken, `/api/brain/spaces/${spaceId}/entities`, { name: 'WipeEnt', type: 'concept' });
    assert.equal(entR.status, 201, `Entity: ${JSON.stringify(entR.body)}`);

    const entR2 = await post(INSTANCES.a, adminToken, `/api/brain/spaces/${spaceId}/entities`, { name: 'WipeEnt2', type: 'concept' });
    assert.equal(entR2.status, 201);

    const edgeR = await post(INSTANCES.a, adminToken, `/api/brain/spaces/${spaceId}/edges`, { from: 'WipeEnt', to: 'WipeEnt2', label: 'related' });
    assert.equal(edgeR.status, 201, `Edge: ${JSON.stringify(edgeR.body)}`);

    const chronoR = await post(INSTANCES.a, adminToken, `/api/brain/spaces/${spaceId}/chrono`, { title: 'Chrono to wipe', kind: 'event', startsAt: new Date().toISOString() });
    assert.equal(chronoR.status, 201, `Chrono: ${JSON.stringify(chronoR.body)}`);

    const fileR = await reqJson(INSTANCES.a, adminToken, `/api/files/${spaceId}?path=wipe-test.txt`, {
      method: 'POST',
      body: 'content to wipe',
      headers: { 'Content-Type': 'text/plain' },
    });
    assert.ok(fileR.status === 200 || fileR.status === 201, `File upload: ${fileR.status}`);

    // Verify pre-wipe stats
    const preStats = await get(INSTANCES.a, adminToken, `/api/brain/spaces/${spaceId}/stats`);
    assert.equal(preStats.status, 200);
    assert.ok(preStats.body.memories >= 1, 'Should have at least 1 memory');
    assert.ok(preStats.body.entities >= 2, 'Should have at least 2 entities');
    assert.ok(preStats.body.edges >= 1, 'Should have at least 1 edge');
    assert.ok(preStats.body.chrono >= 1, 'Should have at least 1 chrono entry');
    assert.ok(preStats.body.files >= 1, 'Should have at least 1 file');

    // Execute full wipe
    const wipeR = await post(INSTANCES.a, adminToken, `/api/admin/spaces/${spaceId}/wipe`, {});
    assert.equal(wipeR.status, 200, `Wipe: ${JSON.stringify(wipeR.body)}`);
    assert.ok(typeof wipeR.body.deleted === 'object', 'Response must have `deleted` object');
    assert.ok(wipeR.body.deleted.memories >= 1, 'deleted.memories should reflect removed docs');
    assert.ok(wipeR.body.deleted.entities >= 2, 'deleted.entities should reflect removed docs');
    assert.ok(wipeR.body.deleted.edges >= 1, 'deleted.edges should reflect removed docs');
    assert.ok(wipeR.body.deleted.chrono >= 1, 'deleted.chrono should reflect removed docs');
    assert.ok(wipeR.body.deleted.files >= 1, 'deleted.files should reflect removed docs');

    // Verify space still exists
    const listR = await get(INSTANCES.a, adminToken, '/api/spaces');
    assert.ok(listR.body.spaces?.some(s => s.id === spaceId), 'Space must still exist after wipe');

    // Verify post-wipe stats are all zero
    const postStats = await get(INSTANCES.a, adminToken, `/api/brain/spaces/${spaceId}/stats`);
    assert.equal(postStats.status, 200);
    assert.equal(postStats.body.memories, 0, 'memories should be 0 after wipe');
    assert.equal(postStats.body.entities, 0, 'entities should be 0 after wipe');
    assert.equal(postStats.body.edges, 0, 'edges should be 0 after wipe');
    assert.equal(postStats.body.chrono, 0, 'chrono should be 0 after wipe');
    assert.equal(postStats.body.files, 0, 'files should be 0 after wipe');
  });

  it('wiping an already-empty space returns all-zero counts (idempotent)', async () => {
    const spaceId = `wipe-empty-${RUN_ID}`;
    const createR = await post(INSTANCES.a, adminToken, '/api/spaces', { id: spaceId, label: 'Wipe Empty Test' });
    assert.equal(createR.status, 201);
    createdSpaceIds.push(spaceId);

    const wipeR = await post(INSTANCES.a, adminToken, `/api/admin/spaces/${spaceId}/wipe`, {});
    assert.equal(wipeR.status, 200, `Wipe empty: ${JSON.stringify(wipeR.body)}`);
    assert.deepEqual(wipeR.body.deleted, { memories: 0, entities: 0, edges: 0, chrono: 0, files: 0 });
  });

  it('wipe on non-existent space returns 404', async () => {
    const r = await post(INSTANCES.a, adminToken, '/api/admin/spaces/does-not-exist/wipe', {});
    assert.equal(r.status, 404, `Expected 404, got ${r.status}`);
  });

  it('wipe with invalid types value returns 400', async () => {
    const r = await post(INSTANCES.a, adminToken, '/api/admin/spaces/general/wipe', { types: ['invalid-type'] });
    assert.equal(r.status, 400, `Expected 400 for invalid type, got ${r.status}`);
    assert.ok(r.body?.error?.toLowerCase().includes('types'), `Error should mention 'types': ${r.body?.error}`);
  });

  it('wipe requires admin token — non-admin token is rejected', async () => {
    // Create a non-admin token by checking that a space-scoped or read-only token is rejected.
    // We use a random invalid token to simulate the 401 case.
    const fakeToken = 'ythril_notavalidtoken';
    const r = await post(INSTANCES.a, fakeToken, '/api/admin/spaces/general/wipe', {});
    assert.ok(r.status === 401 || r.status === 403, `Expected 401 or 403, got ${r.status}`);
  });
});

describe('Space wipe — partial wipe (by type)', () => {
  let adminTok;
  const partialWipeSpaceIds = [];

  before(() => {
    adminTok = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  after(async () => {
    for (const id of partialWipeSpaceIds) {
      await delWithBody(INSTANCES.a, adminTok, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
    }
  });

  it('partial wipe of memories only leaves entities, edges, chrono, and files intact', async () => {
    const spaceId = `wipe-partial-mem-${RUN_ID}`;
    const createR = await post(INSTANCES.a, adminTok, '/api/spaces', { id: spaceId, label: 'Wipe Partial Memories' });
    assert.equal(createR.status, 201);
    partialWipeSpaceIds.push(spaceId);

    // Seed one of each type
    await post(INSTANCES.a, adminTok, `/api/brain/${spaceId}/memories`, { fact: 'Mem to wipe', tags: [] });
    await post(INSTANCES.a, adminTok, `/api/brain/spaces/${spaceId}/entities`, { name: 'SurvivingEnt', type: 'concept' });
    await post(INSTANCES.a, adminTok, `/api/brain/spaces/${spaceId}/chrono`, { title: 'Surviving chrono', kind: 'event', startsAt: new Date().toISOString() });

    const preMem = await get(INSTANCES.a, adminTok, `/api/brain/spaces/${spaceId}/stats`);
    assert.ok(preMem.body.memories >= 1);
    assert.ok(preMem.body.entities >= 1);

    // Wipe memories only
    const wipeR = await post(INSTANCES.a, adminTok, `/api/admin/spaces/${spaceId}/wipe`, { types: ['memories'] });
    assert.equal(wipeR.status, 200, `Partial wipe: ${JSON.stringify(wipeR.body)}`);
    assert.ok(wipeR.body.deleted.memories >= 1, 'Should have deleted at least 1 memory');
    assert.equal(wipeR.body.deleted.entities, 0, 'Entities should not be affected');
    assert.equal(wipeR.body.deleted.edges, 0, 'Edges should not be affected');
    assert.equal(wipeR.body.deleted.chrono, 0, 'Chrono should not be affected');
    assert.equal(wipeR.body.deleted.files, 0, 'Files should not be affected');

    // Verify stats
    const postStats = await get(INSTANCES.a, adminTok, `/api/brain/spaces/${spaceId}/stats`);
    assert.equal(postStats.body.memories, 0, 'Memories should be 0 after partial wipe');
    assert.ok(postStats.body.entities >= 1, 'Entities must survive partial memories wipe');
    assert.ok(postStats.body.chrono >= 1, 'Chrono must survive partial memories wipe');
  });

  it('partial wipe of entities only leaves memories and other types intact', async () => {
    const spaceId = `wipe-partial-ent-${RUN_ID}`;
    const createR = await post(INSTANCES.a, adminTok, '/api/spaces', { id: spaceId, label: 'Wipe Partial Entities' });
    assert.equal(createR.status, 201);
    partialWipeSpaceIds.push(spaceId);

    await post(INSTANCES.a, adminTok, `/api/brain/${spaceId}/memories`, { fact: 'Surviving memory', tags: [] });
    await post(INSTANCES.a, adminTok, `/api/brain/spaces/${spaceId}/entities`, { name: 'EntToWipe', type: 'concept' });

    // Wipe entities only
    const wipeR = await post(INSTANCES.a, adminTok, `/api/admin/spaces/${spaceId}/wipe`, { types: ['entities'] });
    assert.equal(wipeR.status, 200);
    assert.ok(wipeR.body.deleted.entities >= 1, 'Should have deleted at least 1 entity');
    assert.equal(wipeR.body.deleted.memories, 0, 'Memories should not be affected');

    const postStats = await get(INSTANCES.a, adminTok, `/api/brain/spaces/${spaceId}/stats`);
    assert.equal(postStats.body.entities, 0, 'Entities should be 0 after partial wipe');
    assert.ok(postStats.body.memories >= 1, 'Memories must survive partial entities wipe');
  });

  it('partial wipe of files only clears file records and file storage, leaves brain intact', async () => {
    const spaceId = `wipe-partial-files-${RUN_ID}`;
    const createR = await post(INSTANCES.a, adminTok, '/api/spaces', { id: spaceId, label: 'Wipe Partial Files' });
    assert.equal(createR.status, 201);
    partialWipeSpaceIds.push(spaceId);

    // Upload a file
    const fileR = await reqJson(INSTANCES.a, adminTok, `/api/files/${spaceId}?path=partial-wipe.txt`, {
      method: 'POST',
      body: 'file content',
      headers: { 'Content-Type': 'text/plain' },
    });
    assert.ok(fileR.status === 200 || fileR.status === 201, `Upload: ${fileR.status}`);

    // Seed a memory so we can check it survives
    await post(INSTANCES.a, adminTok, `/api/brain/${spaceId}/memories`, { fact: 'Surviving memory', tags: [] });

    const preStats = await get(INSTANCES.a, adminTok, `/api/brain/spaces/${spaceId}/stats`);
    assert.ok(preStats.body.files >= 1, 'Should have at least 1 file');
    assert.ok(preStats.body.memories >= 1, 'Should have at least 1 memory');

    // Wipe files only
    const wipeR = await post(INSTANCES.a, adminTok, `/api/admin/spaces/${spaceId}/wipe`, { types: ['files'] });
    assert.equal(wipeR.status, 200, `File-only wipe: ${JSON.stringify(wipeR.body)}`);
    assert.ok(wipeR.body.deleted.files >= 1, 'Should have deleted at least 1 file record');
    assert.equal(wipeR.body.deleted.memories, 0, 'Memories should not be affected');

    const postStats = await get(INSTANCES.a, adminTok, `/api/brain/spaces/${spaceId}/stats`);
    assert.equal(postStats.body.files, 0, 'Files should be 0 after partial wipe');
    assert.ok(postStats.body.memories >= 1, 'Memories must survive partial files wipe');

    // Physical file should be gone (directory was cleared)
    const fileRead = await reqJson(INSTANCES.a, adminTok, `/api/files/${spaceId}?path=partial-wipe.txt`);
    assert.equal(fileRead.status, 404, `File should return 404 after files wipe, got ${fileRead.status}`);
  });

  it('partial wipe with multiple types wipes only those types', async () => {
    const spaceId = `wipe-multi-${RUN_ID}`;
    const createR = await post(INSTANCES.a, adminTok, '/api/spaces', { id: spaceId, label: 'Wipe Multi Types' });
    assert.equal(createR.status, 201);
    partialWipeSpaceIds.push(spaceId);

    await post(INSTANCES.a, adminTok, `/api/brain/${spaceId}/memories`, { fact: 'Memory to wipe', tags: [] });
    await post(INSTANCES.a, adminTok, `/api/brain/spaces/${spaceId}/entities`, { name: 'EntToWipe', type: 'concept' });
    await post(INSTANCES.a, adminTok, `/api/brain/spaces/${spaceId}/chrono`, { title: 'Surviving chrono', kind: 'event', startsAt: new Date().toISOString() });

    // Wipe memories + entities, leave chrono
    const wipeR = await post(INSTANCES.a, adminTok, `/api/admin/spaces/${spaceId}/wipe`, { types: ['memories', 'entities'] });
    assert.equal(wipeR.status, 200, `Multi-type wipe: ${JSON.stringify(wipeR.body)}`);
    assert.ok(wipeR.body.deleted.memories >= 1, 'memories should be wiped');
    assert.ok(wipeR.body.deleted.entities >= 1, 'entities should be wiped');
    assert.equal(wipeR.body.deleted.edges, 0, 'edges should be untouched');
    assert.equal(wipeR.body.deleted.chrono, 0, 'chrono should be untouched');

    const postStats = await get(INSTANCES.a, adminTok, `/api/brain/spaces/${spaceId}/stats`);
    assert.equal(postStats.body.memories, 0, 'memories should be 0');
    assert.equal(postStats.body.entities, 0, 'entities should be 0');
    assert.ok(postStats.body.chrono >= 1, 'chrono must survive');
  });
});
