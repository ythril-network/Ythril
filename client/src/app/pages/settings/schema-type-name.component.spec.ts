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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLIENT_ROOT } from '../../testing/tracked-sources';
import * as nameModule from './schema-type-name.component';
import { SchemaTypeNameComponent } from './schema-type-name.component';

/** Read through the module so the spec runs (red) before the constants exist. */
const SCHEMA_TYPE_NAME_STYLES = (nameModule as Record<string, unknown>)['SCHEMA_TYPE_NAME_STYLES'] as string ?? '';
const TYPE_HEAD_STYLES = (nameModule as Record<string, unknown>)['TYPE_HEAD_STYLES'] as string ?? '';

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
    expect(alert?.textContent?.trim()).not.toBe(EN['spaces.schema.renameError.exists']);
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

/**
 * At 390 px a long type name pushed the head's buttons off screen and the pane scrolled sideways, and a "was" note made a property row wider
 * than its table (the browser drive's D7, bundle-285 slice S10). A spec cannot lay out a page; it pins the structure the fold rests on, and the
 * re-drive at 390 px shows the rest.
 */
describe('a long name at phone width', () => {
  /** The rules a style text holds, as the browser parses them: each `@media` block's condition with its rules' text, and the top-level rules. */
  function rulesOf(css: string): { media: string | null; text: string }[] {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const out: { media: string | null; text: string }[] = [];
    for (const rule of Array.from(style.sheet!.cssRules)) {
      if (rule instanceof CSSMediaRule) for (const inner of Array.from(rule.cssRules)) out.push({ media: rule.conditionText, text: inner.cssText });
      else out.push({ media: null, text: rule.cssText });
    }
    style.remove();
    return out;
  }
  const phone = (r: { media: string | null }): boolean => /max-width:\s*760px/.test(r.media ?? '');

  it('keeps the whole name reachable when it is cut: as the title, and as the text a screen reader reads', () => {
    const long = 'customer-support-conversation-transcript-segment';
    const { el } = mount({ name: long });
    const name = el.querySelector<HTMLElement>('.nm-text')!;
    expect(name.getAttribute('title')).toBe(long);
    expect(name.textContent!.trim()).toBe(long);
  });

  it('lets the name shrink only when asked to (`truncate`), and puts the "was" note on a line of its own at phone width', () => {
    const rules = rulesOf(SCHEMA_TYPE_NAME_STYLES);
    expect(rules.some(r => r.media === null && /:host\(\.truncate\)/.test(r.text) && /min-width:\s*0/.test(r.text)), 'the truncating control can shrink below its text').toBe(true);
    expect(rules.some(r => phone(r) && /\.sch-hint/.test(r.text) && /flex-basis:\s*100%/.test(r.text)), 'the note takes its own line on a phone').toBe(true);
  });

  /**
   * Round 2 of the drive: at 1440 px the property keys in the table were cut to stubs ("a…", "stat…"), because the shrink meant for the type head's
   * long name reached every use of the control. Every rule that clips (overflow, an ellipsis, a max width, a zero min width) belongs to the
   * truncating use only, and only the type head asks for it.
   */
  it('clips nothing by default: every clipping rule is scoped to the truncating use (drive round 2)', () => {
    const clipping = rulesOf(SCHEMA_TYPE_NAME_STYLES).filter(r => /overflow:\s*hidden|text-overflow|max-width|min-width:\s*0/.test(r.text));
    expect(clipping.length, 'the truncating rules exist').toBeGreaterThan(0);
    expect(clipping.filter(r => !/\.truncate/.test(r.text)).map(r => r.text)).toEqual([]);
  });

  it('marks its host as truncating only when the input says so; the property key in the table does not, the type head does', () => {
    expect(mount().el.classList.contains('truncate'), 'not by default').toBe(false);
    expect(mount({ truncate: true }).el.classList.contains('truncate')).toBe(true);
    const tab = readFileSync(resolve(CLIENT_ROOT, 'src/app/pages/settings/space-schema-tab.component.ts'), 'utf8');
    expect(tab).toMatch(/<app-schema-type-name\b[^>]*\[truncate\]="true"/);
    const editor = readFileSync(resolve(CLIENT_ROOT, 'src/app/pages/settings/schema-type-editor.component.ts'), 'utf8');
    const keyUse = /<app-schema-type-name\b[^>]*nameClass="prop-name-key"[^>]*>/.exec(editor)?.[0] ?? '';
    expect(keyUse, 'the property key use is found').not.toBe('');
    expect(keyUse).not.toMatch(/truncate/);
  });

  it('the type head lets its name shrink and folds its buttons onto another line at phone width, and the Schema tab draws with it', () => {
    const rules = rulesOf(TYPE_HEAD_STYLES);
    expect(rules.some(r => r.media === null && /\.sch-detail-head app-schema-type-name/.test(r.text) && /min-width:\s*0/.test(r.text))).toBe(true);
    expect(rules.some(r => phone(r) && /^\.sch-detail-head\s*\{/.test(r.text) && /flex-wrap:\s*wrap/.test(r.text)), 'the head wraps').toBe(true);
    expect(rules.some(r => phone(r) && /\.sch-detail-head \.acts/.test(r.text) && /flex-wrap:\s*wrap/.test(r.text)), 'the buttons wrap').toBe(true);
    const tab = readFileSync(resolve(CLIENT_ROOT, 'src/app/pages/settings/space-schema-tab.component.ts'), 'utf8');
    expect(tab).toMatch(/styles:\s*\[[^\]]*\bTYPE_HEAD_STYLES\b/);
  });
});
