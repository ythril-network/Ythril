/**
 * The step editor behind "Edit steps" (bundle-285 slice S5, Q-747; plan sections 3.1 item 5, 5 rows E1 to E8, 9; drawing moments 1c, 2a, 2b, 6).
 *
 * One row per step as drawn, and the rules the drawing cannot show:
 *
 * - each of the four rows (rename a property, rename the type, map a value, split by a condition) has the fields it is drawn with and an
 *   accessible name on every control, and a remove button that says WHICH step it removes;
 * - a split's target picker lists the kind's other types, never the type being split, and ends with "Add a new type..."; choosing it asks for a
 *   name in place, and a confirmed name is a type added to the schema as a COPY of the source (reported to the host, which owns the schema);
 * - a split's cases say "counted as it runs" at every size, never a number: no door counts a condition over the records (owner, 2026-11-19);
 * - a row's refusal (the sentence of the server, by the index it named) is under its own row as an alert and takes focus;
 * - a bound the server also refuses is not offered: the step cap, the case cap, the value cap and the longest name or condition;
 * - Escape inside the new-type name closes THAT field only (the innermost layer), never the dialog around the editor;
 * - every name is bound as text: a peer-authored type or property name with markup in it is text.
 *
 * The words are markers (`ED-OLD-NAME`), so no assertion depends on the English wording and a key the editor forgot shows as a raw key.
 *
 * ## Seen red
 *
 * Red at beabdcccb: `pages/settings/convert-step-editor.component.ts` does not exist.
 */
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { CONVERSION_LIMITS } from '../../shared/conversion-limits';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { ConvertStepEditorComponent } from './convert-step-editor.component';
import type { AddedType, ConvertSchemas, EditStep } from './convert-steps';

const WORDS: Record<string, string> = {
  'conversion.editor.renameProperty': 'ED-RENAME-PROP',
  'conversion.editor.renameType': 'ED-RENAME-TYPE',
  'conversion.editor.mapEnum': 'ED-MAP',
  'conversion.editor.splitType': 'ED-SPLIT',
  'conversion.editor.on': 'ED-ON',
  'conversion.editor.to': 'ED-TO',
  'conversion.editor.in': 'ED-IN',
  'conversion.editor.becomes': 'ED-BECOMES',
  'conversion.editor.recordsOf': 'ED-RECORDS-OF',
  'conversion.editor.if': 'ED-IF',
  'conversion.editor.otherwise': 'ED-OTHERWISE',
  'conversion.editor.addCondition': 'ED-ADD-CONDITION',
  'conversion.editor.countedAsItRuns': 'ED-COUNTED-AS-IT-RUNS',
  'conversion.editor.help': 'ED-HELP',
  'conversion.editor.addStep': 'ED-ADD-STEP',
  'conversion.editor.remove': 'ED-REMOVE',
  'conversion.editor.removeAria': 'ED-REMOVE-ARIA {{what}}',
  'conversion.editor.addNewType': 'ED-ADD-NEW-TYPE',
  'conversion.editor.newTypeName': 'ED-NEW-TYPE-NAME',
  'conversion.editor.oldName': 'ED-OLD-NAME',
  'conversion.editor.newName': 'ED-NEW-NAME',
  'conversion.editor.oldTypeName': 'ED-OLD-TYPE-NAME',
  'conversion.editor.newTypeNameField': 'ED-NEW-TYPE-NAME-FIELD',
  'conversion.editor.property': 'ED-PROPERTY',
  'conversion.editor.oldValue': 'ED-OLD-VALUE',
  'conversion.editor.newValue': 'ED-NEW-VALUE',
  'conversion.editor.condition': 'ED-CONDITION',
  'conversion.editor.becomesType': 'ED-BECOMES-TYPE',
  'conversion.editor.typeToSplit': 'ED-TYPE-TO-SPLIT',
  'conversion.editor.addValue': 'ED-ADD-VALUE',
  'conversion.editor.removeValue': 'ED-REMOVE-VALUE',
  'spaces.schema.renameError.empty': 'ED-ERR-EMPTY',
  'spaces.schema.renameError.exists': 'ED-ERR-EXISTS',
};

const STAGED: ConvertSchemas = {
  entity: {
    contact: { propertySchemas: { status: { type: 'string', enum: ['current', 'prospect', 'inactive'] }, kind: { type: 'string' } } },
    organization: {},
    person: {},
  },
  fact: { contact: {} },
};

const rename: EditStep = { op: 'renameProperty', kind: 'entity', type: 'contact', from: 'company', to: 'employer' };
const retype: EditStep = { op: 'renameType', kind: 'entity', from: 'client', to: 'customer' };
const map: EditStep = { op: 'mapEnum', kind: 'entity', type: 'contact', property: 'status', pairs: [{ from: 'active', to: 'current' }, { from: 'lead', to: 'prospect' }] };
const split: EditStep = { op: 'splitType', kind: 'entity', from: 'contact', cases: [{ when: 'properties.kind == "org"', to: 'organization' }], otherwise: 'person' };

describe('the step editor', () => {
  let fixture: ComponentFixture<ConvertStepEditorComponent>;
  let emitted: EditStep[][];
  let added: AddedType[];

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [ConvertStepEditorComponent, getTranslocoModule({ translation: { en: WORDS } })] });
  });

  function mount(steps: EditStep[], over: { staged?: ConvertSchemas; canAddStep?: boolean; errors?: Record<number, string>; focusError?: number | null } = {}): HTMLElement {
    fixture = TestBed.createComponent(ConvertStepEditorComponent);
    emitted = [];
    added = [];
    fixture.componentInstance.stepsChange.subscribe(s => emitted.push(s));
    fixture.componentInstance.typeAdded.subscribe(t => added.push(t));
    fixture.componentRef.setInput('steps', steps);
    fixture.componentRef.setInput('kind', 'entity');
    fixture.componentRef.setInput('type', 'contact');
    fixture.componentRef.setInput('staged', over.staged ?? STAGED);
    if (over.canAddStep !== undefined) fixture.componentRef.setInput('canAddStep', over.canAddStep);
    if (over.errors) fixture.componentRef.setInput('errors', over.errors);
    if (over.focusError !== undefined) fixture.componentRef.setInput('focusError', over.focusError);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  const rowsOf = (host: HTMLElement): HTMLElement[] => Array.from(host.querySelectorAll<HTMLElement>('li.cv-step'));
  const byLabel = <T extends HTMLElement>(root: ParentNode, label: string): T[] => Array.from(root.querySelectorAll<T>(`[aria-label="${label}"]`));
  const typeInto = (el: HTMLInputElement, value: string): void => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); };
  const press = (el: Element, key: string): KeyboardEvent => {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e;
  };
  const chooseOption = (select: HTMLSelectElement, text: string): void => {
    const at = Array.from(select.options).findIndex(o => o.textContent?.trim() === text);
    expect(at, `an option "${text}"`).toBeGreaterThanOrEqual(0);
    select.selectedIndex = at;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const lastEmitted = (): EditStep[] => emitted[emitted.length - 1]!;

  describe('rename a property (E1)', () => {
    it('shows the verb, "on <type>", the old name, "to" and the new name, each control with its own name', () => {
      const host = mount([rename]);
      const [row] = rowsOf(host);
      expect(row!.textContent).toContain('ED-RENAME-PROP');
      expect(row!.textContent).toContain('ED-ON');
      expect(row!.textContent).toContain('ED-TO');
      expect(row!.querySelector('.cv-tn')?.textContent).toBe('contact');
      expect((byLabel<HTMLInputElement>(row!, 'ED-OLD-NAME')[0]!).value).toBe('company');
      expect((byLabel<HTMLInputElement>(row!, 'ED-NEW-NAME')[0]!).value).toBe('employer');
    });

    it('a changed name is reported as the whole new list, the other rows untouched', () => {
      const host = mount([rename, retype]);
      typeInto(byLabel<HTMLInputElement>(rowsOf(host)[0]!, 'ED-NEW-NAME')[0]!, 'boss');
      expect(lastEmitted()).toEqual([{ ...rename, to: 'boss' }, retype]);
    });

    it('limits a name to the longest the server takes', () => {
      const host = mount([rename]);
      expect(byLabel<HTMLInputElement>(rowsOf(host)[0]!, 'ED-OLD-NAME')[0]!.maxLength).toBe(CONVERSION_LIMITS.typeNameMax);
    });
  });

  describe('rename the type (E2)', () => {
    it('shows the old type name, "to" and the new one', () => {
      const host = mount([retype]);
      const [row] = rowsOf(host);
      expect(row!.textContent).toContain('ED-RENAME-TYPE');
      expect(byLabel<HTMLInputElement>(row!, 'ED-OLD-TYPE-NAME')[0]!.value).toBe('client');
      expect(byLabel<HTMLInputElement>(row!, 'ED-NEW-TYPE-NAME-FIELD')[0]!.value).toBe('customer');
    });
  });

  describe('map a value (E3)', () => {
    it('shows "in <property>", "on <type>" and a row per old value with "becomes" and a picker of the staged enum\'s values', () => {
      const host = mount([map]);
      const [row] = rowsOf(host);
      expect(row!.textContent).toContain('ED-MAP');
      expect(byLabel<HTMLInputElement>(row!, 'ED-PROPERTY')[0]!.value).toBe('status');
      expect(byLabel<HTMLInputElement>(row!, 'ED-OLD-VALUE').map(i => i.value)).toEqual(['active', 'lead']);
      const pickers = byLabel<HTMLSelectElement>(row!, 'ED-NEW-VALUE');
      expect(pickers.map(p => p.value)).toEqual(['current', 'prospect']);
      expect(Array.from(pickers[0]!.options).map(o => o.textContent?.trim())).toEqual(['current', 'prospect', 'inactive']);
    });

    it('a choice is reported as the new list', () => {
      const host = mount([map]);
      chooseOption(byLabel<HTMLSelectElement>(rowsOf(host)[0]!, 'ED-NEW-VALUE')[1]!, 'inactive');
      expect(lastEmitted()).toEqual([{ ...map, pairs: [{ from: 'active', to: 'current' }, { from: 'lead', to: 'inactive' }] }]);
    });

    it('an offered row with no target yet shows an empty picker, not a value it made up', () => {
      const offered: EditStep = { op: 'mapEnum', kind: 'entity', type: 'contact', property: 'status', pairs: [{ from: 'lead', to: '' }] };
      const host = mount([offered]);
      const picker = byLabel<HTMLSelectElement>(rowsOf(host)[0]!, 'ED-NEW-VALUE')[0]!;
      expect(picker.value).toBe('');
      expect(picker.options[picker.selectedIndex]!.textContent?.trim()).toBe('');
    });

    it('adds a value, removes one, and stops adding at the most one map may hold', () => {
      const host = mount([map]);
      const row = rowsOf(host)[0]!;
      (byLabel<HTMLButtonElement>(row, 'ED-ADD-VALUE')[0]!).click();
      expect(lastEmitted()).toEqual([{ ...map, pairs: [...(map as { pairs: { from: string; to: string }[] }).pairs, { from: '', to: '' }] }]);
      (byLabel<HTMLButtonElement>(row, 'ED-REMOVE-VALUE')[0]!).click();
      expect(lastEmitted()).toEqual([{ ...map, pairs: [{ from: 'lead', to: 'prospect' }] }]);
      const many: EditStep = { ...map, pairs: Array.from({ length: CONVERSION_LIMITS.valuesMax }, (_, i) => ({ from: `v${i}`, to: 'current' })) } as EditStep;
      const full = mount([many]);
      expect(byLabel<HTMLButtonElement>(rowsOf(full)[0]!, 'ED-ADD-VALUE')[0]!.disabled).toBe(true);
    });
  });

  describe('split by a condition (E4, E5)', () => {
    it('shows "records of <type>", each case as "if <condition> becomes <type>", the otherwise, "+ Add a condition" and the help text', () => {
      const host = mount([split]);
      const [row] = rowsOf(host);
      expect(row!.textContent).toContain('ED-SPLIT');
      expect(row!.textContent).toContain('ED-RECORDS-OF');
      expect(byLabel<HTMLInputElement>(row!, 'ED-TYPE-TO-SPLIT')[0]!.value).toBe('contact');
      expect(byLabel<HTMLInputElement>(row!, 'ED-CONDITION').map(i => i.value)).toEqual(['properties.kind == "org"']);
      const targets = byLabel<HTMLSelectElement>(row!, 'ED-BECOMES-TYPE');
      expect(targets.map(t => t.value)).toEqual(['organization', 'person']);
      expect(row!.textContent).toContain('ED-IF');
      expect(row!.textContent).toContain('ED-OTHERWISE');
      expect(row!.textContent).toContain('ED-ADD-CONDITION');
      expect(row!.textContent).toContain('ED-HELP');
    });

    it('the type being split is fixed by its block: the field is read-only, so no edit makes the step belong to another type', () => {
      const host = mount([split]);
      expect(byLabel<HTMLInputElement>(rowsOf(host)[0]!, 'ED-TYPE-TO-SPLIT')[0]!.readOnly).toBe(true);
    });

    it('says "counted as it runs" for every case and for the otherwise, and never a number', () => {
      const host = mount([{ ...split, cases: [...(split as { cases: { when: string; to: string }[] }).cases, { when: 'properties.kind == "x"', to: 'person' }] } as EditStep]);
      const row = rowsOf(host)[0]!;
      expect(row.textContent!.split('ED-COUNTED-AS-IT-RUNS').length - 1).toBe(3);
      expect(row.textContent).not.toMatch(/matches|left over|\d{2,}/);
    });

    it('lists the kind\'s other types in the picker, never the type being split, and ends with the add option', () => {
      const host = mount([split]);
      const options = Array.from(byLabel<HTMLSelectElement>(rowsOf(host)[0]!, 'ED-BECOMES-TYPE')[0]!.options);
      const texts = options.map(o => o.textContent?.trim());
      expect(texts).toEqual(['organization', 'person', 'ED-ADD-NEW-TYPE']);
      expect(texts).not.toContain('contact');
      expect(options[options.length - 1]!.hasAttribute('data-add')).toBe(true);
    });

    it('does not offer the types of another kind (a fact named like the entity is not a target)', () => {
      const host = mount([split], { staged: { entity: { contact: {}, organization: {} }, fact: { elsewhere: {} } } });
      const texts = Array.from(byLabel<HTMLSelectElement>(rowsOf(host)[0]!, 'ED-BECOMES-TYPE')[0]!.options).map(o => o.textContent?.trim());
      expect(texts).toEqual(['organization', 'ED-ADD-NEW-TYPE']);
    });

    it('adds a condition, and stops at the most cases one split may hold', () => {
      const host = mount([split]);
      Array.from(rowsOf(host)[0]!.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent?.includes('ED-ADD-CONDITION'))!.click();
      const after = lastEmitted()[0] as Extract<EditStep, { op: 'splitType' }>;
      expect(after.cases).toHaveLength(2);
      expect(after.cases[1]).toEqual({ when: '', to: '' });
      const cases = Array.from({ length: CONVERSION_LIMITS.casesMax }, (_, i) => ({ when: `a == ${i}`, to: 'person' }));
      const full = mount([{ ...split, cases } as EditStep]);
      const button = Array.from(rowsOf(full)[0]!.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent?.includes('ED-ADD-CONDITION'))!;
      expect(button.disabled).toBe(true);
    });

    it('limits a condition to the longest the server takes', () => {
      const host = mount([split]);
      expect(byLabel<HTMLInputElement>(rowsOf(host)[0]!, 'ED-CONDITION')[0]!.maxLength).toBe(CONVERSION_LIMITS.conditionMax);
    });
  });

  describe('Add a new type (E5)', () => {
    function chooseAdd(host: HTMLElement): HTMLSelectElement {
      const picker = byLabel<HTMLSelectElement>(rowsOf(host)[0]!, 'ED-BECOMES-TYPE')[0]!;
      const at = Array.from(picker.options).findIndex(o => o.hasAttribute('data-add'));
      picker.selectedIndex = at;
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      fixture.detectChanges();
      return picker;
    }
    const nameField = (host: HTMLElement): HTMLInputElement | undefined => byLabel<HTMLInputElement>(host, 'ED-NEW-TYPE-NAME')[0];

    it('choosing it asks for a name in place and changes nothing yet', () => {
      const host = mount([split]);
      expect(nameField(host)).toBeUndefined();
      chooseAdd(host);
      expect(nameField(host)).toBeDefined();
      expect(emitted).toEqual([]);
      expect(added).toEqual([]);
    });

    it('a confirmed name is reported as a type added as a copy of the source, and becomes that case\'s target', () => {
      const host = mount([split]);
      chooseAdd(host);
      const field = nameField(host)!;
      field.value = 'partner';
      press(field, 'Enter');
      fixture.detectChanges();
      expect(added).toEqual([{ kind: 'entity', name: 'partner', copyOf: 'contact' }]);
      expect((lastEmitted()[0] as Extract<EditStep, { op: 'splitType' }>).cases[0]!.to).toBe('partner');
      expect(nameField(host)).toBeUndefined();
    });

    it('refuses an empty name and a name the kind already has, in words, and reports nothing', () => {
      const host = mount([split]);
      chooseAdd(host);
      const field = nameField(host)!;
      field.value = '   ';
      press(field, 'Enter');
      fixture.detectChanges();
      expect(host.textContent).toContain('ED-ERR-EMPTY');
      field.value = 'person';
      press(field, 'Enter');
      fixture.detectChanges();
      expect(host.textContent).toContain('ED-ERR-EXISTS');
      expect(added).toEqual([]);
      expect(emitted).toEqual([]);
    });

    it('limits the name to the longest a type name may have', () => {
      const host = mount([split]);
      chooseAdd(host);
      expect(nameField(host)!.maxLength).toBe(CONVERSION_LIMITS.typeNameMax);
    });

    it('Escape closes the name field and stops there: the dialog around the editor never hears it', () => {
      const host = mount([split]);
      let heard = false;
      host.addEventListener('keydown', e => { if ((e as KeyboardEvent).key === 'Escape') heard = true; });
      chooseAdd(host);
      const field = nameField(host)!;
      press(field, 'Escape');
      fixture.detectChanges();
      expect(heard, 'the Escape bubbled out of the editor').toBe(false);
      expect(nameField(host)).toBeUndefined();
      expect(added).toEqual([]);
    });
  });

  describe('add and remove (E6, E7)', () => {
    const adders = (host: HTMLElement): HTMLButtonElement[] => Array.from(host.querySelectorAll<HTMLButtonElement>('.cv-add button'));

    it('offers the four kinds of step in a labelled group', () => {
      const host = mount([]);
      const group = host.querySelector('.cv-add')!;
      expect(group.getAttribute('role')).toBe('group');
      expect(group.getAttribute('aria-label')).toBe('ED-ADD-STEP');
      expect(adders(host).map(b => b.textContent?.trim())).toEqual(['ED-RENAME-PROP', 'ED-MAP', 'ED-RENAME-TYPE', 'ED-SPLIT']);
    });

    it('each adds a row of its kind, empty, for the block\'s kind and type', () => {
      const host = mount([]);
      adders(host)[0]!.click();
      expect(lastEmitted()).toEqual([{ op: 'renameProperty', kind: 'entity', type: 'contact', from: '', to: '' }]);
      adders(host)[1]!.click();
      expect(lastEmitted()).toEqual([{ op: 'mapEnum', kind: 'entity', type: 'contact', property: '', pairs: [{ from: '', to: '' }] }]);
      adders(host)[2]!.click();
      expect(lastEmitted()).toEqual([{ op: 'renameType', kind: 'entity', from: 'contact', to: '' }]);
      adders(host)[3]!.click();
      expect(lastEmitted()).toEqual([{ op: 'splitType', kind: 'entity', from: 'contact', cases: [{ when: '', to: '' }], otherwise: '' }]);
    });

    it('a new type step goes before the property steps: the order they are sent in', () => {
      const host = mount([rename]);
      adders(host)[2]!.click();
      expect(lastEmitted().map(s => s.op)).toEqual(['renameType', 'renameProperty']);
    });

    it('offers no second type step while the type has one: the server refuses two type steps on one type', () => {
      const withRename = mount([retype]);
      expect(adders(withRename).map(b => b.disabled)).toEqual([false, false, true, true]);
      const withSplit = mount([split]);
      expect(adders(withSplit).map(b => b.disabled)).toEqual([false, false, true, true]);
    });

    it('offers nothing at all when the conversion already holds the most steps it may', () => {
      const host = mount([], { canAddStep: false });
      expect(adders(host).every(b => b.disabled)).toBe(true);
    });

    it('a remove button names the step it removes, and removes only that row', () => {
      const host = mount([rename, retype]);
      const [first] = rowsOf(host);
      const remove = first!.querySelector<HTMLButtonElement>('button.icon-btn')!;
      expect(remove.title).toBe('ED-REMOVE');
      expect(remove.getAttribute('aria-label')).toBe('ED-REMOVE-ARIA company ED-TO employer');
      remove.click();
      expect(lastEmitted()).toEqual([retype]);
    });
  });

  describe('a refused row (E8)', () => {
    it('shows the server\'s sentence under its own row as an alert, and under no other', () => {
      const host = mount([rename, retype], { errors: { 1: 'the schema before does not declare it' } });
      const rows = rowsOf(host);
      expect(rows[0]!.querySelector('[role="alert"]')).toBeNull();
      expect(rows[1]!.querySelector('[role="alert"]')?.textContent?.trim()).toBe('the schema before does not declare it');
    });

    it('moves focus to the sentence of the row it was asked about', () => {
      const host = mount([rename, retype], { errors: { 1: 'x' }, focusError: 1 });
      fixture.detectChanges();
      const alert = rowsOf(host)[1]!.querySelector<HTMLElement>('[role="alert"]')!;
      expect(document.activeElement).toBe(alert);
    });
  });

  describe('names are text', () => {
    it('a peer-authored name with markup in it is shown as text and makes no element', () => {
      const evil = '<img src=x onerror=alert(1)>';
      const host = mount([{ op: 'renameProperty', kind: 'entity', type: evil, from: evil, to: evil }], {
        staged: { entity: { [evil]: {}, other: {} } },
      });
      expect(host.querySelector('img')).toBeNull();
      expect(rowsOf(host)[0]!.querySelector('.cv-tn')?.textContent).toBe(evil);
      expect(byLabel<HTMLInputElement>(rowsOf(host)[0]!, 'ED-OLD-NAME')[0]!.value).toBe(evil);
    });
  });

  describe('every control has a name', () => {
    it('no input, select or button of any row or of the add group is unnamed', () => {
      const host = mount([rename, retype, map, split]);
      const unnamed = Array.from(host.querySelectorAll<HTMLElement>('input, select, button'))
        .filter(el => !(el.getAttribute('aria-label') || (el.textContent ?? '').trim() || el.getAttribute('title')));
      expect(unnamed.map(el => el.outerHTML)).toEqual([]);
    });
  });
});
