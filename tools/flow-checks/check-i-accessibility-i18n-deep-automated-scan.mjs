#!/usr/bin/env node
/**
 * check-i-accessibility-i18n-deep-automated-scan: axe-core's WCAG rules on every derived route, in every colour scheme the client has, each violation recorded.
 *
 * Rule: axe-core run with the tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` and `wcag22aa` on every route derived from
 * `client/src/app/app.routes.ts` finds nothing; the scanned count equals the derived count (a route that landed elsewhere, or a scheme not scanned, is
 * "cannot answer", never a shorter pass); the schemes are light and dark when the client's styles declare a colour scheme rule (comments stripped),
 * and one otherwise, said as "one theme". Each violation is printed on its own line before the verdict.
 *
 * The failure that bought it (Q-792): this check answered "cannot answer" from a placeholder, so the pages were never scanned as a whole.
 *
 * Answers on the last stdout line: `holds:` (exit 0), `violated:` (exit 1) or `cannot answer:` (exit 2). Everything else is in `_axe.mjs`.
 *
 *     node tools/flow-checks/check-i-accessibility-i18n-deep-automated-scan.mjs --base-url http://127.0.0.1:3200 --modules <folder> [YTHRIL_TOKEN in env]
 */
import { axeProbe, axeAnalyzer, scanPages, judgeScan } from './_axe.mjs';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

await axeProbe(async (ctx) => {
  const analyze = axeAnalyzer(ctx, (b) => b.withTags(TAGS));
  const scanned = await scanPages(ctx, { schemes: ctx.schemes, analyze });
  return judgeScan(ctx, scanned, { what: `axe ${TAGS.join('+')}` });
});
