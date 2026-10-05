/**
 * The ONE way a maintainer script calls a Ythril REST tool: `POST <url>/api/<tool>` with a bearer token and the
 * tool's arguments as the body, answered by the `{ok, text, data}` envelope.
 *
 * ## What this prevents
 *
 * A script that writes to a Ythril instance holds a bearer token, and a hand-written `fetch` in each script leaves
 * that token somewhere it was never meant to be. Four ways, each closed INSIDE this module so no caller can leave
 * one out (the guard was the part a copy dropped, which is why it lives here and not in each script):
 *
 * 1. **The wrong URL.** `http://` to a host that is not this machine sends the token in the clear, and a typo'd
 *    `http://localhost.evil.example` merely STARTS like a loopback name. The URL must be `https`, or `http` to a
 *    loopback literal (`127.0.0.1`, `localhost`, `[::1]`) compared as a whole host; and it must carry no
 *    credentials, because the token has its own argument and `user:password@` is printed by every layer that
 *    prints a URL. Refused at construction, before anything is sent. `assertBearerSafeUrl` is that check alone, for
 *    a script that sends a token somewhere else (the GitHub API) or that builds its own requests.
 * 2. **A redirect.** `fetch` follows a 30x by default and the target is chosen by whoever answered. No redirect is
 *    followed: it is an error, and the target is never contacted.
 * 3. **A hang.** A request ends after `REQUEST_TIMEOUT_MS` (10 s) unless the caller states another.
 * 4. **A secret in an error.** Nothing thrown here carries the token, a `Bearer` value, a header name, URL userinfo
 *    or a response body the server may have echoed headers into: an error is built from the tool name, the status
 *    and the server's own one-line `error` sentence with the token scrubbed out of it, never from the transport's
 *    error object.
 *
 * ## The interface
 *
 * `createYthrilApi({ url, token, timeoutMs? })` returns `{ call(tool, args) }`. A 2xx answer resolves with the
 * envelope; anything else rejects with a `YthrilApiError` whose `status` is the HTTP status (absent for a network
 * failure, a timeout or a refused redirect).
 *
 * ## Where it is used
 *
 * `scripts/test-times.mjs` (the Test-Run recorder). `benchmarks/bench.mjs` and `benchmarks/tier0.mjs` take the URL
 * guard from here; the benchmark client keeps its own transport (its retry policy, 60 s timeout and brain routes are
 * a different question - see `benchmarks/writer/ythril-client.mjs`).
 */

/** How long one request may take before it is abandoned. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** Hosts `http` may be spoken to. Compared whole, never by prefix. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The longest answer read; a Ythril answer is bounded by the server's own byte budget, far below this. */
const MAX_ANSWER_BYTES = 16 * 1024 * 1024;

/** Characters of the server's own sentence kept in an error. */
const MAX_SENTENCE_CHARS = 300;

/** A tool name is a path segment; anything else could walk to another route. */
const TOOL_NAME = /^[a-z][a-z0-9_]*$/;

/** A bearer token is printable ASCII without spaces; anything else cannot be a header value. */
const TOKEN_SHAPE = /^[\x21-\x7e]+$/;

/** A failed call. `status` is the HTTP status when the server answered. */
export class YthrilApiError extends Error {
  constructor(message, { status, tool } = {}) {
    super(message);
    this.name = 'YthrilApiError';
    if (status !== undefined) this.status = status;
    if (tool !== undefined) this.tool = tool;
  }
}

/**
 * Refuse a URL a bearer token must not be sent to, and return its normalised root (no trailing slash, path prefix
 * kept). Never echoes the URL it refuses: an unparseable string may be a password.
 *
 * @param {string} url
 * @param {string} [what] how the refusal names it, e.g. `Ythril URL`
 * @returns {string} `origin + path prefix`, without a trailing slash
 */
export function assertBearerSafeUrl(url, what = 'Ythril URL') {
  let u;
  try { u = new URL(url); } catch { throw new TypeError(`${what} is not a URL`); }
  if (u.username || u.password) throw new TypeError(`${what} must not carry credentials`);
  if (u.search || u.hash) throw new TypeError(`${what} must not carry a query or a fragment`);
  const loopback = LOOPBACK_HOSTS.has(u.hostname);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback))) {
    throw new TypeError(`${what} must be https, or http to 127.0.0.1, localhost or [::1] (got ${u.protocol}//${u.host})`);
  }
  return u.origin + u.pathname.replace(/\/+$/, '');
}

/** The server's own one-line sentence from a failed answer, with anything token-shaped scrubbed. */
function sentenceOf(body, token) {
  const raw = body !== null && typeof body === 'object' && typeof body.error === 'string' ? body.error : '';
  return raw.split(/\r?\n/)[0]
    .split(token).join('***')
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .slice(0, MAX_SENTENCE_CHARS);
}

/** Read an answer, refusing one larger than `MAX_ANSWER_BYTES`. */
async function readText(res, tool) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > MAX_ANSWER_BYTES) throw new YthrilApiError(`${tool}: answer larger than ${MAX_ANSWER_BYTES} bytes`, { tool });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * @param {{ url: string, token: string, timeoutMs?: number }} opts
 * @returns {{ call(tool: string, args?: object): Promise<{ ok: boolean, text?: string, data?: any }> }}
 */
export function createYthrilApi({ url, token, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (typeof token !== 'string' || token === '') throw new TypeError('a Ythril token is required');
  if (!TOKEN_SHAPE.test(token)) throw new TypeError('the Ythril token must be printable ASCII without spaces');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive number');
  const root = assertBearerSafeUrl(url);

  return {
    async call(tool, args = {}) {
      if (typeof tool !== 'string' || !TOOL_NAME.test(tool)) throw new TypeError('tool must be a tool name such as filter or save_chrono');
      let res;
      try {
        res = await fetch(`${root}/api/${tool}`, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(args),
        });
      } catch (err) {
        // The transport's own error is deliberately not chained: it can carry the request it was sending.
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        throw new YthrilApiError(timedOut ? `${tool}: request timed out after ${timeoutMs} ms` : `${tool}: request failed (${err?.cause?.code ?? err?.code ?? err?.name ?? 'error'})`, { tool });
      }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {});
        throw new YthrilApiError(`${tool}: refused a redirect (${res.status}); the token is never sent to a second address`, { status: res.status, tool });
      }
      const text = await readText(res, tool);
      let body = null;
      try { body = JSON.parse(text); } catch { /* a non-JSON answer is reported below, without its text */ }
      if (!res.ok) {
        const sentence = sentenceOf(body, token);
        throw new YthrilApiError(`${tool}: HTTP ${res.status}${sentence ? `: ${sentence}` : ''}`, { status: res.status, tool });
      }
      if (body === null || typeof body !== 'object') throw new YthrilApiError(`${tool}: the answer was not JSON`, { status: res.status, tool });
      if (body.ok === false) throw new YthrilApiError(`${tool}: refused${sentenceOf(body, token) ? `: ${sentenceOf(body, token)}` : ''}`, { status: res.status, tool });
      return body;
    },
  };
}
