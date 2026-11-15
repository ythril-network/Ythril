#!/usr/bin/env node
/**
 * check-i-a11y-form-label-association: every form control has a label, and every hint or error beside a control is described to assistive technology.
 *
 * Rule: on every route derived from `client/src/app/app.routes.ts`, axe-core's label rules (`label`, `select-name`, `form-field-multiple-labels`,
 * `aria-input-field-name`, `aria-toggle-field-name`, `label-title-only`) find nothing, and every visible hint or error element in or beside a form
 * control (a class token `hint` or `error`, split on `-` and `_`) either carries `role="alert"` or an `aria-live`, or has an id that a control's
 * `aria-describedby` or `aria-errormessage` names. A label association does not depend on the colour scheme, so the routes are scanned once.
 *
 * The failure that bought it (Q-792): this check answered "cannot answer" from a placeholder, so no form's labels were ever measured on a running Ythril.
 *
 * Answers on the last stdout line: `holds:` (exit 0), `violated:` (exit 1) or `cannot answer:` (exit 2). Everything else is in `_axe.mjs`.
 *
 *     node tools/flow-checks/check-i-a11y-form-label-association.mjs --base-url http://127.0.0.1:3200 --modules <folder> [YTHRIL_TOKEN in env]
 */
import { axeProbe, axeAnalyzer, scanPages, judgeScan } from './_axe.mjs';

const LABEL_RULES = ['label', 'select-name', 'form-field-multiple-labels', 'aria-input-field-name', 'aria-toggle-field-name', 'label-title-only'];

/** In the page: the hint and error elements beside a control that nothing describes. */
function undescribedHintsAndErrors() {
  const isHintOrError = (el) => [...el.classList].some((c) => c.split(/[-_]/).some((part) => part === 'hint' || part === 'error'));
  const beside = (el) => Boolean(el.closest('form') || el.parentElement?.querySelector('input, select, textarea') || el.closest('label'));
  const visible = (el) => el.getClientRects().length > 0;
  const named = new Set();
  for (const el of document.querySelectorAll('[aria-describedby], [aria-errormessage]')) {
    for (const attr of ['aria-describedby', 'aria-errormessage']) {
      for (const id of (el.getAttribute(attr) ?? '').split(/\s+/)) if (id) named.add(id);
    }
  }
  const out = [];
  for (const el of document.querySelectorAll('[class]')) {
    if (!isHintOrError(el) || !beside(el) || !visible(el)) continue;
    const announced = el.getAttribute('role') === 'alert' || el.hasAttribute('aria-live');
    if (announced || (el.id && named.has(el.id))) continue;
    out.push(`hint-or-error-not-described: <${el.tagName.toLowerCase()} class="${el.className}"> has no id named by aria-describedby or aria-errormessage`);
  }
  return out;
}

await axeProbe(async (ctx) => {
  const analyze = axeAnalyzer(ctx, (b) => b.withRules(LABEL_RULES), (page) => page.evaluate(undescribedHintsAndErrors));
  const one = { ...ctx, schemes: ['light'], themes: { ...ctx.themes, schemed: false } };
  const scanned = await scanPages(one, { schemes: one.schemes, analyze });
  return judgeScan(one, scanned, { what: 'form labels and hint/error descriptions' });
});
