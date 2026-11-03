/**
 * `scripts/check-changelog.mjs` asks for an `[Unreleased]` entry for a change to a sidecar or to a script a user runs
 * (Q-611, Q-612).
 *
 * ## What it missed
 *
 * The check required an entry for `server/src/`, `client/src/` and `client/public/` and exempted `scripts/` outright.
 * Two things that ship are neither. `sidecars/` is code that runs in the product's own containers — the render sidecars
 * parse untrusted documents, and Q-611 changes how much memory a page may take — and `scripts/enable-networks-
 * workstation.*` is the program an operator runs on their own machine and that writes their secrets (Q-612). A change
 * to either went through with no CHANGELOG line and nothing noticed, which is exactly what the check exists to stop.
 *
 * ## How it is tested
 *
 * The script itself is run, in a scratch git repository with a base commit, a CHANGELOG with an `[Unreleased]` section and
 * a working-tree change under the path in question: exit 1 and the file named when no line was added under
 * `[Unreleased]`, exit 0 when one was. Paths that must stay exempt (docs, tests) and paths that were always covered
 * (`server/src`) are the controls, so a pass here is not "the check now fails everything".
 *
 * Run: node --test testing/standalone/check-changelog-covers-sidecars-and-scripts.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeScratchRepo } from '../_shared/scratch-git-repo.mjs';
import { testChildEnv } from '../_shared/test-child-env.mjs';
import { REPO_ROOT } from './_sources.mjs';

const CHANGELOG = '# Changelog\n\n## [Unreleased]\n\n## [1.0.0] — 2026-01-01\n\n- first\n';
/** Files the check needs next to it, copied from the repository under test. */
const NEEDED = ['scripts/check-changelog.mjs', 'scripts/_changelog-sections.mjs', 'testing/_shared/running-under-ci.mjs'];
/** Tracked paths the base commit holds, so a change to one is a modification, not an addition. */
const BASE_FILES = {
  'sidecars/doc-render/app.py': 'print("render")\n',
  'sidecars/doc-office/app.py': 'print("office")\n',
  'sidecars/doc-render/Dockerfile': 'FROM python:3\n',
  'scripts/enable-networks-workstation.sh': '#!/usr/bin/env bash\necho hi\n',
  'scripts/enable-networks-workstation.ps1': 'Write-Host hi\n',
  'server/src/index.ts': 'export {};\n',
  'client/src/main.ts': 'export {};\n',
  'docs/guide.md': '# guide\n',
  'testing/standalone/x.test.js': '// x\n',
};

let repo;

/** Run the check against the base commit; `edit` changes the working tree first. */
function check(edit) {
  const { dir, git } = repo;
  git('checkout', '-q', '--', '.');
  git('clean', '-fdq');
  edit(dir);
  const r = spawnSync(process.execPath, ['scripts/check-changelog.mjs', 'main'], {
    cwd: dir, encoding: 'utf8', env: testChildEnv({}),
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const touch = (rel) => (dir) => writeFileSync(join(dir, rel), `${readFileSync(join(dir, rel), 'utf8')}// changed\n`);
const withEntry = (edit) => (dir) => {
  edit(dir);
  writeFileSync(join(dir, 'CHANGELOG.md'), CHANGELOG.replace('## [Unreleased]\n', '## [Unreleased]\n\n- a line that says what changed\n'));
};

describe('the changelog check covers what runs in a container or on an operator\'s machine', () => {
  before(() => {
    repo = makeScratchRepo({ prefix: 'ythril-check-changelog-', branch: 'main' });
    for (const rel of NEEDED) {
      mkdirSync(dirname(join(repo.dir, rel)), { recursive: true });
      copyFileSync(join(REPO_ROOT, rel), join(repo.dir, rel));
    }
    writeFileSync(join(repo.dir, 'CHANGELOG.md'), CHANGELOG);
    for (const [rel, text] of Object.entries(BASE_FILES)) {
      mkdirSync(dirname(join(repo.dir, rel)), { recursive: true });
      writeFileSync(join(repo.dir, rel), text);
    }
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'base');
    // The scratch repo's own tools must run: a node the test cannot start would read as "the check failed".
    execFileSync(process.execPath, ['--version']);
  });
  after(() => repo?.cleanup());

  const MUST_NEED_AN_ENTRY = [
    'sidecars/doc-render/app.py',
    'sidecars/doc-office/app.py',
    'sidecars/doc-render/Dockerfile',
    'scripts/enable-networks-workstation.sh',
    'scripts/enable-networks-workstation.ps1',
  ];
  for (const rel of MUST_NEED_AN_ENTRY) {
    it(`a change to ${rel} with no [Unreleased] line fails and names the file`, () => {
      const r = check(touch(rel));
      assert.equal(r.status, 1, `expected the check to refuse, got ${r.status}:\n${r.out}`);
      assert.ok(r.out.includes(rel), `the failure must name ${rel}:\n${r.out}`);
    });

    it(`the same change with a line under [Unreleased] passes`, () => {
      const r = check(withEntry(touch(rel)));
      assert.equal(r.status, 0, r.out);
    });
  }

  it('control: a change to server/src with no entry still fails (the rule was always there)', () => {
    const r = check(touch('server/src/index.ts'));
    assert.equal(r.status, 1, r.out);
    assert.ok(r.out.includes('server/src/index.ts'), r.out);
  });

  it('control: a change to client/src with no entry still fails', () => {
    assert.equal(check(touch('client/src/main.ts')).status, 1);
  });

  it('control: docs and tests stay exempt', () => {
    assert.equal(check(touch('docs/guide.md')).status, 0);
    assert.equal(check(touch('testing/standalone/x.test.js')).status, 0);
  });

  it('control: a line added under a RELEASED section does not satisfy it', () => {
    const r = check((dir) => {
      touch('sidecars/doc-render/app.py')(dir);
      writeFileSync(join(dir, 'CHANGELOG.md'), CHANGELOG.replace('- first\n', '- first\n- a typo fix in a released section\n'));
    });
    assert.equal(r.status, 1, r.out);
  });
});
