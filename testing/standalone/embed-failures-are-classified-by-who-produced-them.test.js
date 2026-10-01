/**
 * The queue reads a failure from its MESSAGE; a lost inference process must be readable there, and forgeable nowhere.
 *
 * ## The rule (Q-99 part 1)
 *
 * `failEmbedJob` and `isTransientEmbedError` decide a job's fate from a string: the error crossed a process
 * boundary, then a queue, and only text survives. A crashed inference process is the embedder's fault, not the
 * record's, so it is TRANSIENT (retried with backoff, the record's attempt handed back). But "the embedder's fault"
 * is exactly how an input that KILLS the runtime looks, so a lost child is also CAPPED per record
 * (`lostChildFailures`, three, then terminal `failed` naming the crash — `embed-queue-lost-child-db.test.js`).
 *
 * Both halves rest on recognising a lost child from text, which raises two questions this file pins:
 *
 *  1. **One source for the marker.** `embed-errors.ts` owns the text `embedding process lost`, and the queue's
 *     needle list is built from that export. A second copy of the literal is a second place to be wrong: rename
 *     the message and the queue silently stops retrying crashes.
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
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

let errors, isTransientEmbedError, queue;

before(async () => {
  errors = await import('../../server/dist/brain/embed-errors.js');
  queue = await import('../../server/dist/brain/embed-queue.js');
  ({ isTransientEmbedError } = queue);
});

describe('the marker', () => {
  it('is the text operators will see, and the queue retries it', () => {
    assert.equal(errors.LOST_MARKER, 'embedding process lost');
    assert.equal(isTransientEmbedError(errors.LOST_MARKER), true);
    assert.equal(isTransientEmbedError(`${errors.LOST_MARKER} (code=139 signal=null)`), true);
    assert.equal(isTransientEmbedError(`${errors.LOST_MARKER} (code=null signal=SIGKILL)`), true);
  });

  it('has exactly one definition in the server sources, and the queue takes it from there', () => {
    const files = trackedSources('server/src', { floor: 100, untracked: true });
    const holding = files.filter(f => stripComments(readFileSync(join(REPO_ROOT, f), 'utf8')).includes('embedding process lost'));
    assert.deepEqual(holding, ['server/src/brain/embed-errors.ts'],
      'the marker text is written in more than one place; the queue would stop recognising a crash the day one is edited');
    const holdingNotSent = files.filter(f => stripComments(readFileSync(join(REPO_ROOT, f), 'utf8')).includes('embedding process unavailable'));
    assert.deepEqual(holdingNotSent, ['server/src/brain/embed-errors.ts'],
      'the not-sent marker text is written in more than one place');

    const queueSrc = stripComments(readFileSync(join(REPO_ROOT, 'server/src/brain/embed-queue.ts'), 'utf8'));
    assert.match(queueSrc, /from\s+['"]\.\/embed-errors\.js['"]/, 'embed-queue.ts does not import the marker module');
    assert.match(queueSrc, /LOST_MARKER/, 'embed-queue.ts imports the module but does not use the marker');
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

describe('the per-record cap is named where the queue reads it', () => {
  it('exports the cap, at three, from the queue', () => {
    assert.equal(queue.MAX_LOST_CHILD_FAILURES, 3,
      'three crashes on one record is an input that kills the runtime; the plan\'s number, and one place to change it');
  });
});
