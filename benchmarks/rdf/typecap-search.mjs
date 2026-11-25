#!/usr/bin/env node
/**
 * Finds the largest product count the Ythril import can take under its type cap, from the generator's output.
 *
 *   node benchmarks/rdf/typecap-search.mjs [--lo 1000] [--hi 3000] [--cap 200] [--work <dir>]
 *
 * Each probe generates the dataset of that size (booked docker), makes its variant and counts the distinct `rdf:type`
 * classes; nothing is loaded. A probe's folder is removed afterwards unless it is one of the pinned sizes. The last
 * line is the answer as JSON: `{"size": N, "types": T}`; `generate.mjs --sizes N --any-size` then makes the real one.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ensureTools, generateDataset } from './generate.mjs';
import { PIN, parseArgs, workDir } from './env.mjs';
import { prepareFile } from './prepare.mjs';
import { countTypesInFile, largestUnderCap } from './typecap.mjs';

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const work = workDir(flags);
  const tools = await ensureTools(work);
  const count = (n) => {
    const dir = generateDataset(work, tools, n);
    const probe = join(dir, 'types-probe.nt');
    prepareFile(join(dir, 'dataset.nt'), probe);
    const types = countTypesInFile(probe);
    rmSync(probe, { force: true });
    if (!PIN.sizes.includes(n)) rmSync(dir, { recursive: true, force: true });
    console.log(`${n} products: ${types} types`);
    return types;
  };
  const found = largestUnderCap(count, { lo: Number(flags.lo ?? 1000), hi: Number(flags.hi ?? 3000), cap: Number(flags.cap ?? 200) });
  console.log(JSON.stringify(found));
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
