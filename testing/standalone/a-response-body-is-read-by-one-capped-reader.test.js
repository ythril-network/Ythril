/**
 * A response body is read into memory by ONE capped reader, `scripts/_shared/capped-body.mjs` (bundle-56 dedup, item 7).
 *
 * ## What this prevents
 *
 * `ythril-api.mjs` `readText` and `test-times.mjs` `fetchCapped` each wrote the same loop: `for await` over `res.body`,
 * sum the chunk lengths, throw past a cap, `Buffer.concat`. The answer of a server the script does not control is
 * hostile input, and the cap is the one line a hand-written read leaves out - the next script that read a body
 * would have read it whole. The reader refuses past the cap and stops reading when it does.
 *
 * What stays separate, and why: `benchmarks/dataset-pin.mjs` streams a body through a hash to a file, with no cap and
 * no buffer. That is a different question (a verified download), and it never holds the body in memory.
 *
 * Run: node --test testing/standalone/a-response-body-is-read-by-one-capped-reader.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const MODULE = 'scripts/_shared/capped-body.mjs';
const load = () => import(pathToFileURL(resolve(REPO_ROOT, MODULE)).href);

/** A response whose body arrives in the given chunks, and which says when the reader walked away from it. */
function chunked(chunks) {
  const state = { cancelled: false, pulled: 0 };
  const body = new ReadableStream({
    pull(controller) {
      const next = chunks[state.pulled++];
      if (next === undefined) controller.close(); else controller.enqueue(next);
    },
    cancel() { state.cancelled = true; },
  });
  return { res: new Response(body), state };
}

describe('readCappedBody', () => {
  it('returns every byte of a body within the cap, across chunks', async () => {
    const { readCappedBody } = await load();
    const { res } = chunked([Buffer.from('hel'), Buffer.from('lo '), Buffer.from('world')]);
    assert.equal((await readCappedBody(res, 100)).toString('utf8'), 'hello world');
  });

  it('accepts a body of exactly the cap', async () => {
    const { readCappedBody } = await load();
    const { res } = chunked([Buffer.alloc(10, 1), Buffer.alloc(10, 2)]);
    assert.equal((await readCappedBody(res, 20)).length, 20);
  });

  it('refuses a body one byte past the cap, and says the cap', async () => {
    const { readCappedBody, BodyTooLargeError } = await load();
    const { res } = chunked([Buffer.alloc(10, 1), Buffer.alloc(11, 2)]);
    await assert.rejects(readCappedBody(res, 20), (err) => err instanceof BodyTooLargeError && err.cap === 20 && /larger than 20 bytes/.test(err.message));
  });

  it('stops reading when it refuses: the rest of the body is never pulled, and the stream is cancelled', async () => {
    const { readCappedBody } = await load();
    const { res, state } = chunked([Buffer.alloc(50), Buffer.alloc(50), Buffer.alloc(50), Buffer.alloc(50)]);
    await assert.rejects(readCappedBody(res, 60));
    assert.equal(state.cancelled, true, 'the body was left open');
    assert.ok(state.pulled < 4, `the reader pulled ${state.pulled} chunks of 4 after the cap was crossed`);
  });

  it('answers an empty body, and a response with none, as zero bytes', async () => {
    const { readCappedBody } = await load();
    assert.equal((await readCappedBody(new Response(''), 10)).length, 0);
    assert.equal((await readCappedBody({ body: null }, 10)).length, 0);
  });

  it('throws what the caller asked for, so the caller keeps its own error type', async () => {
    const { readCappedBody } = await load();
    class Mine extends Error {}
    const { res } = chunked([Buffer.alloc(30)]);
    await assert.rejects(readCappedBody(res, 10, { refuse: (cap) => new Mine(`mine ${cap}`) }), (err) => err instanceof Mine && err.message === 'mine 10');
  });

  it('refuses a cap that is not a positive number: there is no way to ask for no cap', async () => {
    const { readCappedBody } = await load();
    for (const cap of [undefined, null, 0, -1, NaN, Infinity, '10']) {
      await assert.rejects(readCappedBody(new Response('x'), cap), TypeError, `cap ${String(cap)}`);
    }
  });
});

describe('no other script keeps its own capped read', () => {
  /*
   * The shape a hand-written copy has: a `for await` over a `.body` AND a `Buffer.concat` in the same file. The hashing
   * stream in `benchmarks/dataset-pin.mjs` has the first and not the second, which is the difference in the question.
   */
  it('only the reader loops over a body and joins the chunks', () => {
    const files = trackedSources(['scripts', 'testing', 'benchmarks'], { ext: ['.mjs', '.js'], floor: 200, exclude: [MODULE] });
    assert.ok(files.length >= 50, `the scan saw only ${files.length} sources`);
    const copies = files.filter((f) => {
      const text = stripComments(readFileSync(resolve(REPO_ROOT, f), 'utf8'));
      return /for await \([^)]*\.body\b/.test(text) && /Buffer\.concat\(/.test(text);
    });
    assert.deepEqual(copies, [], `these read a response body into memory themselves; use readCappedBody from ${MODULE}`);
  });

  it('the two doors that used to keep one import the reader', () => {
    for (const f of ['scripts/_shared/ythril-api.mjs', 'scripts/test-times.mjs']) {
      assert.match(readFileSync(resolve(REPO_ROOT, f), 'utf8'), /capped-body\.mjs/, `${f} does not import the reader`);
    }
  });
});
