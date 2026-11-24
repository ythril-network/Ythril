#!/usr/bin/env node
/**
 * Generates the BSBM datasets and the query parameters the benchmark runs with.
 *
 *   node benchmarks/rdf/generate.mjs [--work <dir>] [--sizes 1000,5000,20000] [--runs 23]
 *
 * What it does, in order, each step skipped when its output is already there (nothing is overwritten):
 *
 * 1. Fetches BSBM Tools v0.2 and refuses it unless its sha256 is the pinned one (`dataset-pin.mjs`).
 * 2. Extracts it (the archive ships its jars, so nothing is compiled).
 * 3. Per size, runs the BSBM generator in the pinned temurin image: `<work>/data/<size>/dataset.nt` and
 *    the driver's own data folder `td_data/`, plus `manifest.json` (triples, bytes, sha256).
 * 4. Per size, asks the BSBM test driver for the query parameters. The driver chooses them from its
 *    serialised data files, which only it can read, so it is run against a tiny capture server that records
 *    every query the driver sends. Each is matched back to its template (`extractParams`) and the values are
 *    written to `params.json`: per query, `--runs` parameter sets (3 warm-up and 20 measured need 23).
 *
 * Datasets, downloads and parameters live under the work folder, never in the repository.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { fetchPinned, readPinnedDataset } from '../dataset-pin.mjs';
import { dockerAsync, dockerOk, parseArgs, pinnedImage, workDir, PIN, PIN_PATH, TOOLS_SUBDIR } from './env.mjs';
import { extractParams } from './params.mjs';
import { acceptFor, loadTemplates } from './queries.mjs';
import { unzip } from './unzip.mjs';

async function fileDigest(path) {
  const h = createHash('sha256');
  let lines = 0;
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    h.update(chunk);
    bytes += chunk.length;
    for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) lines++;
  }
  return { sha256: h.digest('hex'), bytes, triples: lines };
}

async function ensureTools(work) {
  const zip = join(work, PIN.datasets.bsbmtools.cachePath);
  if (existsSync(zip)) {
    readPinnedDataset(work, PIN_PATH, 'bsbmtools'); // throws when the cached bytes are not the pinned ones
  } else {
    console.log(`fetching ${PIN.datasets.bsbmtools.url}`);
    await fetchPinned(work, PIN_PATH, 'bsbmtools');
  }
  const tools = join(work, TOOLS_SUBDIR);
  if (!existsSync(join(tools, 'lib', 'bsbm.jar'))) unzip(zip, join(work, 'tools'));
  return tools;
}

function generateDataset(work, tools, size) {
  const out = join(work, 'data', String(size));
  if (existsSync(join(out, 'manifest.json'))) return out;
  const partial = `${out}.partial`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });
  console.log(`generating ${size} products`);
  const script = [
    'set -e', 'mkdir /w', 'cd /w', 'cp /bsbm/*.txt .',
    `java -Xmx1g -cp "/bsbm/lib/*" benchmark.generator.Generator -fc -pc ${size} -s nt -dir /w/td_data -fn /w/dataset > /w/gen.log`,
    'cp -r /w/dataset.nt /w/td_data /w/gen.log /out/',
  ].join('; ');
  // The generator reads its word lists one byte at a time: from a bind mount that took minutes, so the work
  // happens on the container's own disk and the result is copied out once.
  dockerOk(['run', '--rm', '-m', '2g', '-v', `${tools}:/bsbm:ro`, '-v', `${partial}:/out`, pinnedImage('temurin'), 'sh', '-c', script], { mem: 2 });
  renameSync(partial, out);
  return out;
}

async function captureParams(work, tools, out, size, runs) {
  const templates = loadTemplates(tools);
  const captured = [];
  const server = http.createServer((req, res) => {
    const query = new URL(req.url, 'http://capture').searchParams.get('query');
    captured.push(query);
    const wantsGraph = /rdf\+xml/.test(req.headers.accept ?? '');
    res.setHeader('content-type', wantsGraph ? 'application/rdf+xml' : 'application/sparql-results+xml');
    res.end(wantsGraph
      ? '<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>'
      : '<?xml version="1.0"?><sparql xmlns="http://www.w3.org/2005/sparql-results#"><head><variable name="a"/></head><results></results></sparql>');
  });
  await new Promise((r) => server.listen(0, '0.0.0.0', r));
  const port = server.address().port;
  const seed = PIN.seeds.driver;
  const script = [
    'set -e', 'mkdir /w', 'cd /w', 'cp -r /bsbm/queries /bsbm/usecases /bsbm/lib /bsbm/log4j.xml .',
    `java -cp ".:lib/*" benchmark.testdriver.TestDriver -runs ${runs} -w 0 -seed ${seed} -idir /td -ucf usecases/explore/sparql.txt -o /w/r.xml http://host.docker.internal:${port}/sparql > /w/driver.log`,
  ].join('; ');
  console.log(`capturing ${runs} runs of driver parameters (seed ${seed})`);
  const r = await dockerAsync(['run', '--rm', '-m', '1g', '--add-host', 'host.docker.internal:host-gateway',
    '-v', `${tools}:/bsbm:ro`, '-v', `${join(out, 'td_data')}:/td:ro`, pinnedImage('temurin'), 'sh', '-c', script], { mem: 1 });
  server.close();
  if (r.status !== 0) throw new Error(`the test driver failed (${r.status}): ${r.stderr || r.stdout}`);

  const params = {};
  for (const name of Object.keys(templates)) params[name] = [];
  for (const q of captured) {
    let matched = false;
    for (const [name, t] of Object.entries(templates)) {
      try { params[name].push(extractParams(t.text, q)); matched = true; break; } catch { /* next template */ }
    }
    if (!matched) throw new Error(`a query the driver sent fits no Explore template:\n${q}`);
  }
  for (const [name, list] of Object.entries(params)) {
    if (list.length < runs) throw new Error(`${name}: the driver sent ${list.length} parameter sets, ${runs} are needed`);
    params[name] = list.slice(0, runs);
  }
  const record = {
    size, driverSeed: seed, runs, accept: Object.fromEntries(Object.entries(templates).map(([n, t]) => [n, acceptFor(t.form)])),
    params,
  };
  writeFileSync(join(out, 'params.json'), `${JSON.stringify(record, null, 1)}\n`);
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const work = workDir(flags);
  const sizes = String(flags.sizes ?? PIN.sizes.join(',')).split(',').map(Number);
  const runs = Number(flags.runs ?? 23);
  const tools = await ensureTools(work);
  for (const size of sizes) {
    if (!PIN.sizes.includes(size) && !flags['any-size']) throw new Error(`size ${size} is not one of ${PIN.sizes.join(', ')}; --any-size allows it`);
    const out = generateDataset(work, tools, size);
    const manifestPath = join(out, 'manifest.json');
    if (!existsSync(manifestPath)) {
      const d = await fileDigest(join(out, 'dataset.nt'));
      writeFileSync(manifestPath, `${JSON.stringify({
        size, ...d, generatorSeed: PIN.seeds.generator, generatorImage: pinnedImage('temurin'),
        bsbmToolsSha256: PIN.datasets.bsbmtools.sha256, forwardChaining: true,
      }, null, 2)}\n`);
      console.log(`${size}: ${d.triples} triples, ${d.bytes} bytes, sha256 ${d.sha256}`);
    }
    if (!existsSync(join(out, 'params.json'))) await captureParams(work, tools, out, size, runs);
    console.log(`${size}: ready in ${out}`);
  }
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
