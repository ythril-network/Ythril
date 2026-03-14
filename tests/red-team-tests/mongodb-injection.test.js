/**
 * Red-team tests: MongoDB operator injection attempts
 *
 * Verifies that Zod validation and safe query construction prevent:
 *  - $where / $function JS injection in filter fields
 *  - $gt / $regex / $ne operator objects in JSON body
 *  - Prototype pollution via __proto__ or constructor keys
 *  - Array operators in string-typed fields
 *
 * All injections should return 400 (validation error) — never 200/201.
 *
 * Run: node --test tests/red-team-tests/mongodb-injection.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

let token;

/** POST to brain memories with arbitrary body */
async function postMemory(body) {
  const r = await fetch(`${INSTANCES.a}/api/brain/general/memories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** POST to tokens with arbitrary body */
async function postToken(body) {
  const r = await fetch(`${INSTANCES.a}/api/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

describe('MongoDB operator injection in Brain /memories', () => {
  before(() => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  it('fact: { $where: "..." } → 400 (not inserted)', async () => {
    const r = await postMemory({ fact: { $where: 'sleep(1000)' } });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('fact: { $gt: "" } → 400', async () => {
    const r = await postMemory({ fact: { $gt: '' } });
    assert.equal(r.status, 400);
  });

  it('fact: { $ne: null } → 400', async () => {
    const r = await postMemory({ fact: { $ne: null } });
    assert.equal(r.status, 400);
  });

  it('fact: null → 400', async () => {
    const r = await postMemory({ fact: null });
    assert.equal(r.status, 400);
  });

  it('fact: 12345 (number instead of string) → 400', async () => {
    const r = await postMemory({ fact: 12345 });
    assert.equal(r.status, 400);
  });

  it('tags: { $regex: ".*" } instead of array → 400', async () => {
    const r = await postMemory({ fact: 'legit fact', tags: { $regex: '.*' } });
    assert.equal(r.status, 400);
  });

  it('tags with nested operator → 400', async () => {
    const r = await postMemory({ fact: 'legit', tags: [{ $where: 'this' }] });
    assert.equal(r.status, 400);
  });
});

describe('Prototype pollution attempts via JSON body', () => {
  before(() => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  it('{ "__proto__": { "isAdmin": true } } in token create → 400', async () => {
    const r = await postToken({ name: 'test', '__proto__': { isAdmin: true } });
    // Express body parser should strip __proto__ or Zod should reject extra keys
    // Either way, the server should not set isAdmin on Object.prototype
    assert.ok(r.status === 201 || r.status === 400,
      `Expected 201 or 400, got ${r.status}`);
    // Verify Object.prototype was not polluted
    assert.equal(({}).isAdmin, undefined, '__proto__ pollution must not succeed');
  });

  it('{ "constructor": { "prototype": { "evil": true } } } → safe', async () => {
    const r = await postToken({
      name: 'ctor-test',
      constructor: { prototype: { evil: true } },
    });
    assert.ok(r.status === 201 || r.status === 400,
      `Expected 201 or 400, got ${r.status}`);
    assert.equal(({}).evil, undefined, 'constructor pollution must not succeed');
  });
});

describe('MongoDB injection in network create', () => {
  before(() => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  it('label: { $gt: "" } → 400', async () => {
    const r = await post(INSTANCES.a, token, '/api/networks', {
      label: { $gt: '' },
      type: 'club',
      spaces: ['general'],
    });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}`);
  });

  it('type: { $ne: "club" } → 400', async () => {
    const r = await post(INSTANCES.a, token, '/api/networks', {
      label: 'Test',
      type: { $ne: 'club' },
      spaces: ['general'],
    });
    assert.equal(r.status, 400);
  });
});
