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
 *
 * **The lookbehind is what keeps it linear** (bundle-30 `R9`). Without it a match could START at every character
 * of a run of scheme characters, and each start scanned the rest of the run looking for `://`: 40 000 letters
 * took 0.7 s and the cost grew with the square, so a peer's megabyte `_id` of letters was minutes of event loop
 * on the line that logged it. A scheme now starts only where no scheme character precedes it, so each run is
 * scanned once; a real URL is always preceded by something else (a space, a quote, `=`, the start of the text).
 */
const URL_USERINFO = /(?<![a-z0-9+.\-])([a-z][a-z0-9+.\-]*:\/\/)[^\s/@]+@/gi;

/**
 * A URL authority still open where a value was cut for redaction — `https://user:pass` with its `@` past the
 * window. `peerText` redacts a bounded window of a value, and `URL_USERINFO` needs the `@` that ends a userinfo:
 * without this, a password longer than the window's margin would reach the line half-written.
 */
const OPEN_USERINFO_AT_END = /(?<![a-z0-9+.\-])([a-z][a-z0-9+.\-]*:\/\/)[^\s/@]*$/i;

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

/** One line-breaking character, written as the escape an operator reads. */
const escapeChar = (ch: string): string => SHORT_ESCAPE[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;

/** `text` with every line-breaking character escaped — the one place `LINE_BREAKING` is applied. */
function escapeLineBreaks(text: string): string {
  return text.replace(LINE_BREAKING, escapeChar);
}

/**
 * The most characters of one value a log line carries (`peerText`), and of one joined list (`peerList`).
 *
 * Large enough for a stack trace and any honest id, label or reason; small enough that a line built of a handful
 * of values stays a line. A value past it is cut and says by how much (`…(+N chars)`).
 */
export const LOG_VALUE_MAX = 4096;

/**
 * How far past `LOG_VALUE_MAX` a value is read for redaction before it is cut: longer than any credential shape
 * the redactor knows, so a secret straddling the cut is still recognised whole — and short enough that redacting
 * a megabyte value costs what redacting a line costs (bundle-30 `R9`). A URL authority the window itself cuts
 * open is redacted to its end (`OPEN_USERINFO_AT_END`).
 */
const REDACT_MARGIN = 1024;

/** How many elements of a list `peerList` shows before it says how many more there were. */
const LIST_MAX = 100;

/** The text of a value nobody could render: what a line says rather than throwing from inside a `catch`. */
const UNRENDERABLE = '[unrenderable value]';

/** An Error's `name: message` (`message` alone for a plain `Error`), never throwing on a hostile getter. */
function errorHeader(err: Error): string {
  try {
    const message = typeof err.message === 'string' ? err.message : String(err.message);
    const name = typeof err.name === 'string' ? err.name : 'Error';
    return name === 'Error' || name === '' ? message : `${name}: ${message}`;
  } catch {
    return UNRENDERABLE;
  }
}

/** Any value as text, never throwing: a string as itself, an Error as its header, anything else as JSON or `String`. */
function textOf(value: unknown): string {
  try {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return errorHeader(value);
    if (value === undefined) return 'undefined';
    try {
      const json = JSON.stringify(value);
      if (json !== undefined) return json;
    } catch { /* cyclic, a BigInt, a throwing getter: rendered by String below */ }
    return String(value);
  } catch {
    return UNRENDERABLE;
  }
}

/**
 * Redact, cut on a code-point boundary at `max` RENDERED characters, escape — in that order, which is the rule.
 *
 *  - **Redact first**: the userinfo pattern needs the `@` that ends it, so a cut made first would leave the front
 *    half of a password unrecognised and on the line. Only a window of the value is redacted (`REDACT_MARGIN`), so
 *    a megabyte costs what a line costs.
 *  - **Cut by what is written, escape whole**: the budget counts escaped characters, and an escape is never split,
 *    so `\u00` without its digits never reaches a line, and a value of control characters is bounded by `max`
 *    like any other. A surrogate pair is kept or dropped whole.
 *  - **Say what was cut**: `…(+N chars)`, N in characters of the value.
 */
function render(text: string, max: number): string {
  const window = text.length > max + REDACT_MARGIN ? text.slice(0, max + REDACT_MARGIN) : text;
  let redacted = redact(window);
  if (window.length < text.length) redacted = redacted.replace(OPEN_USERINFO_AT_END, `$1${REDACTED_TOKEN}`);
  // The common case — a short value with nothing to escape — costs the redaction and one scan, not a walk.
  else if (redacted.length <= max && !LINE_BREAKING_ANY.test(redacted)) return redacted;
  let out = '';
  let used = 0;
  let i = 0;
  while (i < redacted.length) {
    const code = redacted.codePointAt(i) ?? 0;
    const width = code > 0xffff ? 2 : 1;
    const ch = redacted.slice(i, i + width);
    const shown = LINE_BREAKING_ONE.test(ch) ? escapeChar(ch) : ch;
    if (used + shown.length > max) break;
    out += shown;
    used += shown.length;
    i += width;
  }
  const omitted = (redacted.length - i) + (text.length - window.length);
  return omitted > 0 ? `${out}…(+${omitted} chars)` : out;
}

/** `LINE_BREAKING` for one character, and for "any at all" — neither global, so neither keeps a `lastIndex`. */
const LINE_BREAKING_ONE = new RegExp(`^(?:${LINE_BREAKING.source})$`);
const LINE_BREAKING_ANY = new RegExp(LINE_BREAKING.source);

/**
 * A value from OUTSIDE this instance — a peer's document id, a reason built from its content, a peer's label, a
 * caller's parameter, a driver's error text — made safe for a log line or a refusal (`Q-231`, `Q-214`, `Q-270`):
 *
 *  - **escaped**: every line-breaking character is written as its escape (`\r`, `\n`, `\u001b`), so a value can
 *    never start a line of its own. A document id `x\r\nFORGED ...` arriving by sync otherwise prints a second log
 *    line that reads exactly like this server's own;
 *  - **redacted**: a bearer token, URL userinfo or credential query parameter is never written;
 *  - **bounded**: at most `LOG_VALUE_MAX` characters, then `…(+N chars)`, so a megabyte `seq` makes a line, not a
 *    megabyte of one — in the ring the log viewer reads, the container log and every aggregator after it;
 *  - **never throws**: it runs inside a `catch` more often than not, and a throwing getter, a cyclic object or a
 *    BigInt must not turn a logged failure into a second, unlogged one.
 *
 * An Error renders its message (`name: message` for a subclass), not `{}`. Escape rather than strip, so the
 * operator still sees what was sent. Use it where the value enters the text; `a-steerable-value-reaches-a-log-line-
 * only-bounded.test.js` holds every door's log lines to it.
 */
export function peerText(value: unknown): string {
  try {
    return render(textOf(value), LOG_VALUE_MAX);
  } catch {
    return UNRENDERABLE;
  }
}

/** The older name of `peerText` — the same function, never a second rule. */
export const logSafe = peerText;

/**
 * A joined list of outside values, bounded twice: at most `LIST_MAX` elements and `LOG_VALUE_MAX` characters,
 * each element rendered by `peerText`'s rule, then `…(+K more)` naming how many were left out. `values.join(sep)`
 * bounds neither — ten thousand refused ids are ten thousand ids on one line.
 */
export function peerList(values: Iterable<unknown>, sep = ', '): string {
  try {
    const all = [...values];
    let out = '';
    let shown = 0;
    for (const v of all) {
      if (shown >= LIST_MAX) break;
      const room = LOG_VALUE_MAX - out.length - (shown > 0 ? sep.length : 0);
      if (room <= 0) break;
      const item = render(textOf(v), Math.min(room, LOG_VALUE_MAX));
      if (shown > 0 && item.length > room) break;
      out += (shown > 0 ? escapeLineBreaks(sep) : '') + item;
      shown++;
    }
    const more = all.length - shown;
    return more > 0 ? `${out}${shown > 0 ? ' ' : ''}…(+${more} more)` : out;
  } catch {
    return UNRENDERABLE;
  }
}

/**
 * An Error for the line `fmt` writes when it is the meta argument (bundle-30 `B4`): its stack is KEPT — the frames
 * are this server's own code, and `reportServerFailure` exists to leave them behind — while its message goes through
 * the same rule as any outside value (a driver's message can carry a peer's `_id`), bounded to half the budget so the
 * frames keep the rest. The whole is then bounded once more by its caller.
 */
function errorWithStack(err: Error): string {
  const header = errorHeader(err);
  let frames = '';
  try {
    const stack = typeof err.stack === 'string' ? err.stack : '';
    // The frames start after the message the stack repeats, so a message holding "\n    at " is not read as frames.
    const message = typeof err.message === 'string' ? err.message : '';
    const from = message.length > 0 && stack.includes(message) ? stack.indexOf(message) + message.length : 0;
    const at = stack.indexOf('\n    at ', from);
    frames = at === -1 ? '' : stack.slice(at);
  } catch { /* no frames, then */ }
  return `${render(header, LOG_VALUE_MAX / 2)}${frames}`;
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
