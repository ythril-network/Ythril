/**
 * `schema/NOTICE` names every package the schema package pulls into production, read from the lock file (Q-668, B1).
 *
 * ## The defect this prevents
 *
 * The package an outside app installs is Apache-2.0 with its own NOTICE (owner, 2026-11-01). What that NOTICE must name is not the
 * package's two direct dependencies: `@bufbuild/cel` brings `@bufbuild/cel-spec` (derived from Google's), `@bufbuild/re2` (a port with
 * two copyright holders) and `@bufbuild/protobuf` (Apache-2.0 AND BSD-3-Clause, a clause naming Google). A NOTICE written from
 * `schema/package.json` misses three of five, and the obligation travels with each one.
 *
 * ## Why the walk starts at the workspace key
 *
 * The first design walked from the package's own `node_modules` entry, and the second reader found it vacuous: that lock entry is a LINK
 * (`{ resolved: 'schema', link: true }`) with no dependencies, so the closure was the package alone and every NOTICE passed. The walk
 * starts at the workspace's own key, `schema`, and a floor of five packages fails a walk that found nothing.
 *
 * The gate is one of the release gate's NOTICE gates, so a tag cannot go out with the package's NOTICE short.
 *
 * Run: node --test testing/standalone/the-schema-package-notice-names-its-production-closure.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packagesOf, workspaceClosure, productionClosure, missingFromNotice } from './_notice-closure.mjs';
import { stripComments } from './_strip-comments.mjs';
import { balancedFrom } from './_structural-window.mjs';

/** The workspace whose closure is read, by its lock key, and the least a working walk finds there. */
const WORKSPACE = 'schema';
const FLOOR = 5;
const THIS_GATE = basename(fileURLToPath(import.meta.url)).replace(/\.test\.js$/, '');

describe('the workspace walk (proved on a fixture, so the real answer means what it says)', () => {
  const lock = {
    '': { name: 'root' },
    pkg: { name: '@x/pkg', dependencies: { engine: '1.0.0' }, devDependencies: { tool: '1' } },
    'node_modules/@x/pkg': { resolved: 'pkg', link: true },
    'node_modules/engine': { version: '1.0.0', license: 'Apache-2.0', dependencies: { child: '^1' } },
    'node_modules/child': { version: '1.0.0', license: 'MIT' },
    'node_modules/tool': { version: '1.0.0', license: 'MIT', dev: true },
  };

  it('walks from the workspace key, leaves the workspace and its development tools out', () => {
    assert.deepEqual(workspaceClosure(lock, 'pkg').map(p => p.name).sort(), ['child', 'engine']);
  });

  it('the link entry is the vacuous start B1 found: it reaches only itself, and the workspace walk refuses it', () => {
    assert.deepEqual(productionClosure(lock, '@x/pkg', '').map(p => p.name), ['@x/pkg']);
    assert.throws(() => workspaceClosure(lock, 'node_modules/@x/pkg'), /is a link/);
    assert.throws(() => workspaceClosure(lock, 'absent'), /not in the lock file/);
  });

  it('a NOTICE missing one package of the closure is caught (the planted copy)', () => {
    const names = workspaceClosure(lock, 'pkg').map(p => p.name);
    assert.deepEqual(missingFromNotice(names, '### engine\n\nchild is mentioned in a sentence\n'), ['child']);
    assert.deepEqual(missingFromNotice(names, '### engine\n\n### child\n'), []);
  });
});

describe('schema/NOTICE names the package\'s production closure', () => {
  const closure = workspaceClosure(packagesOf(readFileSync('package-lock.json', 'utf8')), WORKSPACE);

  it(`the walk found the closure (at least ${FLOOR} packages), so the check below is not about nothing`, () => {
    assert.ok(closure.length >= FLOOR,
      `the '${WORKSPACE}' workspace pulls only ${closure.length} package(s) into production: ${closure.map(p => p.name).join(', ')}`);
  });

  it('every package of it is named by a NOTICE heading', () => {
    assert.ok(existsSync('schema/NOTICE'), 'schema/NOTICE is committed (the package ships its own, not a copy of the root\'s)');
    const missing = missingFromNotice(closure.map(p => p.name), readFileSync('schema/NOTICE', 'utf8'));
    assert.deepEqual(missing, [], `schema/NOTICE names none of: ${missing.join(', ')}`);
  });

  it('the release gate runs this gate among its NOTICE gates', () => {
    const gate = stripComments(readFileSync('scripts/release-gate.mjs', 'utf8'));
    const at = gate.indexOf('const NOTICE_GATES');
    assert.ok(at >= 0, 'scripts/release-gate.mjs declares no NOTICE_GATES: re-anchor this gate');
    const list = balancedFrom(gate, gate.indexOf('[', at), 'NOTICE_GATES');
    const names = [...list.matchAll(/\[\s*'([^']+)'\s*,/g)].map(m => m[1]);
    assert.ok(names.length >= 3, `read only ${names.length} gate(s) from NOTICE_GATES: the parse is broken`);
    assert.ok(names.includes(THIS_GATE), `NOTICE_GATES lists ${names.join(', ')}, not ${THIS_GATE}`);
  });
});
