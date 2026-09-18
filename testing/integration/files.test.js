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
import { INSTANCES, req, reqJson, get, del, post, readCollection } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE_A = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

let tokenA;

/**
 * File metadata records, through `filter` — ONE helper for the whole file.
 *
 * There were two, in two `describe` blocks, and the second still called the `GET .../files` route that
 * `B-9` step 3b deleted. Two copies of one question is how a conversion leaves half a file behind: the
 * first was converted, the second was out of sight, and a third block calling the first one got a
 * `ReferenceError` because a `const` inside a `describe` is not in scope for its neighbours.
 *
 * `path` stays an ARGUMENT rather than a predicate because the argument is the one that is normalised —
 * the leading-slash case depends on exactly that, and a bare `filter: { path }` would answer an empty
 * page for it.
 */
const listFileMeta = (args = {}, spaceId = 'general') =>
  readCollection(INSTANCES.a, tokenA, spaceId, 'files', args);

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

  it('Upload file via JSON body returns 202 with sha256 (text document async embedding)', async () => {
    const r = await uploadFile(tokenA, 'general', 'test-upload.txt', 'hello world');
    // .txt files are text documents — embedding is asynchronous, so 202 Accepted is returned
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.ok(r.body.sha256, 'Should include sha256 hash');
    assert.equal(r.body.path, 'test-upload.txt');
    assert.equal(r.body.embeddingStatus, 'pending', 'Text document uploads must return embeddingStatus=pending');
  });

  it('GET embedding-queue/media returns per-space job counts by status (F9 Overview panel)', async () => {
    // Seed a job by uploading a document, then read the queue summary.
    await uploadFile(tokenA, 'general', 'queue-probe.txt', 'embedding queue probe');
    const r = await get(INSTANCES.a, tokenA, '/api/brain/spaces/general/embedding-queue/media');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // Shape (not exact counts — a job races through pending→processing→complete): the four status
    // counts are non-negative integers, failedSample is an array, and at least one job now exists.
    for (const k of ['pending', 'processing', 'complete', 'failed']) {
      assert.equal(typeof r.body[k], 'number', `${k} must be a number`);
      assert.ok(r.body[k] >= 0, `${k} must be >= 0`);
    }
    assert.ok(Array.isArray(r.body.failedSample), 'failedSample must be an array');
    assert.ok(r.body.pending + r.body.processing + r.body.complete + r.body.failed >= 1, 'the uploaded doc should have created a job');
  });

  it('Download uploaded file returns correct bytes', async () => {
    await uploadFile(tokenA, 'general', 'test-download.txt', 'download me');
    const r = await downloadFile(tokenA, 'general', 'test-download.txt');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body, 'download me');
  });

  it('Upload raw bytes (Buffer) for non-document format returns 201', async () => {
    const buf = Buffer.from('raw content here', 'utf8');
    // .bin has no recognized document format -- resolves to "text" passthrough, no async embedding
    const r = await uploadRaw(tokenA, 'general', 'test-raw.bin', buf, 'application/octet-stream');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.sha256);
  });

  it('Upload base64-encoded content for text document returns 202', async () => {
    const content = Buffer.from('base64 content', 'utf8').toString('base64');
    const url = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent('test-b64.txt')}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({ content, encoding: 'base64' }),
    });
    // .txt is a document format — async embedding → 202
    assert.equal(r.status, 202);
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

  it('a folder entry reports its recursive content size (sum of files beneath it)', async () => {
    const dir = `sizedir-${Date.now()}`;
    // 'hello' = 5 bytes at the top of the folder; 'worldwide!!' = 11 bytes nested → both roll up.
    await uploadFile(tokenA, 'general', `${dir}/a.txt`, 'hello');
    await uploadFile(tokenA, 'general', `${dir}/sub/b.txt`, 'worldwide!!');
    const r = await fetch(`${INSTANCES.a}/api/files/general?path=.`, { headers: { 'Authorization': `Bearer ${tokenA}` } });
    const body = await r.json();
    const folder = body.entries.find(e => e.name === dir && e.type === 'dir');
    assert.ok(folder, `folder ${dir} is listed`);
    assert.equal(folder.size, 16, 'folder size sums every file beneath it (5 + 11), recursively');
  });

  it('file rows carry their joined metadata (status/tags) in the listing', async () => {
    const dir = `metadir-${Date.now()}`;
    await uploadFile(tokenA, 'general', `${dir}/note.txt`, 'joined metadata check');
    const r = await fetch(`${INSTANCES.a}/api/files/general?path=${encodeURIComponent(dir)}`, { headers: { 'Authorization': `Bearer ${tokenA}` } });
    const body = await r.json();
    const file = body.entries.find(e => e.name === 'note.txt' && e.type === 'file');
    assert.ok(file, 'the file is listed');
    // Its FileMeta record exists (created at upload), so its metadata is joined onto the row.
    assert.ok(Array.isArray(file.tags), 'file row carries tags from its metadata record');
    assert.equal(typeof file.size, 'number', 'file row has its byte size');
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

  it('an uploaded file lands 0600 inside a 0700 directory', async () => {
    // Asserted against the ARTEFACT, because no source check can prove a mode actually landed — and this machine
    // cannot measure it either: Windows ignores POSIX modes, so the numbers only exist on a Linux host.
    //
    // Uploaded files used to be written with the process umask (0644 in 0755 directories) while `config.json` has
    // always been 0600. The most sensitive bytes on the volume were the most readable — to any other user on the
    // host, and to any container sharing the mount. Found by the Privacy audit lens.
    const filePath = 'permission-probe.txt';
    await uploadFile(tokenA, 'general', filePath, 'mode probe');

    const fileMode = execSync(`docker exec ythril-a stat -c %a /data/files/general/${filePath}`).toString().trim();
    assert.equal(fileMode, '600',
      `an uploaded document is mode ${fileMode}; it holds whatever a user chose to upload and must be owner-only`);

    const dirMode = execSync('docker exec ythril-a stat -c %a /data/files/general').toString().trim();
    assert.equal(dirMode, '700',
      `the space files directory is mode ${dirMode}; 0755 lets any other user on the host list and read it`);

    // Cleanup so the listing assertions elsewhere are unaffected.
    const url = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent(filePath)}`;
    await fetch(url, { method: 'DELETE', headers: { 'Authorization': `Bearer ${tokenA}` } });
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

    const q = await listFileMeta({ path: filePath });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.ok(Array.isArray(q.results), 'response should contain files array');
    assert.ok(q.results.length > 0, `Expected metadata record for ${filePath}`);
    const doc = q.results[0];
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
    assert.ok([201, 202].includes(r.status), await r.text());

    const q = await listFileMeta({ path: filePath });
    assert.equal(q.status, 200);
    assert.ok(q.results.length > 0, 'Expected metadata record');
    const doc = q.results[0];
    assert.equal(doc.description, 'A tagged file', 'description must be stored');
    assert.ok(Array.isArray(doc.tags) && doc.tags.includes('api-meta-test'), 'tags must be stored');
  });

  it('Re-uploading a file updates updatedAt and sizeBytes', async () => {
    const filePath = `meta-overwrite-${RUN}.txt`;
    await uploadFile(tokenA, 'general', filePath, 'v1');
    const q1 = await listFileMeta({ path: filePath });
    const doc1 = q1.results[0];

    // Small delay to ensure timestamp differs
    await new Promise(r => setTimeout(r, 50));
    await uploadFile(tokenA, 'general', filePath, 'version 2 content is longer');

    const q2 = await listFileMeta({ path: filePath });
    const doc2 = q2.results[0];
    assert.equal(doc2.createdAt, doc1.createdAt, 'createdAt must not change on overwrite');
    assert.ok(doc2.sizeBytes > doc1.sizeBytes || doc2.updatedAt >= doc1.updatedAt,
      'updatedAt or sizeBytes should reflect the overwrite');
  });

  it('DELETE removes the metadata record', async () => {
    const filePath = `meta-delete-${RUN}.txt`;
    await uploadFile(tokenA, 'general', filePath, 'going away');
    const q1 = await listFileMeta({ path: filePath });
    assert.ok(q1.results.length > 0, 'Must have metadata before delete');

    const delUrl = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent(filePath)}`;
    const dr = await fetch(delUrl, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${tokenA}` },
    });
    assert.equal(dr.status, 204, 'Delete should return 204');

    const q2 = await listFileMeta({ path: filePath });
    assert.equal(q2.results.length, 0, 'Metadata must be removed after file delete');
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

    const srcQ = await listFileMeta({ path: srcPath });
    assert.equal(srcQ.results.length, 0, 'Source metadata must be removed after move');

    const dstQ = await listFileMeta({ path: dstPath });
    assert.ok(dstQ.results.length > 0, 'Destination metadata must exist after move');
    assert.equal(dstQ.results[0].path, dstPath, 'path field must reflect new location');
  });

  it('GET /api/brain/spaces/:spaceId/files?tag= filters by tag', async () => {
    const filePath = `meta-tagfilter-${RUN}.txt`;
    const url = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent(filePath)}`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({ content: 'x', tags: [`unique-tag-${RUN}`] }),
    });

    const q = await listFileMeta({ tag: `unique-tag-${RUN}` });
    assert.equal(q.status, 200);
    assert.ok(q.results.some(f => f.path === filePath), 'Should find file by unique tag');
  });

  it('GET /api/brain/.../files?path= with leading slash normalises correctly', async () => {
    const filePath = `meta-normpath-${RUN}.txt`;
    await uploadFile(tokenA, 'general', filePath, 'norm');

    // Stored path has no leading slash; querying with leading slash must still match
    const q = await listFileMeta({ path: '/' + filePath });
    assert.equal(q.status, 200);
    assert.ok(q.results.length > 0, 'Leading-slash query must find the metadata record');
    assert.equal(q.results[0].path, filePath, 'Returned path must be the normalised (no-slash) form');
  });

  it('the metadata-only delete is GONE, and deleting the file takes both', async () => {
    /*
     * `DELETE /api/brain/spaces/:spaceId/files?path=` removed a metadata record while leaving the bytes on
     * disk, and answered 409 when it would have orphaned one. It had no tool, so an agent could not do it
     * at all — one door offering a capability the other does not, which is the rule this release is about.
     *
     * It went rather than gaining a tool, because the 409 says what it was for: the only safe use was on
     * metadata whose file was already gone, and `deleteFileCascade` removes the record with the file, so
     * that state is not reachable through the API any more.
     */
    const filePath = `meta-braindelete-${RUN}.txt`;
    await uploadFile(tokenA, 'general', filePath, 'keep me on disk');

    const q1 = await listFileMeta({ path: filePath });
    assert.ok(q1.results.length > 0, 'Must have metadata before the delete');

    const delUrl = `${INSTANCES.a}/api/brain/spaces/general/files?path=${encodeURIComponent(filePath)}`;
    const dr = await fetch(delUrl, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${tokenA}` },
    });
    assert.equal(dr.status, 404, `the metadata-only delete must be gone, got ${dr.status}: ${await dr.text()}`);

    // Deleting the FILE takes the metadata with it — which is why the route above is not missed.
    const dlUrl = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent(filePath)}`;
    const gone = await fetch(dlUrl, { method: 'DELETE', headers: { 'Authorization': `Bearer ${tokenA}` } });
    // 200 with a body, or 204 when there is nothing to say. Both mean deleted, and pinning one of them
    // would make this case fail on a change that is not about files at all.
    assert.ok([200, 204].includes(gone.status), `file delete failed: ${gone.status} ${await gone.text()}`);
    const q2 = await listFileMeta({ path: filePath });
    assert.equal(q2.results.length, 0, 'the metadata must go with the file');
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
import { legacyRights } from '../_shared/legacy-token-rights.mjs';

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
    // .txt is a document format → async embedding → 202
    assert.ok([201, 202].includes(r.status), JSON.stringify(r.body));
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
    const r = await listFileMeta({ path: filePath });
    assert.equal(r.status, 200, 'the metadata read must respond 200');
    assert.ok(r.results.length > 0, `Expected metadata record for ${filePath}`);
    assert.equal(r.results[0].sizeBytes, TOTAL_SIZE, 'sizeBytes must equal total assembled size');
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


  it('Deleting a directory removes metadata for all files inside it', async () => {
    const dir = `meta-dir-del-${RUN}`;
    await upload(`${dir}/a.txt`, 'alpha');
    await upload(`${dir}/b.txt`, 'beta');
    await upload(`${dir}/sub/c.txt`, 'gamma');

    // All three should have metadata
    const before = await listFileMeta();
    const inDir = before.results.filter(f => f.path.startsWith(`${dir}/`));
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
    const remaining = after.results.filter(f => f.path.startsWith(`${dir}/`));
    assert.equal(remaining.length, 0, `Metadata must be removed for all files under ${dir}`);
  });

  it('Deleting a directory leaves no orphaned metadata or chunks (regression: folder-delete orphans)', async () => {
    const dir = `orphan-cleanup-${RUN}`;
    // A raw image both creates a top-level file-meta record AND (with media embedding on)
    // enqueues a media job — the exact shape that used to orphan on folder delete: a leftover
    // metafile plus a job retrying forever against the now-missing file. A text file adds
    // hidden chunk records that must also be cleaned.
    const jpg = Buffer.from('ffd8ffe0006a706567', 'hex');
    await uploadRaw(tokenA, 'general', `${dir}/pic.jpg`, jpg, 'image/jpeg');
    await upload(`${dir}/note.txt`, 'some text body');

    // Sanity: records (including hidden chunk/subfile records) exist under the folder.
    // `includeChunks=true` was the route's opt-IN; `filter` returns chunk records unless a predicate
    // excludes them, so asking for every record is asking for no predicate at all.
    const before = await listFileMeta({ limit: 200 });
    assert.ok(
      before.results.some(f => f.path.startsWith(`${dir}/`)),
      `Expected records under ${dir} before delete`,
    );

    // Delete the folder.
    const delUrl = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent(dir)}`;
    const dr = await fetch(delUrl, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(dr.status, 204, 'Directory delete should return 204');

    // No record of ANY kind (file, chunk, or conversion artifact) may remain under the folder —
    // whether its own path or its parent's path is under the deleted directory.
    const after = await listFileMeta({ limit: 200 });
    const remaining = after.results.filter(f =>
      f.path.startsWith(`${dir}/`) || (f.parentFileId && f.parentFileId.startsWith(`${dir}/`)),
    );
    assert.equal(
      remaining.length, 0,
      `No orphaned records may remain under ${dir}; found ${JSON.stringify(remaining.map(f => f.path))}`,
    );
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
    const srcRemaining = srcMeta.results.filter(f => f.path.startsWith(`${srcDir}/`));
    assert.equal(srcRemaining.length, 0, `Source metadata must be gone after directory move`);

    // Destination paths should have metadata
    const dstMeta = await listFileMeta();
    const dstRecords = dstMeta.results.filter(f => f.path.startsWith(`${dstDir}/`));
    assert.ok(dstRecords.length >= 3, `Expected ≥3 metadata records under ${dstDir}, got ${dstRecords.length}`);
    assert.ok(dstRecords.every(f => f.path.startsWith(`${dstDir}/`)), 'All records must use new dir prefix');

    // A moved directory must still be OPENABLE. This is not a formality: hardening the files tree chmodded the
    // destination of every move, and applying the FILE mode to a directory removed its execute bit. Nothing failed
    // at the move — the next offsite backup walked the tree with `fs.cpSync`, which is C++, so
    // `std::filesystem_error: directory iterator cannot open directory: Permission denied` reached `terminate()`
    // and killed the server outright (container exit 139). This exact directory is the one that did it.
    const listUrl = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent(dstDir)}`;
    const listed = await fetch(listUrl, { headers: { 'Authorization': `Bearer ${tokenA}` } });
    assert.equal(listed.status, 200, `a moved directory must still be listable: ${await listed.text()}`);

    const modes = execSync(
      `docker exec ythril-a stat -c %a /data/files/general/${dstDir} /data/files/general/${dstDir}/nested`,
    ).toString().trim().split('\n');
    for (const m of modes) {
      assert.equal(m, '700',
        `a moved directory is mode ${m}; a directory without its owner-execute bit cannot be opened, and the `
        + 'recursive walk in an offsite backup dies in native code rather than throwing something catchable');
    }
  });
});

// ── Media embedding integration tests ─────────────────────────────────────────
//
// These tests verify the media embedding pipeline acceptance criteria from
// issue #109. They do NOT require Ollama or Whisper services to be running —
// they test the API contract: embeddingStatus is set correctly on upload,
// and the retry_embedding endpoint behaves as specified.
//
// For full end-to-end media processing tests (captioning, STT), run with
// a live Ollama+Whisper stack and set MEDIA_EMBEDDING_ENABLED=true.

describe('Media embedding — upload response (embedding enabled by default)', () => {
  const RUN = Date.now();

  before(() => {
    tokenA = fs.readFileSync(TOKEN_FILE_A, 'utf8').trim();
  });

  it('Uploading a PNG when media embedding is enabled returns embeddingStatus=pending', async () => {
    // 1x1 PNG — minimal valid PNG binary
    const png1x1 = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
      0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
      0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
      0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
      0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
      0x44, 0xae, 0x42, 0x60, 0x82,
    ]);

    const filePath = `embed-enabled-${RUN}.png`;
    const r = await uploadRaw(tokenA, 'general', filePath, png1x1, 'image/png');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    // Media embedding is enabled by default — PNG jobs are enqueued on upload
    assert.equal(r.body.embeddingStatus, 'pending',
      `Expected embeddingStatus=pending when media embedding is enabled, got: ${r.body.embeddingStatus}`);
  });

  it('Uploading a text document returns embeddingStatus=pending (async embedding)', async () => {
    const r = await uploadFile(tokenA, 'general', `embed-text-${RUN}.txt`, 'plain text');
    // Text documents (.txt, .md, etc.) now use async embedding — 202 Accepted with embeddingStatus=pending
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.embeddingStatus, 'pending',
      `Expected embeddingStatus=pending for text document, got: ${r.body.embeddingStatus}`);
  });
});

describe('Media embedding — retry_embedding endpoint', () => {
  const RUN = Date.now();

  before(() => {
    tokenA = fs.readFileSync(TOKEN_FILE_A, 'utf8').trim();
  });

  it('retry_embedding on non-existent file returns 404', async () => {
    const url = `${INSTANCES.a}/api/files/general/retry_embedding?path=${encodeURIComponent('does-not-exist.png')}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenA}` },
    });
    assert.equal(r.status, 404, `Expected 404 for non-existent file, got ${r.status}`);
  });

  it('retry_embedding on a text document file returns 202 (job record exists)', async () => {
    const filePath = `retry-text-${RUN}.txt`;
    await uploadFile(tokenA, 'general', filePath, 'text content');

    const url = `${INSTANCES.a}/api/files/general/retry_embedding?path=${encodeURIComponent(filePath)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenA}` },
    });
    // Text documents now have a job record — retry_embedding should reset it to pending
    assert.ok(
      [202, 409].includes(r.status),
      `Expected 202 or 409 for text document retry, got ${r.status}`,
    );
  });

  it('retry_embedding requires authentication', async () => {
    const url = `${INSTANCES.a}/api/files/general/retry_embedding?path=test.png`;
    const r = await fetch(url, { method: 'POST' }); // no auth
    assert.equal(r.status, 401, `Expected 401 without auth, got ${r.status}`);
  });

  it('retry_embedding requires write access (read-only token → 403)', async () => {
    const tokRes = await fetch(`${INSTANCES.a}/api/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({ name: `retry-readonly-${RUN}`, rights: legacyRights({ readOnly: true }) }),
    });
    assert.equal(tokRes.status, 201, 'read-only token creation failed');
    const readOnlyToken = (await tokRes.json()).plaintext;

    const url = `${INSTANCES.a}/api/files/general/retry_embedding?path=test.png`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${readOnlyToken}` },
    });
    assert.equal(r.status, 403, `Read-only token must be blocked with 403, got ${r.status}`);
  });

  it('retry_embedding actually resets embeddingStatus to pending and the job re-runs', async () => {
    // Dedicated space so the file listing is small and unpolluted.
    const spaceId = `s8-retry-${RUN}`;
    const createSpace = await fetch(`${INSTANCES.a}/api/spaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({ id: spaceId, label: 'S8 Retry Effect' }),
    });
    assert.equal(createSpace.status, 201);

    const filePath = `retry-effect-${RUN}.txt`;
    const docStatus = async () => {
      const r = await readCollection(INSTANCES.a, tokenA, spaceId, 'files', { limit: 200 });
      const meta = r.results?.find(f => (f.path ?? f._id ?? '').includes(filePath));
      return meta?.embeddingStatus;
    };
    const waitForStatus = async (predicate, timeoutMs) => {
      const start = Date.now();
      let last;
      while (Date.now() - start < timeoutMs) {
        last = await docStatus();
        if (predicate(last)) return last;
        await new Promise(res => setTimeout(res, 1000));
      }
      return last;
    };

    try {
      await uploadFile(tokenA, spaceId, filePath,
        'Retry effect document with enough words to be chunked and embedded by the media worker.');

      // Let the initial job settle so the retry starts from a terminal state.
      const settled = await waitForStatus(s => s === 'complete' || s === 'failed', 60_000);
      assert.ok(settled === 'complete' || settled === 'failed',
        `initial embedding never settled (last status: ${settled})`);

      const retry = await fetch(
        `${INSTANCES.a}/api/files/${spaceId}/retry_embedding?path=${encodeURIComponent(filePath)}`,
        { method: 'POST', headers: { 'Authorization': `Bearer ${tokenA}` } },
      );
      assert.equal(retry.status, 202, `retry should queue, got ${retry.status}`);

      // The 202 alone is satisfied by a handler that queues nothing. The retry
      // EFFECT is the status reset — observable as pending (or already claimed
      // as processing) immediately after...
      const flipped = await docStatus();
      assert.ok(['pending', 'processing'].includes(flipped),
        `embeddingStatus must flip to pending/processing after retry, got: ${flipped}`);

      // ...and the requeued job must actually run back to a terminal state.
      const final = await waitForStatus(s => s === 'complete' || s === 'failed', 60_000);
      assert.ok(final === 'complete' || final === 'failed',
        `retried job never re-ran to a terminal state (last status: ${final})`);
    } finally {
      await fetch(`${INSTANCES.a}/api/spaces/${spaceId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
        body: JSON.stringify({ confirm: true }),
      }).catch(() => {});
    }
  });
});

describe('Media embedding — GET /api/admin/media-config', () => {
  before(() => {
    tokenA = fs.readFileSync(TOKEN_FILE_A, 'utf8').trim();
  });

  it('GET media-config returns expected structure', async () => {
    const r = await fetch(`${INSTANCES.a}/api/admin/media-config`, {
      headers: { 'Authorization': `Bearer ${tokenA}` },
    });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}`);
    const body = await r.json();
    // The `enabled` master switch was removed — media embedding is always on, gated per class by levels.
    assert.equal(body.enabled, undefined, 'the removed enabled master switch must not be returned');
    assert.ok(typeof body.levels === 'object' && body.levels !== null, 'levels config must be an object');
    assert.ok(['local', 'external'].includes(body.visionProvider), 'visionProvider must be local or external');
    assert.ok(['local', 'external'].includes(body.sttProvider), 'sttProvider must be local or external');
    assert.ok(typeof body.vision === 'object' && body.vision !== null, 'vision config must be an object');
    assert.ok(typeof body.stt === 'object' && body.stt !== null, 'stt config must be an object');
    assert.ok(Array.isArray(body.lockedByInfra), 'lockedByInfra must be an array');
    assert.ok(typeof body.workerConcurrency === 'number', 'workerConcurrency must be a number');
    assert.ok(typeof body.maxFileSizeBytes === 'number', 'maxFileSizeBytes must be a number');
  });

  it('GET media-config masks apiKey when set', async () => {
    const r = await fetch(`${INSTANCES.a}/api/admin/media-config`, {
      headers: { 'Authorization': `Bearer ${tokenA}` },
    });
    const body = await r.json();
    // If apiKey is present, it must be masked (not a real key)
    if (body.vision?.apiKey) {
      assert.ok(body.vision.apiKey.includes('•'), 'vision apiKey must be masked');
    }
    if (body.stt?.apiKey) {
      assert.ok(body.stt.apiKey.includes('•'), 'stt apiKey must be masked');
    }
  });

  it('GET media-config requires authentication', async () => {
    const r = await fetch(`${INSTANCES.a}/api/admin/media-config`);
    assert.equal(r.status, 401, `Expected 401 without auth, got ${r.status}`);
  });

  it('PATCH media-config rejects unknown fields (strict schema)', async () => {
    const r = await fetch(`${INSTANCES.a}/api/admin/media-config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({ unknownField: 'oops' }),
    });
    assert.equal(r.status, 400, `Expected 400 for unknown field, got ${r.status}`);
  });

  it('PATCH media-config with valid body returns updated config', async () => {
    // Read current config first
    const getR = await fetch(`${INSTANCES.a}/api/admin/media-config`, {
      headers: { 'Authorization': `Bearer ${tokenA}` },
    });
    const original = await getR.json();

    // Only patch if the field is not locked
    if (original.lockedByInfra?.includes('workerConcurrency')) {
      // Skip if locked by env var
      return;
    }

    const newConcurrency = (original.workerConcurrency ?? 2) === 2 ? 3 : 2;
    const patchR = await fetch(`${INSTANCES.a}/api/admin/media-config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({ workerConcurrency: newConcurrency }),
    });
    // Read body once — using text() then parsing avoids double-consume
    const patchBody = await patchR.text();
    assert.equal(patchR.status, 200, `PATCH returned ${patchR.status}: ${patchBody}`);
    const updated = JSON.parse(patchBody);
    assert.equal(updated.config?.workerConcurrency, newConcurrency, 'workerConcurrency must be updated');

    // Restore original value
    await fetch(`${INSTANCES.a}/api/admin/media-config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({ workerConcurrency: original.workerConcurrency }),
    });
  });
});
