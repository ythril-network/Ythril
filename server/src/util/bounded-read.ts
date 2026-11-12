/**
 * Bounded readers for HTTP responses from operator-configured upstreams.
 *
 * ## Why this is a shared module and not a private helper
 *
 * `boundedJson` was written in `files/media/providers.ts`, with the risk stated correctly in a comment:
 *
 * > `fetch().json()` reads the entire body without limit → a hostile or runaway upstream could exhaust heap.
 * > We cap by streaming the body and aborting once `maxBytes` is exceeded.
 *
 * It was then used at three call sites, **all inside that same file**, while twelve other `Response.json()` reads
 * across eight files went unbounded — including `files/converters/renderer.ts`, which reads rendered page images
 * as base64 strings and is the largest JSON body the server ever handles. Nothing about the reader is
 * media-specific; it was private by accident.
 *
 * ## Why nobody noticed, which is the part worth remembering
 *
 * **Every one of those call sites already had a timeout.** An audit sweep asked "is there a provider call with no
 * timeout?", found none, and moved on. A timeout bounds **duration**; it says nothing about **size**. A fast
 * upstream streaming gigabytes finishes well inside a 120-second budget. A guard on the wrong axis is more
 * dangerous than no guard, because a satisfied check is the strongest possible reason to stop looking.
 *
 * ## The realistic failure is runaway, not hostile
 *
 * Every upstream here is operator-configured — a sidecar, a local model server, an OpenAI-compatible endpoint.
 * None is attacker-supplied, so this is not remotely exploitable. What it is: a sidecar bug, or an operator
 * turning render quality up. `renderDpi` accepts up to **600** and `maxPages` up to **2000** through the UI, and
 * `renderer.ts` decodes every returned page with `Buffer.from(b64, 'base64')` — so the JSON string, the parsed
 * strings and the decoded buffers are all live at once. That path needs no bug and no attacker to hurt.
 */
import { peerText } from './log.js';

/**
 * Default ceiling for one upstream response body.
 *
 * 256 MiB: comfortably above a legitimate 50-page render at 600 DPI (the shipped `maxPages` default at the
 * schema's maximum quality), and far below anything that threatens the heap. Deliberately one generous number
 * rather than a per-caller guess — a cap tuned so tightly that it rejects real work would be reverted, and a
 * reverted cap protects nothing.
 *
 * `YTHRIL_MAX_UPSTREAM_RESPONSE_BYTES` raises or lowers it. An operator who has set `maxPages: 2000` at 600 DPI
 * genuinely needs more than this, and the error message says so rather than leaving them to guess.
 */
export const DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES = 256 * 1024 * 1024;

export function maxUpstreamResponseBytes(): number {
  const raw = process.env['YTHRIL_MAX_UPSTREAM_RESPONSE_BYTES']?.trim();
  if (!raw) return DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES;
  const n = Number(raw);
  // A malformed value must not silently remove the bound, so it falls back rather than becoming 0 or NaN.
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES;
  return n;
}

/**
 * The refusal of a body past its ceiling, a class of its own so a caller that has a word for "too large" (a schema snapshot over its cap, `over_cap`)
 * tells it from a body that failed to parse or a connection that broke, without reading the message.
 */
export class ResponseTooLargeError extends Error {
  constructor(message: string) { super(message); this.name = 'ResponseTooLargeError'; }
}

/** How much of an upstream error body is worth keeping. Three call sites chose 200 independently; that is the standard. */
export const ERROR_BODY_CHARS = 200;

/**
 * Read a JSON response with a hard size ceiling.
 *
 * Checks `content-length` first — a declared oversize body is refused without reading a byte — then streams and
 * aborts the moment the cap is passed. The `content-length` check is an optimisation, not the guard: it is
 * advisory and an upstream may omit or lie about it, which is why the streaming check exists regardless.
 *
 * @param label  Named in the error, because "response too large" without a source is an unactionable log line.
 */
export async function boundedJson<T>(
  res: Response,
  label: string,
  maxBytes: number = maxUpstreamResponseBytes(),
): Promise<T> {
  const tooBig = (detail: string): Error => new ResponseTooLargeError(
    `${label} response ${detail} (max ${maxBytes} bytes). If this is legitimate, raise `
    + 'YTHRIL_MAX_UPSTREAM_RESPONSE_BYTES.',
  );

  const declared = res.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) {
    throw tooBig(`too large: ${declared} bytes`);
  }

  if (!res.body) {
    // Some runtimes buffer bodies and expose no stream. Fall back to text() with a post-hoc check — weaker,
    // because the allocation has already happened, but it is the only option and it still refuses to PARSE.
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw tooBig(`exceeded ${maxBytes} bytes`);
    return JSON.parse(text) as T;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      // Cancel rather than drain: the point is to stop paying for bytes we have already decided to refuse.
      try { await reader.cancel(); } catch { /* the connection is going away anyway */ }
      throw tooBig(`exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const merged = Buffer.concat(chunks.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  return JSON.parse(merged.toString('utf8')) as T;
}

/**
 * Read a MODEL SERVER's JSON reply: `boundedJson`, and a reply that carries an `error` is thrown as a line.
 *
 * Question: "how much of a model server's own error words may we quote?" `boundedJson` bounds the BODY (256 MiB); a megabyte
 * `error.message` sits inside that bound, and a caller that put it whole into a thrown Error sent a megabyte to the logs and
 * to its own caller's answer. The `error` check lives HERE so a caller cannot drop the cut: the text is read as `peerText`
 * reads a value from outside (redacted, escaped, at most `ERROR_BODY_CHARS`, saying how much it left out). The field is a
 * string for Ollama and an object for an OpenAI-compatible server, so it is taken as `unknown`: an object's `message` is
 * the text when it is a string, the object itself rendered otherwise.
 *
 * @param label  Named in the thrown message and in a too-large refusal.
 * @param opts.fail  Builds the thrown Error from `error: <bounded text>` when a caller has its own error type or prefix.
 */
export async function boundedModelJson<T extends object>(
  res: Response,
  label: string,
  opts: { maxBytes?: number; fail?: (message: string) => Error } = {},
): Promise<T> {
  const json = await boundedJson<T & { error?: unknown }>(res, label, opts.maxBytes);
  const error = json?.error;
  if (!error) return json;
  const said = typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message
    : error;
  const text = peerText(said, { max: ERROR_BODY_CHARS });
  throw opts.fail ? opts.fail(`error: ${text}`) : new Error(`${label} error: ${text}`);
}

/**
 * Read an upstream ERROR body, bounded and truncated, for use in a message.
 *
 * Five sites did this by hand and three of them truncated at 200 characters while two interpolated the whole
 * body into an `Error`. The untruncated pair are not an information leak — the global error middleware returns a
 * generic message and never `err.message`, which was checked rather than assumed — but they are a second full
 * copy of an already unbounded read, landing in a log line where a multi-megabyte body destroys the surrounding
 * context and buries the actual error.
 *
 * Never throws. An error path that can itself fail replaces a diagnosable failure with a confusing one, which is
 * the opposite of what an error body is for.
 */
export async function boundedErrorText(res: Response, maxChars: number = ERROR_BODY_CHARS): Promise<string> {
  try {
    // 1 MiB is plenty for any error body; nothing legitimate needs more, and it caps the read before truncation
    // rather than after — truncating a string you have already allocated is not a bound.
    const text = await boundedJsonSafeText(res, 1024 * 1024);
    return text.length > maxChars ? `${text.slice(0, maxChars)}… (truncated)` : text;
  } catch {
    return '';
  }
}

/** Streaming text read with a byte ceiling. Returns what it got if the cap is hit rather than throwing. */
async function boundedJsonSafeText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, maxBytes);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.byteLength;
    if (total >= maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8');
}
