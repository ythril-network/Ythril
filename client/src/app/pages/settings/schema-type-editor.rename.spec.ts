/**
 * A pencil beside each property key renames it, and the row says "was <old name>" until the schema is saved (Q-747, bundle-285).
 *
 * The editor edits a draft IN PLACE (its host decides when it is saved), so every assertion here is on the draft the host holds as
 * well as on the page: the rename must reach the draft with the definition and the place of the row kept, a refusal must leave the
 * draft alone and say why on the row, and the row's "was" note must come from what the draft remembers, not from a copy the host
 * has to keep in step. A library-linked type is read-only until unlinked and offers no pencil at all.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, afterEach } from 'vitest';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { dictionary } from '../../testing/i18n-dictionary';
import { SchemaTypeEditorComponent } from './schema-type-editor.component';
import { emptyTypeSchemaState, type TypeSchemaState } from './space-settings-state.service';

const EN = dictionary('en');
const PROP_ERRORS = {
  'spaces.schema.renamePropError.exists': 'This type already has a property with that name.',
  'spaces.schema.renamePropError.empty': 'A property needs a name.',
  'spaces.schema.renamePropError.missing': 'That property is no longer here.',
};

function draftOf(...keys: string[]): TypeSchemaState {
  // As the space opened it: every property is a stored one (`markStored` is what the settings state calls on open and on save).
  return emptyTypeSchemaState({ propertySchemas: keys.map(key => ({ key, s: { type: 'string', description: `the ${key}` }, _enumInput: '', _stored: true })) });
}

function mount(draft: TypeSchemaState, inputs: Record<string, unknown> = {}) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [SchemaTypeEditorComponent, getTranslocoModule({ translation: { en: { ...EN, ...PROP_ERRORS } } })] });
  const fixture = TestBed.createComponent(SchemaTypeEditorComponent);
  document.body.appendChild(fixture.nativeElement);
  fixture.componentRef.setInput('knowledgeType', 'entity');
  fixture.componentRef.setInput('draft', draft);
  for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
  const renamed: { from: string; to: string }[] = [];
  /** Start recording what the editor tells its host; called by the tests that care, so the others do not depend on the output. */
  const listen = () => { fixture.componentInstance.propRenamed.subscribe(e => renamed.push(e)); };
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const keysOnPage = () => [...el.querySelectorAll('tr.prop-row')].map(r => r.querySelector('.prop-name-key')?.textContent?.trim());
  const pencil = (key: string) => el.querySelector<HTMLButtonElement>(`button[aria-label="Rename the property ${key}"]`);
  const input = () => el.querySelector<HTMLInputElement>('tr.prop-row input[type="text"]');
  const type = (text: string) => { const i = input()!; i.value = text; i.dispatchEvent(new Event('input')); };
  const press = (k: string) => { input()!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); fixture.detectChanges(); };
  const open = (key: string) => { pencil(key)!.click(); fixture.detectChanges(); };
  const rename = (from: string, to: string) => { open(from); type(to); press('Enter'); };
  return { fixture, el, keysOnPage, pencil, input, type, press, open, rename, renamed, listen };
}

afterEach(() => { document.body.innerHTML = ''; });

describe('a pencil beside each property key', () => {
  it('is one button per property, named by the property, and a keyboard can reach each', () => {
    const { el, pencil } = mount(draftOf('company', 'email', 'age'));
    expect(el.querySelectorAll('tr.prop-row button[aria-label^="Rename the property "]').length).toBe(3);
    for (const key of ['company', 'email', 'age']) {
      const b = pencil(key)!;
      expect(b, key).toBeTruthy();
      expect(b.tagName).toBe('BUTTON');
      expect(b.tabIndex).toBe(0);
      expect(b.getAttribute('title')).toBe('Rename this property');
    }
  });

  it('opens an input named for the property, holding the key', () => {
    const { open, input } = mount(draftOf('company', 'email'));
    open('company');
    expect(input()?.value).toBe('company');
    expect(input()?.getAttribute('aria-label')).toBe('Rename the property company');
  });

  it('opening it does not also open the row\'s detail card', () => {
    const { el, open } = mount(draftOf('company'));
    open('company');
    expect(el.querySelector('tr.prop-expand-row')).toBeNull();
  });

  it('is said in German and Polish, by the property\'s key', () => {
    for (const lang of ['de', 'pl'] as const) {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ imports: [SchemaTypeEditorComponent, getTranslocoModule({ translation: { en: dictionary(lang) } })] });
      const f = TestBed.createComponent(SchemaTypeEditorComponent);
      f.componentRef.setInput('knowledgeType', 'entity');
      f.componentRef.setInput('draft', draftOf('company'));
      f.detectChanges();
      const b = (f.nativeElement as HTMLElement).querySelector('tr.prop-row button:not(.prop-toggle)[aria-label*="company"]');
      expect(b?.getAttribute('aria-label')).toBe(dictionary(lang)['spaces.schema.renamePropAria']!.replace('{{key}}', 'company'));
    }
  });

  it('is not offered on a type linked to a library entry, which is read-only until it is unlinked', () => {
    const { el } = mount(draftOf('company'), { libRef: 'people', linkedProps: [{ key: 'company', s: { type: 'string' } }] });
    expect(el.querySelectorAll('button[aria-label^="Rename the property"]').length).toBe(0);
    expect(el.querySelectorAll('input').length).toBe(0);
  });
});

describe('renaming', () => {
  it('Enter renames the property in the draft, keeping its definition and its place', () => {
    const draft = draftOf('company', 'email', 'age');
    const definition = draft.propertySchemas[0]!.s;
    const { rename, keysOnPage, input } = mount(draft);
    rename('company', 'employer');
    expect(draft.propertySchemas.map(p => p.key)).toEqual(['employer', 'email', 'age']);
    expect(draft.propertySchemas[0]!.s).toBe(definition);
    expect(keysOnPage()).toEqual(['employer', 'email', 'age']);
    expect(input(), 'the field closes').toBeNull();
  });

  it('tells its host what was renamed', () => {
    const { rename, renamed, listen } = mount(draftOf('company', 'email'));
    listen();
    rename('company', 'employer');
    expect(renamed).toEqual([{ from: 'company', to: 'employer' }]);
  });

  it('keeps the detail card open under the new key when the row was open', () => {
    const { fixture, el, rename } = mount(draftOf('company'));
    (el.querySelector('tr.prop-row button.prop-toggle') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el.querySelector('tr.prop-expand-row')).toBeTruthy();
    rename('company', 'employer');
    expect(el.querySelector('tr.prop-expand-row')).toBeTruthy();
    expect(el.querySelector('tr.prop-row')?.classList.contains('prow-open')).toBe(true);
  });

  it('Escape reverts: nothing is renamed and nothing is announced', () => {
    const draft = draftOf('company', 'email');
    const { open, type, press, input, renamed, keysOnPage, listen } = mount(draft);
    listen();
    open('company');
    type('employer');
    press('Escape');
    expect(input()).toBeNull();
    expect(draft.propertySchemas.map(p => p.key)).toEqual(['company', 'email']);
    expect(keysOnPage()).toEqual(['company', 'email']);
    expect(renamed).toEqual([]);
  });

  it('a name another property holds is refused in words on the row, the field stays open, and the draft is untouched', () => {
    const draft = draftOf('company', 'email');
    const { open, type, press, input, el, renamed, listen } = mount(draft);
    listen();
    open('company');
    type('email');
    press('Enter');
    expect(input()?.value).toBe('email');
    const alert = el.querySelector('tr.prop-row [role="alert"]');
    expect(alert?.textContent?.trim()).toBe(PROP_ERRORS['spaces.schema.renamePropError.exists']);
    expect(draft.propertySchemas.map(p => p.key)).toEqual(['company', 'email']);
    expect(renamed).toEqual([]);
  });

  it('an empty name is refused in words too', () => {
    const draft = draftOf('company');
    const { open, type, press, el } = mount(draft);
    open('company');
    type('   ');
    press('Enter');
    expect(el.querySelector('tr.prop-row [role="alert"]')?.textContent?.trim()).toBe(PROP_ERRORS['spaces.schema.renamePropError.empty']);
    expect(draft.propertySchemas.map(p => p.key)).toEqual(['company']);
  });

  it('after a refusal, a free name goes through and the refusal goes away', () => {
    const draft = draftOf('company', 'email');
    const { open, type, press, el, input } = mount(draft);
    open('company');
    type('email');
    press('Enter');
    type('employer');
    press('Enter');
    expect(draft.propertySchemas.map(p => p.key)).toEqual(['employer', 'email']);
    expect(input()).toBeNull();
    expect(el.querySelector('tr.prop-row [role="alert"]')).toBeNull();
  });
});

describe('"was <old name>" in the pane', () => {
  const wasNotes = (el: HTMLElement) => [...el.querySelectorAll('tr.prop-row .sch-hint')].map(n => n.textContent?.trim());

  it('says the stored name beside a renamed property, and only there', () => {
    const { el, rename } = mount(draftOf('company', 'email'));
    expect(wasNotes(el)).toEqual([]);
    rename('company', 'employer');
    expect(wasNotes(el)).toEqual(['was company']);
  });

  it('after two renames it still says the stored name', () => {
    const { el, rename } = mount(draftOf('company'));
    rename('company', 'firm');
    rename('firm', 'employer');
    expect(wasNotes(el)).toEqual(['was company']);
  });

  it('goes when the property is renamed back', () => {
    const { el, rename } = mount(draftOf('company'));
    rename('company', 'employer');
    rename('employer', 'company');
    expect(wasNotes(el)).toEqual([]);
  });

  it('is not said for a property added in this sitting', () => {
    const draft = draftOf('company');
    draft._newPropInput = 'nickname';
    const { el, fixture, rename, pencil } = mount(draft);
    const add = el.querySelector<HTMLButtonElement>('.sch-add-prop button.sch-add-btn')!;
    add.click();
    fixture.detectChanges();
    expect(pencil('nickname')).toBeTruthy();
    rename('nickname', 'alias');
    expect(wasNotes(el)).toEqual([]);
  });

  it('is said when the draft already carries a rename the host made (the type was renamed, the editor re-mounted)', () => {
    const draft = draftOf('company');
    draft.propertySchemas[0]!.key = 'employer';
    draft.propertySchemas[0]!._was = 'company';
    const { el } = mount(draft);
    expect(wasNotes(el)).toEqual(['was company']);
  });

  it('is said in the three languages', () => {
    for (const lang of ['en', 'de', 'pl'] as const) {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ imports: [SchemaTypeEditorComponent, getTranslocoModule({ translation: { en: dictionary(lang) } })] });
      const f = TestBed.createComponent(SchemaTypeEditorComponent);
      const draft = draftOf('employer');
      draft.propertySchemas[0]!._was = 'company';
      f.componentRef.setInput('knowledgeType', 'entity');
      f.componentRef.setInput('draft', draft);
      f.detectChanges();
      expect(wasNotes(f.nativeElement as HTMLElement)).toEqual([dictionary(lang)['spaces.schema.was']!.replace('{{name}}', 'company')]);
    }
  });
});
