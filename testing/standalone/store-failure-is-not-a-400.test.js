/**
 * A failure of the STORE answers 503 and says it is retryable; a bad request still answers 400.
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
 * Run: node --test testing/standalone/store-failure-is-not-a-400.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchSource } from './_tool-dispatch.mjs';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const { classifyReadFailure, storeFailureDetail } = await import('../../server/dist/brain/store-failure.js');

/** A driver error, shaped the way the MongoDB node driver actually shapes one. */
const mongoErr = (name, fields = {}) => Object.assign(new Error(fields.message ?? 'boom'), { name, ...fields });

describe('the reported condition, verbatim from both reports', () => {
  /**
   * The exact string both parties quoted, from two different instances. It is the whole reason the classifier
   * matches on a message at all — neither failing instance is ours to probe for a code.
   */
  const REPORTED = 'Executor error during aggregate command on namespace: '
    + 'ythril_the fleet integrator.orchestrator_facts :: caused by :: ';

  it('is a 503, is retryable, and stops reading as a complaint about the request', () => {
    const f = classifyReadFailure(mongoErr('MongoServerError', { message: REPORTED }));
    assert.equal(f.status, 503, 'a store failure is not a client error');
    assert.equal(f.retryable, true);
    assert.ok(f.retryAfterSeconds > 0, 'and it must say how long to wait');
  });

  it('closes the dangling `caused by ::` rather than shipping a half sentence', () => {
    // THE symptom: the message ends mid-sentence, which a caller reads as a truncated complaint about their
    // own request. An operator could not tell whether the gap was the store's or our logging.
    // Since bundle-30 I8 the driver's account is the operator's LOG line (`storeFailureDetail`) and the answer is in
    // our words — it names internal hosts and ports (`no-door-answers-with-the-drivers-text`). So the half sentence
    // is closed where it is read now, and the caller is told whose fault it is.
    const err = mongoErr('MongoServerError', { message: REPORTED });
    const detail = storeFailureDetail(err);
    assert.doesNotMatch(detail, /caused by ::\s*$/, 'the logged line must not still end at `caused by ::`');
    assert.match(detail, /the store reported no cause/,
      'when nothing was attached, say so — that is the answer to "is the gap yours or ours?"');
    assert.match(classifyReadFailure(err).error, /store-side failure/i,
      'and the caller is told whose fault it is, because the status alone is not read by a human');
    assert.doesNotMatch(classifyReadFailure(err).error, /caused by/, 'and is never told the driver\'s text');
  });

  it('fills the cause in from the driver when there IS one — in the log, and the code in the answer', () => {
    const err = mongoErr('MongoServerError', {
      message: REPORTED,
      errmsg: 'mongot connection closed',
      codeName: 'InternalError',
      code: 8,
    });
    const f = classifyReadFailure(err);
    assert.match(storeFailureDetail(err), /mongot connection closed/, 'the real reason must reach the operator');
    assert.doesNotMatch(f.error, /mongot connection closed/, 'and not the caller');
    assert.equal(f.code, 8, 'the code is stable, names no host, and is an operator\'s fastest route to the condition');
    assert.equal(f.codeName, 'InternalError');
    assert.doesNotMatch(storeFailureDetail(err), /the store reported no cause/,
      'that phrase is for an EMPTY cause and would be a lie next to a real one');
  });

  it('reads a nested `cause`, which is where the empty one was hiding', () => {
    const err = mongoErr('MongoServerError', {
      message: 'Executor error during find command',
      cause: new Error('connection 4 to 10.1.2.3:27017 closed'),
    });
    assert.match(storeFailureDetail(err), /connection 4 to 10\.1\.2\.3:27017 closed/);
    assert.doesNotMatch(classifyReadFailure(err).error, /10\.1\.2\.3/);
  });
});

describe('the store cases, each identified positively', () => {
  for (const name of ['MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoServerSelectionError',
    'MongoTopologyClosedError', 'MongoNotConnectedError']) {
    it(`${name} is the store`, () => {
      const f = classifyReadFailure(mongoErr(name));
      assert.equal(f.status, 503, `${name} means the store did not answer`);
      assert.equal(f.retryable, true);
    });
  }

  for (const [code, why] of [[11600, 'InterruptedAtShutdown'], [91, 'ShutdownInProgress'],
    [11602, 'InterruptedDueToReplStateChange'], [189, 'PrimarySteppedDown'],
    [13436, 'NotPrimaryOrSecondary'], [50, 'MaxTimeMSExpired'], [262, 'ExceededTimeLimit']]) {
    it(`MongoServerError code ${code} (${why}) is the store`, () => {
      const f = classifyReadFailure(mongoErr('MongoServerError', { code }));
      assert.equal(f.status, 503, `${why} is not answerable right now, and will be`);
      assert.equal(f.retryable, true);
    });
  }

  it('a $vectorSearch failure is the store even without a recognised code', () => {
    const f = classifyReadFailure(mongoErr('MongoServerError',
      { message: 'PlanExecutor error :: $vectorSearch index not queryable' }));
    assert.equal(f.status, 503);
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
    // A MongoServerError with a code that is NOT on the allowlist: a bad regex, a projection conflict.
    // The name alone must not be enough, or every caller mistake becomes "retry for ever".
    null,
  ];
  for (const msg of clientErrors.filter(Boolean)) {
    it(`stays 400: ${msg.slice(0, 44)}`, () => {
      const f = classifyReadFailure(new Error(msg));
      assert.equal(f.status, 400, 'a refusal the caller can fix must stay a refusal');
      assert.equal(f.retryable, false, 'and must NOT invite a retry that will fail identically');
      assert.equal(f.error, msg, 'and its message must be unchanged — callers match on these');
    });
  }

  it('a MongoServerError with an unlisted code stays 400 — the name is not enough', () => {
    const f = classifyReadFailure(mongoErr('MongoServerError',
      { code: 18, message: 'Authentication failed.' }));
    assert.equal(f.status, 400, 'AuthenticationFailed will never succeed on a retry');
    assert.equal(f.retryable, false);
  });

  it('a plain Error with no name and no code stays 400', () => {
    const f = classifyReadFailure(new Error('something went wrong'));
    assert.equal(f.status, 400);
    assert.equal(f.retryable, false);
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
  it('`retryable` is on EVERY failure body, not only the retryable ones', async () => {
    // A field that appears only when it is true is a field whose absence has to be interpreted, and the caller
    // who most needs it is the one who does not know to look — the same argument as the budget's accounting.
    // Asserted on what is SENT, for a store failure and a request's own: the spelling moved into the one answer
    // (`storeFailureAnswer`, bundle-30 I6 C1), and a gate on the spelling would follow it rather than the rule.
    const { sendReadFailure } = await import('../../server/dist/api/brain/_read-failure.js');
    const sent = (err) => {
      const out = { headers: {} };
      const res = {
        setHeader: (k, v) => { out.headers[k] = v; },
        status: (s) => { out.status = s; return res; },
        json: (b) => { out.body = b; return res; },
      };
      sendReadFailure(res, err);
      return out;
    };
    const store = sent(mongoErr('MongoNetworkError', { message: 'socket closed' }));
    const own = sent(new Error('unknown operator $nope'));
    assert.deepEqual([store.status, store.body?.retryable, store.headers['Retry-After'] !== undefined], [503, true, true]);
    assert.deepEqual([own.status, own.body?.retryable], [400, false],
      'the field must be sent unconditionally, not spread in behind a condition');
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

  it('every search route answers a failure through one classifier — its own catch via the helper, or through callTool', () => {
    /*
     * Counted, not spot-checked: separate two-line catches are how one route keeps the old behaviour.
     *
     * The subject is the ROUTES, not the catches. This counted `catch` blocks with a floor of one, and every
     * search route that could fail on the store has since collapsed onto `callTool` — `/filter` at 3c,
     * `/recall`, then `/similar` at `Q-89` — which classifies the failure itself and hands back a status. So
     * the file has no catch left, and a floor on catches would have to be lowered to zero, where an empty scan
     * passes. A floor on the routes found cannot be satisfied by a scan that read nothing.
     *
     * The rule, per route: a route that catches answers through `sendReadFailure`; a route that delegates to
     * `callTool` forwards the classifier's structured body. Neither rolls its own 400.
     */
    const src = stripComments(readFileSync('server/src/api/brain/search.ts', 'utf8'));
    const starts = [...src.matchAll(/searchRouter\.(?:get|post|put|patch|delete)\(/g)].map(m => m.index);
    assert.ok(starts.length >= 2, `only ${starts.length} route(s) found on the search router — the scan is broken, not the code`);
    const routes = starts.map((at, i) => src.slice(at, starts[i + 1] ?? src.length));
    let delegating = 0;
    for (const body of routes) {
      const name = body.slice(0, body.indexOf(','));
      const catches = (body.match(/\}\s*catch\s*\(/g) ?? []).length;
      const delegated = (body.match(/sendReadFailure\(res, err\)/g) ?? []).length;
      assert.equal(delegated, catches,
        `${name} catches ${catches} failure(s) and only ${delegated} answer through sendReadFailure`);
      if (/callTool\(/.test(body)) {
        delegating++;
        assert.match(body, /\.\.\.\(outcome\.result\.structuredContent \?\? \{\}\)/,
          `${name} delegates to callTool and drops its structured error body, so the classification never reaches the caller`);
      }
    }
    // The routes that used to catch are the delegating ones now; none found means the anchor moved, not that they left.
    assert.ok(delegating >= 1, 'no search route delegates to callTool — re-anchor this gate');
    assert.doesNotMatch(src, /res\.status\(400\)\.json\(\{ error: msg \}\)/,
      'a surviving hand-rolled 400 catch is the drift this replaced');
  });

  it('MCP carries the same classification, because it has no status to correct', () => {
    const src = dispatchSource();
    assert.match(src, /storeFailureAnswer\(err\)/,
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
