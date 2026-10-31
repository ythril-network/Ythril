/**
 * Does the checkout hold a file git does not track that no rule NAMING A PLACE registers?
 *
 * ## Why this exists
 *
 * Q-626, 2026-10-27. Agent runs left logs, a bash stack dump, test output and stray worktree copies in the owner's
 * checkout, and nothing reported them: `*.log` and `*.txt` in `.gitignore` hide build and test output, so `git status`
 * stayed clean around exactly the files that should have been noticed. A catch-all rule exists to hide output; it does
 * not say "this is where such files belong". Scratch goes outside every checkout (`scratchRoot`, `scripts/_shared/scratch-root.mjs`); the first answer, a gitignored `tmp/` in the checkout, registered the clutter instead of keeping it out, and its rule is gone, so a `tmp/` is unregistered like any other stray.
 *
 * ## The rule
 *
 * A path git does not track is REGISTERED only when `git check-ignore -v --no-index` matches it to a rule that names a
 * place, from a `.gitignore` or from `.git/info/exclude`: `node_modules/`, `dist/`, `local-data/`, `config/config.json`. It is UNREGISTERED when it is
 *
 * - not ignored at all (`git status` says `??`), or
 * - ignored only by a CATCH-ALL: a rule whose pattern has no `/` (a trailing one aside) and has a `*` in it, such as
 *   `*.log`, `npm-debug.log*`, `*.txt`, `_diag_body*.json`, `.env.*`, or
 * - ignored only by a source that does not travel with the checkout (a machine-wide `core.excludesFile`), or
 * - editor and operating-system noise: `.DS_Store` and `Thumbs.db` (`*.swp` and `*.swo` are catch-alls already). A stray
 *   one is clutter too, and its bare-name rule says no place.
 *
 * `git check-ignore -v` names the LAST rule that matches, so a rule that names the path but is written above a catch-all in the
 * same file is never the one it reports (Q-656: a rule for `testing/sync/configs/<name>/token.txt` above `*.txt`). A path whose reported rule is a
 * catch-all is therefore asked again against only the non-catch-all rules of that rule file (`git ls-files -o -i --exclude=<rule>...`,
 * negations kept, no temporary file), and is registered when one of them names it. A rule file in a subdirectory is not asked again:
 * its patterns are relative to its own folder, and the question here puts them at the root.
 *
 * The catch-all set is DERIVED from the rule files ({@link catchAllRules}), never listed, so a `*.foo` added to
 * `.gitignore` next year is covered the day it is written. The question each path is put is the shape of the rule that
 * hid it, which is also what {@link catchAllRules} reports, so the two cannot disagree.
 *
 * ## What it prevents, and what it does not
 *
 * It fails the clutter that a catch-all hides. It cannot tell a file the owner wants from one an agent dropped; that is
 * why the answer for a deliberate local file is a rule that names its place (as `config/config.json` is), not an
 * exemption here. It reads git's own answer for every path and keeps no list of its own.
 *
 * Usage: node scripts/unregistered-local-files.mjs [--root <dir>] [--catch-all]
 *   exit 0 nothing unregistered; exit 1 one or more, each printed with the rule that hid it (or "untracked");
 *   exit 2 a bad argument or a git that did not answer. `--catch-all` prints the derived catch-all rules, one a line.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint, readFlags } from './_shared/script-cli.mjs';
import { SCRATCH_ROOT_ENV, scratchRoot } from './_shared/scratch-root.mjs';

/** Bare file names that are editor or operating-system noise: a rule naming one registers no place. */
const NOISE_NAMES = new Set(['.DS_Store', 'Thumbs.db']);

/** The pattern of a rule, read as git reads it for this question: no negation, no escaped leading `#`, no trailing slash. */
const bodyOf = (pattern) => pattern.replace(/\/+$/, '');

/**
 * Is `pattern` a rule that hides output without naming a place?
 *
 * @param {string} pattern  one `.gitignore` pattern, as written
 */
export function isCatchAll(pattern) {
  if (!pattern || pattern.startsWith('!')) return false;
  const body = bodyOf(pattern);
  if (body.includes('/')) return false; // a path or directory rule: it names where
  return body.includes('*') || NOISE_NAMES.has(body);
}

/**
 * The catch-all patterns a rule file holds, in file order and without repeats.
 *
 * @param {string} text  the contents of a `.gitignore` (or `.git/info/exclude`)
 * @returns {string[]}
 */
export function catchAllRules(text) {
  const found = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (isCatchAll(line) && !found.includes(line)) found.push(line);
  }
  return found;
}

const git = (root, args, input) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
  cwd: root, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
});

/** Untracked (`??`) and ignored (`!!`) paths: a directory only when git collapses it, which it does when the directory as a whole is untracked or matched by a rule. */
function untrackedPaths(root) {
  const fields = git(root, ['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=normal']).split('\0');
  const out = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    if (code[0] === 'R' || code[0] === 'C') i++; // a rename or copy carries its source as the next field
    if (code === '??' || code === '!!') out.push({ path: field.slice(3), ignored: code === '!!' });
  }
  return out;
}

/** The rule (`source`, `line`, `pattern`) that ignores each path, keyed by path; a path no rule matches is absent. */
function rulesFor(root, paths) {
  if (paths.length === 0) return new Map();
  const answer = git(root, ['check-ignore', '-v', '--no-index', '-z', '--stdin'], paths.join('\0') + '\0').split('\0');
  const rules = new Map();
  for (let i = 0; i + 3 < answer.length; i += 4) rules.set(answer[i + 3], { source: answer[i], line: answer[i + 1], pattern: answer[i + 2] });
  return rules;
}

/** The non-catch-all rules of a rule file, one per line as written, negations kept: the rules that can name a place. */
function placeRules(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || isCatchAll(line)) continue;
    rules.push(line);
  }
  return rules;
}

/** How many paths one `git ls-files` call is asked about: a command line has a length limit, and a stack dump can leave thousands. */
const PATHS_PER_ASK = 100;

/**
 * Which of `paths` do the `rules` (and only they) ignore? `git ls-files -o -i --exclude=<rule>...` applies exactly the rules it is
 * given, so the answer is never the last-match one `check-ignore -v` gives. A path given with a trailing slash is a directory git
 * collapsed; it is named when the rules ignore the directory as a whole.
 */
function namedByRules(root, rules, paths) {
  const named = new Set();
  if (rules.length === 0) return named;
  for (let i = 0; i < paths.length; i += PATHS_PER_ASK) {
    const chunk = paths.slice(i, i + PATHS_PER_ASK);
    const answer = git(root, ['--literal-pathspecs', 'ls-files', '-z', '-o', '-i', '--directory', ...rules.map(r => `--exclude=${r}`), '--', ...chunk]);
    for (const p of answer.split('\0')) if (p) named.add(p);
  }
  return named;
}

/** Does the rule come from a file a clone would receive, or from this checkout's own exclude file? */
const isRepositoryRuleFile = (source) => /(^|[\\/])\.gitignore$/.test(source) || /[\\/]info[\\/]exclude$/.test(source);

/**
 * Every unregistered path under `root`, each with the reason.
 *
 * @param {string} root  a git working tree
 * @returns {{ path: string, why: string }[]}
 */
export function unregisteredLocalFiles(root) {
  const entries = untrackedPaths(root);
  const rules = rulesFor(root, entries.filter(e => e.ignored).map(e => e.path));
  /** Paths whose reported rule is a catch-all, by the rule file that holds it: asked again against that file's place rules. */
  const askedAgain = new Map();
  for (const { path, ignored } of entries) {
    const rule = ignored ? rules.get(path) : undefined;
    if (rule && isRepositoryRuleFile(rule.source) && isCatchAll(rule.pattern)) askedAgain.set(rule.source, [...(askedAgain.get(rule.source) ?? []), path]);
  }
  const named = new Set();
  for (const [source, paths] of askedAgain) {
    const file = resolve(root, source);
    const atRoot = dirname(file) === resolve(root) || /[\\/]info[\\/]exclude$/.test(source);
    if (atRoot && existsSync(file)) for (const p of namedByRules(root, placeRules(readFileSync(file, 'utf8')), paths)) named.add(p);
  }
  const found = [];
  for (const { path, ignored } of entries) {
    if (!ignored) { found.push({ path, why: 'untracked' }); continue; }
    const rule = rules.get(path);
    if (!rule) { found.push({ path, why: 'ignored by a rule git did not name' }); continue; }
    if (!isRepositoryRuleFile(rule.source)) { found.push({ path, why: `hidden only by ${rule.source}, which no clone receives` }); continue; }
    if (isCatchAll(rule.pattern) && !named.has(path)) {
      found.push({ path, why: `only the catch-all rule ${rule.pattern} (${rule.source}:${rule.line}) hides it` });
    }
  }
  return found;
}

/** Where scratch goes, for the message: the scratch root, or the reason it cannot be named (a bad variable must not read as a git failure). */
function scratchPlace() {
  try { return scratchRoot(); } catch (error) { return `the folder named by ${SCRATCH_ROOT_ENV} (${error.message})`; }
}

function main(argv) {
  const { values, stray } = readFlags(argv.filter(a => a !== '--catch-all'), ['--root']);
  if (stray.length) { console.error(`unregistered-local-files: unknown argument(s) ${stray.join(' ')}; the ones it takes are --root <dir> and --catch-all`); return 2; }
  const root = resolve(values['--root'] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  try {
    if (argv.includes('--catch-all')) {
      const text = existsSync(join(root, '.gitignore')) ? readFileSync(join(root, '.gitignore'), 'utf8') : '';
      console.log(catchAllRules(text).join('\n'));
      return 0;
    }
    const found = unregisteredLocalFiles(root);
    for (const { path, why } of found) console.log(`${path}  (${why})`);
    if (found.length === 0) return 0;
    console.error(`\n${found.length} path(s) in ${root} that git does not track and no rule registers as a place. Scratch goes outside every checkout, under ${scratchPlace()}; `
      + 'a file you mean to keep local needs a .gitignore rule that names its path, not a catch-all; anything else: delete it.');
    return 1;
  } catch (error) {
    console.error(`unregistered-local-files: git did not answer for ${root}: ${String(error.stderr || error.message).trim()}`);
    return 2;
  }
}

if (isEntryPoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
