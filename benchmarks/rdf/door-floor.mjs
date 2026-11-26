/**
 * The fixed cost of each door family, read from the server's own `Server-Timing` header (Q-976): per family, the client's wall time and
 * the server's total and per-phase median and p95 over warm runs, so a cut in the shared path is measured on every door like for like.
 *
 * ## What it measures
 *
 * One scratch instance loaded by `load.mjs ythril --size <n>` (its state file names the URL, the token and the space). Each family is asked
 * the same small question `--warm` times unmeasured, then `--runs` times measured, one request at a time:
 *
 * - SPARQL: BSBM Q11 (the cheapest Explore query) with the parameter sets BSBM's driver chose, bound to the records Ythril minted, as
 *   `run.mjs` binds them; over REST and over MCP `sparql_query` (whose figures ride in the result's `_meta`, `ythril/server-timing`);
 * - recall, filter, traverse, a record read (filter by id), a record save (a fact), a file listing, the RDF export (one page), a Linked Data
 *   address, and a sync pull (one page of entities).
 *
 * A family the instance refuses (a recall with no embedder, a sync pull with no network) is recorded with its status and no figures: the
 * table says what was not measured, never a time of a refusal as if it were the door's.
 *
 * ## Use
 *
 *   node benchmarks/rdf/door-floor.mjs --work <dir> --size 1000 [--url <origin>] [--runs 50] [--warm 3] [--label base] [--out <file.json>]
 *
 * `--url` overrides the state file's origin (a container recreated on another image listens on a new port). Prints a markdown table and
 * writes the raw figures as JSON to `--out` (default `<work>/results/<UTC stamp>-door-floor-<label>.json`).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs, workDir, TOOLS_SUBDIR } from './env.mjs';
import { statePath } from './oxigraph.mjs';
import { substitute } from './params.mjs';
import { loadTemplates } from './queries.mjs';
import { lookupQueries, mapParameters, parameterAddresses, tableFromBindings } from './ythril-params.mjs';
import { median, percentile } from './stats.mjs';

/** The 95th percentile, nearest rank (`stats.mjs`). */
const PERCENTILE = 95;
const p95 = (xs) => percentile(xs, PERCENTILE);

/** The phases a header names, in the order the table lists them (the server's own order, `http/phase-timer.ts`). */
const PHASES = ['total', 'auth', 'rate', 'scope', 'door', 'parse', 'members', 'schema', 'verdict', 'plan', 'run', 'render'];
/** The `_meta` key an MCP tool result carries its figures under. */
const MCP_TIMING_META = 'ythril/server-timing';

/** The entries of a `Server-Timing` value: `{ name: dur }` (durations of a phase that ran more than once are its sum). */
export function phasesOf(header) {
  const out = {};
  if (!header) return out;
  for (const raw of String(header).split(',')) {
    const [name, ...params] = raw.trim().split(';').map(s => s.trim());
    const dur = params.find(p => p.startsWith('dur='));
    if (name && dur) out[name] = Number(dur.slice(4));
  }
  return out;
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const work = workDir(flags);
  const size = Number(flags.size ?? 1000);
  const runs = Number(flags.runs ?? 50);
  const warm = Number(flags.warm ?? 3);
  const label = String(flags.label ?? 'run');
  const state = JSON.parse(readFileSync(statePath(work, `ythril-${size}`), 'utf8'));
  const origin = String(flags.url ?? new URL(state.url).origin);
  const space = state.spaceId;
  const auth = { authorization: `Bearer ${state.token}` };
  const sparqlUrl = `${origin}/api/brain/spaces/${encodeURIComponent(space)}/sparql`;

  // Q11 with BSBM's parameter sets, bound to the records Ythril minted (as run.mjs binds them).
  const paramsFile = JSON.parse(readFileSync(join(work, 'data', String(size), 'params.json'), 'utf8'));
  const templates = loadTemplates(join(work, TOOLS_SUBDIR));
  const rows = [];
  for (const { query } of lookupQueries(parameterAddresses(paramsFile))) {
    const res = await fetch(sparqlUrl, { method: 'POST', headers: { ...auth, 'content-type': 'application/sparql-query', accept: 'application/sparql-results+json' }, body: query });
    if (!res.ok) throw new Error(`parameter lookup answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    for (const b of (await res.json()).results.bindings) rows.push({ o: b.o.value, s: b.s.value });
  }
  const mapped = mapParameters(paramsFile, tableFromBindings(rows));
  const q11 = (k) => substitute(templates.Q11.text, mapped.file.params.Q11[k % mapped.file.params.Q11.length]);

  // One entity to read, traverse and address, found by the filter door itself.
  const json = { ...auth, 'content-type': 'application/json' };
  const probe = await fetch(`${origin}/api/filter`, { method: 'POST', headers: json, body: JSON.stringify({ space, collection: 'entities', filter: {}, limit: 1 }) });
  const probeBody = probe.ok ? await probe.json() : null;
  const entity = (probeBody?.data?.results ?? probeBody?.results ?? [])[0]?._id ?? null;
  const ldBase = state.rdfBase ?? null;

  const families = {
    'sparql Q11 (REST)': (k) => fetch(sparqlUrl, { method: 'POST', headers: { ...auth, 'content-type': 'application/sparql-query', accept: 'application/sparql-results+json' }, body: q11(k) }),
    'sparql Q11 (MCP)': (k) => fetch(`${origin}/mcp`, {
      method: 'POST', headers: { ...json, accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sparql_query', arguments: { space, query: q11(k) } } }),
    }),
    'recall': () => fetch(`${origin}/api/brain/recall`, { method: 'POST', headers: json, body: JSON.stringify({ space, query: 'product offer', topK: 5 }) }),
    'filter': () => fetch(`${origin}/api/filter`, { method: 'POST', headers: json, body: JSON.stringify({ space, collection: 'entities', filter: {}, limit: 10 }) }),
    'traverse': () => fetch(`${origin}/api/brain/spaces/${encodeURIComponent(space)}/traverse`, { method: 'POST', headers: json, body: JSON.stringify({ startId: entity, maxDepth: 1 }) }),
    'record get': () => fetch(`${origin}/api/filter`, { method: 'POST', headers: json, body: JSON.stringify({ space, collection: 'entities', filter: { _id: entity }, limit: 1 }) }),
    'record save': (k) => fetch(`${origin}/api/brain/spaces/${encodeURIComponent(space)}/facts`, { method: 'POST', headers: json, body: JSON.stringify({ fact: `door-floor ${label} ${k}`, tags: ['door-floor'] }) }),
    'file list': () => fetch(`${origin}/api/files/${encodeURIComponent(space)}`, { headers: auth }),
    'rdf export': () => fetch(`${origin}/api/brain/spaces/${encodeURIComponent(space)}/export/rdf?format=nquads&limit=100`, { headers: auth }),
    'linked data': () => fetch(ldBase && entity ? `${origin}/ld/${encodeURIComponent(space)}/entity/${encodeURIComponent(entity)}` : `${origin}/ld/${encodeURIComponent(space)}/`, { headers: { ...auth, accept: 'application/n-quads' } }),
    'sync pull': () => fetch(`${origin}/api/sync/entities?spaceId=${encodeURIComponent(space)}&limit=100`, { headers: auth }),
  };

  const record = { label, origin, space, size, runs, warm, at: new Date().toISOString(), families: {} };
  for (const [family, ask] of Object.entries(families)) {
    const measured = [];
    let status = null;
    for (let k = 0; k < warm + runs; k++) {
      const t0 = performance.now();
      const res = await ask(k);
      const text = await res.text();
      const wall = performance.now() - t0;
      status = res.status;
      let phases = phasesOf(res.headers.get('server-timing'));
      if (family.endsWith('(MCP)')) {
        const data = /^(?:event|data):/m.test(text) ? text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)) : [text];
        for (const d of data) {
          let msg = null; try { msg = JSON.parse(d); } catch { /* not JSON */ }
          const held = msg?.result?._meta?.[MCP_TIMING_META];
          if (held) phases = Object.fromEntries(Object.entries(held).map(([p, f]) => [p, Number(f.dur)]));
          if (msg?.result?.isError) status = 'refused';
        }
      }
      if (k >= warm && res.ok && status !== 'refused') measured.push({ wall, phases });
    }
    const of = (pick) => {
      const xs = measured.map(pick).filter(Number.isFinite);
      return xs.length > 0 ? { median: median(xs), p95: p95(xs) } : null;
    };
    record.families[family] = {
      status, measured: measured.length,
      wall: of(m => m.wall),
      phases: Object.fromEntries(PHASES.map(p => [p, of(m => m.phases[p])]).filter(([, v]) => v !== null)),
    };
  }

  const out = String(flags.out ?? join(work, 'results', `${record.at.replace(/[:.]/g, '-')}-door-floor-${label}.json`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(tableOf(record));
  console.log(`\nwrote ${out}`);
}

/** The record as a markdown table: one row per family, the client's wall and each phase as median / p95 ms. */
export function tableOf(record) {
  const ms = (v) => (v ? `${v.median.toFixed(2)} / ${v.p95.toFixed(2)}` : '');
  const lines = [
    `Door floor, ${record.label}: ${record.space}, ${record.runs} measured runs after ${record.warm} warm-up, median / p95 ms`,
    '',
    `| family | status | client wall | ${PHASES.join(' | ')} |`,
    `|---|---|---:|${PHASES.map(() => '---:').join('|')}|`,
  ];
  for (const [family, f] of Object.entries(record.families)) {
    lines.push(`| ${family} | ${f.status}${f.measured === 0 ? ' (not measured)' : ''} | ${ms(f.wall)} | ${PHASES.map(p => ms(f.phases[p])).join(' | ')} |`);
  }
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('door-floor.mjs')) await main();
