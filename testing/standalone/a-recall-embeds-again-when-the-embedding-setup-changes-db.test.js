/**
 * A kept query vector is used only for the embedding setup that made it: another model, another endpoint, or another task prefix embeds the
 * text again (bundle-378, Q-976, fix round A: R5).
 *
 * ## The rule
 *
 * Ranking one model's vectors against another's returns plausible results in the wrong order, so a vector kept for a text is reused only while
 * the model, the endpoint it is computed at and the PREPARED text (the task prefix the scheme adds) are what they were. The key is built in
 * `recall.ts` (`embedQuery`), from the same `prepareInput` the model call uses. The earlier spec of this was a grep of the source for
 * `embedQuery(query)`, which stayed green when `model`, `endpoint` or `prepareInput` was taken out of the key; this one drives a recall:
 *
 *  1. the same caller, text and setup: one model call;
 *  2. the configured model changed: the text is embedded again;
 *  3. the endpoint changed: the text is embedded again, at the new endpoint;
 *  4. the prefix scheme changed (so the prepared text is another): the text is embedded again, as another string.
 *
 * ## Seen red
 *
 * Not red on f91569511: the key already holds all three, and this guards it. Each case was seen red by taking its part out of the key
 * (`model`, `endpoint`, `prepareInput(...)` replaced by the raw text) before it was committed.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-recall-embeds-again-when-the-embedding-setup-changes-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRecallCaller, adminRights, startCountingEmbedder } from './_recall-caller.mjs';

const skip = await mongoSkipReason();
const S = 'rsc-space';
const TEXT = 'rsc-setup-probe-text';

let r, admin, second;

describe('a kept query vector is used only for the setup that made it', { skip }, () => {
  before(async () => {
    r = await openRecallCaller({ suite: 'rsc', spaces: { [S]: [{ id: 'rsc-a', deg: 10, text: 'gear lever' }] } });
    admin = await adminRights();
    second = await startCountingEmbedder();
    process.env['EMBEDDING_URL'] = r.embedder.url;
  });
  after(async () => {
    delete process.env['EMBEDDING_MODEL'];
    delete process.env['EMBEDDING_PREFIX_SCHEME'];
    await second?.close();
    await r?.close();
  });

  const recallText = async () => {
    const out = await r.recallAs('tok-s', admin, { space: S, query: TEXT });
    assert.equal(out.failed, false, out.text.slice(0, 300));
  };

  it('the same setup embeds the text once', async () => {
    await recallText();
    await recallText();
    assert.equal(r.embedder.inputs.length, 1, `two recalls under one setup made ${r.embedder.inputs.length} model calls`);
  });

  it('another configured model embeds the text again', async () => {
    process.env['EMBEDDING_MODEL'] = 'rsc-another-model';
    try {
      await recallText();
      assert.equal(r.embedder.inputs.length, 2, 'a vector made by another model was reused');
      await recallText();
      assert.equal(r.embedder.inputs.length, 2, 'the new model\'s own vector was not kept');
    } finally { delete process.env['EMBEDDING_MODEL']; }
  });

  it('another endpoint embeds the text again, at that endpoint', async () => {
    const before = r.embedder.inputs.length;
    process.env['EMBEDDING_URL'] = second.url;
    try {
      await recallText();
      assert.equal(second.inputs.length, 1, 'a vector made at another endpoint was reused');
      assert.equal(r.embedder.inputs.length, before, 'the first endpoint was asked again');
    } finally { process.env['EMBEDDING_URL'] = r.embedder.url; }
  });

  it('another task prefix embeds the text again, as another string', async () => {
    const before = r.embedder.inputs.length;
    process.env['EMBEDDING_PREFIX_SCHEME'] = 'qwen';
    try {
      await recallText();
      assert.equal(r.embedder.inputs.length, before + 1, 'a vector prepared with another prefix was reused');
      assert.notEqual(r.embedder.inputs.at(-1), r.embedder.inputs[0], 'the prepared text did not change with the scheme, so the case proves nothing');
    } finally { delete process.env['EMBEDDING_PREFIX_SCHEME']; }
  });
});
