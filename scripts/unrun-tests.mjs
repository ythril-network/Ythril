#!/usr/bin/env node
/**
 * `node scripts/unrun-tests.mjs [--root <dir>]` — which tracked test file does no CI selection reach?
 *
 * ## The failure this prevents
 *
 * A test file is only a test if something runs it. CI runs the union of what its commands SELECT — globs over
 * `testing/<suite>/`, the standalone split, the vitest `include` for the client — and nothing asked whether that union
 * was every test file the repository has. A file under `testing/bench/`, a spec outside `client/src`, a test one
 * directory deeper than a glob reaches: each is tracked, each looks like a test, each is green in review because nobody
 * ran it. It is the same defect as a skipped test with a different cause.
 *
 * ## What it derives, and from what — never from a list
 *
 * The commands CI runs are READ: every `run:` of `.github/workflows/ci.yml`, followed through the `npm run <script>`
 * chains of `package.json` (root and workspace) and through the runner scripts that name further scripts. What those
 * commands select is READ too: the path globs of a `node --test` line, the directories a runner owns
 * (`run-standalone.mjs`: the standalone folder; `run-suite.mjs <suite>`: the folder its table gives that suite), and the
 * `include` of the vitest config a `vitest` command runs with. Narrow one of those and the files it stops reaching appear,
 * which is what shows they are read rather than remembered.
 *
 * Tracked test files minus that union is the answer. It runs in preflight and in the aggregator, so the mistake is found
 * before a push and not by a reader of the log.
 *
 * ## Floors, because an empty set proves nothing
 *
 * A derivation that finds no workflow, no selections, or fewer tracked test files than a plausible repository holds is a
 * broken derivation and EXITS 2; it is never read as "nothing unrun". Exit 1 means files were named; exit 0 means none.
 *
 * Its pair is `scripts/executed-tests.mjs`: this one asks whether a file is SELECTED, that one whether it produced a
 * test event (a file a glob matches that registers nothing).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackedSources, trackedTestFiles, isTestFile } from '../testing/standalone/_sources.mjs';
import { isEntryPoint, readFlags } from './_shared/script-cli.mjs';
import { stripComments } from '../testing/standalone/_strip-comments.mjs';
import { CI_WORKFLOW, loadCi, jobEntries, stepsOf, shellOf, shellCommands } from '../testing/_shared/ci-workflow.mjs';

/** A glob as a regular expression over repo-relative paths (`*`, `**`, `?`, `{a,b}`; nothing else is special). */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) { re += '\\{'; continue; }
      re += `(?:${glob.slice(i + 1, end).split(',').map(s => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`;
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * Every script a workflow's steps run, as the shell would read it (continuations joined, `#` lines gone) — from the
 * one workflow reader, which follows a local composite action: a test command moved into `.github/actions/*` is still
 * run by its job, and reading `step.run` alone would report its files unrun or, worse, derive nothing and say so.
 */
function workflowCommands(root) {
  return jobEntries(loadCi(root)).flatMap(({ job }) => stepsOf(job).map((step) => shellOf(step, { root })).filter(Boolean));
}

/** One shell script (already read as the shell reads it) as separate simple commands, each an array of words. */
function simpleCommands(script) {
  return shellCommands(script)
    .map(seg => seg.split(/\s+/).filter(Boolean))
    .map(words => {
      while (words.length && (/^[A-Za-z_]\w*=/.test(words[0]) || words[0] === 'cross-env')) words.shift();
      return words;
    })
    .filter(words => words.length > 0);
}


/**
 * What the commands CI runs select, as `{ regex, why }` entries over repo-relative paths.
 *
 * @param {string} root
 * @returns {Array<{ re: RegExp, why: string }>}
 */
export function ciSelections(root) {
  const selections = [];
  const seenScripts = new Set();
  const seenFiles = new Set();
  const pkgCache = new Map();
  const pkgAt = (dir) => {
    if (!pkgCache.has(dir)) {
      const p = join(root, dir, 'package.json');
      pkgCache.set(dir, existsSync(p) ? readJson(p) : null);
    }
    return pkgCache.get(dir);
  };
  const tracked = trackedSources(['.'], { ext: null, root });
  const select = (glob, why) => selections.push({ re: globToRegExp(glob), why });

  /** The suite table of `run-suite.mjs`: `name: { dir: '…' }`. */
  const suiteDirs = () => {
    const p = join(root, 'testing/_init/run-suite.mjs');
    if (!existsSync(p)) return new Map();
    return new Map([...readFileSync(p, 'utf8').matchAll(/(\w+):\s*\{\s*dir:\s*'([^']+)'/g)].map(m => [m[1], m[2]]));
  };

  /** The vitest `include` globs of the config in `dir`, prefixed with `dir`. */
  const vitestIncludes = (dir) => {
    const configs = tracked.filter(f => new RegExp(`^${dir === '' ? '' : `${dir}/`}vitest\\.config\\.[mc]?[jt]s$`).test(f));
    if (configs.length === 0) throw new Error(`a command runs vitest in ${dir || '.'}, which has no vitest config to read`);
    const text = readFileSync(join(root, configs[0]), 'utf8');
    const m = /include:\s*\[([^\]]*)\]/.exec(text);
    if (!m) throw new Error(`${configs[0]} has no \`include: [...]\` list to read`);
    return [...m[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map(g => (dir === '' ? g[1] : `${dir}/${g[1]}`));
  };

  const runScript = (dir, name, via) => {
    const key = `${dir}::${name}`;
    if (seenScripts.has(key)) return;
    seenScripts.add(key);
    const cmd = pkgAt(dir)?.scripts?.[name];
    if (typeof cmd !== 'string') return;
    runCommands(simpleCommands(cmd), dir, `${via} > ${dir ? `${dir}:` : ''}${name}`);
  };

  /** A runner (`node some/script.mjs`) is followed into the package scripts it names. */
  const followRunner = (file, via) => {
    if (seenFiles.has(file) || !existsSync(join(root, file))) return;
    seenFiles.add(file);
    // Comment-free: a script name mentioned in prose is not a script the runner runs.
    const text = stripComments(readFileSync(join(root, file), 'utf8'));
    const scripts = Object.keys(pkgAt('')?.scripts ?? {});
    for (const name of new Set([...text.matchAll(/['"`]([\w:-]+)['"`]/g)].map(m => m[1]))) {
      if (scripts.includes(name)) runScript('', name, `${via} > ${file}`);
    }
  };

  function runCommands(commands, dir, via) {
    for (const words of commands) {
      const [bin, ...rest] = words;
      if (bin === 'npm' || bin === 'npx') {
        if (bin === 'npm') {
          const sub = rest[0];
          const ws = rest.find(w => w.startsWith('--workspace='))?.slice('--workspace='.length)
            ?? (rest.includes('-w') ? rest[rest.indexOf('-w') + 1] : rest.includes('--workspace') ? rest[rest.indexOf('--workspace') + 1] : undefined);
          const target = ws ?? dir;
          if (sub === 'run' || sub === 'run-script') {
            const name = rest.slice(1).find(w => !w.startsWith('-'));
            if (name) runScript(target, name, via);
          } else if (sub === 'test' || sub === 't') runScript(target, 'test', via);
        } else if (rest[0] === 'vitest') {
          for (const g of vitestIncludes(dir)) select(g, `${via}: vitest in ${dir || '.'}`);
        }
        continue;
      }
      if (bin === 'vitest') {
        for (const g of vitestIncludes(dir)) select(g, `${via}: vitest in ${dir || '.'}`);
        continue;
      }
      if (bin === 'node') {
        const args = rest.filter(w => !w.startsWith('-') || w === '-');
        if (rest.includes('--test')) {
          // `node --test <files, globs or directories>`: every word that names test files.
          for (const w of args) {
            const path = w.replace(/^\.\//, '');
            if (isTestFile(path) || /[*?{]/.test(path)) select(dir ? `${dir}/${path}` : path, `${via}: node --test`);
            else if (tracked.some(f => f.startsWith(`${path.replace(/\/$/, '')}/`))) {
              select(`${path.replace(/\/$/, '')}/**`, `${via}: node --test (directory)`);
            }
          }
          continue;
        }
        const script = (args[0] ?? '').replace(/^\.\//, '');
        if (/(^|\/)run-standalone\.mjs$/.test(script)) {
          // splitStandalone lists the test files directly inside the folder (a nested one is refused there).
          select('testing/standalone/*.test.js', `${via}: ${script}`);
        } else if (/(^|\/)run-suite\.mjs$/.test(script)) {
          const dirs = suiteDirs();
          const suite = args[1];
          if (suite && dirs.has(suite)) select(`${dirs.get(suite)}/*.test.js`, `${via}: ${script} ${suite}`);
        }
        if (script) followRunner(script, via);
      }
    }
  }

  runCommands(workflowCommands(root).flatMap(simpleCommands), '', CI_WORKFLOW);
  return selections;
}

/** @returns {{ unrun: string[], total: number, selections: number }} */
export function unrunTests(root) {
  const files = trackedTestFiles({ root });
  const selections = ciSelections(root);
  if (selections.length === 0) {
    throw new Error(`no test selection could be derived from ${CI_WORKFLOW} and the package scripts it runs under ${root}. `
      + 'An empty union reaches nothing, so every file would be reported unrun — or, read the other way, none: this is the '
      + 'derivation failing, not a verdict.');
  }
  const unrun = files.filter(f => !selections.some(s => s.re.test(f)));
  return { unrun, total: files.length, selections: selections.length };
}

if (isEntryPoint(import.meta.url)) {
  const { values, stray } = readFlags(process.argv.slice(2), ['--root']);
  if (stray.length > 0) {
    console.error('usage: node scripts/unrun-tests.mjs [--root <dir>]');
    process.exit(2);
  }
  const root = values['--root'] ? resolve(values['--root']) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const { unrun, total, selections } = unrunTests(root);
    if (unrun.length > 0) {
      console.error(`unrun-tests: ${unrun.length} tracked test file(s) that no CI selection reaches — CI never starts them:`);
      for (const f of unrun) console.error(`  ${f}`);
      console.error('Move each into a folder a suite runs, or add the command that runs it to .github/workflows/ci.yml.');
      process.exit(1);
    }
    console.log(`unrun-tests: all ${total} tracked test files are reached by one of ${selections} CI selections`);
  } catch (e) {
    console.error(`unrun-tests: the derivation failed — ${e.message}`);
    process.exit(2);
  }
}
