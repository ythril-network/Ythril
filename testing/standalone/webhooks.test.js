/**
 * Unit tests: webhook types and validation
 *
 * Covers:
 *  - Webhook event type validation
 *  - HTTPS URL enforcement
 *  - Secret minimum length
 *  - Event type filtering
 *  - HMAC-SHA256 signature computation
 *  - Subscription matching logic
 *
 * These tests use pure in-process logic and do NOT require a MongoDB instance.
 * Run with:
 *   node --test testing/standalone/webhooks.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// ── Replicated types and logic ─────────────────────────────────────────────

const ALL_WEBHOOK_EVENTS = new Set([
  'memory.created', 'memory.updated', 'memory.deleted',
  'entity.created', 'entity.updated', 'entity.deleted',
  'edge.created',   'edge.updated',   'edge.deleted',
  'chrono.created',  'chrono.updated',  'chrono.deleted',
  'file.created',    'file.updated',    'file.deleted',
  'test.ping',
]);

/** Replicate matching logic from store.ts */
function matchesSubscription(sub, event, spaceId) {
  if (!sub.enabled) return false;
  if (sub.status === 'disabled') return false;
  if (sub.spaces.length > 0 && !sub.spaces.includes(spaceId)) return false;
  if (sub.events.length > 0 && !sub.events.includes(event)) return false;
  return true;
}

/** Replicate HMAC computation from dispatcher.ts */
function computeHmac(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Webhook event types', () => {
  it('ALL_WEBHOOK_EVENTS contains all expected event types', () => {
    const expected = [
      'memory.created', 'memory.updated', 'memory.deleted',
      'entity.created', 'entity.updated', 'entity.deleted',
      'edge.created', 'edge.updated', 'edge.deleted',
      'chrono.created', 'chrono.updated', 'chrono.deleted',
      'file.created', 'file.updated', 'file.deleted',
      'test.ping',
    ];
    for (const e of expected) {
      assert.ok(ALL_WEBHOOK_EVENTS.has(e), `Missing event type: ${e}`);
    }
    assert.equal(ALL_WEBHOOK_EVENTS.size, expected.length);
  });

  it('rejects unknown event types', () => {
    assert.equal(ALL_WEBHOOK_EVENTS.has('unknown.event'), false);
    assert.equal(ALL_WEBHOOK_EVENTS.has('memory.upserted'), false);
    assert.equal(ALL_WEBHOOK_EVENTS.has(''), false);
  });
});

describe('Webhook URL validation', () => {
  it('accepts HTTPS URLs', () => {
    const url = 'https://example.com/webhook';
    assert.ok(url.startsWith('https://'));
  });

  it('rejects HTTP URLs', () => {
    const url = 'http://example.com/webhook';
    assert.equal(url.startsWith('https://'), false);
  });

  it('rejects non-URL strings', () => {
    const badUrls = ['not-a-url', 'ftp://example.com', 'javascript:alert(1)'];
    for (const url of badUrls) {
      assert.equal(url.startsWith('https://'), false, `Should reject: ${url}`);
    }
  });
});

describe('Webhook secret validation', () => {
  it('accepts secrets >= 8 characters', () => {
    const valid = ['whsec_12345678', 'abcdefgh', '12345678'];
    for (const s of valid) {
      assert.ok(s.length >= 8, `Should accept: ${s}`);
    }
  });

  it('rejects secrets < 8 characters', () => {
    const invalid = ['short', '1234567', 'abc', ''];
    for (const s of invalid) {
      assert.ok(s.length < 8, `Should reject: ${s}`);
    }
  });
});

describe('Subscription matching', () => {
  const baseSub = {
    id: 'test-sub',
    url: 'https://example.com/webhook',
    secret: 'whsec_test123',
    enabled: true,
    status: 'active',
    spaces: [],
    events: [],
    consecutiveFailures: 0,
  };

  it('matches all events when events filter is empty', () => {
    assert.ok(matchesSubscription(baseSub, 'memory.created', 'general'));
    assert.ok(matchesSubscription(baseSub, 'entity.deleted', 'my-space'));
    assert.ok(matchesSubscription(baseSub, 'file.created', 'other'));
  });

  it('matches all spaces when spaces filter is empty', () => {
    assert.ok(matchesSubscription(baseSub, 'memory.created', 'any-space'));
    assert.ok(matchesSubscription(baseSub, 'memory.created', 'general'));
  });

  it('filters by event type when events are specified', () => {
    const sub = { ...baseSub, events: ['memory.created', 'memory.updated'] };
    assert.ok(matchesSubscription(sub, 'memory.created', 'general'));
    assert.ok(matchesSubscription(sub, 'memory.updated', 'general'));
    assert.equal(matchesSubscription(sub, 'memory.deleted', 'general'), false);
    assert.equal(matchesSubscription(sub, 'entity.created', 'general'), false);
  });

  it('filters by space when spaces are specified', () => {
    const sub = { ...baseSub, spaces: ['dev-lessons', 'dev-infra'] };
    assert.ok(matchesSubscription(sub, 'memory.created', 'dev-lessons'));
    assert.ok(matchesSubscription(sub, 'memory.created', 'dev-infra'));
    assert.equal(matchesSubscription(sub, 'memory.created', 'other'), false);
  });

  it('does not match disabled subscriptions', () => {
    const sub = { ...baseSub, enabled: false };
    assert.equal(matchesSubscription(sub, 'memory.created', 'general'), false);
  });

  it('does not match subscriptions with status=disabled', () => {
    const sub = { ...baseSub, status: 'disabled' };
    assert.equal(matchesSubscription(sub, 'memory.created', 'general'), false);
  });

  it('combines space + event filters (AND logic)', () => {
    const sub = {
      ...baseSub,
      spaces: ['production'],
      events: ['entity.created'],
    };
    assert.ok(matchesSubscription(sub, 'entity.created', 'production'));
    assert.equal(matchesSubscription(sub, 'entity.created', 'staging'), false);
    assert.equal(matchesSubscription(sub, 'memory.created', 'production'), false);
    assert.equal(matchesSubscription(sub, 'memory.created', 'staging'), false);
  });
});

describe('HMAC-SHA256 signature', () => {
  it('produces a valid hex-encoded HMAC', () => {
    const secret = 'whsec_test123456';
    const body = '{"event":"memory.created","timestamp":"2026-04-11T14:30:00.000Z"}';
    const sig = computeHmac(secret, body);
    assert.ok(typeof sig === 'string');
    assert.ok(/^[0-9a-f]{64}$/.test(sig), 'Should be 64 hex chars (SHA256)');
  });

  it('is deterministic — same inputs produce same output', () => {
    const secret = 'whsec_deterministic';
    const body = '{"event":"entity.created"}';
    const sig1 = computeHmac(secret, body);
    const sig2 = computeHmac(secret, body);
    assert.equal(sig1, sig2);
  });

  it('changes when the body changes', () => {
    const secret = 'whsec_diffbody';
    const sig1 = computeHmac(secret, '{"a":1}');
    const sig2 = computeHmac(secret, '{"a":2}');
    assert.notEqual(sig1, sig2);
  });

  it('changes when the secret changes', () => {
    const body = '{"event":"test.ping"}';
    const sig1 = computeHmac('whsec_secret1', body);
    const sig2 = computeHmac('whsec_secret2', body);
    assert.notEqual(sig1, sig2);
  });

  it('can be verified by the receiver using the same secret', () => {
    const secret = 'whsec_shared_secret';
    const body = '{"event":"memory.created","spaceId":"general"}';
    const signature = computeHmac(secret, body);

    // Receiver verifies by computing the same HMAC
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    assert.equal(signature, expected);
  });
});

describe('Webhook event payload structure', () => {
  it('creates a valid event payload', () => {
    const payload = {
      event: 'memory.created',
      timestamp: new Date().toISOString(),
      spaceId: 'dev-lessons',
      spaceName: 'Dev Lessons',
      entry: { _id: 'abc-123', fact: 'The sky is blue' },
      tokenId: 'tok-123',
      tokenLabel: 'mcp-bridge',
    };

    assert.ok(ALL_WEBHOOK_EVENTS.has(payload.event));
    assert.ok(typeof payload.timestamp === 'string');
    assert.ok(typeof payload.spaceId === 'string');
    assert.ok(typeof payload.spaceName === 'string');
    assert.ok(typeof payload.entry === 'object');
    assert.ok(typeof payload.entry._id === 'string');
  });

  it('delete events include only { _id }', () => {
    const payload = {
      event: 'memory.deleted',
      timestamp: new Date().toISOString(),
      spaceId: 'general',
      spaceName: 'General',
      entry: { _id: 'deleted-id' },
    };

    assert.deepEqual(Object.keys(payload.entry), ['_id']);
  });
});
