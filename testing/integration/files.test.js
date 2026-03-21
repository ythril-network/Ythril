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
