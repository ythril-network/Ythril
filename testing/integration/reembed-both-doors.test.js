/**
 * The embedding backfill answers the same on both doors — driven against a running instance.
 *
 * ## Why this exists
 *
 * `POST /api/spaces/:id/reembed` shipped in 4.4 with no MCP tool, and nothing reported it: the capability
 * map paired the route with `space_reindex`, so the parity gate read a covered capability. `space_reembed`
 * closes it. The source gate beside this one asserts the two tools reach different modules; this asserts
 * the thing a source gate cannot — that the tool actually queues the jobs, and that the route agrees.
 *
 * ## The fixture is the interesting part
 *
 * A record with no vector is not something you can write directly: every write embeds. The way to make one
 * is the way an operator makes one by accident — turn `suppressEmbeddings` ON, write, turn it OFF. That is
 * exactly the state the backfill exists for, so the fixture and the subject are the same thing.
 *
 * Run: node --test testing/integration/reembed-both-doors.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, patch } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `reembed-${RUN}`;

let tokenA;
let mcp;

const viaRest = async (tool, args) => {
  const res = await fetch(`${INSTANCES.a}/api/${tool}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  return { status: res.status, body: await res.json() };
};

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  mcp = await openMcpSession(tokenA);

  const created = await post(INSTANCES.a, tokenA, '/api/spaces', { id: SPACE, label: `Reembed ${RUN}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  // Suppression ON, so the writes below land with no vector — the state the backfill is the way out of.
  const on = await patch(INSTANCES.a, tokenA, `/api/spaces/${SPACE}`, { meta: { suppressEmbeddings: true } });
  assert.ok(on.status < 400, `turning suppression on: ${on.status} ${JSON.stringify(on.body)}`);

  for (let i = 0; i < 3; i++) {
    const w = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${SPACE}/facts`, { fact: `unembedded fact ${i} ${RUN}` });
    assert.equal(w.status, 201, JSON.stringify(w.body));
  }
});

after(async () => {
  await fetch(`${INSTANCES.a}/api/spaces/${SPACE}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
  mcp?.close();
});

describe('the backfill, on both doors', () => {
  it('reports the suppressed records as skipped rather than queueing them', async () => {
    /*
     * Suppression still ON. This is the case that made the sweep correct in the first place: a suppressed
     * record matches "has no vector" by construction, so a backfill that filtered AFTER the query would
     * queue them, fail to embed them, and find them again on the next call, for ever.
     */
    const r = await viaRest('space_reembed', { space: SPACE });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.enqueued, 0, 'a suppressed record must not be queued');
    assert.ok(r.body.data.skippedSuppressed >= 3,
      `expected the three suppressed facts to be counted as skipped: ${JSON.stringify(r.body.data)}`);
  });

  it('queues them once suppression is released, and says how many', async () => {
    const off = await patch(INSTANCES.a, tokenA, `/api/spaces/${SPACE}`, { meta: { suppressEmbeddings: false } });
    assert.ok(off.status < 400, `turning suppression off: ${off.status} ${JSON.stringify(off.body)}`);

    const r = await viaRest('space_reembed', { space: SPACE });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.data.enqueued >= 3,
      `releasing suppression does not backfill on its own — this call is what does: ${JSON.stringify(r.body.data)}`);
    assert.equal(r.body.data.skippedSuppressed, 0);
  });

  it('and the MCP door returns the same structure', async () => {
    /*
     * THIS ASSERTED `enqueued === 0` AND THAT WAS A CLAIM THE CODE NEVER MADE.
     *
     * It passed when the file ran alone and failed in the full suite, which is the signature of a test
     * that encoded a timing coincidence. A backfill ENQUEUES; the worker embeds. Until the worker gets
     * there the record still has no vector, so a second sweep finds it again — and the module's promise is
     * that this is harmless, not that it cannot happen: `enqueueEmbedJob` upserts by job id, so a repeated
     * call CONVERGES rather than duplicating.
     *
     * So the assertion is the promise: the second sweep may find the same records, and it must never find
     * MORE than the space holds. Asserting emptiness would have made the suite fail on a slow worker and
     * taught the next person to widen the wrong thing.
     */
    const r = await mcp.callTool('space_reembed', { space: SPACE });
    assert.ok(!r.isError, JSON.stringify(r));
    const data = r.structuredContent;
    assert.ok(data, 'the tool must carry its counts in structuredContent, not only in prose');
    for (const key of ['spaceId', 'enqueued', 'skippedSuppressed', 'byKind', 'remaining', 'truncated']) {
      assert.ok(key in data, `the tool's result is missing '${key}', which the REST route returns`);
    }
    assert.equal(data.spaceId, SPACE);
    assert.ok(data.enqueued <= 3,
      `a converging sweep cannot find more than the space holds: ${JSON.stringify(data)}`);
    assert.equal(data.skippedSuppressed, 0, 'suppression is off by now, so nothing may be skipped for it');
  });

  it('a kind it was not asked for is left alone', async () => {
    // `kinds` narrows the sweep. A misspelled kind is refused by the schema rather than silently widening
    // to everything, which is the failure an operator would not notice until the bill.
    const bad = await viaRest('space_reembed', { space: SPACE, kinds: ['nonesuch'] });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));

    const ok = await viaRest('space_reembed', { space: SPACE, kinds: ['entity'] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.byKind.fact, undefined, 'a sweep narrowed to entities must not touch facts');
  });
});
