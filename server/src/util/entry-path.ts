/**
 * How to start one of the server's OWN entry points as a separate process, in a build and in a checkout.
 *
 * ## The question it answers
 *
 * "Given the name of an entry file under `server/src`, what command runs it?" In a build the answer is the compiled
 * `.js` under the current node. In a development checkout there is no compiled file, so it is the `.ts` run through
 * the `tsx` command line that the repository hoists into its root `node_modules`. When neither exists the answer is
 * a refusal that names both places it looked, so the operator is not left reading a bare `ENOENT` from a spawn.
 *
 * ## Why it is a module
 *
 * `api/local-agent.ts` knew this first (the connector it starts). The inference host is the second place that
 * launches an entry of ours, and a second hand-written copy is one more place to get the `tsx` path wrong in a way
 * only developers notice. `local-inference-structure.test.js` holds that the `tsx` command-line path is written in
 * exactly one source, this one.
 *
 * ## Why it refuses names
 *
 * It turns a string into a program this server will execute. Every call site passes a compile-time constant, but a
 * helper with that power must not take the string's word for it: only plain relative segments are accepted, so the
 * day somebody hands it something derived from input it throws instead of launching it. No `..`, no absolute path,
 * no drive letter, no extension (the function chooses `.js` or `.ts`), no separators other than `/`.
 *
 * The answer is only a command and its arguments. What to do with them (`spawn` detached for the connector, `fork`
 * with an IPC channel for the inference child) is the caller's business, which is why this is one module serving
 * two different launch styles.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** What to execute: `cmd` with `args`. `args` ends with the entry file itself. */
export interface EntryCommand {
  cmd: string;
  args: string[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Plain relative segments of letters, digits, `-` and `_`, joined by single `/`. */
const ENTRY_NAME = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/i;

/**
 * @param name  the entry under the server tree without an extension, e.g. `brain/embed-process`
 * @param opts  `root` and `tsxCli` exist for the tests; they default to the tree this module sits in and the
 *              hoisted `tsx` of the repository (the tree is `server/src` or `server/dist`, so two levels above
 *              it is the repository root)
 * @throws when the name is not a plain relative entry name, or when there is nothing to run
 */
export function resolveEntry(
  name: string,
  opts: { root?: string; tsxCli?: string } = {},
): EntryCommand {
  if (typeof name !== 'string' || !ENTRY_NAME.test(name)) {
    throw new Error(
      `Refusing to launch ${JSON.stringify(name)}: not a valid entry name (plain relative segments of letters, `
      + 'digits, "-" and "_" separated by "/", with no extension).',
    );
  }
  const root = opts.root ?? path.resolve(HERE, '..');
  const base = path.join(root, ...name.split('/'));
  const jsEntry = `${base}.js`;
  const tsEntry = `${base}.ts`;

  if (fs.existsSync(jsEntry)) return { cmd: process.execPath, args: [jsEntry] };

  if (fs.existsSync(tsEntry)) {
    // Development checkout: `tsx` is hoisted to the repository root's node_modules.
    const tsxCli = opts.tsxCli ?? path.resolve(root, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (!fs.existsSync(tsxCli)) {
      throw new Error(`${tsEntry} is a source entry and needs tsx to run, but tsx was not found at ${tsxCli}.`);
    }
    return { cmd: process.execPath, args: [tsxCli, tsEntry] };
  }

  throw new Error(`Entry point "${name}" was not found: looked for ${jsEntry} and ${tsEntry}.`);
}
