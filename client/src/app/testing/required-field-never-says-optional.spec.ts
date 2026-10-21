/**
 * A field that is required never carries a placeholder that says "optional" (Q-549).
 *
 * The entity form's Type input is `required` (owner's ruling P-31: the server refuses a typeless entity on every door) and its
 * placeholder was `brain.entities.form.typePlaceholder` = "optional" - the field told the operator the opposite of what the form
 * enforces. The key was shared by wording with the memory form, where the type really is optional, so no review of either string
 * alone could see it: the defect is the PAIR of the control and its words.
 *
 * Derived, never listed: every tracked component template (inline `template:` strings and `.html` files, `componentTemplates`) is
 * scanned for input, textarea, select and custom elements that are required - a `required` attribute, a `[required]` binding, or a
 * field inside a component that declares an input NAMED `required` (the properties editor's rows) - and every translation key their
 * `placeholder=`, `[placeholder]=` or `[attr.placeholder]=` names must read as something other than optional in en, de and pl. A
 * static placeholder text is held to the same rule. The "optional" words per locale are the forms a translation uses; a new
 * spelling of it is one alternative to add. Floors on the required fields and on the placeholders found, so a changed template
 * spelling cannot pass by finding nothing.
 */
import { describe, it, expect } from 'vitest';
import { componentTemplates, formElements } from './component-templates';
import { dictionary, LOCALES } from './i18n-dictionary';

const SAYS_OPTIONAL: Record<(typeof LOCALES)[number], RegExp> = {
  en: /\boptional\b/i,
  de: /\boptional\b/i,
  pl: /(opcjonaln|fakultatywn)/i,
};

const KEY = /'([a-zA-Z][\w-]*(?:\.[\w-]+)+)'/g;

interface RequiredPlaceholder { where: string; keys: string[]; staticText: string | null }

/** Every required field of every template, and the placeholders it carries. */
function requiredFields(): { count: number; withPlaceholder: RequiredPlaceholder[] } {
  let count = 0;
  const withPlaceholder: RequiredPlaceholder[] = [];
  for (const t of componentTemplates()) {
    for (const el of formElements(t)) {
      const bare = el.attrs.replace(/"[^"]*"|'[^']*'/g, '""');
      const isField = /^(?:input|textarea|select)$/.test(el.name);
      const required = /\srequired(?=[\s/=]|$)/.test(bare) || /\[required\]/.test(bare) || (t.declaresRequiredInput && isField);
      if (!required) continue;
      count++;
      const ph = /(?:\[attr\.placeholder\]|\[placeholder\]|\splaceholder)\s*=\s*"([^"]*)"/.exec(el.attrs);
      if (!ph) continue;
      const binding = /\[(?:attr\.)?placeholder\]/.test(el.attrs);
      withPlaceholder.push({
        where: `${t.file}:${el.line}`,
        keys: binding ? [...ph[1]!.matchAll(KEY)].map(m => m[1]!) : [],
        staticText: binding ? null : ph[1]!,
      });
    }
  }
  return { count, withPlaceholder };
}

describe('a required field never says optional (Q-549)', () => {
  const { count, withPlaceholder } = requiredFields();

  it('finds the required fields and their placeholders (a floor, so a changed template spelling cannot pass by finding nothing)', () => {
    expect(count, 'required fields found across the templates').toBeGreaterThan(10);
    expect(withPlaceholder.length, 'required fields that carry a placeholder').toBeGreaterThanOrEqual(2);
    expect(withPlaceholder.flatMap(p => p.keys).length, 'placeholders that name a translation key').toBeGreaterThanOrEqual(2);
  });

  for (const loc of LOCALES) {
    it(`${loc}: no placeholder of a required field reads optional`, () => {
      const d = dictionary(loc);
      const wrong: string[] = [];
      for (const p of withPlaceholder) {
        for (const key of p.keys) {
          const value = d[key];
          if (typeof value === 'string' && SAYS_OPTIONAL[loc].test(value)) wrong.push(`${p.where}: ${key} = ${JSON.stringify(value)}`);
        }
        if (p.staticText !== null && SAYS_OPTIONAL[loc].test(p.staticText)) wrong.push(`${p.where}: static placeholder ${JSON.stringify(p.staticText)}`);
      }
      expect(wrong, `${loc}: a required field whose placeholder says optional:\n  ${wrong.join('\n  ')}`).toEqual([]);
    });
  }
});
