/**
 * The workspace package that holds the space-schema vocabulary is named ONCE, by its manifest, and no tracked text spells its retired name (Q-683).
 *
 * ## The defect this prevents
 *
 * Q-683 renames the package from its retired name (scope `@ythril`) to the same name under the scope the owner holds on npm (`@ythril-network`), and publishes it. An npm
 * version can never be republished, so a rename that leaves one place on the old name ships a package whose own docs, lockfile or gates disagree
 * with it. Two failures are the same defect:
 *
 * - A STALE NAME. A lockfile entry, a comment, a doc line or a regex still naming the retired package. A regex is the worst case: a gate whose pattern
 *   spells a name no import uses matches nothing and PASSES, so the rule it stands for stops being held without a single red line. Gates of this
 *   repository spelled the name by hand in a pattern or an assertion.
 * - A SECOND SPELLING OF THE NEW NAME. Every gate that spells the current name itself needs the next rename to find it again; one that builds the pattern
 *   from `schemaSpecifierSource` / `SCHEMA_PACKAGE_NAME` (testing/standalone/_relative-specifier.mjs, read once from schema/package.json) follows the
 *   manifest, and a typo cannot make it quiet.
 *
 * ## What is held (design v3, A5)
 *
 * - The set is the tracked-text listing (`git ls-files` through `readTrackedTextSources`, with a floor), `package-lock.json` included.
 * - The retired name is spelled nowhere in it, in a comment, a doc, a regex (`@ythril` + any number of backslashes + `/schema`) or a lock entry, except
 *   CHANGELOG.md's released sections (from the first `## [x.y.z]` heading on: history keeps the name it was published under) and _relative-specifier.mjs,
 *   the one sanctioned spelling (`RETIRED_SCHEMA_PACKAGE_NAME`). Each exception is asserted to still hold the name, so an exemption cannot outlive its reason.
 * - The CURRENT name is not spelled literally in `testing/` or `scripts/` either (except _relative-specifier.mjs): a gate builds from the manifest.
 * - The server's dependency key, every `-w` / `--workspace` argument naming the package, and the pin VALUE equal schema/package.json's name and version;
 *   the lockfile links the package under that name.
 * - repository.url is `git+https://github.com/${DEFAULT_REPO_SLUG}.git` with directory `schema` (npm provenance checks the source repository);
 *   `publishConfig.access` is `public` (a scoped package publishes private without it); no `.npmrc` is tracked (a registry or token line in a tracked
 *   npmrc would override the trusted-publishing flow).
 * - The contract of _relative-specifier.mjs the tests build from: `SCHEMA_PACKAGE_NAME`, `RETIRED_SCHEMA_PACKAGE_NAME`, `schemaSpecifierSource(subpaths)`.
 * - Every matcher above is shown refusing a planted copy in memory: a comment, a regex, a lock entry, the current name in a testing/ file, a tracked
 *   `.npmrc`; and each exception is shown to be exactly as wide as stated.
 *
 * This file spells neither name in one piece (both are joined from their parts at run time), so it is inside its own rule.
 *
 * ## The failure that bought it
 *
 * The first design of the rename (v1) listed the sites by hand; the vet found nine hand-spelled gate sites and a lock entry the list did not hold. A grep run
 * once is not a gate: this is the grep, kept.
 *
 * ## The contract chosen where the design leaves it open
 *
 * `schemaSpecifierSource(subpaths)` takes an array of subpaths (`''` is the main entry, `'/internal'` a subpath export), defaults to `['']`, and returns a
 * regex SOURCE for the package's name followed by exactly one of them. It is a sequence with no top-level alternation, so it can be embedded in a larger
 * pattern as written. It throws on an empty array or a subpath that is neither `''` nor starts with `/`: a typo is loud, never an empty match.
 *
 * Run: node --test testing/standalone/the-schema-package-is-named-once.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { REPO_ROOT, readTrackedTextSources } from './_sources.mjs';
import * as specifier from './_relative-specifier.mjs';
import { DEFAULT_REPO_SLUG } from '../../scripts/_shared/gh-call.mjs';

/** The retired and the current name, joined at run time: this file is scanned by the rules it holds. */
const RETIRED = ['@ythril', 'schema'].join('/');
const CURRENT = ['@ythril-network', 'schema'].join('/');

const SANCTIONED = 'testing/standalone/_relative-specifier.mjs';
const CHANGELOG = 'CHANGELOG.md';

/** A fresh global RegExp per use: the retired name, with any number of backslashes before the slash (a regex `\/`, a string `\\/`, plain). */
const retiredPattern = () => new RegExp(`@ythril\\\\*\\/schema`, 'g');
/** A fresh global RegExp per use: the current name, in the same forms. */
const currentPattern = () => new RegExp(`@ythril-network\\\\*\\/schema`, 'g');

/** Where the released history starts in a changelog: the first `## [x.y.z]` heading. -1 when there is none. */
const releasedFrom = (text) => text.search(/^## \[\d+\.\d+\.\d+/m);

/** `{ file, line, text }` for every line of `text` matching `pattern` (a fresh global RegExp), reading only the first `stop` characters (line numbers stay the file's own). */
function sitesOf(file, text, pattern, { stop = text.length } = {}) {
  const found = [];
  const lines = text.slice(0, stop).split('\n');
  lines.forEach((line, i) => { if (pattern.test(line)) found.push({ file, line: i + 1, text: line.trim().slice(0, 100) }); pattern.lastIndex = 0; });
  return found;
}

/**
 * The retired name's sites in one tracked text. The sanctioned module is exempt whole; the changelog is read only up to its first released heading (line
 * numbers stay the file's own); a changelog with no released heading is read whole, so the exemption cannot swallow a file it does not understand.
 */
export function retiredNameSites(file, text) {
  if (file === SANCTIONED) return [];
  if (file === CHANGELOG) {
    const at = releasedFrom(text);
    return sitesOf(file, text, retiredPattern(), { stop: at < 0 ? text.length : at });
  }
  return sitesOf(file, text, retiredPattern());
}

/** The current name's literal sites in one tracked text, for a file under testing/ or scripts/ other than the sanctioned module. */
export function currentNameLiteralSites(file, text) {
  if (file === SANCTIONED || !(file.startsWith('testing/') || file.startsWith('scripts/'))) return [];
  return sitesOf(file, text, currentPattern());
}

/** Does the exemption of `file` still hold the retired name (so the exception is not left standing for a reason that is gone)? */
export function exemptionHoldsName(file, text) {
  if (file === SANCTIONED) return retiredPattern().test(text);
  if (file === CHANGELOG) { const at = releasedFrom(text); return at >= 0 && retiredPattern().test(text.slice(at)); }
  throw new Error(`${file} is no exemption`);
}

/** The tracked `.npmrc` files of a listing, at any depth. */
export const npmrcFiles = (files) => files.filter(f => posix.basename(f) === '.npmrc');

/** Every scoped `<scope>/schema` workspace argument of `-w` / `--workspace` in a text. */
export function workspaceArguments(text) {
  return [...text.matchAll(/(?:\s-w\s+|--workspace[=\s]\s*)(@[\w.-]+\/schema)(?![\w.-])/g)].map(m => m[1]);
}

/** What is wrong with the server's dependency on the package: its key is not the manifest's name (or a second schema package is listed), or its pin is not the manifest's version. */
export function dependencyProblems(serverManifest, schemaManifest) {
  const problems = [];
  const keys = Object.keys(serverManifest.dependencies ?? {}).filter(k => k.endsWith('/schema'));
  if (keys.length !== 1 || keys[0] !== schemaManifest.name) problems.push(`the server's schema dependencies are [${keys.join(', ')}], not [${schemaManifest.name}]`);
  const pin = serverManifest.dependencies?.[schemaManifest.name];
  if (pin !== schemaManifest.version) problems.push(`the server pins ${schemaManifest.name} at ${pin}, not ${schemaManifest.version}`);
  return problems;
}

/** What is wrong with a listing for this gate: below the floor, or missing a file the rule is about. */
export function listingProblems(files, floor) {
  const problems = [];
  if (files.length < floor) problems.push(`only ${files.length} text file(s), below ${floor}`);
  for (const must of ['package-lock.json', CHANGELOG, 'schema/package.json', 'server/package.json', SANCTIONED]) {
    if (!files.includes(must)) problems.push(`the listing lacks ${must}`);
  }
  return problems;
}

const FLOOR = 1500;
const readText = (file) => readFileSync(join(REPO_ROOT, file), 'utf8');

/** Every tracked text file, read: `git ls-files` through the shared helper (floor inside), binary files (a NUL in the first 8 KB) left out. */
const trackedText = () => readTrackedTextSources(['.'], { floor: FLOOR });

describe('the matchers this gate stands on (each refuses a planted copy, in memory)', () => {
  it('refuses the retired name in a comment', () => {
    const sites = retiredNameSites('server/src/api/x.ts', `const a = 1;\n// the ${RETIRED} package\n`);
    assert.deepEqual(sites.map(s => [s.file, s.line]), [['server/src/api/x.ts', 2]]);
  });

  it('refuses it in a regex, whatever the escape: `\\/`, `\\\\/` or none', () => {
    for (const form of [RETIRED.replace('/', '\\/'), RETIRED.replace('/', '\\\\/'), RETIRED]) {
      assert.equal(retiredNameSites('testing/standalone/y.test.js', `const R = /${form}(?:\\/internal)?/;`).length, 1, form);
    }
  });

  it('refuses it in a lock entry, as a key, a name and a dependency', () => {
    for (const row of [`    "node_modules/${RETIRED}": {`, `      "name": "${RETIRED}",`, `        "${RETIRED}": "6.4.0",`]) {
      assert.equal(retiredNameSites('package-lock.json', `{\n${row}\n}`).length, 1, row);
    }
  });

  it('refuses it in a doc, a manifest and a script alike (the set is every tracked text)', () => {
    for (const file of ['docs/x.md', 'schema/package.json', 'server/package.json', 'scripts/a.mjs', 'Dockerfile', '.github/workflows/publish.yml', 'README.md']) {
      assert.equal(retiredNameSites(file, `see ${RETIRED}`).length, 1, file);
    }
  });

  it('does not take the current name, a sibling package of the old scope, or the scope alone for the retired name', () => {
    for (const ok of [`import x from '${CURRENT}';`, '@ythril/server', '@ythril is the old scope', `${CURRENT}/internal`, '@ythril-network/server']) {
      assert.deepEqual(retiredNameSites('docs/x.md', ok), [], ok);
    }
  });

  it('exempts CHANGELOG.md from its first released heading on, and not above it', () => {
    const changelog = ['# Changelog', '', '## [Unreleased]', '', `- Changed: ${RETIRED} is renamed.`, '', '## [6.4.0] - 2026-11-03', '', `- ${RETIRED} types a space's schemas.`, ''].join('\n');
    assert.deepEqual(retiredNameSites(CHANGELOG, changelog).map(s => s.line), [5], 'only the Unreleased line is refused, at its own line number');
    assert.deepEqual(retiredNameSites(CHANGELOG, changelog.replace('[Unreleased]', '[6.5.0]')), [], 'with no Unreleased section above, the whole changelog is history');
    assert.equal(retiredNameSites(CHANGELOG, `# Changelog\n\n${RETIRED}\n`).length, 1, 'a changelog with no released heading is read whole');
  });

  it('exempts only these two files, by exact path (a twin elsewhere is refused)', () => {
    assert.deepEqual(retiredNameSites(SANCTIONED, `export const R = '${RETIRED}';`), []);
    for (const twin of ['scripts/_relative-specifier.mjs', 'testing/_shared/_relative-specifier.mjs', 'docs/CHANGELOG.md', 'schema/CHANGELOG.md']) {
      assert.equal(retiredNameSites(twin, RETIRED).length, 1, twin);
    }
  });

  it('refuses the CURRENT name spelled literally in a testing/ or scripts/ file, in a string, a template or a regex', () => {
    for (const file of ['testing/standalone/z.test.js', 'testing/_shared/z.mjs', 'testing/e2e/a/b.js', 'scripts/z.mjs', 'scripts/_shared/z.mjs']) {
      for (const form of [`assert.equal(n, '${CURRENT}');`, `\`npm run build -w ${CURRENT}\``, `/${CURRENT.replace('/', '\\/')}/`]) {
        assert.equal(currentNameLiteralSites(file, form).length, 1, `${file}: ${form}`);
      }
    }
  });

  it('allows the current name where it belongs: the sanctioned module, and every file outside testing/ and scripts/', () => {
    assert.deepEqual(currentNameLiteralSites(SANCTIONED, CURRENT), []);
    for (const file of ['server/src/index.ts', 'docs/x.md', 'schema/package.json', 'package-lock.json', 'README.md', '.github/workflows/publish.yml', 'testing-guide.md']) {
      assert.deepEqual(currentNameLiteralSites(file, CURRENT), [], file);
    }
  });

  it('refuses a tracked .npmrc at any depth, and nothing that merely resembles one', () => {
    assert.deepEqual(npmrcFiles(['.npmrc', 'schema/.npmrc', 'server/package.json', 'docs/npmrc-notes.md', 'a/.npmrc.bak', 'b/npmrc']), ['.npmrc', 'schema/.npmrc']);
    assert.deepEqual(npmrcFiles(['package.json', 'schema/package.json']), []);
  });

  it('reads the package\'s workspace arguments in each form, and ignores a path, a sibling package and a longer name', () => {
    assert.deepEqual(workspaceArguments(`npm run build -w ${CURRENT} && x`), [CURRENT]);
    assert.deepEqual(workspaceArguments(`npm run build -w ${RETIRED}`), [RETIRED]);
    assert.deepEqual(workspaceArguments(`npm publish --workspace=${CURRENT} --provenance`), [CURRENT]);
    assert.deepEqual(workspaceArguments(`npm ci --workspace ${CURRENT}`), [CURRENT]);
    assert.deepEqual(workspaceArguments('npm ci --workspace=server --workspace=schema -w @ythril/server'), []);
    assert.deepEqual(workspaceArguments(`npm run build -w ${CURRENT}s`), []);
  });

  it('reads the server\'s dependency: a retired key, a second schema package, a missing key and a drifted pin are each refused', () => {
    const schemaManifest = { name: CURRENT, version: '6.5.0' };
    assert.deepEqual(dependencyProblems({ dependencies: { [CURRENT]: '6.5.0', zod: '^4' } }, schemaManifest), []);
    assert.equal(dependencyProblems({ dependencies: { [RETIRED]: '6.5.0' } }, schemaManifest).length >= 1, true, 'the retired key');
    assert.equal(dependencyProblems({ dependencies: { [CURRENT]: '6.5.0', [RETIRED]: '6.5.0' } }, schemaManifest).length, 1, 'a second schema package beside the right one');
    assert.equal(dependencyProblems({ dependencies: { zod: '^4' } }, schemaManifest).length, 2, 'no key at all');
    assert.deepEqual(dependencyProblems({ dependencies: { [CURRENT]: '6.4.0' } }, schemaManifest), [`the server pins ${CURRENT} at 6.4.0, not 6.5.0`]);
    assert.deepEqual(dependencyProblems({ dependencies: { [CURRENT]: '^6.5.0' } }, schemaManifest), [`the server pins ${CURRENT} at ^6.5.0, not 6.5.0`], 'a range is not the pin');
  });

  it('knows when its own listing is broken: below the floor, or lacking the lockfile or a file a rule is about', () => {
    const whole = ['package-lock.json', CHANGELOG, 'schema/package.json', 'server/package.json', SANCTIONED, ...Array.from({ length: FLOOR }, (_, i) => `f/${i}.txt`)];
    assert.deepEqual(listingProblems(whole, FLOOR), []);
    assert.equal(listingProblems(whole.slice(0, 100), FLOOR).length >= 1, true);
    assert.deepEqual(listingProblems(whole.filter(f => f !== 'package-lock.json'), FLOOR), ['the listing lacks package-lock.json']);
  });

  it('knows an exemption that no longer holds the name', () => {
    const history = `## [6.4.0]\n\n- ${RETIRED} types schemas.\n`;
    assert.equal(exemptionHoldsName(CHANGELOG, `## [Unreleased]\n\n## [6.4.0]\n\n- ${RETIRED}\n`), true);
    assert.equal(exemptionHoldsName(CHANGELOG, `## [Unreleased]\n\n- ${RETIRED}\n\n## [6.4.0]\n\n- nothing\n`), false, 'a name only above the released headings is no reason to exempt them');
    assert.equal(exemptionHoldsName(CHANGELOG, '# Changelog\n'), false);
    assert.equal(exemptionHoldsName(CHANGELOG, history), true);
    assert.equal(exemptionHoldsName(SANCTIONED, `export const R = '${RETIRED}';`), true);
    assert.equal(exemptionHoldsName(SANCTIONED, `export const R = '${CURRENT}';`), false);
    assert.throws(() => exemptionHoldsName('docs/x.md', RETIRED), /no exemption/);
  });
});

describe('the contract of _relative-specifier.mjs that every gate builds from (what the tests import)', () => {
  const manifestName = JSON.parse(readText('schema/package.json')).name;

  it('exports SCHEMA_PACKAGE_NAME (the manifest\'s name), RETIRED_SCHEMA_PACKAGE_NAME and schemaSpecifierSource', () => {
    assert.equal(specifier.SCHEMA_PACKAGE_NAME, manifestName, 'the constant is read from schema/package.json, once');
    assert.equal(specifier.SCHEMA_PACKAGE_NAME, CURRENT, 'the package is named by the scope the owner holds on npm');
    assert.equal(specifier.RETIRED_SCHEMA_PACKAGE_NAME, RETIRED);
    assert.equal(typeof specifier.schemaSpecifierSource, 'function');
  });

  /** A matcher for exactly `subpaths` of the current name. */
  const only = (subpaths) => new RegExp(`^${specifier.schemaSpecifierSource(subpaths)}$`);

  it('schemaSpecifierSource accepts the name with exactly one of the subpaths, and nothing else', () => {
    const N = specifier.SCHEMA_PACKAGE_NAME;
    const table = [
      { subpaths: [''], accepts: [N], rejects: [`${N}/internal`, `${N}/`, RETIRED, `${N}-x`, ''] },
      { subpaths: ['/internal'], accepts: [`${N}/internal`], rejects: [N, `${N}/internal/x`, `${N}/from-typescript`, `${RETIRED}/internal`] },
      { subpaths: ['', '/internal'], accepts: [N, `${N}/internal`], rejects: [`${N}/from-typescript`, RETIRED, `${RETIRED}/internal`, `${N}/internalx`] },
      { subpaths: ['/from-typescript'], accepts: [`${N}/from-typescript`], rejects: [N, `${N}/internal`, `${RETIRED}/from-typescript`] },
    ];
    for (const { subpaths, accepts, rejects } of table) {
      for (const s of accepts) assert.equal(only(subpaths).test(s), true, `${JSON.stringify(subpaths)} accepts ${s}`);
      for (const s of rejects) assert.equal(only(subpaths).test(s), false, `${JSON.stringify(subpaths)} rejects ${s}`);
    }
  });

  it('with no argument it names the main entry only', () => {
    const N = specifier.SCHEMA_PACKAGE_NAME;
    const rx = new RegExp(`^${specifier.schemaSpecifierSource()}$`);
    assert.equal(rx.test(N), true);
    assert.equal(rx.test(`${N}/internal`), false);
  });

  it('its source embeds as written (no top-level alternation leaks into the pattern around it) and escapes the name\'s own characters', () => {
    const N = specifier.SCHEMA_PACKAGE_NAME;
    const quoted = new RegExp(`from '${specifier.schemaSpecifierSource(['', '/internal'])}'`);
    assert.equal(quoted.test(`from '${N}'`), true);
    assert.equal(quoted.test(`from '${N}/internal'`), true);
    assert.equal(quoted.test(`from '${N}/other'`), false);
    assert.equal(quoted.test(`from '${RETIRED}'`), false);
    assert.equal(quoted.test(`import '${N}/internal'`), false, 'the text around the source still has to match');
    assert.equal(new RegExp(specifier.schemaSpecifierSource(['', '/internal'])).test(`x ${RETIRED}/internal x`), false, 'unanchored, the retired name is still no match');
  });

  it('a typo is loud: an empty list, or a subpath that is neither empty nor starts with a slash, throws', () => {
    assert.throws(() => specifier.schemaSpecifierSource([]));
    assert.throws(() => specifier.schemaSpecifierSource(['internal']));
    assert.throws(() => specifier.schemaSpecifierSource(['/internal', 'from-typescript']));
  });

  it('SCHEMA_PACKAGE_ENTRIES is keyed by the manifest name and holds no key of the retired one', () => {
    const keys = Object.keys(specifier.SCHEMA_PACKAGE_ENTRIES);
    assert.ok(keys.length >= 3, 'the table holds the three entries');
    for (const key of keys) assert.ok(key === manifestName || key.startsWith(`${manifestName}/`), `${key} is not under the manifest name`);
    assert.deepEqual(keys.filter(k => k.startsWith(RETIRED)), []);
  });
});

describe('the repository names the package once', () => {
  const files = trackedText();
  const byName = new Map(files.map(f => [f.file, f.text]));
  const json = (file) => JSON.parse(byName.get(file));
  const schema = json('schema/package.json');
  const server = json('server/package.json');
  const lock = json('package-lock.json');
  const NAME = schema.name;

  it('the listing is the tracked text, whole (floor, and the lockfile, the changelog and the manifests are in it)', () => {
    assert.deepEqual(listingProblems(files.map(f => f.file), FLOOR), []);
  });

  it('no tracked text spells the retired name (a comment, a doc, a regex, a lock entry), except the changelog\'s released sections and the sanctioned module', () => {
    const sites = files.flatMap(({ file, text }) => retiredNameSites(file, text));
    assert.deepEqual(sites.map(s => `${s.file}:${s.line}  ${s.text}`), [], 'the retired package name is spelled here: rename it (the one sanctioned spelling is RETIRED_SCHEMA_PACKAGE_NAME)');
  });

  it('each exception still holds the name it is an exception for', () => {
    for (const file of [CHANGELOG, SANCTIONED]) assert.equal(exemptionHoldsName(file, byName.get(file)), true, `${file} no longer names the retired package: drop its exemption`);
  });

  it('no file of testing/ or scripts/ spells the CURRENT name literally: a gate builds its pattern from the manifest', () => {
    const sites = files.flatMap(({ file, text }) => currentNameLiteralSites(file, text));
    assert.deepEqual(sites.map(s => `${s.file}:${s.line}  ${s.text}`), [], 'build from SCHEMA_PACKAGE_NAME / schemaSpecifierSource (testing/standalone/_relative-specifier.mjs)');
  });

  it('the package is named for the scope the owner holds on npm, and is not private', () => {
    assert.equal(NAME, CURRENT);
    assert.equal(schema.private, undefined);
  });

  it('the server depends on the package by that name, and by no other schema package, pinned to the package\'s own version', () => {
    assert.deepEqual(dependencyProblems(server, schema), []);
  });

  it('every `-w` / `--workspace` argument that names the package, in any tracked text outside testing/, is its name', () => {
    const found = files.filter(f => !f.file.startsWith('testing/')).flatMap(({ file, text }) => workspaceArguments(text).map(arg => ({ file, arg })));
    assert.ok(found.length >= 2, `only ${found.length} workspace argument(s) read: the server's predev and prebuild name the package`);
    assert.deepEqual(found.filter(f => f.arg !== NAME), []);
    for (const script of ['predev', 'prebuild']) assert.deepEqual(workspaceArguments(` ${server.scripts[script]}`), [NAME], `server ${script} builds the package by name`);
  });

  it('the workspace set holds the package, and the lockfile links it under its name', () => {
    assert.ok(json('package.json').workspaces.includes('schema'));
    assert.deepEqual(lock.packages[`node_modules/${NAME}`], { resolved: 'schema', link: true });
    assert.equal(lock.packages.schema.name, NAME);
    assert.equal(lock.packages.schema.version, schema.version);
    assert.equal(lock.packages.server.dependencies[NAME], schema.version);
    // Of the workspace LINKS (a registry package that happens to be called `schema` under another scope is not ours), exactly this one.
    assert.deepEqual(Object.entries(lock.packages).filter(([k, v]) => k.startsWith('node_modules/') && v.link === true && v.resolved === 'schema').map(([k]) => k), [`node_modules/${NAME}`]);
  });

  it('repository.url is the repository the release is cut from (provenance compares it), with directory `schema`', () => {
    assert.equal(schema.repository.type, 'git');
    assert.equal(schema.repository.url, `git+https://github.com/${DEFAULT_REPO_SLUG}.git`);
    assert.equal(schema.repository.directory, 'schema');
  });

  it('publishConfig.access is public (a scoped package publishes private without it)', () => {
    assert.deepEqual(schema.publishConfig, { access: 'public' });
  });

  it('no .npmrc is tracked (a registry or token line in one overrides the trusted-publishing flow)', () => {
    assert.deepEqual(npmrcFiles(files.map(f => f.file)), []);
  });
});
