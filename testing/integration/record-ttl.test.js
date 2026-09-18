/**
 * Integration tests: record TTL / auto-expiry (F10)
 *
 * Covers the black-box-observable half of F10 (the `_expireAt` stamp surfaces on read; only `embedding`
 * is stripped). The background sweep itself is not exercised here — per-record `ttlDays` is integer-days,
 * so nothing can lapse inside a test window; the sweep's pure delete iteration is covered by unit logic
 * and the shared delete-path tests. See testing/standalone/ttl-expiry.test.js for the compute rules.
 *
 *  - per-record `ttlDays` on a write stamps `_expireAt ≈ now + ttlDays` (memory + entity)
 *  - `ttlDays: 0` / omitted (no space default) → no `_expireAt`
 *  - space `recordTtlDays` auto-TTL stamps writes that omit `ttlDays`; per-record wins; `0` opts out
 *  - update: `ttlDays: 0` clears; omitted does NOT re-slide an existing expiry; `ttlDays > 0` re-sets
 *  - REST: `recordTtlDays` round-trips on the space; `0`/`null` clears it; out-of-range rejected
 *
 * Run: node --test testing/integration/record-ttl.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody, patch, readRecord } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const DAY_MS = 86_400_000;

let tokenA;
const RUN = Date.now();
const createdSpaceIds = [];

/** Assert an ISO expiry string lands within a day of now + `days` (generous: absorbs clock skew). */
function assertAboutDaysFromNow(iso, days) {
  assert.ok(iso, `expected an _expireAt, got ${iso}`);
  const t = new Date(iso).getTime();
  const expected = Date.now() + days * DAY_MS;
  assert.ok(Math.abs(t - expected) < DAY_MS, `expected ~${days}d out, got ${iso}`);
}

describe('record TTL (F10)', () => {
  before(() => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  });

  after(async () => {
    for (const id of createdSpaceIds) {
      await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
    }
  });

  // ── per-record ttlDays on create ──────────────────────────────────────────

  it('memory create with ttlDays > 0 stamps _expireAt', async () => {
    const w = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/facts', {
      fact: `ttl-mem-${RUN}`, ttlDays: 30,
    });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    assertAboutDaysFromNow(w.body._expireAt, 30);
    // surfaces on read too
    const g = await readRecord(INSTANCES.a, tokenA, 'general', 'facts', w.body._id);
    assertAboutDaysFromNow(g.body._expireAt, 30);
    await del(INSTANCES.a, tokenA, `/api/brain/spaces/general/facts/${w.body._id}`).catch(() => {});
  });

  it('entity create with ttlDays > 0 stamps _expireAt', async () => {
    const w = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/entities', {
      // `type` is required on this door too since `W-19`. It defaulted to `''`, which is what made a
      // typeless entity — one `validateEntity` can never check, because `type` selects the schema.
      name: `ttl-ent-${RUN}`, type: 'service', ttlDays: 10,
    });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    assertAboutDaysFromNow(w.body._expireAt, 10);
    await del(INSTANCES.a, tokenA, `/api/brain/spaces/general/entities/${w.body._id}`).catch(() => {});
  });

  it('memory create with ttlDays = 0 gets no _expireAt', async () => {
    const w = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/facts', {
      fact: `ttl-zero-${RUN}`, ttlDays: 0,
    });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    assert.equal(w.body._expireAt, undefined);
    await del(INSTANCES.a, tokenA, `/api/brain/spaces/general/facts/${w.body._id}`).catch(() => {});
  });

  it('memory create with no ttlDays (space has no default) gets no _expireAt', async () => {
    const w = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/facts', {
      fact: `ttl-none-${RUN}`,
    });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    assert.equal(w.body._expireAt, undefined);
    await del(INSTANCES.a, tokenA, `/api/brain/spaces/general/facts/${w.body._id}`).catch(() => {});
  });

  // ── files (F12): per-record TTL on uploads, stamped on the file-level FileMeta record ────────────
  // Upload carries ttlDays as a QUERY param (works for raw-binary bodies); _expireAt surfaces on the
  // filemeta read. The sweep's files-deleter runs the full cascade — same enforcement path as F10.

  async function uploadWithTtl(pathName, ttlDays) {
    const q = ttlDays === undefined ? '' : `&ttlDays=${ttlDays}`;
    return fetch(`${INSTANCES.a}/api/files/general?path=${encodeURIComponent(pathName)}${q}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/octet-stream' },
      body: `ttl file body ${RUN}`,
    });
  }
  async function fileMeta(pathName) {
    return get(INSTANCES.a, tokenA, `/api/brain/spaces/general/files?path=${encodeURIComponent(pathName)}`);
  }

  it('file upload with ttlDays > 0 stamps _expireAt on the file record', async () => {
    const p = `ttl-file-${RUN}.txt`;
    const up = await uploadWithTtl(p, 10);
    assert.ok([200, 201, 202].includes(up.status), `upload status ${up.status}`);
    const g = await fileMeta(p);
    assertAboutDaysFromNow(g.body.files?.[0]?._expireAt, 10);
    await del(INSTANCES.a, tokenA, `/api/files/general?path=${encodeURIComponent(p)}`).catch(() => {});
  });

  it('file upload with ttlDays = 0 gets no _expireAt', async () => {
    const p = `ttl-file-zero-${RUN}.txt`;
    const up = await uploadWithTtl(p, 0);
    assert.ok([200, 201, 202].includes(up.status), `upload status ${up.status}`);
    const g = await fileMeta(p);
    assert.equal(g.body.files?.[0]?._expireAt, undefined);
    await del(INSTANCES.a, tokenA, `/api/files/general?path=${encodeURIComponent(p)}`).catch(() => {});
  });

  // ── space-wide recordTtlDays auto-TTL ─────────────────────────────────────

  it('space recordTtlDays applies to writes that omit ttlDays; per-record overrides; 0 opts out', async () => {
    const spaceId = `ttl-space-${RUN}`;
    const c = await post(INSTANCES.a, tokenA, '/api/spaces', { id: spaceId, label: 'TTL Space' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    createdSpaceIds.push(spaceId);

    const p = await patch(INSTANCES.a, tokenA, `/api/spaces/${spaceId}`, { recordTtlDays: 15 });
    assert.equal(p.status, 200, JSON.stringify(p.body));

    // omitted ttlDays → space default 15d
    const dflt = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${spaceId}/facts`, { fact: `dflt-${RUN}` });
    assert.equal(dflt.status, 201, JSON.stringify(dflt.body));
    assertAboutDaysFromNow(dflt.body._expireAt, 15);

    // per-record ttlDays wins over the space default
    const over = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${spaceId}/facts`, { fact: `over-${RUN}`, ttlDays: 3 });
    assert.equal(over.status, 201, JSON.stringify(over.body));
    assertAboutDaysFromNow(over.body._expireAt, 3);

    // ttlDays: 0 opts a single record out of the space default
    const opt = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${spaceId}/facts`, { fact: `opt-${RUN}`, ttlDays: 0 });
    assert.equal(opt.status, 201, JSON.stringify(opt.body));
    assert.equal(opt.body._expireAt, undefined);
  });

  // ── update precedence ─────────────────────────────────────────────────────

  it('update: ttlDays 0 clears, omitted does not re-slide, ttlDays > 0 re-sets', async () => {
    const w = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/facts', {
      fact: `ttl-upd-${RUN}`, ttlDays: 20,
    });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    const id = w.body._id;
    const firstExpiry = w.body._expireAt;
    assertAboutDaysFromNow(firstExpiry, 20);

    // omitted ttlDays on update must NOT re-slide the existing expiry
    const u1 = await patch(INSTANCES.a, tokenA, `/api/brain/spaces/general/facts/${id}`, { fact: `ttl-upd-${RUN}-edited` });
    assert.equal(u1.status, 200, JSON.stringify(u1.body));
    const g1 = await readRecord(INSTANCES.a, tokenA, 'general', 'facts', id);
    assert.equal(new Date(g1.body._expireAt).getTime(), new Date(firstExpiry).getTime(), 'expiry must be unchanged');

    // ttlDays: 0 clears
    const u2 = await patch(INSTANCES.a, tokenA, `/api/brain/spaces/general/facts/${id}`, { ttlDays: 0 });
    assert.equal(u2.status, 200, JSON.stringify(u2.body));
    const g2 = await readRecord(INSTANCES.a, tokenA, 'general', 'facts', id);
    assert.equal(g2.body._expireAt, undefined);

    // ttlDays > 0 re-sets
    const u3 = await patch(INSTANCES.a, tokenA, `/api/brain/spaces/general/facts/${id}`, { ttlDays: 5 });
    assert.equal(u3.status, 200, JSON.stringify(u3.body));
    const g3 = await readRecord(INSTANCES.a, tokenA, 'general', 'facts', id);
    assertAboutDaysFromNow(g3.body._expireAt, 5);

    await del(INSTANCES.a, tokenA, `/api/brain/spaces/general/facts/${id}`).catch(() => {});
  });

  // ── REST contract on the space setting ────────────────────────────────────

  it('recordTtlDays round-trips on the space and clears with 0', async () => {
    const spaceId = `ttl-rt-${RUN}`;
    const c = await post(INSTANCES.a, tokenA, '/api/spaces', { id: spaceId, label: 'TTL RT' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    createdSpaceIds.push(spaceId);

    await patch(INSTANCES.a, tokenA, `/api/spaces/${spaceId}`, { recordTtlDays: 42 });
    let list = await get(INSTANCES.a, tokenA, '/api/spaces');
    let s = list.body.spaces.find(x => x.id === spaceId);
    assert.equal(s.recordTtlDays, 42);

    // 0 clears (serialised away entirely)
    await patch(INSTANCES.a, tokenA, `/api/spaces/${spaceId}`, { recordTtlDays: 0 });
    list = await get(INSTANCES.a, tokenA, '/api/spaces');
    s = list.body.spaces.find(x => x.id === spaceId);
    assert.equal(s.recordTtlDays, undefined);
  });

  it('rejects out-of-range recordTtlDays', async () => {
    const spaceId = `ttl-space-${RUN}`; // reuse the space created above
    const neg = await patch(INSTANCES.a, tokenA, `/api/spaces/${spaceId}`, { recordTtlDays: -1 });
    assert.equal(neg.status, 400, JSON.stringify(neg.body));
    const huge = await patch(INSTANCES.a, tokenA, `/api/spaces/${spaceId}`, { recordTtlDays: 40000 });
    assert.equal(huge.status, 400, JSON.stringify(huge.body));
  });

  it('rejects out-of-range per-record ttlDays on a write', async () => {
    const neg = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/facts', { fact: `bad-${RUN}`, ttlDays: -5 });
    assert.equal(neg.status, 400, JSON.stringify(neg.body));
  });
});
