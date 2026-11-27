#!/usr/bin/env node
/**
 * Loads the generated BSBM dataset variant (`variant.nt`, see prepare.mjs) into one engine and times the load.
 * Both engines load the same bytes; the state records the variant and its sha256.
 *
 *   node benchmarks/rdf/load.mjs oxigraph-up   --size 1000       bulk `load` into a fresh store, then `serve`
 *   node benchmarks/rdf/load.mjs oxigraph-down --size 1000 --work <dir>    (a -down command needs --work or --name-prefix)
 *   node benchmarks/rdf/load.mjs ythril-up     [--ythril-image <ref>]   a scratch instance (own database)
 *   node benchmarks/rdf/load.mjs ythril        --size 1000       a space with RDF on, then the RDF import door
 *   node benchmarks/rdf/load.mjs ythril-limits --timeout-ms 300000 --max-records-read 10000000 --max-results 100000
 *   node benchmarks/rdf/load.mjs ythril-down --work <dir>
 *
 * Each step writes `<work>/state/<engine>[-<size>].json`, which `run.mjs` reads: the endpoint, the token for a
 * scratch instance, the image digest and the load time. When the Ythril import refuses the data, the state
 * says so with the status and code instead of a time, and the server is left as it is.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chunkFile } from './chunk.mjs';
import { downNeedsItsRun, namePrefixOf, parseArgs, variantOf, workDir } from './env.mjs';
import { oxigraphDown, oxigraphUp, statePath } from './oxigraph.mjs';
import { createRdfSpace, deleteSpace, loadChunks, loadInto, setSparqlLimits, spaceCounts, ythrilDown, ythrilNames, ythrilUp } from './ythril.mjs';

/** The import door's body bound (`rdf_bound_exceeded`), and the size a chunk is cut to: well under it. */
const IMPORT_BODY_BOUND = 1024 ** 3;
const CHUNK_BYTES = 768 * 1024 ** 2;

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  downNeedsItsRun(positional[0], flags);
  const work = workDir(flags);
  // The prefix of this run's container names (--name-prefix, else the work folder): two runs never remove each other's containers.
  const prefix = namePrefixOf(flags, work);
  const cmd = positional[0];
  const size = Number(flags.size);
  const needSize = () => {
    if (!Number.isInteger(size) || size <= 0) throw new Error('--size <products> is required');
    return variantOf(work, size); // throws when generate.mjs has not made the variant
  };

  if (cmd === 'oxigraph-up') {
    needSize();
    const s = await oxigraphUp(work, size, prefix);
    console.log(`oxigraph ${size}: loaded in ${s.loadMs} ms, serving ${s.url}`);
  } else if (cmd === 'oxigraph-down') {
    oxigraphDown(size, prefix);
    console.log('oxigraph removed');
  } else if (cmd === 'ythril-up') {
    const s = await ythrilUp(work, {
      prefix,
      ...(flags['ythril-image'] ? { image: String(flags['ythril-image']) } : {}),
      ...(flags['ythril-commit'] ? { commit: String(flags['ythril-commit']) } : {}),
    });
    console.log(`scratch ythril at ${s.url} (${s.image})`);
  } else if (cmd === 'ythril-limits') {
    // Raises the SPARQL limits of the scratch instance (read live); the values are refused when the server would refuse them.
    const asked = { timeoutMs: Number(flags['timeout-ms']), maxRecordsRead: Number(flags['max-records-read']), maxResults: Number(flags['max-results']) };
    console.log(`sparql limits now: ${JSON.stringify(setSparqlLimits(asked, ythrilNames(prefix).app))}`);
  } else if (cmd === 'ythril-down') {
    ythrilDown(prefix);
    console.log('scratch ythril removed');
  } else if (cmd === 'ythril') {
    const variant = needSize();
    const state = JSON.parse(readFileSync(statePath(work, 'ythril'), 'utf8'));
    const spaceId = `bsbm-${size}`;
    await deleteSpace(state, spaceId);
    await createRdfSpace(state, spaceId, flags.base ? String(flags.base) : undefined);
    // --import-query "schema=generate&from=data" adds the door's own parameters (docs 06f-exports.md, RDF import).
    const importQuery = String(flags['import-query'] ?? '');
    const importParams = Object.fromEntries(new URLSearchParams(importQuery));
    // A variant over the door's body bound goes in as subject-complete chunks, ends first (chunk.mjs).
    let result;
    if (statSync(variant.file).size > IMPORT_BODY_BOUND) {
      const { files } = chunkFile(variant.file, join(work, 'chunks', String(size)), CHUNK_BYTES);
      console.log(`the variant is over the import body bound: importing ${files.length} subject-complete chunks`);
      result = await loadChunks(state, spaceId, files, importParams);
    } else result = await loadInto(state, spaceId, variant.file, importParams);
    const counts = await spaceCounts(state, spaceId).catch(() => null);
    const out = {
      ...state, size, spaceId, url: `${state.url}/api/brain/spaces/${spaceId}/sparql`, load: result, counts,
      importQuery, variant: variant.name, variantSha256: variant.sha256,
    };
    mkdirSync(join(work, 'state'), { recursive: true });
    writeFileSync(statePath(work, `ythril-${size}`), `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
    if (result.ok) console.log(`ythril ${size}: imported in ${result.loadMs} ms (${JSON.stringify(result.report.kinds)})`);
    else console.log(`ythril ${size}: the import was refused after ${result.loadMs} ms: ${result.status} ${result.code}: ${result.message}; reasons ${JSON.stringify(result.report.reasonsByCode)}`);
  } else {
    throw new Error('usage: load.mjs oxigraph-up|oxigraph-down|ythril-up|ythril|ythril-limits|ythril-down [--size N] [--work dir]');
  }
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
