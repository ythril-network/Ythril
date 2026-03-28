/**
 * Red-team tests: Path traversal attack attempts
 *
 * Verifies that the sandbox (resolveSafePath) blocks all attempts to escape
 * the space root — including URL encoding, double encoding, null bytes, and
 * Unicode normalization bypasses.
 *
 * All attempts must return 400 (or 404 for valid paths that simply don't
 * exist) — never return file content from outside the space root.
 *
 * Run: node --test testing/red-team-tests/path-traversal.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

let token;

/** GET /api/files/general?path=<raw> — raw param is placed directly in the URL */
async function getPath(rawParam) {
  const url = `${INSTANCES.a}/api/files/general?path=${rawParam}`;
  const r = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  return { status: r.status, url };
}

/** DELETE with a raw path parameter */
async function deletePath(rawParam) {
  const url = `${INSTANCES.a}/api/files/general?path=${rawParam}`;
  const r = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  return r.status;
}

describe('Path traversal — GET endpoint', () => {
  before(() => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  const TRAVERSAL_PATHS = [
    // Classic dot-dot-slash
    { label: '../../../etc/passwd', raw: '../../../etc/passwd' },
    // URL-encoded dots
    { label: '%2E%2E/%2E%2E/etc/passwd', raw: '%2E%2E/%2E%2E/etc/passwd' },
    // URL-encoded slash
    { label: '../..%2Fetc/passwd', raw: '../..%2Fetc/passwd' },
    // Double-encoded percent
    { label: '%252E%252E%252F (double-encoded)', raw: '%252E%252E%252Fetc%252Fpasswd' },
    // Null byte
    { label: 'file.txt%00.jpg (null byte)', raw: 'file.txt%00.jpg' },
    // Backslash (Windows-style)
    { label: '..\\..\\etc\\passwd', raw: '..%5C..%5Cetc%5Cpasswd' },
    // Overlong UTF-8 sequences (browsers normalize, server should too)
    { label: '%C0%AF (overlong /)', raw: '..%C0%AFetc%C0%AFpasswd' },
    // Absolute path
    { label: '/etc/passwd (absolute)', raw: '/etc/passwd' },
    // Multiple slashes
    { label: '......////etc/passwd', raw: '......////etc/passwd' },
  ];

  for (const { label, raw } of TRAVERSAL_PATHS) {
    it(`Blocks: ${label}`, async () => {
      const { status } = await getPath(raw);
      assert.ok(
        status === 400 || status === 404,
        `Path "${label}" should return 400 or 404, got ${status}`,
      );
      // Must NOT be 200 — that would indicate file content was served
      assert.notEqual(status, 200, `Path traversal succeeded for: ${label}`);
    });
  }
});

describe('Path traversal — DELETE endpoint', () => {
  before(() => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  it('DELETE ../../../etc/passwd → 400 or 404', async () => {
    const status = await deletePath('../../../etc/passwd');
    assert.ok(status === 400 || status === 404, `Expected 400/404, got ${status}`);
  });

  it('DELETE %2E%2E%2F%2E%2E%2Fetc%2Fpasswd → 400 or 404', async () => {
    const status = await deletePath('%2E%2E%2F%2E%2E%2Fetc%2Fpasswd');
    assert.ok(status === 400 || status === 404, `Expected 400/404, got ${status}`);
  });
});

describe('Path traversal — PATCH (move) endpoint', () => {
  before(() => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  it('PATCH with traversal destination is blocked (400)', async () => {
    // First create a valid file
    await fetch(`${INSTANCES.a}/api/files/general?path=traversal-src.txt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ content: 'escape attempt', encoding: 'utf8' }),
    });
    const r = await fetch(`${INSTANCES.a}/api/files/general?path=traversal-src.txt`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ destination: '../../../tmp/escaped.txt' }),
    });
    // Must be rejected at validation (400) or source not found (404).
    // A 500 here is NOT acceptable: it would mean the server reached the
    // filesystem before validating the destination path, then crashed.
    assert.ok(
      r.status === 400 || r.status === 404,
      `Move to traversal destination should be blocked with 400/404, got ${r.status} — a 500 indicates the path sandbox is not checked before I/O`,
    );
  });
});

describe('Valid relative paths within space are allowed', () => {
  before(() => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  it('Path with subdirectory (valid) → not 400', async () => {
    // subdir/file.txt is valid — may 404 if not existing but should not be 400
    const { status } = await getPath('subdir/legit.txt');
    assert.ok(status === 404 || status === 201 || status === 200,
      `Valid subdirectory path should not return 400, got ${status}`);
  });

  it('Filename with leading slash (browser Content-Disposition) → not 400', async () => {
    // Browsers often send the original filename with a leading / in the
    // Content-Disposition header (e.g. '/Screenshot 2024-01-01.png').
    // This must NOT be treated as a path traversal attempt.
    const { status } = await getPath('%2FHearthstone%20Screenshot%2002-24-26%2023.37.34.png');
    assert.ok(
      status === 404 || status === 200 || status === 201,
      `Filename with leading slash should not return 400, got ${status}`,
    );
  });

  it('Filename with spaces (valid) → not 400', async () => {
    const { status } = await getPath('My%20Documents%2Freport%202024.txt');
    assert.ok(
      status === 404 || status === 200 || status === 201,
      `Filename with spaces should not return 400, got ${status}`,
    );
  });
});
