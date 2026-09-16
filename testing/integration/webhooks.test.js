/**
 * Integration tests: Webhook subscription API + real dispatch path (S8.4)
 *
 * The former standalone `webhooks.test.js` re-implemented the dispatcher's URL
 * validation, HMAC, and subscription-matching logic and asserted against those
 * copies — so it would pass even if the real code broke. These tests drive the
 * REAL compiled path through the admin API:
 *   - URL validation (https-only, SSRF-safe) and secret/event validation live
 *     in the CreateBody schema (server/src/api/webhooks.ts).
 *   - Subscription matching (space + event filters) lives in the store's
 *     getMatchingWebhooks, exercised by a real brain mutation that fires
 *     emitWebhookEvent.
 *   - Delivery + HMAC signing + delivery-logging run in the dispatcher; we
 *     observe the recorded delivery via GET /:id/deliveries.
 *
 * True HTTP receipt is NOT assertable in the test stack: webhook delivery uses
 * ssrfSafeFetch, which refuses private/loopback targets, so a host/container
 * listener can never be reached. The webhooks therefore point at an
 * unresolvable public-form host (`*.invalid`) — creation passes the SSRF shape
 * check, and delivery fails fast at DNS, leaving a RECORDED delivery that
 * proves the emit→match→sign→deliver→log path ran.
 *
 * MFA note: requireAdminMfa only enforces a TOTP code when MFA is enabled on
 * the instance; the test stack has none, so the admin token passes through.
 *
 * Run: node --test testing/integration/webhooks.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody, waitFor } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

let token;
const RUN = Date.now();
const SINK = `https://sink-${RUN}.ythril-test.invalid/hook`; // public-form, never resolves

describe('Webhook admin API — validation', () => {
  before(() => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  it('rejects a non-HTTPS URL (400)', async () => {
    const r = await post(INSTANCES.a, token, '/api/admin/webhooks', {
      url: 'http://example.com/hook', secret: 'whsec_12345678',
    });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error ?? '', /HTTPS/i, `Error should mention HTTPS: ${r.body.error}`);
  });

  it('rejects a private / SSRF-unsafe URL (400)', async () => {
    const r = await post(INSTANCES.a, token, '/api/admin/webhooks', {
      url: 'https://127.0.0.1/hook', secret: 'whsec_12345678',
    });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('rejects a secret shorter than 8 chars (400)', async () => {
    const r = await post(INSTANCES.a, token, '/api/admin/webhooks', {
      url: SINK, secret: 'short',
    });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('rejects an unknown event type (400)', async () => {
    const r = await post(INSTANCES.a, token, '/api/admin/webhooks', {
      url: SINK, secret: 'whsec_12345678', events: ['fact.upserted'],
    });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('accepts a valid https public-form URL (201) and never leaks the secret', async () => {
    const r = await post(INSTANCES.a, token, '/api/admin/webhooks', {
      url: SINK, secret: 'whsec_valid_1234', events: ['fact.created'],
    });
    assert.equal(r.status, 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.id, 'created webhook must return an id');
    // The store strips the secret from responses (stripSecret) — the plaintext
    // must never round-trip back to the client.
    assert.ok(!r.body.secret || !String(r.body.secret).includes('whsec_valid'),
      `plaintext secret must not be returned: ${JSON.stringify(r.body.secret)}`);
    await del(INSTANCES.a, token, `/api/admin/webhooks/${r.body.id}`).catch(() => {});
  });
});

describe('Webhook dispatch — real match + sign + deliver + log', () => {
  let spaceX, spaceY;
  let hookMatch;   // subscribed to spaceX / fact.created
  let hookOther;   // subscribed to spaceX / entity.created (must NOT get fact.created)

  before(async () => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    spaceX = `wh-x-${RUN}`;
    spaceY = `wh-y-${RUN}`;
    for (const s of [spaceX, spaceY]) {
      const c = await post(INSTANCES.a, token, '/api/spaces', { id: s, label: `Webhook ${s}` });
      assert.equal(c.status, 201, `create space ${s}: ${JSON.stringify(c.body)}`);
    }

    const m = await post(INSTANCES.a, token, '/api/admin/webhooks', {
      url: `${SINK}?w=match`, secret: 'whsec_match_1234',
      spaces: [spaceX], events: ['fact.created'],
    });
    assert.equal(m.status, 201, `create match hook: ${JSON.stringify(m.body)}`);
    hookMatch = m.body.id;

    const o = await post(INSTANCES.a, token, '/api/admin/webhooks', {
      url: `${SINK}?w=other`, secret: 'whsec_other_1234',
      spaces: [spaceX], events: ['entity.created'],
    });
    assert.equal(o.status, 201, `create other hook: ${JSON.stringify(o.body)}`);
    hookOther = o.body.id;
  });

  after(async () => {
    for (const id of [hookMatch, hookOther]) {
      if (id) await del(INSTANCES.a, token, `/api/admin/webhooks/${id}`).catch(() => {});
    }
    for (const s of [spaceX, spaceY]) {
      await delWithBody(INSTANCES.a, token, `/api/spaces/${s}`, { confirm: true }).catch(() => {});
    }
  });

  it('a matching fact.created fires a real delivery that is recorded', async () => {
    const created = await post(INSTANCES.a, token, `/api/brain/spaces/${spaceX}/facts`, {
      fact: `webhook-match-${RUN}`, tags: ['wh'],
    });
    assert.equal(created.status, 201, `create fact: ${JSON.stringify(created.body)}`);

    // The dispatcher matched, signed, attempted delivery (DNS-fails on .invalid),
    // and recorded the attempt. Poll the delivery log for the fact.created row.
    let delivery;
    await waitFor(async () => {
      const r = await get(INSTANCES.a, token, `/api/admin/webhooks/${hookMatch}/deliveries`);
      delivery = r.body.deliveries?.find(d => d.event === 'fact.created');
      return Boolean(delivery);
    }, 20_000, 500, 'no fact.created delivery was recorded — emit/match/dispatch path did not run');

    assert.equal(delivery.webhookId, hookMatch, 'delivery is attributed to the matching webhook');
    assert.equal(delivery.spaceId, spaceX, 'delivery records the originating space');
    // Delivery to an unresolvable host must fail — proving a real network
    // attempt occurred (not a fabricated log row).
    assert.equal(delivery.success, false, 'delivery to *.invalid must fail');
    assert.ok(delivery.error, 'a failed delivery must record an error');
  });

  it('event-filter mismatch means NO fact.created delivery on the other hook', async () => {
    // hookOther is subscribed to entity.created only; the fact.created above
    // (same space) must not have matched it. getMatchingWebhooks is the real
    // filter under test.
    const r = await get(INSTANCES.a, token, `/api/admin/webhooks/${hookOther}/deliveries`);
    assert.equal(r.status, 200);
    const leaked = (r.body.deliveries ?? []).find(d => d.event === 'fact.created');
    assert.ok(!leaked, 'a webhook filtered to entity.created must not receive fact.created');
  });

  it('a REST entity create fires entity.created via the centralized upsertEntity emit', async () => {
    // hookOther is subscribed to entity.created in spaceX. Creating an entity must deliver —
    // proving emission now lives in the shared upsertEntity function (not the route).
    const created = await post(INSTANCES.a, token, `/api/brain/spaces/${spaceX}/entities`, {
      name: `wh-ent-${RUN}`, type: 'concept',
    });
    assert.equal(created.status, 201, `create entity: ${JSON.stringify(created.body)}`);

    let delivery;
    await waitFor(async () => {
      const r = await get(INSTANCES.a, token, `/api/admin/webhooks/${hookOther}/deliveries`);
      delivery = r.body.deliveries?.find(d => d.event === 'entity.created');
      return Boolean(delivery);
    }, 20_000, 500, 'no entity.created delivery — centralized upsertEntity emission did not run');
    assert.equal(delivery.spaceId, spaceX, 'entity.created delivery records the originating space');
  });

  it('the test-delivery endpoint records a test.ping attempt', async () => {
    const t = await post(INSTANCES.a, token, `/api/admin/webhooks/${hookMatch}/test`, {});
    assert.equal(t.status, 200, `test endpoint: ${JSON.stringify(t.body)}`);

    await waitFor(async () => {
      const r = await get(INSTANCES.a, token, `/api/admin/webhooks/${hookMatch}/deliveries`);
      return (r.body.deliveries ?? []).some(d => d.event === 'test.ping');
    }, 20_000, 500, 'the test endpoint never produced a test.ping delivery record');
  });

  it('a space-filter mismatch does not deliver (a fact in an unsubscribed space)', async () => {
    const created = await post(INSTANCES.a, token, `/api/brain/spaces/${spaceY}/facts`, {
      fact: `webhook-nomatch-${RUN}`, tags: ['wh'],
    });
    assert.equal(created.status, 201);

    // Give the dispatcher a moment, then assert no spaceY delivery landed on the
    // spaceX-scoped webhook.
    await new Promise(res => setTimeout(res, 3000));
    const r = await get(INSTANCES.a, token, `/api/admin/webhooks/${hookMatch}/deliveries`);
    const leaked = (r.body.deliveries ?? []).find(d => d.spaceId === spaceY);
    assert.ok(!leaked, 'a webhook scoped to spaceX must not receive spaceY events');
  });
});
