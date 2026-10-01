/**
 * Three Q-108 defects carried into 5.6.x, each pinned on its own (main pins them inside
 * `a-quantity-over-its-bound-is-refused.test.js`, which imports bound modules 5.6.x does not carry).
 *
 *  1. **Every notify event a sender sends is one the route accepts.** `spaces/meta-update.ts` sent
 *     `meta_change_pending` since the schema vote shipped, and it was never in `POST /api/notify`'s enum, so every
 *     peer refused it with a 400 that the sender's fire-and-forget never read. The senders are DERIVED — every
 *     `event: '<name>'` literal in a source file that calls `/api/notify` — with a floor, so a sixth sender is
 *     checked the day it is written.
 *  2. **The notify event store is bounded by bytes, not only by count.** 500 events of up to the JSON body limit
 *     each could hold gigabytes. The ring now evicts oldest-first past 1 MiB whatever the count.
 *  3. **An unknown tool name is refused BEFORE it becomes a metric label.** It was counted in
 *     `ythril_tool_calls_total` before the 404, so any caller could mint a time series per spelling.
 *
 * Fixtures are literal numbers on purpose (`CLAUDE.md`, *A test fixture is allowed to be literal*).
 *
 * Run: npm run build -w server && node --test testing/standalone/a-notify-event-and-a-tool-name-are-bounded.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';

const notify = await import('../../server/dist/api/notify.js').catch(err => ({ __missing: err.message }));

/** Every `event: '<name>'` a source file that calls `/api/notify` sends, other than the route itself. */
function sentEvents() {
  const files = execFileSync('git', ['ls-files', 'server/src/*.ts', 'server/src/**/*.ts'], { encoding: 'utf8' })
    .split('\n').filter(f => f && f !== 'server/src/api/notify.ts');
  const sent = new Map();
  for (const f of files) {
    const src = stripComments(readFileSync(f, 'utf8'));
    if (!src.includes('/api/notify')) continue;
    for (const m of src.matchAll(/\bevent:\s*'([a-z_]+)'/g)) sent.set(m[1], f);
  }
  return sent;
}

describe('notify and tool-call bounds (Q-108)', () => {
  it('every notify event a sender sends is one POST /api/notify accepts', () => {
    assert.ok(notify.NotifyBody, `api/notify exports no NotifyBody: ${notify.__missing ?? ''}`);
    const sent = sentEvents();
    assert.ok(sent.size >= 5, `found only ${sent.size} sent notify events — the derivation is reading the wrong thing`);
    const refused = [...sent].filter(([event]) => !notify.NotifyBody.safeParse(
      { networkId: 'n', instanceId: 'i', event }).success).map(([event, f]) => `${event} (sent by ${f})`);
    assert.deepEqual(refused, [],
      `these events are sent and every peer refuses them with a 400 the sender never reads:\n  ${refused.join('\n  ')}`);
  });

  it('the notify ring is held to 1 MiB whatever the count, oldest out first', () => {
    assert.ok(notify.notifyRing, `api/notify exports no notifyRing: ${notify.__missing ?? ''}`);
    for (let i = 0; i < 400; i++) {
      notify.notifyRing.push({ id: `${i}`, networkId: 'n', instanceId: 'i', event: 'ping', data: { blob: 'x'.repeat(8000) }, receivedAt: 'x' });
    }
    assert.ok(notify.notifyRing.bytes() <= 1024 * 1024, `the ring holds ${notify.notifyRing.bytes()} bytes`);
    const kept = notify.notifyRing.list();
    assert.ok(kept.length > 0 && kept.length < 400, 'the ring evicts by bytes');
    assert.equal(kept[kept.length - 1].id, '399', 'the newest event is kept');
    assert.ok(Number(kept[0].id) > 0, 'and the oldest went first');
  });

  it('the notify ring still holds at most 500 events of any size', () => {
    for (let i = 0; i < 600; i++) {
      notify.notifyRing.push({ id: `s${i}`, networkId: 'n', instanceId: 'i', event: 'ping', receivedAt: 'x' });
    }
    assert.equal(notify.notifyRing.list().length, 500);
  });

  it('an unknown tool is refused BEFORE its name becomes a metric label', () => {
    const src = stripComments(readFileSync('server/src/mcp/call-tool.ts', 'utf8'));
    const refusal = src.search(/if\s*\(\s*!tool\s*\)\s*\{?\s*return refuse\(404/);
    const label = src.indexOf('toolCallsTotal.inc(');
    assert.ok(refusal > 0 && label > 0, 're-anchor: the unknown-tool refusal or the metric increment moved');
    assert.ok(refusal < label, 'the caller-supplied tool name reaches `toolCallsTotal` before the 404 — unbounded label cardinality');
  });
});
