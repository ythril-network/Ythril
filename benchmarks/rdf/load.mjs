#!/usr/bin/env node
/**
 * Loads a generated BSBM dataset into one engine and times the load.
 *
 *   node benchmarks/rdf/load.mjs oxigraph-up   --size 1000       bulk `load` into a fresh store, then `serve`
 *   node benchmarks/rdf/load.mjs oxigraph-down --size 1000
 *   node benchmarks/rdf/load.mjs ythril-up     [--ythril-image <ref>]   a scratch instance (own database)
 *   node benchmarks/rdf/load.mjs ythril        --size 1000       a space with RDF on, then the RDF import door
 *   node benchmarks/rdf/load.mjs ythril-down
 *
 * Each step writes `<work>/state/<engine>[-<size>].json`, which `run.mjs` reads: the endpoint, the token for a
 * scratch instance, the image digest and the load time. When the Ythril import refuses the data, the state
 * says so with the status and code instead of a time, and the server is left as it is.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, workDir } from './env.mjs';
import { oxigraphDown, oxigraphUp, statePath } from './oxigraph.mjs';
import { createRdfSpace, deleteSpace, loadInto, spaceCounts, ythrilDown, ythrilUp } from './ythril.mjs';

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const work = workDir(flags);
  const cmd = positional[0];
  const size = Number(flags.size);
  const needSize = () => {
    if (!Number.isInteger(size) || size <= 0) throw new Error('--size <products> is required');
    if (!existsSync(join(work, 'data', String(size), 'dataset.nt'))) throw new Error(`no dataset for ${size}: run generate.mjs --sizes ${size}`);
  };

  if (cmd === 'oxigraph-up') {
    needSize();
    const s = await oxigraphUp(work, size);
    console.log(`oxigraph ${size}: loaded in ${s.loadMs} ms, serving ${s.url}`);
  } else if (cmd === 'oxigraph-down') {
    oxigraphDown(size);
    console.log('oxigraph removed');
  } else if (cmd === 'ythril-up') {
    const s = await ythrilUp(work, {
      ...(flags['ythril-image'] ? { image: String(flags['ythril-image']) } : {}),
      ...(flags['ythril-commit'] ? { commit: String(flags['ythril-commit']) } : {}),
    });
    console.log(`scratch ythril at ${s.url} (${s.image})`);
  } else if (cmd === 'ythril-down') {
    ythrilDown();
    console.log('scratch ythril removed');
  } else if (cmd === 'ythril') {
    needSize();
    const state = JSON.parse(readFileSync(statePath(work, 'ythril'), 'utf8'));
    const spaceId = `bsbm-${size}`;
    await deleteSpace(state, spaceId);
    await createRdfSpace(state, spaceId, flags.base ? String(flags.base) : undefined);
    const file = join(work, 'data', String(size), 'dataset.nt');
    // --import-query "schema=generate&from=data" adds the door's own parameters (docs 06f-exports.md, RDF import).
    const result = await loadInto(state, spaceId, file, Object.fromEntries(new URLSearchParams(String(flags['import-query'] ?? ''))));
    const counts = await spaceCounts(state, spaceId).catch(() => null);
    const out = { ...state, size, spaceId, url: `${state.url}/api/brain/spaces/${spaceId}/sparql`, load: result, counts };
    mkdirSync(join(work, 'state'), { recursive: true });
    writeFileSync(statePath(work, `ythril-${size}`), `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
    if (result.ok) console.log(`ythril ${size}: imported in ${result.loadMs} ms (${JSON.stringify(result.report.kinds)})`);
    else console.log(`ythril ${size}: the import was refused after ${result.loadMs} ms: ${result.status} ${result.code}: ${result.message}; reasons ${JSON.stringify(result.report.reasonsByCode)}`);
  } else {
    throw new Error('usage: load.mjs oxigraph-up|oxigraph-down|ythril-up|ythril|ythril-down [--size N] [--work dir]');
  }
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
