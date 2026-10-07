/**
 * The speech slot's probe and its inference call agree about `/v1`.
 *
 * ## What was wrong
 *
 * `WhisperProvider` built its URL by concatenation — `${base}/v1/audio/transcriptions` — while the probe
 * derives its URL through `normalizeOpenAiBase`. So the two disagreed for exactly one input, and it is the
 * input the documentation tells an operator to use:
 *
 *     baseUrl = https://api.openai.com/v1
 *       probe:     GET  /v1/models                     -> fine
 *       inference: POST /v1/v1/audio/transcriptions    -> 404
 *
 * That is #562's defect — probe and inference deriving different URLs from one base — still live in the
 * speech slot after every other OpenAI-compatible caller was moved onto the shared normaliser. It bites in
 * the dangerous direction: the dot is green and extraction silently produces nothing.
 *
 * The vision and assist slots require the `/v1` form, so an operator running one server for all three had
 * no spelling that satisfied all of them.
 *
 * ## What this pins
 *
 * One base URL, both spellings, one request path — asserted against the URL the provider actually puts on
 * the wire, and against the probe's own derivation so the two cannot drift apart again.
 *
 * Run: node --test testing/standalone/stt-transcription-url.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const { WhisperProvider } = await import('../../server/dist/files/media/providers.js');
const { listUrlFor, normalizeOpenAiBase } = await import('../../server/dist/files/converters/vlm-endpoint.js');

/** A minimal wav — the provider only needs bytes it can wrap in a Blob. */
const WAV = Buffer.alloc(64);

let server, local, base, requested;

before(async () => {
  server = http.createServer((req, res) => {
    requested.push(req.url ?? '');
    // Drain the multipart body; answering before the upload finishes can reset the connection.
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"text":"ok","segments":[]}');
    });
  });
  local = await listenOnLoopback(server);
  base = local.url;
});
after(() => local.close());

describe('the transcription URL', () => {
  it('is /v1/audio/transcriptions for a bare host', async () => {
    requested = [];
    const r = await new WhisperProvider({ baseUrl: base, model: 'base' }).transcribe(WAV, 'audio/wav');
    assert.equal(r.text, 'ok');
    assert.deepEqual(requested, ['/v1/audio/transcriptions']);
  });

  it('THE BUG: a base that already carries /v1 is not doubled', async () => {
    requested = [];
    await new WhisperProvider({ baseUrl: `${base}/v1`, model: 'base' }).transcribe(WAV, 'audio/wav');
    assert.deepEqual(requested, ['/v1/audio/transcriptions'],
      'the documented OpenAI base produced /v1/v1/audio/transcriptions and 404d, with a green dot above it');
  });

  it('a trailing slash changes nothing either', async () => {
    requested = [];
    await new WhisperProvider({ baseUrl: `${base}/v1/`, model: 'base' }).transcribe(WAV, 'audio/wav');
    assert.deepEqual(requested, ['/v1/audio/transcriptions']);
  });

  it('and the probe derives the SAME base the transcription call uses', () => {
    // The agreement is the point, not either URL on its own: a probe that normalises while inference
    // concatenates reports on an endpoint nobody is calling.
    for (const spelling of [base, `${base}/v1`, `${base}/v1/`]) {
      const listBase = listUrlFor('openai', spelling).replace(/\/models$/, '');
      assert.equal(listBase, normalizeOpenAiBase(spelling), `spelling: ${spelling}`);
    }
  });
});
