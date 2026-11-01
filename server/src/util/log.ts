// Centralised logger — redacts Authorization header from all output.
// Maintains an in-memory ring buffer for the /api/about/logs endpoint.
// Supports SSE subscribers for real-time log streaming.
// Stamps every line emitted during a request with that request's id — see `runWithRequestId`.

import { AsyncLocalStorage } from 'node:async_hooks';
import { errorChain } from '../db/error-chain.js';
import { errorHeader, textOf, render, escapeLineBreaks, redact, peerText, LOG_VALUE_MAX } from '@ythril/schema/internal';

const MAX_RING = 1000;
const _ring: string[] = [];

type LogSubscriber = (line: string) => void;
const _subscribers = new Set<LogSubscriber>();

/**
 * The id of the request whose work is currently running, so every log line can carry it.
 *
 * ## Why this exists
 *
 * `X-Request-Id` is returned on every response, and two doc pages described it as being "logged server-side"
 * "for log correlation". It reached exactly ONE log line: the unhandled-error handler. So a caller reporting a
 * failure handed over an id that matched nothing in the log unless the failure happened to be an unhandled
 * exception — and every failure that is HANDLED, which is most of them, logged without it: a 507 quota refusal,
 * a 503 readiness answer, a WARN from the media worker mid-request. Those are the lines an operator actually
 * needs to find, and they were the ones with no id.
 *
 * ## Why AsyncLocalStorage rather than a parameter
 *
 * Threading an id through every function that might log would be a change to hundreds of call sites, most of
 * which do not know they are inside a request — and any one of them missed would leave a silent hole exactly
 * where the old behaviour already was. This makes the id ambient for the duration of the request, so lines
 * written by code that has never heard of requests are still correlated.
 *
 * Losing the context is harmless by construction: `store` is undefined, and the line is emitted without an id,
 * which is the behaviour every line had before. There is no path where this can throw or block.
 *
 * ## THE ONE PLACE IT DOES NOT REACH, measured rather than assumed
 *
 * An EventEmitter listener is NOT bound to the async context it was registered in — `emit` runs it in the
 * emitter's context. Probed directly: a listener registered inside `AsyncLocalStorage.run` and fired on a later
 * tick from outside reads `undefined`. So a line logged from `res.on('finish')`, a socket `'error'`, or a child
 * process `'close'` carries no id even though the request is still nominally in progress.
 *
 * Two such lines exist today, both `log.debug` and neither a failure an operator would correlate: an MCP session
 * close and a spawned-connector error. They are left alone rather than plumbed, because capturing the id into a
 * local and re-entering the context at each listener is real complexity for two debug lines. **What matters is
 * that the limit is written down here** — the next person to add a log line inside a listener should know it will
 * not be correlated, and anyone extending this should know `currentRequestId()` returns undefined there. The
 * audit writer, which runs in exactly such a callback, has to capture the id at middleware time instead.
 */
const requestContext = new AsyncLocalStorage<{ requestId: string }>();

/**
 * Run `fn` with `requestId` attached to every log line it and its descendants emit.
 *
 * Called once, by the request-id middleware, so it wraps the whole request including everything awaited inside
 * it. Deliberately NOT exported as a setter: a set-and-forget id would leak into the next request handled on
 * the same tick, and a log line stamped with somebody else's request id is worse than one with none.
 */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return requestContext.run({ requestId }, fn);
}

/**
 * Run `fn` with NO request id: what a tick of background work is run through, so that it never carries the id of whoever started it.
 *
 * ## What it prevents
 *
 * Node timers (and `node-cron`'s, which are built on them) inherit the `AsyncLocalStorage` context they were created in. A job armed
 * while a request was being handled ran every tick inside that request's context: on a first-run instance the TTL sweep is started from
 * the `/setup` request and its failure line carried the setup request's id for the life of the process, and the cron schedulers a config
 * reload re-arms did the same under the reload's id. A line stamped with another request's id is worse than one with none: a search for
 * that request finds work that has nothing to do with it.
 *
 * `intervalJob` (`util/interval-job.ts`) goes through here for every interval job, so no caller can forget. A cron registration is a
 * library call that cannot have the guard put inside it, so its callback goes through here and a gate holds every registration to that
 * (`a-background-tick-carries-no-request-id`). Work a REQUEST starts and awaits (a manual scan from a route) keeps the request's id on
 * purpose: it is the request's own work, which is why `runExclusive` does not use this.
 *
 * `fn`'s continuations are outside the request too. The caller's own context is untouched.
 */
export function outsideRequest<T>(fn: () => T): T {
  return requestContext.exit(fn);
}

/** The current request's id, or undefined outside a request. Exported for the audit path and for tests. */
export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}


/*
 * How a value from OUTSIDE is said in a line or a refusal — `peerText`, `peerList`, the secret redaction and `refusalOfParse` — is
 * `@ythril/schema`'s (`schema/src/text.ts`), because a schema refusal the package words and a line this logger writes must say a value
 * the same way. Re-exported, so every module (and every gate) that reads them from here reads the one definition.
 */
export {
  redactSecrets, LOG_VALUE_MAX, peerText, logSafe, NAME_QUOTED, peerList, REFUSAL_NAMES_MAX, refusalOfParse, unrecognizedKeysIssue,
  type ParseRefusalIssue, type ParseRefusal, type ParseRefusalOptions, type ParseIssueLike,
} from '@ythril/schema/internal';

/**
 * An Error for the line `fmt` writes when it is the meta argument (bundle-30 `B4`): its stack is KEPT — the frames
 * are this server's own code, and `reportServerFailure` exists to leave them behind — while its message goes through
 * the same rule as any outside value (a driver's message can carry a peer's `_id`), bounded to half the budget so the
 * frames keep the rest. The whole is then bounded once more by its caller.
 *
 * **What the error wraps is said too**, between the header and the frames, one `caused by:` per wrapped error (`errorChain`, the one
 * walk: `cause`, `underlying`, a driver wrapper's thrown error, an aggregate's members). A server failure answered with a sentence
 * that says "the reason is in the server log" has its reason in the error UNDER the wrapper, and a line that printed only the wrapper
 * sent the operator to a log that did not hold it. It is here, in the one place a 5xx is rendered, so no door has to remember it.
 */
function errorWithStack(err: Error): string {
  const header = errorHeader(err);
  const causes = causesOf(err);
  let frames = '';
  try {
    const stack = typeof err.stack === 'string' ? err.stack : '';
    // The frames start after the message the stack repeats, so a message holding "\n    at " is not read as frames.
    const message = typeof err.message === 'string' ? err.message : '';
    const from = message.length > 0 && stack.includes(message) ? stack.indexOf(message) + message.length : 0;
    const at = stack.indexOf('\n    at ', from);
    frames = at === -1 ? '' : stack.slice(at);
  } catch { /* no frames, then */ }
  return `${render(header, LOG_VALUE_MAX / 2)}${causes}${frames}`;
}

/** The most wrapped errors one line names; the rest are a count. A line that grows with its chain pushes the frames out of its budget. */
const CAUSES_MAX = 4;

/** What `err` wraps, as `\ncaused by: <header>` lines (empty when it wraps nothing); never throws. */
function causesOf(err: Error): string {
  try {
    const wrapped = errorChain(err).slice(1);
    const lines = wrapped.slice(0, CAUSES_MAX).map(e => `\ncaused by: ${render(e instanceof Error ? errorHeader(e) : textOf(e), LOG_VALUE_MAX / 4)}`);
    const more = wrapped.length - CAUSES_MAX;
    return lines.join('') + (more > 0 ? `\ncaused by: …(+${more} more)` : '');
  } catch {
    return '';
  }
}


function fmt(level: string, msg: string, meta?: unknown): string {
  const ts = new Date().toISOString();
  /*
   * The id goes BEFORE the message and after the level, so a grep for the id finds the line whatever the
   * message is, and the existing shape `[ts] [LEVEL] …` is unchanged for a line emitted outside a request —
   * which is every boot line, every scheduled sweep, and everything the log viewer already renders.
   */
  const rid = currentRequestId();
  const base = `[${ts}] [${level}]${rid ? ` [${rid}]` : ''} ${redact(msg)}`;
  /*
   * The meta argument is rendered here, by the rule every outside value follows, so no call site has to remember
   * it (bundle-30 `B4`): an Error keeps its stack and has its message bounded (`errorWithStack`), anything else is
   * `peerText`. And the line as a whole is escaped: what the slots of `msg` were not trusted with (the gate holds
   * every door's slots to `peerText`), a line still cannot be split by — a log line is one line.
   */
  const line = meta === undefined ? base
    : `${base} ${meta instanceof Error ? peerText(errorWithStack(meta)) : peerText(meta)}`;
  return escapeLineBreaks(line);
}

function emit(line: string): void {
  _ring.push(line);
  if (_ring.length > MAX_RING) _ring.shift();
  for (const sub of _subscribers) {
    try { sub(line); } catch { /* ignore */ }
  }
}

export const log = {
  info: (msg: string, meta?: unknown) => { const l = fmt('INFO ', msg, meta); emit(l); console.log(l); },
  warn: (msg: string, meta?: unknown) => { const l = fmt('WARN ', msg, meta); emit(l); console.warn(l); },
  error: (msg: string, meta?: unknown) => { const l = fmt('ERROR', msg, meta); emit(l); console.error(l); },
  debug: (msg: string, meta?: unknown) => {
    if (process.env['DEBUG']) { const l = fmt('DEBUG', msg, meta); emit(l); console.log(l); }
  },
};

/** Return the last `n` log lines from the in-memory ring buffer. */
export function getLogLines(n: number): string[] {
  const clamped = Math.max(1, Math.min(n, MAX_RING));
  return _ring.slice(-clamped);
}

/** Subscribe to new log lines. Returns an unsubscribe function. */
export function subscribeLogLines(cb: LogSubscriber): () => void {
  _subscribers.add(cb);
  return () => { _subscribers.delete(cb); };
}
