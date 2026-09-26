/**
 * Every webhook event the Settings page offers is one the server accepts, and every event the server emits can be
 * picked there.
 *
 * The client keeps its own list (`WEBHOOK_EVENT_GROUPS` in `client/src/app/core/api.types.ts`) for the picker. When
 * the knowledge type `memory` became `fact` in 5.0 (`A-2`), the server's event names moved to `fact.*` and the
 * client's did not: the page went on offering `memory.created`, `memory.updated` and `memory.deleted`, and the server
 * refused every subscription that ticked one with "Invalid event type" — from 5.0.0 until 5.4.0, on the one control
 * an operator uses to subscribe to fact events at all.
 *
 * Derived from both sides, never listed here: the server's set is `ALL_WEBHOOK_EVENTS`, and `test.ping` is left out
 * of the picker on purpose (it is the test button's own event).
 *
 * Run: node --test testing/standalone/a-webhook-event-the-client-offers-is-one-the-server-accepts.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let ALL_WEBHOOK_EVENTS;
before(async () => { ({ ALL_WEBHOOK_EVENTS } = await import('../../server/dist/webhooks/types.js')); });

const src = readFileSync('client/src/app/core/api.types.ts', 'utf8');
/** Not offered in the picker, by design: the test button sends it. */
const NOT_PICKABLE = new Set(['test.ping']);

function clientPicker() {
  const at = src.indexOf('export const WEBHOOK_EVENT_GROUPS');
  assert.ok(at > -1, 'WEBHOOK_EVENT_GROUPS is gone from api.types.ts — re-point this gate');
  const body = src.slice(at, src.indexOf('];', at));
  return [...body.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map(m => m[1]);
}

function clientType() {
  const m = /export type WebhookEventType =([^;]+);/.exec(src);
  assert.ok(m, 'WebhookEventType is gone from api.types.ts — re-point this gate');
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

describe('the webhook picker and the server agree on event names', () => {
  it('every event the picker offers is accepted by the server', () => {
    const offered = clientPicker();
    assert.ok(offered.length > 0, 'parsed no events — the gate would pass on nothing');
    const refused = offered.filter(e => !ALL_WEBHOOK_EVENTS.has(e));
    assert.deepEqual(refused, [], `the page offers events the server refuses with "Invalid event type": ${refused.join(', ')}`);
  });

  it('every event the server emits can be picked', () => {
    const offered = new Set(clientPicker());
    const missing = [...ALL_WEBHOOK_EVENTS].filter(e => !NOT_PICKABLE.has(e) && !offered.has(e));
    assert.deepEqual(missing, [], `the server emits events nobody can subscribe to from the page: ${missing.join(', ')}`);
  });

  it('the client type names the same events the server does', () => {
    const typed = new Set(clientType());
    const want = [...ALL_WEBHOOK_EVENTS].filter(e => !NOT_PICKABLE.has(e)).sort();
    assert.deepEqual([...typed].sort(), want);
  });
});
