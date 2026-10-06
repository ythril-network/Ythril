/**
 * The sentences the docs quote as the answer to a store failure are the sentences the server answers with
 * (bundle-53 G27, Q-330 and Q-343).
 *
 * ## The defect it prevents
 *
 * An integrator reads the answer's TEXT in `03-auth-and-limits.md` and `16-mcp.md` while deciding what to
 * retry, and the owner rule for this repo is that those pages are an authoritative source. The text lives in
 * `brain/store-failure.ts`; the docs hold a copy. Nothing fails when the code's sentence is reworded — the
 * copy just stops being what a caller receives, and a client that matched the prose (against the guide's own
 * advice) quietly stops matching. Two of the answers matter most because their STATUS differs from what a
 * caller would guess:
 *
 *  - a connection-pool checkout that timed out, or a pool that was closed, is a `503` retryable (Q-330). It
 *    answered `500` (not retryable, "an internal fault") before, so a pool that was merely exhausted for a
 *    second read as a bug in the caller's deployment;
 *  - a write concern the deployment can never meet is a `500`, NOT retryable (Q-343). It answered `503`
 *    ("retry") before, which asks for a configuration fault to be repeated for ever.
 *
 * ## What it holds
 *
 * The answer is DERIVED, not retyped: a real driver error goes through `classifyReadFailure` and the text that
 * comes back must appear, word for word, in BOTH pages. The pool errors are built from the driver's own
 * `lib/cmap/errors.js`, so a driver upgrade that renames one is seen here. The docs wrap and block-quote their
 * sentences, so both sides are compared with whitespace and the `>` of a quotation folded away.
 *
 * Run: node --test testing/standalone/the-store-failure-messages-in-the-docs-are-the-constants.test.js
 * (after `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const sf = await import('../../server/dist/brain/store-failure.js');
const requireFromServer = createRequire(path.resolve('server/package.json'));
const driver = requireFromServer('mongodb');
const cmap = requireFromServer(path.join(path.dirname(requireFromServer.resolve('mongodb')), 'cmap', 'errors.js'));
const { MongoNetworkError, MongoDriverError, MongoWriteConcernError } = driver;

/** The pages an integrator reads these answers on: the REST/auth reference and the MCP reference. */
const PAGES = ['docs/integration-guide/03-auth-and-limits.md', 'docs/integration-guide/16-mcp.md'];

/** A page as one line of words: the `>` of a quotation, the line breaks and the emphasis marks folded away. */
const words = (text) => text.replace(/^\s*>\s?/gm, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();

const pages = new Map(PAGES.map(p => [p, words(readFileSync(p, 'utf8'))]));

/** The answer a door gives for `err`, which must be the status asserted, so a reclassified error fails here and not in the docs. */
function answerOf(err, status, retryable) {
  const a = sf.classifyReadFailure(err);
  assert.equal(a.status, status, `${err.name ?? err.constructor.name} answers ${a.status}, not ${status}`);
  assert.equal(a.retryable, retryable);
  assert.ok(typeof a.error === 'string' && a.error.length > 40, 'the answer carries a sentence of ours');
  return a;
}

/** What a caller receives, by situation. */
const poolErrors = [
  new cmap.WaitQueueTimeoutError('Timed out while checking out a connection from connection pool', 'mongo-a.internal:27017'),
  new cmap.PoolClosedError({ address: 'mongo-a.internal:27017' }),
];
const ANSWERS = [
  { what: 'a store failure (a dropped connection, a pool the driver cleared)', ...answerOf(new MongoNetworkError('connection closed'), 503, true) },
  { what: 'a pool checkout that timed out', ...answerOf(poolErrors[0], 503, true) },
  { what: 'a pool that was closed', ...answerOf(poolErrors[1], 503, true) },
  { what: 'a driver error nothing recognises', ...answerOf(new MongoDriverError('some internal fault'), 500, false) },
  {
    what: 'a write concern the deployment cannot meet',
    ...answerOf(new MongoWriteConcernError({ writeConcernError: { code: 100, codeName: 'UnsatisfiableWriteConcern', errmsg: 'Not enough data-bearing nodes' } }), 500, false),
  },
];

describe('the sentences the docs quote as store-failure answers are the ones the server sends', () => {
  it('has the answers it should be holding the docs to (a floor)', () => {
    assert.ok(ANSWERS.length >= 5);
    assert.ok(new Set(ANSWERS.map(a => a.error)).size >= 3, 'three distinct sentences: retry, do-not-retry-fault, unsatisfiable');
    assert.ok(PAGES.length >= 2 && pages.size === PAGES.length);
  });

  it('the pool checkout errors are answered with the sentence of any other store failure', () => {
    assert.equal(ANSWERS[1].error, ANSWERS[0].error);
    assert.equal(ANSWERS[2].error, ANSWERS[0].error);
    assert.equal(ANSWERS[1].retryAfterSeconds, 5, 'and with the same Retry-After');
  });

  it('the unsatisfiable-write-concern answer is the exported constant, with the server\'s code and name', () => {
    const a = ANSWERS[4];
    assert.equal(a.error, sf.UNSATISFIABLE_WRITE_CONCERN_MESSAGE);
    assert.equal(a.code, 100);
    assert.equal(a.codeName, 'UnsatisfiableWriteConcern');
  });

  for (const [page, text] of pages) {
    it(`${page} names the pool's two checkout failures among the conditions that answer 503`, () => {
      // The conditions are said in prose, so this is the one place the gate reads words rather than a constant: what it
      // holds is that the page SAYS a checkout that timed out and a closed pool are the retryable kind (Q-330).
      assert.match(text, /pool checkout[^.]*(timed out|times out|timeout)/i, `${page} does not say a pool checkout timeout is a 503`);
      assert.match(text, /closed (connection )?pool|pool (that is|was) closed/i, `${page} does not say a closed pool is a 503`);
    });

    for (const a of ANSWERS) {
      it(`${page} quotes the answer to ${a.what}`, () => {
        assert.ok(text.includes(words(a.error)),
          `${page} does not carry the sentence the server answers with for ${a.what}:\n  ${a.error}\n` +
          'Reword the page, or the constant, so a caller reading the guide is told what it will receive.');
      });
    }
  }
});
