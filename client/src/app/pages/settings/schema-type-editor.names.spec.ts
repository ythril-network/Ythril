/**
 * The editor's icon-only buttons say what they remove (bundle-285 slice S10, Q-747; the browser drive's D6).
 *
 * An enum value's chip is now the way to a conversion's map step (remove a value, Save, map it), and its remove button was an "x" with no name at
 * all: a screen reader said "button". Each chip's button is named "Remove <value>" and each property's remove button "Remove property <key>"
 * (it had a title only, which a reader may not announce).
 *
 * ## Seen red
 *
 * Red at c65fa1f51: `.chip-rm` has no `aria-label`; the property's remove button has none either.
 */
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { dictionary } from '../../testing/i18n-dictionary';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { SchemaTypeEditorComponent } from './schema-type-editor.component';
import { emptyTypeSchemaState } from './space-settings-state.service';

function mount(lang: 'en' | 'de' | 'pl' = 'en') {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [SchemaTypeEditorComponent, getTranslocoModule({ translation: { en: dictionary(lang) } })] });
  const fixture = TestBed.createComponent(SchemaTypeEditorComponent);
  document.body.appendChild(fixture.nativeElement);
  fixture.componentRef.setInput('knowledgeType', 'entity');
  fixture.componentRef.setInput('draft', emptyTypeSchemaState({
    propertySchemas: [
      { key: 'status', s: { type: 'string', enum: ['active', 'lead'] }, _enumInput: '', _stored: true },
      { key: 'company', s: { type: 'string' }, _enumInput: '', _stored: true },
    ],
  }));
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el };
}

/** Open a property's detail card, where its allowed values are chips. */
function openRow(m: ReturnType<typeof mount>, key: string): void {
  const row = [...m.el.querySelectorAll<HTMLElement>('tr.prop-row')].find(r => r.querySelector('.prop-name-key')?.textContent?.trim() === key);
  expect(row, `a row for ${key}`).toBeTruthy();
  row!.click();
  m.fixture.detectChanges();
}

afterEach(() => { document.body.innerHTML = ''; });

describe('the editor\'s remove buttons are named', () => {
  it('names each allowed value\'s remove button "Remove <value>"', () => {
    const m = mount();
    openRow(m, 'status');
    const names = [...m.el.querySelectorAll<HTMLButtonElement>('.chip-rm')].map(b => b.getAttribute('aria-label'));
    expect(names).toEqual(['Remove active', 'Remove lead']);
  });

  it('says it in German and Polish too, with the value in it', () => {
    for (const lang of ['de', 'pl'] as const) {
      const m = mount(lang);
      openRow(m, 'status');
      const name = m.el.querySelector<HTMLButtonElement>('.chip-rm')!.getAttribute('aria-label') ?? '';
      expect(name, lang).toContain('active');
      expect(name, lang).not.toMatch(/\{\{|spaces\.schema/);
    }
  });

  it('names each property\'s remove button by the property', () => {
    const m = mount();
    const names = [...m.el.querySelectorAll<HTMLButtonElement>('tr.prop-row button.icon-btn.danger')].map(b => b.getAttribute('aria-label'));
    expect(names).toEqual(['Remove property status', 'Remove property company']);
  });
});
