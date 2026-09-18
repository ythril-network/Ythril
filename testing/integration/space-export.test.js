/**
 * Integration tests: Space export and import endpoints
 *
 * Covers:
 *  - GET /api/admin/spaces/:spaceId/export returns correct structure and data
 *  - Export excludes embedding vectors (large binary data)
 *  - Export on non-existent space returns 404
 *  - Export requires admin token (401/403 for non-admin)
 *  - POST /api/admin/spaces/:spaceId/import upserts documents by _id
 *  - Import correctly counts inserted vs updated vs errors
 *  - Import on non-existent space returns 404
 *  - Import with invalid array type returns 400
 *  - Round-trip: export → wipe → import restores all data
 *
 * Run: node --test testing/integration/space-export.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody, reqJson, readRecord } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

let adminToken;
const RUN_ID = Date.now();
const createdSpaceIds = [];

describe('Space export — basic export', () => {
  before(() => {
    adminToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  after(async () => {
    for (const id of createdSpaceIds) {
      await delWithBody(INSTANCES.a, adminToken, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
    }
  });

  it('export returns correct top-level structure', async () => {
    const spaceId = `export-struct-${RUN_ID}`;
    const createR = await post(INSTANCES.a, adminToken, '/api/spaces', { id: spaceId, label: 'Export Struct Test', meta: { strictLinkage: false } });
    assert.equal(createR.status, 201, `Create: ${JSON.stringify(createR.body)}`);
    createdSpaceIds.push(spaceId);

    const exportR = await get(INSTANCES.a, adminToken, `/api/admin/spaces/${spaceId}/export`);
    assert.equal(exportR.status, 200, `Export: ${JSON.stringify(exportR.body)}`);

    const body = exportR.body;
    assert.ok(typeof body.exportedAt === 'string', 'exportedAt must be a string');
    assert.ok(!isNaN(Date.parse(body.exportedAt)), 'exportedAt must be a valid ISO date');
    assert.equal(body.spaceId, spaceId);
    assert.equal(body.spaceName, 'Export Struct Test');
    assert.ok(typeof body.version === 'string' && body.version.length > 0, 'version must be a non-empty string');
    assert.ok(Array.isArray(body.facts), 'facts must be an array');
    assert.ok(Array.isArray(body.entities), 'entities must be an array');
    assert.ok(Array.isArray(body.edges), 'edges must be an array');
    assert.ok(Array.isArray(body.chrono), 'chrono must be an array');
    assert.ok(Array.isArray(body.files), 'files must be an array');
  });

  it('export includes seeded data and excludes embedding vectors', async () => {
    const spaceId = `export-data-${RUN_ID}`;
    const createR = await post(INSTANCES.a, adminToken, '/api/spaces', { id: spaceId, label: 'Export Data Test', meta: { strictLinkage: false } });
    assert.equal(createR.status, 201);
    createdSpaceIds.push(spaceId);

    // Seed one of each type
    const memR = await post(INSTANCES.a, adminToken, `/api/brain/spaces/${spaceId}/facts`, { fact: 'Export memory fact', tags: ['export-tag'] });
    assert.equal(memR.status, 201);

    const entR = await post(INSTANCES.a, adminToken, `/api/brain/spaces/${spaceId}/entities`, { name: 'ExportEnt', type: 'concept' });
    assert.equal(entR.status, 201);

    const entR2 = await post(INSTANCES.a, adminToken, `/api/brain/spaces/${spaceId}/entities`, { name: 'ExportEnt2', type: 'concept' });
    assert.equal(entR2.status, 201);

    const edgeR = await post(INSTANCES.a, adminToken, `/api/brain/spaces/${spaceId}/edges`, {
      from: 'ExportEnt', to: 'ExportEnt2', label: 'related',
    });
    assert.equal(edgeR.status, 201);

    const chronoR = await post(INSTANCES.a, adminToken, `/api/brain/spaces/${spaceId}/chrono`, {
      title: 'Export Chrono', type: 'event', startsAt: new Date().toISOString(),
    });
    assert.equal(chronoR.status, 201);

    const exportR = await get(INSTANCES.a, adminToken, `/api/admin/spaces/${spaceId}/export`);
    assert.equal(exportR.status, 200);

    const body = exportR.body;
    assert.ok(body.facts.length >= 1, 'Should export at least 1 memory');
    assert.ok(body.entities.length >= 2, 'Should export at least 2 entities');
    assert.ok(body.edges.length >= 1, 'Should export at least 1 edge');
    assert.ok(body.chrono.length >= 1, 'Should export at least 1 chrono entry');

    // Verify embedding vectors are excluded
    for (const mem of body.facts) {
      assert.ok(!('embedding' in mem), `Memory ${mem._id} should not have embedding field`);
    }
    for (const ent of body.entities) {
      assert.ok(!('embedding' in ent), `Entity ${ent._id} should not have embedding field`);
    }
    for (const edge of body.edges) {
      assert.ok(!('embedding' in edge), `Edge ${edge._id} should not have embedding field`);
    }
    for (const ch of body.chrono) {
      assert.ok(!('embedding' in ch), `Chrono ${ch._id} should not have embedding field`);
    }

    // Verify _id values are strings
    for (const mem of body.facts) {
      assert.equal(typeof mem._id, 'string', 'Memory _id must be a string');
    }
    for (const ent of body.entities) {
      assert.equal(typeof ent._id, 'string', 'Entity _id must be a string');
    }

    // Verify specific seeded data is present
    const exportedMem = body.facts.find(m => m.fact === 'Export memory fact');
    assert.ok(exportedMem, 'Seeded memory must appear in export');
    assert.deepEqual(exportedMem.tags, ['export-tag']);
  });

  it('export includes file metadata', async () => {
    const spaceId = `export-files-${RUN_ID}`;
    const createR = await post(INSTANCES.a, adminToken, '/api/spaces', { id: spaceId, label: 'Export Files Test', meta: { strictLinkage: false } });
    assert.equal(createR.status, 201);
    createdSpaceIds.push(spaceId);

    // Upload a file
    const fileR = await reqJson(INSTANCES.a, adminToken, `/api/files/${spaceId}?path=export-test.txt`, {
      method: 'POST',
      body: 'file content for export',
      headers: { 'Content-Type': 'text/plain' },
    });
    assert.ok(fileR.status === 200 || fileR.status === 201 || fileR.status === 202, `Upload: ${fileR.status}`);

    const exportR = await get(INSTANCES.a, adminToken, `/api/admin/spaces/${spaceId}/export`);
    assert.equal(exportR.status, 200);
    assert.ok(exportR.body.files.length >= 1, 'Should export at least 1 file metadata entry');

    // Verify file metadata fields
    const fileMeta = exportR.body.files[0];
    assert.ok(typeof fileMeta._id === 'string', 'File _id must be a string');
    assert.ok(typeof fileMeta.path === 'string', 'File path must be a string');
    assert.ok(Array.isArray(fileMeta.tags), 'File tags must be an array');
  });

  it('export on non-existent space returns 404', async () => {
    const r = await get(INSTANCES.a, adminToken, '/api/admin/spaces/does-not-exist-export/export');
    assert.equal(r.status, 404);
  });

  it('export requires admin token', async () => {
    const fakeToken = 'ythril_notavalidtoken';
    const r = await get(INSTANCES.a, fakeToken, '/api/admin/spaces/general/export');
    assert.ok(r.status === 401 || r.status === 403, `Expected 401 or 403, got ${r.status}`);
  });
});

describe('Space import — basic import', () => {
  let tok;
  const importSpaceIds = [];

  before(() => {
    tok = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  after(async () => {
    for (const id of importSpaceIds) {
      await delWithBody(INSTANCES.a, tok, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
    }
  });

  it('import inserts new documents and returns correct counts', async () => {
    const spaceId = `import-new-${RUN_ID}`;
    const createR = await post(INSTANCES.a, tok, '/api/spaces', { id: spaceId, label: 'Import New Test' });
    assert.equal(createR.status, 201);
    importSpaceIds.push(spaceId);

    const payload = {
      facts: [
        { _id: 'import-mem-1', spaceId, fact: 'Imported memory', tags: [], entityIds: [], author: { instanceId: 'test', instanceLabel: 'test' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), seq: 1, embeddingModel: 'none' },
      ],
      entities: [
        { _id: 'import-ent-1', spaceId, name: 'ImportedEnt', type: 'concept', tags: [], properties: {}, author: { instanceId: 'test', instanceLabel: 'test' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), seq: 2 },
      ],
      edges: [],
      chrono: [],
      files: [],
    };

    const importR = await post(INSTANCES.a, tok, `/api/admin/spaces/${spaceId}/import`, payload);
    assert.equal(importR.status, 200, `Import: ${JSON.stringify(importR.body)}`);
    assert.equal(importR.body.spaceId, spaceId);
    assert.ok(importR.body.results, 'Response must have results');
    assert.equal(importR.body.results.facts.inserted, 1, 'Should insert 1 memory');
    assert.equal(importR.body.results.facts.updated, 0);
    assert.equal(importR.body.results.facts.errors, 0);
    assert.equal(importR.body.results.entities.inserted, 1, 'Should insert 1 entity');
    assert.equal(importR.body.results.entities.updated, 0);
    assert.equal(importR.body.results.entities.errors, 0);

    // Verify data is retrievable
    const memList = await get(INSTANCES.a, tok, `/api/brain/spaces/${spaceId}/stats`);
    assert.equal(memList.status, 200);
    assert.ok(memList.body.facts >= 1, 'Memory should be present after import');
    assert.ok(memList.body.entities >= 1, 'Entity should be present after import');
  });

  it('import updates existing documents and counts correctly', async () => {
    const spaceId = `import-update-${RUN_ID}`;
    const createR = await post(INSTANCES.a, tok, '/api/spaces', { id: spaceId, label: 'Import Update Test' });
    assert.equal(createR.status, 201);
    importSpaceIds.push(spaceId);

    const now = new Date().toISOString();
    const doc = { _id: 'update-mem-1', spaceId, fact: 'Original', tags: [], entityIds: [], author: { instanceId: 'test', instanceLabel: 'test' }, createdAt: now, updatedAt: now, seq: 1, embeddingModel: 'none' };

    // First import — inserts
    const first = await post(INSTANCES.a, tok, `/api/admin/spaces/${spaceId}/import`, { facts: [doc] });
    assert.equal(first.status, 200);
    assert.equal(first.body.results.facts.inserted, 1);

    // Second import with same _id — updates
    const updated = { ...doc, fact: 'Updated fact' };
    const second = await post(INSTANCES.a, tok, `/api/admin/spaces/${spaceId}/import`, { facts: [updated] });
    assert.equal(second.status, 200);
    assert.equal(second.body.results.facts.inserted, 0, 'Should be 0 inserted on update');
    assert.equal(second.body.results.facts.updated, 1, 'Should be 1 updated');
    assert.equal(second.body.results.facts.errors, 0);
  });

  it('import rejects documents missing _id with error count', async () => {
    const spaceId = `import-bad-${RUN_ID}`;
    const createR = await post(INSTANCES.a, tok, '/api/spaces', { id: spaceId, label: 'Import Bad Test' });
    assert.equal(createR.status, 201);
    importSpaceIds.push(spaceId);

    // Document with missing _id
    const badDoc = { spaceId, fact: 'No id doc', tags: [] };
    const importR = await post(INSTANCES.a, tok, `/api/admin/spaces/${spaceId}/import`, { facts: [badDoc] });
    assert.equal(importR.status, 200, `Expected 200 with error count, got ${importR.status}`);
    assert.equal(importR.body.results.facts.errors, 1, 'Should count bad doc as error');
    assert.equal(importR.body.results.facts.inserted, 0);
  });

  it('import with non-array type returns 400', async () => {
    const r = await post(INSTANCES.a, tok, '/api/admin/spaces/general/import', { facts: 'not-an-array' });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}`);
    assert.ok(r.body?.error?.includes('facts'), `Error should mention 'facts': ${r.body?.error}`);
  });

  it('import on non-existent space returns 404', async () => {
    const r = await post(INSTANCES.a, tok, '/api/admin/spaces/does-not-exist-import/import', {});
    assert.equal(r.status, 404);
  });

  it('import requires admin token', async () => {
    const fakeToken = 'ythril_notavalidtoken';
    const r = await post(INSTANCES.a, fakeToken, '/api/admin/spaces/general/import', {});
    assert.ok(r.status === 401 || r.status === 403, `Expected 401 or 403, got ${r.status}`);
  });
});

describe('Space export/import — round-trip (export → wipe → import)', () => {
  let tok;
  const roundTripSpaceIds = [];

  before(() => {
    tok = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  after(async () => {
    for (const id of roundTripSpaceIds) {
      await delWithBody(INSTANCES.a, tok, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
    }
  });

  it('export → wipe → import restores all brain data', async () => {
    const spaceId = `roundtrip-${RUN_ID}`;
    const createR = await post(INSTANCES.a, tok, '/api/spaces', { id: spaceId, label: 'Round-trip Test', meta: { strictLinkage: false } });
    assert.equal(createR.status, 201, `Create: ${JSON.stringify(createR.body)}`);
    roundTripSpaceIds.push(spaceId);

    // Seed diverse data
    const memR = await post(INSTANCES.a, tok, `/api/brain/spaces/${spaceId}/facts`, { fact: 'Round-trip memory', tags: ['rt-tag'] });
    assert.equal(memR.status, 201);
    const memId = memR.body._id;

    const entR = await post(INSTANCES.a, tok, `/api/brain/spaces/${spaceId}/entities`, { name: 'RTEnt', type: 'concept', tags: ['rt'] });
    assert.equal(entR.status, 201);

    const entR2 = await post(INSTANCES.a, tok, `/api/brain/spaces/${spaceId}/entities`, { name: 'RTEnt2', type: 'concept' });
    assert.equal(entR2.status, 201);

    const edgeR = await post(INSTANCES.a, tok, `/api/brain/spaces/${spaceId}/edges`, {
      from: 'RTEnt', to: 'RTEnt2', label: 'related', weight: 0.9,
    });
    assert.equal(edgeR.status, 201);

    const now = new Date().toISOString();
    const chronoR = await post(INSTANCES.a, tok, `/api/brain/spaces/${spaceId}/chrono`, {
      title: 'RT Event', type: 'event', startsAt: now,
    });
    assert.equal(chronoR.status, 201);

    // Export
    const exportR = await get(INSTANCES.a, tok, `/api/admin/spaces/${spaceId}/export`);
    assert.equal(exportR.status, 200, `Export: ${JSON.stringify(exportR.body)}`);
    const exportPayload = exportR.body;
    assert.ok(exportPayload.facts.length >= 1);
    assert.ok(exportPayload.entities.length >= 2);
    assert.ok(exportPayload.edges.length >= 1);
    assert.ok(exportPayload.chrono.length >= 1);

    // Wipe the space
    const wipeR = await post(INSTANCES.a, tok, `/api/admin/spaces/${spaceId}/wipe`, {});
    assert.equal(wipeR.status, 200, `Wipe: ${JSON.stringify(wipeR.body)}`);

    // Verify all data is gone
    const postWipeStats = await get(INSTANCES.a, tok, `/api/brain/spaces/${spaceId}/stats`);
    assert.equal(postWipeStats.body.facts, 0);
    assert.equal(postWipeStats.body.entities, 0);
    assert.equal(postWipeStats.body.edges, 0);
    assert.equal(postWipeStats.body.chrono, 0);

    // Import the exported payload
    const importR = await post(INSTANCES.a, tok, `/api/admin/spaces/${spaceId}/import`, exportPayload);
    assert.equal(importR.status, 200, `Import: ${JSON.stringify(importR.body)}`);
    assert.equal(importR.body.results.facts.errors, 0, 'No import errors for facts');
    assert.equal(importR.body.results.entities.errors, 0, 'No import errors for entities');
    assert.equal(importR.body.results.edges.errors, 0, 'No import errors for edges');
    assert.equal(importR.body.results.chrono.errors, 0, 'No import errors for chrono');

    // Verify data is restored with same IDs
    const postImportStats = await get(INSTANCES.a, tok, `/api/brain/spaces/${spaceId}/stats`);
    assert.ok(postImportStats.body.facts >= 1, 'Memories should be restored');
    assert.ok(postImportStats.body.entities >= 2, 'Entities should be restored');
    assert.ok(postImportStats.body.edges >= 1, 'Edges should be restored');
    assert.ok(postImportStats.body.chrono >= 1, 'Chrono should be restored');

    // Verify the specific memory is restored with the same ID
    const memCheck = await readRecord(INSTANCES.a, tok, spaceId, 'facts', memId);
    assert.equal(memCheck.status, 200, `Memory ${memId} should be retrievable after import`);
    assert.equal(memCheck.body.fact, 'Round-trip memory');
    assert.deepEqual(memCheck.body.tags, ['rt-tag']);
  });

  it('CROSS-SPACE import — entities/edges/chrono are LISTED in the target space', async () => {
    // The export embeds the SOURCE space's id in every document, and listEntities/listEdges/
    // listChrono filter on that field. Importing space A's export into space B while keeping
    // `spaceId: "A"` wrote documents that were counted but INVISIBLE to every list — the
    // import reported success and the data looked lost.
    //
    // The whole import suite missed this because it only ever round-trips into the SAME space
    // (so spaceId stays consistent) and only ever asserts via /stats (counts) and
    // GET /facts/:id — the three read paths that do NOT filter on spaceId. Exactly the
    // trap that hid the space-rename bug.
    const srcId = `xspace-src-${RUN_ID}`;
    const dstId = `xspace-dst-${RUN_ID}`;
    for (const id of [srcId, dstId]) {
      const c = await post(INSTANCES.a, tok, '/api/spaces', { id, label: `Cross ${id}` });
      assert.equal(c.status, 201, JSON.stringify(c.body));
      roundTripSpaceIds.push(id);
    }

    const e1 = await post(INSTANCES.a, tok, `/api/brain/spaces/${srcId}/entities`, { name: 'Ada', type: 'person' });
    const e2 = await post(INSTANCES.a, tok, `/api/brain/spaces/${srcId}/entities`, { name: 'Grace', type: 'person' });
    assert.equal(e1.status, 201, JSON.stringify(e1.body));
    assert.equal(e2.status, 201, JSON.stringify(e2.body));
    const ed = await post(INSTANCES.a, tok, `/api/brain/spaces/${srcId}/edges`, {
      from: e1.body._id, to: e2.body._id, label: 'knows',
    });
    assert.equal(ed.status, 201, JSON.stringify(ed.body));
    const ch = await post(INSTANCES.a, tok, `/api/brain/spaces/${srcId}/chrono`, {
      title: 'Cross import milestone', type: 'milestone', startsAt: new Date().toISOString(),
    });
    assert.equal(ch.status, 201, JSON.stringify(ch.body));

    const exp = await get(INSTANCES.a, tok, `/api/admin/spaces/${srcId}/export`);
    assert.equal(exp.status, 200, JSON.stringify(exp.body));

    // Import SOURCE's export into a DIFFERENT space.
    const imp = await post(INSTANCES.a, tok, `/api/admin/spaces/${dstId}/import`, exp.body);
    assert.ok([200, 201].includes(imp.status), JSON.stringify(imp.body));

    const ents = await get(INSTANCES.a, tok, `/api/brain/spaces/${dstId}/entities`);
    assert.equal(ents.status, 200);
    assert.equal(
      ents.body.entities?.length, 2,
      'imported entities must be LISTED in the TARGET space — they were being written with the ' +
      'source space id, which made them invisible to every list while still being counted',
    );

    const edges = await get(INSTANCES.a, tok, `/api/brain/spaces/${dstId}/edges`);
    assert.equal(edges.status, 200);
    assert.equal(edges.body.edges?.length, 1, 'imported edges must be LISTED in the target space');

    const chrono = await get(INSTANCES.a, tok, `/api/brain/spaces/${dstId}/chrono`);
    assert.equal(chrono.status, 200);
    assert.equal(chrono.body.chrono?.length, 1, 'imported chrono entries must be LISTED in the target space');
  });

  it('export streams MANY documents as valid JSON and round-trips them exactly', async () => {
    // The export is streamed (P7): the envelope and each collection's array are written to the
    // socket incrementally, with the inter-document commas placed by hand. That comma logic is
    // invisible with 1-2 documents and is exactly where a streaming bug hides — a missing comma
    // (invalid JSON) or a trailing one only shows up across many docs and cursor batch
    // boundaries. So seed a few hundred and assert the response parses AND every document
    // survives a round trip. The old buffered `res.json()` could not have this bug; the
    // streamed version can, so it must be tested at scale.
    const N = 250;
    const srcId = `stream-src-${RUN_ID}`;
    const dstId = `stream-dst-${RUN_ID}`;
    for (const id of [srcId, dstId]) {
      const c = await post(INSTANCES.a, tok, '/api/spaces', { id, label: `Stream ${id}` });
      assert.equal(c.status, 201, JSON.stringify(c.body));
      roundTripSpaceIds.push(id);
    }

    // Bulk-write so seeding N is fast. Include characters that MUST be JSON-escaped, so the
    // streamed output is exercised on escaping too, not just plain ASCII.
    const facts = Array.from({ length: N }, (_, i) => ({
      fact: `stream doc ${i} — "quoted", \\backslash\\, newline\n, tab\t, unicode ☃`,
      tags: [`t${i % 5}`],
    }));
    const bulk = await post(INSTANCES.a, tok, `/api/brain/spaces/${srcId}/bulk`, { facts });
    assert.ok([200, 201, 207].includes(bulk.status), JSON.stringify(bulk.body)); // /bulk returns 207 Multi-Status
    assert.equal(bulk.body.errors?.length ?? 0, 0, `bulk seed must have no errors: ${JSON.stringify(bulk.body.errors)}`);

    // Export must be syntactically valid JSON with all N facts present.
    const exp = await get(INSTANCES.a, tok, `/api/admin/spaces/${srcId}/export`);
    assert.equal(exp.status, 200);
    assert.ok(Array.isArray(exp.body.facts), 'facts must be an array');
    assert.equal(exp.body.facts.length, N, `all ${N} facts must be exported, got ${exp.body.facts.length}`);
    // The tricky-character doc must survive escaping intact.
    const doc0 = exp.body.facts.find(m => m.fact.startsWith('stream doc 0 '));
    assert.ok(doc0 && doc0.fact.includes('☃') && doc0.fact.includes('"quoted"'), 'special characters must round-trip through the stream');

    // And the whole thing must import back cleanly.
    const imp = await post(INSTANCES.a, tok, `/api/admin/spaces/${dstId}/import`, exp.body);
    assert.ok([200, 201].includes(imp.status), JSON.stringify(imp.body));
    const stats = await get(INSTANCES.a, tok, `/api/brain/spaces/${dstId}/stats`);
    assert.equal(stats.body.facts, N, `all ${N} facts must import into the target space`);
  });
});
