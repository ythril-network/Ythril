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
import { legacyRights } from '../_shared/legacy-token-rights.mjs';

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
    const createR = await post(INSTANCES.a, adminToken, '/api/spaces', { id: spaceId, label: 'Wipe Full Test', meta: { strictLinkage: false } });
    assert.equal(createR.status, 201, `Create: ${JSON.stringify(createR.body)}`);
    createdSpaceIds.push(spaceId);

    // Seed data in every collection
    const memR = await post(INSTANCES.a, adminToken, `/api/brain/spaces/${spaceId}/facts`, { fact: 'Memory to wipe', tags: ['wipe-test'] });
    assert.equal(memR.status, 201, `Memory: ${JSON.stringify(memR.body)}`);

    const entR = await post(INSTANCES.a, adminToken, `/api/brain/spaces/${spaceId}/entities`, { name: 'WipeEnt', type: 'concept' });
    assert.equal(entR.status, 201, `Entity: ${JSON.stringify(entR.body)}`);

    const entR2 = await post(INSTANCES.a, adminToken, `/api/brain/spaces/${spaceId}/entities`, { name: 'WipeEnt2', type: 'concept' });
    assert.equal(entR2.status, 201);

    const edgeR = await post(INSTANCES.a, adminToken, `/api/brain/spaces/${spaceId}/edges`, { from: 'WipeEnt', to: 'WipeEnt2', label: 'related' });
    assert.equal(edgeR.status, 201, `Edge: ${JSON.stringify(edgeR.body)}`);

    const chronoR = await post(INSTANCES.a, adminToken, `/api/brain/spaces/${spaceId}/chrono`, { title: 'Chrono to wipe', type: 'event', startsAt: new Date().toISOString() });
    assert.equal(chronoR.status, 201, `Chrono: ${JSON.stringify(chronoR.body)}`);

    const fileR = await reqJson(INSTANCES.a, adminToken, `/api/files/${spaceId}?path=wipe-test.txt`, {
      method: 'POST',
      body: 'content to wipe',
      headers: { 'Content-Type': 'text/plain' },
    });
    assert.ok(fileR.status === 200 || fileR.status === 201 || fileR.status === 202, `File upload: ${fileR.status}`);

    // Verify pre-wipe stats
    const preStats = await get(INSTANCES.a, adminToken, `/api/brain/spaces/${spaceId}/stats`);
    assert.equal(preStats.status, 200);
    assert.ok(preStats.body.facts >= 1, 'Should have at least 1 memory');
    assert.ok(preStats.body.entities >= 2, 'Should have at least 2 entities');
    assert.ok(preStats.body.edges >= 1, 'Should have at least 1 edge');
    assert.ok(preStats.body.chrono >= 1, 'Should have at least 1 chrono entry');
    assert.ok(preStats.body.files >= 1, 'Should have at least 1 file');

    // Execute full wipe
    const wipeR = await post(INSTANCES.a, adminToken, `/api/admin/spaces/${spaceId}/wipe`, {});
    assert.equal(wipeR.status, 200, `Wipe: ${JSON.stringify(wipeR.body)}`);
    assert.ok(typeof wipeR.body.deleted === 'object', 'Response must have `deleted` object');
    assert.ok(wipeR.body.deleted.facts >= 1, 'deleted.facts should reflect removed docs');
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
    assert.equal(postStats.body.facts, 0, 'memories should be 0 after wipe');
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
    /*
     * The WHOLE object, deliberately, and it earned that on 2026-09-03.
     *
     * A per-key check would pass a wipe that had quietly stopped clearing a collection nobody thought to
     * assert on. This equality is what noticed `links` arriving — the only place in the suite that did,
     * because `npm run preflight` cannot run the Docker suites and a response-shape contract pinned only
     * here is invisible until CI.
     *
     * So a new collection means one edit in this line, on purpose. If that ever feels like friction, the
     * friction is the check working.
     */
    assert.deepEqual(wipeR.body.deleted, { facts: 0, entities: 0, edges: 0, chrono: 0, files: 0, links: 0 });
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

  it('wipe requires admin — a VALID non-admin token is rejected (403)', async () => {
    // Regression: this used to POST a random invalid token, which only exercises requireAuth's
    // 401 — so it would still pass if the ADMIN gate were removed (a valid non-admin token
    // would then wipe the space). Use a real, valid, non-admin token so the 403 proves the
    // admin gate itself, not merely "unauthenticated is rejected".
    const t = await post(INSTANCES.a, adminToken, '/api/tokens', { name: `wipe-nonadmin-${RUN_ID}`});
    assert.equal(t.status, 201, JSON.stringify(t.body));
    const nonAdmin = t.body.plaintext;
    try {
      const r = await post(INSTANCES.a, nonAdmin, '/api/admin/spaces/general/wipe', { confirm: true });
      assert.equal(r.status, 403, `a valid non-admin token must be rejected by the admin gate, got ${r.status}`);
    } finally {
      await del(INSTANCES.a, adminToken, `/api/tokens/${t.body.token.id}`).catch(() => {});
    }
  });

  it('a SPACE-SCOPED admin token cannot wipe / rename / delete an OUT-OF-SCOPE space (403)', async () => {
    // Highest-blast-radius gap the vacuous-test audit found: requireAdminMfaScoped's
    // enforceSpaceScope() call is the ONLY thing stopping a `{admin:true, spaces:[A]}` token
    // from wiping/renaming/deleting space B. The guard logic was correct but UNTESTED — a
    // regression that dropped the scope check would have let a scoped admin operate on ANY
    // space, and nothing would have failed. This pins the behaviour.
    const inScope = `scoped-in-${RUN_ID}`;
    const outScope = `scoped-out-${RUN_ID}`;
    for (const id of [inScope, outScope]) {
      const c = await post(INSTANCES.a, adminToken, '/api/spaces', { id, label: id });
      assert.equal(c.status, 201, JSON.stringify(c.body));
      createdSpaceIds.push(id);
    }

    const t = await post(INSTANCES.a, adminToken, '/api/tokens', {
      name: `scoped-admin-${RUN_ID}`,
      rights: legacyRights({ admin: true, spaces: [inScope] })
    });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    const scopedAdmin = t.body.plaintext;

    try {
      // Positive control: the in-scope space IS operable (proves the token is a working admin,
      // so the 403s below are the SCOPE check, not a broken token).
      const okWipe = await post(INSTANCES.a, scopedAdmin, `/api/admin/spaces/${inScope}/wipe`, { confirm: true });
      assert.equal(okWipe.status, 200, `in-scope wipe should succeed: ${okWipe.status} ${JSON.stringify(okWipe.body)}`);

      // The actual assertions: every space-targeting admin op on the OUT-of-scope space is 403.
      const wipe = await post(INSTANCES.a, scopedAdmin, `/api/admin/spaces/${outScope}/wipe`, { confirm: true });
      assert.equal(wipe.status, 403, `out-of-scope WIPE must be 403, got ${wipe.status} — privilege escalation`);

      const rename = await reqJson(INSTANCES.a, scopedAdmin, `/api/spaces/${outScope}/rename`, {
        method: 'PATCH', body: JSON.stringify({ newId: `${outScope}-x` }),
      });
      assert.equal(rename.status, 403, `out-of-scope RENAME must be 403, got ${rename.status}`);

      const schema = await reqJson(INSTANCES.a, scopedAdmin, `/api/spaces/${outScope}/schema`, {
        method: 'PUT', body: JSON.stringify({ typeSchemas: {} }),
      });
      assert.equal(schema.status, 403, `out-of-scope SCHEMA write must be 403, got ${schema.status}`);

      const delR = await delWithBody(INSTANCES.a, scopedAdmin, `/api/spaces/${outScope}`, { confirm: true });
      assert.equal(delR.status, 403, `out-of-scope DELETE must be 403, got ${delR.status}`);
    } finally {
      await del(INSTANCES.a, adminToken, `/api/tokens/${t.body.token.id}`).catch(() => {});
    }
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
    await post(INSTANCES.a, adminTok, `/api/brain/spaces/${spaceId}/facts`, { fact: 'Mem to wipe', tags: [] });
    await post(INSTANCES.a, adminTok, `/api/brain/spaces/${spaceId}/entities`, { name: 'SurvivingEnt', type: 'concept' });
    await post(INSTANCES.a, adminTok, `/api/brain/spaces/${spaceId}/chrono`, { title: 'Surviving chrono', type: 'event', startsAt: new Date().toISOString() });

    const preMem = await get(INSTANCES.a, adminTok, `/api/brain/spaces/${spaceId}/stats`);
    assert.ok(preMem.body.facts >= 1);
    assert.ok(preMem.body.entities >= 1);

    // Wipe memories only
    const wipeR = await post(INSTANCES.a, adminTok, `/api/admin/spaces/${spaceId}/wipe`, { types: ['facts'] });
    assert.equal(wipeR.status, 200, `Partial wipe: ${JSON.stringify(wipeR.body)}`);
    assert.ok(wipeR.body.deleted.facts >= 1, 'Should have deleted at least 1 memory');
    assert.equal(wipeR.body.deleted.entities, 0, 'Entities should not be affected');
    assert.equal(wipeR.body.deleted.edges, 0, 'Edges should not be affected');
    assert.equal(wipeR.body.deleted.chrono, 0, 'Chrono should not be affected');
    assert.equal(wipeR.body.deleted.files, 0, 'Files should not be affected');

    // Verify stats
    const postStats = await get(INSTANCES.a, adminTok, `/api/brain/spaces/${spaceId}/stats`);
    assert.equal(postStats.body.facts, 0, 'Memories should be 0 after partial wipe');
    assert.ok(postStats.body.entities >= 1, 'Entities must survive partial memories wipe');
    assert.ok(postStats.body.chrono >= 1, 'Chrono must survive partial memories wipe');
  });

  it('partial wipe of entities only leaves memories and other types intact', async () => {
    const spaceId = `wipe-partial-ent-${RUN_ID}`;
    const createR = await post(INSTANCES.a, adminTok, '/api/spaces', { id: spaceId, label: 'Wipe Partial Entities' });
    assert.equal(createR.status, 201);
    partialWipeSpaceIds.push(spaceId);

    await post(INSTANCES.a, adminTok, `/api/brain/spaces/${spaceId}/facts`, { fact: 'Surviving memory', tags: [] });
    await post(INSTANCES.a, adminTok, `/api/brain/spaces/${spaceId}/entities`, { name: 'EntToWipe', type: 'concept' });

    // Wipe entities only
    const wipeR = await post(INSTANCES.a, adminTok, `/api/admin/spaces/${spaceId}/wipe`, { types: ['entities'] });
    assert.equal(wipeR.status, 200);
    assert.ok(wipeR.body.deleted.entities >= 1, 'Should have deleted at least 1 entity');
    assert.equal(wipeR.body.deleted.facts, 0, 'Memories should not be affected');

    const postStats = await get(INSTANCES.a, adminTok, `/api/brain/spaces/${spaceId}/stats`);
    assert.equal(postStats.body.entities, 0, 'Entities should be 0 after partial wipe');
    assert.ok(postStats.body.facts >= 1, 'Memories must survive partial entities wipe');
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
    assert.ok(fileR.status === 200 || fileR.status === 201 || fileR.status === 202, `Upload: ${fileR.status}`);

    // Seed a memory so we can check it survives
    await post(INSTANCES.a, adminTok, `/api/brain/spaces/${spaceId}/facts`, { fact: 'Surviving memory', tags: [] });

    const preStats = await get(INSTANCES.a, adminTok, `/api/brain/spaces/${spaceId}/stats`);
    assert.ok(preStats.body.files >= 1, 'Should have at least 1 file');
    assert.ok(preStats.body.facts >= 1, 'Should have at least 1 memory');

    // Wipe files only
    const wipeR = await post(INSTANCES.a, adminTok, `/api/admin/spaces/${spaceId}/wipe`, { types: ['files'] });
    assert.equal(wipeR.status, 200, `File-only wipe: ${JSON.stringify(wipeR.body)}`);
    assert.ok(wipeR.body.deleted.files >= 1, 'Should have deleted at least 1 file record');
    assert.equal(wipeR.body.deleted.facts, 0, 'Memories should not be affected');

    const postStats = await get(INSTANCES.a, adminTok, `/api/brain/spaces/${spaceId}/stats`);
    assert.equal(postStats.body.files, 0, 'Files should be 0 after partial wipe');
    assert.ok(postStats.body.facts >= 1, 'Memories must survive partial files wipe');

    // Physical file should be gone (directory was cleared)
    const fileRead = await reqJson(INSTANCES.a, adminTok, `/api/files/${spaceId}?path=partial-wipe.txt`);
    assert.equal(fileRead.status, 404, `File should return 404 after files wipe, got ${fileRead.status}`);
  });

  it('partial wipe with multiple types wipes only those types', async () => {
    const spaceId = `wipe-multi-${RUN_ID}`;
    const createR = await post(INSTANCES.a, adminTok, '/api/spaces', { id: spaceId, label: 'Wipe Multi Types' });
    assert.equal(createR.status, 201);
    partialWipeSpaceIds.push(spaceId);

    await post(INSTANCES.a, adminTok, `/api/brain/spaces/${spaceId}/facts`, { fact: 'Memory to wipe', tags: [] });
    await post(INSTANCES.a, adminTok, `/api/brain/spaces/${spaceId}/entities`, { name: 'EntToWipe', type: 'concept' });
    await post(INSTANCES.a, adminTok, `/api/brain/spaces/${spaceId}/chrono`, { title: 'Surviving chrono', type: 'event', startsAt: new Date().toISOString() });

    // Wipe memories + entities, leave chrono
    const wipeR = await post(INSTANCES.a, adminTok, `/api/admin/spaces/${spaceId}/wipe`, { types: ['facts', 'entities'] });
    assert.equal(wipeR.status, 200, `Multi-type wipe: ${JSON.stringify(wipeR.body)}`);
    assert.ok(wipeR.body.deleted.facts >= 1, 'memories should be wiped');
    assert.ok(wipeR.body.deleted.entities >= 1, 'entities should be wiped');
    assert.equal(wipeR.body.deleted.edges, 0, 'edges should be untouched');
    assert.equal(wipeR.body.deleted.chrono, 0, 'chrono should be untouched');

    const postStats = await get(INSTANCES.a, adminTok, `/api/brain/spaces/${spaceId}/stats`);
    assert.equal(postStats.body.facts, 0, 'memories should be 0');
    assert.equal(postStats.body.entities, 0, 'entities should be 0');
    assert.ok(postStats.body.chrono >= 1, 'chrono must survive');
  });
});
