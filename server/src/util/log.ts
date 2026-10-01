// Centralised logger — redacts Authorization header from all output.
// Maintains an in-memory ring buffer for the /api/about/logs endpoint.
// Supports SSE subscribers for real-time log streaming.
// Stamps every line emitted during a request with that request's id — see `runWithRequestId`.

import { AsyncLocalStorage } from 'node:async_hooks';

const REDACTED = 'Bearer [redacted]';
const REDACTED_TOKEN = '[redacted]';
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

/** The current request's id, or undefined outside a request. Exported for the audit path and for tests. */
export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

/**
 * Credential-bearing query parameters.
 *
 * `token` was here for SSE/MCP EventSource auth. The rest are the names a provider endpoint, a webhook
 * target or a signed URL actually uses — any of which can reach a log line by way of an error message
 * that quotes the URL it failed on.
 *
 * Each alternative is anchored to `?` or `&`, so `sort_key=` and `monkey=` are untouched while `?key=`
 * is not. Over-redacting a log line costs a debugging session; under-redacting one puts a live
 * credential in a store that is shipped to an aggregator and retained.
 */
const SECRET_QUERY_PARAMS = /([?&](?:token|api[-_]?key|access[-_]?token|auth|secret|password|passwd|pwd|sig|signature|key)=)[^&\s"']+/gi;

/**
 * URL userinfo — `scheme://user:password@host`.
 *
 * The gap this closes, and it was already documented elsewhere in this repo: `audit-changes.ts` keeps
 * webhook routes out of the audit log entirely because "a webhook URL can embed a credential in
 * userinfo or a query string". That reasoning was applied to the audit store and not to this one, while
 * `webhooks/store.ts` logged the target URL verbatim on creation. Same secret, different retained
 * store, and application logs usually have *broader* access than the admin-only audit API.
 *
 * Matches only between the scheme and the first `/`, so a path or query containing `@` is left alone.
 */
const URL_USERINFO = /([a-z][a-z0-9+.\-]*:\/\/)[^\s/@]+@/gi;

/**
 * Exported so the few places that legitimately write straight to the console — the crash handlers,
 * which must still say something when the process is dying and the ring buffer may never be read — can
 * apply the same rules. A `console.error(err)` beside a redacted `log.error` is not belt and braces; it
 * is the braces quietly undoing the belt, because stdout is what a container log collector captures.
 */
export function redactSecrets(msg: string): string {
  return redact(msg);
}

/** Every character that can end, rewind or hide a log line: C0 controls, DEL, C1 controls, and U+2028/U+2029. */
const LINE_BREAKING = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** The escapes an operator reads at a glance; every other line-breaking character is written `\uXXXX`. */
const SHORT_ESCAPE: Readonly<Record<string, string>> = { '\r': '\\r', '\n': '\\n', '\t': '\\t' };

/**
 * A value from OUTSIDE this instance — a peer's document id, a reason built from its content, a peer's label —
 * made safe to interpolate into a log line: every control character is written as its JSON escape (`\r`, `\n`,
 * `\u001b`), so a value can never start a line of its own or forge one. A document id `x\r\nFORGED ...` arriving
 * by sync otherwise prints a second log line that reads exactly like this server's own.
 *
 * Escape rather than strip, so the operator still sees what was sent. Use it at the interpolation of any
 * peer-supplied value; this server's own text needs nothing.
 */
export function logSafe(value: unknown): string {
  const s = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  return s.replace(LINE_BREAKING, ch => SHORT_ESCAPE[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function redact(msg: string): string {
  return msg
    .replace(/Bearer\s+[A-Za-z0-9_.\-]+/gi, REDACTED)
    .replace(URL_USERINFO, `$1${REDACTED_TOKEN}@`)
    .replace(SECRET_QUERY_PARAMS, `$1${REDACTED_TOKEN}`);
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
  if (meta === undefined) return base;
  if (meta instanceof Error) return `${base} ${redact(meta.stack ?? meta.message)}`;
  return `${base} ${redact(JSON.stringify(meta))}`;
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
