/**
 * What files the repository actually has — the one implementation, with the floor built in.
 *
 * ## Why this exists, and it is a self-inflicted example
 *
 * `Q-6` spent six rounds converting gates that asserted a whole set while reading a hand-written list of
 * files. Every conversion replaced the list with the same four lines: shell out to `git ls-files`, split,
 * filter by extension, assert a floor. By the end that block existed about ten times, written by the same
 * sweep whose entire subject is *"a rule written twice is a rule that can be wrong once"*.
 *
 * Owner, 2026-09-07: *"when you find copies i always think 'why is that not a reusable module then?'"*
 *
 * ## The floor is INSIDE, and that is the point of the module
 *
 * An empty listing passes every loop written over it, so a gate whose scan is broken reports success about
 * nothing at all. That is the same defect one level up from what these gates check, and it is the half a
 * copy is most likely to omit — it is the line that looks like boilerplate.
 *
 * Here it cannot be omitted: asking for the sources gives you the floor whether you remembered it or not.
 *
 * ## Why `git ls-files` rather than reading the directory
 *
 * `todo/`, `node_modules/` and every build output are gitignored, and a `readdirSync` walk finds them. The
 * question these gates ask is *"what does this repository contain"*, and git is the only thing that answers
 * it — see `gitignored-files-break-local-checks` in the reference notes.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Tracked files under `dirs`, filtered by extension, with a minimum asserted.
 *
 * @param {string|string[]} dirs      one or more paths, as `git ls-files` takes them
 * @param {object}          [opts]
 * @param {string[]|null}   [opts.ext] extensions to keep, default `['.ts']`; `null` keeps EVERY tracked file, the
 *                                       `.d.ts` rule included (a caller asking what the checkout holds, not what is source)
 * @param {number}          [opts.floor] the minimum that means the scan worked, default 100
 * @param {string[]}        [opts.exclude] exact paths to drop — the module that DEFINES the thing under test
 * @param {string}          [opts.root] the checkout to list, default this repository. A scratch copy of the
 *                                       tracked layout is listed through the same module, floor included, so the
 *                                       scripts that are exercised against one count files the way they do.
 * @param {boolean}         [opts.specs] include `.spec.ts`, default true. The one real second question:
 *                                       "what does the PRODUCT contain" against "what does the repo contain".
 * @param {boolean}         [opts.untracked] also return files that are NOT COMMITTED yet, default false —
 *                                       the second real second question, described below.
 * @returns {string[]} repo-relative paths, forward slashes, as git prints them
 *
 * `.d.ts` is never returned (unless `ext` is `null`). A declaration file is not a source in the sense any of these gates mean, and
 * every caller that hand-rolled this excluded it — which is what makes it a default rather than an option.
 */
export function trackedSources(dirs, opts = {}) {
  const { ext = ['.ts'], floor = 100, exclude = [], specs = true, untracked = false, root = REPO_ROOT } = opts;
  const paths = Array.isArray(dirs) ? dirs : [dirs];
  /*
   * `-z` and a NUL split rather than newlines.
   *
   * Without it, `git ls-files` QUOTES any path holding a space, a quote or a non-ASCII byte — so such a file
   * would arrive wrapped in double quotes and match no `endsWith` any caller writes, silently leaving itself
   * out of the sweep. Several of the sweeps folded in here already did this; doing it in the module means
   * none of them had to remember.
   */
  const NUL = String.fromCharCode(0);
  const ls = (args) => execFileSync('git', ['ls-files', '-z', ...args, ...paths],
    { cwd: resolve(root), maxBuffer: 64 * 1024 * 1024 }).toString('utf8');

  /*
   * `--others --exclude-standard` adds files that exist on disk and are not committed, while still honouring
   * .gitignore — so a build output or a scratch file never enters the scan.
   *
   * Two gates want it and they want it for the same reason: an unbounded upstream read, or a boot migration
   * over synced data, is worth REFUSING before it is pushed, and a tracked-only listing cannot see one that
   * was written five minutes ago. `upstream-reads-are-bounded` learned it the hard way — on its first run the
   * scan missed the very helper the gate points at, because that helper was part of the same uncommitted
   * change.
   *
   * It is an option rather than the default because the other question is the more common one and the two
   * differ in a way that matters: a listing including uncommitted files is not reproducible between this
   * machine and CI, so a gate that wants a stable set must not get one.
   */
  const raw = untracked ? `${ls([])}${NUL}${ls(['--others', '--exclude-standard'])}` : ls([]);

  const listed = [...new Set(raw.split(NUL).map(f => f.trim()))]
    .map(f => f.replace(/\\/g, '/'))
    .filter(f => f
      && (ext === null || (ext.some(e => f.endsWith(e)) && !f.endsWith('.d.ts')))
      && (specs || !f.endsWith('.spec.ts'))
      && !exclude.includes(f));

  if (listed.length < floor) {
    // THROWS rather than returning empty. A caller that gets `[]` loops over nothing and reports a green
    // tick, which is exactly the failure the floor exists to prevent — so the failure has to be the listing's
    // own, not something each caller has to remember to check for.
    throw new Error(
      `only ${listed.length} file(s) found under ${paths.join(', ')} of ${resolve(root)} with a floor of ${floor}. The listing is `
      + 'broken, not the code: an empty scan passes every loop written over it, so this fails loudly rather '
      + 'than reporting success about nothing.');
  }
  return listed;
}

/** Every tracked source, read. Saves the `map(readFileSync)` that follows every one of these scans. */
export function readTrackedSources(dirs, opts = {}) {
  const { root = REPO_ROOT } = opts;
  return trackedSources(dirs, opts).map(f => ({ file: f, text: readFileSync(join(root, f), 'utf8') }));
}

/**
 * What a TEST FILE is, written once: `*.test.{js,mjs,cjs,ts}` and `*.spec.{js,mjs,cjs,ts}` (not `tsconfig.spec.json`,
 * not `docker-compose.test.yml`). These are the suffixes `trackedSources` takes as `ext`, and {@link isTestFile} reads
 * the same list, so a listing and a one-path question cannot disagree.
 *
 * ## What it prevents
 *
 * Six sites each decided for themselves what a test file is — `.test.js` under `testing/` here, `.test.js` plus
 * `.spec.ts` under two folders there, a regular expression over the whole repository in a third. The files they
 * disagree about are the ones checked by some of them and not by others: a `.test.mjs` that a CI selection reaches but
 * the body gates never parse, a `.spec.js` the executed-tests check counts and the splitter does not. The question
 * "what suffix makes a file a test" is asked here and nowhere else; WHERE to look stays a parameter of each caller.
 */
export const TEST_FILE_SUFFIXES = Object.freeze(['.test.js', '.test.mjs', '.test.cjs', '.test.ts', '.spec.js', '.spec.mjs', '.spec.cjs', '.spec.ts']);

/** Is this repo-relative path a test file? */
export const isTestFile = (path) => TEST_FILE_SUFFIXES.some(s => String(path).endsWith(s));

/** The fewest tracked test files that means a whole-repository listing worked — far under what is held, so adding or removing a test never trips it. */
export const TRACKED_TEST_FLOOR = 100;

/**
 * Every tracked test file of the checkout at `root` (default: this repository), sorted, repo-relative with forward
 * slashes. `trackedSources` with the test suffixes: the floor is inside, so an empty listing THROWS.
 *
 * @param {object} [opts]
 * @param {string} [opts.root]   the checkout to list
 * @param {string|string[]} [opts.dirs] where to look, default the whole checkout
 * @param {number} [opts.floor]  default {@link TRACKED_TEST_FLOOR}; a caller listing one folder says its own
 */
export function trackedTestFiles({ root = REPO_ROOT, dirs = ['.'], floor = TRACKED_TEST_FLOOR } = {}) {
  return trackedSources(dirs, { ext: [...TEST_FILE_SUFFIXES], floor, root }).sort();
}
