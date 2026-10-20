/**
 * The live change stream on a personal view goes through the real ticket path, holds one listener, and ends when its owner or its
 * view changes (Q-531, bundle-100, plan rev 3.1 "SSE ticket", rev 3.2 "Lifecycle and owner" and the security vet S9).
 *
 * ## The rules
 *
 * 1. **The ticket redeems on a view.** `POST /api/brain/spaces/%40mine/events/ticket` mints, and the ticket opens
 *    `GET /api/brain/spaces/<id>/events?ticket=` whichever spelling the browser sends (`%40mine` or `@mine`): minting and redemption
 *    compare ONE canonical form, the path decoded per segment. A malformed escape in the path gets no ticket and never a 500.
 * 2. **One listener per stream.** A stream on a view of two members adds exactly one listener to the brain-change bus (not one per
 *    member), delivers a change in each member once, and nothing from a space outside the view.
 * 3. **It ends with its owner and with its view.** After the owner's token is revoked, or after the view's members change, the next
 *    change ends the stream (the config generation is compared per event; the client reconnects and recomputes), and the stream's
 *    listener and its slot in the connection pool are released.
 *
 * ## Seen red at 18e8d598
 *
 * `POST /api/views` answers 404 `Not found`, so every case fails at its view create; with the create skipped, the ticket door answers
 * `Space '@mine' not found`. The malformed-path case is held to "no 500"; it is red only if the decode is moved outside a `try`.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), npm run build:server, then
 *      node --test testing/standalone/a-personal-view-stream-follows-its-owner-and-its-view-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openViewDoors, viewOf } from './_view-doors.mjs';

const skip = await mongoSkipReason();
const QA = 'vs-qa';
const OPS = 'vs-ops';
const ELSE = 'vs-else';
const POOL = 'brain-events';

let d, publishBrainChange, openStreams, bus;
const fmt = (a) => `${a.status} ${(a.text ?? '').slice(0, 200)}`;

async function mustCreate(key, name, members) {
  const a = await d.rest(key, 'POST', '/api/views', { name, members });
  assert.equal(a.status, 201, `POST /api/views {name: '${name}'} answered ${fmt(a)}`);
  assert.equal(viewOf(a)?.id, `@${name}`);
}

/** The brain-change bus, found by what it does: the emitter `publishBrainChange` emits `change` on. */
function findBus() {
  let found = null;
  const emit = EventEmitter.prototype.emit;
  EventEmitter.prototype.emit = function (name, ...args) { if (name === 'change' && args[0]?.event === 'vs-probe') found = this; return emit.call(this, name, ...args); };
  try { publishBrainChange({ event: 'vs-probe', spaceId: 'vs-nowhere', entry: {} }); } finally { EventEmitter.prototype.emit = emit; }
  assert.ok(found, 'publishBrainChange emitted no `change` event: the bus could not be located');
  return found;
}

/** Mint a ticket at `mintSpelling` and open the stream at `openSpelling`; resolves once the stream's first byte arrived. */
async function openStream(key, mintSpelling, openSpelling = mintSpelling) {
  const t = await d.rest(key, 'POST', `/api/brain/spaces/${mintSpelling}/events/ticket`);
  assert.equal(t.status, 200, `the ticket door on ${mintSpelling}: ${fmt(t)}`);
  assert.ok(typeof t.body?.ticket === 'string', `no ticket in ${fmt(t)}`);
  const ac = new AbortController();
  const r = await fetch(`${d.server.url}/api/brain/spaces/${openSpelling}/events?ticket=${encodeURIComponent(t.body.ticket)}`, { signal: ac.signal });
  assert.equal(r.status, 200, `the stream at ${openSpelling} with a ticket minted at ${mintSpelling}: ${r.status} ${await r.text().catch(() => '')}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let ended = false;
  /** Read until `pred(buffer)` or `ms` pass; answers whether it held, and whether the server ended the stream. */
  async function until(pred, ms = 3_000) {
    const deadline = Date.now() + ms;
    while (!pred(buf) && !ended && Date.now() < deadline) {
      const next = await Promise.race([reader.read(), new Promise(res => setTimeout(() => res(null), Math.max(1, deadline - Date.now())))]);
      if (next === null) break;
      if (next.done) { ended = true; break; }
      buf += dec.decode(next.value, { stream: true });
    }
    return pred(buf);
  }
  await until(b => b.length > 0);
  return {
    until, get ended() { return ended; }, get text() { return buf; },
    ids: () => [...buf.matchAll(/^data: (.*)$/gm)].map(m => { try { return JSON.parse(m[1]).id; } catch { return undefined; } }).filter(Boolean),
    close() { ac.abort(); },
  };
}

const change = (spaceId, id) => publishBrainChange({ event: 'entity.created', spaceId, entry: { _id: id } });

describe('the change stream on a personal view (Q-531)', { skip }, () => {
  before(async () => {
    d = await openViewDoors({ suite: 'q531-view-stream', spaces: [QA, OPS, ELSE] });
    ({ publishBrainChange } = await import('../../server/dist/brain/brain-events.js'));
    ({ openStreams } = await import('../../server/dist/util/sse-stream.js'));
    bus = findBus();
  });
  after(async () => { await d?.close(); });

  const reader = () => d.mint(`vs-${Math.random().toString(36).slice(2, 8)}`, {
    [QA]: d.row({ knowledge: 'read' }), [OPS]: d.row({ knowledge: 'read' }), [ELSE]: d.row({ knowledge: 'read' }),
  });

  it('a ticket minted on the view redeems under either spelling of the id', async () => {
    const t = await reader();
    await mustCreate(t.key, 'mine', [QA, OPS]);
    for (const [mint, open] of [['%40mine', '%40mine'], ['%40mine', '@mine'], ['@mine', '%40mine']]) {
      const s = await openStream(t.key, mint, open);
      s.close();
    }
  });

  it('a malformed escape in the stream path gets no ticket and never a 500', async () => {
    const t = await reader();
    await mustCreate(t.key, 'bad', [QA]);
    const minted = await d.rest(t.key, 'POST', '/api/brain/spaces/%40bad/events/ticket');
    assert.equal(minted.status, 200, `control: the ticket door on the view: ${fmt(minted)}`);
    for (const path of ['/api/brain/spaces/%E0%A4%A/events', '/api/brain/spaces/%40bad%/events', '/api/brain/spaces/%ZZ/events']) {
      const r = await fetch(`${d.server.url}${path}?ticket=${encodeURIComponent(minted.body.ticket)}`, { signal: AbortSignal.timeout(10_000) });
      const body = await r.text();
      assert.notEqual(r.status, 500, `${path}: a malformed path answered 500 ${body.slice(0, 160)}`);
      assert.notEqual(r.status, 200, `${path}: a malformed path opened a stream`);
    }
  });

  it('one listener per stream; each member\'s change arrives once, nothing from outside the view', async () => {
    const t = await reader();
    await mustCreate(t.key, 'two', [QA, OPS]);
    const before_ = bus.listenerCount('change');
    const s = await openStream(t.key, '%40two');
    try {
      assert.equal(bus.listenerCount('change') - before_, 1, 'a stream on a view of two members added other than one bus listener');
      change(QA, 'vs-in-qa'); change(OPS, 'vs-in-ops'); change(ELSE, 'vs-outside');
      await s.until(b => b.includes('vs-in-qa') && b.includes('vs-in-ops'));
      await s.until(() => false, 300);
      assert.deepEqual(s.ids().sort(), ['vs-in-ops', 'vs-in-qa'], `the stream delivered ${JSON.stringify(s.ids())}`);
    } finally { s.close(); }
  });

  it('revoking the owner\'s token ends the stream at the next change and releases its listener and slot', async () => {
    const t = await reader();
    await mustCreate(t.key, 'revoked', [QA, OPS]);
    const [listeners, slots] = [bus.listenerCount('change'), openStreams(POOL)];
    const s = await openStream(t.key, '%40revoked');
    try {
      change(QA, 'vs-before-revoke');
      assert.ok(await s.until(b => b.includes('vs-before-revoke')), 'control: the stream delivered nothing before the revoke');
      assert.equal(await d.tokens.revokeToken(t.id), true);
      change(QA, 'vs-after-revoke');
      await s.until(() => false, 3_000);
      assert.ok(s.ended, 'the stream of a revoked owner stayed open');
      assert.ok(!s.text.includes('vs-after-revoke'), 'a revoked owner\'s stream delivered a change after the revoke');
      await s.until(() => false, 200);
      assert.deepEqual([bus.listenerCount('change'), openStreams(POOL)], [listeners, slots], 'the ended stream kept its listener or its pool slot');
    } finally { s.close(); }
  });

  it('changing the view ends its stream at the next change (the client reconnects and recomputes)', async () => {
    const t = await reader();
    await mustCreate(t.key, 'changed', [QA, OPS]);
    const s = await openStream(t.key, '%40changed');
    try {
      const p = await d.rest(t.key, 'PATCH', '/api/views/%40changed', { members: [QA] });
      assert.equal(p.status, 200, `PATCH the view's members: ${fmt(p)}`);
      change(OPS, 'vs-after-change');
      await s.until(() => false, 3_000);
      assert.ok(s.ended, 'a stream on a view whose members changed stayed open on the old member set');
      assert.ok(!s.text.includes('vs-after-change'), 'the stream delivered a change of a member the view no longer has');
    } finally { s.close(); }
  });
});
