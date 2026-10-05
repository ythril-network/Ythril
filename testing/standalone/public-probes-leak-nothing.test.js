/**
 * `/health` and `/ready` are public. They must say whether to send traffic, and nothing about the deployment.
 *
 * ## The finding — Observability & Operability audit lens
 *
 * Both probes are registered **before every authentication middleware**, and they have to be: an orchestrator
 * cannot carry a token. `/ready` returned the MongoDB driver's error message verbatim in
 * `checks.mongodb.error`, and those messages describe the infrastructure. Measured against the real driver, not
 * assumed:
 *
 *     mongodb://appuser:…@mongo-a.internal:27017,mongo-b.internal:27017/ythril?replicaSet=rs0
 *       → "getaddrinfo ENOTFOUND mongo-a.internal"
 *
 * No credential leaked in any case tried — the driver is careful about that. Internal hostnames did, and other
 * topology failures name internal addresses and ports.
 *
 * It also made `/ready` the **only** route in the product that answered this way. The global error handler logs
 * the detail and returns a flat `Internal server error`; the two other public routers (`setup`, `theme`) echo
 * nothing. The three admin routers that do echo a raw message are behind auth, where it is useful.
 *
 * And the detail was logged **nowhere**: it went to whoever probed the endpoint and was then discarded, so an
 * operator watching a failing pod's logs saw silence. Classifying it fixed both halves — the response carries a
 * code, the log carries the message, once per transition.
 *
 * Run: node --test testing/standalone/public-probes-leak-nothing.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(p, 'utf8');
const READY = read('server/src/ready.ts');

/**
 * Every reason code the `CheckReason` union declares, read out of the type.
 *
 * Two cases here asserted a hand-written list of them — one naming six, the other five — and the second is
 * the one that mattered: it claims the hosting guide documents EVERY code, and `error` was outside it. That
 * code happens to be documented, so nothing was wrong; nothing would have said so if it were not.
 *
 * Bounded at the next DECLARATION rather than at the first `;`, because one of the trailing comments
 * contains a semicolon ("connected to a secondary; writes would fail") — a convenience slice hid two of the
 * six codes once already.
 */
function checkReasons() {
  const at = READY.indexOf('export type CheckReason');
  const end = READY.indexOf('export interface CheckResult', at);
  if (at < 0 || end <= at) throw new Error('CheckReason is gone or unbounded — re-anchor this parser');
  return [...READY.slice(at, end).matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
}
const APP = read('server/src/app.ts');

/** The `/ready` handler, from its registration to the next route registration. */
function readyHandler() {
  const at = APP.indexOf("app.get('/ready'");
  assert.ok(at > 0, 'the /ready route is gone');
  const end = APP.indexOf("app.use('/metrics'", at);
  assert.ok(end > at, 'could not bound the /ready handler');
  return APP.slice(at, end);
}

describe('the probes are public — that is the premise', () => {
  it('/health and /ready are registered before any auth middleware', () => {
    // If this ever stops being true the leak stops mattering, and this whole file should be revisited rather
    // than left asserting something that no longer describes the code.
    const health = APP.indexOf("app.get('/health'");
    const ready = APP.indexOf("app.get('/ready'");
    const audit = APP.indexOf('app.use(auditMiddleware)');
    assert.ok(health > 0 && ready > 0, 'the probe routes are gone');
    assert.ok(health < audit && ready < audit,
      'the probes are no longer ahead of the middleware stack — re-check whether they are still unauthenticated');
  });

  it('/health returns a fixed shape with no environment detail', () => {
    const at = APP.indexOf("app.get('/health'");
    const body = APP.slice(at, APP.indexOf("app.get('/ready'", at));
    assert.match(body, /status:\s*'ok'/, 'the liveness probe should stay a constant');
    assert.doesNotMatch(body, /version|hostname|process\.env|getConfig/,
      'liveness must not describe the instance: it is the most reachable endpoint there is');
  });
});

describe('a failing check reports a code, never the driver message', () => {
  it('the payload type carries a reason, and no message field', () => {
    assert.match(READY, /reason\?:\s*CheckReason/, 'CheckResult must carry a classified reason');
    assert.doesNotMatch(READY, /^\s*error\?:\s*string/m,
      'CheckResult must not have a free-text error field — that is what leaked internal hostnames');
  });

  it('no check returns an error message in its result', () => {
    // The specific shape that leaked: `error: err instanceof Error ? err.message : String(err)`.
    assert.doesNotMatch(READY, /error:\s*err instanceof Error \? err\.message/,
      'a check is putting the raw driver message back into the response');
    assert.doesNotMatch(READY, /error:\s*(msg|message)\b/, 'a check is returning a message field');
  });

  it("the handler's own catch branch classifies too", () => {
    // Easy to miss: the route has a second failure path, for `getReadiness()` itself throwing, and it built its
    // own payload by hand. That was the first place the message came back.
    const body = readyHandler();
    assert.match(body, /classifyCheckError\(/, 'the catch branch must classify rather than echo');
    assert.doesNotMatch(body, /error:\s*message/, 'the catch branch is still echoing the message');
  });

  it('every reason is a fixed code an alert can key on', () => {
    const at = READY.indexOf('export type CheckReason');
    assert.ok(at > 0, 'CheckReason is gone');
    // Sliced to the next DECLARATION, not to the first `;`. A `;` inside one of the trailing comments
    // ("connected to a secondary; writes would fail") truncated the slice and hid two of the six codes — the
    // same convenience-slice mistake as the last two batches, caught the same way.
    const end = READY.indexOf('export interface CheckResult', at);
    assert.ok(end > at, 'could not bound the CheckReason declaration');
    const decl = READY.slice(at, end);
    // Every member of the union is a quoted literal, which is the CLAIM -- not "these six are present",
    // which is a fixture of what the union happened to hold the day it was written.
    const codes = checkReasons();
    assert.ok(codes.length >= 6, `parsed only ${codes.length} reason codes -- the parser is wrong, not the code`);
    for (const code of codes) {
      assert.match(decl, new RegExp(`'${code}'`), `the ${code} reason is missing`);
      assert.doesNotMatch(code, /[^a-z_]/,
        `${code} is not a fixed code an alert can key on -- a reason must be greppable and stable`);
    }
  });
});

describe('the classifier, on the strings the driver actually produces', () => {
  // Captured from a real `mongodb` driver rather than invented, which is the only reason these are worth pinning.
  const CASES = [
    ['getaddrinfo ENOTFOUND mongo-a.internal', 'unreachable'],
    ["Socket 'connect' timed out after 1211ms (connectTimeoutMS: 1200)", 'unreachable'],
    ['Authentication failed.', 'auth_failed'],
    ['connection 4 to 10.1.2.3:27017 closed', 'unreachable'],
    ['timed out after 2000ms', 'timeout'],
    ['not primary and secondaryOk=false', 'not_primary'],
    ['Unrecognized pipeline stage name: $vectorSearch', 'unsupported'],
    ['something nobody predicted', 'error'],
  ];

  it('classifies each one as expected', async () => {
    const { classifyCheckError } = await import('../../server/dist/ready.js');
    const wrong = [];
    for (const [msg, expected] of CASES) {
      const got = classifyCheckError(new Error(msg));
      if (got !== expected) wrong.push(`${JSON.stringify(msg)} → ${got}, expected ${expected}`);
    }
    assert.deepEqual(wrong, [], `misclassified:\n  ${wrong.join('\n  ')}`);
  });

  it('never returns the input', async () => {
    // The point of the whole exercise: whatever comes in, what comes out is one of six words.
    const { classifyCheckError } = await import('../../server/dist/ready.js');
    const secretish = 'mongodb://appuser:sup3rS3cret@mongo-a.internal:27017 refused the connection';
    const out = classifyCheckError(new Error(secretish));
    assert.doesNotMatch(out, /sup3rS3cret|mongo-a\.internal/, 'the classifier is passing input through');
    assert.ok(['unreachable', 'timeout', 'auth_failed', 'not_primary', 'unsupported', 'error'].includes(out),
      `unexpected reason: ${out}`);
  });
});

describe('the detail goes to the log instead of being discarded', () => {
  it('a failure is logged with the full message', () => {
    assert.match(READY, /log\.warn\(/, 'a readiness failure must be logged — it used to be logged nowhere at all');
    const at = READY.indexOf('function logTransition');
    assert.ok(at > 0, 'the transition logger is gone');
    const fn = READY.slice(at, READY.indexOf('\n}', at));
    assert.match(fn, /\$\{(?:peerText\()?detail\)?\}/, 'the log line must include the underlying message');
  });

  it('it logs on TRANSITION, not on every poll', () => {
    // A Kubernetes probe runs every few seconds. Logging each failure would bury the rest of the log in copies
    // of one line, which is how a well-meant log line becomes a reason to turn logging down.
    const at = READY.indexOf('function logTransition');
    const fn = READY.slice(at, READY.indexOf('\n}', at));
    assert.match(fn, /_lastState\.get\(check\) === key/, 'repeated identical states must be suppressed');
    assert.match(fn, /recovered/, 'recovery must be logged too, or the log never says the outage ended');
  });

  it('each check reports its state on success as well as failure', () => {
    // set-claim: the two readiness CHECKS the endpoint performs, each with its own transition assertion.
    // A third check would arrive with its own case, because its states are per-check.
    // Without the success call there is no transition to detect, so recovery is silent.
    for (const check of ['mongodb', 'vectorSearch']) {
      assert.match(READY, new RegExp(`logTransition\\('${check}', 'ok'\\)`),
        `${check} never reports success, so a recovery cannot be noticed`);
    }
  });
});

describe('it is documented', () => {
  it('the hosting guide lists every reason code and says where the detail went', () => {
    const doc = read('docs/integration-guide/02-hosting.md');
    const at = doc.indexOf('What `/ready` returns');
    assert.ok(at > 0, 'the /ready payload section is gone');
    const section = doc.slice(at, doc.indexOf('\n#### ', at + 10));
    // EVERY code the union declares, parsed. This named five of the six -- `error` was documented anyway,
    // and would not have been noticed here if it had not been. A seventh must reach the guide or fail here.
    for (const code of checkReasons()) {
      assert.match(section, new RegExp(`\`${code}\``), `${code} is undocumented, so nobody can alert on it`);
    }
    assert.match(section, /before every authentication middleware|public/i,
      'the section must say why the payload is terse — otherwise it reads as an omission');
    assert.match(section, /log/i, 'it must say where the full message went');
  });
});
