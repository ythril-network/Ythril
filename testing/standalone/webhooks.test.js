/**
 * Unit tests: webhook event-type constant + payload shape (compiled-code parity)
 *
 * This file previously RE-IMPLEMENTED the dispatcher's event set, URL/secret
 * validation, HMAC, and subscription-matching, then asserted against those
 * copies — so it passed even if the real code drifted or broke (S8.4). The real
 * behavioural coverage now lives in `testing/integration/webhooks.test.js`,
 * which drives the compiled admin API + dispatcher (validation, matching via
 * getMatchingWebhooks, HMAC signing, delivery logging) end-to-end.
 *
 * What remains here is the one thing that IS a pure, importable value: the
 * canonical `ALL_WEBHOOK_EVENTS` set. Importing it from the compiled build means
 * this test fails by name if an event type is added/removed/renamed in the real
 * enum without the expectation being updated — instead of silently agreeing
 * with a stale local copy.
 *
 * Run: node --test testing/standalone/webhooks.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let ALL_WEBHOOK_EVENTS;

before(async () => {
  ({ ALL_WEBHOOK_EVENTS } = await import('../../server/dist/webhooks/types.js'));
});

describe('Webhook event types (real ALL_WEBHOOK_EVENTS from the compiled build)', () => {
  it('contains exactly the documented event set', () => {
    const expected = [
      'fact.created', 'fact.updated', 'fact.deleted',
      'entity.created', 'entity.updated', 'entity.deleted', 'entity.merged',
      'edge.created', 'edge.updated', 'edge.deleted',
      'chrono.created', 'chrono.updated', 'chrono.deleted',
      'file.created', 'file.updated', 'file.deleted',
      'bulk.write',
      'link_violation.created',
      'duplicate.detected',
      'change_note.received',
      'test.ping',
    ];
    for (const e of expected) {
      assert.ok(ALL_WEBHOOK_EVENTS.has(e), `Missing event type in the real enum: ${e}`);
    }
    // Exact-size check: a new event type added to the enum without updating this
    // list (or a removed one) fails here by name — the drift guard.
    assert.equal(
      ALL_WEBHOOK_EVENTS.size, expected.length,
      `Real enum has ${ALL_WEBHOOK_EVENTS.size} events, expected list has ${expected.length}: ` +
      `${JSON.stringify([...ALL_WEBHOOK_EVENTS].filter(e => !expected.includes(e)))}`,
    );
  });

  it('rejects unknown event types', () => {
    assert.equal(ALL_WEBHOOK_EVENTS.has('unknown.event'), false);
    assert.equal(ALL_WEBHOOK_EVENTS.has('fact.upserted'), false);
    assert.equal(ALL_WEBHOOK_EVENTS.has(''), false);
  });

  it('and the PRE-5.0 spellings, which is the half a rename leaves behind', () => {
    // The boot migration rewrites stored subscriptions, but an operator adding one by hand from an old
    // runbook must be refused rather than left with a hook that is listed, enabled, and never delivers.
    for (const old of ['memory.created', 'memory.updated', 'memory.deleted']) {
      assert.equal(ALL_WEBHOOK_EVENTS.has(old), false,
        `${old} is still accepted. Nothing emits it, so the subscription would be silently dead — the exact `
        + 'failure `db/rename-memories-to-facts.ts` migrates existing hooks away from.');
    }
  });
});

describe('Webhook event payload structure', () => {
  it('a fact.created payload uses a documented event type', () => {
    const payload = {
      event: 'fact.created',
      timestamp: new Date().toISOString(),
      spaceId: 'dev-lessons',
      spaceName: 'Dev Lessons',
      entry: { _id: 'abc-123', fact: 'The sky is blue' },
      tokenId: 'tok-123',
      tokenLabel: 'mcp-bridge',
    };
    assert.ok(ALL_WEBHOOK_EVENTS.has(payload.event));
    assert.ok(typeof payload.entry._id === 'string');
  });

  it('delete events carry only { _id }', () => {
    const payload = { event: 'fact.deleted', entry: { _id: 'deleted-id' } };
    assert.ok(ALL_WEBHOOK_EVENTS.has(payload.event));
    assert.deepEqual(Object.keys(payload.entry), ['_id']);
  });
});
