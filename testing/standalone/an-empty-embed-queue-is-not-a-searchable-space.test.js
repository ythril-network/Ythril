/**
 * The benchmark harness must not start asking questions until the corpus can actually be found.
 *
 * ## The measurement this lost
 *
 * A rung wrote 35 records, its embedding queue read empty on the first poll, the space reported its vector
 * index ready — and every one of its 16 questions came back with ZERO results. It scored 0.0% on every column
 * in the report. The same queries answered normally against the same space a few minutes later.
 *
 * Nothing failed. The queue was empty because the jobs were not in it yet, and an absent index status reads as
 * ready. Both are the same observation from outside: **"nothing outstanding" cannot tell finished from not
 * started.**
 *
 * ## Why a big corpus hides it, which is the part that makes it dangerous
 *
 * The rungs that wrote 419 and 186 records took a minute of ingest, so the index was live long before anyone
 * asked. The bug appears only on the FAST rung — the one whose ingest is cheapest, and therefore the one most
 * likely to be re-run alone while iterating. A harness that is reliable when it is slow and wrong when it is
 * quick will produce its wrong number on exactly the runs nobody is being careful about.
 *
 * ## What the fix has to be
 *
 * Not a longer wait, and not more polls — both are still the same proxy. The wait asks the thing itself: does
 * a recall against this space return anything at all? That is the property the harness depends on, and it is
 * the only one that cannot be true-by-accident here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeYthril } from '../../benchmarks/writer/ythril-client.mjs';

/**
 * Stand in for the instance.
 *
 * `recallEmptyFor` is how many recalls answer with nothing before the index comes alive — the race, made
 * deterministic. Everything else answers as a healthy instance does from the first request: the queue is
 * empty, the index is ready, the space holds records.
 */
function fakeInstance({ recallEmptyFor = 0, memories = 35 } = {}) {
  const calls = { recall: 0, queue: 0, stats: 0 };
  const json = body => new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  });

  return {
    calls,
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      if (path === '/api/spaces') return json({ spaces: [{ id: 'bench-x', indexStatus: 'ready' }] });
      if (path.endsWith('/embedding-queue/records')) {
        calls.queue++;
        return json({ counts: { pending: 0, processing: 0, failed: 0 }, jobs: [] });
      }
      if (path.endsWith('/stats')) {
        calls.stats++;
        return json({ memories, entities: 0, edges: 0, chrono: 0, files: 0 });
      }
      if (path.endsWith('/recall')) {
        calls.recall++;
        const empty = calls.recall <= recallEmptyFor;
        return json({ results: empty ? [] : [{ _id: 'r1', fact: 'something', score: 0.5 }] });
      }
      throw new Error(`the fake instance was asked for ${init?.method ?? 'GET'} ${path}, which this test `
        + 'does not model — if the harness now needs it, model it rather than loosening the assertion');
    },
  };
}

/** Swap in a fake `fetch` for one call and always put the real one back. */
async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const client = () => makeYthril({ baseUrl: 'http://fake.invalid', token: 'ythril_test' });

test('an empty queue over a space that answers nothing is NOT ready', async () => {
  const instance = fakeInstance({ recallEmptyFor: 2 });
  await withFetch(instance.fetch, () =>
    client().waitForEmbeddings('bench-x', { timeoutMs: 20_000, pollMs: 10 }));

  assert.ok(instance.calls.recall >= 3,
    `the wait probed recall ${instance.calls.recall} time(s). It must keep waiting while recall answers `
    + 'nothing — returning on the empty queue alone is what scored a whole rung at 0.0%');
});

test('a space that answers immediately is not made to wait', async () => {
  const instance = fakeInstance({ recallEmptyFor: 0 });
  const started = Date.now();
  await withFetch(instance.fetch, () =>
    client().waitForEmbeddings('bench-x', { timeoutMs: 20_000, pollMs: 10 }));

  assert.equal(instance.calls.recall, 1,
    'a healthy space should cost exactly one probe; more means the check re-runs for no reason and adds '
    + 'its cost to every conversation of every rung');
  assert.ok(Date.now() - started < 5_000, 'the probe must not introduce a fixed delay');
});

test('an EMPTY space is ready, rather than waiting for something that will never arrive', async () => {
  /*
   * A space holding nothing can never return a result, so probing it would spin to the timeout and fail a
   * run for a rung that legitimately wrote no records. The probe answers the question "is what is here
   * findable", and for an empty space the honest answer is yes, vacuously.
   */
  const instance = fakeInstance({ recallEmptyFor: 99, memories: 0 });
  await withFetch(instance.fetch, () =>
    client().waitForEmbeddings('bench-x', { timeoutMs: 3_000, pollMs: 10 }));

  assert.equal(instance.calls.recall, 0, 'an empty space must not be probed at all');
});

test('the probe never carries a benchmark question', async () => {
  /*
   * Nothing in the ingest or readiness path may see a question — the same rule `ingest/` is gated on. A probe
   * built from a question would also make "is this space ready" depend on which question came first, so the
   * answer would differ between two runs over identical corpora.
   */
  const seen = [];
  const instance = fakeInstance({ recallEmptyFor: 0 });
  const spy = async (url, init) => {
    if (new URL(url).pathname.endsWith('/recall') && init?.body) seen.push(JSON.parse(init.body).query);
    return instance.fetch(url, init);
  };
  await withFetch(spy, () => client().waitForEmbeddings('bench-x', { timeoutMs: 20_000, pollMs: 10 }));

  assert.equal(seen.length, 1);
  assert.ok(seen[0].length <= 16 && !seen[0].includes('?'),
    `the readiness probe asked "${seen[0]}", which looks like a real question rather than a fixed neutral `
    + 'string');
});
