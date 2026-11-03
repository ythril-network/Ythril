/**
 * No upstream response body may be read without a size ceiling.
 *
 * ## The finding
 *
 * `boundedJson` was written in `files/media/providers.ts` with the risk stated correctly in a comment —
 * *"`fetch().json()` reads the entire body without limit → a hostile or runaway upstream could exhaust heap"* —
 * and then used at **three call sites, all inside that same file**. Twelve other `Response.json()` reads across
 * eight files were unbounded, including `files/converters/renderer.ts`, which reads rendered page images as
 * base64 strings and decodes each one, making it the largest JSON body the server handles.
 *
 * ## Why nobody noticed, which is the part this gate is really for
 *
 * **Every one of those call sites already had a timeout.** An audit sweep asked "is there a provider call with no
 * timeout?", found none, and moved on. A timeout bounds **duration**; it says nothing about **size**. A fast
 * upstream streaming gigabytes finishes well inside a 120-second budget.
 *
 * The realistic failure is **runaway, not hostile** — every upstream is operator-configured. `renderDpi` accepts
 * up to 600 and `maxPages` up to 2000 through the UI, so no bug and no attacker is needed.
 *
 * ## Sizing, checked rather than assumed
 *
 * The two untruncated error bodies do **not** reach an API client: the global error middleware in `app.ts`
 * returns a literal `'Internal server error'` and never `err.message`, and the four route handlers that do return
 * `err.message` wrap Mongo/config/keypair work that no upstream body can reach. So that half is a log-quality and
 * double-allocation problem, not an information leak — stated because the tracker entry had it filed as possibly
 * either, and guessing would have justified a larger change than the evidence supports.
 *
 * Run: node --test testing/standalone/upstream-reads-are-bounded.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { trackedSources } from './_sources.mjs';

const ROOT = process.cwd();
const HELPER = 'server/src/util/bounded-read.ts';

let mod;
before(async () => { mod = await import('../../server/dist/util/bounded-read.js'); });

/**
 * Every .ts under server/src that is part of the repo — tracked **and** untracked-but-not-ignored.
 *
 * A plain `git ls-files` cannot see a file added in the same change as the gate, so on its first run this
 * scan missed the very helper it points at. That is how it failed the first time it was run, and it is the
 * third time this repo has been bitten by treating `git ls-files` as "what files does this project have".
 *
 * `untracked: true` is that paragraph, said at the call. The default listing answers *"what does the
 * repository hold"*; this gate asks what is on disk right now. Both questions go through one module, so the
 * two gates needing the second one no longer each carry their own copy of the incantation — and the flag is
 * visible at the call site, which a copy never was.
 */
function sourceFiles() {
  return trackedSources('server/src', { untracked: true, floor: 50 });
}

/** Strip comments line-first so the gate cannot fire on the prose explaining it. */
function code(path) {
  return readFileSync(join(ROOT, path), 'utf8')
    .split(/\r?\n/)
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

describe('the gate: every upstream read goes through a bounded reader', () => {
  it('found a plausible number of files — the scan itself still works', () => {
    const files = sourceFiles();
    assert.ok(files.length > 50, `only ${files.length} source files found; the enumeration broke, not the code`);
    assert.ok(files.includes(HELPER), `${HELPER} is not tracked, so the helper this gate points at is missing`);
  });

  it('no Response.json() is called outside the helper', () => {
    const offenders = [];
    for (const f of sourceFiles()) {
      if (f === HELPER) continue;
      const src = code(f);
      // `.json()` on a fetch Response. Mongo/Express have no such method, so this pattern is specific.
      for (const m of src.matchAll(/\bawait\s+\w+\.json\(\)/g)) {
        offenders.push(`${f}: ${m[0]}`);
      }
    }
    assert.deepEqual(offenders, [], 'these read an entire upstream body into memory with no ceiling. A timeout '
      + 'does not help — it bounds duration, not size.\n  ' + offenders.join('\n  ')
      + "\n\nUse `boundedJson<T>(res, 'label')` from util/bounded-read.js.");
  });

  it('no error body is read by hand', () => {
    const offenders = [];
    for (const f of sourceFiles()) {
      if (f === HELPER) continue;
      const src = code(f);
      for (const m of src.matchAll(/\.text\(\)\s*\.catch\(/g)) offenders.push(`${f}: ${m[0]}`);
    }
    assert.deepEqual(offenders, [], 'these read an upstream error body unbounded. Five sites did this by hand and '
      + 'three truncated at 200 chars while two did not, so the truncation was drift rather than a decision.\n  '
      + offenders.join('\n  ') + '\n\nUse `boundedErrorText(res)`.');
  });

  it('and the helper is actually used, so the two checks above are not vacuous', () => {
    // A pattern that stopped matching would report zero offenders and pass while verifying nothing. The floor is
    // the other half of every enumeration gate in this repo.
    let jsonSites = 0;
    let textSites = 0;
    for (const f of sourceFiles()) {
      if (f === HELPER) continue;
      const src = code(f);
      jsonSites += (src.match(/boundedJson[<(]/g) ?? []).length;
      textSites += (src.match(/boundedErrorText\(/g) ?? []).length;
    }
    assert.ok(jsonSites >= 12, `only ${jsonSites} boundedJson call sites; 12 were routed, so some regressed`);
    assert.ok(textSites >= 5, `only ${textSites} boundedErrorText call sites; 5 were routed`);
  });
});

describe('the bounded JSON reader', () => {
  const jsonRes = (body, headers = {}) => new Response(body, {
    headers: { 'content-type': 'application/json', ...headers },
  });

  it('reads a normal body', async () => {
    const out = await mod.boundedJson(jsonRes(JSON.stringify({ ok: 1 })), 'test');
    assert.deepEqual(out, { ok: 1 });
  });

  it('refuses a declared-oversize body without reading it', async () => {
    const res = jsonRes('{}', { 'content-length': String(50 * 1024 * 1024) });
    await assert.rejects(
      () => mod.boundedJson(res, 'test', 1024),
      /too large: 52428800 bytes/,
      'content-length is the cheap check: an upstream that declares 50 MiB against a 1 KiB cap must be refused '
      + 'before a byte is read',
    );
  });

  it('aborts a body that exceeds the cap while streaming, even with no content-length', async () => {
    // The declared length is advisory and an upstream may omit or lie about it, so the streaming check is the
    // actual guard. Removing it leaves a hole that content-length alone cannot cover.
    const big = 'x'.repeat(4096);
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 8; i++) c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    await assert.rejects(
      () => mod.boundedJson(new Response(stream), 'test', 1024),
      /exceeded 1024 bytes/,
    );
  });

  it('names the source and the escape hatch in the error', async () => {
    // "response too large" with no source is an unactionable log line, and a cap with no documented override is
    // one an operator has to read our source to discover.
    await assert.rejects(
      () => mod.boundedJson(jsonRes('x'.repeat(5000)), 'doc-render sidecar', 100),
      (err) => {
        assert.match(err.message, /doc-render sidecar/, 'the error does not name which upstream');
        assert.match(err.message, /YTHRIL_MAX_UPSTREAM_RESPONSE_BYTES/, 'the error does not name the override');
        return true;
      },
    );
  });

  it('falls back to the default when the cap env var is malformed, never to unbounded', () => {
    // set-claim: malformed INPUTS -- ways an operator can typo an env var, each of which must resolve to
    // the default rather than to no bound at all.
    const saved = process.env.YTHRIL_MAX_UPSTREAM_RESPONSE_BYTES;
    try {
      // Asserted as a CHOICE, not an effect: a malformed value becoming Infinity and becoming 256 MiB both let a
      // small body through, so every effect-based assertion here passes either way.
      for (const bad of ['nonsense', '0', '-1', 'NaN', '']) {
        process.env.YTHRIL_MAX_UPSTREAM_RESPONSE_BYTES = bad;
        assert.equal(
          mod.maxUpstreamResponseBytes(), mod.DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES,
          `'${bad}' resolved to ${mod.maxUpstreamResponseBytes()} — a typo must not remove the bound`,
        );
      }
      process.env.YTHRIL_MAX_UPSTREAM_RESPONSE_BYTES = '4096';
      assert.equal(mod.maxUpstreamResponseBytes(), 4096, 'a deliberate override must still work');
    } finally {
      if (saved === undefined) delete process.env.YTHRIL_MAX_UPSTREAM_RESPONSE_BYTES;
      else process.env.YTHRIL_MAX_UPSTREAM_RESPONSE_BYTES = saved;
    }
  });
});

describe('the bounded error-body reader', () => {
  it('truncates and says so', async () => {
    const out = await mod.boundedErrorText(new Response('e'.repeat(5000)), 50);
    assert.equal(out.length, 50 + '… (truncated)'.length);
    assert.match(out, /truncated/, 'a silently truncated error body reads as a complete one');
  });

  it('returns a short body unchanged', async () => {
    assert.equal(await mod.boundedErrorText(new Response('upstream said no')), 'upstream said no');
  });

  it('never throws, because an error path that can fail replaces a diagnosable failure with a confusing one', async () => {
    const broken = new Response(new ReadableStream({
      start(c) { c.error(new Error('connection reset mid-error-body')); },
    }));
    assert.equal(await mod.boundedErrorText(broken), '', 'it threw, so the real upstream status is now lost');
  });
});

// ── Q-363: a model server's `error` field is bounded by ONE reader, not by each caller ─────────────────────────
//
// `boundedJson` bounds the BODY (256 MiB). A 1 MB `error.message` inside it passes that bound, and four callers put it
// whole into a thrown Error that reaches logs and caller answers, while `util/model-chat.ts` already cut the same text
// with `peerText(…, { max })`. The rule is the shape of the call: a caller that reads a model server's JSON and then
// reads `.error` of it goes through `boundedModelJson`, which owns that check, so no caller can drop the bound.

/** The text between the `<` at `from` and its matching `>`, or null when there is no type argument. */
function typeArgumentAt(src, from) {
  if (src[from] !== '<') return null;
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '<') depth++;
    else if (c === '>' && src[i - 1] !== '=') { depth--; if (depth === 0) return src.slice(from + 1, i); }
  }
  return null;
}

/**
 * Every `boundedJson` call in `src` whose result is read for an `error` — by its type argument naming an `error` member, or by
 * the variable it is assigned to being followed by `.error` within the next lines. Returns the offending call heads.
 */
function boundedJsonReadsForError(src) {
  const found = [];
  for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*await\s+boundedJson\b/g)) {
    const name = m[1];
    const afterName = m.index + m[0].length;
    const typeArg = typeArgumentAt(src, afterName);
    const tail = src.slice(afterName, afterName + 1500).split('\n').slice(0, 12).join('\n');
    const typed = typeArg !== null && /\berror\s*\??\s*:/.test(typeArg);
    const used = new RegExp(`\\b${name}\\.error\\b`).test(tail);
    if (typed || used) found.push(`${name} = await boundedJson…`);
  }
  return found;
}

describe('Q-363 the gate: a model server\'s JSON is read through boundedModelJson', () => {
  it('the detector names a boundedJson read that reads `.error` (planted copies of the defect)', () => {
    const typed = "const json = await boundedJson<{\n data?: number[];\n error?: { message?: string };\n}>(response, 'p');";
    const used = "const j = await boundedJson<Record<string, unknown>>(res, 'M');\nif (j.error) throw new Error(String(j.error));";
    const clean = "const j = await boundedJson<{ data?: number[] }>(res, 'M');\nreturn j.data;";
    assert.equal(boundedJsonReadsForError(typed).length, 1, 'a type argument naming `error` must be flagged');
    assert.equal(boundedJsonReadsForError(used).length, 1, 'a `.error` read after the call must be flagged');
    assert.equal(boundedJsonReadsForError(clean).length, 0, 'a read that never looks at an error is not a model-server read');
  });

  it('no caller reads `.error` of a boundedJson result outside bounded-read.ts', () => {
    const offenders = [];
    for (const f of sourceFiles()) {
      if (f === HELPER) continue;
      for (const hit of boundedJsonReadsForError(code(f))) offenders.push(`${f}: ${hit}`);
    }
    assert.deepEqual(offenders, [], 'a model server\'s `error` (a string for Ollama, an object for OpenAI-compatible servers) is '
      + 'put whole into a thrown Error, so a megabyte error text reaches the logs and the caller. Use '
      + '`boundedModelJson(res, label)` from util/bounded-read.js: it owns the `error` check and cuts the text through peerText.\n  '
      + offenders.join('\n  '));
  });

  it('and boundedModelJson is actually used, so the gate above is not vacuous', () => {
    let sites = 0;
    for (const f of sourceFiles()) {
      if (f === HELPER) continue;
      sites += (code(f).match(/boundedModelJson[<(]/g) ?? []).length;
    }
    // embedding.ts (1), files/media/providers.ts (3), util/model-chat.ts (2): every model-server JSON read.
    assert.ok(sites >= 6, `only ${sites} boundedModelJson call sites outside the helper; the six model-server reads were not routed`);
  });

  it('the two P5 sites bound their error text through peerText', () => {
    const audio = code('server/src/files/media/audio-embedder.ts');
    const lastError = audio.match(/\blastError\s*=\s*err instanceof Error[^;]+;/g) ?? [];
    assert.ok(lastError.length > 0, 'audio-embedder.ts no longer assigns lastError; the gate lost its subject');
    for (const s of lastError) assert.match(s, /peerText\(/, `a chunk's provider error is stored raw in lastError: ${s}`);
    const worker = code('server/src/files/media/worker.ts');
    const message = worker.match(/\bconst message\s*=\s*err instanceof Error[^;]+;/g) ?? [];
    assert.ok(message.length > 0, 'worker.ts no longer derives `message` from the caught error; the gate lost its subject');
    for (const s of message) assert.match(s, /peerText\(/, `a job's failure text goes to failJob unbounded: ${s}`);
  });
});

describe('Q-363 boundedModelJson', () => {
  const MEGABYTE = 'E'.repeat(1_000_000);
  const jsonRes = (obj) => new Response(JSON.stringify(obj), { headers: { 'content-type': 'application/json' } });
  const needsHelper = () => assert.equal(typeof mod.boundedModelJson, 'function',
    'module server/dist/util/bounded-read.js does not export boundedModelJson: the implementation creates it');

  it('returns the parsed body when there is no error', async () => {
    needsHelper();
    assert.deepEqual(await mod.boundedModelJson(jsonRes({ data: [1] }), 'Model'), { data: [1] });
  });

  it('a string error (Ollama) is thrown, named by the label', async () => {
    needsHelper();
    await assert.rejects(() => mod.boundedModelJson(jsonRes({ error: 'model "x" not found' }), 'Ollama vision'),
      (err) => { assert.match(err.message, /Ollama vision/); assert.match(err.message, /model "x" not found/); return true; });
  });

  it('an object error (OpenAI-compatible) is thrown with its message', async () => {
    needsHelper();
    await assert.rejects(() => mod.boundedModelJson(jsonRes({ error: { message: 'quota exceeded', type: 'x' } }), 'Whisper'),
      (err) => { assert.match(err.message, /quota exceeded/); return true; });
  });

  it('a megabyte error text, string or object, is cut: the thrown message stays a line', async () => {
    needsHelper();
    for (const error of [MEGABYTE, { message: MEGABYTE }, { detail: MEGABYTE }]) {
      await assert.rejects(() => mod.boundedModelJson(jsonRes({ error }), 'Embedding'),
        (err) => {
          assert.ok(err.message.length < 600, `a ${typeof error} error of 1,000,000 chars became a ${err.message.length}-char message`);
          return true;
        });
    }
  });

  it('credentials in the error text are redacted, as peerText does', async () => {
    needsHelper();
    await assert.rejects(() => mod.boundedModelJson(jsonRes({ error: 'cannot reach https://svc:hunter2pw@models.internal/v1' }), 'Model'),
      (err) => { assert.doesNotMatch(err.message, /hunter2pw/); return true; });
  });

  it('a caller\'s own fail() builds the thrown Error from the bounded text', async () => {
    needsHelper();
    class Mine extends Error {}
    let got;
    await assert.rejects(() => mod.boundedModelJson(jsonRes({ error: MEGABYTE }), 'Model', { fail: (m) => { got = m; return new Mine(m); } }),
      (err) => err instanceof Mine);
    assert.ok(typeof got === 'string' && got.length < 600, 'fail() was handed the unbounded text');
  });

  it('still refuses an oversize body like boundedJson (maxBytes)', async () => {
    needsHelper();
    await assert.rejects(() => mod.boundedModelJson(jsonRes({ data: 'x'.repeat(5000) }), 'Model', { maxBytes: 100 }), /exceeded 100 bytes|too large/);
  });
});

describe('Q-363 embed() against a model server whose error text is a megabyte', () => {
  let server; let local; let dir; let emb;
  const saved = {};
  const ENV = ['CONFIG_PATH', 'EMBEDDING_URL', 'EMBEDDING_DIMENSIONS', 'EMBEDDING_PROVIDER'];
  const MEGABYTE = 'X'.repeat(1_000_000);
  let answer = { error: { message: MEGABYTE } };

  before(async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
    const { listenOnLoopback } = await import('../_shared/local-server.mjs');
    const http = await import('node:http');
    mkdirSync('E:/TMP/Ythril/data/b231-tests-S', { recursive: true });
    dir = mkdtempSync(join('E:/TMP/Ythril/data/b231-tests-S', 'q363-'));
    for (const k of ENV) saved[k] = process.env[k];
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ instanceId: 'q363', instanceLabel: 'q363', tokens: [], networks: [],
      spaces: [{ id: 'general', label: 'G', builtIn: true, folders: [], meta: {} }] }), { mode: 0o600 });
    server = http.createServer((q, r) => { q.resume(); q.on('end', () => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify(answer)); }); });
    local = await listenOnLoopback(server);
    process.env.CONFIG_PATH = join(dir, 'config.json');
    process.env.EMBEDDING_DIMENSIONS = '8';
    delete process.env.EMBEDDING_PROVIDER;
    process.env.EMBEDDING_URL = local.url;
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    emb = await import('../../server/dist/brain/embedding.js');
  });

  after(async () => {
    await local?.close();
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  it('the thrown message is a bounded line, not the megabyte', async () => {
    answer = { error: { message: MEGABYTE } };
    await assert.rejects(() => emb.embed('hi'), (err) => {
      assert.ok(err.message.length < 600, `embed() threw a ${err.message.length}-char message for a 1,000,000-char error text`);
      return true;
    });
  });

  it('an error object with no message is cut too (the JSON.stringify branch)', async () => {
    answer = { error: { detail: MEGABYTE } };
    await assert.rejects(() => emb.embed('hi'), (err) => {
      assert.ok(err.message.length < 600, `embed() threw a ${err.message.length}-char message for a 1,000,000-char error object`);
      return true;
    });
  });

  it('an unreachable endpoint\'s thrown message carries no credentials of the configured URL', async () => {
    const { closedLoopbackPort } = await import('../_shared/closed-port.mjs');
    const port = await closedLoopbackPort();
    process.env.EMBEDDING_URL = `http://svc:hunter2pw@127.0.0.1:${port}`;
    try {
      await assert.rejects(() => emb.embed('hi'), (err) => {
        assert.doesNotMatch(err.message, /hunter2pw/, 'the thrown "Could not reach embedding endpoint at <baseUrl>" carries the URL\'s password');
        return true;
      });
    } finally { process.env.EMBEDDING_URL = local.url; }
  });
});
