/**
 * Integration tests: File manager API  (/api/files/:spaceId)
 *
 * Covers:
 *  - Upload file (JSON body, raw bytes)
 *  - Download file (GET â†’ raw bytes)
 *  - List directory (GET â†’ JSON)
 *  - Delete file (204), delete file missing (404)
 *  - Delete directory requires { confirm: true } (422 without, 204 with)
 *  - Move/rename file (PATCH)
 *  - mkdir (POST /mkdir)
 *  - Path traversal blocked (400)
 *  - Non-existent path â†’ 404
 *  - Non-existent space â†’ 404
 *  - No auth â†’ 401
 *
 * Run: node --test testing/integration/files.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, req, reqJson, get, del, post } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE_A = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

let tokenA;

/** Helper: upload file as JSON body */
async function uploadFile(token, spaceId, filePath, content) {
  const url = `${INSTANCES.a}/api/files/${spaceId}?path=${encodeURIComponent(filePath)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ content, encoding: 'utf8' }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** Helper: download raw file bytes */
async function downloadFile(token, spaceId, filePath) {
  const url = `${INSTANCES.a}/api/files/${spaceId}?path=${encodeURIComponent(filePath)}`;
  const r = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const body = r.headers.get('content-type')?.includes('application/json')
    ? await r.json().catch(() => null)
    : await r.text().catch(() => null);
  return { status: r.status, body, contentType: r.headers.get('content-type') };
}

/** Helper: raw-bytes upload */
async function uploadRaw(token, spaceId, filePath, buffer, mimeType = 'application/octet-stream') {
  const url = `${INSTANCES.a}/api/files/${spaceId}?path=${encodeURIComponent(filePath)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': mimeType,
      'Authorization': `Bearer ${token}`,
    },
    body: buffer,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

describe('File upload & download', () => {
  before(() => {
    tokenA = fs.readFileSync(TOKEN_FILE_A, 'utf8').trim();
  });

  it('Upload file via JSON body returns 201 with sha256', async () => {
    const r = await uploadFile(tokenA, 'general', 'test-upload.txt', 'hello world');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.sha256, 'Should include sha256 hash');
    assert.equal(r.body.path, 'test-upload.txt');
  });

  it('Download uploaded file returns correct bytes', async () => {
    await uploadFile(tokenA, 'general', 'test-download.txt', 'download me');
    const r = await downloadFile(tokenA, 'general', 'test-download.txt');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body, 'download me');
  });

  it('Upload raw bytes (Buffer) returns 201', async () => {
    const buf = Buffer.from('raw content here', 'utf8');
    const r = await uploadRaw(tokenA, 'general', 'test-raw.bin', buf, 'application/octet-stream');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.sha256);
  });

  it('Upload base64-encoded content returns 201', async () => {
    const content = Buffer.from('base64 content', 'utf8').toString('base64');
    const url = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent('test-b64.txt')}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({ content, encoding: 'base64' }),
    });
    assert.equal(r.status, 201);
  });

  it('Upload with invalid encoding returns 400', async () => {
    const url = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent('bad-enc.txt')}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({ content: 'test', encoding: 'rot13' }),
    });
    assert.equal(r.status, 400);
  });
});

describe('Directory listing', () => {
  before(() => {
    tokenA = fs.readFileSync(TOKEN_FILE_A, 'utf8').trim();
  });

  it('GET root dir returns JSON listing', async () => {
    const url = `${INSTANCES.a}/api/files/general`;
    const r = await fetch(url, { headers: { 'Authorization': `Bearer ${tokenA}` } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.entries), 'Should return entries array');
    assert.equal(body.type, 'dir');
  });

  it('Listing non-existent dir returns 404', async () => {
    const url = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent('no-such-dir/')}`;
    const r = await fetch(url, { headers: { 'Authorization': `Bearer ${tokenA}` } });
    assert.equal(r.status, 404);
  });
});

describe('mkdir', () => {
  before(() => {
    tokenA = fs.readFileSync(TOKEN_FILE_A, 'utf8').trim();
  });

  it('POST /mkdir creates a directory and returns 201', async () => {
    const url = `${INSTANCES.a}/api/files/general/mkdir?path=${encodeURIComponent('testdir-' + Date.now())}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenA}` },
    });
    const body = await r.json().catch(() => null);
    assert.equal(r.status, 201, JSON.stringify(body));
    assert.ok(body?.created);
  });
});

describe('Delete file and directory', () => {
  before(() => {
    tokenA = fs.readFileSync(TOKEN_FILE_A, 'utf8').trim();
  });

  it('DELETE file returns 204', async () => {
    await uploadFile(tokenA, 'general', 'to-delete.txt', 'bye');
    const url = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent('to-delete.txt')}`;
    const r = await fetch(url, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${tokenA}` },
    });
    assert.equal(r.status, 204);
  });

  it('DELETE non-existent file returns 404', async () => {
    const url = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent('gone.txt')}`;
    const r = await fetch(url, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${tokenA}` },
    });
    assert.equal(r.status, 404);
  });

  it('DELETE orphaned meta (file removed externally) returns 204 and cleans up meta', async () => {
    // Upload a file so both the disk copy and the meta record exist.
    const filePath = 'orphan-test.txt';
    await uploadFile(tokenA, 'general', filePath, 'orphan content');

    // Remove the physical file directly from the container, leaving the meta record intact.
    execSync(`docker exec ythril-a rm /data/files/general/${filePath}`);

    // The DELETE endpoint must detect the orphan, clean up meta, and return 204.
    const url = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent(filePath)}`;
    const r = await fetch(url, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${tokenA}` },
    });
    assert.equal(r.status, 204, `Expected 204 for orphaned meta, got ${r.status}`);

    // Verify meta was cleaned up: a second DELETE must return 404 (no disk, no meta).
    const r2 = await fetch(url, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${tokenA}` },
    });
    assert.equal(r2.status, 404, `Expected 404 after orphan cleanup, got ${r2.status}`);
  });

  it('DELETE directory without confirm returns 422', async () => {
    const ts = Date.now();
    // Create the directory and a file inside
    await fetch(`${INSTANCES.a}/api/files/general/mkdir?path=${encodeURIComponent('del-dir-' + ts)}`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${tokenA}` },
    });
    await uploadFile(tokenA, 'general', `del-dir-${ts}/file.txt`, 'hello');
    const url = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent('del-dir-' + ts)}`;
    const r = await fetch(url, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      // No confirm
    });
    assert.equal(r.status, 422, 'Directory delete without confirm should return 422');
  });

  it('DELETE directory with { confirm:true } returns 204', async () => {
    const ts = Date.now();
    await fetch(`${INSTANCES.a}/api/files/general/mkdir?path=${encodeURIComponent('del-dir2-' + ts)}`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${tokenA}` },
    });
    await uploadFile(tokenA, 'general', `del-dir2-${ts}/inner.txt`, 'hi');
    const url = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent('del-dir2-' + ts)}`;
    const r = await fetch(url, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(r.status, 204, 'Directory delete with confirm should return 204');
  });
});

describe('Move/rename (PATCH)', () => {
  before(() => {
    tokenA = fs.readFileSync(TOKEN_FILE_A, 'utf8').trim();
  });

  it('PATCH moves file to new path', async () => {
    const ts = Date.now();
    await uploadFile(tokenA, 'general', `move-src-${ts}.txt`, 'move me');
    const url = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent(`move-src-${ts}.txt`)}`;
    const r = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({ destination: `move-dst-${ts}.txt` }),
    });
    assert.equal(r.status, 200, await r.text());
    // Old path should be gone
    const old = await downloadFile(tokenA, 'general', `move-src-${ts}.txt`);
    assert.equal(old.status, 404, 'Old path should be 404 after move');
    // New path should exist
    const neo = await downloadFile(tokenA, 'general', `move-dst-${ts}.txt`);
    assert.equal(neo.status, 200, 'New path should be 200 after move');
  });

  it('PATCH without destination returns 400', async () => {
    await uploadFile(tokenA, 'general', 'no-dst.txt', 'x');
    const url = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent('no-dst.txt')}`;
    const r = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
  });
});

describe('File metadata (MongoDB)', () => {
  const RUN = Date.now();

  before(() => {
    tokenA = fs.readFileSync(TOKEN_FILE_A, 'utf8').trim();
  });

  /** Fetch file metadata records from the brain API */
  async function listFileMeta(token, spaceId, queryParams = '') {
    const url = `${INSTANCES.a}/api/brain/spaces/${spaceId}/files${queryParams}`;
    const r = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }

  /** Fetch brain stats for a space */
  async function getStats(token, spaceId) {
    const url = `${INSTANCES.a}/api/brain/spaces/${spaceId}/stats`;
    const r = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }

  it('Upload creates a metadata record in the files collection', async () => {
    const filePath = `meta-test-${RUN}.txt`;
    await uploadFile(tokenA, 'general', filePath, 'metadata content');

    const q = await listFileMeta(tokenA, 'general', `?path=${encodeURIComponent(filePath)}`);
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.ok(Array.isArray(q.body?.files), 'response should contain files array');
    assert.ok(q.body.files.length > 0, `Expected metadata record for ${filePath}`);
    const doc = q.body.files[0];
    assert.ok(doc.sizeBytes > 0, 'sizeBytes must be set');
    assert.ok(typeof doc.createdAt === 'string', 'createdAt must be set');
    assert.ok(typeof doc.updatedAt === 'string', 'updatedAt must be set');
    assert.ok(doc.author && typeof doc.author.instanceId === 'string', 'author must be set');
  });

  it('Upload with description and tags stores those in metadata', async () => {
    const filePath = `meta-tagged-${RUN}.txt`;
    const url = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent(filePath)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({
        content: 'tagged content',
        encoding: 'utf8',
        description: 'A tagged file',
        tags: ['api-meta-test', 'tagged'],
      }),
    });
    assert.equal(r.status, 201, await r.text());

    const q = await listFileMeta(tokenA, 'general', `?path=${encodeURIComponent(filePath)}`);
    assert.equal(q.status, 200);
    assert.ok(q.body.files.length > 0, 'Expected metadata record');
    const doc = q.body.files[0];
    assert.equal(doc.description, 'A tagged file', 'description must be stored');
    assert.ok(Array.isArray(doc.tags) && doc.tags.includes('api-meta-test'), 'tags must be stored');
  });

  it('Re-uploading a file updates updatedAt and sizeBytes', async () => {
    const filePath = `meta-overwrite-${RUN}.txt`;
    await uploadFile(tokenA, 'general', filePath, 'v1');
    const q1 = await listFileMeta(tokenA, 'general', `?path=${encodeURIComponent(filePath)}`);
    const doc1 = q1.body.files[0];

    // Small delay to ensure timestamp differs
    await new Promise(r => setTimeout(r, 50));
    await uploadFile(tokenA, 'general', filePath, 'version 2 content is longer');

    const q2 = await listFileMeta(tokenA, 'general', `?path=${encodeURIComponent(filePath)}`);
    const doc2 = q2.body.files[0];
    assert.equal(doc2.createdAt, doc1.createdAt, 'createdAt must not change on overwrite');
    assert.ok(doc2.sizeBytes > doc1.sizeBytes || doc2.updatedAt >= doc1.updatedAt,
      'updatedAt or sizeBytes should reflect the overwrite');
  });

  it('DELETE removes the metadata record', async () => {
    const filePath = `meta-delete-${RUN}.txt`;
    await uploadFile(tokenA, 'general', filePath, 'going away');
    const q1 = await listFileMeta(tokenA, 'general', `?path=${encodeURIComponent(filePath)}`);
    assert.ok(q1.body.files.length > 0, 'Must have metadata before delete');

    const delUrl = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent(filePath)}`;
    const dr = await fetch(delUrl, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${tokenA}` },
    });
    assert.equal(dr.status, 204, 'Delete should return 204');

    const q2 = await listFileMeta(tokenA, 'general', `?path=${encodeURIComponent(filePath)}`);
    assert.equal(q2.body.files.length, 0, 'Metadata must be removed after file delete');
  });

  it('PATCH (move) updates the metadata path', async () => {
    const srcPath = `meta-move-src-${RUN}.txt`;
    const dstPath = `meta-move-dst-${RUN}.txt`;
    await uploadFile(tokenA, 'general', srcPath, 'move me');

    const patchUrl = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent(srcPath)}`;
    const pr = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({ destination: dstPath }),
    });
    assert.equal(pr.status, 200, await pr.text());

    const srcQ = await listFileMeta(tokenA, 'general', `?path=${encodeURIComponent(srcPath)}`);
    assert.equal(srcQ.body.files.length, 0, 'Source metadata must be removed after move');

    const dstQ = await listFileMeta(tokenA, 'general', `?path=${encodeURIComponent(dstPath)}`);
    assert.ok(dstQ.body.files.length > 0, 'Destination metadata must exist after move');
    assert.equal(dstQ.body.files[0].path, dstPath, 'path field must reflect new location');
  });

  it('GET /api/brain/spaces/:spaceId/files?tag= filters by tag', async () => {
    const filePath = `meta-tagfilter-${RUN}.txt`;
    const url = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent(filePath)}`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({ content: 'x', tags: [`unique-tag-${RUN}`] }),
    });

    const q = await listFileMeta(tokenA, 'general', `?tag=${encodeURIComponent(`unique-tag-${RUN}`)}`);
    assert.equal(q.status, 200);
    assert.ok(q.body.files.some(f => f.path === filePath), 'Should find file by unique tag');
  });

  it('GET /api/brain/.../files?path= with leading slash normalises correctly', async () => {
    const filePath = `meta-normpath-${RUN}.txt`;
    await uploadFile(tokenA, 'general', filePath, 'norm');

    // Stored path has no leading slash; querying with leading slash must still match
    const q = await listFileMeta(tokenA, 'general', `?path=${encodeURIComponent('/' + filePath)}`);
    assert.equal(q.status, 200);
    assert.ok(q.body.files.length > 0, 'Leading-slash query must find the metadata record');
    assert.equal(q.body.files[0].path, filePath, 'Returned path must be the normalised (no-slash) form');
  });

  it('DELETE /api/brain/.../files removes metadata without deleting the file on disk', async () => {
    const filePath = `meta-braindelete-${RUN}.txt`;
    await uploadFile(tokenA, 'general', filePath, 'keep me on disk');

    const q1 = await listFileMeta(tokenA, 'general', `?path=${encodeURIComponent(filePath)}`);
    assert.ok(q1.body.files.length > 0, 'Must have metadata before brain-delete');

    const delUrl = `${INSTANCES.a}/api/brain/spaces/general/files?path=${encodeURIComponent(filePath)}`;
    const dr = await fetch(delUrl, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${tokenA}` },
    });
    assert.equal(dr.status, 204, `Expected 204, got ${dr.status}: ${await dr.text()}`);

    const q2 = await listFileMeta(tokenA, 'general', `?path=${encodeURIComponent(filePath)}`);
    assert.equal(q2.body.files.length, 0, 'Metadata must be gone after brain DELETE');

    // File itself must still be downloadable
    const dlUrl = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent(filePath)}`;
    const dlr = await fetch(dlUrl, { headers: { 'Authorization': `Bearer ${tokenA}` } });
    assert.equal(dlr.status, 200, 'File on disk must still exist after metadata-only delete');
  });

  it('Brain stats endpoint includes files count', async () => {
    const before = await getStats(tokenA, 'general');
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.ok(typeof before.body.files === 'number', 'stats must include files count');
    assert.ok(before.body.files >= 0, 'files count must be non-negative');

    // Upload a new file and verify count increases
    await uploadFile(tokenA, 'general', `stats-count-${RUN}.txt`, 'counting');
    const after = await getStats(tokenA, 'general');
    assert.ok(after.body.files >= before.body.files + 1,
      `Expected files count to increment: before=${before.body.files}, after=${after.body.files}`);
  });
});

describe('Error cases', () => {
  before(() => {
    tokenA = fs.readFileSync(TOKEN_FILE_A, 'utf8').trim();
  });

  it('Non-existent space returns 404', async () => {
    const url = `${INSTANCES.a}/api/files/no-such-space?path=test.txt`;
    const r = await fetch(url, { headers: { 'Authorization': `Bearer ${tokenA}` } });
    assert.equal(r.status, 404);
  });

  it('Missing path query param on upload returns 400', async () => {
    const url = `${INSTANCES.a}/api/files/general`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({ content: 'test' }),
    });
    assert.equal(r.status, 400);
  });

  it('No auth on file download returns 401', async () => {
    await uploadFile(tokenA, 'general', 'auth-test.txt', 'guarded');
    const url = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent('auth-test.txt')}`;
    const r = await fetch(url); // no auth header
    assert.equal(r.status, 401);
  });
});

// ── Chunked upload (Content-Range) ──────────────────────────────────────────

import { createHash } from 'crypto';

/** Upload a chunk with Content-Range header */
async function uploadChunk(token, spaceId, filePath, buffer, start, end, total) {
  const url = `${INSTANCES.a}/api/files/${spaceId}?path=${encodeURIComponent(filePath)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Authorization': `Bearer ${token}`,
    },
    body: buffer,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** Query upload-status */
async function uploadStatus(token, spaceId, filePath, total) {
  const url = `${INSTANCES.a}/api/files/${spaceId}/upload-status?path=${encodeURIComponent(filePath)}&total=${total}`;
  const r = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

describe('Chunked upload (Content-Range)', () => {
  const RUN = Date.now();
  const CHUNK_SIZE = 5 * 1024; // 5 KB
  const TOTAL_SIZE = 15 * 1024; // 15 KB, 3 chunks
  let fullBuffer;
  let fullSha256;

  before(() => {
    tokenA = fs.readFileSync(TOKEN_FILE_A, 'utf8').trim();
    fullBuffer = Buffer.alloc(TOTAL_SIZE);
    for (let i = 0; i < TOTAL_SIZE; i++) fullBuffer[i] = i % 256;
    fullSha256 = createHash('sha256').update(fullBuffer).digest('hex');
  });

  it('Upload file in 3 chunks and verify final sha256', async () => {
    const filePath = `chunked-${RUN}.bin`;

    // Chunk 1: bytes 0-5119/15360
    const c1 = await uploadChunk(tokenA, 'general', filePath, fullBuffer.subarray(0, CHUNK_SIZE), 0, CHUNK_SIZE - 1, TOTAL_SIZE);
    assert.equal(c1.status, 202, `Chunk 1: ${JSON.stringify(c1.body)}`);
    assert.ok(c1.body.received > 0, 'Should report received bytes');

    // Chunk 2: bytes 5120-10239/15360
    const c2 = await uploadChunk(tokenA, 'general', filePath, fullBuffer.subarray(CHUNK_SIZE, 2 * CHUNK_SIZE), CHUNK_SIZE, 2 * CHUNK_SIZE - 1, TOTAL_SIZE);
    assert.equal(c2.status, 202, `Chunk 2: ${JSON.stringify(c2.body)}`);

    // Chunk 3 (final): bytes 10240-15359/15360
    const c3 = await uploadChunk(tokenA, 'general', filePath, fullBuffer.subarray(2 * CHUNK_SIZE, TOTAL_SIZE), 2 * CHUNK_SIZE, TOTAL_SIZE - 1, TOTAL_SIZE);
    assert.equal(c3.status, 201, `Final chunk should return 201: ${JSON.stringify(c3.body)}`);
    assert.equal(c3.body.sha256, fullSha256, 'Assembled file sha256 should match');
  });

  it('Upload-status returns received bytes for in-progress upload', async () => {
    const filePath = `chunked-status-${RUN}.bin`;

    // Upload first chunk only
    await uploadChunk(tokenA, 'general', filePath, fullBuffer.subarray(0, CHUNK_SIZE), 0, CHUNK_SIZE - 1, TOTAL_SIZE);

    const s = await uploadStatus(tokenA, 'general', filePath, TOTAL_SIZE);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.received, CHUNK_SIZE, `Should report ${CHUNK_SIZE} received`);
  });

  it('Upload-status returns 0 for unknown upload', async () => {
    const s = await uploadStatus(tokenA, 'general', `nonexistent-${RUN}.bin`, 999);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.received, 0, 'Unknown upload should have 0 received');
  });

  it('Duplicate chunk (resume) is accepted without error', async () => {
    const filePath = `chunked-resume-${RUN}.bin`;

    // Send chunk 1 twice
    await uploadChunk(tokenA, 'general', filePath, fullBuffer.subarray(0, CHUNK_SIZE), 0, CHUNK_SIZE - 1, TOTAL_SIZE);
    const dup = await uploadChunk(tokenA, 'general', filePath, fullBuffer.subarray(0, CHUNK_SIZE), 0, CHUNK_SIZE - 1, TOTAL_SIZE);
    assert.equal(dup.status, 202, `Duplicate should be accepted: ${JSON.stringify(dup.body)}`);

    // Continue and finish
    await uploadChunk(tokenA, 'general', filePath, fullBuffer.subarray(CHUNK_SIZE, 2 * CHUNK_SIZE), CHUNK_SIZE, 2 * CHUNK_SIZE - 1, TOTAL_SIZE);
    const c3 = await uploadChunk(tokenA, 'general', filePath, fullBuffer.subarray(2 * CHUNK_SIZE, TOTAL_SIZE), 2 * CHUNK_SIZE, TOTAL_SIZE - 1, TOTAL_SIZE);
    assert.equal(c3.status, 201, `Final: ${JSON.stringify(c3.body)}`);
    assert.equal(c3.body.sha256, fullSha256, 'Resume upload sha256 should match');
  });

  it('Assembled file is downloadable with correct content', async () => {
    const filePath = `chunked-${RUN}.bin`;
    const url = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent(filePath)}`;
    const r = await fetch(url, { headers: { 'Authorization': `Bearer ${tokenA}` } });
    assert.equal(r.status, 200);
    const downloaded = Buffer.from(await r.arrayBuffer());
    assert.equal(downloaded.length, TOTAL_SIZE, 'Downloaded size should match');
    const dlSha = createHash('sha256').update(downloaded).digest('hex');
    assert.equal(dlSha, fullSha256, 'Downloaded content should match original');
  });

  it('Non-chunked upload still works (regression)', async () => {
    const buf = Buffer.from('still works without Content-Range', 'utf8');
    const r = await uploadRaw(tokenA, 'general', `regression-${RUN}.txt`, buf);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.sha256);
  });

  it('Completed chunked upload creates a metadata record', async () => {
    const filePath = `chunked-meta-${RUN}.bin`;

    // Upload all 3 chunks
    await uploadChunk(tokenA, 'general', filePath, fullBuffer.subarray(0, CHUNK_SIZE), 0, CHUNK_SIZE - 1, TOTAL_SIZE);
    await uploadChunk(tokenA, 'general', filePath, fullBuffer.subarray(CHUNK_SIZE, 2 * CHUNK_SIZE), CHUNK_SIZE, 2 * CHUNK_SIZE - 1, TOTAL_SIZE);
    const final = await uploadChunk(tokenA, 'general', filePath, fullBuffer.subarray(2 * CHUNK_SIZE, TOTAL_SIZE), 2 * CHUNK_SIZE, TOTAL_SIZE - 1, TOTAL_SIZE);
    assert.equal(final.status, 201, `Final chunk: ${JSON.stringify(final.body)}`);

    // Verify metadata record was created
    const url = `${INSTANCES.a}/api/brain/spaces/general/files?path=${encodeURIComponent(filePath)}`;
    const r = await fetch(url, { headers: { 'Authorization': `Bearer ${tokenA}` } });
    assert.equal(r.status, 200, 'Metadata endpoint must respond 200');
    const body = await r.json();
    assert.ok(body.files.length > 0, `Expected metadata record for ${filePath}`);
    assert.equal(body.files[0].sizeBytes, TOTAL_SIZE, 'sizeBytes must equal total assembled size');
  });
});

describe('File metadata (MongoDB) — directory operations', () => {
  const RUN = Date.now();

  before(() => {
    tokenA = fs.readFileSync(TOKEN_FILE_A, 'utf8').trim();
  });

  /** Upload a text file via JSON body */
  async function upload(filePath, content) {
    return uploadFile(tokenA, 'general', filePath, content);
  }

  /** Fetch file metadata records */
  async function listFileMeta(queryParams = '') {
    const url = `${INSTANCES.a}/api/brain/spaces/general/files${queryParams}`;
    const r = await fetch(url, { headers: { 'Authorization': `Bearer ${tokenA}` } });
    return { status: r.status, body: await r.json().catch(() => null) };
  }

  it('Deleting a directory removes metadata for all files inside it', async () => {
    const dir = `meta-dir-del-${RUN}`;
    await upload(`${dir}/a.txt`, 'alpha');
    await upload(`${dir}/b.txt`, 'beta');
    await upload(`${dir}/sub/c.txt`, 'gamma');

    // All three should have metadata
    const before = await listFileMeta();
    const inDir = before.body.files.filter(f => f.path.startsWith(`${dir}/`));
    assert.ok(inDir.length >= 3, `Expected ≥3 metadata records under ${dir}, got ${inDir.length}`);

    // Delete the directory
    const delUrl = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent(dir)}`;
    const dr = await fetch(delUrl, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(dr.status, 204, 'Directory delete should return 204');

    // Metadata for all child files must be gone
    const after = await listFileMeta();
    const remaining = after.body.files.filter(f => f.path.startsWith(`${dir}/`));
    assert.equal(remaining.length, 0, `Metadata must be removed for all files under ${dir}`);
  });

  it('Moving a directory updates metadata paths for all files inside it', async () => {
    const srcDir = `meta-dir-mv-src-${RUN}`;
    const dstDir = `meta-dir-mv-dst-${RUN}`;
    await upload(`${srcDir}/x.txt`, 'x');
    await upload(`${srcDir}/y.txt`, 'y');
    await upload(`${srcDir}/nested/z.txt`, 'z');

    // Move the directory
    const patchUrl = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent(srcDir)}`;
    const pr = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({ destination: dstDir }),
    });
    assert.equal(pr.status, 200, await pr.text());

    // Source paths should have no metadata
    const srcMeta = await listFileMeta();
    const srcRemaining = srcMeta.body.files.filter(f => f.path.startsWith(`${srcDir}/`));
    assert.equal(srcRemaining.length, 0, `Source metadata must be gone after directory move`);

    // Destination paths should have metadata
    const dstMeta = await listFileMeta();
    const dstRecords = dstMeta.body.files.filter(f => f.path.startsWith(`${dstDir}/`));
    assert.ok(dstRecords.length >= 3, `Expected ≥3 metadata records under ${dstDir}, got ${dstRecords.length}`);
    assert.ok(dstRecords.every(f => f.path.startsWith(`${dstDir}/`)), 'All records must use new dir prefix');
  });
});
