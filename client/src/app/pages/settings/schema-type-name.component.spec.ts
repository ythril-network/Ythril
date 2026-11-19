/**
 * The name of a type or a property, its pencil, and the "was <old name>" note (Q-747, bundle-285).
 *
 * The control was written for a type's name. It now also renames a property's key, so what used to be fixed words become inputs
 * (the label, the refusal wording, the class of the name), and it says "was <old name>" while a rename is unsaved. The keyboard
 * contract is the part a mouse never tests: the pencil is a button, the input is named, Enter commits, Escape reverts WITHOUT
 * reaching the dialog's own Escape (which would close the whole settings dialog under the rename), and focus goes where the
 * operator is working (into the input when it opens, back to the pencil when it closes).
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, afterEach } from 'vitest';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { dictionary } from '../../testing/i18n-dictionary';
import { SchemaTypeNameComponent } from './schema-type-name.component';

const EN = dictionary('en');
const PROP_ERRORS = {
  'spaces.schema.renamePropError.exists': 'This type already has a property with that name.',
  'spaces.schema.renamePropError.empty': 'A property needs a name.',
};

type Refusal = 'empty' | 'exists' | 'missing' | null;

function mount(inputs: Record<string, unknown> = {}, rename: (to: string) => Refusal = () => null) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [SchemaTypeNameComponent, getTranslocoModule({ translation: { en: { ...EN, ...PROP_ERRORS } } })] });
  const fixture = TestBed.createComponent(SchemaTypeNameComponent);
  document.body.appendChild(fixture.nativeElement);
  fixture.componentRef.setInput('name', 'Person');
  fixture.componentRef.setInput('rename', rename);
  for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const pencil = () => el.querySelector<HTMLButtonElement>('button');
  const input = () => el.querySelector<HTMLInputElement>('input');
  const type = (text: string) => { const i = input()!; i.value = text; i.dispatchEvent(new Event('input')); };
  const key = (k: string) => { const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }); input()!.dispatchEvent(e); fixture.detectChanges(); return e; };
  return { fixture, el, pencil, input, type, key, c: fixture.componentInstance };
}

afterEach(() => { document.body.innerHTML = ''; });

describe('the "was <old name>" note', () => {
  it('says what the name was stored as, beside the pencil', () => {
    const { el } = mount({ was: 'Prsson' });
    const note = el.querySelector('.sch-hint');
    expect(note?.textContent?.trim()).toBe('was Prsson');
  });

  it('is absent when nothing was renamed', () => {
    expect(mount({ was: null }).el.querySelector('.sch-hint')).toBeNull();
    expect(mount().el.querySelector('.sch-hint')).toBeNull();
  });

  it('is said in German and Polish too', () => {
    for (const lang of ['de', 'pl'] as const) {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ imports: [SchemaTypeNameComponent, getTranslocoModule({ translation: { en: dictionary(lang) } })] });
      const f = TestBed.createComponent(SchemaTypeNameComponent);
      f.componentRef.setInput('name', 'x'); f.componentRef.setInput('rename', () => null); f.componentRef.setInput('was', 'old');
      f.detectChanges();
      expect((f.nativeElement as HTMLElement).querySelector('.sch-hint')?.textContent?.trim()).toBe(dictionary(lang)['spaces.schema.was']!.replace('{{name}}', 'old'));
    }
  });

  it('shows no raw key and does not interpolate the name as markup', () => {
    const { el } = mount({ was: '<img src=x onerror=alert(1)>' });
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.sch-hint')?.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('the words are the host\'s to choose, and the type\'s stay the default', () => {
  it('a type: the input and the pencil say "Rename this type"', () => {
    const { fixture, pencil, input } = mount();
    expect(pencil()?.getAttribute('aria-label')).toBe(EN['spaces.schema.renameType']);
    expect(pencil()?.getAttribute('title')).toBe(EN['spaces.schema.renameType']);
    pencil()!.click();
    fixture.detectChanges();
    expect(input()?.getAttribute('aria-label')).toBe(EN['spaces.schema.renameType']);
  });

  it('a property: the pencil and the input say which property, by its key', () => {
    const { fixture, pencil, input } = mount({
      name: 'company', labelKey: 'spaces.schema.renamePropAria', labelParams: { key: 'company' }, titleKey: 'spaces.schema.renameProp',
    });
    expect(pencil()?.getAttribute('aria-label')).toBe('Rename the property company');
    expect(pencil()?.getAttribute('title')).toBe('Rename this property');
    pencil()!.click();
    fixture.detectChanges();
    expect(input()?.getAttribute('aria-label')).toBe('Rename the property company');
  });

  it('a property refused is said in the property\'s words, not the type\'s', () => {
    const { fixture, pencil, input, type, key, el } = mount({ name: 'company', errorKeyPrefix: 'spaces.schema.renamePropError' }, () => 'exists');
    pencil()!.click();
    fixture.detectChanges();
    type('email');
    key('Enter');
    expect(input(), 'the field stays open holding what was typed').not.toBeNull();
    expect(input()!.value).toBe('email');
    const alert = el.querySelector('[role="alert"]');
    expect(alert?.textContent?.trim()).toBe(PROP_ERRORS['spaces.schema.renamePropError.exists']);
    expect(alert?.textContent).not.toMatch(/type/i);
  });

  it('a type refused is still said in the type\'s words', () => {
    const { fixture, pencil, type, key, el } = mount({}, () => 'exists');
    pencil()!.click();
    fixture.detectChanges();
    type('Task');
    key('Enter');
    expect(el.querySelector('[role="alert"]')?.textContent?.trim()).toBe(EN['spaces.schema.renameError.exists']);
  });

  it('the name takes the class the host gives it', () => {
    const { el } = mount({ nameClass: 'prop-name-key' });
    expect(el.querySelector('span.prop-name-key')?.textContent?.trim()).toBe('Person');
    expect(el.querySelector('span.dt')).toBeNull();
  });
});

describe('by keyboard', () => {
  it('the pencil is a button, so Tab reaches it and Enter or Space opens it', () => {
    const { pencil } = mount();
    expect(pencil()?.tagName).toBe('BUTTON');
    expect(pencil()?.getAttribute('type')).toBe('button');
    expect(pencil()?.tabIndex).toBe(0);
  });

  it('opening the field puts the cursor in it, with the name selected', () => {
    const { fixture, pencil, input } = mount();
    pencil()!.click();
    fixture.detectChanges();
    expect(document.activeElement).toBe(input());
    expect(input()!.selectionStart).toBe(0);
    expect(input()!.selectionEnd).toBe('Person'.length);
  });

  it('Enter commits the rename and puts focus back on the pencil', async () => {
    const seen: string[] = [];
    const { fixture, pencil, input, type, key } = mount({}, to => { seen.push(to); return null; });
    pencil()!.click();
    fixture.detectChanges();
    type('Human');
    key('Enter');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(seen).toEqual(['Human']);
    expect(input()).toBeNull();
    expect(document.activeElement).toBe(pencil());
  });

  it('Escape reverts: nothing is renamed, the field closes, focus goes back to the pencil', async () => {
    const seen: string[] = [];
    const { fixture, pencil, input, type, key } = mount({}, to => { seen.push(to); return null; });
    pencil()!.click();
    fixture.detectChanges();
    type('Human');
    key('Escape');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(seen).toEqual([]);
    expect(input()).toBeNull();
    expect(document.activeElement).toBe(pencil());
  });

  it('Escape does not reach the dialog around it, which would close the whole settings dialog', () => {
    const { fixture, el, pencil, type, key } = mount();
    let reached = 0;
    el.addEventListener('keydown', () => reached++);
    pencil()!.click();
    fixture.detectChanges();
    type('Human');
    key('Escape');
    expect(reached).toBe(0);
  });

  it('a click on the pencil or in the field does not reach the row it sits in (a property row opens on click)', () => {
    const { fixture, el, pencil, input } = mount();
    let reached = 0;
    el.addEventListener('click', () => reached++);
    pencil()!.click();
    fixture.detectChanges();
    input()!.click();
    expect(reached).toBe(0);
  });
});
