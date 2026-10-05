/**
 * A standalone test file one directory deeper than `testing/standalone/` is REFUSED by `splitStandalone`, not
 * mapped by its basename.
 *
 * ## The failure this prevents
 *
 * `splitStandalone()` (`testing/_shared/standalone-split.mjs`) lists `git ls-files testing/standalone` and keeps
 * `f.split('/').pop()` — the basename — then reads and runs `testing/standalone/<basename>`. For a file at
 * `testing/standalone/sub/x.test.js` that is a path that does not exist, so today the split dies with an `ENOENT`
 * naming a file nobody wrote, from a gate that is supposed to be the one place that knows which files exist. Worse
 * is the file whose basename COLLIDES with a top-level one (`sub/a-byte-budget-counts-bytes.test.js` beside the
 * real `a-byte-budget-counts-bytes.test.js`): the basename maps to the top-level file, the nested one is never
 * run, the top-level one is listed twice, and nothing says so — a test file that exists, is tracked, passes review,
 * and is not in any batch.
 *
 * Nothing in the repository nests a standalone test today, and the unrun-tests check (Q-283) is what notices one
 * no selection reaches. This is the half that must not make it worse: a nested file is a mistake the split names,
 * with its path, instead of a mapping that is wrong in a way that depends on the file's name. Whether nesting
 * should one day be SUPPORTED is a separate question; until it is, refusing is the only honest answer, because
 * the split's output feeds batches that are `testing/standalone/<name>` paths.
 *
 * ## How it is exercised
 *
 * The real `splitStandalone`, run in a child process whose working directory is a COPY of the tracked layout
 * (`_ci-root-fixture.mjs`) with a nested file added — the function reads the repository it runs in, and the
 * working tree this runs from is not to be dirtied. Three rows: the copy as it is (answers, with its floors),
 * a nested file with a new name, a nested file whose basename collides with a top-level one.
 *
 * Run: node --test testing/standalone/a-nested-standalone-test-is-refused-not-misread.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { makeCiRoot } from './_ci-root-fixture.mjs';

const SPLIT = pathToFileURL(join(REPO_ROOT, 'testing', '_shared', 'standalone-split.mjs')).href;
const TEST_FILE = "import { it } from 'node:test';\nit('registers', () => {});\n";

/** Call `splitStandalone()` with `cwd` as the repository; report what it returned or how it failed. */
function splitIn(cwd) {
  const probe = `import(${JSON.stringify(SPLIT)}).then((m) => {
    try {
      const s = m.splitStandalone();
      console.log(JSON.stringify({ ok: true, all: s.all }));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, code: e.code ?? null, message: String(e.message) }));
    }
  });`;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd, env, encoding: 'utf8', timeout: 60_000 });
  const line = r.stdout.trim().split('\n').pop();
  try { return JSON.parse(line); } catch { assert.fail(`the probe printed nothing parseable:\n${r.stdout}\n${r.stderr}`); }
}

describe('splitStandalone and a test file nested under testing/standalone', () => {
  let ci;
  before(() => { ci = makeCiRoot(); });
  after(() => ci.dispose());

  it('the layout as it is: answers, with every file listed once', () => {
    const r = splitIn(ci.root);
    assert.equal(r.ok, true, `the split failed on the unmodified layout: ${JSON.stringify(r)}`);
    assert.ok(r.all.length >= 100, `only ${r.all.length} files listed`);
    assert.equal(new Set(r.all).size, r.all.length, 'a file is listed twice');
  });

  it('a nested file with a new name is refused, naming its path — not an ENOENT for a path nobody wrote', () => {
    ci.with({ add: { 'testing/standalone/sub/nested-and-new.test.js': TEST_FILE } }, () => {
      const r = splitIn(ci.root);
      assert.equal(r.ok, false, 'a nested test file was accepted and mapped by its basename');
      assert.notEqual(r.code, 'ENOENT', `the refusal is a failed read of a path the split invented: ${r.message}`);
      assert.ok(r.message.includes('testing/standalone/sub/nested-and-new.test.js'),
        `the refusal does not name the file's real path: ${r.message}`);
      assert.match(r.message, /nested|subdirector/i, `the refusal does not say what is wrong: ${r.message}`);
    });
  });

  it('a nested file whose basename collides with a top-level one is refused too — it must not run the other file twice', () => {
    const topLevel = ci.tracked().find(f => /^testing\/standalone\/[^/]+\.test\.js$/.test(f));
    const name = topLevel.split('/').pop();
    ci.with({ add: { [`testing/standalone/sub/${name}`]: TEST_FILE } }, () => {
      const r = splitIn(ci.root);
      assert.equal(r.ok, false, `the nested copy of ${name} was accepted: the top-level file would be listed twice and the nested one never run`);
      assert.ok(r.message.includes(`testing/standalone/sub/${name}`), `the refusal does not name the nested path: ${r.message}`);
    });
  });
});
