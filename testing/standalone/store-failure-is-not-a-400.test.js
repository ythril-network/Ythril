/**
 * A failure of the STORE answers 503 and says it is retryable; a bad request still answers 400 — and neither says the
 * driver's words (`Q-361`: rewritten when the answers stopped echoing the driver's text; the statuses are unchanged).
 *
 * ## What this pins, and why the unsafe direction is the one to test hardest
 *
 * `/query`, `/recall` and `/find-similar` each answered `400` for every throw. Two parties reported the same
 * consequence from opposite sides within thirty hours — the canary operator as an unreadable operator message,
 * the fleet integrator as **6 of 36 recalls (17%)** silently producing uninformed output, because `onError:
 * continueRegularOutput` plus a 4xx means "do not retry, the fault is yours".
 *
 * The fix's own risk runs the other way: calling a genuine client error retryable would have a caller retry a
 * malformed filter for ever. So the assertions below are weighted that way — a handful prove the store case
 * becomes a 503, and the rest prove that everything we refuse ourselves is untouched.
 *
 * ## What this file USED to assert, and does not
 *
 * It asserted the ECHO: that the dangling `caused by ::` was closed with "the store reported no cause", that the
 * driver's `errmsg` reached the caller, and that a nested `cause`'s text (`10.1.2.3:27017`) was in the body. Those were the
 * defect read as a feature — the same text names the host, the port and the namespace to whoever asks, and a global
 * handler cannot tell an operator from an anonymous caller — so they now assert the opposite: **the answer is our sentence
 * and says nothing of the driver's message, while `status`, `retryable`, `Retry-After`, `code` and `codeName` stay.**
 * Its errors were also plain `Error`s wearing a driver's `name`, which only a classifier that asks what an error is CALLED
 * can be shown to handle; they are now the driver's own classes (`_store-failure-fixtures.mjs`, derived with a floor).
 * `a-store-failure-says-nothing-of-the-driver` holds the same rule over every class the driver exports.
 *
 * Run: node --test testing/standalone/store-failure-is-not-a-400.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchSource } from './_tool-dispatch.mjs';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { LEAK, STORE_SIDE, STORE_SIDE_NAMES, driverSideErrors, serverError, driver } from './_store-failure-fixtures.mjs';

const { classifyReadFailure } = await import('../../server/dist/brain/store-failure.js');

const DRIVER_SIDE = driverSideErrors();
const driverError = (name, message) => {
  const made = DRIVER_SIDE.find(d => d.name === name);
  assert.ok(made, `the driver exports no ${name}`);
  const err = made.make();
  return message === undefined ? err : Object.assign(err, { message });
};

describe('the reported condition, verbatim from both reports', () => {
  /**
   * The exact string both parties quoted, from two different instances. It is the whole reason the classifier
   * matches on a message at all — neither failing instance is ours to probe for a code.
   */
  const REPORTED = 'Executor error during aggregate command on namespace: '
    + 'ythril_the fleet integrator.orchestrator_facts :: caused by :: ';
  const reported = (extra = {}) => new driver.MongoServerError({ ok: 0, code: 8, codeName: 'InternalError', errmsg: REPORTED, ...extra });

  it('is a 503, is retryable, and stops reading as a complaint about the request', () => {
    const f = classifyReadFailure(reported());
    assert.equal(f.status, 503, 'a store failure is not a client error');
    assert.equal(f.retryable, true);
    assert.ok(f.retryAfterSeconds > 0, 'and it must say how long to wait');
  });

  it('says it is the store\'s and can be retried, in our words — not a half sentence ending at `caused by ::`', () => {
    // THE symptom: the message ends mid-sentence, which a caller reads as a truncated complaint about their own
    // request. The answer is now OUR sentence, which names whose fault it is because the status alone is not read by a human.
    const f = classifyReadFailure(reported());
    assert.doesNotMatch(f.error, /caused by ::\s*$/, 'the message must not still end at `caused by ::`');
    assert.match(f.error, STORE_SIDE, 'say whose fault it is');
    assert.match(f.error, /retried|retryable/i, 'and that retrying is the right response');
  });

  it('says nothing of the namespace, the executor or the driver\'s cause', () => {
    const f = classifyReadFailure(reported({ errmsg: `${REPORTED}mongot connection closed`, codeName: 'InternalError' }));
    assert.doesNotMatch(f.error, LEAK);
    assert.doesNotMatch(f.error, /orchestrator_facts|mongot connection closed/, 'the store\'s words are the operator\'s, in the log');
  });

  it('keeps the store\'s code and codeName — stable, and an operator\'s fastest route to the condition', () => {
    const f = classifyReadFailure(reported());
    assert.equal(f.code, 8);
    assert.equal(f.codeName, 'InternalError');
  });

  it('a nested `cause` of a driver error is not in the answer either', () => {
    const f = classifyReadFailure(Object.assign(driverError('MongoServerSelectionError'), { cause: new Error('connection 4 to 10.1.2.3:27017 closed') }));
    assert.equal(f.status, 503);
    assert.doesNotMatch(f.error, /10\.1\.2\.3|27017/);
  });
});

describe('the store cases, each identified positively — by the driver\'s own classes', () => {
  it('built from the driver\'s classes (floor), not from names on plain Errors', () => {
    assert.ok(DRIVER_SIDE.length >= 25, `only ${DRIVER_SIDE.length} driver classes built`);
    for (const name of STORE_SIDE_NAMES) assert.ok(driverError(name) instanceof driver.MongoError, `${name} is not a MongoError`);
  });

  for (const name of STORE_SIDE_NAMES) {
    it(`${name} is the store`, () => {
      const f = classifyReadFailure(driverError(name));
      assert.equal(f.status, 503, `${name} means the store did not answer`);
      assert.equal(f.retryable, true);
      assert.match(f.error, STORE_SIDE);
      assert.doesNotMatch(f.error, LEAK);
    });
  }

  for (const [code, why] of [[11600, 'InterruptedAtShutdown'], [91, 'ShutdownInProgress'],
    [11602, 'InterruptedDueToReplStateChange'], [189, 'PrimarySteppedDown'],
    [13436, 'NotPrimaryOrSecondary'], [50, 'MaxTimeMSExpired'], [262, 'ExceededTimeLimit']]) {
    it(`MongoServerError code ${code} (${why}) is the store`, () => {
      const f = classifyReadFailure(serverError(code, why, `${why}: connection 9 to mongo-b.internal:27018 closed`));
      assert.equal(f.status, 503, `${why} is not answerable right now, and will be`);
      assert.equal(f.retryable, true);
      assert.doesNotMatch(f.error, LEAK);
    });
  }

  it('a $vectorSearch failure from the STORE is the store even without a recognised code', () => {
    // On a real MongoServerError: the pattern is read from what the DRIVER raised. An error of ours that merely says the
    // same words is a refusal (`a-store-failure-says-nothing-of-the-driver`).
    const f = classifyReadFailure(serverError(8, 'UnknownError', 'PlanExecutor error :: $vectorSearch index not queryable'));
    assert.equal(f.status, 503);
    assert.doesNotMatch(f.error, /PlanExecutor|queryable/);
  });
});

describe('everything we refuse ourselves is UNCHANGED — the direction that must not break', () => {
  const clientErrors = [
    'filter: unexpected property \'$where\'',
    '`maxBytes` must be a positive integer number of bytes',
    'projection cannot mix inclusion and exclusion',
    'entryId must be a valid UUID v4',
    'topK must be a number',
    'Space \'nope\' not found',
  ];
  for (const msg of clientErrors) {
    it(`stays 400: ${msg.slice(0, 44)}`, () => {
      const f = classifyReadFailure(new Error(msg));
      assert.equal(f.status, 400, 'a refusal the caller can fix must stay a refusal');
      assert.equal(f.retryable, false, 'and must NOT invite a retry that will fail identically');
      assert.equal(f.error, msg, 'and its message must be unchanged — callers match on these');
    });
  }

  it('a MongoServerError with an unlisted code stays 400, in the server\'s own words — the name is not enough', () => {
    const f = classifyReadFailure(serverError(18, 'AuthenticationFailed', 'Authentication failed.'));
    assert.equal(f.status, 400, 'AuthenticationFailed will never succeed on a retry');
    assert.equal(f.retryable, false);
    assert.equal(f.error, 'Authentication failed.');
  });

  it('a malformed query the SERVER refused keeps the server\'s words — they are how a caller fixes it', () => {
    const f = classifyReadFailure(serverError(51091, 'Location51091', 'Regular expression is invalid: missing closing parenthesis'));
    assert.equal(f.status, 400);
    assert.equal(f.error, 'Regular expression is invalid: missing closing parenthesis');
  });

  it('a plain Error with no name and no code stays 400', () => {
    const f = classifyReadFailure(new Error('something went wrong'));
    assert.equal(f.status, 400);
    assert.equal(f.retryable, false);
    assert.equal(f.error, 'something went wrong');
  });

  it('a non-Error throw does not crash the classifier', () => {
    const f = classifyReadFailure('a string');
    assert.equal(f.status, 400);
    assert.equal(f.error, 'a string');
    assert.equal(classifyReadFailure(null).status, 400);
    assert.equal(classifyReadFailure(undefined).status, 400);
  });
});

describe('a delegating route keeps what the response does not carry', () => {
  it('recall still stashes its outcome for the space-activity signal', () => {
    /*
     * The half of a route collapse that NO comparison of the two response bodies can find, because it is
     * not in the body.
     *
     * `audit/middleware.ts` reads `req.recallOutcome` — did this recall answer, and how well — and records
     * it per space. That is the signal separating a space worth keeping from one that is merely asked a
     * lot. The old handler set it because it was the only code that knew; when `POST /api/brain/recall`
     * collapsed onto `callTool` the assignment went with the handler, and every recall through that route
     * recorded `undefined` for both fields. Nothing failed, nothing logged, and the number an operator
     * reads would have drifted quietly toward zero.
     *
     * Asserted against the CONSUMER rather than as a literal, so a rename moves both or fails here.
     */
    const audit = stripComments(readFileSync('server/src/audit/middleware.ts', 'utf8'));
    const routes = stripComments(readFileSync('server/src/api/brain/search.ts', 'utf8'));
    const reads = [...audit.matchAll(/req\.recallOutcome\?\.(\w+)/g)].map(m => m[1]);
    assert.ok(reads.length >= 2, `the audit hook reads only ${reads.length} outcome field(s) — re-point this gate`);

    const at = routes.indexOf("searchRouter.post('/recall'");
    assert.ok(at > 0, '/recall is no longer registered — re-anchor this gate');
    const body = routes.slice(at, routes.indexOf('searchRouter.', at + 20));
    assert.match(body, /req\.recallOutcome\s*=/,
      'the recall route no longer stashes its outcome, so the space-activity signal records nothing');
    for (const field of new Set(reads)) {
      // `\\b`, doubled: a single `\b` in a template literal is a BACKSPACE character, not a word boundary,
      // so the first version built a regex that matched nothing and reported every field as missing.
      assert.match(body, new RegExp(`\\b${field}\\b`),
        `the audit hook reads \`${field}\` and the route never sets it — the field is silently undefined`);
    }
  });

  it('and derives the score through the shared comparator, not from `.score`', () => {
    // Precedence is rerank > fused > vector. On an instance with a reranker, `.score` is the one number
    // that did NOT decide the result's position, so recording it would make the activity signal describe
    // an ordering nobody saw.
    const routes = stripComments(readFileSync('server/src/api/brain/search.ts', 'utf8'));
    const at = routes.indexOf('req.recallOutcome');
    const stmt = routes.slice(at, routes.indexOf('};', at));
    assert.match(stmt, /rankOf\(/,
      'topScore must come from rankOf — `.score` is the vector half alone');
  });
});

describe('both doors, and all three routes', () => {
  it('`retryable` is on EVERY failure body, not only the retryable ones', () => {
    // A field that appears only when it is true is a field whose absence has to be interpreted, and the caller
    // who most needs it is the one who does not know to look — the same argument as the budget's accounting.
    const src = stripComments(readFileSync('server/src/api/brain/_read-failure.ts', 'utf8'));
    assert.match(src, /retryable: f\.retryable/,
      'the field must be sent unconditionally, not spread in behind a condition');
    assert.doesNotMatch(src, /f\.retryable \? \{ retryable/,
      'a conditional `retryable` is the shape this exists to avoid');
  });

  it('`retryable` reaches the EARLY refusals too, not only the throws', () => {
    /*
     * `sendReadFailure` only sees a throw. The three handlers also refuse early — a bad `collection`, a
     * non-boolean flag, a malformed `entryId` — each with its own `res.status(400).json(...)`, and those
     * bodies carried no `retryable` at all. Measured against a live instance: three of four probed refusals
     * came back without it.
     *
     * An absent `retryable` is the exact thing this change removes, so the field goes on every failure through
     * one wrapper rather than through twenty-odd hand edits that would miss the twenty-first.
     */
    const routes = stripComments(readFileSync('server/src/api/brain/search.ts', 'utf8'));
    /*
     * By ROUTE, not by the guard in front of it. This counted the literal
     * `requireSpaceAuth, statesRetryability`, so when `/recall` moved to `requireBodyScopedSpace` at 5.0
     * the count fell to two and the gate read it as a route DROPPING the wrapper — a false alarm about
     * the one thing it exists to prevent. The guard is not the subject; the read routes are.
     *
     * `/filter` left this list at `B-9` step 3c with the route itself — a hand-written twin of the tool,
     * deleted so there is one implementation. Its early refusals come from `callTool` now, which the
     * MCP case at the bottom of this file covers: same classification, no status to correct.
     */
    for (const path of ['/recall', '/similar']) {
      const at = routes.indexOf(`searchRouter.post('${path}'`);
      const legacy = at < 0 ? routes.indexOf(`searchRouter.post('/spaces/:spaceId${path}'`) : -1;
      const start = at >= 0 ? at : legacy;
      assert.ok(start >= 0, `${path} is no longer registered on the search router — re-anchor this gate`);
      const decl = routes.slice(start, routes.indexOf('async (req, res)', start));
      assert.match(decl, /statesRetryability/,
        `${path} does not carry statesRetryability, so its early refusals omit \`retryable\``);
    }

    /*
     * A DELEGATING route needs the wrapper AND the tool's structured body, and the second half is the one
     * that was dropped. `/recall` hands its arguments to `callTool`, which classifies a store failure and
     * returns `retryable`, `storeSideFailure` and the driver code in `structuredContent`; a route that
     * answers `{error}` alone throws all of that away and leaves the wrapper to guess from the status.
     */
    const recallAt = routes.indexOf("searchRouter.post('/recall'");
    const recallBody = routes.slice(recallAt, routes.indexOf('searchRouter.', recallAt + 20));
    if (/callTool\(/.test(recallBody)) {
      assert.match(recallBody, /\.\.\.\(outcome\.result\.structuredContent \?\? \{\}\)/,
        'a route delegating to callTool must forward the structured error body, or `retryable` and the '
        + 'driver code are lost between the classifier and the caller');
    }

    const helper = stripComments(readFileSync('server/src/api/brain/_read-failure.ts', 'utf8'));
    assert.match(helper, /res\.statusCode >= 500 \|\| res\.statusCode === 429/,
      '429 is retryable by definition and already documents Retry-After — defaulting it to false would lie');
    assert.match(helper, /\['retryable'\] === undefined/,
      'a body that already states retryable must be left alone, so the classifier always wins over the default');
  });

  it('every read route that catches its own failures answers through the one helper', () => {
    /*
     * Counted, not spot-checked: separate two-line catches are how one route keeps the old behaviour.
     *
     * The count is DERIVED rather than written down, because `/recall` stopped catching anything when it
     * collapsed onto `callTool` — which classifies the failure itself and hands back a status. Pinning the
     * number at three turned that into a red gate about a route that had got safer, and the obvious repair
     * (change 3 to 2) would have to be made again after the next collapse. So the subject is *every route
     * that still has a `catch`*, and the rule is that none of them rolls its own answer.
     */
    const src = stripComments(readFileSync('server/src/api/brain/search.ts', 'utf8'));
    const catches = (src.match(/\}\s*catch\s*\(/g) ?? []).length;
    const delegated = (src.match(/sendReadFailure\(res, [^)]*\berr\)/g) ?? []).length;
    // A floor of ONE, down from two at 3c: `/filter`'s hand-written twin caught its own failures and is
    // gone. The floor exists so an empty scan cannot pass the equality below — it is not a count of the
    // routes, and lowering it as the surface collapses onto `callTool` is this rule succeeding.
    assert.ok(catches >= 1, `only ${catches} catch blocks on the search router — the scan is broken, not the code`);
    assert.equal(delegated, catches,
      `${catches} routes catch a failure and only ${delegated} answer through sendReadFailure`);
    assert.doesNotMatch(src, /res\.status\(400\)\.json\(\{ error: msg \}\)/,
      'a surviving hand-rolled 400 catch is the drift this replaced');
  });

  it('MCP carries the same classification, because it has no status to correct', () => {
    const src = dispatchSource();
    assert.match(src, /classifyReadFailure\(err\)/,
      'the MCP dispatcher must classify too, or an agent gets the truncated prose a REST caller no longer sees');
    assert.match(src, /storeSideFailure: true/,
      'and say so in structuredContent, which is this transport\'s equivalent of a 5xx');
  });

  it('does NOT retry internally — that hid a dead process from the only parties who could see it', () => {
    // the canary operator's third option was a transparent retry with backoff. On 2026-08-19 the cause turned
    // out to be a dead mongot under a degraded array; a retry loop would have turned that into slow successes.
    const src = stripComments(readFileSync('server/src/brain/store-failure.ts', 'utf8'));
    assert.doesNotMatch(src, /setTimeout|await new Promise|for \(let attempt/,
      'classification only — a retry here would paper over the hardware fault it exists to report');
  });
});
