/**
 * A local HTTP server that speaks the Ythril REST tool door — `POST /api/<tool>`, body EXACTLY the tool's
 * arguments, answer `{ok, text, data}` — for the tests of the scripts that WRITE to a Ythril instance
 * (`scripts/test-times.mjs`, `scripts/_shared/ythril-api.mjs`).
 *
 * ## What it prevents
 *
 * A test that proves "the recorder writes one record per run" against a hand-built stub proves the stub. This
 * server keeps a real little store, and it answers the way the product answers where the answer matters to the
 * caller, so a script written against it cannot rely on a convenience the product does not give:
 *
 * - `save_chrono` ALWAYS mints the id. A supplied `id` that names nothing is IGNORED, not adopted (probe P8,
 *   `save_chrono`'s own schema says so), so a caller that "supplies its own id for idempotency" makes a second
 *   record here exactly as it does on a real instance. The answer carries the id only inside the sentence
 *   (`… created (ID <uuid>, seq N).`) with `data: null`, because that is what the tool returns.
 * - `update_chrono` MERGES `properties` key by key and REPLACES every other field it is given; an unknown id is
 *   a 404 `{ok:false, error}`.
 * - `filter` evaluates its predicate with the tests' one matcher (`filter-matcher.mjs`: dotted-path equality, `$eq`,
 *   `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`, `$and`, `$or`); any other operator is a 400, so a
 *   script that reaches for one fails loudly here rather than matching nothing.
 *   `projection` EXCLUSIONS are applied (a path set to 0 is removed from every row), `sort`/`dir`/`limit`/`skip`
 *   are honoured, and the page carries `{collection, results, count, total, limit, skip}` in `data`.
 * - Only the space `y-proj-ythril` exists; any other is a 404, so a write that lands in the wrong space is red.
 *
 * ## What it observes
 *
 * `calls` — every request in arrival order (`tool`, `args`, `authorization`, `at`); `maxInFlight` — the most
 * requests that were ever open at once (the one-writer-per-machine check); `store` — the chrono entries held.
 *
 * ## Fault levers
 *
 * `delayMs` slows every answer (to hold a writer in the middle of its work); `respond(req, body)` may answer a
 * request itself — return `{status, body}` — before the store sees it, which is how a test makes a 500, a 401
 * that echoes the request headers back, or a 302 to a second server; `hang()` makes every later request never
 * answer. Nothing here talks to a real instance, and it only ever binds 127.0.0.1.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { matchesFilter, readPath, UnsupportedFilterError } from './filter-matcher.mjs';
import { listenOnLoopback } from './local-server.mjs';
import { sleep } from './sleep.mjs';

export const FAKE_SPACE = 'y-proj-ythril';
export const FAKE_TOKEN = 'ythril_testtoken_0123456789abcdef';

/** Remove a dotted path from a copy of the row. */
function withoutPath(doc, path) {
  const parts = path.split('.');
  const copy = structuredClone(doc);
  let cur = copy;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur?.[parts[i]];
    if (cur === null || typeof cur !== 'object') return copy;
  }
  if (cur && typeof cur === 'object') delete cur[parts[parts.length - 1]];
  return copy;
}

export async function startFakeYthril({ token = FAKE_TOKEN, delayMs = 0, respond } = {}) {
  const calls = [];
  const store = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let hanging = false;
  let clock = Date.now();
  let seqNo = 0;
  const tick = () => new Date(clock++).toISOString();

  const state = { delayMs, respond };

  const server = http.createServer((req, res) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    res.on('close', () => { inFlight--; });
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const send = (status, body, headers = {}) => {
        const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
        res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/html' : 'application/json', ...headers });
        res.end(text);
      };
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { /* a non-JSON body is answered below */ }
        const tool = (req.url ?? '').replace(/^\/api\//, '').split('?')[0];
        const call = { method: req.method, url: req.url, tool, args: body, authorization: req.headers['authorization'] ?? null, headers: { ...req.headers }, at: Date.now() };
        calls.push(call);
        if (hanging) return; // never answered: the client's own timeout is what ends it
        if (state.delayMs) await sleep(state.delayMs);
        if (state.respond) {
          const answered = state.respond(call, body);
          if (answered) return send(answered.status, answered.body, answered.headers);
        }
        if (req.method !== 'POST' || !(req.url ?? '').startsWith('/api/')) return send(404, { ok: false, error: 'not a tool route' });
        if (req.headers['authorization'] !== `Bearer ${token}`) return send(401, { ok: false, error: 'unauthorized', data: null });
        if (body.space !== FAKE_SPACE) return send(404, { ok: false, error: `Space '${String(body.space)}' not found`, data: null });

        switch (tool) {
          case 'save_chrono': {
            const stamp = tick();
            const entry = {
              _id: randomUUID(), // a supplied id is ignored, never adopted
              type: body.type, title: body.title, startsAt: body.startsAt, endsAt: body.endsAt, status: body.status ?? 'scheduled',
              properties: { ...(body.properties ?? {}) }, suppressEmbeddings: body.suppressEmbeddings,
              createdAt: stamp, updatedAt: stamp, seq: ++seqNo,
            };
            store.push(entry);
            return send(200, { ok: true, text: `Chrono entry '${entry.title}' (${entry.type}) created (ID ${entry._id}, seq ${entry.seq}).`, data: null });
          }
          case 'update_chrono': {
            const entry = store.find(e => e._id === body.id);
            if (!entry) return send(404, { ok: false, error: `Chrono entry '${String(body.id)}' not found`, data: null });
            const { space: _s, id: _i, properties, deleteFields, ...rest } = body;
            Object.assign(entry, rest);
            if (properties) entry.properties = { ...entry.properties, ...properties };
            for (const f of deleteFields ?? []) if (f.startsWith('properties.')) delete entry.properties[f.slice('properties.'.length)];
            entry.updatedAt = tick();
            entry.seq = ++seqNo;
            return send(200, { ok: true, text: 'The answer is in `data`; it is not repeated here.', data: structuredClone(entry) });
          }
          case 'delete_chrono': {
            const at = store.findIndex(e => e._id === body.id);
            if (at < 0) return send(404, { ok: false, error: `Chrono entry '${String(body.id)}' not found`, data: null });
            store.splice(at, 1);
            return send(200, { ok: true, text: 'The answer is in `data`; it is not repeated here.', data: { _id: body.id, deleted: true } });
          }
          case 'filter': {
            if (body.collection !== 'chrono') return send(400, { ok: false, error: 'the fake holds chrono only', data: null });
            let rows;
            try { rows = store.filter(e => matchesFilter(e, body.filter)); } catch (err) {
              if (err instanceof UnsupportedFilterError) return send(400, { ok: false, error: err.message, data: null });
              throw err;
            }
            const total = rows.length;
            const field = body.sort ?? 'createdAt';
            const dir = body.sort ? (body.dir === 'asc' ? 1 : -1) : -1;
            rows = [...rows].sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0) * dir);
            const skip = body.skip ?? 0;
            const limit = body.limit ?? 200;
            rows = rows.slice(skip, skip + limit).map(r => structuredClone(r));
            for (const [path, v] of Object.entries(body.projection ?? {})) if (v === 0) rows = rows.map(r => withoutPath(r, path));
            const inclusion = Object.entries(body.projection ?? {}).filter(([, v]) => v === 1).map(([p]) => p);
            if (inclusion.length) {
              rows = rows.map(r => {
                const out = { _id: r._id };
                for (const p of inclusion) {
                  const v = readPath(r, p);
                  if (v === undefined) continue;
                  const parts = p.split('.');
                  let cur = out;
                  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]] ??= {};
                  cur[parts[parts.length - 1]] = v;
                }
                return out;
              });
            }
            return send(200, { ok: true, text: 'The answer is in `data`; it is not repeated here.', data: { collection: 'chrono', results: rows, count: rows.length, total, limit, skip, truncated: false } });
          }
          default:
            return send(404, { ok: false, error: `unknown tool ${tool}`, data: null });
        }
      } catch (err) {
        send(err.status ?? 500, { ok: false, error: String(err.message), data: null });
      }
    });
  });
  const { url, close } = await listenOnLoopback(server);

  return {
    url, token, calls, store,
    get maxInFlight() { return maxInFlight; },
    set delayMs(v) { state.delayMs = v; },
    set respond(fn) { state.respond = fn; },
    hang() { hanging = true; },
    /** Every call to one tool, in order. */
    callsTo: (tool) => calls.filter(c => c.tool === tool),
    /** A chrono entry as a caller of `save_chrono` would have written it — for tests that need history on file. */
    seed(entry) {
      const stamp = tick();
      const doc = { _id: randomUUID(), type: 'Test-Run', status: 'completed', createdAt: stamp, updatedAt: stamp, seq: ++seqNo, ...entry };
      store.push(doc);
      return doc;
    },
    close,
  };
}
