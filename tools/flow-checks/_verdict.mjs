/**
 * How a project flow-check probe says its answer: the last stdout line starts `holds:`, `violated:` or `cannot answer:`, and the exit code is 0, 1 or 2.
 * `project-check.mjs` (the flows' runner) reads exactly that, and treats anything else as "cannot answer".
 *
 * ## What it prevents
 *
 * A probe that cannot read its input and reports "holds" about nothing. Anything a probe throws (a missing folder, a listing under its floor, a
 * git failure) is `cannot answer`, exit 2, never exit 0. Every probe in this folder that does not load a browser answers through here, so the
 * rule is written once.
 *
 * The three small helpers are the whole API: `holds(why)`, `violated(what)` and `CannotAnswer`, and `answer(fn)` runs a probe as a script.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** The probe could not read what it needs. */
export class CannotAnswer extends Error {}
export const holds = (reason) => ({ holds: true, reason });
export const violated = (reason) => ({ holds: false, reason });

/** True when `metaUrl` is the file node was started with, so a module can export its logic and still run as a script. */
export const isMain = (metaUrl) => Boolean(process.argv[1]) && fileURLToPath(metaUrl) === resolve(process.argv[1]);

/** Run `decide` (sync or async, returns holds()/violated()) and print the one verdict line; the exit code follows it. */
export async function answer(decide) {
  try {
    const v = await decide();
    console.log(`${v.holds ? 'holds' : 'violated'}: ${v.reason}`);
    process.exitCode = v.holds ? 0 : 1;
  } catch (e) {
    console.log(`cannot answer: ${String(e?.message ?? e).split('\n')[0]}`);
    process.exitCode = 2;
  }
}

/** `--name value` pairs from argv (a flag always takes the next argument). */
export function flagsOf(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    if (i + 1 >= argv.length) throw new CannotAnswer(`${argv[i]} needs a value`);
    flags[argv[i].slice(2)] = argv[++i];
  }
  return flags;
}
