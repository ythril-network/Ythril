/**
 * Red-team tests: Mass assignment & parameter pollution
 *
 * Verifies that client-supplied fields cannot override server-generated
 * identifiers (token id, hash, prefix), application flags (builtIn),
 * or schema-controlled values via HTTP parameter pollution.
 *
 * Run: node --test testing/red-team-tests/mass-assignment.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del } from '../sync/helpers.js';
import { legacyRights } from '../_shared/legacy-token-rights.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

let adminToken;

describe('Mass assignment — token creation', () => {
  before(() => {
    adminToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  it('Extra fields (id, hash, prefix) are stripped on token creation', async () => {
    const attackerId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const r = await post(INSTANCES.a, adminToken, '/api/tokens', {
      name: 'mass-assign-token-test ' + Date.now(),
      // Attacker tries to inject server-generated fields
      id: attackerId,
      hash: '$2b$12$fakehashfakehashfakehashfakehashfakehashfakehash',
      prefix: 'ythril_0',
    });
    assert.equal(r.status, 201, `Failed to create token: ${JSON.stringify(r.body)}`);

    const created = r.body.token;
    assert.notEqual(created.id, attackerId, 'Server must generate its own token ID — not use the attacker-supplied one');
    assert.ok(!created.hash, 'Hash must never be returned to the client');
    // prefix is returned as a fast-lookup index (not secret); verify the server
    // ignored the attacker-supplied value and generated its own from the plaintext
    if (created.prefix) {
      assert.notEqual(created.prefix, 'ythril_0', 'Server must not use the attacker-supplied prefix value');
    }

    // Clean up
    await fetch(`${INSTANCES.a}/api/tokens/${created.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
  });

  it('Body as JSON array instead of object returns 400', async () => {
    const r = await post(INSTANCES.a, adminToken, '/api/tokens', [
      { name: 'array-attack', expiresAt: null },
    ]);
    assert.equal(r.status, 400, `Array body should be rejected, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Missing required name field returns 400', async () => {
    const r = await post(INSTANCES.a, adminToken, '/api/tokens', {
      expiresAt: null,
    });
    assert.equal(r.status, 400, `Missing name should be rejected, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Spaces list containing empty string is rejected → 400', async () => {
    const r = await post(INSTANCES.a, adminToken, '/api/tokens', {
      name: 'empty-space-test',
      rights: legacyRights({ spaces: ['general', ''] })
    });
    assert.equal(r.status, 400, `Empty string in spaces should be rejected, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});

describe('Mass assignment — space creation', () => {
  it('builtIn flag is stripped on space creation', async () => {
    const spaceId = 'mass-assign-space-' + Date.now();
    const r = await post(INSTANCES.a, adminToken, '/api/spaces', {
      id: spaceId,
      label: 'Mass Assign Test Space',
      // Attacker tries to mark space as built-in so it cannot be deleted
      builtIn: true,
    });
    assert.equal(r.status, 201, `Space creation failed: ${JSON.stringify(r.body)}`);

    // The space must not have builtIn = true
    const space = r.body.space;
    assert.ok(!space.builtIn, `builtIn should not be injectable; got ${JSON.stringify(space)}`);

    // Must be deleteable (builtIn:true would prevent this)
    const del = await fetch(`${INSTANCES.a}/api/spaces/${spaceId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(del.status, 204, `Space should be deleteable (builtIn was not set), got ${del.status}`);
  });

  it('id with uppercase letters is rejected by slug validator → 400', async () => {
    const r = await post(INSTANCES.a, adminToken, '/api/spaces', {
      id: 'MySpace',
      label: 'Bad ID Case Test',
    });
    assert.equal(r.status, 400, `Uppercase id should fail slug regex, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Duplicate space id returns 409', async () => {
    // "general" is always present as a built-in space
    const r = await post(INSTANCES.a, adminToken, '/api/spaces', {
      id: 'general',
      label: 'Duplicate General',
    });
    assert.equal(r.status, 409, `Duplicate space id should return 409, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});

describe('Mass assignment — network creation', () => {
  it('Invalid network type is rejected → 400', async () => {
    const r = await post(INSTANCES.a, adminToken, '/api/networks', {
      label: 'bad-type-net',
      type: 'admin',   // not a valid enum value
      spaces: ['general'],
    });
    assert.equal(r.status, 400, `Invalid type should be rejected, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Network with no spaces is rejected → 400', async () => {
    const r = await post(INSTANCES.a, adminToken, '/api/networks', {
      label: 'no-spaces-net',
      type: 'closed',
      spaces: [],
    });
    assert.equal(r.status, 400, `Empty spaces array should be rejected, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Network referencing a non-existent space is rejected → 404', async () => {
    const r = await post(INSTANCES.a, adminToken, '/api/networks', {
      label: 'bad-space-net',
      type: 'closed',
      spaces: ['definitely-does-not-exist-xyz'],
    });
    // The one existence answer (Q-531): a missing space a body names answers as one a path names.
    assert.equal(r.status, 404, `Non-existent space should be rejected, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Body as JSON array instead of object returns 400', async () => {
    const r = await post(INSTANCES.a, adminToken, '/api/networks', [
      { label: 'array-attack', type: 'closed', spaces: ['general'] },
    ]);
    assert.equal(r.status, 400, `Array body should be rejected, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Preset id collision returns 409', async () => {
    // Must be a valid v4 UUID (version digit = 4, variant digit = 8-b)
    const presetId = 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5';
    // Create with preset id
    const first = await post(INSTANCES.a, adminToken, '/api/networks', {
      id: presetId,
      label: 'preset-id-net-1',
      type: 'closed',
      spaces: ['general'],
    });
    assert.equal(first.status, 201, `First creation failed: ${JSON.stringify(first.body)}`);

    // Attempt duplicate with same preset id
    const second = await post(INSTANCES.a, adminToken, '/api/networks', {
      id: presetId,
      label: 'preset-id-net-2',
      type: 'closed',
      spaces: ['general'],
    });
    assert.equal(second.status, 409, `Duplicate preset id should return 409, got ${second.status}: ${JSON.stringify(second.body)}`);

    // Clean up
    await fetch(`${INSTANCES.a}/api/networks/${presetId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
  });
});

describe('HTTP parameter pollution', () => {
  it('Duplicate JSON keys — last value wins, no explosion', async () => {
    // RFC 7159 says duplicate keys are implementation-defined; V8's JSON.parse
    // uses last-wins semantics.  The point of this test is that the server never
    // returns 500 regardless of which value wins or whether the rate limiter fires.
    const r = await fetch(`${INSTANCES.a}/api/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      // Deliberately malformed JSON with a duplicate key — last value wins in V8
      body: '{"name":"dup-key-a","name":"dup-key-b","expiresAt":null}',
    });
    // 201 = accepted (last-wins name used), 400 = Zod rejected, 429 = rate limiter
    // fired — all are correct outcomes.  500 is the only failure mode we care about.
    assert.notEqual(r.status, 500, `Duplicate JSON key must not cause a 500, got ${r.status}`);
    assert.ok(
      [201, 400, 429].includes(r.status),
      `Unexpected status ${r.status} for duplicate-key body`,
    );
    if (r.status === 201) {
      const body = await r.json().catch(() => null);
      assert.equal(body?.token?.name, 'dup-key-b', 'Last value should win for duplicate JSON keys');
      await fetch(`${INSTANCES.a}/api/tokens/${body?.token?.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
    }
  });

  it('Oversized name string (10 KB) is rejected by Zod or rate limiter → 400 or 429', async () => {
    // Both outcomes prove the server protects itself: Zod rejects the oversized
    // value (400) or the rate limiter blocks the request before Zod runs (429).
    // A 500 or 201 would be the failure mode.
    const r = await post(INSTANCES.a, adminToken, '/api/tokens', {
      name: 'x'.repeat(10_000),
      expiresAt: null,
    });
    assert.ok(
      r.status === 400 || r.status === 429,
      `Oversized name should be rejected (400) or rate-limited (429), got ${r.status}: ${JSON.stringify(r.body)}`,
    );
    assert.notEqual(r.status, 201, 'Must not create a token with an oversized name');
  });
});
