/**
 * NOTICE and `docs/dependencies.md` name every package in the production closure of the two RDF parsers, and every one is permissive
 * (bundle-270, slice S1; amendment A12).
 *
 * ## Why the closure and not the two dependencies
 *
 * `notice-coverage.test.js` asks about DIRECT dependencies. The import reads Turtle, TriG and N-Quads with `n3` and JSON-LD with
 * `jsonld-streaming-parser`; between them they pull in about twenty more packages into the image (the JSON-LD context parser, a
 * canonicalizer, a link-header parser, a data factory, a streaming JSON parser, the stream and buffer polyfills with their own children, and
 * the type packages that parser lists as runtime dependencies). Each carries its own copyright and licence terms, and `ieee754` is BSD-3-Clause
 * where the rest are MIT. The gate reads the closure out of `package-lock.json`, never from a list here, with a floor.
 *
 * ## What it holds
 *
 * 1. the server declares `n3` and `jsonld-streaming-parser` as dependencies, and the root does not keep `n3` as a development dependency
 *    (one declaration of what the server ships);
 * 2. every package of their production closure is named by a NOTICE heading (full name) and by `docs/dependencies.md` (in backticks);
 * 3. every licence in the closure, as the lock records it, is a permissive one: no copyleft, no unknown, no unlicensed;
 * 4. the installed copies agree with the lock where an install is present: each package's `package.json` names the licence the lock says.
 *
 * Run: node --test testing/standalone/a-notice-names-every-package-the-rdf-parsers-ship.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { productionClosure, packagesOf, missingFromNotice } from './_notice-closure.mjs';

const PARSERS = ['n3', 'jsonld-streaming-parser'];
const PERMISSIVE = /^(MIT|ISC|BSD-2-Clause|BSD-3-Clause|Apache-2\.0|0BSD)$/;

const lock = packagesOf(readFileSync('package-lock.json', 'utf8'));
const server = JSON.parse(readFileSync('server/package.json', 'utf8'));
const root = JSON.parse(readFileSync('package.json', 'utf8'));
const notice = readFileSync('NOTICE', 'utf8');
const dependenciesDoc = readFileSync('docs/dependencies.md', 'utf8');

const closure = () => {
  const seen = new Map();
  for (const name of PARSERS) for (const pkg of productionClosure(lock, name)) seen.set(pkg.key, pkg);
  return [...seen.values()];
};

/** The licence an installed package declares, or undefined when it is not installed. */
const installedLicense = (pkg) => {
  const file = `${pkg.key}/package.json`;
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).license : undefined;
};

describe('the two RDF parsers are declared once, by the server', () => {
  for (const name of PARSERS) {
    it(`the server depends on ${name}`, () => {
      assert.ok(server.dependencies?.[name], `server/package.json does not depend on ${name}`);
      assert.ok(!server.devDependencies?.[name], `${name} is a development dependency of the server as well`);
    });
  }
  it('the root does not keep n3 as a development dependency', () => {
    assert.ok(!root.devDependencies?.n3, 'package.json (the root) still lists n3 under devDependencies: it is a server dependency now');
  });
});

describe('everything the two parsers ship is attributed and permissive', () => {
  it('the closure is found (a floor, so a broken walk is not a clean one)', () => {
    const names = closure().map(c => c.name);
    assert.ok(names.length >= 15, `only ${names.length} packages (${names.join(', ')})`);
    for (const expected of ['n3', 'jsonld-streaming-parser', 'jsonld-context-parser', 'canonicalize', 'readable-stream', 'buffer', 'ieee754']) {
      assert.ok(names.includes(expected), `${expected} is not in the closure: ${names.join(', ')}`);
    }
  });
  it('every package of the closure is named by a NOTICE heading', () => {
    const missing = missingFromNotice(closure().map(c => c.name), notice);
    assert.deepEqual(missing, [], `NOTICE does not name: ${missing.join(', ')}`);
  });
  it('every package of the closure is named in docs/dependencies.md', () => {
    const missing = closure().map(c => c.name).filter(name => !dependenciesDoc.includes(`\`${name}\``));
    assert.deepEqual(missing, [], `docs/dependencies.md does not name: ${missing.join(', ')}`);
  });
  it('every licence in the closure is permissive, as the lock records it or, where an older lock entry records none, as the installed package does', () => {
    const bad = closure()
      .map(c => ({ ...c, license: c.license ?? installedLicense(c) }))
      .filter(c => !PERMISSIVE.test(c.license ?? ''))
      .map(c => `${c.name}@${c.version} (${c.license})`);
    assert.deepEqual(bad, [], `not permissive, or recorded nowhere (run npm ci): ${bad.join(', ')}`);
  });
  it('an installed package says the licence the lock says', () => {
    const checked = [];
    for (const pkg of closure()) {
      const installed = installedLicense(pkg);
      if (installed === undefined || pkg.license === null) continue;
      assert.equal(installed, pkg.license, `${pkg.name}: the lock says ${pkg.license}, the installed package ${installed}`);
      checked.push(pkg.name);
    }
    if (existsSync('node_modules/n3/package.json')) assert.ok(checked.length >= 12, `only ${checked.length} installed packages were read`);
  });
});
