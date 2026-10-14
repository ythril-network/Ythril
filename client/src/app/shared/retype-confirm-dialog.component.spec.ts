/**
 * The retype confirmation (Q-93, plan R6-14): the dialog a person meets when changing a record's type would remove
 * properties the new type does not declare.
 *
 * ## What the plan says it must be, and why each line is asserted rather than trusted
 *
 * The generic confirm shows ONE pre-wrapped string in a 440px box with no height limit, default button words and a
 * danger button that is white on #f85149 (3.35:1, below the 4.5:1 AA floor). A list of keys and values cannot be
 * carried by that string, so this is its own dialog:
 *
 * - it LISTS the keys with their values, each value SHORTENED (a pasted blob must not push the buttons off screen, and
 *   the 500-character value must not be in the DOM at all — shortening by CSS alone leaves it there for a screen reader);
 * - it shows at most 20 and counts the rest ("and N more"), and the list container scrolls (a `max-height` is declared);
 * - it says the removal "cannot be undone", because it cannot (the fields are `$unset`);
 * - its confirm button names the EFFECT, with the number of properties — "Remove 3 properties" — not "Confirm";
 * - Cancel and confirm are the two outputs, and a dialog is a dialog to assistive technology: role, `aria-modal`, focus
 *   moved inside;
 * - the danger button's colours are COMPUTED against 4.5:1 from the styles the client ships, not eyeballed.
 *
 * Words are asserted in the shipped English (`locale('en')`): a key missing from the file renders as the raw key, and an
 * assertion on an echoed key would pass for a dialog that says nothing.
 *
 * The component and service are loaded by path at run time: on the unchanged base they do not exist, and a static import
 * would turn this file into one collection error instead of the per-test failures that say which promise is unkept.
 */
import { ApplicationRef, type Type } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Dialog } from '@angular/cdk/dialog';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTranslocoModule } from '../testing/transloco-testing';
import { locale } from '../testing/files-page-harness';
import { declaredValue, elementHolding, boxesUpTo } from '../testing/declared-style';

type Key = { key: string; value: unknown };
interface DialogCmp { keys: unknown; confirmed: { subscribe(fn: () => void): unknown }; cancelled: { subscribe(fn: () => void): unknown } }
interface Service { confirm(keys: Key[]): Promise<boolean> }

async function load<T>(file: string, exportName: string): Promise<T> {
  const path = file;
  let mod: Record<string, unknown>;
  try {
    mod = await import(/* @vite-ignore */ path);
  } catch (e) {
    throw new Error(`${file} does not exist yet (bundle-23 creates it): ${(e as Error).message.split('\n')[0]}`);
  }
  const found = mod[exportName];
  if (!found) throw new Error(`${file} does not export ${exportName}`);
  return found as T;
}

const loadDialog = () => load<Type<DialogCmp>>('./retype-confirm-dialog.component', 'RetypeConfirmDialogComponent');
const loadService = () => load<Type<Service>>('../core/retype-confirm.service', 'RetypeConfirmService');

const keysN = (n: number, value: (i: number) => unknown = i => `value ${i}`): Key[] =>
  Array.from({ length: n }, (_v, i) => ({ key: `retype_key_${String(i + 1).padStart(2, '0')}`, value: value(i + 1) }));

async function open(keys: Key[]) {
  const Cmp = await loadDialog();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [Cmp, getTranslocoModule({ translation: { en: locale('en') } })] });
  const fixture = TestBed.createComponent(Cmp) as ComponentFixture<DialogCmp>;
  fixture.componentRef.setInput('keys', keys);
  const confirmed = vi.fn();
  const cancelled = vi.fn();
  fixture.componentInstance.confirmed.subscribe(confirmed);
  fixture.componentInstance.cancelled.subscribe(cancelled);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, confirmed, cancelled };
}

const text = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
const buttons = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('button')];
const confirmButton = (el: HTMLElement) => buttons(el).find(b => /remove/i.test(text(b)));
const cancelButton = (el: HTMLElement) => buttons(el).find(b => /cancel/i.test(text(b)));

beforeEach(() => TestBed.resetTestingModule());

describe('the retype dialog lists what would be removed', () => {
  it('shows every key it was given (up to the cap) by name', async () => {
    const { el } = await open(keysN(3));
    for (const k of keysN(3)) expect(text(el), `${k.key} is not listed`).toContain(k.key);
  });

  it('shows short values as they are, numbers and booleans and objects readably', async () => {
    const { el } = await open([
      { key: 'a_str', value: 'plain' }, { key: 'b_num', value: 42 }, { key: 'c_bool', value: false }, { key: 'd_obj', value: { x: 1 } },
    ]);
    const t = text(el);
    expect(t).toContain('plain');
    expect(t).toContain('42');
    expect(t).toContain('false');
    expect(t).not.toContain('[object Object]');
  });

  it('SHORTENS a long value with an ellipsis and keeps its full text out of the DOM', async () => {
    const long = 'abcdefghij'.repeat(50);
    expect(long).toHaveLength(500);
    const { el } = await open([{ key: 'big_one', value: long }, { key: 'small_one', value: 'tiny' }]);
    const t = text(el);
    expect(t).toContain('big_one');
    expect(t, 'the 500-character value is in the dialog whole').not.toContain(long);
    expect(t, 'its beginning should still be there').toContain('abcdefghijabcdefghij');
    const row = elementHolding(el, 'big_one');
    expect(row, 'could not find the row of the long value').toBeTruthy();
    expect(text(row!.parentElement ?? row!)).toMatch(/…|\.\.\./);
    expect(text(el), 'a short value must not be cut').toContain('tiny');
    expect((el.innerHTML ?? '')).not.toContain(long);
  });

  it('shows at most 20 keys and counts the rest', async () => {
    const { el } = await open(keysN(25));
    const t = text(el);
    const shown = keysN(25).filter(k => t.includes(k.key));
    expect(shown.length, 'the dialog lists a different number of keys than 20').toBe(20);
    expect(t, 'the remaining five are not counted').toMatch(/and\s+5\s+more/i);
  });

  it('shows no "more" line at exactly 20, and "and 1 more" at 21', async () => {
    const twenty = await open(keysN(20));
    expect(text(twenty.el)).not.toMatch(/and\s+\d+\s+more/i);
    expect(keysN(20).every(k => text(twenty.el).includes(k.key))).toBe(true);
    const twentyOne = await open(keysN(21));
    expect(text(twentyOne.el)).toMatch(/and\s+1\s+more/i);
  });

  it('puts the keys in a container that scrolls (a max-height is declared)', async () => {
    const { el } = await open(keysN(20));
    const row = elementHolding(el, 'retype_key_01');
    expect(row, 'the first key is not rendered').toBeTruthy();
    const scrolling = boxesUpTo(row!, el).filter(box => {
      const max = declaredValue(box, 'max-height');
      const overflow = declaredValue(box, 'overflow') ?? declaredValue(box, 'overflow-y') ?? '';
      return !!max && max !== 'none' && /auto|scroll/.test(overflow);
    });
    expect(scrolling.length, 'no box around the key list declares a max-height with overflow auto/scroll').toBeGreaterThan(0);
  });
});

describe('the retype dialog says what it does, in words', () => {
  it('says the removal cannot be undone', async () => {
    const { el } = await open(keysN(2));
    expect(text(el)).toMatch(/cannot be undone/i);
  });

  it('labels the confirm button with its effect and the number of properties (all of them, shown or not)', async () => {
    const three = await open(keysN(3));
    expect(text(confirmButton(three.el) ?? three.el), 'no button says "Remove"').toMatch(/Remove\s+3\s+propert/i);
    const many = await open(keysN(25));
    expect(text(confirmButton(many.el) ?? many.el), 'the count must be the total, not the 20 shown').toMatch(/Remove\s+25\s+propert/i);
  });

  it('says "1 property", not "1 properties"', async () => {
    const { el } = await open(keysN(1));
    const label = text(confirmButton(el) ?? el);
    expect(label).toMatch(/Remove\s+1\s+propert/i);
    expect(label).not.toMatch(/1\s+properties/i);
  });

  it('is not a bare "Confirm" button', async () => {
    const { el } = await open(keysN(3));
    expect(buttons(el).map(text)).not.toContain('Confirm');
  });
});

describe('the retype dialog\'s two answers', () => {
  it('Cancel emits `cancelled` and nothing else', async () => {
    const { el, confirmed, cancelled } = await open(keysN(2));
    const cancel = cancelButton(el);
    expect(cancel, 'no Cancel button').toBeTruthy();
    cancel!.click();
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(confirmed).not.toHaveBeenCalled();
  });

  it('the confirm button emits `confirmed` and nothing else', async () => {
    const { el, confirmed, cancelled } = await open(keysN(2));
    const go = confirmButton(el);
    expect(go, 'no button says "Remove"').toBeTruthy();
    go!.click();
    expect(confirmed).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('the confirm button is styled as the danger action', async () => {
    const { el } = await open(keysN(2));
    expect(confirmButton(el)?.className ?? '').toMatch(/\bbtn-danger\b|\bdanger\b/);
  });
});

/**
 * Contrast of the danger button, computed from the styles the client SHIPS: the component's own declarations first, then
 * the global `.btn-danger` rule in styles.scss, with `var()` resolved through the `:root` tokens. Nothing here names a
 * colour; a different token, a different text colour or a different fill is measured all the same.
 */
describe('the danger button\'s colours meet WCAG AA (4.5:1)', () => {
  const SCSS = readFileSync(resolve(__dirname, '../../styles.scss'), 'utf8');
  const root = SCSS.slice(SCSS.indexOf(':root {'), SCSS.indexOf('\n}', SCSS.indexOf(':root {')));
  const TOKENS = new Map<string, string>([...root.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()] as [string, string]));

  function resolveColor(raw: string | null | undefined, depth = 0): string | null {
    if (!raw || depth > 8) return null;
    const v = raw.trim();
    const viaVar = /^var\(--([a-z0-9-]+)(?:\s*,\s*([^)]+))?\)$/.exec(v);
    if (viaVar) return resolveColor(TOKENS.get(viaVar[1]) ?? viaVar[2], depth + 1);
    if (/^#[0-9a-f]{3,6}$/i.test(v)) return v;
    if (v === 'white') return '#ffffff';
    if (v === 'black') return '#000000';
    const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[,/]\s*([\d.]+))?\s*\)$/.exec(v);
    if (rgb && (rgb[4] === undefined || Number(rgb[4]) === 1)) {
      return '#' + [rgb[1], rgb[2], rgb[3]].map(n => Number(n).toString(16).padStart(2, '0')).join('');
    }
    return null;
  }

  function luminance(hex: string): number {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const [r, g, b] = (h.match(/../g) ?? []).map(pair => parseInt(pair, 16) / 255)
      .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const ratio = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  /** The global `.btn-danger { … }` declarations, the fallback when the component declares none of its own. */
  const GLOBAL_DANGER = /\.btn-danger\s*\{([^}]*)\}/.exec(SCSS)?.[1] ?? '';
  const globalProp = (prop: string): string | null =>
    new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(GLOBAL_DANGER)?.[1].trim() ?? null;

  it('computes the arithmetic correctly, and finds the palette, before it is trusted', () => {
    expect(TOKENS.size, 'the :root token block could not be read').toBeGreaterThan(20);
    expect(ratio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    // The vet's own measurement: white on #f85149.
    expect(ratio('#ffffff', '#f85149')).toBeCloseTo(3.35, 1);
    expect(resolveColor('var(--danger)')).toBe(TOKENS.get('error'));
  });

  it('text on the danger button against its fill is at least 4.5:1', async () => {
    const { el } = await open(keysN(3));
    const btn = confirmButton(el);
    expect(btn, 'no button says "Remove"').toBeTruthy();

    const fg = resolveColor(declaredValue(btn!, 'color') ?? globalProp('color') ?? 'var(--text-primary)');
    let fill: string | null = null;
    for (const box of boxesUpTo(btn!, el)) {
      const bg = declaredValue(box, 'background-color') ?? declaredValue(box, 'background');
      const own = box === btn ? (bg ?? globalProp('background-color') ?? globalProp('background')) : bg;
      const c = own && !/^(transparent|none|inherit|initial)$/i.test(own.trim()) ? resolveColor(own) : null;
      if (c) { fill = c; break; }
    }
    fill ??= resolveColor('var(--bg-card)');

    expect(fg, 'could not resolve the button\'s text colour to a literal').toBeTruthy();
    expect(fill, 'could not resolve the button\'s background to a literal').toBeTruthy();
    const r = ratio(fg!, fill!);
    expect(r, `danger button text ${fg} on ${fill} is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });
});

describe('a dialog to assistive technology (opened through RetypeConfirmService)', () => {
  const overlay = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');

  async function ask(keys: Key[]) {
    const Service = await loadService();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [getTranslocoModule({ translation: { en: locale('en') } })] });
    const service = TestBed.inject(Service);
    const app = TestBed.inject(ApplicationRef);
    const answer = service.confirm(keys);
    await vi.waitFor(() => { app.tick(); expect(overlay(), 'no dialog opened').toBeTruthy(); });
    app.tick();
    return { answer, app, dialog: overlay()! };
  }

  afterEach(() => {
    try { TestBed.inject(Dialog).closeAll(); } catch { /* the injector may already be gone */ }
    document.querySelectorAll('.cdk-overlay-container').forEach(n => n.remove());
  });

  it('opens a dialog or alertdialog that is modal', async () => {
    const { dialog } = await ask(keysN(3));
    expect(['dialog', 'alertdialog']).toContain(dialog.getAttribute('role'));
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby') ?? dialog.getAttribute('aria-label'), 'the dialog has no name').toBeTruthy();
  });

  it('moves focus inside the dialog', async () => {
    const { dialog, app } = await ask(keysN(3));
    await vi.waitFor(() => { app.tick(); expect(dialog.contains(document.activeElement), 'focus stayed outside the dialog').toBe(true); });
  });

  it('lists the keys and names the effect when opened through the service', async () => {
    const { dialog } = await ask(keysN(3));
    expect(text(dialog)).toContain('retype_key_01');
    expect(text(dialog)).toMatch(/Remove\s+3\s+propert/i);
    expect(text(dialog)).toMatch(/cannot be undone/i);
  });

  it('resolves true when the person confirms', async () => {
    const { answer, dialog } = await ask(keysN(2));
    confirmButton(dialog)!.click();
    expect(await answer).toBe(true);
  });

  it('resolves false on Cancel', async () => {
    const { answer, dialog } = await ask(keysN(2));
    cancelButton(dialog)!.click();
    expect(await answer).toBe(false);
  });

  it('resolves false on Escape (a dismissal is never a yes)', async () => {
    const { answer, dialog } = await ask(keysN(2));
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    expect(await answer).toBe(false);
  });
});
