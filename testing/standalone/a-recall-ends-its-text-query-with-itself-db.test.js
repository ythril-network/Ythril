/**
 * A recall that fails, or has nothing to fuse, leaves no text query running, and its text query carries the recall's deadline (bundle-378,
 * Q-976, fix round A: R2, L2.3).
 *
 * ## The rule
 *
 * Recall sends its text (`$text`) queries when it begins, so the store runs them beside the embedding and the vector searches. A text query
 * has no other bound than the recall's, and the store scores every record that matches it whatever the limit (about 150 ms at BSBM 1 000, far
 * more on a large space). So:
 *
 *  1. the text query carries the recall's own deadline as `maxTimeMS`, never longer than the caller asked (`maxTimeMS` of the call, floored by
 *     the instance's budget), so a runaway text query ends with the recall's budget;
 *  2. a recall that fails before its fusion (the embedder refuses the query) ends its text query: the query's signal is aborted when the
 *     recall answers, so the store is not left scoring a space for a caller that has gone;
 *  3. a recall whose pool is empty, which never reads its text rankings, ends them the same way;
 *  4. ending a text query after the fusion has read it changes nothing: the recall still answers the records the text index finds.
 *
 * ## Seen red
 *
 * On f91569511 the text query is sent with no `maxTimeMS` and no `signal`: case 1 finds neither option on it, and cases 2 and 3 find no signal
 * to be aborted, so the text query runs to its end whatever became of the recall.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-recall-ends-its-text-query-with-itself-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRecallCaller, adminRights } from './_recall-caller.mjs';

const skip = await mongoSkipReason();
const S = 'rtq-space';
const E = 'rtq-empty';
/** The deadline the calls below ask for, and the margin the text query's deadline may sit under it (the time the recall spent before sending it). */
const ASKED_MS = 7_000;
const MARGIN_MS = 3_000;

let r, admin;

/** The text finds sent while `fn` runs. */
async function textFindsDuring(fn) {
  const from = r.textFinds.length;
  const answer = await fn();
  return { answer, finds: r.textFinds.slice(from) };
}

describe('a recall ends its text query with itself', { skip }, () => {
  before(async () => {
    r = await openRecallCaller({ suite: 'rtq', spaces: { [S]: [{ id: 'rtq-a', deg: 10, text: 'widget spring' }], [E]: [] } });
    admin = await adminRights();
  });
  after(async () => { await r?.close(); });

  it('the text query carries the recall\'s deadline as maxTimeMS', async () => {
    const { answer, finds } = await textFindsDuring(() => r.recallAs('tok-1', admin, { space: S, query: 'widget deadline probe', maxTimeMS: ASKED_MS }));
    assert.equal(answer.failed, false, answer.text.slice(0, 300));
    assert.ok(finds.length > 0, 'the recall sent no text query, so the case below proves nothing');
    for (const f of finds) {
      assert.equal(typeof f.options.maxTimeMS, 'number', `the text query on ${f.collection} carries no deadline: ${JSON.stringify(Object.keys(f.options))}`);
      assert.ok(f.options.maxTimeMS > ASKED_MS - MARGIN_MS && f.options.maxTimeMS <= ASKED_MS,
        `the text query's deadline is ${f.options.maxTimeMS} ms for a recall asked to end within ${ASKED_MS}`);
    }
  });

  it('a recall the embedder refuses ends its text query', async () => {
    // Through the tools the fan-out (`recallGlobal`) embeds before any per-space recall begins, so the order that matters is a direct recall's
    // (the ingest shortlist's): it sends its text queries first and embeds after.
    r.embedder.failing = true;
    try {
      const { finds } = await textFindsDuring(() => assert.rejects(r.recallDirect(S, 'widget refused probe')));
      assert.ok(finds.length > 0, 'the recall sent no text query before it failed, so the case below proves nothing');
      for (const f of finds) {
        assert.ok(f.options.signal, `the text query on ${f.collection} has no signal, so nothing can end it`);
        assert.equal(f.options.signal.aborted, true, 'the text query was left running after its recall failed');
      }
    } finally { r.embedder.failing = false; }
  });

  it('a recall with an empty pool ends the text query it never reads', async () => {
    const { answer, finds } = await textFindsDuring(() => r.recallAs('tok-3', admin, { space: E, query: 'widget empty probe' }));
    assert.equal(answer.failed, false, answer.text.slice(0, 300));
    assert.ok(finds.length > 0, 'the recall sent no text query, so the case below proves nothing');
    for (const f of finds) {
      assert.ok(f.options.signal, `the text query on ${f.collection} has no signal, so nothing can end it`);
      assert.equal(f.options.signal.aborted, true, 'the text query was left running although the recall had nothing to fuse it into');
    }
  });

  it('a recall that fuses its text query answers the record the text finds, and its query is not harmed by ending after the answer', async () => {
    const { answer } = await textFindsDuring(() => r.recallAs('tok-4', admin, { space: S, query: 'widget' }));
    assert.equal(answer.failed, false, answer.text.slice(0, 300));
    assert.ok(answer.text.includes('rtq-a'), `the record the fresh scan and the text index both find is answered: ${answer.text.slice(0, 300)}`);
  });
});
