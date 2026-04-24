/**
 * Red-team tests: INFRA_MANAGED migration lock.
 *
 * When YTHRIL_MONGO_INFRA_MANAGED=true is set, POST /api/admin/data/migrate
 * must return 409 INFRA_MANAGED regardless of the URI or request body — even
 * though YTHRIL_DB_MIGRATION_ENABLED=true is also set on this instance.
 *
 * This models a K8s / infra-managed deployment where the MongoDB URI is
 * controlled externally (e.g. via a secret / MONGO_URI env var) and API-driven
 * migration must be blocked even for legitimate admin tokens.
 *
 * These tests run against instance D (port 3203) which has both
 * YTHRIL_DB_MIGRATION_ENABLED=true and YTHRIL_MONGO_INFRA_MANAGED=true.
 *
 * Run: node --test testing/red-team-tests/infra-managed-migration.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = INSTANCES.d;
const TOKEN_FILE_D = path.join(__dirname, '..', 'sync', 'configs', 'd', 'token.txt');

// A syntactically valid external URI — the infra-managed guard must fire before
// any URI validation or connection attempt.
const EXTERNAL_MONGO_URI = 'mongodb://8.8.8.8:27017/exfil?serverSelectionTimeoutMS=500';
// The instance's own URI — even migrating to the current URI must be blocked.
const CURRENT_MONGO_URI = 'mongodb://ythril-mongo-d:27017/?directConnection=true';

let adminToken;

describe('INFRA_MANAGED lock — POST /api/admin/data/migrate returns 409', () => {
  before(() => {
    adminToken = fs.readFileSync(TOKEN_FILE_D, 'utf8').trim();
  });

  it('returns 409 INFRA_MANAGED for a valid external URI', async () => {
    const r = await post(BASE, adminToken, '/api/admin/data/migrate', {
      uri: EXTERNAL_MONGO_URI,
    });
    assert.equal(r.status, 409,
      `Expected 409 (infra-managed) but got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'INFRA_MANAGED',
      `Expected code=INFRA_MANAGED in body: ${JSON.stringify(r.body)}`);
    assert.ok(typeof r.body.error === 'string' && r.body.error.length > 0,
      'Response must include a descriptive error message');
  });

  it('returns 409 INFRA_MANAGED even for the current instance URI', async () => {
    const r = await post(BASE, adminToken, '/api/admin/data/migrate', {
      uri: CURRENT_MONGO_URI,
    });
    assert.equal(r.status, 409,
      `Expected 409 (infra-managed) but got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'INFRA_MANAGED');
  });

  it('returns 409 INFRA_MANAGED for a missing URI (guard fires before validation)', async () => {
    const r = await post(BASE, adminToken, '/api/admin/data/migrate', {});
    assert.equal(r.status, 409,
      `Expected 409 (infra-managed) but got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'INFRA_MANAGED');
  });

  it('returns 409 INFRA_MANAGED for an invalid URI scheme (guard fires before validation)', async () => {
    const r = await post(BASE, adminToken, '/api/admin/data/migrate', {
      uri: 'http://attacker.example.com/db',
    });
    assert.equal(r.status, 409,
      `Expected 409 (infra-managed) but got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'INFRA_MANAGED');
  });

  it('returns 403 for non-admin (auth check fires before infra-managed guard)', async () => {
    // Auth check is part of requireAdminMfa middleware — must still reject non-admins
    const r = await post(BASE, 'invalid-token-xyz', '/api/admin/data/migrate', {
      uri: EXTERNAL_MONGO_URI,
    });
    assert.equal(r.status, 401,
      `Expected 401 for invalid token but got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});
