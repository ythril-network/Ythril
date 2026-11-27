/**
 * The release notes and the release gate carry only what the mechanism rule passed.
 *
 * ## Why this exists (Q-975)
 *
 * `a-changelog-entry-names-no-internal-mechanism` holds `[Unreleased]` in the static preflight. A release is cut from a
 * section that is `[Unreleased]` renamed, and what the cut publishes is the public text: the GitHub Release body
 * (`scripts/release-notes.mjs`) and the section the gate checks before the tag (`scripts/release-gate.mjs`). A rule that
 * lived in the preflight alone would let an entry written straight into a release section, or a preflight that was skipped,
 * reach the Releases page, which nobody can take back. So both doors ask the same module the preflight asks.
 *
 * ## What it holds
 *
 * - `release-notes.mjs` exits 1 and names the line when the section it cuts for a release after 6.5.7 names a mechanism,
 *   writes nothing, and cuts a clean section as before. It is run as a program, in a directory that holds only a changelog.
 * - `release-gate.mjs` imports the rule and fails the `changelog` gate with its description (read from the code, comments out:
 *   the gate is a script that runs on import, so the call is read, not made).
 *
 * Run: node --test testing/standalone/a-release-cut-holds-the-mechanism-rule.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stripComments } from './_strip-comments.mjs';

const NOTES = resolve('scripts/release-notes.mjs');

const section = (version, ...entries) => ['# Changelog', '', '## [Unreleased]', '', `## [${version}] — 2026-12-01`, '',
  '**A minor release: planted.**', '', '### Added', '', '- **Sync:** `GET /api/spaces` answers `404` for none.',
  '- **Sync:** `space_stats` counts what a reader sees.', ...entries, ''].join('\n');

describe('the release cut holds the mechanism rule', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'release-cut-')); });
  after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

  /** Run the notes program over a planted changelog; `{ status, stdout, stderr }`, never throwing on a refusal. */
  const cut = (changelog, version = '6.9.9') => {
    writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
    const out = join(dir, 'notes.md');
    rmSync(out, { force: true });
    try {
      execFileSync(process.execPath, [NOTES, version, out], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { status: 0, out: readFileSync(out, 'utf8') };
    } catch (e) {
      return { status: e.status, stderr: String(e.stderr), out: existsSync(out) ? readFileSync(out, 'utf8') : null };
    }
  };

  it('cuts a clean section as before', () => {
    const r = cut(section('6.9.9'));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.out, /`space_stats` counts what a reader sees/);
  });

  it('refuses a release whose section names a mechanism, names the line, and writes no notes', () => {
    const r = cut(section('6.9.9', '- **RDF:** a journal in `<space>_rdf_dirty` is brought into the index.'));
    assert.equal(r.status, 1);
    assert.equal(r.out, null, 'notes were written for a section that names a mechanism');
    assert.match(r.stderr, /name an internal mechanism/);
    assert.match(r.stderr, /CHANGELOG\.md:13 {2}\[6\.9\.9\] {2}"journal" is/);
    assert.match(r.stderr, /"<space>_rdf_dirty" is a collection a space owns/);
  });

  it('does not look at a release up to 6.5.7, which stays as published', () => {
    const r = cut(section('6.5.7', '- **RDF:** a journal in `<space>_rdf_dirty` is brought into the index.'), '6.5.7');
    assert.equal(r.status, 0, r.stderr);
  });
});

describe('the release gate asks the same module', () => {
  const code = stripComments(readFileSync('scripts/release-gate.mjs', 'utf8'));
  const notes = stripComments(readFileSync('scripts/release-notes.mjs', 'utf8'));

  it('release-gate.mjs imports the rule and the code-derived names, and fails the changelog gate with the description', () => {
    assert.match(code, /import \{[^}]*\bchangelogMechanisms\b[^}]*\bdescribeMechanisms\b[^}]*\} from '\.\/_changelog-mechanisms\.mjs'/);
    assert.match(code, /import \{ codeSurfaces \} from '\.\/_changelog-surfaces\.mjs'/);
    assert.match(code, /changelogMechanisms\(text, codeSurfaces\(\)\)/);
    assert.match(code, /fail\('changelog', describeMechanisms\(/);
  });

  it('release-notes.mjs asks the same two modules for the section it cuts', () => {
    assert.match(notes, /from '\.\/_changelog-mechanisms\.mjs'/);
    assert.match(notes, /from '\.\/_changelog-surfaces\.mjs'/);
    assert.match(notes, /changelogMechanisms\(/);
  });
});
