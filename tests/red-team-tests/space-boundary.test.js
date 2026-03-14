/**
 * Red-team tests: Cross-space data access (space boundary enforcement)
 *
 * A token that is scoped to space X must not be able to read or write
 * data in space Y.
 *
 * Run: node --test tests/red-team-tests/space-boundary.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

let tokenA;           // full-access token
let generalOnlyToken; // scoped to "general" only
let generalOnlyId;

describe('Space-scoped token enforcement', () => {
  before(async () => {
    tokenA = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

    // Create a token scoped only to the "general" space
    const r = await post(INSTANCES.a, tokenA, '/api/tokens', {
      name: 'space-boundary-test ' + Date.now(),
      spaces: ['general'],
    });
    assert.equal(r.status, 201, `Failed to create scoped token: ${JSON.stringify(r.body)}`);
    generalOnlyToken = r.body.plaintext;
    generalOnlyId = r.body.token?.id;
  });

  after(async () => {
    // Clean up scoped token
    if (generalOnlyId) {
      await fetch(`${INSTANCES.a}/api/tokens/${generalOnlyId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${tokenA}` },
      });
    }
  });

  it('Scoped token can access its own space (general) files', async () => {
    const r = await fetch(`${INSTANCES.a}/api/files/general`, {
      headers: { 'Authorization': `Bearer ${generalOnlyToken}` },
    });
    assert.equal(r.status, 200, 'Token scoped to "general" should read general files');
  });

  it('Scoped token can write to its space (general)', async () => {
    const r = await fetch(`${INSTANCES.a}/api/files/general?path=space-boundary-test.txt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${generalOnlyToken}` },
      body: JSON.stringify({ content: 'in-scope write', encoding: 'utf8' }),
    });
    assert.equal(r.status, 201, 'Token should write to its allowed space');
  });

  // Spaces in Ythril — at minimum "general" is always present.
  // "private" might or might not exist in test config; test if a token
  // scoped to "general" is blocked from a different space slug.
  it('Scoped token cannot access brain in a different space', async () => {
    // Attempt to access /api/brain/private or /api/brain/nonexistent-space
    // Both should return 401 (not authorized for that space) or 404 (space missing)
    const r = await fetch(`${INSTANCES.a}/api/brain/private/memories`, {
      headers: { 'Authorization': `Bearer ${generalOnlyToken}` },
    });
    // 401 = no/invalid token, 403 = valid token but out-of-scope, 404 = space doesn't exist
    assert.ok(r.status === 401 || r.status === 403 || r.status === 404,
      `Expected 401/403/404 for out-of-scope space, got ${r.status}`);
    assert.notEqual(r.status, 200, 'Should NOT have access to private space');
  });

  it('Scoped token cannot upload to a different space via files API', async () => {
    const r = await fetch(`${INSTANCES.a}/api/files/private?path=escape.txt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${generalOnlyToken}` },
      body: JSON.stringify({ content: 'escape', encoding: 'utf8' }),
    });
    // 401 = no/invalid token, 403 = valid token but out-of-scope, 404 = space doesn't exist
    assert.ok(r.status === 401 || r.status === 403 || r.status === 404,
      `Expected 401/403/404 for out-of-scope space write, got ${r.status}`);
    assert.notEqual(r.status, 201, 'Should NOT write to out-of-scope space');
  });
});

describe('Full-access token can access all spaces', () => {
  before(() => {
    tokenA = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  it('Full-access token reads general space', async () => {
    const r = await fetch(`${INSTANCES.a}/api/files/general`, {
      headers: { 'Authorization': `Bearer ${tokenA}` },
    });
    assert.equal(r.status, 200);
  });

  it('Full-access token reaches /api/spaces listing', async () => {
    const r = await get(INSTANCES.a, tokenA, '/api/spaces');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body?.spaces), 'Should return spaces array');
  });
});
