/**
 * A write the bound ended is answered `503`, retryable, with a GENERIC message — on every door a caller writes
 * through: the sync push routes, the REST record route, and the MCP tool door (bundle-30 plan §A5).
 *
 * ## The rule
 *
 * A timed-out write is the store's condition, not the caller's mistake and not a server bug: the caller should
 * retry it, and a sender should hold its watermark. So it is a typed `StoreTimeout`, mapped by ONE function on
 * every door to `503` with `retryable: true` — and with a message of our own, never the driver's text, which names
 * collections and internals and differs by which side of the socket fired first. A `400` would tell a sender the
 * document is bad (it is dropped), a `500` reads as our bug, and a 200 over a write that did not land is a lie.
 *
 * ## The doors, and why the push half is the FACT routes
 *
 * The plan bounds every operation issued while a seq hold is active (§A3). On the push door the one write inside a
 * hold is a FORK (`acceptPushedPage` allocates a block for it), and only facts fork — so the push routes that can
 * time out are the single `/facts` route and `/batch-upsert` carrying facts; both are asked. The REST door is
 * `PATCH /api/brain/spaces/:spaceId/facts/:id` through the whole app (its errors reach the app's error handler,
 * so calling the route's handler alone would test a door no request reaches); the MCP door is `update_fact`
 * through `callTool`, the dispatch every MCP request goes through.
 *
 * ## The stall is REAL (`_write-faults.mjs holdDocumentLock`)
 *
 * Another session's open transaction locks the document the write targets — the fact for an update, the fork's
 * derived id for a fork — and the bound (2 s, through the plan's `setWriteBoundForTest`) is what must end it. On
 * the unchanged code nothing ends it: each door is still waiting when the test releases the lock, and that is the
 * red, together with the missing seam.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-write-timeout-answers-503-on-every-door-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { holdDocumentLock, settleWithin, setWriteBoundForTest } from './_write-faults.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'timeout503';
const F = 'bbbbbbbb-0000-4000-8000-0000000000f3';
const DIVERGENT = 'the same fact, as the peer tells it';
const BOUND = { writeTimeoutMs: 2000, holdDeadlineMs: 2000 };
const CAP_MS = BOUND.holdDeadlineMs + 2500;

/** What the driver says about a write the bound ended — none of it may reach a caller. */
const DRIVER_TEXT = /Mongo\w*Error|MaxTimeMS|maxTimeMS|exceeded time limit|Timed out during|Server reported a timeout|WriteConflict|timeout503_facts|E11000/;

let door, base, adminKey, callTool, ADMIN, server, plan;

/** Each door: how to stall it, and how to call it — answering `{ status, body, text }`. */
const DOORS = [
  {
    name: 'sync push POST /facts (a fork)',
    lock: () => holdDocumentLock(door.mongo, `${S}_facts`, { insert: { _id: plan.forkIdFor(F, 3, DIVERGENT), spaceId: S, fact: 'lock', seq: 0 } }),
    call: async () => {
      const r = await door.push('/facts', build.fact(S, F, 3, { fact: DIVERGENT }), { spaceId: S });
      return { status: r.code, body: r.body, text: JSON.stringify(r.body) };
    },
  },
  {
    name: 'sync push POST /batch-upsert (a fork)',
    lock: () => holdDocumentLock(door.mongo, `${S}_facts`, { insert: { _id: plan.forkIdFor(F, 3, DIVERGENT), spaceId: S, fact: 'lock', seq: 0 } }),
    call: async () => {
      const r = await door.push('/batch-upsert', { facts: [build.fact(S, F, 3, { fact: DIVERGENT })] }, { spaceId: S });
      return { status: r.code, body: r.body, text: JSON.stringify(r.body) };
    },
  },
  {
    name: 'REST PATCH /api/brain/spaces/:spaceId/facts/:id',
    lock: () => holdDocumentLock(door.mongo, `${S}_facts`, { filter: { _id: F } }),
    call: async () => {
      const r = await fetch(`${base}/api/brain/spaces/${S}/facts/${F}`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fact: 'an edit the store cannot take in time' }),
      });
      const text = await r.text();
      let body; try { body = JSON.parse(text); } catch { body = text; }
      return { status: r.status, body, text };
    },
  },
  {
    name: 'MCP update_fact (callTool)',
    lock: () => holdDocumentLock(door.mongo, `${S}_facts`, { filter: { _id: F } }),
    call: async () => {
      const out = await callTool({
        name: 'update_fact', args: { space: S, id: F, fact: 'an edit the store cannot take in time' },
        caller: { rights: ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' },
      });
      const text = (out.result.content ?? []).map(c => c.text ?? '').join('\n');
      return { status: out.status, body: out.result.structuredContent ?? {}, text };
    },
  },
];

describe('a write timeout answers 503 on every door', { skip }, () => {
  let seamError = null;
  let restoreBound = () => {};

  before(async () => {
    door = await openPushDoor({ suite: 'timeout503', spaces: [{ id: S, label: S, folders: [], meta: { suppressEmbeddings: true } }] });
    plan = await import('../../server/dist/sync/upsert-plan.js');
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    const tokens = await import('../../server/dist/auth/tokens.js');
    adminKey = (await tokens.createToken({ name: 'admin', admin: true })).plaintext;
    const { createApp } = await import('../../server/dist/app.js');
    server = createApp().listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
    try { restoreBound = await setWriteBoundForTest(BOUND); } catch (err) { seamError = err; }
  });
  after(async () => {
    restoreBound();
    await new Promise(r => server?.close(r));
    await door?.close();
  });
  beforeEach(async () => {
    await door.wipe(S);
    await door.coll(S, 'facts').insertOne(build.fact(S, F, 3));
    await door.setCounter(S, 3);
  });

  it('the write bound has a test seam (db/write-bound.ts setWriteBoundForTest)', () => {
    assert.equal(seamError, null, seamError?.message);
  });

  it('control: unstalled, every door writes (so a 503 below is the stall, not the fixture)', async () => {
    for (const d of DOORS) {
      await door.wipe(S);
      await door.coll(S, 'facts').insertOne(build.fact(S, F, 3));
      const r = await d.call();
      assert.equal(r.status, 200, `${d.name} answered ${r.status} with nothing stalled: ${r.text.slice(0, 300)}`);
    }
  });

  for (const d of DOORS) {
    it(`${d.name}: a timed-out write answers 503, retryable, in words of our own`, { timeout: CAP_MS + 30_000 }, async () => {
      const lock = await d.lock();
      let res;
      try {
        res = await settleWithin(d.call(), CAP_MS);
      } finally {
        await lock.release();
      }
      const late = res.settled ? null : await res.rest;
      assert.ok(res.settled,
        `${d.name} had not answered ${res.elapsedMs} ms into a write stalled behind a lock — no bound ended it `
        + `(once the lock was released it answered ${late?.ok ? late.value.status : late?.error?.message})`);
      assert.ok(res.ok, `${d.name} threw instead of answering: ${res.error?.stack ?? res.error}`);
      const { status, body, text } = res.value;
      assert.equal(status, 503, `${d.name} answered ${status} for a write the store could not take in time: ${text.slice(0, 300)}`);
      assert.equal(body?.retryable, true, `${d.name}'s 503 does not say it is retryable: ${text.slice(0, 300)}`);
      assert.doesNotMatch(text, DRIVER_TEXT, `${d.name} answered with the driver's text: ${text.slice(0, 300)}`);
    });
  }
});
