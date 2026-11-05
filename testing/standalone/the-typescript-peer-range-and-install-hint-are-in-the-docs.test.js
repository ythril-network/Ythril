/**
 * The `typescript` peer range of `@ythril/schema` and the install hint of the from-typescript entry's error appear, as `package.json` and the source state them,
 * in the package README, the Schema API guide (06a) and `docs/dependencies.md` (Q-687, design v3 items 3, 8 and 14).
 *
 * ## The defects this prevents
 *
 * - **A ceiling on the peer blocks the whole package.** npm refuses (ERESOLVE) to install a package whose optional peer is already present at a version outside
 *   its range. With `>=5.4 <7`, an app whose own `typescript` is 7 (what `npm install typescript` gives since 7.0) could not install `@ythril/schema` at all,
 *   main entry included, though it never calls the from-typescript entry (bundle-220's pre-ship probe). So the range has a floor (5.4, the first release with
 *   the closed host's `libReplacement` option) and no ceiling; a module with no compiler API is refused when the entry is CALLED, with the hint, never at install.
 * - **The hint drifts from the compiler the entry is proven on.** An app author learns which compiler to install from three docs and from the entry's error
 *   ("... npm install typescript@6 ..."). The hint names the major of the `typescript-6` devDependency, the newest compiler the package's own tests run the
 *   entry on (from-typescript-reads-the-same-on-typescript-6), and is READ from it here, never written in this file.
 *
 * ## What is held
 *
 * - `schema/package.json` declares a `typescript` peer range of the form `>=<floor>`, with no upper bound.
 * - `schema/src/from-typescript.ts` words its install error with `npm install typescript@<the alias's major>` and names the `typescript` option.
 * - `schema/README.md`, `docs/integration-guide/06a-schema-api.md` and `docs/dependencies.md` each carry the range exactly as the manifest has it, state no
 *   ceiling beside it, and carry the hint.
 * - The reader is proven on planted values: a doc that kept a ceiling, a moved floor, and a hint of another major are each named.
 *
 * Run: node --test testing/standalone/the-typescript-peer-range-and-install-hint-are-in-the-docs.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DOCS = ['schema/README.md', 'docs/integration-guide/06a-schema-api.md', 'docs/dependencies.md'];
const ENTRY = 'schema/src/from-typescript.ts';

/** The install hint the tested alias implies: `typescript@<major>` from a `npm:typescript@^<major>` spec; `null` for anything else. */
export function installHintOf(aliasSpec) {
  const m = /^npm:typescript@\^?(\d+)(?:\.\d+)*$/.exec(String(aliasSpec ?? '').trim());
  return m ? `typescript@${m[1]}` : null;
}

/** `text` escaped for use inside a RegExp. */
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What `text` lacks of `{ range, hint }`, or states against them, as sentences. */
export function docGaps(label, text, { range, hint }) {
  const gaps = [];
  if (!text.includes(range)) gaps.push(`${label} does not carry the peer range \`${range}\` as package.json states it`);
  if (new RegExp(`${literal(range)}\\s*<`).test(text)) gaps.push(`${label} states a ceiling beside the peer range \`${range}\``);
  if (!text.includes(hint)) gaps.push(`${label} does not carry the install hint \`${hint}\``);
  return gaps;
}

describe('the reader this gate stands on (planted values)', () => {
  it('reads the hint from the tested alias', () => {
    assert.equal(installHintOf('npm:typescript@^6'), 'typescript@6');
    assert.equal(installHintOf('npm:typescript@7.0.2'), 'typescript@7');
    assert.equal(installHintOf('^6'), null, 'a spec that is not an alias of typescript implies no hint: the gate refuses it');
  });

  it('names a doc that kept a ceiling, moved the floor, or names another major', () => {
    const now = { range: '>=5.4', hint: 'typescript@6' };
    assert.deepEqual(docGaps('a', 'needs typescript >=5.4; run npm install typescript@6', now), []);
    assert.equal(docGaps('a', 'needs typescript >=5.4 <7; run npm install typescript@6', now).length, 1, 'a ceiling');
    assert.equal(docGaps('a', 'needs typescript >=5.2; run npm install typescript@6', now).length, 1, 'another floor');
    assert.equal(docGaps('a', 'needs typescript >=5.4; run npm install typescript@5', now).length, 1, 'another major');
    assert.equal(docGaps('a', 'nothing', now).length, 2);
  });
});

describe('the typescript peer range and the install hint are stated alike everywhere', () => {
  const manifest = JSON.parse(readFileSync('schema/package.json', 'utf8'));
  const range = manifest.peerDependencies?.typescript;
  const hint = installHintOf(manifest.devDependencies?.['typescript-6']);

  it('schema/package.json declares a typescript peer range with a floor and no ceiling, so an app on a newer typescript still installs the package', () => {
    assert.ok(range, 'schema/package.json declares no peerDependencies.typescript');
    assert.match(range, /^>=\d+\.\d+$/, `the peer range ${range} is not of the form ">=<floor>": a ceiling makes npm refuse the whole package beside a newer typescript`);
  });

  it('the install error words the hint of the tested alias, and names the typescript option', () => {
    assert.ok(hint, 'schema/package.json has no typescript-6 devDependency of the form npm:typescript@^<major>');
    const src = readFileSync(ENTRY, 'utf8');
    assert.ok(src.includes(`npm install ${hint}`), `${ENTRY} does not word its install error with "npm install ${hint}"`);
    assert.match(src, /typescript['"`]?\s+option|option\s+typescript/i, `${ENTRY}'s install error does not name the typescript option`);
  });

  for (const doc of DOCS) {
    it(`${doc} carries the range and the hint`, () => {
      assert.ok(range && hint, 'there is no range or hint to hold the doc to');
      assert.deepEqual(docGaps(doc, readFileSync(doc, 'utf8'), { range, hint }), []);
    });
  }
});
