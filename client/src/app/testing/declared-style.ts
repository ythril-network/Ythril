/**
 * What CSS a component DECLARES for an element — read from the rules and the `style` attribute, never from
 * `getComputedStyle`.
 *
 * ## Why this exists
 *
 * A spec that asks "is this text wrapped, or cut off with an ellipsis?" needs the CSS of the element and of
 * every box around it. jsdom lays nothing out, and its `getComputedStyle` implements a small part of the
 * cascade (no inheritance for `white-space`, no `overflow-wrap`), so the computed answer is the browser's
 * default whatever the stylesheet says — a spec built on it passes for a component that truncates.
 *
 * So this reads the stylesheets Angular injected for the component (emulated encapsulation turns `.vs` into
 * `.vs[_ngcontent-xyz]`, which `Element.matches` accepts) plus the inline `style`, and answers by declaration.
 * It is an approximation of the cascade — the LAST matching rule wins, specificity is not weighed — which is
 * enough for the question asked here and is why callers assert on a CONTROL element as well: a stylesheet this
 * module cannot see would make every answer "nothing declared", and a spec that only asserts absence would
 * report clean about CSS it never read.
 */

/** The value `prop` is declared with on `el` itself, or null when nothing declares it. */
export function declaredValue(el: Element, prop: string): string | null {
  const at = new RegExp(`(?:^|[;{\\s])${prop.replace(/-/g, '\\-')}\\s*:\\s*([^;}]+)`, 'i');
  let found: string | null = null;
  for (const sheet of Array.from(el.ownerDocument.styleSheets)) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of Array.from(rules)) {
      const selector = (rule as CSSStyleRule).selectorText;
      if (!selector) continue;
      let hit = false;
      try { hit = el.matches(selector); } catch { hit = false; }
      if (!hit) continue;
      const m = at.exec(rule.cssText.slice(rule.cssText.indexOf('{')));
      if (m) found = m[1].replace(/!important/i, '').trim();
    }
  }
  const inline = el.getAttribute('style');
  if (inline) {
    const m = at.exec(inline);
    if (m) found = m[1].replace(/!important/i, '').trim();
  }
  return found;
}

/** The elements from `el` up to and including `boundary` (or the document root when `boundary` is not an ancestor). */
export function boxesUpTo(el: Element, boundary: Element): Element[] {
  const out: Element[] = [];
  for (let n: Element | null = el; n; n = n.parentElement) {
    out.push(n);
    if (n === boundary) break;
  }
  return out;
}

/** The nearest declaration of `prop` on `el` or an ancestor up to `boundary` — what an inherited property resolves to. */
export function declaredNearest(el: Element, prop: string, boundary: Element): string | null {
  for (const box of boxesUpTo(el, boundary)) {
    const v = declaredValue(box, prop);
    if (v !== null) return v;
  }
  return null;
}

/**
 * Every way text inside `el` can be cut off by a box between it and `boundary`: an ellipsis, a line clamp, a
 * `nowrap`. Empty means the text wraps.
 */
export function truncationAround(el: Element, boundary: Element): string[] {
  const problems: string[] = [];
  for (const box of boxesUpTo(el, boundary)) {
    const name = `${box.tagName.toLowerCase()}${box.className && typeof box.className === 'string' ? '.' + box.className.trim().split(/\s+/).join('.') : ''}`;
    const ellipsis = declaredValue(box, 'text-overflow');
    if (ellipsis && /ellipsis|clip/.test(ellipsis)) problems.push(`${name}: text-overflow ${ellipsis}`);
    const clamp = declaredValue(box, '-webkit-line-clamp') ?? declaredValue(box, 'line-clamp');
    if (clamp && clamp !== 'none') problems.push(`${name}: line-clamp ${clamp}`);
    const ws = declaredValue(box, 'white-space');
    if (ws && /nowrap/.test(ws)) problems.push(`${name}: white-space ${ws}`);
  }
  return problems;
}

/** The smallest element under `root` whose own text contains `text` — where a rendered string actually sits. */
export function elementHolding(root: Element, text: string): Element | null {
  let best: Element | null = null;
  const walk = (el: Element): void => {
    if (!(el.textContent ?? '').includes(text)) return;
    best = el;
    for (const child of Array.from(el.children)) walk(child);
  };
  walk(root);
  return best;
}
