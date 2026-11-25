/**
 * The Ythril side of the benchmark: a scratch instance, a space with RDF on, and the RDF import door.
 *
 * ## What this prevents
 *
 * - **Touching a real instance.** `up` starts its own database and its own Ythril container, on loopback ports
 *   it is given by Docker, with a data volume of its own; nothing here takes a URL for an instance it did not
 *   start except `loadInto`, which the caller points at a scratch instance by hand.
 * - **A refusal read as a time.** The import door can refuse BSBM data (a bound, an address form). `loadInto`
 *   answers `{ ok: false, status, code }` for that and never a load time, and the result record keeps the code.
 * - **A second copy of the file.** A `202` means the import runs on and lands by itself; `loadInto` polls the
 *   import's status and never sends the file again.
 */
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dockerOk, dockerPlain, pinnedImage, sleep } from './env.mjs';
import { ensureImage, statePath } from './oxigraph.mjs';

const NET = 'b271-bench-net';
export const ythrilNames = () => ({ mongo: 'b271-ythril-mongo', app: 'b271-ythril', config: 'b271-ythril-config', data: 'b271-ythril-data', mongoData: 'b271-ythril-mongo-data' });

/** The commit an image was built from, when its tag says so (`b271-ythril:<sha>`); the caller can name it instead. */
function commitFromTag(image) {
  const tag = image.split(':').pop();
  return /^[0-9a-f]{7,40}$/.test(tag) ? tag : null;
}

export async function ythrilUp(work, { image = 'ghcr.io/ythril-network/ythril:6.5.6', commit = commitFromTag(image) } = {}) {
  const n = ythrilNames();
  const mongoRef = pinnedImage('mongo');
  ensureImage(mongoRef);
  ythrilDown();
  dockerPlain(['network', 'create', NET]);
  for (const v of [n.config, n.data, n.mongoData]) dockerOk(['volume', 'create', v]);

  dockerOk(['run', '-d', '--name', n.mongo, '--hostname', n.mongo, '--network', NET, '-m', '3g', '-v', `${n.mongoData}:/data/db`, mongoRef], { mem: 3, hold: [n.mongo] });
  for (let i = 0; i < 120; i++) {
    const r = dockerPlain(['exec', n.mongo, 'mongosh', '--quiet', '--eval', 'db.adminCommand({replSetGetStatus:1}).myState']);
    if (r.status === 0 && r.stdout.trim() === '1') break;
    if (i === 119) throw new Error(`the scratch database did not become primary: ${r.stdout}${r.stderr}`);
    await sleep(2000);
  }

  dockerOk(['run', '-d', '--name', n.app, '--network', NET, '-m', '4g', '-p', '127.0.0.1::3200',
    '-v', `${n.config}:/config`, '-v', `${n.data}:/data`,
    '-e', 'CONFIG_PATH=/config/config.json', '-e', 'DATA_ROOT=/data', '-e', 'NODE_ENV=production',
    '-e', `MONGO_URI=mongodb://${n.mongo}:27017/ythril_bench?directConnection=true`, image], { mem: 4, hold: [n.app] });
  const port = dockerPlain(['port', n.app, '3200/tcp']).stdout.trim().split('\n')[0].split(':').pop();
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${url}/health`)).ok) break; } catch { /* not up yet */ }
    if (i === 89) throw new Error(`the scratch Ythril did not answer /health: ${dockerPlain(['logs', '--tail', '30', n.app]).stdout}`);
    await sleep(2000);
  }
  const setup = await fetch(`${url}/api/setup/json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'b271 benchmark scratch' }) });
  const body = await setup.json();
  if (setup.status !== 201) throw new Error(`setup answered ${setup.status}: ${JSON.stringify(body)}`);
  const imageId = dockerPlain(['image', 'inspect', image, '--format', '{{.Id}}']).stdout.trim();
  const state = { engine: 'ythril', url, token: body.plaintext, image, imageId, commit, app: n.app, mongo: n.mongo };
  mkdirSync(join(work, 'state'), { recursive: true });
  writeFileSync(statePath(work, 'ythril'), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return state;
}

export function ythrilDown() {
  const n = ythrilNames();
  dockerPlain(['rm', '-f', n.app]);
  dockerPlain(['rm', '-f', n.mongo]);
  for (const v of [n.config, n.data, n.mongoData]) dockerPlain(['volume', 'rm', '-f', v]);
  dockerPlain(['network', 'rm', NET]);
}

async function api(state, method, path, { body, headers = {}, raw } = {}) {
  const res = await fetch(`${state.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${state.token}`, ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    ...(raw ? { duplex: 'half' } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

/** Creates a space with RDF on and returns its id; the answer of a refusal is thrown with its text. */
export async function createRdfSpace(state, id, base = `https://ythril-bench.invalid/ld/${id}/`) {
  const made = await api(state, 'POST', '/api/spaces', { body: { id, label: `BSBM ${id}` } });
  if (made.status >= 300) throw new Error(`creating space ${id} answered ${made.status}: ${made.text}`);
  const rdf = await api(state, 'PATCH', `/api/spaces/${id}`, { body: { meta: { rdf: { enabled: true, base } } } });
  if (rdf.status >= 300) throw new Error(`switching RDF on for ${id} answered ${rdf.status}: ${rdf.text}`);
  return id;
}

/**
 * Imports an N-Triples file through the RDF import door and times it, from the request until the report says
 * the import ended. N-Triples is read as N-Quads, which it is a subset of.
 */
export async function loadInto(state, spaceId, file, params = {}) {
  const qs = new URLSearchParams({ format: 'nquads', ...params });
  const t0 = process.hrtime.bigint();
  let res = await api(state, 'POST', `/api/brain/spaces/${spaceId}/import/rdf?${qs}`, {
    raw: createReadStream(file), headers: { 'content-type': 'application/n-quads' },
  });
  if (res.status === 202 && res.json?.importId) {
    for (;;) {
      await sleep(2000);
      const s = await api(state, 'GET', `/api/brain/spaces/${spaceId}/import/rdf/${res.json.importId}`);
      res = s;
      if (s.json?.status !== 'running') break;
    }
  }
  const loadMs = Number((process.hrtime.bigint() - t0) / 1_000_000n);
  // A refusal answers { error, code, report }; a finished import answers the report itself.
  const body = res.json ?? {};
  const report = body.report ?? body;
  const completed = res.status >= 200 && res.status < 300 && report.status === 'completed';
  if (completed) return { ok: true, loadMs, status: res.status, report: summarizeReport(report) };
  return { ok: false, loadMs, status: res.status, ...describeRefusal(res), report: summarizeReport(report) };
}

/**
 * Imports several subject-complete files in order (see chunk.mjs), timing them together. Stops at the first refusal
 * and answers it; a finished load answers the sum of the times and the number of files in `chunks`.
 */
export async function loadChunks(state, spaceId, files, params = {}) {
  let loadMs = 0;
  let last = null;
  for (const file of files) {
    last = await loadInto(state, spaceId, file, params);
    loadMs += last.loadMs;
    if (!last.ok) return { ...last, loadMs, chunks: files.length };
  }
  return { ...last, loadMs, chunks: files.length };
}

/**
 * The code and message a refused import is recorded with. A refusal polled to its end answers `200` with a report
 * whose status is `refused`: it is `rdf_import_refused`, and its message is the reason codes with their counts
 * (never the report's text, which names statements). Any other refusal keeps the code and message it came with.
 */
export function describeRefusal({ json, text }) {
  const body = json ?? {};
  const report = body.report ?? body;
  const byCode = report.reasonsByCode ?? null;
  const counts = byCode ? Object.entries(byCode).map(([c, n]) => `${c} ${n}`).join(', ') : '';
  if (report.status === 'refused' || body.code === 'rdf_import_refused') {
    return { code: 'rdf_import_refused', message: `reasons: ${counts || 'none listed'}` };
  }
  return { code: body.code ?? report.code ?? 'unknown', message: String(body.error ?? body.message ?? text).slice(0, 500) };
}

function summarizeReport(r) {
  return {
    status: r.status, mode: r.mode, quads: r.quads, subjects: r.subjects, kinds: r.kinds,
    reasonCount: r.reasonCount, reasonsByCode: r.reasonsByCode, notTaken: r.notTaken,
  };
}

/** Removes a space of the scratch instance so a load can be repeated on an empty one; an absent space is fine. */
export async function deleteSpace(state, id) {
  const r = await api(state, 'DELETE', `/api/spaces/${id}`, { body: { confirm: true } });
  if (r.status >= 300 && r.status !== 404) throw new Error(`deleting space ${id} answered ${r.status}: ${r.text}`);
}

export async function spaceCounts(state, spaceId) {
  const r = await api(state, 'GET', `/api/brain/spaces/${spaceId}/stats`);
  return r.json;
}
