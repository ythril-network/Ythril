/**
 * The per-type "suppress embeddings" control says what Save does to the vectors already stored, and is labelled for assistive technology (Q-368).
 *
 * Like the space-wide switch, setting a TYPE to suppress sweeps the stored text vectors of that type's records. The warning under the select said
 * only "Records written while this is on are not embedded, and turning it off later does not go back and embed them", which is the opposite of the
 * reader's worry (what happens to the ones I have) and does not say how to get them back. The control is also a bare `<label>` beside a `<select>`
 * with no `for` and no `id`: the select has no accessible name, and nothing announces the warning.
 *
 * Owed, in en / de / pl:
 *
 *  - while the type is set to suppress, a `role="status"` notice says Save removes the stored text vectors of THIS TYPE's records and names the way
 *    back by the button's label and where it lives (the space's Danger Zone, Embeddings);
 *  - the select is described by the notice (`aria-describedby` -> its id) and named by its label (`label[for]` -> the select's `id`);
 *  - the notice is absent for "inherit" and "always embed": nothing is removed by them.
 *
 * The draft is the plain object a host edits in place, so each case builds the editor over a draft that already says what it says.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { dictionary } from '../../testing/i18n-dictionary';
import { SchemaTypeEditorComponent } from './schema-type-editor.component';
import { emptyTypeSchemaState } from './space-settings-state.service';

const WORDS = {
  en: { vector: /vector/i, removed: /remov|delet|dropp|discard/i },
  de: { vector: /vektor/i, removed: /entfern|lösch|verwerf/i },
  pl: { vector: /wektor/i, removed: /usun|usuw|kasuj|odrzuc/i },
} as const;

function mount(language: 'en' | 'de' | 'pl', suppress: boolean | null) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [SchemaTypeEditorComponent, getTranslocoModule({ translation: { en: dictionary(language) } })] });
  const fixture = TestBed.createComponent(SchemaTypeEditorComponent);
  fixture.componentRef.setInput('knowledgeType', 'fact');
  fixture.componentRef.setInput('draft', emptyTypeSchemaState({ suppressEmbeddings: suppress }));
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const dict = dictionary(language);
  const label = [...el.querySelectorAll('label')].find(l => (l.textContent ?? '').trim() === dict['spaces.schema.suppressEmbeddings.label']) ?? null;
  const select = label?.getAttribute('for') ? el.querySelector<HTMLSelectElement>(`select#${CSS.escape(label.getAttribute('for')!)}`) : null;
  const notice = el.querySelector<HTMLElement>('[role="status"]');
  return { el, dict, label, select, notice };
}

describe('the per-type suppression control (Q-368)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  for (const language of ['en', 'de', 'pl'] as const) {
    it(`${language}: a type set to suppress says Save removes its stored text vectors, and where the way back is`, () => {
      const { notice, dict } = mount(language, true);
      expect(notice, 'the warning is a role=status element').toBeTruthy();
      const said = notice!.textContent ?? '';
      expect(said, `${language} notice: ${said}`).toMatch(WORDS[language].vector);
      expect(said, `${language} notice: ${said}`).toMatch(WORDS[language].removed);
      expect(said, 'the button, by its label').toContain(dict['spaces.dangerZone.embeddingsBackfill']);
      expect(said, 'and where it is').toContain(dict['spaces.popup.tab.dangerZone']);
    });
  }

  it('the notice is scoped to the type\'s records, not the whole space', () => {
    const said = mount('en', true).notice?.textContent ?? '';
    expect(said, `says: ${said}`).toMatch(/\b(?:this|the) type|type's|of this type/i);
  });

  it('the label belongs to the select: label[for] is the id of the select', () => {
    const { label, select } = mount('en', null);
    expect(label, 'the Embeddings label is rendered').toBeTruthy();
    expect(label!.getAttribute('for'), 'label has `for`').toBeTruthy();
    expect(select, 'a select carries that id, so the label names it').toBeTruthy();
    expect(select!.querySelector('option[value="on"]'), 'and it is the suppression select').toBeTruthy();
  });

  it('the select is described by the notice: aria-describedby is the notice\'s id', () => {
    const { select, notice } = mount('en', true);
    expect(notice, 'the notice').toBeTruthy();
    expect(notice!.id, 'the notice has an id').toBeTruthy();
    expect(select?.getAttribute('aria-describedby') ?? '').toContain(notice!.id);
  });

  it('"inherit" and "always embed" show no removal notice: nothing is removed by them', () => {
    expect(mount('en', null).notice).toBeNull();
    expect(mount('en', false).notice).toBeNull();
  });
});
