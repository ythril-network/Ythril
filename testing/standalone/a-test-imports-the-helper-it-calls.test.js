/**
 * A test that calls a shared helper imports it — because the suites that would notice need Docker.
 *
 * ## What happened
 *
 * `Q-38` added `waitForIndexed(...)` to four integration files and the import to three of them. The
 * fourth threw `waitForIndexed is not defined` in its `before`, which cancelled every subtest under it:
 * **eight reported failures from one missing import**, and the first seven said only *"test did not
 * finish before its parent and was cancelled"*, which points nowhere near the cause.
 *
 * ## Why a gate rather than a linter
 *
 * There is no ESLint in this repo, so `no-undef` is not available to lean on — and adding a linter to
 * catch one class of mistake is a dependency, a config and a new failure surface for everybody.
 *
 * What makes this worth its own gate instead is WHERE the mistake lands. `preflight` cannot run the
 * integration, sync or red-team suites: they need Docker. So a missing import in one of them is
 * invisible locally and costs a full CI round trip — twelve minutes to be told about a one-word edit.
 * This runs in `preflight`, where it costs a second.
 *
 * ## Derived from the helper module, not from a list
 *
 * The names come from `testing/sync/helpers.js`'s own exports. A helper added next year is covered
 * without anybody remembering this file exists, and a helper renamed stops being checked under its old
 * name rather than silently passing.
 *
 * Run: node --test testing/standalone/a-test-imports-the-helper-it-calls.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const HELPERS = 'testing/sync/helpers.js';

let exported;

/** Comments stripped, so a helper NAMED in a docblock is not read as a call. */
function stripComments(src) {
  return src
    .split('\n')
    .map(l => l.replace(/(^|[^:])\/\/.*/, '$1'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * The suites `preflight` CANNOT RUN, from git — and the scope IS the rule.
 *
 * A missing import in a standalone gate fails the moment anybody runs preflight, so it needs no gate.
 * These three need Docker, so the same mistake there is invisible until CI, where it cost twelve minutes
 * to be told about a one-word edit.
 *
 * It also keeps this honest. Several standalone gates QUOTE example code in string literals — an
 * assertion message containing `await patch(A, tok, …)` — and a scan that read those as calls reported
 * four innocent files. Narrowing to where the cost actually is beats teaching a regex to parse
 * JavaScript.
 */
const SUITES = ['testing/integration/', 'testing/sync/', 'testing/red-team-tests/'];

function trackedTests() {
  const out = execFileSync('git', ['ls-files', 'testing'], { encoding: 'utf8' })
    .split('\n').map(l => l.trim())
    .filter(l => /\.m?js$/.test(l) && SUITES.some(d => l.startsWith(d)));
  assert.ok(out.length >= 40, `expected the Docker suites, found ${out.length} files`);
  return out;
}

/** The names a file pulls in, from any import or require — not only from the helpers module. */
function importedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const name = part.replace(/\btype\b/, '').split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  for (const m of src.matchAll(/import\s+(\w+)\s+from/g)) names.add(m[1]);
  // `const { a, b } = await import(…)` and plain destructuring off a require.
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().split('=')[0].trim();
      if (name) names.add(name);
    }
  }
  // A locally declared function of the same name is not a missing import either.
  for (const m of src.matchAll(/function\s+(\w+)\s*\(/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=/g)) names.add(m[1]);
  return names;
}

describe('a test imports the helper it calls', () => {
  before(() => {
    const src = readFileSync(HELPERS, 'utf8');
    exported = new Set([...src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(m => m[1]));
  });

  it('reads the helper module (the check itself works)', () => {
    /*
     * A floor, because an empty export set would make the sweep below loop over nothing and report every
     * file clean — the shape this repo's gates are required to guard against.
     */
    assert.ok(exported.size >= 10,
      `expected the shared helpers, found ${exported.size} exported function(s) in ${HELPERS}`);
  });

  it('every call to a shared helper has an import behind it', () => {
    const offenders = [];
    for (const file of trackedTests()) {
      if (file === HELPERS) continue;
      const src = stripComments(readFileSync(file, 'utf8'));
      const names = importedNames(src);
      for (const helper of exported) {
        if (names.has(helper)) continue;
        /*
         * A bare CALL, not a mention and not a METHOD. `\b` matches straight after a dot, so `map.get(`
         * and `headers.get(` read as calls to a helper named `get` — which is a real export here, and
         * which reported four innocent files on the first run. The lookbehind is what makes the name
         * have to stand alone.
         */
        if (new RegExp(`(?<![.\\w$])${helper}\\s*\\(`).test(src)) offenders.push(`${file} calls ${helper}()`);
      }
    }
    assert.deepEqual(offenders, [],
      'These files call a shared helper they never imported. It throws at run time — and in the Docker '
      + 'suites, a throw inside `before` CANCELS every subtest under it, so one missing import reports '
      + 'as a page of failures whose messages point nowhere near it.');
  });
});
