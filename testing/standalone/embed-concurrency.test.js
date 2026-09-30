/**
 * Chunk-embed concurrency is sized per embedder, because the two are different problems.
 *
 * ## What was measured, inside the shipped image
 *
 * One in-process chunk embed (~1.8 KB) takes ~208 ms and blocks the event loop for essentially all of it.
 * Eight of them at once, which is what shipped:
 *
 *     conc 8, no yield   total 4730ms   loop lag max 2482ms   50ms-timer fired 1 time in 4.7s
 *     conc 2, yield      total 3677ms   loop lag max  547ms   fired 8 times
 *
 * So the old shape was **22% slower AND blocked the loop for 2.5 s at a stretch** — eight concurrent
 * CPU-bound inferences on a capped allocation thrash rather than parallelise. On a reporting fleet, a 358 KB
 * document turned into repeated liveness kills: `Readiness probe failed: context deadline exceeded (awaiting
 * headers)`, no error, no `failed` status, ~190 MiB of a 10 Gi limit. Nothing pointed at the document.
 *
 * ## Why not sized from the core count
 *
 * `os.availableParallelism()` reports the HOST's cores, not the cgroup limit. The reporting deployment is
 * capped at 4 CPU on a 16-core node — core detection would have "left headroom" of 15 and oversubscribed
 * exactly as before. That is why the in-process default is a conservative constant with an operator override,
 * and this file pins that reasoning as behaviour.
 *
 * ## What changed in Q-99 part 1, and why the numbers did not
 *
 * The figures above are the REASON the in-process default was 2, and they describe a world in which an inference
 * blocked the server's event loop. The local model now runs in a child process, one inference at a time behind a
 * FIFO host, so the loop stays free at any concurrency and a higher setting can only add queue depth. The default
 * stays 2 because two is what keeps the child fed while the IPC of the previous answer is in flight (pipelining),
 * and the clamp stays because an operator typo must not become hundreds of queued requests. What CHANGED is the
 * reasoning written beside the constant, and the last describe block of this file holds that: a comment that
 * still says "leaves the event loop responsive" is an authoritative reference that is wrong, and nobody reports a
 * sentence like that.
 *
 * Run: node --test testing/standalone/embed-concurrency.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

let embedConcurrency, IN_PROCESS_EMBED_CONCURRENCY, EXTERNAL_EMBED_CONCURRENCY, MAX_EMBED_CONCURRENCY;

describe('embedConcurrency', () => {
  before(async () => {
    ({ embedConcurrency, IN_PROCESS_EMBED_CONCURRENCY, EXTERNAL_EMBED_CONCURRENCY, MAX_EMBED_CONCURRENCY } =
      await import('../../server/dist/files/converters/embed-concurrency.js'));
  });

  it('is LOW for the bundled model — one inference process runs one embed at a time, so more only queues', () => {
    assert.equal(embedConcurrency({}), IN_PROCESS_EMBED_CONCURRENCY);
    assert.equal(embedConcurrency({ baseUrl: '' }), IN_PROCESS_EMBED_CONCURRENCY);
    assert.equal(embedConcurrency({ baseUrl: '   ' }), IN_PROCESS_EMBED_CONCURRENCY,
      'whitespace is not an endpoint');
    assert.equal(embedConcurrency({ baseUrl: null }), IN_PROCESS_EMBED_CONCURRENCY);
    assert.ok(IN_PROCESS_EMBED_CONCURRENCY < EXTERNAL_EMBED_CONCURRENCY, 'the whole point of the split');
  });

  it('is HIGHER for an external endpoint — the work is on another host', () => {
    assert.equal(embedConcurrency({ baseUrl: 'http://emb:8080' }), EXTERNAL_EMBED_CONCURRENCY);
    assert.equal(embedConcurrency({ baseUrl: 'https://api.example.com/v1' }), EXTERNAL_EMBED_CONCURRENCY);
  });

  it('honours an operator override for either embedder', () => {
    assert.equal(embedConcurrency({ embedConcurrency: 6 }), 6);
    assert.equal(embedConcurrency({ baseUrl: 'http://emb:8080', embedConcurrency: 1 }), 1);
  });

  it('NEVER returns zero or a negative, whatever is configured', () => {
    // A zero would stall ingestion completely — a worse failure than a slow one, and the kind that reads as
    // "uploads do nothing" with no error anywhere.
    for (const v of [0, -1, -100, 0.4]) {
      assert.ok(embedConcurrency({ embedConcurrency: v }) >= 1, `override ${v}`);
    }
  });

  it('clamps an absurd override rather than obeying it', () => {
    assert.equal(embedConcurrency({ embedConcurrency: 5000 }), MAX_EMBED_CONCURRENCY);
  });

  it('ignores a non-numeric or non-finite override and uses the default', () => {
    for (const v of [undefined, NaN, Infinity, '8']) {
      assert.equal(embedConcurrency({ embedConcurrency: v }), IN_PROCESS_EMBED_CONCURRENCY, String(v));
    }
  });

  it('floors a fractional override instead of passing it to a loop bound', () => {
    assert.equal(embedConcurrency({ embedConcurrency: 3.9 }), 3);
  });
});

describe('the reasoning written beside the defaults describes the process that exists', () => {
  const RAW = readFileSync('server/src/files/converters/embed-concurrency.ts', 'utf8');
  const PIPELINE = readFileSync('server/src/files/converters/pipeline.ts', 'utf8');

  it('no longer says the in-process default protects the event loop', () => {
    assert.ok(!/leave the event loop responsive|blocks the event\s+loop for essentially all/.test(RAW),
      'embed-concurrency.ts still gives "inference blocks the loop" as the reason for the default; since Q-99 '
      + 'part 1 the model runs in a child process and that is no longer what the number is for');
  });

  it('says what the number bounds now: requests queued on the one inference process', () => {
    assert.match(RAW, /inference process/i);
    assert.match(RAW, /\bqueue/i);
  });

  it('keeps its code where it was: the constants and the clamp', () => {
    const code = stripComments(RAW);
    assert.match(code, /IN_PROCESS_EMBED_CONCURRENCY\s*=\s*2\b/);
    assert.match(code, /Math\.min\(MAX_EMBED_CONCURRENCY/);
  });

  it('the document pipeline does not claim an embed blocks the event loop', () => {
    // The `setImmediate` yield between chunks was written because an in-process embed blocked the loop for ~200 ms.
    // Decided in this change, not left conditional: either the yield is gone or its comment says what it is for now.
    const at = PIPELINE.indexOf('setImmediate(resolve)');
    if (at < 0) return;   // removed: nothing to be wrong about
    // The comment block DIRECTLY above the statement: contiguous `//` lines walking up from it, bounded by the
    // first line that is not a comment rather than by a character count.
    const above = PIPELINE.slice(0, at).split(/\r?\n/);
    above.pop();   // the part of the statement's own line that precedes `setImmediate`
    const comment = [];
    for (let i = above.length - 1; i >= 0 && /^\s*\/\//.test(above[i]); i--) comment.unshift(above[i]);
    assert.ok(comment.length > 0, 'the yield has lost its explanation — re-anchor this gate');
    assert.ok(!/in-process embed blocks it|An in-process embed blocks/i.test(comment.join('\n')),
      'pipeline.ts keeps its per-chunk yield with a comment that still says an embed blocks the event loop');
  });
});
