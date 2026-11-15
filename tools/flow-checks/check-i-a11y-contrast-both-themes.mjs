#!/usr/bin/env node
/**
 * check-i-a11y-contrast-both-themes: colour contrast on every route, in both colour schemes when the client has two.
 *
 * Rule: axe-core's `color-contrast` rule, run through Playwright on every route derived from `client/src/app/app.routes.ts`, finds nothing. When the
 * client's styles declare a colour scheme rule (`prefers-color-scheme` or a theme selector, comments stripped) the routes are scanned light and dark and
 * the page's computed colours must differ between them; with none, the routes are scanned once and the verdict says "one theme".
 *
 * The failure that bought it (Q-792): this check answered "cannot answer" from a placeholder, so contrast was never measured on a running Ythril.
 *
 * Answers on the last stdout line: `holds:` (exit 0), `violated:` (exit 1) or `cannot answer:` (exit 2: no modules, no base URL, a URL that does not
 * answer in 5 s, a browser that does not start, or a route that landed elsewhere). Everything else is in `_axe.mjs`.
 *
 *     node tools/flow-checks/check-i-a11y-contrast-both-themes.mjs --base-url http://127.0.0.1:3200 --modules <folder> [YTHRIL_TOKEN in env]
 */
import { axeProbe, axeAnalyzer, scanPages, judgeScan } from './_axe.mjs';

await axeProbe(async (ctx) => {
  const analyze = axeAnalyzer(ctx, (b) => b.withRules(['color-contrast']));
  const scanned = await scanPages(ctx, { schemes: ctx.schemes, analyze });
  return judgeScan(ctx, scanned, { what: 'color-contrast' });
});
