/**
 * What a model endpoint says in its `error` field is quoted through the one renderer, at 200 characters (`Q-231`,
 * `Q-270`) — whatever shape the endpoint sent it in.
 *
 * ## The rule
 *
 * `util/model-chat.ts` reads an endpoint's reply and, when the reply says `error`, throws it as this module's own
 * failure — a sentence that reaches the extractor's retry log, the description worker's last-error and the assist
 * budget's refusal text. An endpoint is a value from outside this instance (an operator pointed at it, but its text is
 * its own), and the two wires that answer with a 200-and-`error` body — Ollama and the OpenAI-compatible wire — handled
 * the two shapes differently: a STRING error was quoted whole (a model server that echoes the prompt back is a megabyte
 * line), an OBJECT error was cut at 200 by a `.slice` that neither escapes nor says it cut. One renderer, `peerText`,
 * with the cap it was already held to: `peerText(j.error, { max: 200 })`.
 *
 * What is NOT here, because the same shape elsewhere is not part of this fix: `embedding.ts` and `media/providers.ts`
 * quote a model's error text too and are unfixed on main as well; they are filed for main, not carried.
 *
 * ## Pins (green on the base, kept)
 *
 * An ordinary short error is named exactly as before (`error: model not found`), on both wires; an object error stays
 * bounded.
 *
 * ## Seen red
 *
 * On 6eb5a333 (v5.6.3): a 5 000-character string error comes back whole on both wires, and a string error carrying
 * `\r\n` reaches the failure raw.
 *
 * Run: node --test testing/standalone/a-model-error-text-is-bounded-before-it-is-quoted.test.js  (requires a prior server build)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let chatOnce;
before(async () => { ({ chatOnce } = await import('../../server/dist/util/model-chat.js')); });

const WIRES = {
  ollama: { wire: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'llama-test' },
  openai: { wire: 'openai', baseUrl: 'http://127.0.0.1:8080', model: 'gpt-test', apiKey: 'sk-test' },
};
const request = { turns: [{ role: 'user', content: 'hello' }], maxTokens: 50 };
const answers = body => ({ post: async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }) });
const makeError = message => new Error(message);
const refused = async (wire, body) => {
  try { await chatOnce(WIRES[wire], request, answers(body), makeError); } catch (err) { return err.message; }
  assert.fail(`${wire}: an error body did not throw`);
};

/** The cap a model's error text is held to, plus room for the `error: ` lead and the `…(+N chars)` tail. */
const CAP = 200;
const ROOM = 'error: '.length + '…(+99999 chars)'.length;

for (const wire of Object.keys(WIRES)) {
  describe(`the ${wire} wire: an error body is quoted at ${CAP} characters`, () => {
    it('a long STRING error is cut, and says by how much', async () => {
      const message = await refused(wire, { error: 'x'.repeat(5_000) });
      assert.ok(message.length <= CAP + ROOM, `the failure carries ${message.length} characters of the endpoint's text`);
      assert.match(message, /…\(\+\d+ chars\)$/, 'the cut does not say it was made');
      assert.match(message, /^error: x{200}…/, 'the cut is not at the cap the object error was always held to');
    });

    it('a string error carrying CR LF reaches the failure escaped', async () => {
      const message = await refused(wire, { error: 'model failed\r\nFORGED [ERROR] line' });
      assert.doesNotMatch(message, /[\r\n]/, 'a line break from the endpoint reached the failure raw');
      assert.match(message, /model failed\\r\\nFORGED/);
    });

    it('PIN: an object error stays bounded', async () => {
      const message = await refused(wire, { error: { message: 'y'.repeat(5_000), code: 500 } });
      assert.ok(message.length <= CAP + ROOM, `the failure carries ${message.length} characters`);
    });

    it('PIN: an ordinary short error is named exactly as before', async () => {
      assert.equal(await refused(wire, { error: 'model not found' }), 'error: model not found');
    });
  });
}
