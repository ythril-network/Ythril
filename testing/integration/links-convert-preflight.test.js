/**
 * The conversion pre-flight reports a writer that actually wrote — against a real Mongo.
 *
 * ## Why this test exists, and why it is an integration test and not a unit one
 *
 * `F-25` shipped with the recorder writing `tokenLabel` in BOTH `$setOnInsert` and `$set`. Mongo refuses
 * that outright — *"Updating the path 'tokenLabel' would create a conflict at 'tokenLabel'"* — so every note
 * failed, the failure was swallowed by design (an advisory observation must never fail the write it
 * observes), and the pre-flight answered `writers: []` for a space being written to.
 *
 * **That answer is indistinguishable from a healthy one.** "Nobody has written an array here" is exactly what
 * an operator hopes to see before converting, so a totally broken recorder reads as good news — and the
 * operator then converts and breaks the writers it failed to name.
 *
 * Nothing else could catch it. It type-checks. The source gate asserts every door passes an actor and that
 * the recorder swallows its own failure, and both were true. Only a real write against a real Mongo, read
 * back through the real endpoint, says whether anything was recorded.
 *
 * ## What it drives, deliberately end to end
 *
 * A memory CREATE carrying `entityIds` — the case the audit log cannot see at all, which is half the reason
 * this feature is not built on the audit log — then the endpoint, then a second write to prove a repeat is
 * COUNTED rather than duplicated, then the window bounds.
 *
 * The MCP twin is not driven here; it shares `legacyArrayWriters` with the route, and its schema agreeing
 * with the route's bounds is asserted in `a-door-that-refuses-arrays-also-records-them.test.js`.
 *
 * Run: node --test testing/integration/links-convert-preflight.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, delWithBody } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

const RUN = Date.now();
const SPACE = `preflight-${RUN}`;

let token;
let entityId;

describe('the links conversion pre-flight names a writer that actually wrote', () => {
  before(async () => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    const created = await post(INSTANCES.a, token, '/api/spaces', { id: SPACE, label: 'Preflight' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    // `concept` rather than an invented type: a new space defaults to strict validation, and the
    // neighbouring `entity-refs.test.js` proves this one is accepted on a fresh space. A `before` hook that
    // fails on a schema refusal reports as "the pre-flight is broken", which it would not be.
    const ent = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/entities`, {
      name: `Acme-${RUN}`, type: 'concept',
    });
    assert.equal(ent.status, 201, JSON.stringify(ent.body));
    entityId = ent.body._id;
    assert.match(entityId, /^[0-9a-f-]{36}$/i, 'entity ids are UUIDs');
  });

  after(async () => {
    /*
     * `delWithBody` with `confirm`, and it is not optional: a space in no network answers
     * `400 {"error":"This space is not in any network. Send { \"confirm\": true } to delete it permanently."}`
     * to a bare DELETE. A bodyless call here would fail on every run and leak the fixture — and these suites
     * share one instance pair, so a leaked space fails somebody else's test, not this one.
     *
     * Reported rather than swallowed. A cleanup failure must not fail the suite (it would mask the real
     * result) but it must be VISIBLE, which is the same lesson the recorder this file tests had to learn.
     */
    const r = await delWithBody(INSTANCES.a, token, `/api/spaces/${SPACE}`, { confirm: true })
      .catch(err => ({ status: 0, body: String(err) }));
    if (r.status !== 204 && r.status !== 200) {
      console.error(`cleanup: space '${SPACE}' was not deleted (${r.status}) — it will leak into other suites`,
        JSON.stringify(r.body));
    }
  });

  it('starts by reporting nobody, and says over what window', async () => {
    const r = await get(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/links/convert-preflight`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.writers, []);
    assert.equal(r.body.converted, false);
    // The window is the half an operator must read before the count, so it is asserted rather than assumed.
    assert.ok(Date.parse(r.body.since) > 0, `since is not an instant: ${r.body.since}`);
    assert.ok(r.body.retentionDays > 0);
  });

  it('records a CREATE carrying entityIds — the case the audit log never sees', async () => {
    const m = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/facts`, {
      fact: 'Acme signed in March', entityIds: [entityId],
    });
    assert.equal(m.status, 201, JSON.stringify(m.body));

    // The note is fired and not awaited, so the write can return before it lands. Poll rather than sleep a
    // fixed interval: a fixed wait is either flaky or slow, and this one has a definite end.
    let body;
    for (let i = 0; i < 40; i++) {
      const r = await get(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/links/convert-preflight`);
      body = r.body;
      if (body.writers.length > 0) break;
      await new Promise(res => setTimeout(res, 250));
    }
    assert.equal(body.writers.length, 1,
      `no writer recorded for a create carrying entityIds — the recorder is inert: ${JSON.stringify(body)}`);
    const [w] = body.writers;
    assert.deepEqual(w.fields, ['entityIds']);
    assert.ok(w.count >= 1);
    assert.ok(Date.parse(w.lastAt) > 0, `lastAt is not an instant: ${w.lastAt}`);
    // The identity an operator can act on. A token that wrote must be named, not counted anonymously.
    assert.ok(w.tokenId || w.tokenLabel, `the writer has no identity at all: ${JSON.stringify(w)}`);
  });

  it('counts a second write from the same token rather than adding a second writer', async () => {
    const m = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/facts`, {
      fact: 'Acme renewed in April', entityIds: [entityId],
    });
    assert.equal(m.status, 201, JSON.stringify(m.body));

    let body;
    for (let i = 0; i < 40; i++) {
      const r = await get(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/links/convert-preflight`);
      body = r.body;
      if (body.writers[0]?.count >= 2) break;
      await new Promise(res => setTimeout(res, 250));
    }
    assert.equal(body.writers.length, 1, `one token became ${body.writers.length} writers`);
    assert.ok(body.writers[0].count >= 2,
      `the second write was not counted: ${JSON.stringify(body.writers[0])}`);
  });

  it('refuses a window that cannot be served, and CAPS one that is merely too large', async () => {
    // The parity rule: both doors cap rather than refuse, so an operator asking for a year is served the
    // retention window and told so by `since`, instead of guessing the bound.
    const big = await get(INSTANCES.a, token,
      `/api/brain/spaces/${SPACE}/links/convert-preflight?windowDays=3650`);
    assert.equal(big.status, 200, JSON.stringify(big.body));
    const earliest = Date.now() - (big.body.retentionDays + 1) * 86_400_000;
    assert.ok(Date.parse(big.body.since) > earliest,
      `a 3650-day window was not capped to retention: ${big.body.since}`);

    const zero = await get(INSTANCES.a, token,
      `/api/brain/spaces/${SPACE}/links/convert-preflight?windowDays=0`);
    assert.equal(zero.status, 400, JSON.stringify(zero.body));
  });

  it('404s for a space that does not exist, rather than answering about nothing', async () => {
    const r = await get(INSTANCES.a, token, `/api/brain/spaces/no-such-space-${RUN}/links/convert-preflight`);
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });
});
