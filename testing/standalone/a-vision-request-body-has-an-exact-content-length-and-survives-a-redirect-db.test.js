/**
 * What the vision provider puts on the WIRE for an image: an exact `Content-Length`, the file's own bytes, and the same request
 * after a redirect (bundle-89, Q-425 part 8, plan E5 item 7).
 *
 * ## Why this is the rule and not "the body streams"
 *
 * The plan stops building the image's base64 JSON in memory: the body becomes a prefix, a base64 transform over the stored file,
 * and a suffix. A stream of unknown length goes out `Transfer-Encoding: chunked`, and a real OpenAI-compatible provider, a proxy
 * in front of one, or llama.cpp's server may refuse a chunked upload outright. A stub server accepts anything, so "the stub
 * accepted it" proves nothing (`check-i-testing-mock-hides-nothing`). What a provider sees, and what this asserts, is the HEADER:
 *
 *  1. **`Content-Length` is present, there is no `Transfer-Encoding`, and the length is exactly the bytes that arrived**;
 *  2. **it is exact in the file's size**: the growth between two files is the growth of their base64 (`4 x ceil(n / 3)`), so the
 *     fixed prefix and suffix are constant and the length is computed, not guessed;
 *  3. **the payload is the file**: the base64 in the request decodes to the stored bytes (the request says what was stored, on both
 *     the Ollama wire and the OpenAI-compatible one, whose body is a different shape);
 *  4. **after a 307 the second hop gets the same bytes, the same length and the same `Authorization`** (an external provider goes
 *     through `ssrfSafeFetch`, which re-sends its body on every hop: today's behaviour, now stated, and the thing a one-shot stream
 *     would break; `ssrf-safe-fetch-replays-its-body-on-every-redirect-hop.test.js` holds the module half).
 *
 * ## Seen red
 *
 * **Every row here is a GUARD row: it holds on the unchanged code**, where the body is one string and `fetch` computes an exact
 * length for it. They are the rows a streamed body can break: a missing `Content-Length`, a length that is the JSON's and not the
 * stream's, a stream consumed by the first hop. Rows that go red on the unchanged code are the memory pin and the scratch-copy test.
 *
 * Run: node --test testing/standalone/a-vision-request-body-has-an-exact-content-length-and-survives-a-redirect-db.test.js
 * (requires a prior `npm run build:server`, the test MongoDB and a non-loopback IPv4 address)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason, privateHostAddress } from './_private-address.mjs';
import { openMediaJobDoor } from './_media-job-door.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

/** A server that records every request whole and answers with `respond(req, n)`. `host` binds a LAN address for the external provider. */
async function recordingServer(respond, host) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', c => parts.push(c));
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(parts) });
      respond(req, res, requests.length);
    });
  });
  if (!host) return { requests, ...(await listenOnLoopback(server)) };
  // own-listener: binds a LAN address, because the SSRF guard an external provider goes through blocks loopback
  await new Promise(resolve => server.listen(0, host, resolve));
  const { port } = server.address();
  return { requests, url: `http://${host}:${port}`, close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

const json = (res, body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

/** The base64 payload of a captured request, on whichever wire it was. */
function payloadOf(request) {
  const body = JSON.parse(request.body.toString('utf8'));
  const url = body.messages?.[0]?.content?.[1]?.image_url?.url;   // OpenAI-compatible: a data URL
  if (url) return url.slice(url.indexOf('base64,') + 'base64,'.length);
  return body.messages[0].images[0];                              // Ollama: the bare base64
}

/** Exactly what a request must say about itself. */
function assertExactLength(request, label) {
  assert.equal(request.headers['transfer-encoding'], undefined, `${label}: the body went out chunked, which a provider may refuse`);
  assert.ok(request.headers['content-length'], `${label}: no Content-Length`);
  assert.equal(Number(request.headers['content-length']), request.body.length, `${label}: Content-Length is not the number of bytes that arrived`);
}

const FILES = [crypto.randomBytes(100 * 1024), crypto.randomBytes(100 * 1024 + 1), crypto.randomBytes(100 * 1024 + 2)];
const b64len = (n) => 4 * Math.ceil(n / 3);

describe('what the vision provider puts on the wire for an image (real worker, real Mongo, a recording provider)', { skip }, () => {
  // ONE door for both providers: the door's config, Mongo layer and worker are process singletons, so the provider under test is
  // switched in config for the next case, as `_pull-door.mjs` does for its topologies.
  let door;
  const useProvider = (visionProvider, baseUrl) => {
    const cfg = door.loader.getConfig().mediaEmbedding;
    cfg.visionProvider = visionProvider;
    cfg.vision = { baseUrl, model: 'fake' };
    // A provider key is read from the environment or the secrets file, never from `config.json` (`loader.ts`, `VISION_API_KEY`).
    if (visionProvider === 'external') process.env['VISION_API_KEY'] = 'sk-b89e5'; else delete process.env['VISION_API_KEY'];
  };
  before(async () => { door = await openMediaJobDoor({ suite: 'b89e5wire' }); });
  after(async () => { await door?.close(); });

  describe('local (Ollama wire, plain fetch, loopback)', () => {
    let provider;
    before(async () => {
      provider = await recordingServer((req, res) => json(res, { message: { content: 'a caption' } }));
      useProvider('local', provider.url);
    });
    after(async () => { await provider?.close(); });

    it('GUARD: Content-Length is exact, grows exactly with the base64, and the payload decodes to the file', async () => {
      const lengths = [];
      for (const [i, bytes] of FILES.entries()) {
        const { job } = await door.runJob({ rel: `wire-${i}.png`, mime: 'image/png', mediaType: 'image', source: bytes });
        assert.equal(job?.status, 'complete', `fixture: the job did not complete: ${JSON.stringify(job)}`);
        const request = provider.requests.at(-1);
        assertExactLength(request, `file ${i}`);
        assert.ok(Buffer.from(payloadOf(request), 'base64').equals(bytes), `file ${i}: the request does not carry the stored bytes`);
        lengths.push(Number(request.headers['content-length']));
      }
      for (let i = 1; i < FILES.length; i++) {
        assert.equal(lengths[i] - lengths[0], b64len(FILES[i].length) - b64len(FILES[0].length),
          `file ${i}: the length does not grow by exactly the base64's growth, so the fixed parts are not constant`);
      }
    });
  });

  describe('external (OpenAI-compatible wire, ssrfSafeFetch, a LAN address)', () => {
    let target, hop1;
    before(async () => {
      const lan = privateHostAddress();
      target = await recordingServer((req, res) => json(res, { choices: [{ message: { content: 'a caption' } }] }), lan);
      hop1 = await recordingServer((req, res) => { res.writeHead(307, { Location: `${target.url}/redirected/chat/completions` }); res.end(); }, lan);
      useProvider('external', target.url);
      door.loader.getConfig().allowPrivateModelEndpointsBySlot = { vision: true };
    });
    after(async () => { await target?.close(); await hop1?.close(); });

    it('GUARD: Content-Length is exact and the payload decodes to the file', async () => {
      const bytes = FILES[1];
      const { job } = await door.runJob({ rel: 'wire-ext.png', mime: 'image/png', mediaType: 'image', source: bytes });
      assert.equal(job?.status, 'complete', `fixture: the job did not complete: ${JSON.stringify(job)}`);
      const request = target.requests.at(-1);
      assertExactLength(request, 'external');
      assert.ok(Buffer.from(payloadOf(request), 'base64').equals(bytes), 'the request does not carry the stored bytes');
    });

    it('GUARD: after a 307 the second hop receives the same bytes, the same Content-Length and the same Authorization', async () => {
      useProvider('external', hop1.url);   // a fresh worker per job rebuilds its providers from config
      const bytes = FILES[2];
      const before = target.requests.length;
      const { job } = await door.runJob({ rel: 'wire-redirect.png', mime: 'image/png', mediaType: 'image', source: bytes });
      assert.equal(job?.status, 'complete', `fixture: the job did not complete after the redirect: ${JSON.stringify(job)}`);
      assert.ok(hop1.requests.length >= 1, 'fixture: the first hop never received the request');
      const first = hop1.requests.at(-1);
      const second = target.requests[before];
      assert.ok(second, 'the redirect was not followed to the second hop');
      assert.equal(first.headers['authorization'], 'Bearer sk-b89e5', 'fixture: the FIRST hop carried no Authorization, so the second proves nothing');
      assert.ok(first.body.equals(second.body), `the second hop received ${second.body.length} bytes, the first ${first.body.length}: the body was not re-sent whole`);
      assertExactLength(second, 'the second hop');
      assert.ok(Buffer.from(payloadOf(second), 'base64').equals(bytes), 'the second hop does not carry the stored bytes');
      assert.equal(second.headers['authorization'], 'Bearer sk-b89e5', 'the redirect hop lost the Authorization header the first hop carried');
    });
  });
});
