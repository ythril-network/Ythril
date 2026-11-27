#!/usr/bin/env node
/**
 * Runs the 11 BSBM Explore queries against one engine's SPARQL endpoint and writes one result record.
 *
 *   node benchmarks/rdf/run.mjs --engine oxigraph|ythril --size 1000 [--results <dir>] [--warmups 3] [--runs 20]
 *                               [--ythril-commit <sha>] [--against <oxigraph record>] [--embed-wait-minutes 30]
 *
 * A Ythril run first reads the SPARQL limits in effect from the instance's config, waits for the embed queue to drain
 * (up to `--embed-wait-minutes`, then measures anyway and records what was left), maps the parameters to the records
 * Ythril minted (ythril-params.mjs), and counts per predicate what the instance holds against what the variant states
 * (not-taken.mjs). It is judged against the Oxigraph record named by `--against` (required), one query at a time
 * (comparability.mjs): each query is comparable (its row count is Oxigraph's on every run) or names one reason; the
 * record's `valid` is false only for a `rows-differ` query. Graph answers (Q9, Q12) count their statements by parsing.
 *
 * The endpoint, and for a scratch Ythril its token, come from the state file `load.mjs` wrote. Parameters are the
 * ones the BSBM test driver chose (`params.json`, from `generate.mjs`): run k of every query uses parameter set k,
 * so both engines are asked the same 23 questions per query, three of them as warm-up.
 *
 * A Ythril run also reads each answer's `Server-Timing` header (server-timing.mjs) and records, per query and per run, the door's total
 * (`total`) and the engine's own time (`plan` plus `run`) beside the client's wall time; its table shows the median and p95 of each, so
 * the engine is compared with Oxigraph's like for like. An answer without the header is that query's error, never a zero.
 *
 * Writes `<UTC stamp>-<engine>-<size>.json` to the results folder (default `<work>/results/`) and prints a
 * markdown table. An engine that answers an error for a query is recorded as that query's error and the run goes
 * on to the next query: a missing endpoint is eleven rows saying 404, not a crash.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PIN, REPO_ROOT, TOOLS_SUBDIR, parseArgs, variantOf, workDir } from './env.mjs';
import { statePath } from './oxigraph.mjs';
import { countRows } from './answer-rows.mjs';
import { substitute } from './params.mjs';
import { acceptFor, loadTemplates } from './queries.mjs';
import { buildRecord, writeRecord } from './result-record.mjs';
import { summarize } from './stats.mjs';
import { phasesOf, summarizeTimed, timingOfAnswer } from './server-timing.mjs';
import { judgeComparability } from './comparability.mjs';
import { waitForDrain } from './embed-wait.mjs';
import { countPredicatesOfFile, countQuery, notTakenOf } from './not-taken.mjs';
import { predicatesOf } from './query-shape.mjs';
import { limitsOf, CEILINGS } from './sparql-limits.mjs';
import { readInstanceConfig, spaceCounts } from './ythril.mjs';
import { sleep } from './env.mjs';
import { lookupQueries, mapParameters, parameterAddresses, tableFromBindings } from './ythril-params.mjs';

// Past the server's own longest timeout (sparql.timeoutMs ceiling, five minutes), so a query the server may still answer is not
// recorded as the client's timeout.
const REQUEST_TIMEOUT_MS = CEILINGS.timeoutMs + 30_000;
/** How long a Ythril run waits for the embed queue to drain before it measures anyway (minutes, `--embed-wait-minutes`). */
const EMBED_WAIT_MINUTES = 30;

/**
 * One query. With `timed` (a Ythril run) the answer's `Server-Timing` header is read too: the door's total and the engine's own time
 * ride in `doorMs` and `engineMs`, and a successful answer without them is that query's error (`no-server-timing`), never a zero.
 */
async function ask(endpoint, token, query, accept, timed = false) {
  const t0 = performance.now();
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/sparql-query', accept, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: query,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    const ms = performance.now() - t0;
    if (res.status >= 200 && res.status < 300) {
      let server = {};
      if (timed) {
        try { server = timingOfAnswer(phasesOf(res.headers.get('server-timing'))); } catch (err) {
          return { ok: false, error: { code: 'no-server-timing', status: res.status, message: err.message.slice(0, 300) } };
        }
      }
      // A graph answer is counted by parsing it, on both engines; an answer that does not parse is that query's error.
      try { return { ok: true, ms, ...server, rows: countRows(text, accept), bytes: Buffer.byteLength(text) }; } catch (err) {
        return { ok: false, error: { code: 'unparsable-answer', status: res.status, message: err.message.slice(0, 300) } };
      }
    }
    let code = res.status;
    let message = text.slice(0, 300);
    try { const j = JSON.parse(text); code = j.code ?? j.error?.code ?? res.status; message = j.message ?? j.error?.message ?? j.error ?? message; } catch { /* plain text body */ }
    return { ok: false, error: { code, status: res.status, message: String(message).slice(0, 300) } };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError';
    return { ok: false, error: { code: timedOut ? 'timeout' : 'network', status: 0, message: String(err?.cause?.message ?? err?.message ?? err).slice(0, 300) } };
  }
}

async function runQueries({ engine, endpoint, token, templates, paramsFile, warmups, runs }) {
  const queries = {};
  for (const [name, t] of Object.entries(templates)) {
    const sets = paramsFile.params[name];
    if (!sets || sets.length < warmups + runs) throw new Error(`${name}: params.json holds ${sets?.length ?? 0} sets, ${warmups + runs} are needed`);
    const accept = acceptFor(t.form, engine);
    const times = [];
    const timedRuns = [];
    let firstError = null;
    let errors = 0;
    let rows = null;
    let bytes = null;
    const rowsPerRun = [];
    for (let k = 0; k < warmups + runs; k++) {
      const r = await ask(endpoint, token, substitute(t.text, sets[k]), accept, engine === 'ythril');
      rowsPerRun.push(r.ok ? r.rows : null);
      if (!r.ok) { errors++; firstError ??= r.error; continue; }
      if (k >= warmups) { times.push(r.ms); timedRuns.push({ wall: r.ms, doorMs: r.doorMs, engineMs: r.engineMs }); rows ??= r.rows; bytes ??= r.bytes; }
    }
    // A Ythril query keeps the door's total and the engine's own time of every measured run beside the client's wall time.
    const summary = () => (engine === 'ythril' ? summarizeTimed(timedRuns) : summarize(times));
    queries[name] = times.length
      ? { ...summary(), rows, rowsPerRun, bytes, errors, ...(firstError ? { error: firstError } : {}) }
      : { n: 0, errors, error: firstError ?? { code: 'no-measured-run', status: 0, message: 'every request failed' } };
  }
  return queries;
}

/**
 * The parameters with the generator's addresses replaced by the records Ythril minted for them, from one lookup per
 * class asked of the endpoint itself. Throws (the run stops) when an address maps to nothing.
 */
async function mapForYthril(endpoint, token, paramsFile) {
  const rows = [];
  for (const { class: klass, query } of lookupQueries(parameterAddresses(paramsFile))) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/sparql-query', accept: 'application/sparql-results+json', authorization: `Bearer ${token}` },
      body: query,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`the ${klass} address lookup answered ${res.status}: ${text.slice(0, 200)}`);
    for (const b of JSON.parse(text).results.bindings) rows.push({ o: b.o.value, s: b.s.value });
  }
  return mapParameters(paramsFile, tableFromBindings(rows));
}

/**
 * The distinct predicates the variant states that some query names, counted on the variant and then asked of the instance one at a
 * time; answers `{ iri: { statements, held } }` for the ones the instance holds fewer statements of (not-taken.mjs).
 */
async function notTakenPredicates({ endpoint, token, variantFile, templates }) {
  const stated = await countPredicatesOfFile(variantFile);
  const named = new Set(Object.values(templates).flatMap((t) => predicatesOf(t.text)));
  const statements = Object.fromEntries(Object.entries(stated).filter(([iri]) => named.has(iri)));
  const held = {};
  for (const iri of Object.keys(statements)) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/sparql-query', accept: 'application/sparql-results+json', authorization: `Bearer ${token}` },
      body: countQuery(iri),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`counting ${iri} answered ${res.status}: ${text.slice(0, 200)}`);
    held[iri] = Number(JSON.parse(text).results.bindings[0]?.n?.value);
  }
  return { statements, held, notTaken: notTakenOf(statements, held) };
}

function table(record) {
  const lines = [
    ...(record.valid === false ? [`INVALID: rows-differ on ${record.invalidQueries.map((d) => `${d.query} (${d.oxigraph} vs ${d.ythril})`).join(', ')}`, ''] : []),
    `Engine ${record.engine}, ${record.size} products, outcome ${record.outcome}, ${record.runs} measured runs after ${record.warmups} warm-up`,
    ...(record.sparqlLimits ? [`SPARQL limits: ${Object.entries(record.sparqlLimits).map(([k, v]) => `${k} ${v}`).join(', ')}`] : []),
    ...(record.embedQueue ? [`embed queue: waited ${record.embedQueue.waitedMs} ms, ${record.embedQueue.pending} pending, ${record.embedQueue.drained ? 'drained' : 'not drained'}`] : []),
    '',
    // A Ythril record adds the door's total and the engine's own time (median / p95) beside the client's wall time.
    ...(record.engine === 'ythril'
      ? ['| query | wall median ms | wall p95 ms | door median / p95 ms | engine median / p95 ms | rows | errors | comparable |', '|---|---:|---:|---:|---:|---:|---|---|']
      : ['| query | median ms | p95 ms | rows | errors | comparable |', '|---|---:|---:|---:|---|---|']),
  ];
  const pair = (v) => (v ? `${v.median.toFixed(2)} / ${v.p95.toFixed(2)}` : '-');
  for (const [name, q] of Object.entries(record.queries)) {
    const verdict = q.comparable === undefined ? '' : q.comparable ? 'yes' : q.reason;
    const server = record.engine === 'ythril' ? [pair(q.door), pair(q.engine)] : [];
    if (typeof q.median !== 'number') lines.push(`| ${[name, '-', '-', ...server, '-', `error ${q.error.code}: ${q.error.message.slice(0, 60)} (${q.errors})`, verdict].join(' | ')} |`);
    else lines.push(`| ${[name, q.median.toFixed(2), q.p95.toFixed(2), ...server, q.rows ?? '-', q.errors ? `${q.errors} (first: ${q.error.code})` : '0', verdict].join(' | ')} |`);
  }
  return lines.join('\n');
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const work = workDir(flags);
  const engine = String(flags.engine ?? '');
  if (!['oxigraph', 'ythril'].includes(engine)) throw new Error('--engine oxigraph|ythril is required');
  const size = Number(flags.size);
  if (!Number.isInteger(size) || size <= 0) throw new Error('--size <products> is required');
  const warmups = Number(flags.warmups ?? 3);
  const runs = Number(flags.runs ?? 20);
  const resultsDir = String(flags.results ?? join(work, 'results'));

  const state = JSON.parse(readFileSync(statePath(work, `${engine}-${size}`), 'utf8'));
  const paramsFile = JSON.parse(readFileSync(join(work, 'data', String(size), 'params.json'), 'utf8'));
  const variant = variantOf(work, size);
  // A store loaded from another variant (or an older file) would be timed against queries chosen for this one.
  if (state.variantSha256 !== variant.sha256) {
    throw new Error(`${engine} ${size} was loaded from variant ${state.variantSha256 ?? 'unknown'}, not ${variant.sha256}: load it again`);
  }
  const templates = loadTemplates(join(work, TOOLS_SUBDIR));

  // The reference a Ythril run is judged against: the Oxigraph record of the same size and bytes.
  let reference = null;
  if (engine === 'ythril') {
    if (!flags.against) throw new Error('--against <oxigraph record> is required for a ythril run: it is judged against Oxigraph\'s row counts');
    reference = JSON.parse(readFileSync(String(flags.against), 'utf8'));
    if (reference.engine !== 'oxigraph' || reference.size !== size || reference.dataset?.sha256 !== variant.sha256) {
      throw new Error(`--against must be the oxigraph record of ${size} products on variant ${variant.sha256}`);
    }
  }
  // Ythril minted its own addresses: the parameters are bound to its records before any run. Oxigraph keeps the generator's.
  let runParams = paramsFile;
  let mappedParameters;
  let sparqlLimits;
  let embedQueue;
  let notTaken;
  if (engine === 'ythril') {
    // The limits the run is measured under are read from the instance, not from a flag: the record says what was in effect.
    sparqlLimits = limitsOf(readInstanceConfig(state.app));
    console.log(`sparql limits in effect: ${JSON.stringify(sparqlLimits)}`);
    // Embedding a freshly imported space competes with the queries: wait for the queue to drain, up to the deadline.
    const waitMinutes = Number(flags['embed-wait-minutes'] ?? EMBED_WAIT_MINUTES);
    embedQueue = await waitForDrain({
      // `state.url` is the space's SPARQL endpoint; the stats call wants the instance's base.
      probe: async () => (await spaceCounts({ ...state, url: new URL(state.url).origin }, state.spaceId)).embedQueue,
      sleep, pollMs: 15_000, deadlineMs: waitMinutes * 60_000,
    });
    console.log(`embed queue: waited ${embedQueue.waitedMs} ms, ${embedQueue.pending} pending, ${embedQueue.drained ? 'drained' : 'not drained'}`);
    const m = await mapForYthril(state.url, state.token, paramsFile);
    runParams = m.file;
    mappedParameters = m.mapped;
    console.log(`mapped ${m.mapped} parameter addresses to Ythril's records`);
    const found = await notTakenPredicates({ endpoint: state.url, token: state.token, variantFile: variant.file, templates });
    notTaken = found.notTaken;
    console.log(`predicates a query names that the instance holds fewer statements of than the variant states: ${Object.keys(notTaken).length}`);
  }

  const startedAt = new Date();
  const queries = await runQueries({ engine, endpoint: state.url, token: state.token, templates, paramsFile: runParams, warmups, runs });
  // Each query is judged on its own against Oxigraph's rows; the verdict goes into the query's own entry.
  const verdict = reference ? judgeComparability({ oxigraph: reference.queries, ythril: queries, templates, notTaken }) : null;
  if (verdict) for (const [name, v] of Object.entries(verdict.queries)) if (queries[name]) Object.assign(queries[name], v);
  const timed = Object.values(queries).filter((q) => typeof q.median === 'number');
  const clean = timed.length === Object.keys(queries).length && timed.every((q) => q.errors === 0);
  const outcome = clean ? 'ok' : timed.length ? 'partial' : 'failed';

  // The commit of the Ythril under test: named by the flag, else the one the scratch instance was built from, else
  // (an Oxigraph-only run) the checkout the harness runs from.
  const ythrilCommit = String(flags['ythril-commit'] ?? state.commit ?? execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short=9', 'HEAD'], { encoding: 'utf8' }).trim());
  const load = engine === 'ythril' ? state.load : null;
  const record = buildRecord({
    outcome, engine, size, ythrilCommit,
    oxigraphDigest: PIN.images.oxigraph.ref.slice(PIN.images.oxigraph.ref.indexOf('@') + 1),
    ythrilImage: engine === 'ythril' ? state.imageId ?? state.image ?? null : undefined,
    bsbmSeed: { generator: PIN.seeds.generator, driver: PIN.seeds.driver },
    dataset: { variant: variant.name, triples: variant.triples, sha256: variant.sha256 },
    loadMs: engine === 'ythril' ? (load?.ok ? load.loadMs : null) : state.loadMs,
    ...(engine === 'ythril' && !load?.ok ? { loadRefusal: { status: load?.status ?? 0, code: load?.code ?? 'no-load-recorded', message: load?.message ?? '' } } : {}),
    valid: verdict?.valid ?? true, ...(verdict && !verdict.valid ? { invalidQueries: verdict.differing } : {}),
    ...(engine === 'ythril' ? { sparqlLimits, embedQueue, notTaken } : {}),
    ...(mappedParameters !== undefined ? { mappedParameters } : {}),
    ...(engine === 'ythril' && load?.chunks ? { loadChunks: load.chunks } : {}),
    warmups, runs, queries,
    startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
    host: { node: process.version, cpus: cpus().length },
  });
  const path = writeRecord(resultsDir, record, startedAt);
  console.log(table(record));
  console.log(`\nrecord: ${path}`);
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
