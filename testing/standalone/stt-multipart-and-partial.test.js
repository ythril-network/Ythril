/**
 * External speech-to-text sends real multipart, and a failed chunk never reports success.
 *
 * ## Bug 1 — the request was not multipart at all
 *
 * External STT had never worked. `WhisperProvider` builds `new FormData()` — the **global**, which in
 * Node is the built-in undici — and hands it to `ssrfSafeFetch`, which imports `fetch` from the **undici
 * npm package**. Two realms, so undici's internal `instanceof FormData` fails, the body falls through to
 * the generic branch, and `String(body)` puts the literal text `[object FormData]` on the wire under
 * `Content-Type: text/plain;charset=UTF-8`.
 *
 * The reporter's diagnosis is what pinned it: their OpenAI-conformant adapter uses multer `.single('file')`
 * and saw `req.file` undefined **without** `LIMIT_UNEXPECTED_FILE` — the signature of a request that was
 * not multipart at all, rather than multipart under a different field name. Two copies of undici are
 * installed (7.22.0 hoisted, 7.29.0 nested), so the realms were never going to line up.
 *
 * Fixed at the choke point rather than in the provider: importing undici's own `FormData` there would fix
 * one caller and leave the landmine for the next, in a file with no reason to know which fetch
 * implementation its transport uses. Detection is by `Object.prototype.toString`, never `instanceof` —
 * for exactly the reason the bug exists.
 *
 * ## Bug 2 — a failed chunk still reported the job complete
 *
 *     [WARN] Audio embedder: chunk 0 of <file>.ogg failed: Whisper HTTP 400
 *     [INFO] Media worker: completed audio job test/<file>.ogg (complete)
 *
 * `embedAudio` caught per-chunk failures, logged, continued, and returned only the successes — with no
 * count. The worker discarded the value and hardcoded `complete`. The DOCUMENT path already models this
 * correctly with a `partial` status and a comment explaining why; audio simply never carried the number.
 *
 * Run: node --test testing/standalone/stt-multipart-and-partial.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { blockAfter } from './_structural-window.mjs';

const { ssrfSafeFetch } = await import('../../server/dist/util/ssrf.js');

/**
 * The transport under test must be **undici's** fetch, not the global one.
 *
 * This is the whole bug and it is easy to test past. The global `fetch` IS Node's built-in undici, so it
 * recognises a global `FormData` and serialises it perfectly — a test injecting the global transport
 * passes whether or not the fix is present. Mutation testing caught exactly that: removing the
 * normaliser, and swapping the cross-realm check back to `instanceof`, both SURVIVED against a global
 * `fetchImpl`.
 *
 * `ssrf.ts` imports `fetch` from the undici *package*, which is a different realm from the globals the
 * providers build their bodies with. Injecting that same package fetch reproduces the realm mismatch
 * faithfully while still letting the test point the socket at a local listener.
 */
const { fetch: undiciFetch } = await import('undici');

// ── Bug 1: what actually reaches the wire ────────────────────────────────────

describe('a FormData body arrives as multipart, not as text', () => {
  let server, local, port, received;

  before(async () => {
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        received = {
          contentType: req.headers['content-type'] ?? '',
          auth: req.headers['authorization'] ?? '',
          body: Buffer.concat(chunks).toString('latin1'),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"text":"ok"}');
      });
    });
    local = await listenOnLoopback(server);
    port = local.port;
  });

  after(() => local.close());

  /**
   * Loopback is a crown-jewel address and is refused BEFORE any transport runs — correctly, and not what
   * this test is about. So the guard is handed a hostname resolving to a routable address (its check
   * passes) while the injected transport connects to the local listener.
   */
  const send = async (form) => {
    await ssrfSafeFetch('http://stt.example.test/v1/audio/transcriptions', {
      method: 'POST', body: form, headers: { Authorization: 'Bearer k' },
    }, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      // undici's fetch — see the note above. A global fetch here would pass without the fix.
      fetchImpl: (u, i) => undiciFetch(String(u).replace('http://stt.example.test', `http://127.0.0.1:${port}`), i),
    });
    return received;
  };

  const audioForm = () => {
    // Exactly what WhisperProvider builds — the GLOBAL FormData and Blob, which is the whole point.
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4])], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', 'base');
    form.append('response_format', 'verbose_json');
    return form;
  };

  it('the Content-Type is multipart with a boundary', async () => {
    const r = await send(audioForm());
    assert.match(r.contentType, /^multipart\/form-data; boundary=.+/);
  });

  it('the literal string "[object FormData]" never reaches the wire', async () => {
    // The exact symptom. If this ever reappears, external STT is silently broken again.
    const r = await send(audioForm());
    assert.doesNotMatch(r.body, /\[object FormData\]/);
    assert.doesNotMatch(r.contentType, /text\/plain/);
  });

  it('the file part carries its field name and filename', async () => {
    // multer `.single('file')` matches on the field name; the endpoint validates the extension.
    const r = await send(audioForm());
    assert.match(r.body, /Content-Disposition: form-data; name="file"; filename="audio\.wav"/);
  });

  it('the blob keeps its own content type', async () => {
    const r = await send(audioForm());
    assert.match(r.body, /Content-Type: audio\/wav/);
  });

  it('plain text fields survive alongside the file', async () => {
    const r = await send(audioForm());
    assert.match(r.body, /name="model"[\s\S]*?base/);
    assert.match(r.body, /name="response_format"[\s\S]*?verbose_json/);
  });

  it('the boundary in the header is the one used in the body', async () => {
    // A mismatch parses as zero parts, which looks exactly like the original bug.
    const r = await send(audioForm());
    const boundary = /boundary=(.+)$/.exec(r.contentType)[1];
    assert.ok(r.body.startsWith(`--${boundary}\r\n`), 'body must open with the declared boundary');
    assert.ok(r.body.trimEnd().endsWith(`--${boundary}--`), 'body must close with the terminator');
  });

  it('caller headers are preserved', async () => {
    const r = await send(audioForm());
    assert.equal(r.auth, 'Bearer k');
  });

  it('a non-FormData body is passed through untouched', async () => {
    const r = await send(JSON.stringify({ hello: 'world' }));
    assert.equal(r.body, '{"hello":"world"}');
    assert.doesNotMatch(r.contentType, /multipart/);
  });
});

// ── Bug 2: the status a failed chunk produces ────────────────────────────────

describe('a failed chunk is never reported as complete', () => {
  const strip = s => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const audio = strip(readFileSync('server/src/files/media/audio-embedder.ts', 'utf8'));
  const worker = strip(readFileSync('server/src/files/media/worker.ts', 'utf8'));
  const video = strip(readFileSync('server/src/files/media/video-embedder.ts', 'utf8'));

  it('embedAudio counts failures instead of swallowing them', () => {
    assert.match(audio, /failed\+\+/);
    assert.match(audio, /return \{ records: results, failed, total: chunks\.length \}/);
  });

  it('all-chunks-failed throws, so the job retries instead of reporting success', () => {
    // The reporter's case: every chunk 400'd and the job still said complete. Throwing puts it back on
    // the retry/backoff path, which is what a systemic cause (bad request shape) needs.
    assert.match(audio, /failed === chunks\.length/);
    assert.match(audio, /throw new Error\(`every audio chunk failed to transcribe/);
  });

  it('the worker records partial when any chunk failed', () => {
    // A WINDOW, converted: the subject is the branch, bounded by its own brace. A cap cannot tell "the status
    // is set INSIDE the branch" from "it is set 120 characters after it" — and those are opposite behaviours:
    // one marks a file partial when a chunk failed, the other marks every file partial.
    const at = worker.indexOf('if (a.failed > 0)');
    assert.ok(at > -1, 'the audio-failure branch is gone — re-anchor this gate');
    assert.match(blockAfter(worker, at, 'the audio partial branch'), /fileEmbeddingStatus = 'partial'/);
  });

  it('and does the same for video, whose audio can partly fail', () => {
    // Same conversion as the audio branch above, for the same reason.
    const at = worker.indexOf('if (v.audioFailed > 0)');
    assert.ok(at > -1, 'the video-audio-failure branch is gone — re-anchor this gate');
    assert.match(blockAfter(worker, at, 'the video partial branch'), /fileEmbeddingStatus = 'partial'/);
  });

  it('embedVideo propagates the audio outcome rather than returning void', () => {
    assert.match(video, /Promise<\{ audioFailed: number; audioTotal: number \}>/);
    assert.doesNotMatch(video, /^\s*return;\s*$/m);
  });

  it('and propagates the REAL count, not a placeholder', () => {
    // Asserting only the return type let a mutation hardcode `audioFailed: 0` and survive — the shape
    // was pinned while the value was free.
    assert.match(video, /audioFailed: audioResult\.failed/);
    assert.match(video, /audioTotal: audioResult\.total/);
  });

  it('partial is a status the file-meta model already had', () => {
    // Not a new concept invented for this fix — the document path has used it all along, which is what
    // makes the audio omission an inconsistency rather than a missing feature.
    assert.match(worker, /'complete' \| 'partial'/);
  });
});
