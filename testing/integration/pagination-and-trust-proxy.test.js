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
import { INSTANCES, post, get, readCollection } from '../sync/helpers.js';

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

describe('Paging refuses what it cannot use (S4)', () => {
  /*
   * THIS BLOCK CHANGED ITS CLAIM, and the change is the finding rather than the fix.
   *
   * It used to assert COERCION: `?limit=abc` became the default, `?limit=-5` was clamped to 1, `?skip=abc`
   * was read as 0. That was right for a query string, which has no types — `abc` is indistinguishable from
   * a caller who meant something, so guessing is all there is.
   *
   * `B-9` step 3b moved these reads onto a JSON BODY, which does have types. And moving them showed that
   * the two paging values had drifted apart on the same endpoint: `skip` refused a bad value with a 400
   * and `limit` accepted one and quietly answered with the default. One question, two answers, and the
   * silent half is the one that returns a page nobody asked for with a 200 on it.
   *
   * Both refuse now, through one parser.
   */
  for (const [label, body] of [
    ['a non-numeric limit', { limit: 'abc' }],
    ['a negative limit', { limit: -5 }],
    ['a zero limit — a page of no rows reads exactly like an empty collection', { limit: 0 }],
    ['a fractional limit', { limit: 1.5 }],
    ['a non-numeric skip', { skip: 'abc' }],
    ['a negative skip', { skip: -1 }],
  ]) {
    it(`refuses ${label}`, async () => {
      const r = await readCollection(INSTANCES.a, token(), SPACE, 'facts', body);
      assert.equal(r.status, 400, `accepted it instead: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /limit|skip/, 'the refusal must name the parameter it is about');
    });
  }

  it('and the values it CAN use still work, so the refusals are not a blanket', async () => {
    // The floor. Six refusals prove nothing if the endpoint refuses everything.
    const one = await readCollection(INSTANCES.a, token(), SPACE, 'facts', { limit: 1 });
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(one.results.length, 1);

    const skipped = await readCollection(INSTANCES.a, token(), SPACE, 'facts', { skip: 2, limit: 100 });
    assert.equal(skipped.status, 200, JSON.stringify(skipped.body));
    assert.equal(skipped.results.length, 1, 'three seeded, two skipped');

    // `skip: 0` is the FIRST PAGE and must stay valid — a caller looping on `nextSkip` starts there.
    const first = await readCollection(INSTANCES.a, token(), SPACE, 'facts', { skip: 0, limit: 100 });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.results.length, 3);
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
