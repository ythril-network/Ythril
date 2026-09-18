/**
 * Shared HTTP helpers for integration tests.
 * Assumes instances are running at http://localhost:320{0,1,2}.
 */

import { execSync } from 'node:child_process';

/** Synchronous sleep (these container-config readers are called synchronously). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run a `docker exec` command, retrying on transient failure.
 *
 * The server persists config.json via an atomic temp-file + rename. Across a
 * Docker bind mount (notably Docker Desktop on Windows), that rename has a brief
 * non-atomic window where a concurrent read can observe the file as missing
 * (ENOENT) or half-written. Because the sync engine calls saveConfig frequently
 * (watermarks, gossip merges), a test that reads a container's config via
 * `docker exec` can race a write — so we retry to ride out the window.
 */
export function dockerExec(cmd, { retries = 10, delayMs = 150 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    } catch (err) {
      lastErr = err;
      if (i < retries) sleepSync(delayMs);
    }
  }
  throw lastErr;
}

/** Read and parse a container's /config/config.json (resilient to write races). */
export function readContainerConfig(container) {
  return JSON.parse(dockerExec(`docker exec ${container} node -e "const fs=require('fs');process.stdout.write(fs.readFileSync('/config/config.json','utf8'))"`));
}

/** Read and parse a container's /config/secrets.json (resilient to write races). */
export function readContainerSecrets(container) {
  return JSON.parse(dockerExec(`docker exec ${container} node -e "const fs=require('fs');process.stdout.write(fs.readFileSync('/config/secrets.json','utf8'))"`));
}

/** Read a container's instanceId from its config (resilient to write races). */
export function getInstanceId(container) {
  return dockerExec(`docker exec ${container} node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('/config/config.json','utf8'));process.stdout.write(c.instanceId)"`).trim();
}

export const INSTANCES = {
  a: 'http://127.0.0.1:3200',
  b: 'http://127.0.0.1:3201',
  c: 'http://127.0.0.1:3202',
  d: 'http://127.0.0.1:3203',
};

/**
 * Make an authenticated request.
 * @param {string} baseUrl  - instance base URL
 * @param {string} token    - PAT token
 * @param {string} path     - URL path including leading /
 * @param {RequestInit} opts
 */
export async function req(baseUrl, token, path, opts = {}) {
  const url = `${baseUrl}${path}`;
  const resp = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(opts.headers ?? {}),
    },
  });
  return resp;
}

/** req() but parse JSON body automatically */
export async function reqJson(baseUrl, token, path, opts = {}) {
  const resp = await req(baseUrl, token, path, opts);
  const body = await resp.json().catch(() => null);
  return { status: resp.status, body };
}

/** POST with JSON body */
export async function post(baseUrl, token, path, data) {
  return reqJson(baseUrl, token, path, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/**
 * POST with automatic retry on 429 (rate limit).
 * Reads the standard Retry-After HTTP header (seconds); defaults to 5 s.
 */
export async function postRetry429(baseUrl, token, path, data, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await req(baseUrl, token, path, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    if (resp.status !== 429) {
      const body = await resp.json().catch(() => null);
      return { status: resp.status, body };
    }
    const retryAfter = parseInt(resp.headers.get('retry-after') ?? '5', 10);
    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
  }
  // final attempt — return whatever we get
  return post(baseUrl, token, path, data);
}

/**
 * PATCH with JSON body.
 *
 * `headers` is optional and merges over the defaults — it exists for `If-Match`, which is a header rather
 * than a body field and so cannot be exercised through the body-only form.
 */
export async function patch(baseUrl, token, path, data, headers) {
  return reqJson(baseUrl, token, path, {
    method: 'PATCH',
    body: JSON.stringify(data),
    ...(headers ? { headers } : {}),
  });
}

/** PUT with JSON body */
export async function put(baseUrl, token, path, data) {
  return reqJson(baseUrl, token, path, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

/** DELETE */
export async function del(baseUrl, token, path) {
  return reqJson(baseUrl, token, path, { method: 'DELETE' });
}

/** DELETE with JSON body */
export async function delWithBody(baseUrl, token, path, data) {
  return reqJson(baseUrl, token, path, {
    method: 'DELETE',
    body: JSON.stringify(data),
  });
}

/** GET */
export async function get(baseUrl, token, path) {
  return reqJson(baseUrl, token, path);
}

/**
 * Poll until condition() returns true or timeout (ms).
 *
 * `diagnose` (string or fn) is appended to the timeout message. Use it to explain WHY
 * the wait failed — a bare "timed out after 90000ms" is nearly useless, and actively
 * dangerous: a persistent, actionable error can masquerade as a mysterious flake. That
 * is exactly how the notify rate-limit bug hid for weeks — every sync trigger was being
 * rejected with 429, the tests swallowed it, and all we ever saw was a timeout.
 */
export async function waitFor(condition, timeout = 15_000, interval = 500, diagnose) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) {
      warnIfTight(Date.now() - start, timeout);
      return true;
    }
    await new Promise(r => setTimeout(r, interval));
  }
  // AWAITED, so a diagnostic may go and LOOK at something.
  //
  // It used to be called synchronously, which silently limited every caller to facts already in hand. The sync
  // stall under investigation cannot be explained by any of those: the question is whether the sender still holds
  // the record and where its watermark sits, and both take a request. A `diagnose` returning a promise used to
  // interpolate as `[object Promise]`.
  const detail = typeof diagnose === 'function' ? await diagnose() : diagnose;
  throw new Error(`waitFor timed out after ${timeout}ms${detail ? ` — ${detail}` : ''}`);
}

/** Above this share of the budget, a PASS is worth reporting: it is one slow runner from being a failure. */
const TIGHT_MARGIN = 0.6;

/**
 * Say so when a wait only just made it.
 *
 * ## Why a passing wait needs to report anything
 *
 * `Subscriber-local content survives publisher tombstone` failed in CI on a diff of client CSS, docs and a
 * changelog — nothing that can touch sync propagation — and passed on rerun with no code change. The obvious
 * move is to raise the 25 s and move on. It is also a guess: nobody knows whether a green run takes 3 s or 24 s,
 * so nobody knows whether the margin is thin or whether something occasionally STALLS and the deadline is
 * merely how we found out. Those are different problems and only one of them is fixed by a bigger number.
 *
 * The measurement was missing, so this adds it — for every wait in the suite rather than the one that went red.
 * A pass that consumed most of its budget now prints the numbers, so the next person deciding a timeout has
 * evidence instead of a hunch, and a wait that is drifting toward its ceiling says so BEFORE it starts failing.
 *
 * Deliberately not a failure. Turning a slow pass into a red build would make CI stricter than the product,
 * and the propagation time legitimately varies with what else the runner is doing.
 */
function warnIfTight(elapsed, timeout) {
  if (elapsed <= timeout * TIGHT_MARGIN) return;
  const pct = Math.round((elapsed / timeout) * 100);
  console.warn(`[waitFor] passed after ${elapsed}ms of a ${timeout}ms budget (${pct}%) — thin margin, and a `
    + 'slower runner turns this into a timeout. Raise the budget only if this is normal rather than a stall.');
}

/**
 * Wait until every id is visible to `$vectorSearch`, then return how long it took.
 *
 * ## Why this is one helper and not four copies of a 30-second timeout
 *
 * The Atlas Local vector index is **eventually consistent**: a record that came back 201 is not yet visible to
 * `$vectorSearch`, and nothing in the write path tells you when it will be. Four test files each grew their own
 * copy of this poll, each with a 30 s deadline that nobody had measured against anything.
 *
 * The lag has been observed at up to **150 s** on the CI runner. So the deadline was not conservative, it was
 * simply wrong, and its failure — `Timed out waiting for indexing of: <uuid>` inside a `before` hook — cancels
 * every test in the suite and reads exactly like a real regression. That has now failed CI four separate times.
 *
 * `INDEX_LAG_TIMEOUT_MS` is deliberately well beyond the worst observation rather than just past it. **This costs
 * nothing when the index is quick** — the poll returns on the first hit — so the only thing a bigger number buys
 * is not failing, and the only thing a smaller one buys is failing sooner on a slow runner.
 *
 * A test that does NOT need the index should not call this at all; prefer asserting on what the record itself
 * returns. `embed-properties` was rewritten that way and stopped flaking entirely.
 *
 * @param types Record types to poll. Narrow it — polling for types you did not write cannot succeed.
 */
export const INDEX_LAG_TIMEOUT_MS = 300_000;

/**
 * Wait until `$vectorSearch` ITSELF can see a record — the question `waitForIndexed` stopped answering.
 *
 * ## Why a second poll rather than a flag on the first
 *
 * `waitForIndexed` polls `recall`, and since 5.0 every recall also scans the newest records straight from
 * the collection. So it now returns as soon as the record is WRITTEN, which is what most callers actually
 * want and is why it stays as it is: a test that only needs "recall can find this" is now unblocked sooner
 * and is not lying to itself.
 *
 * But `find_similar` and duplicate detection do NOT have that scan — they search the index and nothing else.
 * For them the old poll became a green light that means nothing, and the symptom is an empty `results` in a
 * test whose fixture "finished waiting": exactly the kind of pass-shaped failure this file exists to stop.
 *
 * So this asks the question those callers depend on, using the capability they are about to use. A seed id
 * whose similarity search returns `expectedId` proves BOTH records reached the index, because the seed's
 * vector is read from the collection and the match can only come from `$vectorSearch`.
 *
 * @param seedId     the entry whose stored vector drives the search
 * @param expectedId the record that must come back — the proof the index has ingested
 */
export async function waitForSimilarityIndex(
  baseUrl, token, spaceId, seedId, entryType, expectedId, timeoutMs = INDEX_LAG_TIMEOUT_MS,
) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let last = null;
  let polls = 0;
  while (Date.now() < deadline) {
    const r = await post(baseUrl, token, '/api/brain/similar',
      { space: spaceId, entryId: seedId, entryType, topK: 50 });
    polls++;
    last = r.status;
    const ids = (r.body?.results ?? []).map(x => x.record?._id ?? x._id);
    if (r.status === 200 && ids.includes(expectedId)) return;
    await new Promise(res => setTimeout(res, 500));
  }
  const how = last === 200
    ? `find_similar answered 200 every time and never listed it, over ${polls} polls`
    : `the last find_similar returned ${last} — this is not index lag, the endpoint itself is failing`;
  throw new Error(
    `Timed out after ${Math.round((Date.now() - started) / 1000)}s waiting for $vectorSearch to see `
    + `${expectedId} from seed ${seedId} in space ${spaceId}: ${how}`);
}

export async function waitForIndexed(baseUrl, token, spaceId, ids, types, timeoutMs = INDEX_LAG_TIMEOUT_MS) {
  const pending = new Set(ids);
  const started = Date.now();
  const deadline = started + timeoutMs;
  let lastStatus = null;
  let polls = 0;
  while (pending.size > 0 && Date.now() < deadline) {
    const r = await post(baseUrl, token, '/api/brain/recall', { space: spaceId, ...({ query: 'indexing probe query', types, topK: 100 }) });
    polls++;
    lastStatus = r.status;
    if (r.status === 200 && Array.isArray(r.body?.results)) {
      // Both shapes, because the four copies of this poll did not agree on one: most read `result._id`, one read
      // `result.record?._id ?? result._id`. A copy that guesses wrong never matches anything and times out in
      // full — a hard failure that looks exactly like index lag. Accepting both is the only version that cannot
      // be silently wrong.
      for (const result of r.body.results) pending.delete(result.record?._id ?? result._id);
    }
    if (pending.size > 0) await new Promise(res => setTimeout(res, 500));
  }
  if (pending.size > 0) {
    // Say which of the two failures this is. A recall that never returned 200 is a broken instance and has
    // nothing to do with index lag, but the old message described both as "timed out waiting for indexing".
    const how = lastStatus === 200
      ? `recall answered 200 every time and never listed them, over ${polls} polls`
      : `the last recall returned ${lastStatus} — this is not index lag, recall itself is failing`;
    throw new Error(
      `Timed out after ${Math.round((Date.now() - started) / 1000)}s waiting for $vectorSearch to see `
      + `${[...pending].join(', ')} in space ${spaceId} (types: ${types.join(',')}): ${how}`);
  }
  return Date.now() - started;
}

/** Trigger a sync run on an instance for a given networkId. Throws on any non-200. */
export async function triggerSync(baseUrl, token, networkId) {
  const r = await post(baseUrl, token, '/api/notify/trigger', { networkId });
  if (r.status !== 200) throw new Error(`triggerSync failed: ${r.status} ${JSON.stringify(r.body)}`);
}

/**
 * Build a sync trigger for use INSIDE a waitFor poll.
 *
 * Re-triggering each poll is deliberate (a single up-front trigger races a slow gossip
 * cycle), but a naked `triggerSync(...).catch(() => {})` is a trap: it tolerates a
 * transient blip and a permanent misconfiguration identically, and the latter then
 * shows up only as an unexplained timeout.
 *
 * This tolerates failures so one bad poll doesn't fail the test, but REMEMBERS the last
 * one. Pass `probe.diagnose` to waitFor so a persistent failure is reported as itself
 * (e.g. "429 Too Many Requests") instead of a silent stall.
 */
export function makeTriggerProbe(baseUrl, token, networkId, label = baseUrl) {
  const probe = async () => {
    try {
      await triggerSync(baseUrl, token, networkId);
      probe.lastError = null;
      probe.okCount++;
    } catch (err) {
      probe.lastError = err;
      probe.failCount++;
    }
  };
  probe.lastError = null;
  probe.okCount = 0;
  probe.failCount = 0;
  probe.diagnose = () =>
    probe.lastError
      ? `every sync trigger to ${label} was failing (${probe.failCount} failed / ${probe.okCount} ok); last error: ${probe.lastError.message}`
      : `sync triggers to ${label} all succeeded (${probe.okCount}) — the peer simply never delivered the expected state`;
  return probe;
}

/**
 * Trigger a sync and poll `condition` until it holds, RE-triggering while waiting.
 *
 * ## The three-part failure this replaces
 *
 * 23 call sites across ten sync/integration files were `await triggerSync(...)` followed by a bare `waitFor`.
 * Each one has three defects that only show up together, on a slow runner:
 *
 *   1. **One trigger races the gossip cycle.** If that single async fire is queued behind other work, nothing
 *      arrives and the poll expires having waited for something nobody asked for a second time.
 *   2. **A bare timeout cannot tell a stall from a rejection.** `waitFor timed out after 15000ms` reports a
 *      persistently-429'd trigger, a misconfigured network id and a merely-slow peer identically. That exact
 *      message is how the notify rate-limit bug hid for weeks.
 *   3. **It does not say what it was waiting for.** A test with two identical waits names neither.
 *
 * `closed-network.test.js` had already worked this out and hand-rolled it at ONE of its four sites; the other
 * three, and every other file, kept the bare form. Which is the argument for a helper rather than a comment.
 *
 * @param what Human phrase completing "waiting for …". Appears in the timeout message; not optional, because
 *   the whole point is that the failure explains itself.
 */
export async function syncUntil(baseUrl, token, networkId, condition, what, { timeoutMs = 25_000, interval = 500, retriggerMs = 3_000, label, onTimeout } = {}) {
  await triggerSync(baseUrl, token, networkId);
  const probe = makeTriggerProbe(baseUrl, token, networkId, label ?? baseUrl);
  const retrigger = setInterval(() => { void probe(); }, retriggerMs);
  try {
    return await waitFor(condition, timeoutMs, interval, async () => {
      // `onTimeout` may fail for its own reasons — a 404, a network blip — and a diagnostic that throws replaces
      // the real timeout message with its own error, which is strictly worse than no diagnostic.
      let extra = '';
      if (typeof onTimeout === 'function') {
        try { extra = (await onTimeout()) ?? ''; } catch (e) { extra = `diagnostic failed: ${e.message}`; }
      }
      return `waiting for ${what} — ${probe.diagnose()}${extra ? ` — ${extra}` : ''}`;
    });
  } finally {
    clearInterval(retrigger);
  }
}

/**
 * WHICH SIDE LOST THE RECORD: the sender never sent it, or the receiver never stored it.
 *
 * For a propagation timeout, those are the only two possibilities, and the whole reason the intermittent pub/sub
 * stall has survived four rounds of investigation is that the timeout message cannot tell them apart. Six
 * reproduction attempts — three isolated, one full-suite, and two against a cold stack — all passed at ~1.1 s
 * against a 25 s budget, so the failure is not reachable locally and the next CI occurrence has to be the one
 * that answers this.
 *
 * `GET /api/networks/:id` returns each member with its `lastSeqPushed` and `lastSeqReceived` (it strips only the
 * token hash), so no server change is needed to read the watermark.
 *
 * Three outcomes, each excluding the others:
 *
 *  - **The sender does not have the record** — the write failed, and this was never a sync problem.
 *  - **It has it and `lastSeqPushed` >= its `seq`** — the watermark passed a record that never arrived. The push
 *    query is `seq > lastSeqPushed`, so this should be impossible; measuring it would disprove that reasoning,
 *    which is why it is worth stating rather than assuming.
 *  - **It has it and `lastSeqPushed` < its `seq`** — the sender should have sent it, so the record was lost on
 *    the wire or discarded by the receiver.
 */
export async function whichSideLostIt(senderUrl, senderToken, networkId, spaceId, recordId, type = 'facts') {
  const rec = await readRecord(senderUrl, senderToken, spaceId, type, recordId);
  if (rec.status !== 200) return `the SENDER does not have ${recordId} either (${rec.status}) — the write, not sync`;
  const seq = rec.body?.seq;
  const net = await get(senderUrl, senderToken, `/api/networks/${networkId}`);
  if (net.status !== 200) return `sender holds ${recordId} at seq ${seq}; could not read the network (${net.status})`;
  const marks = (net.body?.members ?? []).map(m =>
    `${m.label ?? m.instanceId}: pushed=${m.lastSeqPushed?.[spaceId] ?? 'unset'} received=${m.lastSeqReceived?.[spaceId] ?? 'unset'}`);
  const passed = (net.body?.members ?? []).some(m => (m.lastSeqPushed?.[spaceId] ?? -1) >= seq);
  return `the SENDER HOLDS ${recordId} at seq ${seq}; watermarks [${marks.join(' | ')}] — `
    + (passed
      ? 'a watermark is AT OR PAST that seq, so it was marked sent and never will be again'
      : 'no watermark reached that seq, so the sender should still be offering it: lost on the wire or discarded '
        + 'by the receiver');
}

/**
 * A `filter` call over REST, with the tool envelope unwrapped — the ONE place a test does that.
 *
 * `POST /api/filter` is the generic tool door and the only one since `B-9` step 3c deleted the
 * hand-written twin at `/api/brain/filter`. It answers `{ok, text, data}` for every tool, so a caller
 * writes the response handling once — and `data` is where the page is.
 *
 * **The refusal sentence lands where the twin put it.** A failed call comes back as `{error}`, because
 * a dozen assertions print `body.error` and the generic door spells it `error` on a 4xx and `text` in
 * the prose half. Normalising it here is the difference between a readable failure and `undefined`.
 */
export async function filterRest(baseUrl, token, args) {
  const r = await post(baseUrl, token, '/api/filter', args);
  return {
    status: r.status,
    body: r.status === 200 ? (r.body?.data ?? null) : { ...(r.body ?? {}), error: r.body?.error ?? r.body?.text },
  };
}
/**
 * Read a page of a brain collection - the ONE way a test asks that question.
 *
 * ## Why a helper and not a `get` per call site
 *
 * `B-9` step 3 deleted the nine `GET /api/brain/spaces/:spaceId/<collection>` routes, so a collection is
 * read through `filter` and nothing else. Eighty-five call sites were each a hand-written `get` with a
 * query string; eighty-five hand-written POST bodies would have been eighty-five chances to drop the
 * guard below, and the next suite written would have made it eighty-six.
 *
 * ## The guard, which is the half a copy drops
 *
 * **`results` is `undefined` when the call did not answer 200.** The route used to make a failure obvious -
 * a 403 had no `entities` key to loop over. `filter` answers `{results: [...]}` on success and an error
 * body on failure, so a copy that read `body.results ?? []` would turn every refusal into an empty page,
 * and an empty page passes every loop written over it. A test asserting "no rows matched" would then pass
 * against an instance that refused the read.
 *
 * So the caller gets the raw `status` to assert on, and a `results` that is only an array when there was
 * genuinely an answer.
 *
 * @param {string} baseUrl
 * @param {string} token
 * @param {string} space
 * @param {'facts'|'entities'|'edges'|'chrono'|'files'|'links'} collection
 * @param {Record<string, unknown>} [body] anything else `filter` takes: `limit`, `skip`, `sort`, `dir`,
 *   `filter`, the five conveniences, `entityName`/`fromName`/`toName`, `deriveStatus`.
 */
export async function readCollection(baseUrl, token, space, collection, body = {}) {
  const r = await filterRest(baseUrl, token, { space, collection, ...body });
  return { ...r, results: r.status === 200 ? (r.body?.results ?? []) : undefined };
}

/**
 * A chrono read derives its status; every other collection has none to derive.
 *
 * **This is the guard that makes `readRecord` a module rather than a shorthand.** The by-id route it
 * replaces derived the status on the way out — an entry past its due moment read `overdue` whatever it was
 * stored as, unless its type says a passed date means nothing. `filter` returns the STORED value unless
 * asked, which is right for a predicate and wrong for a read that used to derive.
 *
 * A hand-written copy drops this and nothing complains: the happy path is identical for four of the five
 * collections, and for the fifth it is identical for every entry whose due moment has not passed. The
 * failure only appears on a past-dated entry, which is exactly the record somebody is looking for.
 *
 * Pass `deriveStatus: false` to ask for the stored value on purpose — it is a real question, and the point
 * is that it has to be asked.
 */
const deriveChronoStatus = (collection) => (collection === 'chrono' ? { deriveStatus: true } : {});
/**
 * ONE record by id, the way the deleted `GET .../<collection>/:id` was used.
 *
 * **A missing record is `status: 404` here, and that is this helper's whole job.** `filter` answers 200
 * with an empty page - correct for a predicate, and wrong for every caller that was written against a
 * route which 404d. Translating it here keeps those assertions honest instead of quietly turning each one
 * into "the read succeeded and I ignored the rows".
 *
 * `body` reaches `filter` untouched, which is how a caller asks for `includeDiagnostics: true`. The routes
 * this replaces returned `matchedText` and `embeddingModel` unconditionally on a by-id read while WITHHOLDING
 * them on a list — two defaults for one rule, and `filter` has the one default. A test that wants the
 * embed text has to ask for it now, which is the honest version of what it was relying on.
 */
export async function readRecord(baseUrl, token, space, collection, id, body = {}) {
  const r = await readCollection(baseUrl, token, space, collection, {
    filter: { _id: id }, limit: 1, ...deriveChronoStatus(collection), ...body,
  });
  if (r.status !== 200) return { status: r.status, body: r.body };
  const doc = r.results[0];
  return doc
    ? { status: 200, body: doc }
    : { status: 404, body: { error: `${collection} '${id}' not found` } };
}

/** Create a memory on an instance's general space */
export async function createMemory(baseUrl, token, fact, tags = []) {
  return post(baseUrl, token, '/api/brain/spaces/general/facts', { fact, tags });
}

/**
 * List ALL memories on an instance's general space.
 * Pages through the API (up to 500 per request) until exhausted so callers
 * never silently receive a truncated result.
 */
export async function listFacts(baseUrl, token) {
  const all = [];
  let skip = 0;
  const pageSize = 500;
  while (true) {
    const r = await readCollection(baseUrl, token, 'general', 'facts', { limit: pageSize, skip });
    if (r.status !== 200) return r; // surface errors to callers as-is
    all.push(...r.results);
    if (r.results.length < pageSize) break;
    skip += pageSize;
  }
  return { status: 200, body: { facts: all } };
}

/**
 * Restore instance-wide state in a cleanup hook, and PROVE it took.
 *
 * ## The failure this exists to stop
 *
 * A cleanup written `await patch(...).catch(() => {})` reports success whatever happens. For a cleanup that
 * deletes a record it created, that is right: a leftover record costs nothing and the next run uses fresh ids.
 * For a cleanup that restores INSTANCE-WIDE state it is wrong, because the cost is not this test — it is every
 * suite that runs after it in the same job, failing for a reason that has nothing to do with what it tests.
 *
 * Measured 2026-08-20 (X-26): `ensureMaintenanceOff` swallowed its own failure under CPU contention, and the 60
 * `pubsub-topology` runs that followed all died at `Create space on A` with `503 System is in maintenance mode`.
 * Sixty runs of a measurement against a stack that could not answer.
 *
 * ## Why VERIFY and not just check the status
 *
 * "I asked" and "it is set" are different claims, and only the second one matters to the next suite. A `200` on
 * the write can still leave the value unchanged — a field the server ignores, a pin that refuses silently, a
 * merge that dropped the key. So the caller supplies a predicate over the re-read value.
 *
 * Note that `reqJson` RESOLVES for every response: it returns `{status, body}` and never rejects on a 4xx/5xx.
 * So a `try/catch` alone catches a dropped connection and nothing else, which is why the verify step is the
 * thing that decides rather than the absence of a throw.
 *
 * ## WHAT it read, not only that the predicate was false
 *
 * The failure used to say `verify still false after attempt 4` and nothing else, which cannot tell two different
 * faults apart: a `200` on the write that left the value unchanged, and a write that never landed. On 2026-08-28
 * this hook gave up in CI on a commit whose diff was prose, the re-run passed, and the message left nothing to
 * work from — so `verify` may now return `{ ok, saw }` and the `saw` value is quoted in the failure.
 *
 * A bare boolean still works, because most call sites have nothing interesting to report and forcing an object
 * on all of them would be noise. The ones that restore INSTANCE-WIDE state are the ones worth the extra word.
 *
 * @param label   what is being restored, quoted in the failure — the next reader needs to know WHICH cleanup
 * @param apply   performs the restore; its return value is ignored
 * @param verify  re-reads and returns `true`, or `{ ok, saw }` where `saw` is quoted when it fails
 */
/**
 * The subset of a GET'd `documentProcessing` block that `PATCH /api/admin/media-config` will accept.
 *
 * ## Why this exists, and it is not a convenience
 *
 * The GET returns the RESOLVED block — seven keys more than the patch schema declares (`maxTotalPages`,
 * `vlmModel`, `vlmBaseUrl`, `repairModel`, `repairBaseUrl`, `verifyModel`, `verifyBaseUrl`). That schema is
 * `.strict()`, so PATCHing a round-tripped body is a **400 on the whole body** — the restore never lands.
 *
 * Two `after` hooks did exactly that. The failure is invisible whenever the value being restored happens to
 * equal the value already there, which is why it read as an intermittent flake for two days: it fails only
 * when the suite's last write left a DIFFERENT mode than the one the suite started with. `vlm-extraction`
 * writes `ocr` last, so it failed whenever the instance had started on `auto`.
 *
 * Restoring the resolved block would be wrong even if it were accepted: it would write derived values into
 * `config.json` as if an operator had chosen them.
 */
export function patchableDocumentProcessing(dp) {
  if (!dp) return { mode: 'ocr' };
  const ACCEPTED = ['strategy', 'extractImages', 'mode', 'renderDpi', 'maxPages',
    'pageTimeoutMs', 'concurrency', 'ocrTimeoutMs', 'describeTimeoutMs'];
  const out = {};
  for (const k of ACCEPTED) if (dp[k] !== undefined) out[k] = dp[k];
  return out;
}

export async function restoreOrFail(label, apply, verify, { attempts = 4, delayMs = 250 } = {}) {
  let last = 'never ran';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await apply();
      const verdict = await verify();
      // A bare boolean or `{ ok, saw }`. `verdict === true` first, so a truthy object is never mistaken for a
      // pass — which is the bug an `if (verdict)` here would introduce the moment a call site returns `{ok:false}`.
      if (verdict === true || (verdict && typeof verdict === 'object' && verdict.ok === true)) return;
      const saw = verdict && typeof verdict === 'object' && 'saw' in verdict
        ? ` — re-read: ${JSON.stringify(verdict.saw)}`
        : '';
      last = `verify still false after attempt ${attempt}${saw}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    // Saturated rather than broken is the observed failure, and a wait is what fixes that.
    await new Promise(r => setTimeout(r, delayMs * attempt));
  }
  throw new Error(
    `Could not restore ${label} after ${attempts} attempts (${last}). Refusing to exit quietly: this is `
    + 'instance-wide state, so leaving it changed makes later suites in this job fail for a reason that has '
    + 'nothing to do with what they test.',
  );
}
