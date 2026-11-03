/**
 * Every `<input>` in a template names its type, and the type is one the base input styles reach (Q-177).
 *
 * ## Why
 *
 * `styles.scss` styles an input through `input[type="text"]`, `input[type="number"]` and so on - there is no bare `input` rule - so an
 * `<input>` with no `type` attribute renders as the browser's own control: white background, black text, a different height from every
 * other field on the page. Nine inputs (the `*-model` fields of the media-processing page, written with `data-mono`) had none, and each
 * looked right in every spec, because a jsdom spec has no stylesheet. The fix is explicit HTML (`type="text"`), not a widened CSS selector:
 * a selector that accepts "no type" would also style the next control that forgot one by accident.
 *
 * ## The rule, over every template
 *
 * Derived from the repo, never a list: `componentTemplates()` (every tracked inline template and `.html`) and `formElements()` (which reads a
 * tag that spans lines and a `>` inside a quoted binding). For each `<input>`:
 *
 *  - it carries a `type` (`type="..."`, `[type]="..."` or `[attr.type]="..."`);
 *  - when the type is a literal, it is in the selector list of the base rule in `styles.scss`, or in `UNSTYLED_BY_DESIGN` below with the
 *    reason. A control type the stylesheet never names is a new `datetime-local`: it falls through to the browser default
 *    (the precedent the comment above that selector list tells).
 *
 * A bound type (`[type]="..."`) cannot be read statically; it counts as typed and is not checked against the list.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLIENT_ROOT } from './tracked-sources';
import { componentTemplates, formElements } from './component-templates';
import { stripComments } from './strip-comments';

/**
 * Input types the base rule does not style, because the control is not a text box: a checkbox, a radio, a file picker, a range, a colour
 * and a hidden field each have their own look (or none), set where they are used.
 */
const UNSTYLED_BY_DESIGN: Readonly<Record<string, string>> = {
  checkbox: 'a toggle, styled where it is used',
  radio: 'a toggle, styled where it is used',
  file: 'the browser file picker behind a styled button',
  range: 'a slider',
  color: 'a swatch',
  hidden: 'draws nothing',
  submit: 'a button, styled by the button rules',
  button: 'a button, styled by the button rules',
};

/** The `type` attribute of an opening tag: [bound?, literal value]. */
function typeOf(attrs: string): { bound: boolean; value: string | null } | null {
  const m = /(?:^|\s)(\[(?:attr\.)?type\]|type)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
  if (!m) return null;
  return m[1] === 'type' ? { bound: false, value: m[2] ?? m[3] ?? '' } : { bound: true, value: null };
}

/** The types the base input rule in `styles.scss` names: `input[type="x"]` in the selector list that ends in `textarea, select {`. */
function styledTypes(): Set<string> {
  const css = stripComments(readFileSync(resolve(CLIENT_ROOT, 'src/styles.scss'), 'utf8'));
  const types = new Set<string>();
  // The first rule whose selector list names input[type=...] AND textarea AND select is the base rule.
  for (const m of css.matchAll(/((?:[^{}]*input\[type="[a-z-]+"\][^{}]*))\{/g)) {
    if (!/\btextarea\b/.test(m[1]!) || !/\bselect\b/.test(m[1]!)) continue;
    for (const t of m[1]!.matchAll(/input\[type="([a-z-]+)"\]/g)) types.add(t[1]!);
    break;
  }
  return types;
}

describe('every input names its type (Q-177)', () => {
  const inputs: { where: string; attrs: string }[] = [];
  for (const t of componentTemplates()) {
    for (const e of formElements(t)) {
      if (e.name === 'input') inputs.push({ where: `${t.file}:${e.line}`, attrs: e.attrs });
    }
  }

  it('finds the inputs (a floor, so a changed template spelling cannot pass by finding none)', () => {
    // 251 today; far below that, so adding and removing a field does not touch it.
    expect(inputs.length).toBeGreaterThanOrEqual(200);
  });

  it('reads the selector list of the base input rule (a floor)', () => {
    const styled = styledTypes();
    expect(styled.size).toBeGreaterThanOrEqual(10);
    expect([...styled]).toContain('text');
    expect([...styled]).toContain('datetime-local');
  });

  it('no <input> is typeless: a typeless input matches no input[type=...] rule and renders as the browser default', () => {
    const typeless = inputs.filter(i => typeOf(i.attrs) === null).map(i => i.where);
    expect(typeless, `<input> elements with no type attribute:\n  ${typeless.join('\n  ')}`).toEqual([]);
  });

  it('every literal input type is one the base rule in styles.scss styles, or one that is unstyled by design', () => {
    const styled = styledTypes();
    const unstyled: string[] = [];
    for (const i of inputs) {
      const t = typeOf(i.attrs);
      if (!t || t.bound || t.value === null) continue;
      if (!styled.has(t.value) && !(t.value in UNSTYLED_BY_DESIGN)) unstyled.push(`${i.where}  type="${t.value}"`);
    }
    expect(unstyled, `input types the stylesheet never names:\n  ${unstyled.join('\n  ')}`).toEqual([]);
  });

  it('the by-design list names no type the stylesheet also styles (a stale exemption)', () => {
    const styled = styledTypes();
    const stale = Object.keys(UNSTYLED_BY_DESIGN).filter(t => styled.has(t));
    expect(stale).toEqual([]);
  });

  it('reads the type of a tag the way the gate says (planted shapes)', () => {
    expect(typeOf(' class="x" data-mono ')).toBeNull();
    expect(typeOf(' type="text" ')).toEqual({ bound: false, value: 'text' });
    expect(typeOf(' [type]="show() ? \'text\' : \'password\'" ')).toEqual({ bound: true, value: null });
    expect(typeOf(' [attr.type]="t" ')).toEqual({ bound: true, value: null });
    // `data-type` and `ngType` are not the type attribute.
    expect(typeOf(' data-type="text" ')).toBeNull();
  });
});
