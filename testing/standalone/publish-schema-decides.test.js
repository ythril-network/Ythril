/**
 * `scripts/publish-schema.mjs` decides, as a pure function, whether a tag publishes the schema package to npm, and with which
 * arguments (`publishDecision`, bundle-225, Q-683, design C).
 *
 * ## The rule this holds
 *
 * `publishDecision({ npmVersion, env, registry, versionDoc, version, tag, tags, pack })` returns
 * `{ action: 'skip' | 'publish' | 'refuse', argv?, level, message }` and touches nothing. Every branch the job can take is a
 * row here: each refusal, each registry answer, the argv per dist-tag, the npm floor (numeric, 11.5.1), the packed file list,
 * the recorded commit of an already-published version. The effects around it (the registry read, `npm -v`, `npm pack`,
 * `npm publish`) only gather its inputs and carry out its answer.
 *
 * ## The defect it prevents (Q-683)
 *
 * A published npm version can never be republished or replaced. The job that publishes it runs with an OIDC token that can
 * publish ANY version of the package, so what it does on a tag must be right the first time:
 *
 *  - an old npm cannot do trusted publishing and falls back to an ambient token, which the job must not have (refuse);
 *  - a token in the environment (`NODE_AUTH_TOKEN`, `NPM_TOKEN`, an `npm_config_*auth*` key) would be used INSTEAD of the OIDC
 *    exchange, and an OIDC job that ran on a stolen token proves nothing about provenance (refuse, naming the key, never the value);
 *  - a tarball without LICENSE or NOTICE (or with either empty) ships Apache-2.0 §4(d) unmet to a public registry for good
 *    (refuse; the same rule `publish.yml` holds for the image: the artefact is verified, not the instruction);
 *  - a tag whose version is already on npm is skipped, but only when the recorded `gitHead` is the tag's commit: "present" proves a
 *    number exists, not that this tag made it (refuse on a mismatch);
 *  - a backfilled older line or a prerelease must never take npm's `latest` backwards or onto a candidate (`--tag release-6.4`,
 *    `--tag next`), and "highest" is the one rule the GitHub Release uses (`release-tags.mjs`), not a second copy;
 *  - a 404 means "no such package": expected once (the hand publish of 6.5.0, `FIRST_NPM_VERSION`, warning and skip, because the
 *    trusted publisher can only be configured on a package that exists) and a loud failure every time after;
 *  - anything the registry says that is not understood (a malformed body, an oversize body, a 5xx, a network error) refuses: a
 *    guess here is a publish or a skip nobody asked for.
 *
 * ## The failure that bought it
 *
 * The first design held these as a prose list over a script with no seam: six branches that only a live registry could exercise,
 * in the one step that cannot be undone. The challenge round found three of them wrong before any code existed (a setup-node
 * `.npmrc` token that the refusal would have rejected on every run, a prerelease moving `latest`, a stale first-publish skip that
 * would stay green forever), so the branches are tested as a table.
 *
 * ## Choices the rows fix where the design left a detail open
 *
 *  - `registry` and `versionDoc` are `{ status, body }` with `body` the decoded text; a failed read is `{ error }` (the Error the
 *    fetch or `readCappedBody` threw: a `TypeError` for the network, `BodyTooLargeError` for the cap), `status` absent or 200.
 *  - `versionDoc` is the version manifest the script fetched because the version is present; it is absent when the version is not.
 *  - `pack` is the file list of `npm pack --dry-run --json` (`[{ path, size }]`), and `path` is relative to the package root.
 *  - A refusal's `level` is `error`, the first-publish skip's is `warning`, a skip and a publish are `notice`.
 *  - An unreadable `npmVersion` refuses (it cannot be shown to be 11.5.1 or later). A present version with no `GITHUB_SHA` to
 *    compare refuses. A recorded `gitHead` that is absent from the version manifest differs from the tag's commit.
 *  - A refusal's message carries the subject (the env KEY, never its value; the file; the version; the error's own text).
 *
 * Importing the script must not run it: no network, no child process, no exit. A child process proves it below.
 *
 * Run: node --test testing/standalone/publish-schema-decides.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { publishDecision } from '../../scripts/publish-schema.mjs';
import { BodyTooLargeError } from '../../scripts/_shared/capped-body.mjs';
import { stripComments } from './_strip-comments.mjs';

const ROOT = process.cwd();
const SCRIPT = 'scripts/publish-schema.mjs';

/** The package's own name, read from its manifest: this file never spells it, so a rename cannot leave it quiet. */
const NAME = JSON.parse(readFileSync(join(ROOT, 'schema/package.json'), 'utf8')).name;
assert.equal(typeof NAME, 'string', 'schema/package.json has no name');

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';

/** The abbreviated registry document (`Accept: application/vnd.npm.install-v1+json`): name, dist-tags, versions. */
const registryDoc = (versions, distTags = { latest: versions[versions.length - 1] }) => JSON.stringify({
  name: NAME,
  'dist-tags': distTags,
  versions: Object.fromEntries(versions.map((v) => [v, { name: NAME, version: v }])),
});
const ok = (body) => ({ status: 200, body });
const versionManifest = (over = {}) => ok(JSON.stringify({ name: NAME, version: '6.5.0', gitHead: SHA, ...over }));

const GOOD_PACK = [
  { path: 'LICENSE', size: 10349 },
  { path: 'NOTICE', size: 2543 },
  { path: 'README.md', size: 19489 },
  { path: 'dist/index.js', size: 2066 },
  { path: 'dist/index.d.ts', size: 900 },
  { path: 'package.json', size: 1300 },
];

/** A run that publishes 6.5.0 as the highest release: the decision every row changes ONE thing about. */
const input = (over = {}) => ({
  npmVersion: '11.10.0',
  env: { GITHUB_ACTIONS: 'true', GITHUB_SHA: SHA, PATH: '/usr/bin' },
  registry: ok(registryDoc(['6.4.0'])),
  versionDoc: undefined,
  version: '6.5.0',
  tag: 'v6.5.0',
  tags: ['v6.3.0', 'v6.4.0', 'v6.5.0'],
  pack: GOOD_PACK,
  ...over,
});
const withEnv = (extra) => ({ env: { ...input().env, ...extra } });
const decide = (over) => publishDecision(input(over));

/** A refusal: its action, its level, no argv, and a message that names `subject`. */
function assertRefuses(decision, subject, why) {
  assert.equal(decision.action, 'refuse', `${why}: expected a refusal, got ${JSON.stringify(decision)}`);
  assert.equal(decision.level, 'error', `${why}: a refusal is reported at level error`);
  assert.equal(decision.argv, undefined, `${why}: a refusal carries no argv, or a caller could run it`);
  assert.equal(typeof decision.message, 'string', `${why}: a refusal carries its message`);
  if (subject) {
    const needles = [].concat(subject);
    for (const n of needles) {
      assert.ok(typeof n === 'string' ? decision.message.includes(n) : n.test(decision.message),
        `${why}: the message does not name ${n}: ${JSON.stringify(decision.message)}`);
    }
  }
}

describe('publishDecision: the registry answers (npm is new enough, the pack is whole, the environment is clean)', () => {
  it('the version is absent from a package that exists: publish, with no tag argument when it is the highest release', () => {
    const d = decide({ registry: ok(registryDoc(['6.3.0', '6.4.0'])) });
    assert.equal(d.action, 'publish');
    assert.equal(d.level, 'notice');
    assert.deepEqual(d.argv, ['publish', '-w', NAME]);
    assert.ok(d.message.includes('6.5.0'), `the message does not name the version: ${d.message}`);
  });

  it('the document\'s own dist-tags are never read: none, or a wrong one, changes nothing', () => {
    const noTags = JSON.stringify({ name: NAME, versions: { '6.4.0': {} } });
    assert.deepEqual(decide({ registry: ok(noTags) }).argv, ['publish', '-w', NAME]);
    const wrong = registryDoc(['6.4.0'], { latest: '9.9.9' });
    assert.deepEqual(decide({ registry: ok(wrong) }).argv, ['publish', '-w', NAME],
      '"latest" is decided by the git tags (release-tags.mjs), so a registry that says 9.9.9 cannot move it');
  });

  it('the version is present and its recorded gitHead is this tag\'s commit: skip, and never an argv', () => {
    const d = decide({ registry: ok(registryDoc(['6.4.0', '6.5.0'])), versionDoc: versionManifest() });
    assert.equal(d.action, 'skip');
    assert.equal(d.level, 'notice');
    assert.equal(d.argv, undefined);
    assert.ok(d.message.includes('6.5.0'), `the message does not name the version: ${d.message}`);
  });

  it('the version is present and its gitHead is ANOTHER commit: refuse, naming both', () => {
    const d = decide({ registry: ok(registryDoc(['6.5.0'])), versionDoc: versionManifest({ gitHead: OTHER_SHA }) });
    assertRefuses(d, [OTHER_SHA, SHA], 'a present version published from another commit');
  });

  it('the version is present and records no gitHead (a hand publish from a dirty or untagged tree): refuse', () => {
    const doc = ok(JSON.stringify({ name: NAME, version: '6.5.0' }));
    assertRefuses(decide({ registry: ok(registryDoc(['6.5.0'])), versionDoc: doc }), [SHA], 'no recorded commit');
  });

  it('the version is present and the run has no GITHUB_SHA to compare: refuse rather than skip on trust', () => {
    const env = { GITHUB_ACTIONS: 'true', PATH: '/usr/bin' };
    assertRefuses(decide({ env, registry: ok(registryDoc(['6.5.0'])), versionDoc: versionManifest() }), ['GITHUB_SHA'], 'no sha');
  });

  for (const [what, versionDoc, subject] of [
    ['a malformed body', ok('<html>502 Bad Gateway</html>'), /version/i],
    ['an empty body', ok(''), /version/i],
    ['a 404 (the registry lists the version, the manifest is gone)', { status: 404, body: '{}' }, /version/i],
    ['a 500', { status: 500, body: '' }, ['500']],
    ['a network error', { error: new TypeError('fetch failed') }, ['fetch failed']],
    ['an oversize body', { error: new BodyTooLargeError(5 * 1024 * 1024) }, [new BodyTooLargeError(5 * 1024 * 1024).message]],
  ]) {
    it(`the version is present and its manifest read gives ${what}: refuse`, () => {
      assertRefuses(decide({ registry: ok(registryDoc(['6.5.0'])), versionDoc }), subject, `a version manifest read of ${what}`);
    });
  }

  it('a 404 for the first npm version (6.5.0): a warning and a skip, because the trusted publisher exists only on a package that does', () => {
    const d = decide({ registry: { status: 404, body: '{"error":"Not found"}' } });
    assert.equal(d.action, 'skip');
    assert.equal(d.level, 'warning');
    assert.equal(d.argv, undefined);
    assert.ok(d.message.includes('6.5.0'), `the message does not name the version: ${d.message}`);
  });

  for (const [version, tag] of [['6.5.1', 'v6.5.1'], ['6.6.0', 'v6.6.0'], ['7.0.0', 'v7.0.0'], ['6.4.0', 'v6.4.0'], ['6.5.0-rc.1', 'v6.5.0-rc.1']]) {
    it(`a 404 for ${version} (not the first npm version): refuse, naming the first publish`, () => {
      const d = decide({ version, tag, tags: ['v6.4.0', tag], registry: { status: 404, body: '{"error":"Not found"}' } });
      assertRefuses(d, [/first publish/i, version], `a package that should exist since 6.5.0 is missing at ${version}`);
    });
  }

  for (const status of [301, 302, 400, 401, 403, 408, 410, 429, 500, 502, 503, 504, 204, 201, 100]) {
    it(`status ${status}: refuse, naming it (only 200 and the 404 above are understood)`, () => {
      assertRefuses(decide({ registry: { status, body: registryDoc(['6.4.0']) } }), [String(status)], `status ${status}`);
    });
  }

  for (const [what, body] of [
    ['text that is not JSON', 'Service Unavailable'],
    ['an HTML page', '<html><body>502</body></html>'],
    ['an empty body', ''],
    ['a truncated document', registryDoc(['6.4.0']).slice(0, 40)],
    ['JSON null', 'null'],
    ['a JSON array', '[]'],
    ['a JSON string', '"6.5.0"'],
    ['a JSON number', '200'],
    ['an object with no versions', JSON.stringify({ name: NAME, 'dist-tags': { latest: '6.4.0' } })],
    ['versions that are not an object (a string)', JSON.stringify({ name: NAME, versions: '6.4.0' })],
    ['versions that are not an object (an array)', JSON.stringify({ name: NAME, versions: ['6.4.0'] })],
    ['versions null', JSON.stringify({ name: NAME, versions: null })],
  ]) {
    it(`a malformed body at status 200 (${what}): refuse, never read as "absent" and published`, () => {
      assertRefuses(decide({ registry: ok(body) }), [/registry|body|document|malformed|json/i], `a body of ${what}`);
    });
  }

  it('a body over the cap: refuse, with the oversize error\'s own text, never read as absent', () => {
    const error = new BodyTooLargeError(5 * 1024 * 1024);
    assertRefuses(decide({ registry: { status: 200, error } }), [error.message], 'an oversize body at status 200');
    assertRefuses(decide({ registry: { error } }), [error.message], 'an oversize body with no status');
  });

  it('a network error: refuse, with the error\'s own text, never read as "package missing"', () => {
    const error = new TypeError('fetch failed');
    assertRefuses(decide({ registry: { error } }), [error.message], 'a network error');
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    assertRefuses(decide({ registry: { error: timeout } }), [timeout.message], 'a timeout');
  });
});

describe('publishDecision: the npm dist-tag argument (never "latest" by name, never a prerelease or an older line on it)', () => {
  const ROWS = [
    ['the highest release', '6.5.0', 'v6.5.0', ['v6.4.0', 'v6.5.0'], ['publish', '-w', NAME]],
    ['the only release', '6.5.0', 'v6.5.0', ['v6.5.0'], ['publish', '-w', NAME]],
    ['6.10.0 above 6.9.0 (numeric order)', '6.10.0', 'v6.10.0', ['v6.9.0', 'v6.10.0'], ['publish', '-w', NAME]],
    ['a release with a prerelease of a later version in the list', '6.9.0', 'v6.9.0', ['v6.9.0', 'v7.0.0-rc.1'], ['publish', '-w', NAME]],
    ['a prerelease', '6.6.0-rc.1', 'v6.6.0-rc.1', ['v6.5.0', 'v6.6.0-rc.1'], ['publish', '-w', NAME, '--tag', 'next']],
    ['a prerelease above every release', '7.0.0-beta.1', 'v7.0.0-beta.1', ['v6.9.0', 'v7.0.0-beta.1'], ['publish', '-w', NAME, '--tag', 'next']],
    ['a prerelease of an older line is still next, not the line', '6.4.1-rc.1', 'v6.4.1-rc.1', ['v6.4.0', 'v6.5.0', 'v6.4.1-rc.1'], ['publish', '-w', NAME, '--tag', 'next']],
    ['a backfilled patch of an older minor', '6.4.1', 'v6.4.1', ['v6.4.0', 'v6.4.1', 'v6.5.0'], ['publish', '-w', NAME, '--tag', 'release-6.4']],
    ['a backfill of an older major', '5.9.9', 'v5.9.9', ['v5.9.9', 'v6.5.0'], ['publish', '-w', NAME, '--tag', 'release-5.9']],
    ['6.9.1 while 6.10.0 exists (the line is 6.9, not 6.10)', '6.9.1', 'v6.9.1', ['v6.9.1', 'v6.10.0'], ['publish', '-w', NAME, '--tag', 'release-6.9']],
    ['an older release of a two-digit minor', '6.10.2', 'v6.10.2', ['v6.10.2', 'v6.11.0'], ['publish', '-w', NAME, '--tag', 'release-6.10']],
    ['a tag list that does not contain the tag never claims latest', '6.5.0', 'v6.5.0', [], ['publish', '-w', NAME, '--tag', 'release-6.5']],
  ];
  for (const [what, version, tag, tags, argv] of ROWS) {
    it(`${what}: ${argv.slice(3).join(' ') || 'no tag argument'}`, () => {
      const d = decide({ version, tag, tags, registry: ok(registryDoc(['6.4.0'])) });
      assert.equal(d.action, 'publish');
      assert.deepEqual(d.argv, argv);
      assert.ok(!d.argv.includes('latest'), 'the argv names "latest": that tag is npm\'s default, and naming it hides a backfill');
    });
  }
});

describe('publishDecision: npm must be 11.5.1 or later (trusted publishing), compared as numbers', () => {
  for (const [npmVersion, publishes] of [
    ['11.10.0', true], ['11.5.1', true], ['11.6.0', true], ['12.0.0', true], ['11.100.0', true], ['11.5.10', true],
    ['11.5.0', false], ['11.4.9', false], ['10.9.0', false], ['10.9.99', false], ['9.0.0', false], ['8.19.4', false],
  ]) {
    it(`npm ${npmVersion}: ${publishes ? 'publishes' : 'refuses, naming 11.5.1 and what it found'}`, () => {
      const d = decide({ npmVersion });
      if (publishes) {
        assert.equal(d.action, 'publish', `npm ${npmVersion} was refused: ${d.message}`);
      } else {
        assertRefuses(d, ['11.5.1', npmVersion], `npm ${npmVersion}`);
      }
    });
  }

  it('the compare is numeric: 11.10.0 is above 11.5.1 although "10" sorts below "5" as text', () => {
    assert.equal(decide({ npmVersion: '11.10.0' }).action, 'publish');
    assert.equal(decide({ npmVersion: '11.9.0' }).action, 'publish');
  });

  for (const npmVersion of ['', 'banana', undefined, null, '11', '11.5']) {
    it(`an npm version that cannot be read (${JSON.stringify(npmVersion)}): refuse`, () => {
      assertRefuses(decide({ npmVersion }), ['11.5.1'], `npm version ${JSON.stringify(npmVersion)}`);
    });
  }

  it('an old npm refuses before the registry is believed, a 404 included (it must not skip a first publish on a client that cannot publish)', () => {
    assertRefuses(decide({ npmVersion: '10.9.0', registry: { status: 404, body: '{}' } }), ['11.5.1'], 'old npm on a 404');
    assertRefuses(decide({ npmVersion: '11.5.0', registry: { error: new TypeError('fetch failed') } }), ['11.5.1'], 'old npm on a network error');
  });
});

describe('publishDecision: no token in the environment, because a token is used INSTEAD of the OIDC exchange', () => {
  const SECRET = 'npm_Zq9x8W7v6U5t4S3r2Q1p0O';
  const REFUSED = [
    'NODE_AUTH_TOKEN', 'NPM_TOKEN',
    'npm_config__authToken', 'NPM_CONFIG__AUTHTOKEN', 'npm_config__auth', 'npm_config_registry_authtoken',
    'npm_config_//registry.npmjs.org/:_authToken',
  ];
  for (const key of REFUSED) {
    it(`${key} set: refuse, naming the key and never the value`, () => {
      const d = decide(withEnv({ [key]: SECRET }));
      assertRefuses(d, [key], `${key} in the environment`);
      assert.ok(!d.message.includes(SECRET), `the message prints the token's value: ${d.message}`);
    });
  }

  for (const key of ['npm_config_loglevel', 'npm_config_cache', 'NPM_CONFIG_REGISTRY', 'npm_config_audit', 'npm_package_name', 'NODE_OPTIONS', 'GITHUB_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']) {
    it(`${key} set: not a token the job must refuse (the OIDC request token and the repo token are the runner's own)`, () => {
      assert.equal(decide(withEnv({ [key]: 'x' })).action, 'publish', `${key} was refused`);
    });
  }

  it('a token is refused before the registry is read, so no answer can excuse it', () => {
    assertRefuses(decide({ ...withEnv({ NODE_AUTH_TOKEN: SECRET }), registry: { status: 404, body: '{}' } }), ['NODE_AUTH_TOKEN'], 'token with a 404');
    assertRefuses(decide({ ...withEnv({ NPM_TOKEN: SECRET }), registry: ok(registryDoc(['6.5.0'])), versionDoc: versionManifest() }), ['NPM_TOKEN'], 'token with a present version');
  });
});

describe('publishDecision: the tarball carries LICENSE, NOTICE and dist/index.js, each with bytes', () => {
  const without = (file) => GOOD_PACK.filter((f) => f.path !== file);
  const emptied = (file) => GOOD_PACK.map((f) => (f.path === file ? { ...f, size: 0 } : f));

  for (const file of ['LICENSE', 'NOTICE', 'dist/index.js']) {
    it(`${file} missing from the pack list: refuse, naming it`, () => {
      assertRefuses(decide({ pack: without(file) }), [file], `${file} missing`);
    });
    it(`${file} at size 0: refuse, naming it`, () => {
      assertRefuses(decide({ pack: emptied(file) }), [file], `${file} empty`);
    });
  }

  it('the whole pack list: publish', () => {
    assert.equal(decide({ pack: GOOD_PACK }).action, 'publish');
  });

  it('a file of the same name in a subfolder is not the package\'s own LICENSE or NOTICE', () => {
    const pack = [{ path: 'docs/LICENSE', size: 10 }, { path: 'sub/NOTICE', size: 10 }, { path: 'dist/index.js', size: 10 }];
    const d = decide({ pack });
    assertRefuses(d, [/LICENSE/, /NOTICE/], 'LICENSE and NOTICE only below the root');
  });

  it('every missing file is named, not only the first', () => {
    assertRefuses(decide({ pack: [{ path: 'README.md', size: 5 }] }), ['LICENSE', 'NOTICE', 'dist/index.js'], 'nothing required is packed');
  });

  for (const [what, pack] of [['an empty list', []], ['no list', undefined], ['not a list', {}], ['a size that is missing', [{ path: 'LICENSE' }, { path: 'NOTICE', size: 1 }, { path: 'dist/index.js', size: 1 }]]]) {
    it(`${what}: refuse`, () => {
      assertRefuses(decide({ pack }), [], `the pack list is ${what}`);
    });
  }
});

describe('importing the script does not run it', () => {
  it('a child that imports it with fetch, every child-process call, http(s) and exit trapped records none of them', () => {
    const probe = `
      import { createRequire, syncBuiltinESMExports } from 'node:module';
      const require = createRequire(import.meta.url);
      const calls = [];
      const trap = (owner, name, label) => { owner[name] = () => { calls.push(label + '.' + name); throw new Error(label + '.' + name + ' ran on import'); }; };
      const cp = require('node:child_process');
      for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) trap(cp, k, 'child_process');
      for (const m of ['node:http', 'node:https']) for (const k of ['request', 'get']) trap(require(m), k, m);
      trap(require('node:net'), 'connect', 'node:net');
      globalThis.fetch = () => { calls.push('fetch'); throw new Error('fetch ran on import'); };
      process.exit = (code) => { calls.push('process.exit(' + code + ')'); throw new Error('exit ran on import'); };
      syncBuiltinESMExports();
      let mod; let failure = null;
      try { mod = await import(process.env.PROBE_TARGET); } catch (e) { failure = String(e && e.message || e); }
      process.stdout.write(JSON.stringify({ calls, failure, publishDecision: typeof mod?.publishDecision }));
    `;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, PROBE_TARGET: pathToFileURL(join(ROOT, SCRIPT)).href },
    });
    assert.equal(run.status, 0, `the probe did not run clean: ${run.stderr}`);
    const seen = JSON.parse(run.stdout);
    assert.deepEqual(seen.calls, [], 'importing publish-schema.mjs reached the network, a child process or exit: main runs on import');
    assert.equal(seen.failure, null, `importing publish-schema.mjs threw: ${seen.failure}`);
    assert.equal(seen.publishDecision, 'function', 'the import does not export publishDecision');
  });

  it('main sits behind the entry-point test of script-cli.mjs, the one way a script knows it was run', () => {
    const src = stripComments(readFileSync(join(ROOT, SCRIPT), 'utf8'));
    assert.match(src, /import\s*\{[^}]*\bisEntryPoint\b[^}]*\}\s*from\s*['"]\.\/_shared\/script-cli\.mjs['"]/, 'isEntryPoint is not imported from script-cli.mjs');
    assert.match(src, /if\s*\(\s*isEntryPoint\(\s*import\.meta\.url\s*\)\s*\)/, 'main is not guarded by isEntryPoint(import.meta.url)');
  });
});

describe('the effects around the decision are bounded and shared (read on the comment-stripped source: a comment satisfies nothing)', () => {
  const raw = readFileSync(join(ROOT, SCRIPT), 'utf8');
  const src = stripComments(raw);

  it('reads bodies through readCappedBody, prints through workflowCommand, and ranks tags through release-tags.mjs', () => {
    assert.match(src, /\breadCappedBody\b[\s\S]*from\s*['"]\.\/_shared\/capped-body\.mjs['"]|from\s*['"]\.\/_shared\/capped-body\.mjs['"][\s\S]*\breadCappedBody\b/, 'readCappedBody is not imported from capped-body.mjs');
    assert.match(src, /readCappedBody\s*\(/, 'the registry body is not read through readCappedBody');
    assert.match(src, /from\s*['"]\.\/_shared\/workflow-command\.mjs['"]/, 'messages do not go through workflowCommand');
    assert.match(src, /workflowCommand\s*\(/, 'workflowCommand is imported and never called');
    assert.match(src, /from\s*['"]\.\/_shared\/release-tags\.mjs['"]/, 'the dist-tag does not come from release-tags.mjs');
    assert.match(src, /\bisHighestReleaseTag\s*\(/, 'isHighestReleaseTag is not called: "highest" is a second rule here');
  });

  it('asks for the abbreviated document, with a 30 s abort and a 5 MB cap', () => {
    assert.match(src, /application\/vnd\.npm\.install-v1\+json/, 'the full packument is fetched; it grows with every version');
    assert.match(src, /AbortSignal\.timeout\(\s*30[_]?000\s*\)/, 'the registry read has no 30 s abort');
    assert.match(src, /5\s*\*\s*1024\s*\*\s*1024|5[_]?242[_]?880|5\s*\*\s*1[_]?048[_]?576/, 'the registry read has no 5 MB cap');
  });

  it('spawns npm with an args array, no shell, and a timeout each: 30 s for -v, 120 s for pack, 600 s for publish', () => {
    assert.ok(!/shell\s*:\s*true/.test(src), 'a child runs through a shell: the tag and the environment would be parsed by it');
    // `(?<![.\w])`: a call of the child-process functions, not `pattern.exec(text)`.
    assert.ok(!/(?<![.\w])(execSync|exec)\s*\(/.test(src), 'a command string is executed: spawn with an args array instead');
    for (const ms of ['30[_]?000', '120[_]?000', '600[_]?000']) {
      assert.match(src, new RegExp(`\\b${ms}\\b`), `no child has a timeout of ${ms} ms`);
    }
    assert.match(src, /['"]pack['"][\s\S]*['"]--dry-run['"][\s\S]*['"]--json['"]/, 'npm pack is not asked for its JSON file list');
  });

  it('a child that fails, or dies of a signal, exits 1 and is named', () => {
    assert.match(src, /\bsignal\b/, 'a child killed by a signal (status null) is not distinguished from success');
    assert.match(src, /process\.exit\(\s*1\s*\)|process\.exitCode\s*=\s*1/, 'a failure does not exit 1');
  });

  it('a publish failure of E404, E401 or ENEEDAUTH names the trusted-publisher step', () => {
    for (const code of ['E404', 'E401', 'ENEEDAUTH']) assert.ok(src.includes(code), `${code} from npm publish is not recognised`);
    assert.match(src, /trusted[\s-]publish/i, 'the failure does not say the trusted publisher is the thing to check');
  });

  it('holds FIRST_NPM_VERSION at 6.5.0, and its docblock says why it stays and what a CDN-stale E403 means', () => {
    assert.match(src, /FIRST_NPM_VERSION\s*=\s*['"]6\.5\.0['"]/, 'the first npm version is not 6.5.0');
    assert.ok(raw.includes('E403'), 'the docblock does not state the CDN-stale E403 case');
    assert.match(raw, /\bstays?\b/i, 'the docblock does not say why FIRST_NPM_VERSION stays once 6.5.0 exists');
  });
});
