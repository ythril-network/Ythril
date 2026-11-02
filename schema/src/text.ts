/**
 * Text that came from OUTSIDE, made safe to say back: `peerText` and `peerList` for a value in a line or a refusal, and
 * `refusalOfParse` for a failed zod parse answered as `{ error, issues }`.
 *
 * ## Why it lives in the schema package
 *
 * Every refusal a space schema earns is worded through here — a property's name, a type's name and a refinement's message are the
 * caller's text, bounded and escaped before they are said back. The server's logger (`server/src/util/log.ts`) and this package's
 * validator must word a refusal the same way, so the rule is written once, here, and the logger imports it. A second copy in the
 * package would be a validator whose refusal text drifts from the server's on the first edit of either.
 *
 * `errorHeader`, `textOf`, `render`, `escapeLineBreaks` and `redact` are exported for the logger's own line format (`fmt`,
 * `errorWithStack`) through `@ythril/schema/internal`; an app has no use for them.
 */

const REDACTED = 'Bearer [redacted]';
const REDACTED_TOKEN = '[redacted]';

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
export function escapeLineBreaks(text: string): string {
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
export function errorHeader(err: Error): string {
  try {
    const message = typeof err.message === 'string' ? err.message : String(err.message);
    const name = typeof err.name === 'string' ? err.name : 'Error';
    return name === 'Error' || name === '' ? message : `${name}: ${message}`;
  } catch {
    return UNRENDERABLE;
  }
}

/** Any value as text, never throwing: a string as itself, an Error as its header, anything else as JSON or `String`. */
export function textOf(value: unknown): string {
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
export function render(text: string, max: number): string {
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
 *
 * `max` narrows the bound for a quote that needs less — a refusal reason quoting a driver's message or a schema's
 * issue list. It exists so such a quote is never a `.slice(0, N)` of its own, which cuts by code unit (half a
 * surrogate pair), escapes nothing and does not say it cut (bundle-30 `I5`). It can only NARROW: a `max` above
 * `LOG_VALUE_MAX`, or one that is not a whole number, gets `LOG_VALUE_MAX` (`within`). An options object rather than
 * a number, so `.map(peerText)` — which would hand it each element's index as the cap — does not type-check.
 */
export function peerText(value: unknown, { max }: { max?: number } = {}): string {
  try {
    return render(textOf(value), within(max, LOG_VALUE_MAX));
  } catch {
    return UNRENDERABLE;
  }
}

/**
 * `requested` when it is a whole number from 0 to `ceiling`, else `ceiling`: a caller's bound narrows the renderer's
 * and never widens or disables it. `NaN` compares false with everything, so a NaN cap taken as given would never be
 * reached — an unbounded value from a call site that looks bounded.
 */
function within(requested: unknown, ceiling: number): number {
  return typeof requested === 'number' && Number.isInteger(requested) && requested >= 0
    ? Math.min(requested, ceiling) : ceiling;
}

/** The older name of `peerText` — the same function, never a second rule. */
export const logSafe = peerText;

/**
 * How much of one name a caller sent — an unknown key, a reference — a refusal quotes: any honest key or id whole, and
 * short enough that one oversized name cannot crowd out the others named beside it. One number for every door that
 * names a caller's keys back (REST `unknownBodyFields`, the MCP argument validator), so the same mistake is quoted
 * the same way whichever client the caller picked (bundle-30 I6, C18).
 */
export const NAME_QUOTED = 256;

/**
 * A joined list of outside values, bounded twice: at most `LIST_MAX` elements and `LOG_VALUE_MAX` characters,
 * each element rendered by `peerText`'s rule, then `…(+K more)` naming how many were left out. `values.join(sep)`
 * bounds neither — ten thousand refused ids are ten thousand ids on one line.
 *
 * `count` narrows the element bound for a message that names a few (a reference refusal names five); like
 * `peerText`'s `max` it can only narrow (`within`). One number, not a flag per caller: what an element looks like is
 * the caller's to decide by what it passes in (`bad.map(v => JSON.stringify(v))` for quoted ids).
 *
 * `each` narrows how much of ONE element is shown, so one oversized element cannot take the list's whole budget and
 * leave the rest unnamed — a refusal naming a caller's keys or references (`NAME_QUOTED`). Like the others it only
 * narrows. It replaced rendering each element with `peerText` first and the list again (bundle-30 I6, C18).
 */
export function peerList(values: Iterable<unknown>, sep = ', ', { count, each }: { count?: number; each?: number } = {}): string {
  try {
    const all = [...values];
    const most = within(count, LIST_MAX);
    const eachMax = within(each, LOG_VALUE_MAX);
    let out = '';
    let shown = 0;
    for (const v of all) {
      if (shown >= most) break;
      const room = LOG_VALUE_MAX - out.length - (shown > 0 ? sep.length : 0);
      if (room <= 0) break;
      const item = render(textOf(v), Math.min(room, eachMax));
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
 * How many names or issues of one refusal are shown before the rest are counted: the issues of a failed parse (`refusalOfParse`), the
 * unknown keys a write is told about (`answerUnknownWriteFields`), and the fields a schema refusal's sentence names
 * (`describeUpdateViolations`, a refused merge). One number, so they read alike.
 */
export const REFUSAL_NAMES_MAX = 10;

/** One issue of a failed parse as a refusal carries it: what failed and where, and nothing the caller sent as a VALUE. */
export interface ParseRefusalIssue {
  /** zod's code for the failure (`invalid_type`, `unrecognized_keys`, `too_big`, `custom`, …): a fixed vocabulary, never a caller's text. */
  code: string;
  /** Where it failed, each segment a name or an index rendered by `peerText` at `NAME_QUOTED` (an index as its digits). */
  path: string[];
  /** Only for `unrecognized_keys`: the unknown keys, at most {@link REFUSAL_NAMES_MAX}, each rendered at `NAME_QUOTED`. */
  keys?: string[];
}

/** A failed parse answered: prose for a person, structure for a program. */
export interface ParseRefusal {
  /** Bounded prose (at most `LOG_VALUE_MAX` characters, never a JSON document) naming the path of each failing field. */
  error: string;
  /** The first ten issues, then nothing: `error` says how many were left out. */
  issues: ParseRefusalIssue[];
  /**
   * What was wrong at each of `issues`, one bounded sentence apiece and parallel to it, for a caller that words its own lines (`kind:Type — reason`).
   * NOT enumerable, so it is not part of the body: a reason is text a refinement or a compiler wrote, bounded and escaped but not value-free,
   * and `error` already says it. A door answers the refusal itself — `res.status(400).json(refusalOfParse(error))` is `{ error, issues }`.
   */
  reasons: string[];
}

/** How a caller shapes what `refusalOfParse` reads. */
export interface ParseRefusalOptions {
  /** Show more than the default ten issues, up to twenty (a caller whose own answer is a list of failing parts). Never fewer than one. */
  maxIssues?: number;
  /**
   * For an `invalid_union` issue, the branch (its issues) that is ABOUT the field, so the refusal names what is wrong inside it and not
   * zod's `Invalid input`. Which branch that is belongs to the schema that built the union.
   */
  unionBranch?: (branches: readonly ParseIssueLike[][]) => readonly ParseIssueLike[] | undefined;
  /**
   * The path the caller's body was parsed UNDER, when a door wraps it to give the schema context the body cannot carry (the single-type
   * PUT parses its definition as `{ <kind>: { <type>: body } }`). It is taken off every issue path that goes below it, so the refusal names
   * the fields the caller sent; an issue AT the wrapper (its type name refused) keeps its path, since it is about the URL, not the body.
   */
  under?: readonly string[];
}

/** The structural part of a zod issue `refusalOfParse` reads. Not zod's own type: this module is imported by everything and imports nothing. */
export interface ParseIssueLike {
  code?: unknown;
  path?: unknown;
  message?: unknown;
  keys?: unknown;
}

/**
 * A failed zod parse as an ANSWER or a LOG LINE: bounded prose and a structured, value-free issue list (`Q-362`, R5-4, R6-11).
 *
 * zod's own `error.message` is the whole issue array as JSON, and an issue for an unknown key quotes the key whole: a caller's
 * megabyte key came back as a two-megabyte 400, and through the MCP twin as a megabyte log line, while the MCP dispatcher's own
 * validator had bounded the very same mistake. Fifty-odd doors each answered it their own way; this is the one way.
 *
 *  - **`error` is prose**, never a JSON document, naming the path of each failing field and what was wrong with it, at most
 *    `LOG_VALUE_MAX` characters. The `unrecognized_keys` sentence is REBUILT from `issue.keys` (zod's own copies the key unbounded).
 *  - **`issues` is `[{ code, path, keys? }]` and nothing else**: no received value, no expectation, no message. A value is the one
 *    thing a refusal must not reflect back — it is the caller's, possibly a credential, and the caller has it already.
 *  - **At most ten issues are shown** and the rest are counted in the prose, so a body that fails on a thousand fields is one answer.
 *  - **Every name a caller chose is rendered by `peerText` at `NAME_QUOTED`**: a path segment, an unknown key, and — because it is
 *    text a caller can steer — the message a refinement or a compiler wrote. One oversized or line-breaking name neither floods
 *    the answer nor forges a line.
 *
 * Takes whatever a parse failure is: a `ZodError`, the error a throwing `parse` raised in a `catch`, or (answered as its bounded text, with
 * no issues) anything else that was thrown there. The log line a refusal wants is `log.warn(`… ${refusal.error}`)`, so the one text is
 * the answer's and the line's.
 */
export function refusalOfParse(error: unknown, options: ParseRefusalOptions = {}): ParseRefusal {
  try {
    const raw = (error as { issues?: unknown } | null | undefined)?.issues;
    if (!Array.isArray(raw)) return parseRefusal(peerText(error), [], []);
    const all = raw as ParseIssueLike[];
    const most = typeof options.maxIssues === 'number' && Number.isInteger(options.maxIssues) && options.maxIssues > 0
      ? Math.min(options.maxIssues, REFUSAL_ISSUES_CEILING) : REFUSAL_NAMES_MAX;
    const shown = all.slice(0, most);
    const issues: ParseRefusalIssue[] = [];
    const reasons: string[] = [];
    const sentences: string[] = [];
    for (const issue of shown) {
      const { path: fullPath, issue: leaf } = descendUnion(issue, [], options.unionBranch);
      const under = options.under ?? [];
      const rawPath = under.length > 0 && fullPath.length > under.length && under.every((seg, i) => fullPath[i] === seg)
        ? fullPath.slice(under.length) : fullPath;
      const path = rawPath.map(segment => peerText(typeof segment === 'symbol' ? segment.toString() : segment, { max: NAME_QUOTED }));
      const code = typeof leaf.code === 'string' ? leaf.code : 'invalid';
      const where = path.length > 0 ? `${path.join('.')}: ` : '';
      let reason: string;
      if (code === 'unrecognized_keys' && Array.isArray(leaf.keys)) {
        const built = unrecognizedKeysIssue(leaf.keys as unknown[], path);
        issues.push(built.issue);
        reason = built.reason;
      } else {
        issues.push({ code, path });
        reason = peerText(typeof leaf.message === 'string' ? leaf.message : code, { max: NAME_QUOTED });
      }
      reasons.push(reason);
      sentences.push(`${where}${reason}`);
    }
    if (all.length > shown.length) sentences.push(`…(+${all.length - shown.length} more)`);
    return parseRefusal(peerText(sentences.join('; ') || 'Invalid input'), issues, reasons);
  } catch {
    return parseRefusal(UNRENDERABLE, [], []);
  }
}

/**
 * The `unrecognized_keys` issue for a list of keys, and the one clause that says it: what `refusalOfParse` answers for a failed parse AND
 * what the unknown-write-field judge (`contract/write-accepts.ts`, Q-320) refuses a write with, so a caller reads one shape for "this
 * body carries a key it does not take" whichever door and whichever mechanism refused it.
 *
 * **Bounded the way every refusal is, inside, so no caller can drop it:** at most {@link REFUSAL_NAMES_MAX} keys in `issue.keys`, each
 * rendered by `peerText` at `NAME_QUOTED`; the clause (`reason`) is rebuilt from the keys by `peerList` at the same bounds, because zod's
 * own text copies a key unbounded. `path` is taken as already rendered (a parse refusal's path segments are); the judge's is `[]`, the
 * body itself. Takes `unknown[]` because a parse's `keys` is whatever zod put there.
 */
export function unrecognizedKeysIssue(keys: readonly unknown[], path: readonly string[] = []): { issue: ParseRefusalIssue; reason: string } {
  return {
    issue: { code: 'unrecognized_keys', path: [...path], keys: keys.slice(0, REFUSAL_NAMES_MAX).map(k => peerText(k, { max: NAME_QUOTED })) },
    reason: `unrecognized key${keys.length === 1 ? '' : 's'}: ${peerList(keys, ', ', { count: REFUSAL_NAMES_MAX, each: NAME_QUOTED })}`,
  };
}

/**
 * A {@link ParseRefusal}, whose `reasons` are NOT enumerable: a door answers the refusal itself (`res.status(400).json(refusalOfParse(error))`,
 * or spreads it) and the body is `{ error, issues }` — the two the caller is owed — while a caller that words its own lines still reads
 * `.reasons`. A body that carried the reasons as well would say everything twice, and say a refinement's text in a second place.
 */
function parseRefusal(error: string, issues: ParseRefusalIssue[], reasons: string[]): ParseRefusal {
  const refusal = { error, issues } as ParseRefusal;
  Object.defineProperty(refusal, 'reasons', { value: reasons, enumerable: false });
  return refusal;
}

/** How many issues a caller that asks for more than the default (`maxIssues`) can be shown at most. */
const REFUSAL_ISSUES_CEILING = 20;

/**
 * An `invalid_union` issue, replaced by the first issue of the branch that says what is wrong — zod's own text for a union is
 * `Invalid input`, which names nothing, and a refusal that names nothing sends a caller hunting through a body for the key. The branch is
 * the caller's `unionBranch` when it has an opinion, else the CLOSEST one: the branch that failed on the fewest issues, the first of those
 * on a tie (a body that is one unknown key away from an inline definition fails that branch once and the other twice). The branch's path
 * continues the union's. Bounded in depth: a union of unions is followed a few levels, never until it ends.
 */
function descendUnion(
  issue: ParseIssueLike, prefix: readonly unknown[], choose: ParseRefusalOptions['unionBranch'], depth = 0,
): { path: unknown[]; issue: ParseIssueLike } {
  const path = [...prefix, ...(Array.isArray(issue.path) ? issue.path : [])];
  const branches = (issue as { errors?: unknown }).errors;
  if (issue.code !== 'invalid_union' || depth >= 4 || !Array.isArray(branches)) return { path, issue };
  const picked = (choose?.(branches as ParseIssueLike[][]) ?? closestBranch(branches as ParseIssueLike[][]))?.[0];
  return picked ? descendUnion(picked, path, choose, depth + 1) : { path, issue };
}

/** The branch of a failed union that failed on the fewest issues (the first on a tie): the one the body was closest to. */
function closestBranch(branches: readonly ParseIssueLike[][]): readonly ParseIssueLike[] | undefined {
  let best: readonly ParseIssueLike[] | undefined;
  for (const b of branches) if (Array.isArray(b) && b.length > 0 && (best === undefined || b.length < best.length)) best = b;
  return best;
}


export function redact(msg: string): string {
  return msg
    .replace(/Bearer\s+[A-Za-z0-9_.\-]+/gi, REDACTED)
    .replace(URL_USERINFO, `$1${REDACTED_TOKEN}@`)
    .replace(SECRET_QUERY_PARAMS, `$1${REDACTED_TOKEN}`);
}
