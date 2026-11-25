#!/usr/bin/env node
/**
 * Runs the 11 BSBM Explore queries against one engine's SPARQL endpoint and writes one result record.
 *
 *   node benchmarks/rdf/run.mjs --engine oxigraph|ythril --size 1000 [--results <dir>] [--warmups 3] [--runs 20]
 *                               [--ythril-commit <sha>]
 *
 * The endpoint, and for a scratch Ythril its token, come from the state file `load.mjs` wrote. Parameters are the
 * ones the BSBM test driver chose (`params.json`, from `generate.mjs`): run k of every query uses parameter set k,
 * so both engines are asked the same 23 questions per query, three of them as warm-up.
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
import { substitute } from './params.mjs';
import { acceptFor, loadTemplates } from './queries.mjs';
import { buildRecord, writeRecord } from './result-record.mjs';
import { summarize } from './stats.mjs';

const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Counts the rows a response carries, to make two engines' answers comparable at a glance. A Turtle graph has no
 * cheap triple count (prefixes, `;` and `,` lists), so its row count is null and `bytes` is the comparison.
 */
function countRows(text, accept) {
  if (accept === 'application/n-triples') return text.split('\n').filter((l) => l.trim() && !l.startsWith('#')).length;
  try {
    const j = JSON.parse(text);
    if (j.results?.bindings) return j.results.bindings.length;
    if (typeof j.boolean === 'boolean') return 1;
  } catch { /* not JSON */ }
  return null;
}

async function ask(endpoint, token, query, accept) {
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
    if (res.status >= 200 && res.status < 300) return { ok: true, ms, rows: countRows(text, accept), bytes: Buffer.byteLength(text) };
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
    let firstError = null;
    let errors = 0;
    let rows = null;
    let bytes = null;
    for (let k = 0; k < warmups + runs; k++) {
      const r = await ask(endpoint, token, substitute(t.text, sets[k]), accept);
      if (!r.ok) { errors++; firstError ??= r.error; continue; }
      if (k >= warmups) { times.push(r.ms); rows ??= r.rows; bytes ??= r.bytes; }
    }
    queries[name] = times.length
      ? { ...summarize(times), rows, bytes, errors, ...(firstError ? { error: firstError } : {}) }
      : { n: 0, errors, error: firstError ?? { code: 'no-measured-run', status: 0, message: 'every request failed' } };
  }
  return queries;
}

function table(record) {
  const lines = [
    `Engine ${record.engine}, ${record.size} products, outcome ${record.outcome}, ${record.runs} measured runs after ${record.warmups} warm-up`,
    '',
    '| query | median ms | p95 ms | rows | errors |',
    '|---|---:|---:|---:|---|',
  ];
  for (const [name, q] of Object.entries(record.queries)) {
    if (typeof q.median !== 'number') lines.push(`| ${name} | - | - | - | error ${q.error.code}: ${q.error.message.slice(0, 60)} (${q.errors}) |`);
    else lines.push(`| ${name} | ${q.median.toFixed(2)} | ${q.p95.toFixed(2)} | ${q.rows ?? '-'} | ${q.errors ? `${q.errors} (first: ${q.error.code})` : '0'} |`);
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

  const startedAt = new Date();
  const queries = await runQueries({ engine, endpoint: state.url, token: state.token, templates, paramsFile, warmups, runs });
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
    warmups, runs, queries,
    startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
    host: { node: process.version, cpus: cpus().length },
  });
  const path = writeRecord(resultsDir, record, startedAt);
  console.log(table(record));
  console.log(`\nrecord: ${path}`);
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
