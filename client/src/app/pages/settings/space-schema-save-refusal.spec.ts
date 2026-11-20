/**
 * A schema write refused because an RDF import stands on the space is worded in the reader's language in the schema editor (bundle-270,
 * second review U3).
 *
 * ## What it holds
 *
 * Every schema write the editor makes goes out as the space PATCH (`SpacesApiService.updateSpace`) and a refusal is worded by
 * `describeRefusal` / `refusalText` under the default prefix `networks.refusal`: the editor's save (`space-settings-popup.component.ts`) and
 * the layers panel pass no prefix. `data-acts-have-words.spec.ts` holds every write-closed code to its sentence under every
 * prefix; THIS spec holds that the editor's own error paths reach it: a code `space_being_rdf_imported` (409) shows the shipped sentence of the
 * reader's language, never the server's English prose, and a path that began to pass another prefix, or none that the dictionary words, fails here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describeRefusal, refusalText } from '../../core/refusal-text';

const I18N = resolve(__dirname, '../../../../public/assets/i18n');
const LANGS = ['en', 'de', 'pl'] as const;
type Lang = (typeof LANGS)[number];
const dict = (lang: Lang): Record<string, string> => JSON.parse(readFileSync(resolve(I18N, `${lang}.json`), 'utf8'));
const CODE = 'space_being_rdf_imported';
const SERVER_PROSE = "Space 'notes' takes no writes while an RDF import is being written to it (server prose, English)";
const refused = { status: 409, error: { error: SERVER_PROSE, code: CODE } };

/** The shipped file as the translate function: `{{ name }}` interpolated, the key itself when it is missing (as Transloco answers). */
function translocoFor(lang: Lang) {
  const words = dict(lang);
  return { translate: (key: string): string => words[key] ?? key };
}

const source = (file: string): string => readFileSync(resolve(__dirname, file), 'utf8');

describe('the schema editor words a schema write refused by an RDF import', () => {
  for (const lang of LANGS) {
    it(`${lang}: the editor's save error is the shipped sentence for ${CODE}, not the server's prose`, () => {
      const shipped = dict(lang)[`networks.refusal.${CODE}`];
      expect(shipped, `${lang}.json words ${CODE} under networks.refusal`).toBeTruthy();
      const view = describeRefusal(translocoFor(lang), lang, refused, 'spaces.error.saveFailed');
      expect(view.text).toBe(shipped);
      expect(view.text).not.toContain('server prose');
      if (lang !== 'en') expect(view.text, `${lang} is not the English sentence`).not.toBe(dict('en')[`networks.refusal.${CODE}`]);
      expect(refusalText(translocoFor(lang), refused, 'spaces.schema.layers.proposeFailed')).toBe(shipped);
    });
  }

  it('the editor\'s error paths pass no prefix of their own, so they reach networks.refusal', () => {
    // A path that handed another prefix would look the code up there: the sentence would be missing or another screen's.
    expect(source('space-settings-popup.component.ts')).toMatch(/describeRefusal\(this\.transloco, '', err, 'spaces\.error\.saveFailed'\)/);
    expect(source('space-schema-layers.component.ts')).toMatch(/refusalText\(this\.transloco, err, 'spaces\.schema\.layers\.saveFailed'\)/);
    expect(source('space-schema-layers.component.ts')).toMatch(/refusalText\(this\.transloco, err, 'spaces\.schema\.layers\.proposeFailed'\)/);
  });
});
