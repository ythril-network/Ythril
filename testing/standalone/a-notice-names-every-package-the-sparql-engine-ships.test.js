/**
 * NOTICE and `docs/dependencies.md` name every package in the production closure of the SPARQL engine (`@comunica/query-sparql-rdfjs`),
 * and every licence in it may ship (bundle-271, Q-756; design §1.4, r2 R7).
 *
 * ## Why the closure
 *
 * The engine is one dependency that pulls about 440 packages into the image, each with its own copyright and licence terms. The gate reads
 * the closure out of `package-lock.json` (`productionClosure`), never from a list here, with a floor.
 *
 * ## The licence forms this closure has, each judged by `licenceVerdict` (`_notice-closure.mjs`)
 *
 * - `negotiate` declares a `licenses` array (`FreeBSD`), which the lock does not record: the installed `package.json` is read;
 * - `BlueOak-1.0.0` is permissive;
 * - `spark-md5` is `(WTFPL OR MIT)`: a choice, admitted only with the election NOTICE records (MIT), which `docs/dependencies.md` states too;
 * - an optional package limited to another system (`fsevents`) is never installed in the image and is left out.
 *
 * The forms are planted below as lock records, so the judge is seen to refuse what it must before it is trusted with the closure.
 *
 * ## Seen red
 *
 * On 2bfffd806: the server does not depend on the engine and the lock holds no closure. Mutation (seen red once it does): the `spark-md5`
 * election removed from NOTICE.
 *
 * Run: node --test testing/standalone/a-notice-names-every-package-the-sparql-engine-ships.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  productionClosure, packagesOf, missingFromNotice, licenceOfRecord, licenceVerdict, electionIn, installedOnLinux,
} from './_notice-closure.mjs';

const ENGINE = '@comunica/query-sparql-rdfjs';
const lock = packagesOf(readFileSync('package-lock.json', 'utf8'));
const server = JSON.parse(readFileSync('server/package.json', 'utf8'));
const notice = readFileSync('NOTICE', 'utf8');
const dependenciesDoc = readFileSync('docs/dependencies.md', 'utf8');

/** The closure as the image has it: optional packages for another system left out. */
const closure = () => productionClosure(lock, ENGINE).filter(p => installedOnLinux(lock[p.key]));

/** The licence of a closure package: the lock's, or the installed `package.json`'s where the lock records none (a `licenses` array). */
const licenceOf = (pkg) => {
  if (pkg.license) return pkg.license;
  const file = `${pkg.key}/package.json`;
  return existsSync(file) ? licenceOfRecord(JSON.parse(readFileSync(file, 'utf8'))) : null;
};

describe('the licence judge, before it is trusted with the closure', () => {
  const MIT_ELECTED = '### spark-md5\n\nLicense: WTFPL OR MIT. Ythril elects the MIT License.\n\n### next\n';
  for (const [what, record, noticeText, ok] of [
    ['a licenses array (FreeBSD)', { licenses: [{ type: 'FreeBSD', url: 'licence.txt' }] }, '', true],
    ['BlueOak-1.0.0', { license: 'BlueOak-1.0.0' }, '', true],
    ['a license object', { license: { type: 'MIT' } }, '', true],
    ['a choice with the MIT election', { license: '(WTFPL OR MIT)' }, MIT_ELECTED, true],
    ['a choice with no election', { license: '(WTFPL OR MIT)' }, '### spark-md5\n\nLicense: WTFPL OR MIT.\n', false],
    ['a choice whose election is not offered', { license: '(WTFPL OR MIT)' }, MIT_ELECTED.replace('MIT License', 'Apache License'), false],
    ['an election in the next entry, not this one', { license: '(WTFPL OR MIT)' }, '### spark-md5\n\nLicense: WTFPL OR MIT.\n\n### other\n\nYthril elects the MIT License.\n', false],
    ['a copyleft licence', { license: 'GPL-3.0-only' }, '', false],
    ['an AND', { license: '(MIT AND GPL-3.0-only)' }, '', false],
    ['no licence at all', {}, '', false],
  ]) {
    it(`${what}: ${ok ? 'may ship' : 'is refused'}`, () => {
      const verdict = licenceVerdict(licenceOfRecord(record), electionIn(noticeText, 'spark-md5'));
      assert.equal(verdict.ok, ok, JSON.stringify(verdict));
    });
  }
  it('an optional package for another system is not installed on Linux; one for every system is', () => {
    assert.equal(installedOnLinux({ optional: true, os: ['darwin'] }), false);
    assert.equal(installedOnLinux({ optional: true, os: ['!win32'] }), true);
    assert.equal(installedOnLinux({ optional: true }), true);
    assert.equal(installedOnLinux({}), true);
  });
});

describe('everything the SPARQL engine ships is attributed and may ship', () => {
  it('the server depends on the engine at an exact version', () => {
    assert.equal(server.dependencies?.[ENGINE], '5.5.0', `server/package.json does not pin ${ENGINE} to 5.5.0`);
  });

  it('the closure is found (a floor, so a broken walk is not a clean one)', () => {
    const names = closure().map(c => c.name);
    assert.ok(names.length >= 300, `only ${names.length} packages`);
    for (const expected of [ENGINE, '@comunica/core', '@comunica/actor-query-parse-sparql', '@traqula/parser-sparql-1-2', 'spark-md5', 'negotiate']) {
      assert.ok(names.includes(expected), `${expected} is not in the closure`);
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

  it('every licence in the closure may ship: permissive, or a choice whose permissive arm NOTICE elects', () => {
    const bad = closure()
      .map(c => ({ ...c, verdict: licenceVerdict(licenceOf(c), electionIn(notice, c.name)) }))
      .filter(c => !c.verdict.ok)
      .map(c => `${c.name}@${c.version}: ${c.verdict.why}`);
    assert.deepEqual(bad, [], 'a licence in the closure may not ship as recorded (run npm ci when the lock records none)');
  });

  it('the spark-md5 election is MIT in NOTICE and in docs/dependencies.md', () => {
    assert.equal(electionIn(notice, 'spark-md5'), 'MIT', 'NOTICE does not record Ythril electing the MIT License for spark-md5');
    assert.match(dependenciesDoc, /\|\s*`spark-md5`\s*\|\s*`?\(?WTFPL OR MIT\)?`?\s*\|\s*MIT\s*\|/, 'docs/dependencies.md has no spark-md5 row electing MIT');
  });
});
