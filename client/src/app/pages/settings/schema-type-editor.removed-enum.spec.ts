/**
 * A stored enum value taken out in this sitting stays visible, struck, until the schema is saved (bundle-285 slice S10, Q-747; drawing moments
 * 1c and 2b, green-lit with it).
 *
 * The Save dialog asks what each removed value becomes; the struck chip shows the user beforehand what it will ask about, and puts the value
 * back. It is the view only: the staged schema (what Save sends) holds the value list as edited, so nothing struck reaches the wire. What was
 * stored is the S4 mechanism's: `markStored` (on open and on save) keeps a copy of each stored property's values (`_storedEnum`), the editor's
 * bookkeeping like `_stored` and `_was`.
 *
 * ## Seen red
 *
 * Red at 393932e3d: a removed value is gone from the chip list; `markStored` keeps no values.
 */
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { dictionary } from '../../testing/i18n-dictionary';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { SchemaTypeEditorComponent } from './schema-type-editor.component';
import { emptyTypeSchemaState, typeSchemaFromState, type TypeSchemaState } from './space-settings-state.service';
import { markStored } from './type-schema-edits';

const EN = dictionary('en');

/** A type as the space opened it: `status` with two stored values, marked stored the way the settings state does on open. */
function stored(): TypeSchemaState {
  const draft = emptyTypeSchemaState({ propertySchemas: [{ key: 'status', s: { type: 'string', enum: ['active', 'lead'] }, _enumInput: '' }] });
  markStored(draft);
  return draft;
}

function mount(draft: TypeSchemaState) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [SchemaTypeEditorComponent, getTranslocoModule({ translation: { en: EN } })] });
  const fixture = TestBed.createComponent(SchemaTypeEditorComponent);
  document.body.appendChild(fixture.nativeElement);
  fixture.componentRef.setInput('knowledgeType', 'entity');
  fixture.componentRef.setInput('draft', draft);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  el.querySelector<HTMLElement>('tr.prop-row')!.click();
  fixture.detectChanges();
  const live = () => [...el.querySelectorAll('.chip:not(.chip-gone)')].map(c => c.firstChild?.textContent?.trim());
  const struck = () => [...el.querySelectorAll<HTMLElement>('.chip-gone')];
  const remove = (v: string) => { el.querySelector<HTMLButtonElement>(`.chip-rm[aria-label="Remove ${v}"]`)!.click(); fixture.detectChanges(); };
  return { fixture, el, live, struck, remove };
}

afterEach(() => { document.body.innerHTML = ''; });

describe('a stored enum value removed in this sitting', () => {
  it('stays as a struck chip that says it was removed, with a control to put it back; the staged values and the wire do not hold it', () => {
    const draft = stored();
    const m = mount(draft);
    m.remove('lead');
    expect(m.live()).toEqual(['active']);
    const [chip] = m.struck();
    expect(chip, 'a struck chip').toBeTruthy();
    expect(chip!.querySelector('s')?.textContent?.trim()).toBe('lead');
    expect(chip!.textContent).toContain(EN['spaces.schema.propDetail.enumValueRemoved']!);
    expect(chip!.querySelector('button')?.getAttribute('aria-label')).toBe('Put back lead');
    expect(draft.propertySchemas[0]!.s.enum).toEqual(['active']);
    expect(JSON.stringify(typeSchemaFromState('entity', draft))).not.toMatch(/lead|_storedEnum/);
  });

  it('is readable: its text in the secondary text token (6.85:1 on the field), no dimming, the dashed outline and the strike carrying "removed" (drive round 5)', () => {
    const m = mount(stored());
    m.remove('lead');
    const rules = Array.from(document.styleSheets).flatMap(s => Array.from(s.cssRules)).map(r => r.cssText).filter(t => /\.chip-gone/.test(t));
    expect(rules.length, 'the struck chip has rules of its own').toBeGreaterThan(0);
    expect(rules.join('\n'), 'nothing dims the chip or its put-back sign').not.toMatch(/opacity/);
    expect(rules.some(r => /color:\s*var\(--text-secondary\)/.test(r) && !/\.chip-rm/.test(r)), 'the value reads in --text-secondary').toBe(true);
    expect(rules.some(r => /dashed/.test(r)), 'a dashed outline marks it removed').toBe(true);
    expect(rules.join('\n'), 'not the muted token, which the drive could not read on the accent tint').not.toMatch(/\.chip-gone s[^{]*\{[^}]*--text-muted/);
  });

  it('is put back in its stored place by its control, and is a live chip again', () => {
    const draft = stored();
    const m = mount(draft);
    m.remove('active');
    m.struck()[0]!.querySelector('button')!.click();
    m.fixture.detectChanges();
    expect(m.struck()).toHaveLength(0);
    expect(draft.propertySchemas[0]!.s.enum).toEqual(['active', 'lead']);
  });

  it('a value added and removed in the same sitting simply goes, and a save forgets what was removed', () => {
    const draft = stored();
    draft.propertySchemas[0]!.s = { ...draft.propertySchemas[0]!.s, enum: ['active', 'lead', 'new'] };
    const m = mount(draft);
    m.remove('new');
    expect(m.struck()).toHaveLength(0);
    m.remove('lead');
    expect(m.struck()).toHaveLength(1);
    markStored(draft);
    m.fixture.componentRef.setInput('draft', { ...draft });
    m.fixture.detectChanges();
    expect(m.struck(), 'after a save the removal is stored: nothing is struck').toHaveLength(0);
  });
});
