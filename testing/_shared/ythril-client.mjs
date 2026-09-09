/**
 * The Ythril REST client the benchmark runs through — the same door a user has.
 *
 * ## Why HTTP and not an import
 *
 * Every other module here could `import { recall } from '../../server/src/brain/recall.js'` and skip the
 * network. That would measure a function. What the benchmark claims to measure is the product: the route's
 * parameter validation, its caps, its proxy lens, its byte budget, its rate limiter. Those live between the
 * caller and `recall()`, and a number produced without them is a number about code nobody ships.
 *
 * So: `fetch`, Node built-ins, no dependency on `server/src` at all. `CONTRACTS.md` fixes the surface.
 *
 * ## Every endpoint below was read out of the source, not remembered
 *
 * A client written from memory is how a harness spends an hour reporting zero results, so each call names the
 * file it was checked against and the doc page that describes it. Paths verified 2026-08-29 against:
 *
 *   - `server/src/app.ts:302` — `app.use('/api/brain', brainRouter)`, so every brain path below is
 *     `/api/brain` + the sub-router's own full path. `app.ts:303` mounts spaces at `/api/spaces`.
 *   - `server/src/api/brain/memories.ts:34`  POST   `/spaces/:spaceId/memories`      (docs 04-brain-api.md:94)
 *   - `server/src/api/brain/entities.ts:34`  POST   `/spaces/:spaceId/entities`
 *   - `server/src/api/brain/edges.ts:33`     POST   `/spaces/:spaceId/edges`
 *   - `server/src/api/brain/chrono.ts:38`    POST   `/spaces/:spaceId/chrono`
 *   - the four matching `PATCH .../:id` handlers (memories.ts:227, entities.ts:246, edges.ts:205,
 *     chrono.ts:154) — the only door `suppressEmbeddings` has; see `writeRecord`
 *   - `server/src/api/brain/search.ts:351`   POST   `/spaces/:spaceId/recall`        (docs 04a-recall-api.md)
 *   - `server/src/api/brain/search.ts:267`   POST   `/spaces/:spaceId/query`         (docs 04-brain-api.md:375)
 *   - `server/src/api/brain/embed-jobs.ts:74` GET   `/spaces/:spaceId/embedding-queue/records`
 *                                                                                   (docs 04d-brain-ops-api.md:304)
 *   - `server/src/api/spaces.ts:270`         POST   `/api/spaces`                    (docs 06-spaces-api.md:90)
 *   - `server/src/api/spaces.ts:756`         DELETE `/api/spaces/:id`
 *   - `server/src/api/spaces.ts:131`         GET    `/api/spaces` — the only non-admin route that reports
 *     `indexStatus`, which `waitForEmbeddings` needs (docs 06-spaces-api.md:139)
 *
 * ## The four silent failures this file exists to make loud
 *
 * 1. **Retrieval before the corpus is searchable.** Two separate layers, and each looks exactly like poor
 *    recall: the embed queue still holding jobs, and the space's vector index still `building`. Both are
 *    gated by `waitForEmbeddings`, which FAILS rather than proceeds.
 * 2. **The rate limiter.** `globalRateLimit` is 300 requests/minute per credential
 *    (`server/src/rate-limit/middleware.ts:121`). A corpus of a few thousand records cannot be written
 *    faster than that, so a client that does not honour `429` does not slow down — it dies partway through
 *    and reports the recall of a half-written store. Retried with the server's own `Retry-After`.
 * 3. **A degraded recall counted as a bad recall.** `degraded: ["search_timeout"]` comes back with a `200`
 *    and a short result list. `stats()` counts them so the run can say so instead of blaming the retriever.
 * 4. **A record that never embedded.** A `failed` embed job means that record is absent from every recall
 *    for the whole run. `waitForEmbeddings` throws and names the errors rather than letting the hole through.
 */

import { createHash, randomUUID } from 'node:crypto';

/** Request timeout. A `traverse: 5` recall on a dense graph is genuinely slow; a hung socket is not. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Attempts per request, INCLUDING the first. Only retryable conditions consume one — see `isRetryable`. */
const DEFAULT_MAX_ATTEMPTS = 6;

/** Backoff floor and ceiling for the attempts the server gives no `Retry-After` for. */
const BACKOFF_BASE_MS = 500;
const BACKOFF_CEILING_MS = 30_000;

/**
 * The query `waitForEmbeddings` probes a space with to prove it is searchable.
 *
 * Deliberately meaningless. It must match nothing in particular, because the only thing being asked is
 * whether the vector index answers AT ALL — and a probe resembling a benchmark question would quietly make
 * the readiness check depend on the corpus's content.
 */
const SEARCHABLE_PROBE = 'probe';

/** How long `waitForEmbeddings` waits in total, and how often it asks. */
const DEFAULT_EMBED_TIMEOUT_MS = 600_000;
const DEFAULT_EMBED_POLL_MS = 2_000;

/**
 * How long the queue may fail to shrink with nothing in flight before that is called a stall.
 *
 * Separate from the overall timeout because the two mean different things: a timeout is "this corpus is
 * bigger than the budget", a stall is "the embedding worker is not running". Waiting ten minutes to
 * discover the second is ten minutes of a run nobody gets back.
 */
const DEFAULT_EMBED_STALL_MS = 120_000;

/** Failed jobs quoted in the thrown message. Enough to see whether it is one bad record or the model. */
const FAILED_JOBS_QUOTED = 10;

/** Characters of an unparseable error body kept in the message. */
const ERROR_BODY_CHARS = 400;

/** The id shape every brain write route enforces — `server/src/brain/entity-refs.ts:19`, copied not imported. */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** RFC 4122 field widths, named so the formatter below contains no unexplained slice offsets. */
const UUID_FIELD_LENGTHS = [8, 4, 4, 4, 12];

/** `GET /api/spaces` reports these; anything else (including absent) is treated as ready — docs 06:139. */
const INDEX_BUILDING = 'building';
const INDEX_FAILED = 'failed';

/** A non-2xx answer from the instance. Carries the parts an operator needs to act, not just a message. */
export class YthrilHttpError extends Error {
  /**
   * `note` is the client's own reading of a refusal, kept SEPARATE from `body` so the server's exact words
   * survive in the field an operator will quote. A message that silently rewrote `body.error` would make the
   * two disagree, which is the one thing an error report must never do.
   */
  constructor({ status, method, path, body, text, note }) {
    const detail = body && typeof body === 'object' && typeof body.error === 'string'
      ? body.error
      : String(text ?? '').slice(0, ERROR_BODY_CHARS);
    super(`${method} ${path} -> ${status}: ${detail}${note ? ` — ${note}` : ''}`);
    this.name = 'YthrilHttpError';
    this.status = status;
    this.method = method;
    this.path = path;
    /** The parsed body when there was one, so a caller can branch on `retryable` rather than on prose. */
    this.body = body;
  }
}

/** The corpus is not searchable and the run must not start. Distinct class so a runner can report it as such. */
export class EmbeddingsNotReadyError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'EmbeddingsNotReadyError';
    Object.assign(this, detail);
  }
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Refuse an absent or blank string argument by NAME. A defaulted space id writes to the wrong space. */
function requireString(value, what) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${what} must be a non-empty string (got ${value === undefined ? 'undefined' : JSON.stringify(value)})`);
  }
  return value;
}

/**
 * A stable string turned into the UUID v4 the write routes require.
 *
 * ## Why this mapping exists rather than a refusal
 *
 * The write routes reject any `id` that is not a UUID v4 (`entities.ts:45`, `memories.ts:112`,
 * `chrono.ts:121`), and with `strictLinkage` on — the default posture for a new space,
 * `spaces/space-create.ts:113` — an edge's `from`/`to` and a memory's `entityIds` must also RESOLVE.
 * Meanwhile a caller wanting a re-run to address the same records rather than mint duplicates needs an id
 * it can recompute, which is the one thing a server-minted UUID is not.
 *
 * A refusal was the other option and it is the wrong one here, because nothing is being guessed at: the
 * caller's string is an identity, sha256 is injective for every input this harness will ever see, and the
 * same string yields the same UUID forever. Meaning is preserved exactly; only the spelling changes. That is
 * the line between this and a coercion — a coerced parameter loses information, and this loses none.
 *
 * **It is not hidden**: `refId` is on the client, so any module can compute the same value and join back to
 * the record. The alternative — mirroring the readable id into `properties` — was rejected outright: property
 * values are folded into a record's embedding text (`propsEmbedText`), so it would have altered what is being
 * measured in order to make bookkeeping convenient.
 *
 * A value that already IS a UUID v4 passes through untouched, so a caller minting its own ids is unaffected.
 */
function refIdFor(spaceId, localId) {
  if (typeof localId !== 'string' || UUID_V4_RE.test(localId)) return localId;
  // Length-prefixed rather than separator-joined: no delimiter can appear inside a length, so two different
  // (space, id) pairs cannot collide by containing the delimiter. A NUL separator would do the same job and
  // is not worth putting a control byte in a source file.
  const seed = `ythril-bench/${spaceId.length}/${spaceId}/${localId.length}/${localId}`;
  const h = createHash('sha256').update(seed).digest();
  h[6] = (h[6] & 0x0f) | 0x40;   // version 4
  h[8] = (h[8] & 0x3f) | 0x80;   // RFC 4122 variant
  const hex = h.subarray(0, 16).toString('hex');
  let at = 0;
  return UUID_FIELD_LENGTHS.map(len => {
    const field = hex.slice(at, at + len);
    at += len;
    return field;
  }).join('-');
}

/**
 * The four write routes, as data.
 *
 * `refs` and `refArrays` name the fields holding an entity/memory id, so the id mapping is applied in ONE
 * place. Writing it per method is how three of the four end up agreeing and the fourth stores a dangling
 * reference that only surfaces later as a traversal returning nothing.
 *
 * An edge has no `id`: its identity is (from, to, label), so a repeat POST merges — `edges.ts:88`.
 */
const WRITE_ROUTES = {
  memory: { segment: 'memories', idField: 'id', refs: [], refArrays: ['entityIds'] },
  entity: { segment: 'entities', idField: 'id', refs: [], refArrays: [] },
  edge: { segment: 'edges', idField: null, refs: ['from', 'to'], refArrays: [] },
  chrono: { segment: 'chrono', idField: 'id', refs: [], refArrays: ['entityIds', 'memoryIds'] },
};

/**
 * Seconds to wait, from whichever header the server used.
 *
 * `Retry-After` is set by the read routes' failure classifier (`api/brain/_read-failure.ts:26`) and by
 * express-rate-limit on a 429. The `RateLimit` header is draft-7 structured fields
 * (`rate-limit/middleware.ts:124`), so `reset` is read with an anchored key match rather than by counting
 * characters into the string — the delimiters and their order are the server's to change.
 */
function retryAfterMsFrom(headers) {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const at = Date.parse(retryAfter);          // the HTTP-date form
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  const rateLimit = headers.get('ratelimit');
  const reset = rateLimit && /(?:^|[,;\s])reset\s*=\s*(\d+)/i.exec(rateLimit);
  if (reset) return Number(reset[1]) * 1000;
  return undefined;
}

/**
 * Is trying the identical request again worth doing?
 *
 * The read routes answer this themselves — every failure body from `/recall`, `/query` and `/find-similar`
 * carries `retryable` as a boolean (`api/brain/_read-failure.ts`), explicitly so a client branches on a field
 * instead of matching our prose. Where the server says, the server wins. The write routes carry no such
 * field, so the status decides: 429 and 5xx are worth retrying, and no other 4xx ever is — a 400 for a bad
 * body will be a 400 six times and turn one visible mistake into a slow one.
 */
function isRetryable(status, body) {
  if (isPlainObject(body) && typeof body.retryable === 'boolean') return body.retryable;
  return status === 429 || status >= 500;
}

/**
 * `traverse` may be a depth or the object form `{depth, edgeLabels, direction}`.
 *
 * Both are sent to the wire EXACTLY as given. In particular the RANGE is not checked here: the ceiling is
 * `MAX_RECALL_TRAVERSE` in `brain/edges.ts:741` and duplicating it in a client is this repo's most-produced
 * defect — one rule, two implementations, and the weaker one wins silently the day the ceiling moves.
 *
 * What is checked is that the value is one of the two SHAPES, because the failures there are not visible in
 * the answer. A stringified `"2"` and a `[2]` are the coercion shape; and an object without `depth` is worse
 * than either, since a server reading `depth ?? 0` answers `200` with an unexpanded recall — the caller sees
 * plausible results and never learns the graph was not walked.
 */
function checkTraverse(traverse) {
  if (traverse === undefined || traverse === null) return;
  if (typeof traverse === 'number') return;
  if (isPlainObject(traverse)) {
    if (traverse.depth === undefined) {
      throw new TypeError(
        'recall: the object form of `traverse` must carry `depth` — {depth, edgeLabels, direction}. '
        + 'Without it a server reading `depth ?? 0` answers 200 with an unexpanded recall, so the omission '
        + 'is invisible in the results.');
    }
    return;
  }
  throw new TypeError(
    `recall: \`traverse\` must be a depth (number) or {depth, edgeLabels, direction}, got ${JSON.stringify(traverse)}`);
}

/**
 * Build a client bound to one instance and one token.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl     e.g. `http://127.0.0.1:8080`, with or without a trailing slash
 * @param {string} opts.token       a PAT; space creation and deletion additionally need an ADMIN one
 * @param {string} [opts.totpCode]  `X-TOTP-Code`, required by the space routes when the instance has MFA on
 *                                  (`auth/middleware.ts:323`). Omit on an instance without MFA
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxAttempts]
 * @param {(info: object) => void} [opts.onRetry]  called before each backoff, for a runner that logs progress
 */
export function makeYthril({ baseUrl, token, totpCode, timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS, onRetry } = {}) {
  requireString(baseUrl, 'makeYthril({ baseUrl })');
  requireString(token, 'makeYthril({ token })');

  // Parsed to refuse a typo now rather than as a confusing DNS failure on the first write. The trailing
  // slash is trimmed and paths are CONCATENATED rather than resolved through `new URL(path, base)`, which
  // would silently discard a path prefix — an instance served at `https://host/ythril` is a real deployment
  // and `new URL('/api/spaces', 'https://host/ythril/')` points at `https://host/api/spaces`.
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new TypeError(`makeYthril({ baseUrl }): ${JSON.stringify(baseUrl)} is not a URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`makeYthril({ baseUrl }): expected http(s), got ${parsed.protocol}`);
  }
  const root = baseUrl.replace(/\/+$/, '');

  const stats = { requests: 0, retries: 0, rateLimitWaitMs: 0, degradedRecalls: 0, embedWaitMs: 0 };

  /**
   * Which source turns each written record covers — space, then record id, then the ids it accounts for.
   *
   * Kept out here, next to the client, because the alternative is keeping it in the corpus: see the `covers`
   * note in `writeRecord` for why a benchmark's answer-joining metadata must not sit inside the records the
   * benchmark is ranking.
   */
  const coverage = new Map();

  /**
   * One request, with the retry policy in the single place every call passes through.
   *
   * The alternative to retrying was batching writes through `POST /spaces/:id/bulk`, which would cut the
   * request count by an order of magnitude and cost the thing the benchmark is for: bulk applies its own
   * ordering and its own partial-failure reporting, so the write path measured would not be the write path
   * a caller uses one record at a time. Pacing is the cheaper thing to give up.
   */
  async function request(method, path, { body, headers } = {}) {
    const url = `${root}${path}`;
    let attempt = 0;
    for (;;) {
      attempt++;
      stats.requests++;
      let response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            'authorization': `Bearer ${token}`,
            'accept': 'application/json',
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(totpCode ? { 'x-totp-code': totpCode } : {}),
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // A dropped socket or a timeout. Retryable — but only while attempts remain, and the message says
        // which of the two it was, because "connection refused" and "the instance took 60s" have completely
        // different fixes and both arrive here as a TypeError from fetch.
        if (attempt >= maxAttempts) {
          throw new Error(`${method} ${path} failed after ${attempt} attempt(s): ${err.message}`, { cause: err });
        }
        stats.retries++;
        const wait = backoffMs(attempt);
        onRetry?.({ method, path, attempt, waitMs: wait, reason: err.message });
        await sleep(wait);
        continue;
      }

      const text = await response.text();
      const parsedBody = parseBody(response, text);

      if (response.ok) return parsedBody;

      if (attempt < maxAttempts && isRetryable(response.status, parsedBody)) {
        const asked = retryAfterMsFrom(response.headers);
        const wait = asked ?? backoffMs(attempt);
        stats.retries++;
        if (response.status === 429) stats.rateLimitWaitMs += wait;
        onRetry?.({ method, path, attempt, waitMs: wait, status: response.status, reason: parsedBody?.error });
        await sleep(wait);
        continue;
      }

      throw new YthrilHttpError({ status: response.status, method, path, body: parsedBody, text });
    }
  }

  /** Exponential with full jitter. Without the jitter, parallel writers retry in lockstep and re-collide. */
  function backoffMs(attempt) {
    const ceiling = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CEILING_MS);
    return Math.round(Math.random() * ceiling);
  }

  function parseBody(response, text) {
    if (text === '') return null;                        // 204, and the delete route sends one
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('json')) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;                                       // the raw text still reaches YthrilHttpError
    }
  }

  const brain = (space, tail) => `/api/brain/spaces/${encodeURIComponent(space)}${tail}`;

  /** Apply the id mapping to every reference field of one write body. Copies — the caller keeps its object. */
  function resolveRefs(space, route, record) {
    const out = { ...record };
    if (route.idField && out[route.idField] !== undefined) {
      out[route.idField] = refIdFor(space, out[route.idField]);
    }
    for (const field of route.refs) {
      if (out[field] !== undefined) out[field] = refIdFor(space, out[field]);
    }
    for (const field of route.refArrays) {
      if (Array.isArray(out[field])) out[field] = out[field].map(id => refIdFor(space, id));
    }
    return out;
  }

  /**
   * One write, plus the second call `suppressEmbeddings` costs.
   *
   * **The create routes do not accept `suppressEmbeddings`; only the PATCH routes do** (`entities.ts:291`
   * names it "the ONLY field a caller may send on its own"). So a record that must stay out of the ranked
   * results is created and then patched, and the cost is stated rather than hidden: two requests against a
   * 300/minute limiter, and one wasted embedding — the queue may compute a vector before the patch lands,
   * which `embedStoredRecord` then unsets.
   *
   * Dropping the flag instead would have been silent, and silent is the expensive option here: a suppressed
   * record that embeds anyway competes for a `topK` slot with the records carrying the actual content, so a
   * rung's score would fall for a reason invisible in every artefact the run produces.
   */
  async function writeRecord(space, kind, record) {
    requireString(space, `write ${kind}: space`);
    if (!isPlainObject(record)) {
      throw new TypeError(`write ${kind}: the record must be a plain object, got ${JSON.stringify(record)}`);
    }
    const route = WRITE_ROUTES[kind];
    const { suppressEmbeddings, covers, ...rest } = record;
    /*
     * `covers` is the benchmark's own bookkeeping, and it is stripped here rather than stored.
     *
     * ## Why it must not go into the record
     *
     * A memory's embedded text is built from its fact, tags, description and PROPERTIES
     * (`brain/embed-text.ts`), key and value both. So a rung recording which source turns a record covers as
     * `properties.turn` appends `turn D3:1,D3:2,D3:3,D3:4,D3:5` to the text that gets ranked — a dozen
     * meaningless tokens on every record in the corpus, diluting every vector by the same amount.
     *
     * That is not a shape decision anybody was making on purpose. It is the answer-joining metadata of the
     * measurement, sitting inside the thing being measured, and no real deployment would store it. Keeping
     * the mapping out here instead leaves the corpus holding only what a user would actually have.
     *
     * ## Why it lives on the client rather than being returned
     *
     * Every ingest module writes through this one function, so the map is complete without each of them
     * remembering to report. The runner reads it back with `coverage(space)` after the ingest and joins on
     * the record id, which the create response carries.
     */
    if (covers !== undefined) {
      if (!Array.isArray(covers)) {
        throw new TypeError(`write ${kind}: \`covers\` must be an array of source ids, got ${JSON.stringify(covers)}`);
      }
    }
    if (suppressEmbeddings !== undefined && typeof suppressEmbeddings !== 'boolean') {
      throw new TypeError(`write ${kind}: \`suppressEmbeddings\` must be a boolean, got ${JSON.stringify(suppressEmbeddings)}`);
    }
    /*
     * AN ID IS MINTED WHEN THE CALLER SUPPLIES NONE, and this is what makes a retry safe.
     *
     * `request` retries a dropped socket, and a dropped socket says nothing about whether the write landed —
     * so without an id, a lost response duplicates the record and the corpus quietly grows records nobody
     * wrote. Duplicates are the worst possible corruption for this measurement: they change ranking without
     * changing anything a results table shows.
     *
     * With one, the retry is an update instead. `remember` looks the id up before inserting and merges
     * ("a supplied id makes a retry idempotent" — `memories.ts:110`; same shape in `upsertEntity` and
     * `createChrono` at `chrono.ts:120`). An edge needs none: its identity IS (from, to, label), so the
     * repeat POST already merges — `edges.ts:88`.
     *
     * The value is the same kind of server-minted UUID the route would have generated; only the side that
     * generates it moves, and the created record comes back carrying it either way.
     */
    const body = resolveRefs(space, route, rest);
    if (route.idField && body[route.idField] === undefined) body[route.idField] = randomUUID();

    const created = await request('POST', brain(space, `/${route.segment}`), { body });
    if (covers !== undefined) {
      if (!coverage.has(space)) coverage.set(space, new Map());
      coverage.get(space).set(created._id, covers);
    }
    if (suppressEmbeddings === true) {
      await request('PATCH', brain(space, `/${route.segment}/${encodeURIComponent(created._id)}`), {
        body: { suppressEmbeddings: true },
      });
    }
    return created;
  }

  return {
    /**
     * Create a space. Admin token (`spaces.ts:270` is `requireAdminMfa`-gated).
     *
     * `label` defaults to the id: the contract's signature carries no label, the field is required by
     * `CreateSpaceBody`, and it is a display string — the identity the caller chose is the id, which is
     * passed through untouched. `opts` is additive, so `createSpace(id)` alone is the contract call.
     *
     * **`chronoTypes` is the one that will bite.** Without custom chrono schemas the accepted types are
     * exactly `event, deadline, plan, prediction, milestone` (`spaces/schema-validation.ts:192`), and the
     * check is in the ROUTE, so no `validationMode` relaxes it. Declaring types here makes them the
     * allowlist. A rung writing `type: 'conversation-session'` into a space created without them gets a
     * `400` on its first chrono write.
     *
     * Meta is otherwise left alone deliberately: a new space defaults to `validationMode: 'strict'` and
     * `strictLinkage: true`, and loosening that for the benchmark would measure a configuration nobody
     * ships — including the dangling-reference check, which is exactly the kind of ingestion bug a
     * benchmark should fail on rather than score around.
     *
     * @param {string} id
     * @param {object} [opts]
     * @param {string} [opts.label]
     * @param {string[]} [opts.chronoTypes]  chrono `type` values this space must accept
     * @param {object} [opts.meta]           merged over the seeded meta; wins on conflict
     * @param {number} [opts.maxGiB]
     */
    async createSpace(id, opts = {}) {
      requireString(id, 'createSpace(id)');
      const chronoSchemas = opts.chronoTypes
        ? Object.fromEntries(opts.chronoTypes.map(t => [t, {}]))
        : undefined;
      /*
       * `typeSchemas` is the corpus's OWN definition of what it may contain, and declaring it turns a class
       * of silent benchmark corruption into a 400 at the first write.
       *
       * A new space defaults to `validationMode: 'strict'`, and the keys of each collection's map are an
       * ALLOWLIST — `types-knowledge.ts:434`. So a rung that declares `memory: { utterance: … }` and then
       * writes `type: 'note'` is refused, and a property declared `required` that the rung forgets to send is
       * refused. Without a schema, strict mode validates nothing: there is no rule to violate.
       *
       * That matters here more than it would in an application. A benchmark's failure mode is not an
       * exception, it is a number — a corpus missing a field scores low and reads as a finding about
       * retrieval. Two experiments were lost to exactly that in one afternoon, both of which a required
       * property would have stopped at record one.
       *
       * Merged UNDER `opts.meta`, so a caller can still override the whole thing deliberately.
       */
      const meta = {
        ...(chronoSchemas ? { typeSchemas: { chrono: chronoSchemas } } : {}),
        ...(opts.typeSchemas ? { typeSchemas: opts.typeSchemas } : {}),
        ...(opts.meta ?? {}),
      };
      const body = {
        id,
        label: opts.label ?? id,
        ...(opts.maxGiB !== undefined ? { maxGiB: opts.maxGiB } : {}),
        ...(Object.keys(meta).length > 0 ? { meta } : {}),
      };
      // `{ space }`, not the space — `spaces.ts:286`. Unwrapped here so a caller reads `indexStatus`
      // without knowing that.
      const created = await request('POST', '/api/spaces', { body });
      return created.space;
    },

    /**
     * Delete a space and everything in it. Admin token; `{ confirm: true }` is required by
     * `DeleteSpaceBody` (`spaces/body-schemas.ts:270`) and is the guard against deleting the wrong one.
     *
     * **A `202` is not a deletion.** A space that belongs to a network opens a vote instead and the data is
     * still there (`spaces.ts:791`). Reporting that as success is how the next run writes its corpus on top
     * of the last one's, so it throws.
     */
    async deleteSpace(id) {
      requireString(id, 'deleteSpace(id)');
      const path = `/api/spaces/${encodeURIComponent(id)}`;
      const answer = await request('DELETE', path, { body: { confirm: true } });
      // `{ status: 'vote_pending', rounds }` — `spaces.ts:836`. Matched on the field the server states
      // rather than on the 202, because `request` has already discarded the status by here and the
      // identity of the outcome is the thing worth branching on.
      if (isPlainObject(answer) && answer.status === 'vote_pending') {
        throw new Error(
          `deleteSpace(${id}): the instance opened a deletion VOTE (202) instead of deleting — the space is `
          + 'in a network and its data is still present. Use a space that is not federated for benchmark runs.');
      }
      return true;
    },

    /**
     * How many records a space holds, per collection — `GET /api/brain/spaces/:id/stats`.
     *
     * Added for `--reuse-spaces`, whose whole safety rests on being able to tell a populated space from an
     * empty or absent one. A reused space that is missing or half-written produces a LOW score, and a low
     * score reads as a finding about retrieval rather than as a broken run — the most expensive way to be
     * wrong in a benchmark.
     *
     * These are TOTALS and not search coverage: a record is counted here before its embedding exists, which
     * is why `waitForEmbeddings` still runs after this and is not replaced by it.
     */
    async spaceStats(space) {
      requireString(space, 'spaceStats: space');
      return request('GET', `/api/brain/spaces/${encodeURIComponent(space)}/stats`);
    },

    writeMemory: (space, record) => writeRecord(space, 'memory', record),

    /**
     * The record-to-source-turn map this client recorded while ingesting `space`.
     *
     * EMPTY is a legitimate answer — a rung that stores its coverage in the record itself never passes
     * `covers`, and the runner falls back to reading it from the record. It is NOT a legitimate answer after
     * `--reuse-spaces`, where no ingest ran and the map was never built; the runner refuses that combination
     * rather than scoring every question at zero and reporting a number.
     */
    coverage: space => coverage.get(space) ?? new Map(),
    writeEntity: (space, record) => writeRecord(space, 'entity', record),
    writeEdge: (space, record) => writeRecord(space, 'edge', record),
    writeChrono: (space, record) => writeRecord(space, 'chrono', record),

    /**
     * Semantic search. Returns the WHOLE response envelope, not just `results`.
     *
     * `degraded`, `truncated`, `nextSkip`, `count` and `bytesReturned` are on the envelope, and each one
     * changes what a score means: a recall that hit `search_timeout` or ran out of byte budget returned
     * fewer records for a reason that has nothing to do with the retriever. Handing back a bare array would
     * drop exactly the fields that tell a results table when not to trust itself.
     *
     * Parameters are passed through rather than allowlisted. `/recall`'s body is STRICT
     * (`brain/query.ts:99` + `search.ts:359`), so a typo is a `400` naming the key — where a client-side
     * allowlist would drop it silently, which is the same defect one layer earlier.
     */
    async recall(space, params) {
      requireString(space, 'recall: space');
      if (!isPlainObject(params)) throw new TypeError('recall: params must be a plain object');
      requireString(params.query, 'recall: query');
      checkTraverse(params.traverse);
      let answer;
      try {
        answer = await request('POST', brain(space, '/recall'), { body: params });
      } catch (err) {
        // An instance predating the object form refuses it with the numeric-only message, and the caller's
        // grid cell is the thing that has to change. Said here because the server's own text cannot know
        // that the client offered a form the server does not have.
        if (err instanceof YthrilHttpError && err.status === 400 && isPlainObject(params.traverse)
            && /traverse/i.test(err.message)) {
          throw new YthrilHttpError({
            status: err.status, method: 'POST', path: err.path, body: err.body,
            note: 'sent as the object form {depth, edgeLabels, direction}; this instance may accept only a '
              + 'numeric depth, in which case the grid cell is what has to change',
          });
        }
        throw err;
      }
      if (Array.isArray(answer?.degraded) && answer.degraded.length > 0) stats.degradedRecalls++;
      return answer;
    },

    /**
     * Deterministic MongoDB-filter read. Envelope again — `total` is how a caller learns the page it got is
     * not the whole match, and `count` alone cannot say that.
     */
    async query(space, params) {
      requireString(space, 'query: space');
      if (!isPlainObject(params)) throw new TypeError('query: params must be a plain object');
      return request('POST', brain(space, '/query'), { body: params });
    },

    /**
     * Block until the space is actually searchable, or fail saying why it is not.
     *
     * ## Two layers, both of which look like poor recall
     *
     * 1. **The embed queue.** A write returns before its vector exists — the queue computes it moments
     *    later (`memories.ts:117`). Recall cannot see a record with no vector, so a retrieval run started
     *    early measures the queue.
     * 2. **The vector index itself.** A freshly created space comes back `indexStatus: "building"` and
     *    "semantic recall returns no results until the Atlas vector indexes finish building"
     *    (docs 06-spaces-api.md:139). An absent `indexStatus` means ready — proxy spaces and older spaces
     *    have none — so absence is treated as ready rather than as a reason to wait forever.
     *
     * ## And two ways to be not-ready that are not just slowness
     *
     * A `failed` job is a permanent hole: that record is invisible to every recall for the whole run, and
     * a score computed over a corpus with holes is a wrong number rather than a low one. It throws, quoting
     * the errors. `allowFailedJobs: true` downgrades it to a count in the return value, for a run that has
     * decided the hole is acceptable and can say so in its report.
     *
     * A queue that stops shrinking with nothing in flight is a worker that is not running. That is reported
     * after `stallMs` rather than after the full timeout, because the answer is the same either way and one
     * of them costs ten minutes.
     *
     * @returns {Promise<{waitedMs, polls, failed, records: object}>}
     */
    async waitForEmbeddings(space, {
      timeoutMs: budgetMs = DEFAULT_EMBED_TIMEOUT_MS,
      pollMs = DEFAULT_EMBED_POLL_MS,
      stallMs = DEFAULT_EMBED_STALL_MS,
      allowFailedJobs = false,
      onPoll,
    } = {}) {
      requireString(space, 'waitForEmbeddings: space');
      const startedAt = Date.now();
      let polls = 0;
      let indexReady = false;
      let lastOutstanding = Infinity;
      let lastProgressAt = startedAt;

      for (;;) {
        polls++;

        if (!indexReady) {
          const status = await indexStatusOf(space);
          if (status === INDEX_FAILED) {
            throw new EmbeddingsNotReadyError(
              `waitForEmbeddings(${space}): the space's vector index build FAILED. Recall would return `
              + 'nothing for every query, which is indistinguishable from a retriever that finds nothing. '
              + 'Check the instance log for the index build.',
              { space, indexStatus: status });
          }
          indexReady = status !== INDEX_BUILDING;
        }

        // `limit=1` because only `counts` is wanted here — the endpoint returns a page of jobs alongside it
        // and a 50-row page per poll is bytes nobody reads. The failed rows are fetched once, below, and
        // only when there are any.
        const queue = await request('GET', brain(space, '/embedding-queue/records?limit=1'));
        const counts = queue.counts ?? { pending: 0, processing: 0, failed: 0 };
        const outstanding = counts.pending + counts.processing;
        onPoll?.({ space, polls, counts, indexReady, elapsedMs: Date.now() - startedAt });

        if (outstanding < lastOutstanding) {
          lastOutstanding = outstanding;
          lastProgressAt = Date.now();
        }

        if (outstanding === 0 && indexReady) {
          /*
           * The queue being empty is not the same as the corpus being searchable, and believing it was cost
           * a whole rung's measurement.
           *
           * A rung that wrote 35 records finished its ingest in 9 seconds, drained its queue, reported
           * `indexStatus` ready — and then returned ZERO results for all 16 questions, scoring 0.0% on every
           * column. The same queries answered normally against the same space minutes later. Two ways to get
           * here and this check does not care which: the jobs had not been enqueued yet when the first poll
           * ran, or the vector index on a brand-new space was not live and reported nothing rather than
           * `building` (an absent status reads as ready, above). Both look identical from outside — the
           * queue is empty because nothing is in it yet.
           *
           * A big corpus hides this. The rungs writing 419 and 186 records took long enough that the index
           * was live before anyone asked. **So the bug only appears on the FAST rung**, which is the one
           * whose ingest is cheapest and therefore the one most likely to be run alone.
           *
           * The proxy cannot distinguish "nothing left to embed" from "nothing enqueued yet", so this stops
           * asking the proxy and asks the thing itself: does a recall return anything at all? The probe query
           * is a fixed neutral string — vector search returns the nearest records for ANY query, so a
           * non-empty answer means the index is live, and no question is ever consulted to build it.
           */
          const searchable = await isSearchable(space);
          if (searchable) {
            stats.embedWaitMs += Date.now() - startedAt;
            if (counts.failed > 0 && !allowFailedJobs) throw await failedJobsError(space, counts);
            return { waitedMs: Date.now() - startedAt, polls, failed: counts.failed, records: counts };
          }
          // Not searchable yet: the drain was premature. Keep the stall clock honest by treating this as
          // progress, or the "no progress for Ns" branch below fires on a queue that is legitimately empty.
          lastProgressAt = Date.now();
        }

        if (counts.processing === 0 && outstanding > 0 && Date.now() - lastProgressAt > stallMs) {
          throw new EmbeddingsNotReadyError(
            `waitForEmbeddings(${space}): ${counts.pending} job(s) pending, none processing, and no progress `
            + `for ${Math.round((Date.now() - lastProgressAt) / 1000)}s. The embedding worker is not running `
            + 'or cannot reach its model — this is a stalled queue, not a slow one.',
            { space, counts, polls });
        }

        if (Date.now() - startedAt > budgetMs) {
          throw new EmbeddingsNotReadyError(
            `waitForEmbeddings(${space}): still not searchable after ${Math.round(budgetMs / 1000)}s `
            + `(pending ${counts.pending}, processing ${counts.processing}, failed ${counts.failed}, `
            + `index ${indexReady ? 'ready' : INDEX_BUILDING}). REFUSING to retrieve — a run started here `
            + 'measures the queue, not the retriever, and the result is indistinguishable from poor recall.',
            { space, counts, indexReady, polls, waitedMs: Date.now() - startedAt });
        }

        await sleep(pollMs);
      }
    },

    /**
     * The UUID a readable id was written under, so any module can join a record back to the string that
     * named it. See `refIdFor` for why the mapping exists at all.
     */
    refId: (space, localId) => refIdFor(requireString(space, 'refId: space'), localId),

    /**
     * What the client had to do to get the numbers. `retries` and `rateLimitWaitMs` explain a slow run;
     * `degradedRecalls` is the one that changes what a SCORE means, and a report that omits it is claiming
     * the retriever produced answers the server admitted were partial.
     */
    stats: () => ({ ...stats }),
  };

  /** `GET /api/spaces` is the only non-admin route reporting `indexStatus` — `spaces.ts:202`. */
  async function indexStatusOf(space) {
    const listing = await request('GET', '/api/spaces');
    const found = (listing?.spaces ?? []).find(s => s.id === space);
    // Not listed means the token cannot see it, which the queue poll below will refuse far more clearly
    // than a guess here would. Ready is the documented reading of an absent status.
    return found?.indexStatus;
  }

  /**
   * Can a recall against this space return anything at all?
   *
   * The probe is one fixed, neutral query at `topK: 1`. It is not a quality check and must never become one:
   * vector search ranks every record against whatever it is given, so a non-empty answer means the index is
   * live and says nothing about whether the retriever is any good. A benchmark question is never used —
   * nothing here may see one, and a probe built from a question would also make "searchable" depend on which
   * question happened to be asked first.
   *
   * An EMPTY space answers true. It holds nothing, so there is nothing to become searchable, and returning
   * false would spin until the timeout on a space whose ingest legitimately wrote no records.
   */
  async function isSearchable(space) {
    // Not named `stats` — that is the module's own counters object, and shadowing it here would make
    // `stats.embedWaitMs` in the caller read like it belonged to this response.
    const spaceCounts = await request('GET', brain(space, '/stats'));
    const held = (spaceCounts?.memories ?? 0) + (spaceCounts?.entities ?? 0) + (spaceCounts?.chrono ?? 0);
    if (held === 0) return true;
    const probe = await request('POST', brain(space, '/recall'),
      { body: { query: SEARCHABLE_PROBE, topK: 1 } });
    return (probe?.results ?? []).length > 0;
  }

  /** Name the failures rather than reporting a count nobody can act on. */
  async function failedJobsError(space, counts) {
    let sample = [];
    try {
      const failed = await request('GET', brain(space, `/embedding-queue/records?status=failed&limit=${FAILED_JOBS_QUOTED}`));
      sample = (failed.jobs ?? []).map(j => `${j.recordType} ${j.recordId}: ${j.lastError ?? 'no error recorded'}`);
    } catch (err) {
      sample = [`(could not list the failed jobs: ${err.message})`];
    }
    return new EmbeddingsNotReadyError(
      `waitForEmbeddings(${space}): the queue drained but ${counts.failed} record(s) FAILED to embed. Each one `
      + 'is invisible to every recall for the whole run, so the corpus has holes and a score over it is a wrong '
      + `number rather than a low one. Pass { allowFailedJobs: true } to proceed and report the count.\n  `
      + sample.join('\n  '),
      { space, counts, failedSample: sample });
  }
}
