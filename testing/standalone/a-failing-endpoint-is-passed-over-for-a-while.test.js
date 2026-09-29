/**
 * A model endpoint that failed is passed over for a while, and the reranker is one of them (`Q-157`).
 *
 * Owner, 2026-09-29: *"duration is insane for simple semantic search queries, work on performance"*. Measured on
 * a 5.6.0 instance: every recall took 20 s, the reranker's slot timeout, and then answered in fused order anyway;
 * with the reranker skipped the same recall took 90 ms. Nothing remembered that the last pass had failed, so every
 * search paid the timeout again.
 *
 * The assist model already passed a failing primary over for a minute. The reranker is the second endpoint with the
 * same need, so the rule is one module (`util/endpoint-cooldown.ts`) and both use it.
 *
 * Run: npm run build -w server && node --test testing/standalone/a-failing-endpoint-is-passed-over-for-a-while.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { endpointCooldown, endpointUnavailable } from '../../server/dist/util/endpoint-cooldown.js';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

describe('an endpoint cool-down', () => {
  it('is open until a failure, then closed for the base window', () => {
    const c = endpointCooldown('t1', { baseMs: 1_000, maxMs: 8_000 });
    assert.equal(c.coolingDown(0), false);
    c.failed(0);
    assert.equal(c.coolingDown(999), true);
    assert.equal(c.coolingDown(1_000), false);
  });

  it('doubles on each failure in a row, up to its ceiling', () => {
    const c = endpointCooldown('t2', { baseMs: 1_000, maxMs: 4_000 });
    c.failed(0); assert.equal(c.until(), 1_000);
    c.failed(1_000); assert.equal(c.until(), 3_000);
    c.failed(3_000); assert.equal(c.until(), 7_000);
    c.failed(7_000); assert.equal(c.until(), 11_000, 'capped at the ceiling');
  });

  it('a success ends it and resets the doubling', () => {
    const c = endpointCooldown('t3', { baseMs: 1_000, maxMs: 8_000 });
    c.failed(0); c.failed(1_000);
    c.succeeded();
    assert.equal(c.coolingDown(1_500), false);
    c.failed(2_000);
    assert.equal(c.until(), 3_000, 'back to the base window');
  });

  it('counts unreachable, rate-limited and server errors as unavailable, and a request of its own fault not', () => {
    for (const s of [undefined, 429, 500, 502, 503, 529]) assert.equal(endpointUnavailable(s), true, String(s));
    for (const s of [400, 401, 404, 413, 422]) assert.equal(endpointUnavailable(s), false, String(s));
  });
});

describe('the reranker and the assist model both go through it', () => {
  const rerank = stripComments(readFileSync('server/src/brain/rerank-client.ts', 'utf8'));
  const assist = stripComments(readFileSync('server/src/config/assist-backend.ts', 'utf8'));

  it('rerank() asks the cool-down before it sends anything', () => {
    const body = bodyOf(rerank, 'rerank');
    const asks = body.search(/rerankCooldown\.coolingDown\(/);
    const sends = body.search(/modelFetch\(/);
    assert.ok(asks >= 0, 'rerank() never asks whether the reranker is cooling down');
    assert.ok(sends < 0 || asks < sends, 'rerank() sends a request before asking');
  });

  it('a failed pass and a successful one are both reported to it', () => {
    assert.match(rerank, /rerankCooldown\.failed\(/, 'a failing reranker is never cooled down');
    assert.match(rerank, /rerankCooldown\.succeeded\(/, 'a recovered reranker is never reopened');
  });

  it('the assist model keeps no cool-down of its own', () => {
    assert.match(assist, /endpointCooldown\(/, 'the assist model does not use the shared cool-down');
    assert.doesNotMatch(assist, /primaryDownUntil\s*=/, 'the assist model still writes its own cool-down');
  });
});
