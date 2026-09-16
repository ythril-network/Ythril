/**
 * A propagation timeout must be able to go and LOOK, and one test's timeout must say which side lost the record.
 *
 * ## Why this exists
 *
 * `Subscriber-local content survives publisher tombstone` fails intermittently in CI and has survived four rounds
 * of investigation, because its message — `waitFor timed out after 25000ms — sync triggers to A all succeeded (8)`
 * — cannot distinguish the only two things it can be: the sender never sent the record, or the receiver took it
 * and did not store it.
 *
 * Six local reproduction attempts (three isolated, one inside the full sync suite, two against a freshly rebuilt
 * cold stack) all passed at ~1.1 s against the 25 s budget. So the failure is not reachable here and the NEXT CI
 * occurrence has to be the one that answers it.
 *
 * ## The two regressions this pins, both silent
 *
 * 1. **`waitFor` must AWAIT its diagnose.** It used to call it synchronously, which limited every caller to facts
 *    already in hand — and a diagnostic returning a promise interpolated as `[object Promise]`. Nothing would
 *    fail; the message would just be useless, on the one run that mattered.
 * 2. **A diagnostic must never replace the timeout it is describing.** `onTimeout` does two HTTP requests, either
 *    of which can fail for its own reasons. An unswallowed throw there would surface as the diagnostic's error
 *    instead of the real timeout — strictly worse than no diagnostic at all.
 *
 * Both are exercised, not grepped: `waitFor` takes a plain condition function, so it needs no database.
 *
 * Run: node --test testing/standalone/a-timeout-says-which-side-lost-it.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { waitFor } from '../sync/helpers.js';

const never = async () => false;

describe('waitFor can be given a diagnostic that goes and looks', () => {
  it('awaits an async diagnose instead of interpolating a promise', async () => {
    await assert.rejects(
      () => waitFor(never, 30, 10, async () => {
        await new Promise(r => setTimeout(r, 5));
        return 'the sender holds it at seq 42';
      }),
      (err) => {
        assert.match(err.message, /the sender holds it at seq 42/,
          `the resolved value must reach the message, got: ${err.message}`);
        assert.doesNotMatch(err.message, /\[object Promise\]/,
          'a promise reached the message verbatim — diagnose is being called without await');
        return true;
      });
  });

  it('still accepts a synchronous diagnose, and a plain string', async () => {
    // The change must not have broken the twenty-odd existing callers that return a string directly.
    await assert.rejects(() => waitFor(never, 30, 10, () => 'sync detail'), /sync detail/);
    await assert.rejects(() => waitFor(never, 30, 10, 'literal detail'), /literal detail/);
  });

  it('and none at all', async () => {
    await assert.rejects(() => waitFor(never, 30, 10), /waitFor timed out after 30ms$/);
  });

  it('a condition that succeeds never calls the diagnostic', async () => {
    // It does two HTTP requests. Running it on the happy path would put them in every passing wait.
    let called = 0;
    await waitFor(async () => true, 100, 10, () => { called++; return 'x'; });
    assert.equal(called, 0, 'the diagnostic must only run on a timeout');
  });
});

describe('the failing test asks which side lost the record', () => {
  const helpers = stripComments(readFileSync('testing/sync/helpers.js', 'utf8'));
  const pubsub = stripComments(readFileSync('testing/sync/pubsub-topology.test.js', 'utf8'));

  it('syncUntil threads onTimeout through and SWALLOWS its failures', () => {
    assert.match(helpers, /onTimeout \} = \{\}\)/, 'syncUntil must accept an onTimeout hook');
    assert.match(helpers, /try \{ extra = \(await onTimeout\(\)\) \?\? ''; \} catch \(e\) \{ extra = `diagnostic failed/,
      'a throwing diagnostic must degrade to a note, never replace the timeout it describes');
  });

  it('the diagnostic reads the watermark from an endpoint that already exposes it', () => {
    // `GET /api/networks/:id` returns each member minus the token hash, so `lastSeqPushed` is already readable by
    // an admin token. No server change was needed, and none should be introduced for a test diagnostic.
    assert.match(helpers, /api\/networks\/\$\{networkId\}/);
    assert.match(helpers, /lastSeqPushed\?\.\[spaceId\]/);
    assert.match(helpers, /lastSeqReceived\?\.\[spaceId\]/);
  });

  it('and reports all three outcomes, because two of them are not sync bugs at all', () => {
    /*
     * "The sender does not have it" means the WRITE failed. "A watermark passed it" means it was marked sent and
     * never will be again. "No watermark reached it" means the sender should still be offering it, so the loss is
     * on the wire or at the receiver. A diagnostic that only reported the third would misattribute the other two.
     */
    assert.match(helpers, /the SENDER HOLDS/);
    assert.match(helpers, /marked sent and never will be again/);
    assert.match(helpers, /lost on the wire or discarded/);
  });

  it('EXERCISED against a stub: each branch is reachable, not merely present', async () => {
    /*
     * The first version of this asserted only that the strings appear in the source, and mutation testing walked
     * straight through it: replacing the condition with `if (false)` left every string in place and the gate
     * green. A branch that is mentioned is not a branch that runs.
     *
     * A four-line stub server is enough — the diagnostic's whole job is to read two endpoints and say what they
     * mean, so a stub that answers them exercises every branch with no stack and no database.
     */
    const { createServer } = await import('node:http');
    const { whichSideLostIt } = await import('../sync/helpers.js');

    const serve = (routes) => new Promise((resolve) => {
      const srv = createServer((req, res) => {
        const hit = Object.entries(routes).find(([p]) => req.url.startsWith(p));
        res.writeHead(hit ? 200 : 404, { 'content-type': 'application/json' });
        res.end(JSON.stringify(hit ? hit[1] : { error: 'not found' }));
      });
      srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
    });

    // 1. The sender does not hold the record at all.
    let s = await serve({});
    try {
      assert.match(await whichSideLostIt(s.url, 't', 'net', 'sp', 'rec'),
        /the SENDER does not have rec either \(404\) — the write, not sync/);
    } finally { s.srv.close(); }

    // 2. It holds it, and a watermark is already at or past its seq.
    s = await serve({
      '/api/brain/spaces/sp/facts/rec': { _id: 'rec', seq: 7 },
      '/api/networks/net': { members: [{ label: 'B', lastSeqPushed: { sp: 7 }, lastSeqReceived: {} }] },
    });
    try {
      const msg = await whichSideLostIt(s.url, 't', 'net', 'sp', 'rec');
      assert.match(msg, /the SENDER HOLDS rec at seq 7/);
      assert.match(msg, /pushed=7 received=unset/);
      assert.match(msg, /AT OR PAST that seq/);
    } finally { s.srv.close(); }

    // 3. It holds it and no watermark reached it — the loss is downstream.
    s = await serve({
      '/api/brain/spaces/sp/facts/rec': { _id: 'rec', seq: 9 },
      '/api/networks/net': { members: [{ label: 'B', lastSeqPushed: { sp: 4 }, lastSeqReceived: {} }] },
    });
    try {
      const msg = await whichSideLostIt(s.url, 't', 'net', 'sp', 'rec');
      assert.match(msg, /no watermark reached that seq/);
      assert.match(msg, /lost on the wire or discarded/);
    } finally { s.srv.close(); }

    // 4. It holds it but the network cannot be read — informative, and it must not throw.
    s = await serve({ '/api/brain/spaces/sp/facts/rec': { _id: 'rec', seq: 3 } });
    try {
      assert.match(await whichSideLostIt(s.url, 't', 'net', 'sp', 'rec'),
        /sender holds rec at seq 3; could not read the network \(404\)/);
    } finally { s.srv.close(); }
  });

  it('the ARRIVAL wait gets it and the TOMBSTONE wait does not', () => {
    /*
     * On the tombstone wait the record is expected to be GONE from the receiver, so "does the sender still have
     * it" means the opposite and the message would mislead. Gated on the condition rather than on the presence of
     * the hook, because attaching it to both is the mistake that reads as thoroughness.
     */
    assert.match(pubsub, /expectStatus === 200\s*\n?\s*\? \{ onTimeout:/,
      'the diagnostic must be attached only to the arrival wait');
    assert.match(pubsub, /whichSideLostIt\(INSTANCES\.a, tokenA, networkId, testSpaceId, memId\)/);
  });
});
