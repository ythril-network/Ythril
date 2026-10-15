/**
 * NOTICE names every package in the production closure of `@bufbuild/cel` (F-46, ruling R6-15).
 *
 * ## Why the closure and not the dependency
 *
 * `notice-coverage.test.js` asks about DIRECT dependencies and says why it stops there. This dependency is the case it cannot
 * carry: `@bufbuild/cel` ships no licence file of its own, its conformance data (`@bufbuild/cel-spec`, 2.6 MB of it in the image)
 * is derived from Google's `cel-spec` and `cel-go`, its protobuf runtime (`@bufbuild/protobuf`, Apache-2.0 AND BSD-3-Clause)
 * carries a BSD clause that names Google, and its regex engine (`@bufbuild/re2`, MIT) is a port with two copyright holders and an
 * upstream under a third. Each of those obligations travels with its own package, so the gate asks about every package the
 * engine pulls into production — read from the lock file, never listed here, with a floor.
 *
 * ## What it holds
 *
 * 1. the server declares `@bufbuild/cel`, at an EXACT version (the engine decides what a stored rule means; a caret range would let
 *    a patch release change a verdict on a record that was accepted yesterday — `docs/decisions` records why);
 * 2. every package in its production closure is named, by its full scoped name, in a NOTICE heading;
 * 3. NOTICE carries the full text of the Apache License 2.0 whenever any of them is Apache-2.0 (the appendix boilerplate it has
 *    carried alone is not the licence, and `@bufbuild/cel`, `cel-spec` and `protobuf` ship no licence file to supply it).
 *
 * ## Expected red, and what it is red about
 *
 * The dependency is not added yet, so the first assertion fails: `@bufbuild/cel` is in neither `server/package.json` nor the lock.
 * The rest of the file asks questions that need the lock entry and says so rather than passing over nothing. The closure walker
 * is proved on fixtures (a hoisted dependency, a nested one, an optional one, a development-only one), so a green result on the
 * real lock means what it says; and the gate is seen red by removing a package from a fixture NOTICE, the newly covered part.
 *
 * Run: node --test testing/standalone/a-notice-names-every-package-the-rule-engine-ships.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { productionClosure, packagesOf, missingFromNotice, noticeHeadingNames } from './_notice-closure.mjs';

const ENGINE = '@bufbuild/cel';
const APACHE_TEXT = 'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION';

describe('the closure walker (proved on fixtures, so the real answer means what it says)', () => {
  const lock = {
    '': { name: 'ythril' },
    server: { name: 'server', dependencies: { engine: '1.0.0' } },
    'node_modules/engine': { version: '1.0.0', license: 'Apache-2.0', dependencies: { hoisted: '^1', '@scope/nested': '^2' }, optionalDependencies: { native: '^1' }, peerDependencies: { peer: '^1' } },
    'node_modules/hoisted': { version: '1.2.0', license: 'MIT' },
    'node_modules/engine/node_modules/@scope/nested': { version: '2.0.0', license: 'MIT', dependencies: { deep: '^1' } },
    'node_modules/@scope/nested': { version: '9.9.9', license: 'MIT' },
    'node_modules/engine/node_modules/@scope/nested/node_modules/deep': { version: '1.0.0', license: 'MIT' },
    'node_modules/native': { version: '1.0.0', license: 'MIT', optional: true },
    'node_modules/peer': { version: '1.0.0', license: 'ISC' },
    'node_modules/build-only': { version: '1.0.0', license: 'MIT', dev: true },
  };
  const NAMES = ['engine', 'hoisted', '@scope/nested', 'native', 'peer', 'deep'];

  it('follows dependencies, optional dependencies and peers, takes the nested copy that ships, and leaves a development-only package out', () => {
    const closure = productionClosure(lock, 'engine');
    assert.deepEqual(closure.map(c => c.name).sort(), [...NAMES].sort());
    assert.equal(closure.find(c => c.name === '@scope/nested').version, '2.0.0', 'the hoisted copy was taken where a nested one ships');
    assert.ok(!closure.some(c => c.name === 'build-only'));
  });

  it('refuses an entry that is not in the lock instead of returning an empty closure', () => {
    assert.throws(() => productionClosure(lock, 'absent'), /not in the lock file/);
  });

  it('names a package only by a heading that carries its full scoped name, alone or in a list', () => {
    const notice = `## Bundled Components\n\n### engine, hoisted\n\ntext about native and peer and deep\n\n#### @scope/nested\n\n### \`native\`\n`;
    assert.deepEqual([...noticeHeadingNames(notice)].sort(), ['@scope/nested', 'engine', 'hoisted', 'native']);
    // The gate, seen RED: peer and deep appear in a body sentence and in no heading, so they are not named.
    assert.deepEqual(missingFromNotice(NAMES, notice).sort(), ['deep', 'peer']);
    assert.deepEqual(missingFromNotice(NAMES, `${notice}\n### peer\n\n### deep\n`), []);
    // A bare name is not the scoped one.
    assert.deepEqual(missingFromNotice(['@scope/nested'], '### nested\n'), ['@scope/nested']);
  });
});

describe('the rule engine and everything it ships is attributed', () => {
  const server = JSON.parse(readFileSync('server/package.json', 'utf8'));
  const notice = readFileSync('NOTICE', 'utf8');

  it('the server depends on @bufbuild/cel, at an exact version', () => {
    const range = server.dependencies?.[ENGINE];
    assert.ok(range, `server/package.json does not depend on ${ENGINE}: the dependency F-46 is built on has not been added`);
    assert.match(range, /^\d+\.\d+\.\d+$/, `${ENGINE} is declared as '${range}': the engine decides what a stored rule means, so it is pinned exactly`);
  });

  it('the lock file holds it, and its production closure is found (a floor, so a broken walk is not a clean one)', () => {
    const closure = productionClosure(packagesOf(readFileSync('package-lock.json', 'utf8')), ENGINE);
    assert.ok(closure.length >= 4, `only ${closure.length} package(s) found in the closure of ${ENGINE} (${closure.map(c => c.name).join(', ')}): its spec data, protobuf runtime and regex engine are its own packages`);
  });

  it('every package in that closure is named by a NOTICE heading', () => {
    const closure = productionClosure(packagesOf(readFileSync('package-lock.json', 'utf8')), ENGINE);
    const missing = missingFromNotice(closure.map(c => c.name), notice);
    assert.deepEqual(missing, [],
      `NOTICE does not name: ${missing.join(', ')}. Each ships to users as part of the rule engine and carries its own copyright and licence terms.`);
  });

  it('NOTICE carries the full Apache License 2.0 when anything in the closure is Apache-2.0', () => {
    const closure = productionClosure(packagesOf(readFileSync('package-lock.json', 'utf8')), ENGINE);
    const apache = closure.filter(c => /Apache-2\.0/.test(c.license ?? ''));
    assert.ok(apache.length > 0, `none of ${closure.map(c => `${c.name} (${c.license})`).join(', ')} is Apache-2.0: the premise of this check moved`);
    assert.ok(notice.includes(APACHE_TEXT),
      `${apache.map(c => c.name).join(', ')} are Apache-2.0 and ship no licence file; NOTICE carries only the appendix boilerplate, not the licence ("${APACHE_TEXT}")`);
  });
});
