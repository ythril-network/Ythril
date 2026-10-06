/**
 * How a script knows it was RUN, and what its command line said — the two questions every `scripts/*.mjs` that is also
 * an importable module asks before doing anything.
 *
 * ## Why it is a module
 *
 * `executed-tests`, `unexpected-skips`, `unrun-tests`, `test-times` and `testing/_init/run-suite.mjs` each wrote
 * `process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url`, and the first three each wrote
 * their own `valueOf` plus their own "no argument I do not know" check. Two of the five spelled the entry test in a way
 * that threw when `argv[1]` was absent (`node -e`, a REPL), and the three flag parsers each decided differently what a
 * flag with no value meant (`--root` alone meant "the working directory" in one, "the default root" in another).
 *
 * ## What it prevents
 *
 * - {@link isEntryPoint} answers `false`, never throws, when there is no script path: an import under `node -e` must
 *   not run a script's main.
 * - {@link readFlags} REFUSES what it cannot read instead of guessing: a flag whose value is missing (the next token is
 *   absent or another flag), a flag given twice and any token that is neither a named flag nor its value are all
 *   returned in `stray`, so a caller that checks `stray.length` can never read `--results` as "the current folder".
 *   The check is inside the parser because it is the line a hand-written copy drops.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Was the module whose `import.meta.url` is `moduleUrl` started as the process's script (`node scripts/x.mjs`), rather
 * than imported by something that does?
 *
 * @param {string} moduleUrl  the caller's `import.meta.url`
 */
export function isEntryPoint(moduleUrl) {
  const script = process.argv[1];
  return Boolean(script) && pathToFileURL(resolve(script)).href === moduleUrl;
}

/**
 * The values of the named `--flag value` pairs in `argv`, and everything the command line held that is not one.
 *
 * @param {string[]} argv   the arguments after the script name
 * @param {string[]} flags  the flags this script takes, each followed by one value
 * @returns {{ values: Record<string, string|undefined>, stray: string[] }} `values[flag]` is `undefined` when the flag
 *   was not given; `stray` holds each unknown token, each flag without a value and each repeated flag, in order
 */
export function readFlags(argv, flags) {
  const values = Object.fromEntries(flags.map(f => [f, undefined]));
  const stray = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!flags.includes(token)) { stray.push(token); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--') || values[token] !== undefined) { stray.push(token); continue; }
    values[token] = next;
    i++;
  }
  return { values, stray };
}
