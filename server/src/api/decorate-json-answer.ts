/**
 * Decorate a JSON answer ONCE per request, whichever of a route's dozen `res.status(n).json(...)` sites gave it.
 *
 * ## The question this module answers
 *
 * "How does a thing that must ride on EVERY answer of a request — whatever status, whichever line of the handler sent it — get onto it
 * without each line remembering?" The answer is a wrapper on `res.json`, and it existed once by hand (`statesRetryability`, which puts
 * `retryable` on every failure of a read route) before the unknown-write-field judge (Q-320, bundle-128) needed the same thing for the
 * `warnings` rows of a write. Two hand-written wrappers differ in the half nobody remembers, so the shape lives here and both go
 * through it; `one-module-decorates-a-json-answer.test.js` refuses an assignment to a `.json` property anywhere else in `server/src`.
 *
 * ## What it does not let a caller drop
 *
 * - **Plain objects only.** An array, a string, a number, `null` (a body that is not a bag of keys) is sent as it is and never handed to
 *   the decorator: it could only invent fields on something that has none.
 * - **It copies, never mutates.** The decorator is handed a shallow COPY, and what it returns is what is sent. Some route bodies are
 *   shared constants (`const NOT_FOUND = { error: … }`), and a decorator that wrote to its argument would change what the NEXT request is
 *   answered with.
 * - **It never throws.** A decorator that throws leaves the answer exactly as the route gave it — it must not turn a write that landed
 *   into a 500 — and the failure is said once through `warnOnce`, never silently and never once per request.
 * - **One wrapper per request per decorator.** `key` names the decorator; installing the same key twice on one request does not stack, so
 *   a second judge call on a request does not add its rows twice. Different keys stack, and the one installed LAST runs FIRST (each
 *   wraps what `res.json` was when it was installed), so a route's decorator, installed after the `statesRetryability` middleware, runs
 *   before it, and the retryability wrapper then sees the decorated body.
 *
 * The decorator is told the status the route set (`res.statusCode` at the moment `json` is called, so `res.status(409).json(…)` and a
 * bare `res.json(…)` both read truthfully), because which answers a decoration belongs on is a question about the status.
 */
import type express from 'express';
import { log, peerText } from '../util/log.js';
import { warnOnce } from '../util/warn-once.js';

/** The marker on a response: the keys of the decorators already installed on it. A symbol, so no body or header can collide with it. */
const INSTALLED = Symbol('decorateJsonAnswer.installed');

/** What a decorator is: the route's status and a COPY of the plain-object body in, the body to send out. */
export type JsonAnswerDecorator = (status: number, body: Record<string, unknown>) => Record<string, unknown>;

/** Which decorators have been said to throw, once each, for as long as the process lives (a decorator is code: there are few). */
const failureSaid = warnOnce<string>();

const isPlainObject = (body: unknown): body is Record<string, unknown> =>
  body !== null && typeof body === 'object' && !Array.isArray(body);

/**
 * Wrap `res.json` so every plain-object answer of this request passes through `decorate` (see the module comment for the contract).
 *
 * @param res       the response of the request being answered
 * @param key       a name for this decorator, so installing it twice on one request applies it once
 * @param decorate  `(status, body copy) => body to send`
 */
export function decorateJsonAnswer(res: express.Response, key: string, decorate: JsonAnswerDecorator): void {
  const holder = res as unknown as { [INSTALLED]?: Set<string> };
  const installed = (holder[INSTALLED] ??= new Set<string>());
  if (installed.has(key)) return;
  installed.add(key);

  const inner = res.json.bind(res);
  res.json = (body: unknown) => {
    if (!isPlainObject(body)) return inner(body);
    let decorated: unknown;
    try {
      decorated = decorate(res.statusCode, { ...body });
    } catch (err) {
      reportFailure(key, err);
      return inner(body);
    }
    if (!isPlainObject(decorated)) {
      reportFailure(key, new Error('the decorator returned something that is not a plain object'));
      return inner(body);
    }
    return inner(decorated);
  };
}

/** A decorator that failed is said once per decorator and per reason; the answer it was decorating is sent as the route gave it. */
function reportFailure(key: string, err: unknown): void {
  const why = peerText(err instanceof Error ? err.message : err);
  failureSaid(key, () => {
    log.warn(`json answer decorator '${peerText(key)}' failed and its answer was sent undecorated: ${why}`);
  }, why);
}

/**
 * Did this answer leave a RECORD behind although it is not a success — the stored record whose connections were not written
 * (`ConnectionsNotWritten`, `brain/connections-not-written.ts`), whose body carries `written` and whose status is 5xx?
 *
 * The one predicate both doors ask. A plain store-failure body (`sendCaughtFailure` keeps it generic on purpose) carries no `written`:
 * nothing was stored, so there is nothing to name beside it. A body with `written` as `null` or as anything but an object says nothing
 * was written, and is not this.
 */
export function answerLeftARecord(body: unknown): boolean {
  return isPlainObject(body) && isPlainObject(body['written']);
}

/**
 * Does an answer of this status and body carry the rows of the unknown-field judge (`contract/write-accepts.ts`)? Every answer of a
 * judged call does — a success, a refusal for another reason, a 412 — EXCEPT a 5xx where nothing was stored: a plain store failure is
 * generic on purpose, and the caller's next step is to retry, not to read its body. A 5xx that left a record behind
 * ({@link answerLeftARecord}) does carry them: the record is stored, and so is whatever it carried.
 *
 * One function, so the REST decorator and the MCP outcome wrapper (`withUnknownFieldRows`) cannot decide it two ways.
 */
export function answerCarriesUnknownFieldRows(status: number, body: unknown): boolean {
  return status < 500 || answerLeftARecord(body);
}
