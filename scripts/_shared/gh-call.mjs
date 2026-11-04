/**
 * The one place that spawns `gh`, built from node built-ins only (Q-588, Q-584, Q-710).
 *
 * ## What it prevents
 *
 * A second `gh` caller that spells the guards again drops one of them, and each guard is a line a copy forgets:
 *
 * - **A run id is all decimal digits, and is refused before any call** ({@link decimalId}). An id becomes an argument of
 *   `gh run view` and part of an endpoint path: `../../orgs` or `1?x=2` would read another resource.
 * - **`gh` is called with an argument array, a 60 s bound and a clean environment, never a shell line** ({@link ghText}). A hang
 *   ends, nothing is interpreted, and the recorder's token (`YTHRIL_TEST_RUNS_*`) is not handed to a program with no use for it:
 *   the environment is `testChildEnv()`'s.
 * - **A missing or logged-out `gh` is named** ({@link GhNotInstalledError}, {@link GhNotLoggedInError}), so a report is never
 *   printed from nothing and a caller can tell the two apart.
 * - **The repository is named once, and a value from the environment is validated before it becomes part of an endpoint path**
 *   ({@link repoSlug}): `GITHUB_REPOSITORY` is `owner/name`, and nothing else is a path.
 *
 * ## Why it is its own module
 *
 * `scripts/_shared/ci-run-reader.mjs` also reads `ci.yml` through js-yaml, a package. The pull request's `reuse` job installs
 * nothing, so the script it runs may import only node built-ins and repository files (held by
 * `unexpected-skips-fail-the-ci-gate`): the call core lives here with no package in its closure, and the reader re-exports it
 * unchanged. Still exactly one place that spawns `gh` (held by `one-reader-of-a-workflows-runs`).
 *
 * Every function takes an injected `exec` where it spawns, so a gate can hand it a fake and assert on the argument arrays.
 */
import { execFileSync } from 'node:child_process';
import { testChildEnv } from '../../testing/_shared/test-child-env.mjs';

/** The repository a local run reads when the environment names none: `gh run view` and the REST endpoint must name the same one. */
export const DEFAULT_REPO_SLUG = 'ythril-network/Ythril';

/** An `owner/name` as GitHub spells it: letters, digits, `-`, `_` and `.`, one slash, neither half only dots. */
const REPO_SLUG_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * The repository to read: `GITHUB_REPOSITORY` when the run sets it (an empty variable is unset), else the default for a local
 * run. Throws on a value that is not `owner/name`, because it becomes part of an endpoint path.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function repoSlug(env = process.env) {
  const value = env.GITHUB_REPOSITORY;
  if (value === undefined || value === '') return DEFAULT_REPO_SLUG;
  if (!REPO_SLUG_SHAPE.test(value) || value.split('/').some(part => /^\.+$/.test(part))) {
    throw new Error(`GITHUB_REPOSITORY ${JSON.stringify(value)} is not owner/name`);
  }
  return value;
}

/** `gh` is not on the PATH. */
export class GhNotInstalledError extends Error {
  constructor(cause) {
    super('gh is not installed or not on the PATH: install the GitHub CLI (https://cli.github.com) and run `gh auth login`');
    this.name = 'GhNotInstalledError';
    this.cause = cause;
  }
}

/** `gh` is installed and has no login. */
export class GhNotLoggedInError extends Error {
  constructor(cause) {
    super('gh is not logged in: run `gh auth login`');
    this.name = 'GhNotLoggedInError';
    this.cause = cause;
  }
}

/** A run id (or job id) as the string that goes into an argument or an endpoint path; throws on anything that is not all decimal digits. */
export function decimalId(id, what = 'run id') {
  const text = typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? String(id) : id;
  if (typeof text !== 'string' || !/^\d+$/.test(text)) throw new Error(`${what} ${JSON.stringify(id)} is not a decimal number`);
  return text;
}

/**
 * What `gh <args>` printed, as text. `args` must be an array of strings (a shell line is refused before anything runs).
 *
 * @param {string[]} args
 * @param {{ exec?: typeof execFileSync }} [options]  `exec` is `execFileSync`'s shape, injected by gates
 */
export function ghText(args, { exec = execFileSync } = {}) {
  if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) throw new TypeError('gh is called with an argument array of strings, never a shell line');
  try {
    // timeout: the bound on every call, 60 s; a hung gh ends and says so. env: `gh` runs a user's extensions and aliases and has no
    // use for the recorder's token (`YTHRIL_TEST_RUNS_*`, held by a process that records): `testChildEnv` is the one place that
    // says what a child inherits.
    return String(exec('gh', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024, env: testChildEnv(), stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (e) {
    if (e?.code === 'ENOENT') throw new GhNotInstalledError(e);
    if (/gh auth login|not logged in/i.test(`${e?.message ?? ''}\n${e?.stderr ?? ''}`)) throw new GhNotLoggedInError(e);
    throw e;
  }
}

/** What `gh <args>` printed, parsed as JSON. */
export function ghJson(args, options) {
  const text = ghText(args, options);
  try { return JSON.parse(text); } catch { throw new Error(`gh ${args.slice(0, 2).join(' ')} printed no JSON`); }
}
