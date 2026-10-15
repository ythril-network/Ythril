/**
 * Every example rule the Schema tab's help shows is a rule the server accepts when it is saved (b23 verify U3).
 *
 * ## What it prevents
 *
 * "Field reference and examples" under a type's Rules showed `self.properties.at <= now`. The engine has no `now` (a rule's outcome
 * depends only on the record and the rule, so there is no clock to read), and the save-time check refuses the rule naming an unknown
 * identifier. An operator who copies the example the product offers gets a refusal they cannot explain from the page in front of them.
 *
 * ## What is asserted
 *
 * The examples are DERIVED: every i18n value whose key starts `rules.help.` and names an example, in every locale the client ships,
 * one rule per line — with a floor, so a renamed key does not leave a loop over nothing. Each line is saved as a space rule through
 * `SpaceMetaBody`, the parse a schema save runs (a space rule reads `properties` as a map, so no declaration is needed to judge the
 * expression itself), and must be accepted.
 *
 * Run: node --test testing/standalone/every-rule-example-in-the-help-saves.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpaceMetaBody } from './_cel-rules.mjs';

const I18N = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/public/assets/i18n');
const LOCALES = fs.readdirSync(I18N).filter(f => /^[a-z]{2}\.json$/.test(f));

/** Every example line of the rules help, per locale: `[locale, key, line]`. */
const EXAMPLES = LOCALES.flatMap(file => {
  const dict = JSON.parse(fs.readFileSync(path.join(I18N, file), 'utf8'));
  return Object.entries(dict)
    .filter(([key]) => key.startsWith('rules.help.') && /example/i.test(key))
    .flatMap(([key, text]) => String(text).split('\n').map(line => line.trim()).filter(Boolean).map(line => [file, key, line]));
});

describe('every example rule in the rules help saves', () => {
  it('finds the examples (a floor: every locale shows at least one)', () => {
    assert.ok(LOCALES.length >= 3, `found ${LOCALES.length} locale files under ${I18N}`);
    for (const file of LOCALES) {
      assert.ok(EXAMPLES.some(([f]) => f === file), `${file}: no rules.help example found - re-point this gate`);
    }
  });

  for (const [file, key, line] of EXAMPLES) {
    it(`${file} ${key}: ${line}`, () => {
      const parsed = SpaceMetaBody.safeParse({ rules: { example: { rule: line, message: 'the help example' } } });
      assert.ok(parsed.success,
        `the help shows a rule the save refuses: ${line}\n  ${parsed.success ? '' : JSON.stringify(parsed.error.issues.map(i => i.message))}`);
    });
  }
});
