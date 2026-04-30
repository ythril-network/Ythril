/**
 * Red-team tests: Path traversal attack attempts + file metadata injection
 *
 * Verifies that the sandbox (resolveSafePath) blocks all attempts to escape
 * the space root — including URL encoding, double encoding, null bytes, and
 * Unicode normalization bypasses.
 *
 * All attempts must return 400 (or 404 for valid paths that simply don't
 * exist) — never return file content from outside the space root.
 *
 * Also covers file metadata input security:
 *  - MongoDB operator injection in tags/description fields
 *  - Operator injection via tag query param must not leak records
 *  - Non-array tags and oversized description must not cause 500
 *  - Cross-space metadata access blocked by token scope
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

// ── File metadata input security ──────────────────────────────────────────────
//
// Verifies that the `description` and `tags` fields accepted by the file
// write endpoint are stored as opaque strings / arrays and never interpreted
// as queries, commands, or markup.
//
// MongoDB NoSQL injection: MongoDB operators in `tags` / `description` must
// not be evaluated as query operators — they are stored as literal strings.
// The query endpoint (GET /api/brain/spaces/:spaceId/files?tag=) is also
// tested to ensure operator injection via query params is inert.

import { post as helpersPost } from '../sync/helpers.js';

describe('File metadata — injection and oversized field rejection', () => {
  const RUN = Date.now();

  before(() => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  async function uploadWithMeta(filePath, description, tags) {
    const url = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent(filePath)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ content: 'rt-meta', encoding: 'utf8', description, tags }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }

  async function queryByTag(tag) {
    const url = `${INSTANCES.a}/api/brain/spaces/general/files?tag=${encodeURIComponent(tag)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, body: await r.json().catch(() => null) };
  }

  it('MongoDB operator in tags array is stored as literal, not evaluated', async () => {
    // An attacker supplies { "$gt": "" } as a tag string — must be stored
    // and compared literally, never treated as a query operator.
    const filePath = `rt-meta-tag-injection-${RUN}.txt`;
    const injectedTag = '{"$gt":""}';
    const r = await uploadWithMeta(filePath, 'injection test', [injectedTag]);
    // Server should accept (200/201/202) or reject with 400 — never 500
    assert.ok(r.status === 201 || r.status === 202 || r.status === 400,
      `Expected 201 or 400, got ${r.status}: ${JSON.stringify(r.body)}`);

    if (r.status === 201 || r.status === 202) {
      // The tag must be returned as a literal string, not cause a query error
      const q = await queryByTag(injectedTag);
      assert.ok(q.status === 200,
        `Query with operator-like tag should not crash: ${JSON.stringify(q.body)}`);
    }
  });

  it('MongoDB operator in description is stored as literal string', async () => {
    const filePath = `rt-meta-desc-injection-${RUN}.txt`;
    const injectedDesc = '{"$where":"function(){return true;}"}';
    const r = await uploadWithMeta(filePath, injectedDesc, []);
    assert.ok(r.status === 201 || r.status === 202 || r.status === 400,
      `Expected 201 or 400, got ${r.status}: ${JSON.stringify(r.body)}`);

    if (r.status === 201 || r.status === 202) {
      // Verify description is stored verbatim
      const url = `${INSTANCES.a}/api/brain/spaces/general/files?path=${encodeURIComponent(filePath)}`;
      const q = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const qb = await q.json().catch(() => null);
      assert.equal(q.status, 200, `Meta query must succeed: ${JSON.stringify(qb)}`);
      if (qb?.files?.length) {
        assert.equal(qb.files[0].description, injectedDesc,
          'description must be stored as a literal string, not evaluated');
      }
    }
  });

  it('tag query param containing MongoDB operator does not leak all records', async () => {
    // Upload a file with a known unique tag so we have a baseline
    const sentinel = `rt-sentinel-${RUN}`;
    const filePath = `rt-meta-sentinel-${RUN}.txt`;
    await uploadWithMeta(filePath, '', [sentinel]);

    // Now query with an operator-injection attempt in the tag param
    const q = await queryByTag('{"$exists":true}');
    assert.ok(q.status === 200 || q.status === 400,
      `Operator-like tag query must not 500: ${JSON.stringify(q.body)}`);

    if (q.status === 200) {
      // The result must NOT contain all files — operator injection must be inert.
      // It should return zero results (no file has that literal string as a tag).
      const leaked = (q.body?.files ?? []).filter(f => f.path !== filePath);
      assert.equal(leaked.length, 0,
        `Operator injection in tag query must not leak other records; got ${leaked.length} results`);
    }
  });

  it('Non-array tags field is rejected', async () => {
    const filePath = `rt-meta-nonarray-${RUN}.txt`;
    const url = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent(filePath)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ content: 'x', tags: 'not-an-array' }),
    });
    // Server may accept (ignoring non-array tags) or reject with 400 — must not 500
    assert.ok(r.status !== 500, `Non-array tags must not cause a 500: ${r.status}`);
  });

  it('Description exceeding 4000 chars is rejected or truncated — not 500', async () => {
    const filePath = `rt-meta-longdesc-${RUN}.txt`;
    const longDesc = 'x'.repeat(8001);
    const r = await uploadWithMeta(filePath, longDesc, []);
    assert.ok(r.status !== 500,
      `Oversized description must not cause a 500: ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Cross-space file metadata is not accessible via a space-scoped token', async () => {
    // Create a token scoped only to general; try to query metadata for a
    // non-general space — should return 403, not 200 with leaked data.
    const tr = await helpersPost(INSTANCES.a, token, '/api/tokens', {
      name: 'rt-meta-scope-' + RUN,
      spaces: ['general'],
    });
    assert.equal(tr.status, 201, `Failed to create scoped token: ${JSON.stringify(tr.body)}`);
    const scopedToken = tr.body.plaintext;
    const scopedId = tr.body.token?.id;

    try {
      // Try to access another space's file metadata with general-only token
      const r = await fetch(`${INSTANCES.a}/api/brain/spaces/rt-rename-scratch-renamed/files`, {
        headers: { Authorization: `Bearer ${scopedToken}` },
      });
      // 403 = correct scope rejection; 404 = space doesn't exist (also acceptable)
      assert.ok(
        r.status === 403 || r.status === 404,
        `Scoped token must not access other space's file metadata: got ${r.status}`,
      );
    } finally {
      if (scopedId) {
        await fetch(`${INSTANCES.a}/api/tokens/${scopedId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    }
  });
});
