/**
 * The `typescript` peer range of `@ythril/schema` and the install hint of the from-typescript entry's error appear, as `package.json` and the source state them,
 * in the package README, the Schema API guide (06a) and `docs/dependencies.md` (Q-687, design v3 items 3, 8 and 14).
 *
 * ## The defect this prevents
 *
 * An app author learns which compiler the entry accepts from three places and from the error the entry throws when none is installed
 * ("... npm install typescript@6 ..."). A range written by hand in each of them drifts on the day the peer range moves (the floor of 5.4 is the first release
 * with the closed host's `libReplacement` option; a 7.x-shaped module is refused with the same hint), and a doc that says `typescript@5` while the entry
 * says `typescript@6` sends the reader to a compiler the entry then refuses. The range and the hint are therefore READ, never written in this file: the range from
 * `schema/package.json`'s `peerDependencies.typescript`, the hint from that range's upper bound (`<7` allows up to major 6, so `typescript@6`) and from the Error's own
 * text in `schema/src/from-typescript.ts`.
 *
 * ## What is held
 *
 * - `schema/package.json` declares a `typescript` peer range of the form `>=<floor> <<ceiling>`, and `schema/src/from-typescript.ts` words its install error with
 *   `npm install typescript@<ceiling - 1>` and names the `typescript` option.
 * - `schema/README.md`, `docs/integration-guide/06a-schema-api.md` and `docs/dependencies.md` each carry the range exactly as the manifest has it, and the hint.
 * - The reader is proven on planted values: a range moved in the manifest and not in a doc, and a hint of another major, are each named.
 *
 * Run: node --test testing/standalone/the-typescript-peer-range-and-install-hint-are-in-the-docs.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DOCS = ['schema/README.md', 'docs/integration-guide/06a-schema-api.md', 'docs/dependencies.md'];
const ENTRY = 'schema/src/from-typescript.ts';

/** The install hint a range implies: the highest major its upper bound allows, as `typescript@<major>`; `null` for a range with no `<N` bound. */
export function installHintOf(range) {
  const m = /<\s*(\d+)(?:\.\d+)*\s*$/.exec(String(range).trim());
  return m ? `typescript@${Number(m[1]) - 1}` : null;
}

/** What `text` lacks of `{ range, hint }`, as sentences. */
export function docGaps(label, text, { range, hint }) {
  const gaps = [];
  if (!text.includes(range)) gaps.push(`${label} does not carry the peer range \`${range}\` as package.json states it`);
  if (!text.includes(hint)) gaps.push(`${label} does not carry the install hint \`${hint}\``);
  return gaps;
}

describe('the reader this gate stands on (planted values)', () => {
  it('reads the hint from the range\'s upper bound', () => {
    assert.equal(installHintOf('>=5.4 <7'), 'typescript@6');
    assert.equal(installHintOf('>=5.4 <8'), 'typescript@7');
    assert.equal(installHintOf('^5'), null, 'a range with no upper bound implies no hint: the gate refuses it');
  });

  it('names a doc that kept the old range or another major', () => {
    const now = { range: '>=5.4 <7', hint: 'typescript@6' };
    assert.deepEqual(docGaps('a', 'needs typescript >=5.4 <7; run npm install typescript@6', now), []);
    assert.equal(docGaps('a', 'needs typescript >=5.2 <7; run npm install typescript@6', now).length, 1);
    assert.equal(docGaps('a', 'needs typescript >=5.4 <7; run npm install typescript@5', now).length, 1);
    assert.equal(docGaps('a', 'nothing', now).length, 2);
  });
});

describe('the typescript peer range and the install hint are stated alike everywhere', () => {
  const manifest = JSON.parse(readFileSync('schema/package.json', 'utf8'));
  const range = manifest.peerDependencies?.typescript;

  it('schema/package.json declares a typescript peer range with a floor and a ceiling', () => {
    assert.ok(range, 'schema/package.json declares no peerDependencies.typescript');
    assert.match(range, /^>=\d+\.\d+ <\d+$/, `the peer range ${range} is not of the form ">=<floor> <<ceiling>"`);
  });

  it('the install error words the hint the range implies, and names the typescript option', () => {
    const hint = installHintOf(range);
    assert.ok(hint, `no install hint follows from the peer range ${range}`);
    const src = readFileSync(ENTRY, 'utf8');
    assert.ok(src.includes(`npm install ${hint}`), `${ENTRY} does not word its install error with "npm install ${hint}"`);
    assert.match(src, /typescript['"`]?\s+option|option\s+typescript/i, `${ENTRY}'s install error does not name the typescript option`);
  });

  for (const doc of DOCS) {
    it(`${doc} carries the range and the hint`, () => {
      const hint = installHintOf(range);
      assert.ok(range && hint, 'there is no range or hint to hold the doc to');
      assert.deepEqual(docGaps(doc, readFileSync(doc, 'utf8'), { range, hint }), []);
    });
  }
});
