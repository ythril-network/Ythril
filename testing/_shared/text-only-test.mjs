/**
 * Which standalone tests read only tracked text: the ONE place that answers it, by computation from each file's import closure (Q-870, bundle-316).
 *
 * ## What it prevents
 *
 * The preflight ran every pure standalone file after the server build and the client build, because some of them read `server/dist`. Many do not:
 * they read nothing a build or an install writes, and the changelog test among them takes a fraction of a second. "Needs no build" was a hand list of
 * gate files (`SOURCE_GATES`), the only statement of it, so a failure in any other such file was found minutes late and the list could not grow with
 * the tree. This module says it for every file, so the preflight can run them first and a new text-only test is early without anyone listing it.
 *
 * ## The rule
 *
 * A file is TEXT-ONLY when nothing in its import closure (the file, and every tracked `.js`, `.mjs` or `.cjs` its relative imports reach) does any of
 * these, each read from the code with comments stripped (and the strings left, because a path is written in one):
 *
 * - imports under `server/`, `client/` or `schema/` (their sources and their builds), or a TypeScript module;
 * - names `server/dist`, `client/dist` or `schema/dist` ({@link readsDist}), or `node_modules`;
 * - calls `fetch(`, or uses `createRequire`, a `require(` or an `import(` whose argument is not a string literal (it cannot be followed);
 * - imports a package, or a Node module that opens a network or starts a worker (`net`, `http`, `https`, `http2`, `dgram`, `tls`, `dns`,
 *   `worker_threads`, `cluster`);
 * - starts a process other than git: a module that imports `child_process` is allowed only when every way it can start a process is visibly a call whose
 *   program is the literal `'git'` and nothing else (git reads the tracked tree). Every name of a spawn function must be such a call (a renamed import, a
 *   destructuring that renames, a bracket access or a stored reference is not), there must be at least one, a shell string must be `git` and plain arguments
 *   (no `&&`, `;`, `|`, backtick, `$` or redirect), and `shell: true` is refused;
 * - builds a path to a `dist` folder from parts (`join` or `resolve` with a `'dist'` segment), or reads a directory in a way that can reach a build or an
 *   install: a recursive read (`recursive: true`, a `**` glob), or a directory read whose path names `server`, `client` or `schema` as a segment;
 * - writes a second import statement on a line after a `;` (every import statement of the code is read, not one per line).
 *
 * Anything it cannot read or resolve is NOT text-only: a relative import that resolves to no tracked file, a file that is not tracked, a closure it
 * could not follow. It never throws on what a test says (a template literal that holds an import line is read as an import: the answer is a conservative
 * no, never a crash), and it never answers text-only for a closure it could not follow.
 *
 * ## The one known limit
 *
 * A static rule over code cannot see a build path that lives in DATA (a decision record that cites `server/dist`, a JSON file a test reads), a `dist` or
 * `node_modules` folder named by a value computed elsewhere (a segment held in a variable and joined later, a name read from a file), a hand-written walk
 * that descends a folder it was handed, or a closure it cannot read as text (a string that holds `/` and `*` and so hides code from the comment stripper).
 * The first of those was found by running the files with no build (`decisions-are-recorded`, which now checks citations against the tracked tree). Two things
 * guard the rest: CI runs the text kind before it installs or builds anything (`run-standalone.mjs --only=text`, a step of the `standalone-pure` job),
 * so a misclassified file fails there for want of what it needs; and on a developer machine, where a stale `server/dist` or `node_modules` usually
 * exists, a misclassified file can PASS in the preflight's source stage until CI runs it.
 *
 * Reuses `resolveRelativeSpecifier` and `stripComments`, and the one tracked-file listing (`trackedSources`). One question per
 * function: {@link readsOnlyTrackedText} asks one file, {@link textOnlyFiles} asks the pure files of a split, {@link readsDist} asks one text about one
 * build directory.
 */
import { isBuiltin } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { trackedSources } from '../standalone/_sources.mjs';
import { resolveRelativeSpecifier } from '../standalone/_relative-specifier.mjs';
import { stripComments } from '../standalone/_strip-comments.mjs';

/** The build directories a text-only file must not name. */
const BUILD_DIRS = ['server', 'client', 'schema'];

/** Code (comments already out) that names `<which>/dist` as a path or as joined segments. */
const namesDist = (code, which) => new RegExp(`\\b${which}/dist\\b`).test(code)
  || new RegExp(`['"\`]${which}['"\`]\\s*,\\s*['"\`]dist['"\`]`).test(code);

/**
 * True when `src` (comments stripped) names the output directory of `which` ('server' | 'client' | 'schema') as a path or as joined segments.
 * The one dist rule: the preflight's stage test asks it of the source gates, and the classifier asks it of every module of a closure.
 */
export function readsDist(src, which) {
  return namesDist(stripComments(src), which);
}

/** A relative or bare specifier written in code: static `import … from`, `export … from`, a side-effect `import '…'`, a literal `import('…')` or `require('…')`. */
const SPECIFIER = /(?:^|;)\s*(?:import|export)\s[^;]*?\sfrom\s*['"]([^'"]+)['"]|(?:^|;)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/gm;

/** An import of `child_process` (named, namespace or default), with the names a braced one binds. */
const CHILD_PROCESS_IMPORT = /import\s*(?:\{([^}]*)\}|\*\s*as\s+[\w$]+|[\w$]+)\s*from\s*['"](?:node:)?child_process['"]/g;

/** Every spelling of a function that starts a process: a name anywhere in the code, call or not. */
const SPAWN_NAME = /\b(execFileSync|execFile|spawnSync|spawn|execSync|exec|fork)\b/g;
/** The ones that take the program as a first argument, and the ones that take a shell line. */
const TAKES_PROGRAM = new Set(['execFileSync', 'execFile', 'spawnSync', 'spawn', 'fork']);
/** A shell line that is git and plain arguments: nothing that chains, pipes, substitutes or redirects. */
const PLAIN_GIT_LINE = /^git(?:\s[^&;|`$<>\n\\]*)?$/;
/** The first argument of a call, when it is a string literal. */
const FIRST_ARGUMENT_LITERAL = /^\(\s*(['"`])((?:(?!\1)[^\\\n])*)\1/;

/** The text of a call's arguments, with two levels of nested parentheses read (`join(process.cwd(), 'client')`). */
const ARGUMENTS = String.raw`(?:[^()]|\((?:[^()]|\([^()]*\))*\))*`;
/** A path built from parts with a `dist` segment. */
const PATH_WITH_DIST = new RegExp(String.raw`\b(?:join|resolve)\(${ARGUMENTS}['"\`]dist['"\`]`);
/** A directory read, and its argument text. */
const DIRECTORY_READ = new RegExp(String.raw`\b(?:readdirSync|readdir|opendirSync|opendir|globSync|glob)\((${ARGUMENTS})\)`, 'g');
/** A string literal. */
const STRING_LITERAL = /(['"`])((?:(?!\1)[^\\\n])*)\1/g;

/**
 * Why a module that imports `child_process` does not visibly start git and nothing else, or null when it does.
 * @param {string} code the module's code, comments stripped
 */
function startsOtherThanGit(code) {
  for (const m of code.matchAll(CHILD_PROCESS_IMPORT)) if (m[1] !== undefined && /\bas\b/.test(m[1])) return 'it renames an import of child_process';
  // The import statements' own names are not uses; every other spelling is.
  const rest = code.replace(CHILD_PROCESS_IMPORT, '');
  if (/\bshell\s*:\s*true\b/.test(rest)) return 'it asks for a shell';
  let gitCalls = 0;
  for (const m of rest.matchAll(SPAWN_NAME)) {
    const first = FIRST_ARGUMENT_LITERAL.exec(rest.slice(m.index + m[0].length));
    const visiblyGit = first !== null && (TAKES_PROGRAM.has(m[1]) ? first[2] === 'git' : PLAIN_GIT_LINE.test(first[2]));
    if (!visiblyGit) return `${m[1]} is not a call whose program is the literal git`;
    gitCalls++;
  }
  return gitCalls === 0 ? 'it imports child_process and makes no visible call of git' : null;
}

/** Node modules that open a network, start a worker or start a process (`child_process` is judged by its calls, below). */
const NETWORK_OR_WORKER = new Set(['net', 'http', 'https', 'http2', 'dgram', 'tls', 'dns', 'worker_threads', 'cluster']);

const SOURCE_EXTENSION = /\.(?:m|c)?js$/;

/**
 * One module's own facts, with no closure: why it alone is not text-only (a sentence), and the relative specifiers a closure walk follows. Read from the
 * code with comments stripped by the repository's one stripper (`stripComments`); strings stay, because a path is written in one. Its known limit is
 * the stripper's: a `/*` inside a string reads as a comment opener and hides code up to the next `*` and `/`, which can hide a refusal; the first step of CI's
 * pure job (see the header) is what finds a file that slips through that way.
 */
function ownFacts(file, text) {
  const code = stripComments(text);
  const specifiers = new Set();
  for (const m of code.matchAll(SPECIFIER)) specifiers.add(m[1] ?? m[2] ?? m[3] ?? m[4]);
  const refusals = [];
  for (const which of BUILD_DIRS) if (namesDist(code, which)) refusals.push(`names ${which}/dist in ${file}`);
  if (/node_modules/.test(code)) refusals.push(`names node_modules in ${file}`);
  if (/\bfetch\(/.test(code)) refusals.push(`calls fetch in ${file}`);
  if (/\bcreateRequire\b/.test(code)) refusals.push(`uses createRequire in ${file}`);
  if (/(?<![.\w$])require\(\s*[^'"\s)]/.test(code)) refusals.push(`calls require with a value it cannot follow in ${file}`);
  if (/\bimport\(\s*[^'"\s)]/.test(code)) refusals.push(`calls import() with a value it cannot follow in ${file}`);
  let usesChildProcess = false;
  for (const spec of specifiers) {
    if (spec.startsWith('.')) continue;
    const base = spec.replace(/^node:/, '').split('/')[0];
    if (isBuiltin(spec) && base === 'child_process') usesChildProcess = true;
    else if (isBuiltin(spec) && NETWORK_OR_WORKER.has(base)) refusals.push(`imports node:${base} in ${file}`);
    else if (!isBuiltin(spec)) refusals.push(`imports package '${spec}' in ${file}`);
  }
  if (usesChildProcess) {
    const why = startsOtherThanGit(code);
    if (why) refusals.push(`starts a process other than git in ${file} (${why})`);
  }
  if (PATH_WITH_DIST.test(code)) refusals.push(`builds a path to a dist folder from parts in ${file}`);
  for (const read of code.matchAll(DIRECTORY_READ)) {
    if (/recursive\s*:\s*true/.test(read[1]) || /\*\*/.test(read[1])) { refusals.push(`reads a directory recursively in ${file}, which can reach a build or an install`); break; }
    const rooted = [...read[1].matchAll(STRING_LITERAL)].map(l => /(?:^|[/\\])(server|client|schema)(?:[/\\]|$)/.exec(l[2])?.[1]).find(Boolean);
    if (rooted) { refusals.push(`reads a directory rooted at ${rooted}/ in ${file}, which holds a build and an install`); break; }
  }
  return { refusals, relative: [...specifiers].filter(s => s.startsWith('.')) };
}

/**
 * A classifier over one checkout: the tracked files are listed once, and each module's facts are read once however many test files reach it.
 *
 * @param {string} root the checkout
 * @returns {(file: string) => { textOnly: boolean, reason: string }}
 */
function classifierFor(root) {
  // No floor: a scratch repository holds a handful of files, and the question here is whether a file is tracked, not whether the tree is whole.
  const tracked = new Set(trackedSources('.', { ext: null, floor: 0, root }));
  const has = (path) => tracked.has(path);
  const facts = new Map();
  const factsOf = (file) => {
    if (!facts.has(file)) {
      let text = null;
      try { text = readFileSync(join(root, file), 'utf8'); } catch { /* an unreadable file is a refusal below, never a throw */ }
      facts.set(file, text === null ? { refusals: [`cannot read ${file}`], relative: [] } : ownFacts(file, text));
    }
    return facts.get(file);
  };

  return (file) => {
    if (!has(file)) return { textOnly: false, reason: `${file} is not a tracked file of ${root}` };
    const seen = new Set();
    const queue = [file];
    while (queue.length > 0) {
      const current = queue.shift();
      if (seen.has(current)) continue;
      seen.add(current);
      const own = factsOf(current);
      if (own.refusals.length > 0) return { textOnly: false, reason: own.refusals[0] };
      for (const spec of own.relative) {
        const target = posix.join(posix.dirname(current), spec);
        const underBuild = BUILD_DIRS.find(dir => target === dir || target.startsWith(`${dir}/`));
        if (underBuild) return { textOnly: false, reason: `${current} imports ${target}, code under ${underBuild}/` };
        const resolved = resolveRelativeSpecifier(spec, current, has);
        if (resolved === null) return { textOnly: false, reason: `${current} imports '${spec}', which resolves to no tracked file` };
        if (resolved.endsWith('.ts')) return { textOnly: false, reason: `${current} imports the TypeScript module ${resolved}` };
        if (SOURCE_EXTENSION.test(resolved)) queue.push(resolved);
      }
    }
    return { textOnly: true, reason: `no module of the ${seen.size}-file import closure reads a build, an install, the network or a process but git` };
  };
}

/**
 * Does this standalone test read only tracked text?
 *
 * @param {string} file repo-relative, forward slashes (`testing/standalone/x.test.js`)
 * @param {{ root?: string }} [options] the checkout, default the working directory
 * @returns {{ textOnly: boolean, reason: string }} `reason` says what rules a file out, or what was checked
 */
export function readsOnlyTrackedText(file, { root = process.cwd() } = {}) {
  return classifierFor(root)(file);
}

/**
 * The text-only files among the pure files of a split: repo-relative paths, sorted, with no `@ci-only` file (a file that is too slow to run at every
 * push stays out of the preflight's early stage too, and CI runs it with the rest).
 *
 * Lazy and separate from `splitStandalone`, so a runner that does not ask pays nothing and a broken classifier cannot take down the runs that never
 * needed it (the database and instance jobs).
 *
 * @param {{ offlinePure: string[], ciOnly: string[] }} split as `splitStandalone` returns it (bare file names)
 * @param {{ root?: string }} [options] the checkout, default the working directory
 * @returns {string[]}
 */
export function textOnlyFiles(split, { root = process.cwd() } = {}) {
  const classify = classifierFor(root);
  return split.offlinePure
    .filter(name => !split.ciOnly.includes(name))
    .map(name => `testing/standalone/${name}`)
    .filter(file => classify(file).textOnly)
    .sort();
}
