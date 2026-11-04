/**
 * `embed()` never sends an HTTP embedder more than the ceiling, and cuts (and counts) an oversized input once per call (Q-699, bundle-237).
 *
 * ## The last guard
 *
 * The chunkers bound what the conversion makes. Everything else that reaches `embed()` on the HTTP path (a fact, an entity's text, a
 * search query, a media transcript) has no chunker, and an HTTP embedder REFUSES an input over its context with a 400 where the bundled
 * model truncates. So `embed()`'s HTTP branch cuts the prefixed input to `embedding.maxInputBytes` with `boundedPrefix`, announces it
 * through `warnOnce`, and counts it (`ythril_embed_input_cut_total{producer}`):
 *
 *  - what the stub endpoint RECEIVES is at most the ceiling in bytes, the task prefix included, a prefix of what was asked, never ending
 *    in half a character;
 *  - an input at the ceiling is sent untouched, one byte over is cut;
 *  - the cut and its count happen once per CALL: a 503 retry sends the same cut input again and does not count again (the cut sits
 *    outside the retry closure);
 *  - a short input is not counted.
 *
 * The embedder is the real `embed()` over a real local stub HTTP endpoint (`EMBEDDING_URL`), as in `a-rebuild-embeds-what-the-producer-embedded-db`.
 *
 * Red at the unchanged base: a 30,000-character input reaches the stub as 30,000 characters (30,017 with a prefix).
 *
 * Run: node --test testing/standalone/an-oversized-input-reaches-the-http-embedder-cut-once.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const DIMS = 4;
const CEILING = 6_000;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b237-http-cut-'));
const CONFIG_PATH = path.join(scratch, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
delete process.env['EMBEDDING_PREFIX_SCHEME'];

let server, local, loader, embedding, registry;
/** The inputs the stub received, and the statuses it answers with (shifted per request; empty = 200). */
let received = [];
let script = [];

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const configure = (embeddingBlock = {}) => {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    spaces: [{ id: 'general', label: 'General' }], networks: [], tokens: [], embedding: embeddingBlock,
  }, null, 2));
  loader.loadConfig();
};

/** The sum of one counter over all its label sets (the label values are the implementation's; the number of cuts is the rule). */
async function counterTotal(name) {
  const text = await registry.register.metrics();
  let total = 0;
  for (const m of text.matchAll(new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+([0-9.eE+-]+)$`, 'gm'))) total += Number(m[1]);
  return total;
}
const CUT_COUNTER = 'ythril_embed_input_cut_total';

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const input = JSON.parse(body).input;
      const status = script.shift() ?? 200;
      received.push(input);
      if (status !== 200) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `stub says ${status}` } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: Array.from({ length: DIMS }, (_, i) => (i + 1) / 10) }] }));
    });
  });
  local = await listenOnLoopback(server);
  process.env['EMBEDDING_URL'] = local.url;
  loader = await import('../../server/dist/config/loader.js');
  embedding = await import('../../server/dist/brain/embedding.js');
  registry = await import('../../server/dist/metrics/registry.js');
  configure();
});

after(async () => {
  await local?.close();
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
});

beforeEach(() => { received = []; script = []; configure(); });

describe('what an HTTP embedder is sent is at most the ceiling, in bytes, prefix included', () => {
  it('a 30,000-character input is cut to the ceiling, and the call still answers', async () => {
    const text = 'a'.repeat(30_000);
    const out = await embedding.embed(text);
    assert.equal(out.vector.length, DIMS);
    assert.equal(received.length, 1);
    assert.ok(bytes(received[0]) <= CEILING, `the stub received ${bytes(received[0])} bytes`);
    assert.ok(received[0].length > 5_000 && text.startsWith(received[0]), 'what is sent is the beginning of the input, not a sample or a stub of it');
  });

  it('an input of exactly the ceiling is sent untouched; one byte over is cut', async () => {
    await embedding.embed('b'.repeat(CEILING));
    assert.equal(received[0].length, CEILING, 'an input at the ceiling was cut');
    await embedding.embed('b'.repeat(CEILING + 1));
    assert.ok(bytes(received[1]) <= CEILING, `${bytes(received[1])} bytes sent for an input one byte over`);
  });

  it('the task prefix is counted: with the nomic scheme a 7,000-byte document is sent as at most 6,000 bytes including `search_document: `', async () => {
    configure({ prefixScheme: 'nomic' });
    await embedding.embed('c'.repeat(7_000), 'document');
    assert.ok(received[0].startsWith('search_document: '), 'the prefix is still there');
    assert.ok(bytes(received[0]) <= CEILING, `${bytes(received[0])} bytes sent, prefix included`);
    await embedding.embed('c'.repeat(7_000), 'query');
    assert.ok(received[1].startsWith('search_query: ') && bytes(received[1]) <= CEILING, `${bytes(received[1])} bytes sent for a query`);
  });

  it('counts bytes and keeps characters whole: 3,000 CJK characters are 9,000 bytes', async () => {
    const text = '漢'.repeat(3_000);
    await embedding.embed(text);
    assert.ok(bytes(received[0]) <= CEILING, `${bytes(received[0])} bytes sent`);
    assert.ok(!received[0].includes('�') && text.startsWith(received[0]), 'a character was cut in two');
    const emoji = '😀'.repeat(2_000);
    await embedding.embed(emoji);
    assert.ok(bytes(received[1]) <= CEILING && emoji.startsWith(received[1]), 'a surrogate pair was cut in two');
  });

  it('the ceiling is the setting: with embedding.maxInputBytes 1024 the stub receives at most 1,024 bytes', async () => {
    configure({ maxInputBytes: 1_024 });
    await embedding.embed('d'.repeat(5_000));
    assert.ok(bytes(received[0]) <= 1_024, `${bytes(received[0])} bytes sent with the ceiling at 1,024`);
  });
});

describe('the cut is announced and counted once per call', () => {
  it('an oversized input counts one cut; an input under the ceiling counts none', async () => {
    const before = await counterTotal(CUT_COUNTER);
    await embedding.embed('short');
    assert.equal(await counterTotal(CUT_COUNTER), before, 'a short input was counted as cut');
    await embedding.embed('e'.repeat(30_000));
    assert.equal(await counterTotal(CUT_COUNTER), before + 1, `${CUT_COUNTER} did not count the cut`);
  });

  it('a 503 retry sends the same cut input again and does not count again', async () => {
    script = [503];                      // the first answer is a busy endpoint; the retry gets 200
    const before = await counterTotal(CUT_COUNTER);
    await embedding.embed('f'.repeat(30_000));
    assert.equal(received.length, 2, 'the busy answer must have been retried once');
    assert.equal(received[0], received[1], 'the retry sent a different input');
    assert.ok(bytes(received[1]) <= CEILING);
    assert.equal(await counterTotal(CUT_COUNTER), before + 1, 'the cut was counted per attempt instead of per call');
  });
});
