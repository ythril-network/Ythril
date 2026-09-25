/**
 * The assist slot can be a Claude model through the Claude API (`F-33.1`), and every assist caller reaches it through
 * ONE call module, `util/model-chat.ts`.
 *
 * Owner, 2026-09-25: *"assist models should be able to go for claude models/api as well if thats within tos and
 * possible"*. Within terms with an API key: the Claude API is the supported way for an application to call Claude. A
 * Claude.ai or Claude Code subscription credential is not, and nothing here accepts one.
 *
 * What the module has to get right, each of which a hand-written copy at one of the call sites would miss:
 * - the Messages API shape: `x-api-key` and `anthropic-version`, `system` at the top, images as base64 blocks;
 * - no `temperature` (current Claude models refuse sampling parameters);
 * - the reply's `input_tokens`/`output_tokens`, so the budget is charged what Claude actually reports;
 * - a 429 or 529 carried as its status, so `viaAssist` hands the call to the fallback;
 * - a refusal (`stop_reason: "refusal"`) marked as such, so the fallback answers without the primary cooling down;
 * - the caller's own transport, so the SSRF guard and the timeout still apply to every byte.
 *
 * Run: node --test testing/standalone/an-assist-call-speaks-the-claude-api.test.js  (requires a prior server build)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let chatOnce;
before(async () => { ({ chatOnce } = await import('../../server/dist/util/model-chat.js')); });

const ENDPOINT = { wire: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5', apiKey: 'sk-ant-test' };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const MESSAGE = {
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_reason: 'end_turn', stop_sequence: null,
  content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'there.' }],
  usage: { input_tokens: 12, output_tokens: 3 },
};

/** A transport that records what it was asked and answers `answer`. */
function transport(answer) {
  const calls = [];
  const post = async (url, init) => {
    calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return typeof answer === 'function' ? answer() : answer;
  };
  return { post, calls };
}

const request = { system: 'Be terse.', turns: [{ role: 'user', content: 'Say hello', images: ['aGVsbG8='] }], maxTokens: 400 };
const makeError = (message, status) => Object.assign(new Error(message), status === undefined ? {} : { status });

describe('a request to the Claude API', () => {
  it('goes through the caller\'s transport to /v1/messages with the API key and a version', async () => {
    const t = transport(reply(MESSAGE));
    await chatOnce(ENDPOINT, request, { post: t.post }, makeError);
    assert.equal(t.calls.length, 1);
    assert.match(t.calls[0].url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);
    assert.equal(t.calls[0].headers['x-api-key'], 'sk-ant-test');
    assert.ok(t.calls[0].headers['anthropic-version'], 'no anthropic-version header');
    assert.equal(t.calls[0].headers['authorization'], undefined, 'a Bearer token is not how the Claude API is called with a key');
  });

  it('carries the system prompt at the top, images as base64 blocks before the text, and no temperature', async () => {
    const t = transport(reply(MESSAGE));
    await chatOnce(ENDPOINT, request, { post: t.post }, makeError);
    const b = t.calls[0].body;
    assert.equal(b.model, 'claude-sonnet-5');
    assert.equal(b.system, 'Be terse.');
    assert.equal('temperature' in b, false);
    assert.ok(b.max_tokens >= 400);
    assert.deepEqual(b.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } });
    assert.deepEqual(b.messages[0].content.at(-1), { type: 'text', text: 'Say hello' });
  });

  it('asks for a JSON schema through output_config when the caller needs structured answers', async () => {
    const t = transport(reply({ ...MESSAGE, content: [{ type: 'text', text: '{"answers":{}}' }] }));
    const schema = { type: 'object', additionalProperties: false, required: ['answers'], properties: { answers: { type: 'object' } } };
    await chatOnce(ENDPOINT, { ...request, jsonSchema: { name: 'answers', schema } }, { post: t.post }, makeError);
    assert.deepEqual(t.calls[0].body.output_config?.format, { type: 'json_schema', schema });
  });
});

describe('the reply', () => {
  it('is the text of its text blocks, with the usage Claude reported', async () => {
    const r = await chatOnce(ENDPOINT, request, { post: transport(reply(MESSAGE)).post }, makeError);
    assert.equal(r.text, 'Hello there.');
    assert.deepEqual(r.usage, { input_tokens: 12, output_tokens: 3 });
    assert.equal(r.truncated, false);
    assert.equal(r.model, 'claude-sonnet-5');
  });

  it('a reply cut off at max_tokens says so', async () => {
    const r = await chatOnce(ENDPOINT, request, { post: transport(reply({ ...MESSAGE, stop_reason: 'max_tokens' })).post }, makeError);
    assert.equal(r.truncated, true);
  });

  it('a 429 and a 529 keep their status, which is what hands the call to the fallback', async () => {
    for (const status of [429, 529]) {
      const err = await chatOnce(ENDPOINT, request, { post: transport(reply({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, status)).post }, makeError)
        .then(() => null, e => e);
      assert.ok(err, `a ${status} did not throw`);
      assert.equal(err.status, status);
    }
  });

  it('a refusal is marked, so the fallback answers without the primary cooling down', async () => {
    const err = await chatOnce(ENDPOINT, request, { post: transport(reply({ ...MESSAGE, stop_reason: 'refusal', content: [] })).post }, makeError)
      .then(() => null, e => e);
    assert.ok(err, 'a refusal was returned as an answer');
    assert.equal(err.refused, true);
  });
});

describe('the OpenAI wire is unchanged', () => {
  it('still posts a chat completion with a Bearer key and reads choices[0]', async () => {
    const t = transport(reply({ model: 'big', choices: [{ message: { content: ' ok ' }, finish_reason: 'stop' }], usage: { total_tokens: 7 } }));
    const r = await chatOnce({ wire: 'openai', baseUrl: 'https://api.example.com/v1', model: 'big', apiKey: 'k' }, request, { post: t.post }, makeError);
    assert.match(t.calls[0].url, /\/chat\/completions$/);
    assert.equal(t.calls[0].headers['authorization'], 'Bearer k');
    assert.equal(t.calls[0].body.temperature, 0);
    assert.equal(r.text, ' ok ', 'the text as it came: whitespace in a transcription is content, and a caller trims');
    assert.deepEqual(r.usage, { total_tokens: 7 });
  });
});
