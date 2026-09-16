/**
 * Integration tests: pagination clamp (S4) + trust-proxy default (S1)
 *
 * S4 — a garbage/out-of-range ?limit=/?skip= must be coerced to a safe bounded
 *      value, never NaN/unbounded.
 * S1 — with trustProxy default (false, as the test stack runs it), a client
 *      X-Forwarded-For must NOT influence req.ip — verified via the audit log,
 *      which records the client IP on every write.
 *
 * Run: node --test testing/integration/pagination-and-trust-proxy.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `pgtrust-${RUN}`;
const SPOOFED_IP = '203.0.113.99';

let tokenA;
function token() { return tokenA; }

async function raw(method, urlPath, { body, headers } = {}) {
  const r = await fetch(`${INSTANCES.a}${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...(headers ?? {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* no body */ }
  return { status: r.status, body: parsed };
}

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const r = await post(INSTANCES.a, token(), '/api/spaces', { id: SPACE, label: `PgTrust ${RUN}` });
  assert.equal(r.status, 201, `create space: ${JSON.stringify(r.body)}`);
  for (let i = 0; i < 3; i++) {
    await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/facts`, { fact: `pagination memory ${i} ${RUN}` });
  }
});

after(async () => {
  await fetch(`${INSTANCES.a}/api/spaces/${SPACE}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) }).catch(() => {});
});

describe('Pagination clamp (S4)', () => {
  it('non-numeric ?limit=abc is coerced to the default, not NaN/unbounded', async () => {
    const r = await get(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/facts?limit=abc`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.facts));
    assert.equal(r.body.facts.length, 3, 'returns all 3 (default applied)');
  });

  it('?limit=1 returns exactly one', async () => {
    const r = await get(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/facts?limit=1`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.facts.length, 1);
  });

  it('negative ?limit=-5 is clamped to >= 1', async () => {
    const r = await get(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/facts?limit=-5`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.facts.length, 1, 'clamped to minimum 1');
  });

  it('huge ?limit=1e9 does not error and stays bounded', async () => {
    const r = await get(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/facts?limit=1e9`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.facts.length, 3);
  });

  it('non-numeric ?skip=abc is treated as 0', async () => {
    const r = await get(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/facts?skip=abc&limit=100`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.facts.length, 3, 'skip=abc → 0, all returned');
  });

  it('?skip=2 skips two', async () => {
    const r = await get(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/facts?skip=2&limit=100`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.facts.length, 1);
  });
});

describe('Trust proxy default (S1)', () => {
  it('a spoofed X-Forwarded-For does not become the audited client IP', async () => {
    // An audited write carrying a spoofed forwarded-for header.
    const w = await raw('POST', `/api/brain/spaces/${SPACE}/facts`, {
      body: { fact: `trust-proxy probe ${RUN}` },
      headers: { 'X-Forwarded-For': SPOOFED_IP },
    });
    assert.equal(w.status, 201, JSON.stringify(w.body));

    // Audit writes are fire-and-forget — poll until entries for this space appear.
    let entries = [];
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const a = await get(INSTANCES.a, token(), `/api/admin/audit-log?spaceId=${SPACE}&limit=100`);
      entries = a.body?.entries ?? a.body?.logs ?? [];
      if (entries.length > 0) break;
      await new Promise(r => setTimeout(r, 500));
    }
    assert.ok(entries.length > 0, 'audit entries recorded for the test space');
    // With trustProxy=false, req.ip is the socket address — never the spoofed header.
    const spoofed = entries.filter(e => e.ip === SPOOFED_IP);
    assert.equal(spoofed.length, 0, `no audit entry should carry the spoofed X-Forwarded-For IP (found ${spoofed.length})`);
  });
});
