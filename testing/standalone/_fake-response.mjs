/**
 * A response to hand a route's own handler in-process, recording what it sent — the question "what did the handler
 * answer", asked once for every -db test that calls a handler without an HTTP server.
 *
 * ## Why a module
 *
 * Five tests wrote the same object by hand (`a-duplicate-merge-needs-the-merge-rights-where-the-pair-lives-db`,
 * `an-automerge-sees-both-records-seqs-db`, `save-bulk-refuses-a-name-it-does-not-know-on-both-doors-db`,
 * `a-sync-trigger-answers-a-store-failure-in-our-words`, `a-pull-never-passes-an-uncommitted-seq-db`), under four names
 * and two spellings of the status field (`statusCode` and `code`). A test reading `res.code` off a response that
 * recorded `statusCode` reads `undefined`, and `assert.equal(undefined, 200)` is the failure that points at the test.
 *
 * ## What a hand-written copy drops
 *
 * - **`sent`/`headersSent` set by the answer.** A middleware chain walked layer by layer (`layer.handle(req, res, next)`)
 *   stops when a layer answered; a fake that never flips the flag walks past the answer into the next layer.
 * - **Every method a handler chains.** `res.status(c).json(b)`, `.send`, `.end`, `.setHeader`, `.set`, `.get`: a copy
 *   with three of them throws `res.set is not a function` from a handler that sets one header, in a test that was
 *   written for something else.
 * - **A second answer.** A handler that answers twice (an error path that falls through to the success path) is the
 *   defect; `answers` counts them so a test can say "exactly one", and the last write does not silently replace the first.
 *
 * Header names are lower-cased on the way in and out, as the server's own are.
 */

/**
 * @param onAnswer called with the response each time the handler answers — for a test asking what ELSE was true at the
 *        moment of the answer (the push door records the counter as it stood).
 * @returns a response whose `statusCode`, `body`, `headers`, `sent`, `headersSent` and `answers` record what the handler
 *          did. `statusCode` starts at 200, as Express's does.
 */
export function fakeResponse({ onAnswer } = {}) {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    sent: false,
    headersSent: false,
    answers: 0,
    status(code) { res.statusCode = code; return res; },
    setHeader(name, value) { res.headers[String(name).toLowerCase()] = value; return res; },
    set(name, value) { return res.setHeader(name, value); },
    get(name) { return res.headers[String(name).toLowerCase()]; },
    getHeader(name) { return res.get(name); },
    json(body) { return answer(body); },
    send(body) { return answer(body); },
    end(body) { return answer(body); },
  };
  function answer(body) {
    res.body = body;
    res.sent = true;
    res.headersSent = true;
    res.answers++;
    onAnswer?.(res);
    return res;
  }
  return res;
}
