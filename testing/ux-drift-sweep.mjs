/**
 * Sibling-surface drift pass — the same control across every page, measured from COMPUTED styles.
 *
 * ## Why this cannot be a unit test
 *
 * Visual consistency is the owner's primary review dimension, and the audit lens is explicit that reading CSS does
 * not find drift: Angular's view encapsulation means two components can style "the same" input differently and
 * neither file looks wrong. The search-bar drift (#385) is the cautionary tale. Only the running app knows what a
 * control actually measures, so this drives the real bundle and groups every control by its computed signature.
 *
 * Drift then shows up as a NUMBER — "4 distinct signatures for a text input" — instead of an impression.
 *
 * ## Running it
 *
 *   1. Boot an isolated instance (never the operator's own on :3210):
 *
 *        cd server
 *        PORT=3260 TRUST_PROXY=1 \
 *        CONFIG_PATH=<scratch>/config/config.json DATA_ROOT=<scratch>/data \
 *        MONGO_URI=mongodb://127.0.0.1:27017/ythril_ux_audit \
 *        npx tsx src/index.ts
 *
 *   2. `npm run build:client` once, so the server serves the bundle that ships.
 *   3. Complete first-run setup and put the admin token in `token.txt` beside this script. The token is shown ONCE,
 *      in the setup page's TEXT (`ythril_…`) — not in an `input#token`.
 *   4. `node testing/ux-drift-sweep.mjs`
 *
 * Needs `playwright` available and Edge installed (`channel: 'msedge'` avoids a browser download).
 *
 * ## What it will not do
 *
 * It reports; it does not judge. Some variation is real design — an icon button is not a primary button. The signal
 * is *near-identical* signatures (a 1px height difference across eight pages) and the same control appearing on
 * different background tokens, which is drift by definition rather than intent.
 *
 * A run that measures NOTHING exits non-zero. An empty report reads exactly like a clean one, and the first draft of
 * this script did precisely that: it passed its arguments to `$$eval` in the wrong order and swallowed the error.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { pageLoaded, ROUTED_PAGE } from './_shared/page-loaded.mjs';

const BASE = process.env['UX_BASE'] ?? 'http://localhost:3260';
const TOKEN_FILE = process.env['UX_TOKEN_FILE'] ?? 'token.txt';

const PAGES = [
  ['/brain', 'Brain'],
  ['/settings/spaces', 'Spaces'],
  ['/settings/tokens', 'Tokens'],
  ['/settings/storage', 'Storage'],
  ['/settings/models', 'Models'],
  ['/settings/audit-log', 'Audit log'],
  ['/settings/preferences', 'Preferences'],
  ['/schema-library', 'Schema library'],
];

/** The concretes the UX lens names: control height, padding, background token, radius, type size. */
const INPUT_PROPS = ['height', 'padding-top', 'padding-bottom', 'padding-left', 'background-color', 'border-radius', 'font-size'];
const BUTTON_PROPS = ['height', 'padding-left', 'padding-right', 'font-size', 'border-radius'];
const PILL_PROPS = ['height', 'padding-left', 'border-radius', 'font-size', 'text-transform'];

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewportSize: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });

const token = readFileSync(TOKEN_FILE, 'utf8').trim();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#token', { timeout: 30_000 });
await page.fill('#token', token);
await page.press('#token', 'Enter');
await page.waitForURL(u => !/\/(setup|login)/.test(u.toString()), { timeout: 30_000 });
console.log(`signed in, landed on ${page.url()}`);

/**
 * Every visible instance of `selector`, grouped by computed signature.
 *
 * Argument order matters: `$$eval(selector, fn, arg)`. Passing `[selector, props]` as the selector throws, and
 * catching that would turn a broken measurement into a clean-looking report.
 */
async function measure(selector, props) {
  return page.$$eval(selector, (els, ps) => {
    const out = {};
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;      // invisible: not part of the visual language
      const cs = getComputedStyle(el);
      const sig = ps.map(p => (p === 'height' ? `${Math.round(r.height)}px` : cs.getPropertyValue(p))).join(' | ');
      out[sig] = (out[sig] ?? 0) + 1;
    }
    return out;
  }, props);
}

const groups = {
  // Every type the product renders. The first version listed four, which is the SAME gap the global CSS rule had
  // — so when a component override was removed and the audit log's `datetime-local` filters fell back to the
  // browser default (white on white), this tool could not see it. The measurement and the thing it measures must
  // not share a blind spot.
  'TEXT INPUTS': {
    sel: 'input[type=text], input:not([type]), input[type=search], input[type=number], input[type=url],'
       + ' input[type=tel], input[type=datetime-local], input[type=date], input[type=time], input[type=month],'
       + ' input[type=week], input[type=password], input[type=email], textarea, select',
    props: INPUT_PROPS, map: {},
  },
  'BUTTONS': { sel: 'button', props: BUTTON_PROPS, map: {} },
  'PILLS / BADGES': { sel: '[class*=pill], [class*=badge], [class*=chip]', props: PILL_PROPS, map: {} },
};

for (const [path, name] of PAGES) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  // The first data load has to land: a skeleton is not the final state, and a miss throws rather than measuring one.
  await pageLoaded(page, ROUTED_PAGE, 30_000);
  for (const g of Object.values(groups)) {
    for (const [sig, n] of Object.entries(await measure(g.sel, g.props))) {
      (g.map[sig] ??= []).push(`${name}×${n}`);
    }
  }
}

let measured = 0;
for (const [label, g] of Object.entries(groups)) {
  const entries = Object.entries(g.map).sort((a, b) => b[1].length - a[1].length);
  measured += entries.length;
  console.log(`\n=== ${label}: ${entries.length} distinct signature(s) across ${PAGES.length} pages`);
  console.log(`    (${g.props.join(' | ')})`);
  for (const [sig, where] of entries) console.log(`  ${sig}\n      ${where.join(', ')}`);
}

console.log(`\nconsole errors: ${consoleErrors.length}`);
consoleErrors.slice(0, 8).forEach(e => console.log(`  ${e}`));

await browser.close();

if (measured === 0) {
  console.error('\nMEASURED NOTHING. The sign-in or the selectors failed — this is not a clean result.');
  process.exit(1);
}
