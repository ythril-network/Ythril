/**
 * The extractors' generation client (`F-31`): the few steps that WRITE text — a claim's sentence (5.2), an
 * arc (5.8), an entity's description (4.10) — go to the assist model, and only once its host is consented to.
 * Everything a model judges goes to `decide()` instead; this is for what cannot be a choice.
 *
 * Run: node --test testing/standalone/the-extractor-generates-through-the-assist-model.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let pickGenerationBackend, generate, GenerationError, GenerationUnavailableError;
before(async () => {
  ({ pickGenerationBackend, generate, GenerationError, GenerationUnavailableError } = await import('../../server/dist/extractor/generate.js'));
});

// Consented for CONVERSATIONS: the claim writer sends turns, and a documents consent does not cover that (F-35).
const assist = { baseUrl: 'https://llm.example.com/v1', model: 'big', acknowledgedHostForConversations: 'llm.example.com', apiKey: 'k' };
const transport = (...replies) => {
  const calls = [];
  return { calls, sleep: async () => {}, post: async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const r = replies.shift();
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  } };
};
const reply = (content) => ({ body: { model: 'big-2', choices: [{ message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 3 } } });

describe('which model writes', () => {
  it('the assist model, once its host is consented to — and nothing otherwise', () => {
    assert.equal(pickGenerationBackend(assist)?.model, 'big');
    assert.equal(pickGenerationBackend({ ...assist, acknowledgedHostForConversations: 'x' }), null);
    assert.equal(pickGenerationBackend(undefined), null);
  });
  it('a consent given for DOCUMENTS does not send conversations', () => {
    const documentsOnly = { baseUrl: assist.baseUrl, model: assist.model, acknowledgedHost: 'llm.example.com' };
    assert.equal(pickGenerationBackend(documentsOnly), null);
  });
  it('refusing names the setting', () => {
    assert.match(new GenerationUnavailableError().message, /documentProcessing\.assistModel/);
    assert.match(new GenerationUnavailableError().message, /conversations/);
  });
});

describe('the call', () => {
  it('an OpenAI chat request at temperature 0, with the instructions as the system turn', async () => {
    const t = transport(reply('Ada adopted Luna on 9 May 2023.'));
    const r = await generate(pickGenerationBackend(assist), { system: 'Write one claim.', user: 'the exchange', maxTokens: 200 }, t);
    assert.equal(t.calls[0].url, 'https://llm.example.com/v1/chat/completions');
    assert.equal(t.calls[0].headers.Authorization, 'Bearer k');
    assert.equal(t.calls[0].body.temperature, 0);
    assert.equal(t.calls[0].body.max_tokens, 200);
    assert.deepEqual(t.calls[0].body.messages, [{ role: 'system', content: 'Write one claim.' }, { role: 'user', content: 'the exchange' }]);
    assert.equal(r.text, 'Ada adopted Luna on 9 May 2023.');
    assert.equal(r.model, 'big-2');
  });
  it('waits out a 429 through the same backoff the decision client uses', async () => {
    const t = transport({ status: 429 }, reply('ok'));
    assert.equal((await generate(pickGenerationBackend(assist), { system: 's', user: 'u' }, t)).text, 'ok');
    assert.equal(t.calls.length, 2);
  });
  it('an empty answer is an error, not an empty claim', async () => {
    await assert.rejects(generate(pickGenerationBackend(assist), { system: 's', user: 'u' }, transport(reply('   '))),
      (e) => e instanceof GenerationError && /empty/.test(e.message));
  });
});
