/**
 * No script under `scripts/` hands a shell a command string it built from a value (bundle-373, Q-970).
 *
 * ## What it prevents
 *
 * `scripts/preflight.mjs` ran `run(\`node ./scripts/check-changelog.mjs ${changelogAgainst}\`)`, a shell string, with a ref name read from the
 * branch's upstream. Git admits `;`, `$(`, `&`, `|` and backticks in a ref name, so a local branch tracking a remote `release/x;cmd` ran `cmd`
 * on the machine that ran the preflight. A value goes to a child as an argument (`execFileSync(file, [args])`), where no shell reads it.
 *
 * ## The rule
 *
 * In a tracked `.mjs` or `.js` file under `scripts/`, the first argument of `execSync(`, `exec(` or `run(` is a plain string: no `${`
 * inside a template literal, and no `+` joining a literal to a value.
 *
 * Run: node --test testing/standalone/a-script-never-builds-a-shell-command-from-a-value.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';

const SHELL_CALL = /\b(?:execSync|exec|run)\(\s*(?:`[^`]*\$\{|'[^'\n]*'\s*\+\s*[^'"`\s]|"[^"\n]*"\s*\+\s*[^'"`\s])/g;

/** The shell calls in `text` whose command string is built from a value, as `line: text`. */
export function interpolatedShellCalls(text) {
  const found = [];
  for (const m of text.matchAll(SHELL_CALL)) {
    const line = text.slice(0, m.index).split('\n').length;
    found.push(`${line}: ${m[0].replace(/\s+/g, ' ')}`);
  }
  return found;
}

describe('a script never builds a shell command from a value', () => {
  it('no tracked script under scripts/ passes execSync, exec or run a template or a concatenation holding a value', () => {
    const sources = readTrackedSources('scripts', { ext: ['.mjs', '.js'], floor: 20 });
    const hits = sources.flatMap(({ file, text }) => interpolatedShellCalls(text).map((h) => `${file}:${h}`));
    assert.deepEqual(hits, [], 'pass the value as an argument: execFileSync(file, [args])');
  });

  it('fires on the shapes it exists for, and holds a plain string and an argument list', () => {
    assert.equal(interpolatedShellCalls('run(`node ./scripts/check-changelog.mjs ${base}`)').length, 1);
    assert.equal(interpolatedShellCalls("execSync('git diff ' + base)").length, 1);
    assert.equal(interpolatedShellCalls('execSync(\n  `git ${x}`)').length, 1);
    assert.equal(interpolatedShellCalls("run('node scripts/a.mjs')").length, 0);
    assert.equal(interpolatedShellCalls("run('a ' +\n  'b')").length, 0, 'literals joined over lines hold no value');
    assert.equal(interpolatedShellCalls("execFileSync('node', ['./scripts/check-changelog.mjs', base])").length, 0);
  });
});
