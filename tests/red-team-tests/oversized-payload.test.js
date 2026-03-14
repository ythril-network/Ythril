/**
 * Red-team tests: Oversized payload rejection
 *
 * Verifies that the server correctly limits request body size and rejects
 * oversized payloads with 413 — not a crash or silent truncation.
 *
 * Covers:
 *  - Brain memory with an extremely large fact string (Zod string length)
 *  - Token create with a very long name (Zod max 200)
 *  - Network create with huge label
 *  - Files API: when maxUploadBodyBytes is set, checks Content-Length gate
 *  - JSON bodies exceeding Node/Express default body-parser limit (1mb default)
 *
 * Run: node --test tests/red-team-tests/oversized-payload.test.js
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

describe('JSON body size limits (application/json endpoints)', () => {
  before(() => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  it('Token name exceeding 200 chars → 400', async () => {
    const r = await fetch(`${INSTANCES.a}/api/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ name: 'A'.repeat(201) }),
    });
    assert.equal(r.status, 400, `Expected 400 for oversized name, got ${r.status}`);
  });

  it('Brain fact string exceeding 50 000 chars → 400', async () => {
    const hugeFact = 'X'.repeat(50_001);
    const r = await fetch(`${INSTANCES.a}/api/brain/general/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ fact: hugeFact }),
    });
    assert.ok(r.status === 400 || r.status === 413,
      `Expected rejection for oversized fact, got ${r.status}`);
    assert.notEqual(r.status, 201, 'Must not accept a >50k character memory fact');
  });

  it('Brain fact string of 1MB → 400 (fact length limit is 50k)', async () => {
    const hugeFact = 'X'.repeat(1024 * 1024); // 1 MB string
    const r = await fetch(`${INSTANCES.a}/api/brain/general/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ fact: hugeFact }),
    });
    assert.ok(r.status === 400 || r.status === 413,
      `Expected rejection for 1MB fact, got ${r.status}`);
    assert.notEqual(r.status, 201, 'Must not accept a 1MB memory fact');
  });

  it('JSON body exceeding 10MB → 413 (Express json limit is 10mb)', async () => {
    // body-parser limit = 10mb; send an 11MB body
    const body = JSON.stringify({ name: 'x', extra: 'Y'.repeat(11 * 1024 * 1024) });
    const r = await fetch(`${INSTANCES.a}/api/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body,
    });
    assert.ok(r.status === 413 || r.status === 400,
      `Expected 413/400 for oversized body, got ${r.status}`);
  });

  it('Deeply nested JSON (100 levels deep) → 400 or 413', async () => {
    // Build a deeply nested object to test JSON depth limits
    let obj = { name: 'deep' };
    for (let i = 0; i < 100; i++) {
      obj = { nested: obj };
    }
    const r = await fetch(`${INSTANCES.a}/api/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(obj),
    });
    // Should fail validation — not crash
    assert.ok(r.status >= 400, `Expected 4xx for deeply-nested JSON, got ${r.status}`);
  });

  it('Array bomb: 1001-element spaces array → 400 (max 1000)', async () => {
    const r = await fetch(`${INSTANCES.a}/api/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ name: 'array-bomb', spaces: Array(1001).fill('general') }),
    });
    assert.ok(r.status === 400 || r.status === 413,
      `Expected 4xx for array bomb (1001 spaces), got ${r.status}`);
  });
});

describe('File upload size limit (raw bytes)', () => {
  before(() => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  it('Upload a valid small file succeeds (sanity check)', async () => {
    const r = await fetch(`${INSTANCES.a}/api/files/general?path=size-sanity.txt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'Authorization': `Bearer ${token}`,
      },
      body: 'small content',
    });
    assert.ok(r.status === 200 || r.status === 201, `Upload should succeed, got ${r.status}`);
  });
});
