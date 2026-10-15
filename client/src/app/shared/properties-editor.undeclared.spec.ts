/**
 * PropertiesEditorComponent under bundle-23 (Q-93, plan R6-14): a stored key the type does not declare is SHOWN, marked
 * and removable — never silently dropped — and the editor follows its inputs.
 *
 * ## Why these are written against the rendered rows
 *
 * The editor is a form control. What a person experiences is the rows on screen (which key, marked or not, what the
 * input is called to a screen reader), and what the parent receives through `valueChange`. A spec on the component's
 * private `rows` array would pass for a component that renders something else.
 *
 * ## What each group pins
 *
 * - **Visible.** Under strict a record with a key the type does not declare is refused, so a key that is stored but
 *   invisible is a record nobody can fix. The row carries `[data-undeclared]` and the words of
 *   `propertiesEditor.notDeclared`, asserted in the SHIPPED English (`locale('en')`), because a key missing from the
 *   file renders as the raw key and an assertion on the echoed key would pass for it.
 * - **Open type.** An absent or empty schema declares nothing, so nothing is "not declared" — marking every row of an
 *   open type would cry wolf on every record of every space that never declared a type.
 * - **Typed by hand.** A key typed into a new row is marked as soon as it is typed, before the save that would be refused.
 * - **Accessible.** Name inputs and value inputs carry a name (not a placeholder), and a refusal on a key reaches that
 *   key's value input as `aria-invalid` + `aria-describedby`.
 * - **Rebuilds.** Today `ngOnInit` reads `value` once, so after a type change the editor shows the old type's rows.
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PropertySchema } from '../core/api.types';
import { getTranslocoModule } from '../testing/transloco-testing';
import { locale } from '../testing/files-page-harness';
import { PropertiesEditorComponent } from './properties-editor.component';

type Props = Record<string, string | number | boolean>;
type Schema = Record<string, PropertySchema>;

const PERSON: Schema = {
  name: { required: true },
  role: { enum: ['dev', 'ops'] },
  age: { type: 'number' },
  active: { type: 'boolean' },
  born: { type: 'date' },
};
const COMPANY: Schema = { industry: {}, size: { type: 'number' } };

function make(inputs: { schema?: Schema; value?: Props; required?: string[]; errors?: Record<string, string> } = {}) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [PropertiesEditorComponent, getTranslocoModule({ translation: { en: locale('en') } })],
  });
  const fixture = TestBed.createComponent(PropertiesEditorComponent);
  setInputs(fixture, inputs);
  const emitted: Props[] = [];
  fixture.componentInstance.valueChange.subscribe(v => emitted.push(v));
  fixture.detectChanges();
  return { fixture, emitted, el: fixture.nativeElement as HTMLElement };
}

/**
 * `setInput` on an input the component does not declare THROWS (NG0303). `errors` is the input this bundle adds, so on
 * the unchanged base a throw here would turn every test that passes it into a setup error instead of the failed
 * expectation it is meant to be (no `aria-invalid` on the value input). Swallowing it keeps the red where the plan puts it.
 */
function setInputs(fixture: ComponentFixture<PropertiesEditorComponent>, inputs: Record<string, unknown>): void {
  for (const [name, v] of Object.entries(inputs)) {
    try { fixture.componentRef.setInput(name, v); } catch { /* an input the component does not have yet */ }
  }
}

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let i = 0; i < 3; i++) { fixture.detectChanges(); await fixture.whenStable(); }
  fixture.detectChanges();
}

const rows = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>('.prop-row')];
const keyInput = (row: HTMLElement) => row.querySelector<HTMLInputElement>('.prop-key')!;
const valInput = (row: HTMLElement) => row.querySelector<HTMLInputElement | HTMLSelectElement>('.prop-val')!;
const rowOf = (el: HTMLElement, key: string): HTMLElement | undefined => rows(el).find(r => keyInput(r).value === key);
const keysOnScreen = (el: HTMLElement): string[] => rows(el).map(r => keyInput(r).value);
const marked = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>('[data-undeclared]')];

/** The row a mark belongs to, whether the attribute sits on the row itself or on an element inside it. */
const rowHolding = (_el: HTMLElement, mark: HTMLElement): HTMLElement | null => mark.closest<HTMLElement>('.prop-row');

function type(input: HTMLInputElement, text: string): void {
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The accessible name of a control: aria-label, aria-labelledby, an associated or wrapping label. Never the placeholder. */
function accessibleName(el: Element): string {
  const own = el.getAttribute('aria-label')?.trim();
  if (own) return own;
  const doc = el.ownerDocument;
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const text = by.split(/\s+/).map(id => doc.getElementById(id)?.textContent?.trim() ?? '').join(' ').trim();
    if (text) return text;
  }
  if (el.id) {
    const label = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label?.textContent?.trim()) return label.textContent.trim();
  }
  return el.closest('label')?.textContent?.trim() ?? '';
}

beforeEach(() => TestBed.resetTestingModule());

describe('the words for "not declared" exist in every shipped language', () => {
  it('propertiesEditor.notDeclared is English that says it', () => {
    expect(locale('en')['propertiesEditor.notDeclared'] ?? '').toMatch(/not declared/i);
  });

  it('and in every other shipped locale, non-empty and not the English copied over', () => {
    const dir = resolve(__dirname, '../../../public/assets/i18n');
    const others = readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'en.json').map(f => f.replace(/\.json$/, ''));
    expect(others.length, 'the locale files could not be listed').toBeGreaterThanOrEqual(2);
    const en = locale('en')['propertiesEditor.notDeclared'];
    for (const name of others) {
      const text = locale(name)['propertiesEditor.notDeclared'];
      expect(text, `${name}.json has no propertiesEditor.notDeclared`).toBeTruthy();
      expect(text, `${name}.json carries the English sentence untranslated`).not.toBe(en);
    }
  });
});

describe('a stored key the type does not declare stays visible and is marked', () => {
  it('shows every stored key, declared or not, and marks exactly the undeclared one', async () => {
    const { fixture, el } = make({ schema: PERSON, value: { name: 'Ann', legacy: 'x', role: 'dev' } });
    await settle(fixture);
    expect(keysOnScreen(el).sort()).toEqual(['legacy', 'name', 'role']);
    const marks = marked(el);
    expect(marks.length, 'no row is marked [data-undeclared]').toBe(1);
    expect(keyInput(rowHolding(el, marks[0])!).value).toBe('legacy');
  });

  it('says "not declared" in the marked row, in words (shipped English)', async () => {
    const { fixture, el } = make({ schema: PERSON, value: { name: 'Ann', legacy: 'x' } });
    await settle(fixture);
    const mark = marked(el)[0];
    expect(mark, 'no row is marked [data-undeclared]').toBeTruthy();
    expect(rowHolding(el, mark)!.textContent ?? '').toMatch(/not declared/i);
    // …and only that row: a declared key is not labelled.
    expect(rowOf(el, 'name')!.textContent ?? '').not.toMatch(/not declared/i);
  });

  it('gives the marked row a remove action named for a screen reader, and removing it emits the rest', async () => {
    const { fixture, el, emitted } = make({ schema: PERSON, value: { name: 'Ann', legacy: 'x' } });
    await settle(fixture);
    const row = rowOf(el, 'legacy')!;
    const remove = row.querySelector<HTMLButtonElement>('button.prop-remove, button[data-remove]')!;
    expect(remove, 'the undeclared row has no remove button').toBeTruthy();
    expect(remove.getAttribute('aria-label')?.trim(), 'a title alone is not an accessible name').toBeTruthy();
    remove.click();
    await settle(fixture);
    expect(keysOnScreen(el)).toEqual(['name']);
    expect(emitted.at(-1)).toEqual({ name: 'Ann' });
  });

  it('keeps a stored undeclared key in what it emits when another row is edited (never drops it silently)', async () => {
    const { fixture, el, emitted } = make({ schema: PERSON, value: { name: 'Ann', legacy: 'x' } });
    await settle(fixture);
    type(valInput(rowOf(el, 'name')!) as HTMLInputElement, 'Bea');
    await settle(fixture);
    expect(emitted.at(-1)).toEqual({ name: 'Bea', legacy: 'x' });
  });

  it('marks a stored key the moment the schema input stops declaring it', async () => {
    const { fixture, el } = make({ schema: PERSON, value: { name: 'Ann', role: 'dev' } });
    await settle(fixture);
    expect(marked(el)).toHaveLength(0);
    setInputs(fixture, { schema: { name: { required: true } } });
    await settle(fixture);
    expect(keysOnScreen(el).sort()).toEqual(['name', 'role']);
    expect(marked(el).map(m => keyInput(rowHolding(el, m)!).value)).toEqual(['role']);
  });
});

describe('a key typed by hand is marked before anything is saved', () => {
  it('marks a typed key the schema does not declare, and unmarks it when it becomes a declared one', async () => {
    const { fixture, el } = make({ schema: PERSON, value: { name: 'Ann' } });
    await settle(fixture);
    (el.querySelector('.prop-add') as HTMLButtonElement).click();
    await settle(fixture);
    const fresh = rows(el).at(-1)!;
    type(keyInput(fresh), 'nicknam');
    await settle(fixture);
    expect(marked(el).map(m => keyInput(rowHolding(el, m)!).value), 'the typed key is not marked').toEqual(['nicknam']);
    expect(rowHolding(el, marked(el)[0])!.textContent ?? '').toMatch(/not declared/i);

    type(keyInput(rows(el).at(-1)!), 'born');
    await settle(fixture);
    expect(marked(el), 'a declared key must not stay marked').toHaveLength(0);
  });
});

describe('an open type marks nothing', () => {
  it('no schema: nothing is marked, whatever the keys', async () => {
    const { fixture, el } = make({ value: { anything: 'a', goes: 'b' } });
    await settle(fixture);
    expect(keysOnScreen(el)).toEqual(['anything', 'goes']);
    expect(marked(el)).toHaveLength(0);
  });

  it('an empty schema is the same open type', async () => {
    const { fixture, el } = make({ schema: {}, value: { anything: 'a' } });
    await settle(fixture);
    expect(marked(el)).toHaveLength(0);
    (el.querySelector('.prop-add') as HTMLButtonElement).click();
    await settle(fixture);
    type(keyInput(rows(el).at(-1)!), 'typed');
    await settle(fixture);
    expect(marked(el)).toHaveLength(0);
  });
});

describe('a refusal on a property reaches that property\'s input', () => {
  it('sets aria-invalid and an aria-describedby that resolves to the message, on that key\'s value input only', async () => {
    const { fixture, el } = make({
      schema: PERSON,
      value: { name: 'Ann', legacy: 'x' },
      errors: { legacy: 'property \'legacy\' is not declared on this type' },
    });
    await settle(fixture);
    const bad = valInput(rowOf(el, 'legacy')!);
    expect(bad.getAttribute('aria-invalid'), 'the refused property\'s input is not aria-invalid').toBe('true');
    const ids = (bad.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    expect(ids.length, 'no aria-describedby on the refused property\'s input').toBeGreaterThan(0);
    const described = ids.map(id => el.ownerDocument.getElementById(id)?.textContent ?? '').join(' ');
    expect(described).toContain('is not declared on this type');

    const ok = valInput(rowOf(el, 'name')!);
    expect(ok.getAttribute('aria-invalid')).not.toBe('true');
    expect((ok.getAttribute('aria-describedby') ?? '')).not.toContain(ids[0]);
  });

  it('follows the errors input: cleared errors clear the attributes', async () => {
    const { fixture, el } = make({ schema: PERSON, value: { name: 'Ann' }, errors: { name: 'is required' } });
    await settle(fixture);
    expect(valInput(rowOf(el, 'name')!).getAttribute('aria-invalid')).toBe('true');
    setInputs(fixture, { errors: {} });
    await settle(fixture);
    expect(valInput(rowOf(el, 'name')!).getAttribute('aria-invalid')).not.toBe('true');
  });
});

describe('every control has an accessible name, not a placeholder', () => {
  it('names the key input and the value input of every row, whatever the value control is', async () => {
    const { fixture, el } = make({
      schema: PERSON,
      value: { name: 'Ann', role: 'dev', age: 3, active: true, born: '2020-01-01', legacy: 'x' },
    });
    await settle(fixture);
    expect(rows(el).length, 'a row per key').toBe(6);
    const unnamed: string[] = [];
    for (const r of rows(el)) {
      const key = keyInput(r).value;
      for (const [what, control] of [['key', keyInput(r)], ['value', valInput(r)]] as const) {
        const name = accessibleName(control);
        const placeholder = control.getAttribute('placeholder') ?? '';
        if (!name || name === placeholder) unnamed.push(`${key} ${what}`);
      }
    }
    expect(unnamed, 'controls with no accessible name (a placeholder is not one)').toEqual([]);
  });

  it('gives the remove button of every removable row an aria-label (a title is not enough)', async () => {
    const { fixture, el } = make({ schema: PERSON, value: { name: 'Ann', role: 'dev', legacy: 'x' }, required: ['name'] });
    await settle(fixture);
    const removes = [...el.querySelectorAll<HTMLButtonElement>('button.prop-remove')];
    expect(removes.length).toBeGreaterThanOrEqual(2);
    for (const b of removes) expect(b.getAttribute('aria-label')?.trim(), 'remove button without aria-label').toBeTruthy();
  });
});

describe('the editor rebuilds when its inputs change', () => {
  it('shows the new value after the `value` input changes (a type change hands it a different object)', async () => {
    const { fixture, el } = make({ schema: PERSON, value: { name: 'Ann', role: 'dev' } });
    await settle(fixture);
    expect(keysOnScreen(el).sort()).toEqual(['name', 'role']);
    setInputs(fixture, { schema: COMPANY, value: { industry: '', size: 0 } });
    await settle(fixture);
    expect(keysOnScreen(el).sort(), 'the editor still shows the previous type\'s rows').toEqual(['industry', 'size']);
  });

  it('shows the value\'s DISPLAYED text for the rebuilt rows, not the old rows\' values', async () => {
    const { fixture, el } = make({ schema: COMPANY, value: { industry: 'first' } });
    await settle(fixture);
    setInputs(fixture, { value: { industry: 'second' } });
    await settle(fixture);
    expect(valInput(rowOf(el, 'industry')!).value).toBe('second');
  });

  it('does not rebuild on the echo of its own emission: a blank row the person just added survives', async () => {
    // Two-way binding hands every emitted object straight back as the next `value`. A rebuild on that echo would
    // delete the empty row mid-typing, which is the failure the fix for the stale-rows bug must not introduce.
    const { fixture, el, emitted } = make({ schema: COMPANY, value: { industry: 'x' } });
    await settle(fixture);
    (el.querySelector('.prop-add') as HTMLButtonElement).click();
    await settle(fixture);
    expect(rows(el)).toHaveLength(2);
    type(valInput(rowOf(el, 'industry')!) as HTMLInputElement, 'y');
    await settle(fixture);
    expect(emitted.at(-1)).toEqual({ industry: 'y' });
    setInputs(fixture, { value: emitted.at(-1) });
    await settle(fixture);
    expect(rows(el), 'the blank row was thrown away by the echo').toHaveLength(2);
  });

  it('keeps emitting through the new rows after a rebuild', async () => {
    const { fixture, el, emitted } = make({ schema: PERSON, value: { name: 'Ann' } });
    await settle(fixture);
    setInputs(fixture, { schema: COMPANY, value: { industry: '' } });
    await settle(fixture);
    expect(keysOnScreen(el), 'the editor still shows the previous type\'s rows').toEqual(['industry']);
    type(valInput(rowOf(el, 'industry')!) as HTMLInputElement, 'steel');
    await settle(fixture);
    expect(emitted.at(-1)).toEqual({ industry: 'steel' });
  });
});
