/**
 * A version cited as `@ythril/schema@X.Y.Z` in the docs or the package README is the package's own version (Q-668, docs lens S3).
 *
 * ## The defect this prevents
 *
 * The README's "Versions" section and decision 19 said `@ythril/schema@6.3.1` was the first package version, while the package's own
 * manifest, and so the first release that publishes it, was already 6.3.2: 6.3.1 never shipped, and a reader who ran
 * `npm install @ythril/schema@6.3.1` was sent to a version that does not exist. Both were written beside a version bump and neither
 * moved with it. The package is versioned with the release, so a citation of `@ythril/schema@<version>` in prose is the current
 * release's number or it is wrong the day the next release is cut; this makes the release bump fail here and name each place to move.
 *
 * ## What is held
 *
 * - Every `@ythril/schema@<semver>` in a markdown file under `docs/` or in `schema/README.md` (HTML comments are not text) equals
 *   `schema/package.json`'s `version`. A history that must name an older version says it without the `@ythril/schema@` form.
 * - The scan has floors: the docs are read, and the package README cites its own version in the "Versions" section.
 * - The planted copy: a text citing another version is refused by the same function.
 *
 * Run: node --test testing/standalone/the-schema-package-version-cited-in-docs-is-its-own.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { DOCS_ROOT, docFiles } from './_docs.mjs';

const README = 'schema/README.md';

/** Every version a text cites as `@ythril/schema@<semver>`, HTML comments left out. */
export function citedVersions(text) {
  return [...text.replace(/<!--[\s\S]*?-->/g, '').matchAll(/@ythril\/schema@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/g)].map(m => m[1]);
}

/** The citations that are not `version`, as `{ file, cited }`. */
export function wrongCitations(files, version) {
  return files.flatMap(({ file, text }) => citedVersions(text).filter(v => v !== version).map(cited => ({ file, cited })));
}

const version = JSON.parse(readFileSync(join(REPO_ROOT, 'schema', 'package.json'), 'utf8')).version;
const files = [
  ...docFiles().map(f => ({ file: `docs/${f}`, text: readFileSync(join(DOCS_ROOT, f), 'utf8') })),
  { file: README, text: readFileSync(join(REPO_ROOT, README), 'utf8') },
];

describe('the reader this gate stands on', () => {
  it('reads the docs, the package version and the README citation', () => {
    assert.match(version, /^\d+\.\d+\.\d+/, 'schema/package.json has no version');
    assert.ok(files.length >= 20, `read ${files.length} files: the docs listing is broken`);
    assert.ok(citedVersions(files.at(-1).text).length >= 1, 'schema/README.md cites no `@ythril/schema@<version>`: its Versions section changed shape');
  });

  it('planted copies: another version is refused, a comment and a bare number are not citations', () => {
    const planted = [{ file: 'planted.md', text: `Use \`@ythril/schema@${version.replace(/\d+$/, n => Number(n) + 1)}\` now.` }];
    assert.equal(wrongCitations(planted, version).length, 1);
    assert.deepEqual(wrongCitations([{ file: 'c.md', text: '<!-- @ythril/schema@0.0.1 -->\nfirst published with 0.0.1' }], version), []);
    assert.deepEqual(wrongCitations([{ file: 'ok.md', text: `@ythril/schema@${version}` }], version), []);
  });
});

describe('a cited package version is the package version', () => {
  it('every `@ythril/schema@X.Y.Z` in the docs and the package README is schema/package.json\'s version', () => {
    const wrong = wrongCitations(files, version);
    assert.deepEqual(wrong, [], `schema/package.json is ${version}; cited otherwise: ${wrong.map(w => `${w.file} (${w.cited})`).join(', ')}`);
  });
});
