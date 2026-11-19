/**
 * The queue reads a failure from its MESSAGE; a lost inference process must be readable there, and forgeable nowhere.
 *
 * ## The rule (Q-99 part 1)
 *
 * `failEmbedJob` decides a job's fate by `classifyEmbedFailure` (Q-931), which reads a failure of no class the server built from its
 * text, through `isTransientEmbedError`: the error crossed a process boundary, then a queue, and only text survives. A crashed inference
 * process is the embedder's fault, not the record's, so it is TRANSIENT (retried with backoff, the record's attempt handed back). But
 * "the embedder's fault" is exactly how an input that KILLS the runtime looks, so a lost child is also CAPPED per record, by the CLASS of
 * the host's error (`lostChildFailures`, three, then terminal `failed` naming the crash — `embed-queue-lost-child-db.test.js`).
 *
 * Both halves rest on recognising a lost child, which raises two questions this file pins:
 *
 *  1. **One source for the marker.** `embed-errors.ts` owns the text `embedding process lost`, and the words rule is built from
 *     that export. A second copy of the literal is a second place to be wrong: rename the message and the wait silently stops
 *     recognising crashes.
 *  2. **Only the host can produce it.** The child supplies error strings too (a tokenizer failure, an input it
 *     refuses). One of those containing the marker, or a needle such as `timeout`, must not make a record look
 *     crash-capped or an input look transient because of what the CHILD said. `isLostChildError` answers for
 *     an error object the host made; a string that merely reads like one is not.
 *
 * And the class that must NOT be transient: a model that cannot load is deterministic, sticky in the host, and
 * ends a job `failed` after its attempts so an operator sees it and can retry (`embed-queue-db.test.js` holds
 * that end to end).
 *
 * Run: node --test testing/standalone/embed-failures-are-classified-by-who-produced-them.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT, SERVER_CODE_ROOTS } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

let errors, isTransientEmbedError, queue;

before(async () => {
  errors = await import('../../server/dist/brain/embed-errors.js');
  queue = await import('../../server/dist/brain/embed-queue.js');
  ({ isTransientEmbedError } = queue);
});

describe('the marker', () => {
  it('is the text operators will see, and the queue retries it', () => {
    assert.equal(isTransientEmbedError(errors.LOST_MARKER), true);
    assert.equal(isTransientEmbedError(`${errors.LOST_MARKER} (code=139 signal=null)`), true);
    assert.equal(isTransientEmbedError(`${errors.LOST_MARKER} (code=null signal=SIGKILL)`), true);
  });

  it('has exactly one definition in the server sources, and the queue takes the verdict from there', () => {
    const files = trackedSources(SERVER_CODE_ROOTS, { floor: 100, untracked: true });
    const holding = files.filter(f => stripComments(readFileSync(join(REPO_ROOT, f), 'utf8')).includes('embedding process lost'));
    assert.deepEqual(holding, ['server/src/brain/embed-errors.ts'],
      'the marker text is written in more than one place; the queue would stop recognising a crash the day one is edited');
    const holdingNotSent = files.filter(f => stripComments(readFileSync(join(REPO_ROOT, f), 'utf8')).includes('embedding process unavailable'));
    assert.deepEqual(holdingNotSent, ['server/src/brain/embed-errors.ts'],
      'the not-sent marker text is written in more than one place');

    const queueSrc = stripComments(readFileSync(join(REPO_ROOT, 'server/src/brain/embed-queue.ts'), 'utf8'));
    assert.match(queueSrc, /from\s+['"]\.\/embed-errors\.js['"]/, 'embed-queue.ts does not import the verdict module');
    assert.match(queueSrc, /\bclassifyEmbedFailure\b/, 'embed-queue.ts imports the module but does not ask the verdict');
    const errorsSrc = stripComments(readFileSync(join(REPO_ROOT, 'server/src/brain/embed-errors.ts'), 'utf8'));
    assert.match(errorsSrc, /\[\s*LOST_MARKER\s*,/, 'the words rule is not built from the marker export');
  });
});

describe('isLostChildError: only what the host produced', () => {
  it('is true for the error the host raises', () => {
    const err = new errors.LostChildError('code=139 signal=null');
    assert.ok(err instanceof Error);
    assert.equal(errors.isLostChildError(err), true);
    assert.ok(err.message.startsWith(errors.LOST_MARKER));
    assert.ok(err.message.includes('code=139'));
  });

  it('says whether the request was in flight, and only the one in flight carries the marker the queue counts', () => {
    const held = new errors.LostChildError('code=139 signal=null');
    assert.equal(held.inFlight, true, 'the default is the request the child held');

    const behind = new errors.LostChildError('code=139 signal=null', { inFlight: false });
    assert.equal(errors.isLostChildError(behind), true);
    assert.equal(behind.inFlight, false);
    assert.ok(behind.message.startsWith(errors.NOT_SENT_MARKER), behind.message);
    assert.ok(!behind.message.includes(errors.LOST_MARKER),
      'the queue charges a crash to every record whose error carries the marker: a bystander must not');
    assert.ok(behind.message.includes('code=139'));
    assert.equal(isTransientEmbedError(behind.message), true, 'still the embedder\'s fault, so retried');
  });

  it('defuses the not-sent words too in anything a child supplies', () => {
    const defused = errors.withoutLostMarker(`${errors.NOT_SENT_MARKER} and ${errors.LOST_MARKER}`);
    assert.ok(!defused.includes(errors.NOT_SENT_MARKER), defused);
    assert.ok(!defused.includes(errors.LOST_MARKER), defused);
    assert.equal(isTransientEmbedError(defused), false, 'a child cannot make its own failure read as the embedder\'s');
  });

  it('is false for anything that merely reads like one', () => {
    for (const impostor of [
      new Error(errors.LOST_MARKER),
      new Error(`${errors.LOST_MARKER} (code=0 signal=null)`),
      Object.assign(new Error('x'), { lost: true }),
      { message: errors.LOST_MARKER },
      errors.LOST_MARKER,
      'timeout',
      null,
      undefined,
      42,
    ]) {
      assert.equal(errors.isLostChildError(impostor), false, `taken for a lost process: ${String(impostor?.message ?? impostor)}`);
    }
  });
});

/**
 * ## An unreachable endpoint is the embedder's, and the OBJECT says so (Q-924)
 *
 * The embed call knows why it failed at the one place it catches the fetch: the connection never landed. An outage on 18 Nov 2026 ended every queued
 * job `failed` because the queue read that fact from the words of the sentence the call throws (`Could not reach embedding endpoint at <url>`),
 * which holds none of the needles `isTransientEmbedError` reads. `EmbedUnreachableError` carries the fact (`isEmbedUnreachableError` is by `instanceof`
 * alone, as `isLostChildError` is), and `classifyEmbedFailure` is the one question the queue and the rebuild guard both ask of the caught value.
 * A plain `Error` or a string with the same sentence is not the class: an endpoint's body or a child's text cannot forge it.
 */
describe('classifyEmbedFailure: the object is the proof, the sentence is not', () => {
  const SENTENCE = 'Could not reach embedding endpoint at http://x. Make sure an embedding server (e.g. Ollama) is running and configured.';
  let fresh;
  before(async () => { fresh = await import('../../server/dist/brain/embed-errors.js'); });
  const outage = (failure) => fresh.classifyEmbedFailure(failure).kind === 'outage';

  it('the typed error is transient, and carries today\'s sentence word for word, no code and no cause', () => {
    const err = new fresh.EmbedUnreachableError(SENTENCE);
    assert.ok(err instanceof Error);
    assert.equal(fresh.isEmbedUnreachableError(err), true);
    assert.equal(err.message, SENTENCE);
    assert.equal(err.code, undefined, 'a code would send a write that needs the vector to a different answer than today\'s');
    assert.equal('cause' in err, false, 'a cause would do the same, through the error chain');
    assert.equal(outage(err), true);
  });

  it('a plain Error and a string with the same sentence are not the class, and are not an outage', () => {
    assert.equal(fresh.isEmbedUnreachableError(new Error(SENTENCE)), false);
    assert.equal(fresh.isEmbedUnreachableError(SENTENCE), false);
    assert.equal(fresh.isEmbedUnreachableError({ name: 'EmbedUnreachableError', message: SENTENCE }), false);
    assert.equal(outage(new Error(SENTENCE)), false);
    assert.equal(outage(SENTENCE), false);
  });

  it('a failure of no class the server built is asked of its message exactly as isTransientEmbedError asks it, for an Error and for a string', () => {
    for (const message of ['connect ECONNREFUSED 127.0.0.1:11434', 'Embedding request failed (HTTP 503): down', 'Embedding request failed (HTTP 400): bad', 'unsupported input shape', '']) {
      assert.equal(outage(new Error(message)), isTransientEmbedError(message), `Error: ${message}`);
      assert.equal(outage(message), isTransientEmbedError(message), `string: ${message}`);
    }
    assert.equal(fresh.classifyEmbedFailure(new fresh.LostChildError('code=139 signal=null')).kind, 'lost', 'the lost process is read by its class');
    assert.equal(outage(undefined), false);
    assert.equal(outage(null), false);
  });
});

/**
 * `isConnectionFailure` is the outbound call's rule, `isSocketFailure` the doors' (moved unchanged out of `answerForCaught`): the same chain walk, the
 * same code pattern, and the outbound rule adds what an unreachable host looks like beyond the socket codes. One row per code, written by hand.
 */
describe('socket-failure.ts: two questions over one chain walk', () => {
  let rule;
  before(async () => { rule = await import('../../server/dist/util/socket-failure.js'); });

  const viaCause = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`connect ${code}`), { code }) });
  // [code, isSocketFailure (the door's answer, unchanged), isConnectionFailure (the outbound call's)]
  const CODES = [
    ['ECONNREFUSED', true, true], ['ECONNRESET', true, true], ['EPIPE', true, true], ['ETIMEDOUT', true, true], ['ENOTFOUND', true, true], ['EAI_AGAIN', true, true],
    ['EHOSTUNREACH', false, true], ['ENETUNREACH', false, true],
    ['UND_ERR_CONNECT_TIMEOUT', false, true], ['UND_ERR_SOCKET', false, true], ['UND_ERR_HEADERS_TIMEOUT', false, true], ['UND_ERR_BODY_TIMEOUT', false, true],
    ['EACCES', false, false], ['ERR_INVALID_URL', false, false], ['UND_ERR_ABORTED', false, false], ['CERT_HAS_EXPIRED', false, false],
  ];
  for (const [code, door, outbound] of CODES) {
    it(`${code} on the cause: door ${door}, outbound ${outbound}`, () => {
      assert.equal(rule.isSocketFailure(viaCause(code)), door);
      assert.equal(rule.isConnectionFailure(viaCause(code)), outbound);
      assert.equal(rule.isConnectionFailure(Object.assign(new Error('x'), { code })), outbound, 'also on the error itself');
    });
  }

  it('an error named TimeoutError anywhere in the chain is an outbound failure and never the door\'s', () => {
    const slot = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    assert.equal(rule.isConnectionFailure(slot), true);
    assert.equal(rule.isConnectionFailure(new Error('wrapped', { cause: slot })), true);
    assert.equal(rule.isSocketFailure(slot), false, 'the doors answer a timeout as before: the rule they ask did not move');
    assert.equal(rule.isConnectionFailure(new DOMException('This operation was aborted', 'AbortError')), false, 'an abort somebody asked for is not an outage');
  });

  it('is never decided by words: a message that names a refusal or a timeout, without a code or the name, is not a connection failure', () => {
    for (const message of ['connect ECONNREFUSED 127.0.0.1:1', 'timeout', 'fetch failed', 'socket hang up', 'Could not reach embedding endpoint at http://x']) {
      assert.equal(rule.isConnectionFailure(new Error(message)), false, message);
      assert.equal(rule.isConnectionFailure(message), false, `a string: ${message}`);
    }
    for (const nothing of [null, undefined, 42, {}]) assert.equal(rule.isConnectionFailure(nothing), false);
  });

  it('answerForCaught answers a socket-shaped failure exactly as before (502), and the new codes as a refusal or a fault, as before', async () => {
    const { answerForCaught } = await import('../../server/dist/util/answer-for-caught.js');
    assert.equal(answerForCaught(viaCause('ECONNREFUSED'), 'q924', { refusals: true }).status, 502);
    assert.equal(answerForCaught(viaCause('EHOSTUNREACH'), 'q924', { refusals: false }).kind, 'internal', 'a TypeError carrying a code the door never knew stays what it was');
  });
});

/**
 * The worker's pause after an unreachable embedder: one failure stands for the queue, so the worker claims nothing for a pause that grows to a cap
 * and ends with the first embed that worked. The pause is asked by the worker's LOOP, never by `runOneEmbedJob`, which tests drive directly.
 */
describe('the worker\'s pause after an unreachable embedder', () => {
  let mod;
  before(async () => { mod = await import('../../server/dist/brain/embedder-outage-pause.js'); });
  const within = (promise, ms = 5_000) => Promise.race([promise, new Promise((_, no) => setTimeout(() => no(new Error(`still waiting after ${ms} ms`)), ms).unref())]);

  it('starts at the first step, doubles to the cap and stays there, and an embed that worked ends it', () => {
    let t = 1_000_000;
    const pause = mod.createEmbedderOutagePause({ now: () => t });
    assert.equal(pause.remainingMs(), 0, 'no pause before a failure');
    const steps = [];
    for (let i = 0; i < 12; i++) { steps.push(pause.noteUnreachable()); }
    assert.equal(steps[0], mod.EMBEDDER_OUTAGE_PAUSE_FIRST_MS);
    assert.equal(steps[1], 2 * mod.EMBEDDER_OUTAGE_PAUSE_FIRST_MS);
    assert.equal(steps.at(-1), mod.EMBEDDER_OUTAGE_PAUSE_CAP_MS);
    assert.ok(steps.every((s, i) => i === 0 || (s >= steps[i - 1] && s <= mod.EMBEDDER_OUTAGE_PAUSE_CAP_MS)), `the steps ${steps} are not non-decreasing up to the cap`);
    assert.equal(pause.remainingMs(), mod.EMBEDDER_OUTAGE_PAUSE_CAP_MS);
    t += 1_000;
    assert.equal(pause.remainingMs(), mod.EMBEDDER_OUTAGE_PAUSE_CAP_MS - 1_000, 'it runs down with the clock');
    pause.noteEmbedded();
    assert.equal(pause.remainingMs(), 0, 'the first embed that worked ends it');
    assert.equal(pause.noteUnreachable(), mod.EMBEDDER_OUTAGE_PAUSE_FIRST_MS, 'and the next outage starts again from the first step');
  });

  it('waitOut returns at once with no pause, and cancel ends a wait (shutdown is not delayed by the pause)', async () => {
    const pause = mod.createEmbedderOutagePause();
    await within(pause.waitOut());
    pause.noteUnreachable();
    let done = false;
    const waiting = pause.waitOut().then(() => { done = true; });
    await new Promise(r => setImmediate(r));
    assert.equal(done, false, 'the wait ended before the pause did');
    pause.cancel();
    await within(waiting);
    assert.equal(pause.remainingMs(), 0, 'a cancelled pause is over');
  });

  it('the loop asks it before the claim, runOneEmbedJob never waits on it, and stopping the worker cancels it', async () => {
    const src = stripComments(readFileSync(join(REPO_ROOT, 'server/src/brain/embed-worker.ts'), 'utf8'));
    const body = (name) => {
      const head = src.indexOf(name);
      assert.ok(head >= 0, `no ${name} in embed-worker.ts`);
      let depth = 0;
      for (let i = src.indexOf('{', src.indexOf(')', head)); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(head, i);
      }
      assert.fail(`no end of ${name}`);
    };
    const loop = body('async function loop(');
    assert.ok(loop.search(/\bwaitOut\s*\(/) >= 0 && loop.search(/\bwaitOut\s*\(/) < loop.search(/\brunOneEmbedJob\s*\(/), 'the loop does not wait out the pause before it runs a job');
    assert.doesNotMatch(body('export async function runOneEmbedJob('), /\bwaitOut\s*\(/, 'runOneEmbedJob waits on the pause: a test that drives it would wait for the outage');
    assert.match(body('export function stopBrainEmbeddingWorker('), /\.cancel\s*\(/, 'stopping the worker does not end the pause: shutdown waits for it');
    assert.match(body('export async function runOneEmbedJob('), /\.noteUnreachable\s*\(/, 'the pause is never begun');
    assert.match(body('export async function runOneEmbedJob('), /\.noteEmbedded\s*\(/, 'the pause is never ended');
    // Each under its own condition: a failure of any other kind must not begin the pause, and an outcome that never called the embedder
    // (`unchanged`, `gone`) must not end it.
    assert.match(body('export async function runOneEmbedJob('), /if\s*\(isEmbedUnreachableError\(err\)\)\s*embedderOutagePause\.noteUnreachable\s*\(/, 'the pause begins for a failure that is not the unreachable class');
    assert.match(body('export async function runOneEmbedJob('), /if\s*\(outcome\s*===\s*'embedded'\)\s*embedderOutagePause\.noteEmbedded\s*\(/, 'the pause ends on an outcome that did not reach the embedder');
  });
});

/**
 * The real embed call, against real sockets: what it throws, and that its one warning is said once per endpoint and kind per window. The config is
 * read when the loader is first imported, so the file below is pointed at before any test of this file runs.
 */
const EMBED_DIR = mkdtempSync(join(tmpdir(), 'ythril-q924-embed-'));
process.env['CONFIG_PATH'] = join(EMBED_DIR, 'config.json');
process.env['EMBEDDING_DIMENSIONS'] = '4';
writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({ instanceId: 'q924', instanceLabel: 'q924', tokens: [], networks: [],
  spaces: [{ id: 'general', label: 'G', builtIn: true, folders: [], meta: {} }] }), { mode: 0o600 });

describe('the real embed(): what it throws, and what it says once', () => {
  const SENT = (port) => `Could not reach embedding endpoint at http://127.0.0.1:${port}. Make sure an embedding server (e.g. Ollama) is running and configured.`;
  const ENV = ['EMBEDDING_URL', 'EMBEDDING_PROVIDER', 'EMBEDDING_API_KEY'];
  const saved = {};
  let emb, fresh, loader, logs, stopLog;
  const unreachableLines = (port) => logs.filter(l => l.includes('Embedding endpoint unreachable') && l.includes(`:${port})`));

  before(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    fresh = await import('../../server/dist/brain/embed-errors.js');
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    emb = await import('../../server/dist/brain/embedding.js');
    const logModule = await import('../../server/dist/util/log.js');
    logs = [];
    stopLog = logModule.subscribeLogLines(l => logs.push(l));
  });
  after(() => {
    stopLog?.();
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(EMBED_DIR, { recursive: true, force: true });
  });
  beforeEach(() => {
    delete process.env['EMBEDDING_PROVIDER'];
    delete process.env['EMBEDDING_API_KEY'];
  });

  it('a closed port throws the class, with the sentence unchanged and no code or cause', async () => {
    const { closedLoopbackPort } = await import('../_shared/closed-port.mjs');
    const port = await closedLoopbackPort();
    process.env['EMBEDDING_URL'] = `http://127.0.0.1:${port}`;
    await assert.rejects(() => emb.embed('hello'), (err) => {
      assert.ok(fresh.isEmbedUnreachableError(err), `the embed call threw ${err?.constructor?.name}: ${err?.message}`);
      assert.equal(err.message, SENT(port));
      assert.equal(err.code, undefined);
      assert.equal('cause' in err, false);
      return true;
    });
  });

  it('the warning is said once for a run of failed calls to one endpoint, and again after a call that worked', async () => {
    const { closedLoopbackPort } = await import('../_shared/closed-port.mjs');
    const port = await closedLoopbackPort();
    process.env['EMBEDDING_URL'] = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 3; i++) await assert.rejects(() => emb.embed(`call ${i}`));
    assert.equal(unreachableLines(port).length, 1, `three failed calls to one endpoint said it ${unreachableLines(port).length} times: ${unreachableLines(port).join(' | ')}`);

    // The endpoint comes back on the same port, answers once, and goes away again: the next failure is news.
    const stub = http.createServer((q, r) => { q.resume(); q.on('end', () => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] })); }); });
    // own-listener: it must listen on the port the closed-port helper freed, which the shared listener never does
    await new Promise((resolve, reject) => { stub.once('error', reject); stub.listen(port, '127.0.0.1', resolve); });
    try { assert.deepEqual((await emb.embed('it is back')).vector, [0.1, 0.2, 0.3, 0.4]); }
    finally { stub.closeAllConnections(); await new Promise(r => stub.close(r)); }
    await assert.rejects(() => emb.embed('gone again'));
    assert.equal(unreachableLines(port).length, 2, 'a call that worked did not make the next failure news again');
  });

  it('a header value the runtime refuses throws a plain Error with the same sentence, is not transient, and is said once under its own kind', async () => {
    const { closedLoopbackPort } = await import('../_shared/closed-port.mjs');
    const port = await closedLoopbackPort();
    process.env['EMBEDDING_URL'] = `http://127.0.0.1:${port}`;
    process.env['EMBEDDING_API_KEY'] = 'a-key\nwith-a-line-break';
    for (let i = 0; i < 2; i++) {
      await assert.rejects(() => emb.embed('hello'), (err) => {
        assert.equal(fresh.isEmbedUnreachableError(err), false, 'a refused header value is configuration: waiting does not cure it');
        assert.equal(err.message, SENT(port));
        assert.equal(fresh.classifyEmbedFailure(err).kind, 'record');
        return true;
      });
    }
    assert.equal(unreachableLines(port).length, 1);
  });

  it('the address guard\'s refusal (an external endpoint on a blocked address) throws a plain Error with the same sentence and is not transient', async () => {
    process.env['EMBEDDING_PROVIDER'] = 'external';
    process.env['EMBEDDING_URL'] = 'http://127.0.0.1:9';
    await assert.rejects(() => emb.embed('hello'), (err) => {
      assert.equal(fresh.isEmbedUnreachableError(err), false, 'a refused address is configuration, not an outage');
      assert.match(err.message, /^Could not reach embedding endpoint at /);
      assert.equal(fresh.classifyEmbedFailure(err).kind, 'record');
      return true;
    });
  });

  it('the slot\'s own timeout (an endpoint that accepts and never answers) throws the class, and its warning is said once for two calls', async () => {
    const { listenOnLoopback } = await import('../_shared/local-server.mjs');
    const hang = await listenOnLoopback(net.createServer(() => { /* accepts, never answers */ }));
    const config = loader.getConfig();
    const before = config.modelSlots;
    config.modelSlots = { ...(before ?? {}), embedding: { timeoutMs: 1_000 } };
    process.env['EMBEDDING_URL'] = hang.url;
    try {
      for (let i = 0; i < 2; i++) {
        await assert.rejects(() => emb.embed('hello'), (err) => {
          assert.ok(fresh.isEmbedUnreachableError(err), `the slot's timeout threw ${err?.constructor?.name}: ${err?.message}`);
          return true;
        });
      }
      assert.equal(unreachableLines(hang.port).length, 1);
    } finally {
      config.modelSlots = before;
      await hang.close();
    }
  });
});

/**
 * ## No file decides an embed failure's kind by the words of the sentence
 *
 * The defect was a rule that read another module's sentence. The guard is over the whole server tree (derived from git, not listed): in code with its
 * comments removed, a string or a pattern holding the unreachable sentence's words may only be BUILT (the one throw site), never tested; and the
 * words-based question `isTransientEmbedError` is asked in `embed-errors.ts` alone, where `classifyEmbedFailure` puts the object first.
 */
describe('the source: the sentence is built in one place and never read', () => {
  const SENTENCE_WORDS = /could\s+not\s+reach\s+embedding/i;
  // A string test that decides: a call that reads text, with the words in its argument or in a pattern it is given.
  const READS = /(?:\.(?:includes|startsWith|endsWith|indexOf|match|matchAll|search|test)\s*\(|new\s+RegExp\s*\(|\bcase\s)[^)\n;]*could\s+not\s+reach\s+embedding|\/[^/\n]*could\s+not\s+reach\s+embedding[^/\n]*\/[gimsuy]*\s*\.\s*(?:test|exec)\s*\(|could\s+not\s+reach\s+embedding[^\n;]*\)\s*\.\s*(?:test|exec)\b/i;
  const decidesByTheSentence = (code) => READS.test(code);
  const callsTheWordsQuestion = (code) => /\bisTransientEmbedError\s*\(/.test(code);

  const sources = () => trackedSources(SERVER_CODE_ROOTS, { floor: 100, untracked: true })
    .map(file => ({ file, code: stripComments(readFileSync(join(REPO_ROOT, file), 'utf8')) }));

  it('no server file reads the unreachable sentence\'s words to decide anything', () => {
    const files = sources();
    const throwSite = files.filter(f => SENTENCE_WORDS.test(f.code)).map(f => f.file);
    assert.deepEqual(throwSite, ['server/src/brain/embedding.ts'], 'the sentence is written in more than one place, or not at all');
    assert.deepEqual(files.filter(f => decidesByTheSentence(f.code)).map(f => f.file), []);
  });

  it('isTransientEmbedError, which reads words, is asked in embed-errors.ts alone, by the verdict', () => {
    assert.deepEqual(sources().filter(f => callsTheWordsQuestion(f.code)).map(f => f.file), ['server/src/brain/embed-errors.ts']);
  });

  it('seen red on planted copies: a test of the words anywhere, and the words question asked from the rebuild guard', () => {
    const embedding = sources().find(f => f.file === 'server/src/brain/embedding.ts').code;
    for (const planted of [
      `${embedding}\nconst a = (m) => m.includes('Could not reach embedding endpoint');`,
      `${embedding}\nconst b = (m) => /could not reach embedding endpoint/i.test(m);`,
      `${embedding}\nconst c = (m) => m.startsWith('could not reach embedding');`,
    ]) assert.equal(decidesByTheSentence(planted), true, `the gate did not see: ${planted.split('\n').at(-1)}`);
    assert.equal(decidesByTheSentence(embedding), false, 'the throw site itself builds the sentence and tests nothing');
    const guard = sources().find(f => f.file === 'server/src/brain/embed-record.ts').code;
    const planted = guard.replace(/classifyEmbedFailure\s*\(\s*err\s*\)/, 'isTransientEmbedError(err instanceof Error ? err.message : String(err))');
    assert.notEqual(planted, guard, 'the rebuild guard no longer asks classifyEmbedFailure(err): re-point this gate');
    assert.equal(callsTheWordsQuestion(planted), true);
    assert.equal(callsTheWordsQuestion(guard), false);
  });
});

describe('isTransientEmbedError: the classification truth table', () => {
  const LOAD_TEXT = 'Embedding model \'nomic-ai/nomic-embed-text-v1.5\' is not in the model cache (/app/model-cache) and runtime downloads are disabled by HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE / YTHRIL_MODELS_OFFLINE. Either bake the model into the image (see docs/integration-guide/02-hosting.md), point MODEL_CACHE_DIR at a cache that has it, or unset the flag to allow a one-time download from huggingface.co. Underlying error: Could not locate file';

  const rows = [
    // [message, transient, why]
    [`${'embedding process lost'} (code=134 signal=null)`, true, 'a crashed inference process is the embedder\'s fault'],
    [`${'embedding process unavailable'}: it was lost before this request was sent (code=134 signal=null)`, true,
      'a request queued behind a crash is the embedder\'s fault as well'],
    [LOAD_TEXT, false,'a model that cannot load is deterministic: the job must reach failed so an operator sees it'],
    ['unsupported input shape', false, 'a per-record inference failure spends the record\'s attempts'],
    ['Embedding API returned empty vector', false, 'unchanged'],
    ['Embedding request failed (HTTP 400): bad input', false, 'a malformed request is the record\'s'],
    ['Embedding request failed (HTTP 503): down', true, 'unchanged: availability'],
    ['connect ECONNREFUSED 127.0.0.1:11434', true, 'unchanged: reachability'],
    ['Could not reach embedding endpoint at http://x', false, 'unchanged: worded without a needle, as before'],
    ['request timeout', true, 'unchanged: the existing needles still apply to text that is not the lost marker'],
  ];

  for (const [message, expected, why] of rows) {
    it(`${expected ? 'retries' : 'does not retry'}: ${message.slice(0, 70)}`, () => {
      assert.equal(isTransientEmbedError(message), expected, why);
    });
  }

  it('a child-supplied string holding a needle is classified by the needle, never as a lost process', () => {
    const forged = 'tokenizer timeout while reading input';
    assert.equal(errors.isLostChildError(new Error(forged)), false);
    assert.equal(isTransientEmbedError(forged), true, 'the long-standing needle behaviour is kept');
  });
});
