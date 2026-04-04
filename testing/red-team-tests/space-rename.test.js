/**
 * Red-team tests: Space rename endpoint security
 *
 * Verifies that PATCH /api/spaces/:id/rename:
 *  - Requires an admin token (standard and read-only tokens are rejected)
 *  - Requires authentication (unauthenticated requests are rejected)
 *  - Rejects newId values containing path-traversal sequences
 *  - Rejects newId values with characters outside [a-z0-9-]
 *  - Rejects newId values that exceed the 40-char maximum
 *  - Rejects renaming built-in spaces regardless of newId validity
 *
 * Run: node --test testing/red-team-tests/space-rename.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

let adminToken;
let standardToken;
let standardTokenId;
let readOnlyToken;
let readOnlyTokenId;

const SCRATCH_SPACE = 'rt-rename-scratch';

async function renameSpace(token, spaceId, newId) {
  const r = await fetch(`${INSTANCES.a}/api/spaces/${spaceId}/rename`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ newId }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function renameSpaceNoAuth(spaceId, newId) {
  const r = await fetch(`${INSTANCES.a}/api/spaces/${spaceId}/rename`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newId }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

describe('Space rename — authentication and authorisation', () => {
  before(async () => {
    adminToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

    // Standard token (no admin flag)
    const rs = await post(INSTANCES.a, adminToken, '/api/tokens', {
      name: 'rt-rename-standard-' + Date.now(),
    });
    assert.equal(rs.status, 201, `Failed to create standard token: ${JSON.stringify(rs.body)}`);
    standardToken = rs.body.plaintext;
    standardTokenId = rs.body.token?.id;

    // Read-only token
    const ro = await post(INSTANCES.a, adminToken, '/api/tokens', {
      name: 'rt-rename-readonly-' + Date.now(),
      readOnly: true,
    });
    assert.equal(ro.status, 201, `Failed to create read-only token: ${JSON.stringify(ro.body)}`);
    readOnlyToken = ro.body.plaintext;
    readOnlyTokenId = ro.body.token?.id;

    // Create a scratch space to attempt renames against
    const sp = await post(INSTANCES.a, adminToken, '/api/spaces', {
      id: SCRATCH_SPACE,
      label: 'RT Rename Scratch',
    });
    assert.ok(
      sp.status === 201 || sp.status === 409,
      `Failed to create scratch space: ${JSON.stringify(sp.body)}`,
    );
  });

  after(async () => {
    // Clean up tokens only — scratch space is cleaned up by the second describe's after()
    for (const id of [standardTokenId, readOnlyTokenId]) {
      if (id) {
        await fetch(`${INSTANCES.a}/api/tokens/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${adminToken}` },
        });
      }
    }
  });

  it('Unauthenticated request is rejected with 401', async () => {
    const r = await renameSpaceNoAuth(SCRATCH_SPACE, 'should-not-work');
    assert.equal(r.status, 401, `Expected 401, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Standard (non-admin) token is rejected with 403', async () => {
    const r = await renameSpace(standardToken, SCRATCH_SPACE, 'should-not-work');
    assert.equal(r.status, 403, `Standard token must not rename spaces, got ${r.status}`);
  });

  it('Read-only token is rejected with 403', async () => {
    const r = await renameSpace(readOnlyToken, SCRATCH_SPACE, 'should-not-work');
    assert.equal(r.status, 403, `Read-only token must not rename spaces, got ${r.status}`);
  });
});

describe('Space rename — newId input validation', () => {
  before(async () => {
    adminToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    // Re-create scratch space in case the first describe's after() ran before us
    const sp = await post(INSTANCES.a, adminToken, '/api/spaces', {
      id: SCRATCH_SPACE,
      label: 'RT Rename Scratch',
    });
    assert.ok(
      sp.status === 201 || sp.status === 409,
      `Failed to (re-)create scratch space: ${JSON.stringify(sp.body)}`,
    );
  });

  after(async () => {
    // Clean up scratch space (may have been renamed by the valid-rename test)
    for (const sid of [SCRATCH_SPACE, SCRATCH_SPACE + '-renamed']) {
      await fetch(`${INSTANCES.a}/api/spaces/${sid}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      }).catch(() => {});
    }
  });

  const INVALID_NEW_IDS = [
    // Path traversal
    { label: 'dot-dot-slash', newId: '../other-space' },
    { label: 'URL-encoded dot-dot-slash', newId: '..%2Fother-space' },
    { label: 'double dot-dot', newId: '../../etc/passwd' },
    { label: 'backslash traversal', newId: '..\\other-space' },
    // Disallowed characters (schema: /^[a-z0-9-]+$/)
    { label: 'uppercase letters', newId: 'MySpace' },
    { label: 'spaces', newId: 'my space' },
    { label: 'slash in ID', newId: 'my/space' },
    { label: 'null byte', newId: 'space\x00id' },
    { label: 'special chars', newId: 'space<script>' },
    { label: 'underscore', newId: 'my_space' },
    // Length
    { label: '41-char ID (over limit)', newId: 'a'.repeat(41) },
    { label: 'empty string', newId: '' },
  ];

  for (const { label, newId } of INVALID_NEW_IDS) {
    it(`Rejects newId: ${label} → 400`, async () => {
      const r = await renameSpace(adminToken, SCRATCH_SPACE, newId);
      assert.equal(r.status, 400,
        `newId "${newId}" (${label}) should be rejected with 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    });
  }

  it('Rejects renaming the built-in general space → 400', async () => {
    const r = await renameSpace(adminToken, 'general', 'not-general');
    assert.equal(r.status, 400, `Renaming general must be rejected: ${JSON.stringify(r.body)}`);
  });

  it('newId already taken returns 409 (not a silent overwrite)', async () => {
    // general always exists — trying to rename scratch → general must 409
    const r = await renameSpace(adminToken, SCRATCH_SPACE, 'general');
    assert.equal(r.status, 409,
      `Rename to existing ID must return 409, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Valid rename by admin succeeds and space is accessible under new ID', async () => {
    const newId = SCRATCH_SPACE + '-renamed';
    const r = await renameSpace(adminToken, SCRATCH_SPACE, newId);
    assert.equal(r.status, 200, `Valid rename must return 200: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.space?.id, newId, 'Response must contain space with new ID');

    // Old ID must be gone
    const oldGet = await fetch(`${INSTANCES.a}/api/files/${SCRATCH_SPACE}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(oldGet.status, 404, 'Old space ID must be gone after rename');

    // New ID must be accessible
    const newGet = await fetch(`${INSTANCES.a}/api/files/${newId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(newGet.status, 200, 'New space ID must be accessible after rename');
  });
});
