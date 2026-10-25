/**
 * A document lock a held transaction meets (a merge, an edge relabel) is answered as the STORE NOT ANSWERING, `503`, retryable, in words of
 * our own, on both doors (bundle-81, the parent's decision 66; design rev 8 §1b "the transaction-wide held floor").
 *
 * ## The defect
 *
 * A transaction that stamps positions runs through `inHeldTransaction` (`brain/held-transaction.ts`): the position floor held around a bounded
 * `withTransaction`. A document lock held elsewhere is a `WriteConflict` the driver retries for as long as the write bound allows, and what the
 * bound then ends the call with is the driver's own `WriteConflict` — not the bound's timeout. `a-bounded-transaction-ends-and-holds-no-horizon-db`
 * holds the call to the bound "without asking how the caller is answered", and this is the question it leaves: the driver's error reaches the
 * door, which answers the caller a `500` (or, on MCP, a refusal that quotes `WriteConflict` and the collection), where every other write the
 * bound ends is `503`, retryable, generic (`a-write-timeout-answers-503-on-every-door-db`).
 *
 * ## The rule
 *
 * `inHeldTransaction` ends a write conflict it met at the bound as the bound's own `StoreTimeout` (so the store-not-answering answer on every
 * door, and a walk's `store-down`/`space-timeout` verdict), with the driver's error kept as its `cause`. The same call with no lock lands.
 *
 * ## What is driven
 *
 * The REAL stall (`_write-faults.mjs holdDocumentLock`: another session's open transaction on the surviving entity) and the two merge doors: the
 * REST route through the whole app, and `graph_merge` through `callTool`. A control runs each door unstalled, so a 503 is the lock and not the fixture.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-write-conflict-in-a-held-transaction-answers-the-store-503-on-both-doors-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { holdDocumentLock, settleWithin, setWriteBoundForTest } from './_write-faults.mjs';
import { openStalledWriteDoors } from './_stalled-write-doors.mjs';
import { build } from './_push-door.mjs';

const skip = await mongoSkipReason();

const S = 'heldconflict';
const BOUND = { writeTimeoutMs: 2000, holdDeadlineMs: 2000 };
const CAP_MS = BOUND.holdDeadlineMs + 4000;
const SURVIVOR = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const ABSORBED = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const DRIVER_TEXT = /Mongo\w*Error|MaxTimeMS|maxTimeMS|exceeded time limit|Timed out during|Server reported a timeout|WriteConflict|heldconflict_entities|E11000/;

const env = {};

/** Each door answers `{ status, body, text }` after merging ABSORBED into SURVIVOR. */
const DOORS = [
  {
    name: 'REST POST /api/brain/spaces/:id/entities/:survivor/merge/:absorbed',
    call: async () => {
      const r = await fetch(`${env.base}/api/brain/spaces/${S}/entities/${SURVIVOR}/merge/${ABSORBED}`, {
        method: 'POST', headers: { Authorization: `Bearer ${env.adminKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ resolutions: [] }),
      });
      const text = await r.text();
      let body; try { body = JSON.parse(text); } catch { body = text; }
      return { status: r.status, body, text };
    },
  },
  {
    name: 'MCP graph_merge (callTool)',
    call: async () => {
      const out = await env.callTool({
        name: 'graph_merge', args: { space: S, survivorId: SURVIVOR, absorbedId: ABSORBED, resolutions: [] },
        caller: { rights: env.ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' },
      });
      const text = (out.result.content ?? []).map(c => c.text ?? '').join('\n');
      return { status: out.status, body: out.result.structuredContent ?? {}, text };
    },
  },
];

describe('a write conflict a held transaction meets is the store not answering', { skip }, () => {
  let doors;
  let restoreBound = () => {};
  let seamError = null;

  before(async () => {
    doors = await openStalledWriteDoors({ suite: 'heldconflict', spaces: [S] });
    Object.assign(env, doors.env);
    try { restoreBound = await setWriteBoundForTest(BOUND); } catch (err) { seamError = err; }
  });
  after(async () => { restoreBound(); await doors?.close(); });
  beforeEach(async () => {
    await env.door.wipe(S);
    await env.door.coll(S, 'entities').insertMany([
      build.entity(S, SURVIVOR, 3, { name: 'survivor' }), build.entity(S, ABSORBED, 4, { name: 'absorbed' }),
    ]);
    await env.door.setCounter(S, 4);
  });

  it('the write bound has a test seam', () => { assert.equal(seamError, null, seamError?.message); });

  it('inHeldTransaction answers a lock it met at the bound as the bound\'s StoreTimeout, the driver\'s error kept as its cause', { timeout: 30_000 }, async () => {
    const { inHeldTransaction } = await import('../../server/dist/brain/held-transaction.js');
    const { StoreTimeout } = await import('../../server/dist/db/write-timeout.js');
    const lock = await holdDocumentLock(env.door.mongo, `${S}_entities`, { filter: { _id: SURVIVOR } });
    let thrown;
    try {
      await inHeldTransaction(S, 'test.hold', async (session) => {
        await env.door.mongo.col(`${S}_entities`).updateOne({ _id: SURVIVOR }, { $set: { touched: true } }, { session });
      });
    } catch (err) { thrown = err; } finally { await lock.release(); }
    assert.ok(thrown, 'a transaction that could not take its lock in time did not throw');
    assert.ok(thrown instanceof StoreTimeout, `it threw ${thrown?.name} (${thrown?.codeName ?? thrown?.message}), not the bound's StoreTimeout`);
    assert.ok(thrown.cause, 'the driver\'s error is not kept as the cause');
  });

  for (const d of DOORS) {
    it(`control: ${d.name} merges when nothing is locked`, async () => {
      const r = await d.call();
      assert.ok(r.status === 200 || r.status === 201, `${d.name} answered ${r.status} with nothing locked: ${r.text.slice(0, 300)}`);
    });

    it(`${d.name}: a lock on the survivor answers 503, retryable, in words of our own`, { timeout: CAP_MS + 30_000 }, async () => {
      const lock = await holdDocumentLock(env.door.mongo, `${S}_entities`, { filter: { _id: SURVIVOR } });
      let res;
      try { res = await settleWithin(d.call(), CAP_MS); } finally { await lock.release(); }
      const late = res.settled ? null : await res.rest;
      assert.ok(res.settled, `${d.name} had not answered ${res.elapsedMs} ms into a merge stalled behind a lock (once released it answered ${late?.ok ? late.value.status : late?.error?.message})`);
      assert.ok(res.ok, `${d.name} threw instead of answering: ${res.error?.stack ?? res.error}`);
      const { status, body, text } = res.value;
      assert.equal(status, 503, `${d.name} answered ${status} for a merge the store could not take in time: ${text.slice(0, 300)}`);
      assert.equal(body?.retryable, true, `${d.name}'s 503 does not say it is retryable: ${text.slice(0, 300)}`);
      assert.doesNotMatch(text, DRIVER_TEXT, `${d.name} answered with the driver's text: ${text.slice(0, 300)}`);
    });
  }
});
