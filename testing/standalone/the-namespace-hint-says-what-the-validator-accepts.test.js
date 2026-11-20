/**
 * The hint under the namespace field of the Schema Library page says what `NamespaceIriZ` accepts, in every language (Q-748, bundle-269
 * lens sweep, finding 4; `pitfall-label-contradicts-control`).
 *
 * ## The defect it prevents
 *
 * The hint (`schemaLib.namespace.iriHint`) said "an absolute address ending in / or #". The validator behind the field, `NamespaceIriZ`
 * (`schema/src/iri.ts`), refuses a `#` anywhere: a namespace puts a type under it as a document and a property as a fragment of that
 * document, so a namespace ending in `#` would put the type inside a fragment. An operator who followed the hint got a 400.
 *
 * ## What it holds
 *
 * The rule is read from the validator by what it does, never typed here: which ending it accepts and which character it refuses. Every
 * language's hint then names the accepting ending, states the refused character as refused (never as a way to end a namespace), and
 * gives an example the validator itself accepts.
 *
 * Run: node --test testing/standalone/the-namespace-hint-says-what-the-validator-accepts.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';

const { NamespaceIriZ } = await import('../../schema/dist/index.js');

const KEY = 'schemaLib.namespace.iriHint';
const LOCALES = ['en', 'de', 'pl'];
/** The words that join two alternatives in each language: "ending in / OR #". */
const OR = { en: 'or', de: 'oder', pl: 'lub' };
const hintOf = (locale) => JSON.parse(readFileSync(join(REPO_ROOT, `client/public/assets/i18n/${locale}.json`), 'utf8'))[KEY];

const accepts = (iri) => NamespaceIriZ.safeParse(iri).success;
/** The ending characters the validator accepts and the ones it refuses, by trying them on an address that is otherwise one. */
const ENDINGS = ['/', '#', '?', ':'];
const accepted = ENDINGS.filter(c => accepts(`https://example.org/ns${c}`));
const refused = ENDINGS.filter(c => !accepts(`https://example.org/ns${c}`));

describe('the namespace hint says what the validator accepts', () => {
  it('reads a rule worth holding the hint to: one ending accepted, and a "#" refused', () => {
    assert.deepEqual(accepted, ['/'], `the validator accepts the endings ${JSON.stringify(accepted)}`);
    assert.ok(refused.includes('#'), 'the validator accepts a namespace ending in "#"');
    assert.equal(accepts('https://example.org/a#b/'), false, 'the validator accepts a "#" inside a namespace');
  });

  for (const locale of LOCALES) {
    describe(`the ${locale} hint`, () => {
      const hint = hintOf(locale);

      it('exists', () => assert.equal(typeof hint, 'string', `${locale}.json has no ${KEY}`));

      it('names the ending the validator accepts', () => {
        for (const c of accepted) assert.ok(hint.includes(c), `the hint does not name the accepting ending ${c}: ${hint}`);
      });

      it('never offers a refused character as an ending', () => {
        for (const c of refused.filter(r => r === '#')) {
          assert.ok(hint.includes(c), `the hint does not say that ${c} is refused: ${hint}`);
          for (const a of accepted) {
            const offered = new RegExp(`${a.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}\\s*(?:${OR[locale]})\\s*${c}`, 'iu');
            assert.doesNotMatch(hint, offered, `the hint offers ${c} as an ending beside ${a}: ${hint}`);
          }
        }
      });

      it('gives an example the validator accepts', () => {
        const examples = hint.match(/https?:\/\/[^\s,;)]+/g) ?? [];
        assert.ok(examples.length > 0, `the hint gives no example address: ${hint}`);
        for (const e of examples) assert.equal(accepts(e), true, `the hint's example ${e} is refused by the validator`);
      });
    });
  }
});
