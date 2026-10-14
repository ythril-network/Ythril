/**
 * Responsive sweep — find content the user cannot reach at narrow window sizes.
 *
 * ## Why this exists
 *
 * The owner reported (2026-07-29) that tables and tab strips were cut off in a small window. The cause
 * was a single missing `min-width: 0` on the shell's `.main`: a flex item defaults to `min-width: auto`
 * and refuses to shrink below its content, so wide content overflowed it and the ancestor's
 * `overflow: hidden` **clipped** the overflow. No scrollbar, no error, no failing test — the right-hand
 * columns and the last tabs were simply absent. Fixed in PR #534.
 *
 * **That class of bug is invisible to every check this repo has.** It does not exist in the stylesheet
 * (the offending property is a default), it does not throw, and the unit tests render in jsdom, which
 * computes no layout at all. It only exists in a real browser at a real width — so the only honest way
 * to look for it is to open the app narrow and measure.
 *
 * ## What it reports, and why the obvious invariant is the wrong one
 *
 * The first version of this file looked for *unreachable* content — overflowing with no scrollable
 * ancestor. Mutation-testing it against the real pre-#534 code showed it reported **zero findings on the
 * broken build**, which is the worst possible outcome for a check: confident silence.
 *
 * The reason is instructive. `.main` carries `overflow-y: auto`, and CSS computes the other axis to
 * `auto` too — so `.main` is a horizontal scroller. Nothing inside it is ever strictly unreachable; you
 * *can* scroll to the missing table columns. What actually happens is that **the entire page pane slides
 * sideways** — filter bars, headings and all — which is what "cut off" looks like to a user, and it is a
 * bug whether or not the pixels are technically reachable.
 *
 * So the invariants are narrower and much sharper:
 *
 *   1. **`.main` must never scroll horizontally.** The routed page must fit the width it is given.
 *   2. Anything overflowing with no horizontal scroller anywhere above it (genuinely clipped).
 *   3. **A scroller that overflows must show a scroll affordance the user can SEE.**
 *
 * ## Rule 3, and the two bugs that motivated it
 *
 * Rules 1 and 2 both passed on code the owner rejected twice, because "reachable" is not the same as
 * "discoverable":
 *
 *   - **#548.** Brain → Entities was scrollable the entire time. Its scrollbar sat at the bottom of the
 *     table's own box, measured ~2800px below the fold at a 900px viewport. Reachable, and no one could
 *     find it.
 *   - **#551, first attempt.** A mirrored native scroller placed directly above the table. Correct
 *     position, and *invisible*: this platform uses OVERLAY scrollbars, which paint only while scrolling
 *     and take no layout space — `offsetHeight - clientHeight === 0`. It measured present and correct
 *     and a screenshot showed nothing at all.
 *
 * The same shape had already bitten a tab strip that scrolled while showing 5 of 10 tabs. So rule 3 asks
 * the only question that distinguishes those states: is there something with non-zero size that a person
 * would see? Either a native scrollbar thick enough to render, or the drawn `.hscroll-top` control with a
 * real thumb. A finding here means "the content is reachable and nothing says so".
 *
 * ## Tabbed content
 *
 * The earlier version visited `/brain` and never clicked a tab. Every Brain tab body is behind
 * `@if (activeTab() === …)`, so the tables #548 was about **were not in the DOM** when it measured — it
 * was reporting on a page whose content it had never loaded. It now walks each tab strip it finds, and
 * one level of sub-strip (Review's sub-tabs, the file-detail segmented control), measuring each.
 *
 * ## Usage
 *
 *   1. Boot an isolated instance and the client dev server (see `.claude/skills/verify`).
 *   2. `npm i playwright` somewhere, then:
 *      `BASE=http://localhost:4260 STATE=/path/to/state.json node testing/responsive-sweep.mjs`
 *
 * It needs a running instance, so it is deliberately NOT a preflight gate — preflight is the offline
 * half. Run it when touching layout, and after any change to the shell.
 *
 * Exit code is 1 when anything is found, so CI could adopt it later if the stack is up.
 *
 * ## The Files tab (Q-471), and the three options it added
 *
 * The Files table is the widest table in the app in German, and the one every other table's reasoning was
 * wrong about: "reachable by scrolling" is not enough for a column of ACTIONS. It is measured here on its own,
 * at the widths the owner's windows have: 1400x900, 1024 and 320.
 *
 *   - `LOCALE=en,de` runs the whole sweep once per locale (the app reads its language from `localStorage.lang`,
 *     which this sets before the first script runs). Unset, it runs once, as before.
 *   - `SEED=1` creates the files the Files table needs to be measured honestly (long names, tags, a folder) in the
 *     first space the token can see, through the REST API, using the token in `STATE`. A table of three short
 *     names fits everywhere, which is how the German overflow went unseen. It overwrites its own files; it never
 *     deletes anything. Point it only at an instance you may write to.
 *   - The Files tab is `/brain?tab=files`: there is no `/files` route (it redirects to the Brain), so a sweep of
 *     `/files` measured the Brain's first tab and reported on a page that was not the one named.
 *
 * What is asserted on the Files table, and what is only measured:
 *
 *   - ASSERTED at >= 1024px with the detail pane closed: the table does not scroll sideways (`scrollWidth <=
 *     clientWidth`). With the folder tree open that is only expected at >= 1400px, where the window has the room
 *     for the tree, the page's own sidebar and seven columns; at 1024 it is asserted with the tree closed.
 *   - ASSERTED at EVERY width, pane open or closed: the actions column is reachable without scrolling (the last
 *     column is sticky), and a long name is ellipsized rather than widening the table.
 *   - MEASURED, not asserted, below 1024px or with the pane open: the table may scroll, and the top scroll
 *     control (rule 3) must show.
 *
 * It needs a running instance and a browser, so it is not held in CI; the unit specs hold the markup, and this
 * holds what only a layout engine can say.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:4260';
const STATE = process.env.STATE;          // storageState json from an authenticated session
const SHOTS = process.env.SHOTS;          // optional dir for screenshots of offending pages

/**
 * `LOCALE=en,de` (a comma list) runs the sweep once per locale; unset is one run in the browser's own language.
 * The empty string stands for "no override", so the default path is byte-for-byte what it was.
 */
const LOCALES = (process.env.LOCALE ?? '').split(',').map(l => l.trim());

/** The Files tab: there is no `/files` route, the file manager is a tab of the Brain. */
const FILES_TAB = '/brain?tab=files';

const ROUTES = (process.env.ROUTES ?? [
  '/brain', '/graph', FILES_TAB, '/files/conflicts', '/schema-library',
  '/settings/tokens', '/settings/spaces', '/settings/storage', '/settings/networks',
  '/settings/preferences', '/settings/audit-log', '/settings/data', '/settings/webhooks',
  '/settings/about', '/settings/help', '/settings/media-processing',
].join(',')).split(',');

/** Widths worth checking: a desktop window, a narrow one, a narrow desktop window, a phone, and a phone at its narrowest (reflow). */
const VIEWPORTS = [[1400, 900], [1024, 900], [600, 900], [420, 900], [320, 700]];

/** Every tab-strip flavour in the app: Brain's `.tabs`, and anything using the ARIA role. */
const TAB_SELECTOR = '.tabs .tab, [role="tab"]';

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'msedge' });

/** The page being swept: one per locale, because the language is fixed before the app's first script runs. */
let page;

/** Which locale the findings below belong to, for the label. */
let localeLabel = '';

let findings = 0;

/**
 * Measure the current DOM. Runs in page context; returns the worst few findings.
 *
 * Pulled out of the route loop so it can run again after every tab click — the tab bodies are the
 * content this sweep exists to look at, and they only exist once their tab is active.
 */
const measure = () => page.evaluate(() => {
  const scrollsX = el => {
    const s = getComputedStyle(el);
    return s.overflowX === 'auto' || s.overflowX === 'scroll';
  };
  /**
   * `overflow-x: auto` is NOT enough to call something reachable.
   *
   * An element can advertise auto and still be unable to scroll, because a `overflow: hidden`
   * ancestor is clipping it before it ever gets the chance. That is the exact shape of the bug this
   * file was written for, and the first version of this check missed it: `.main` computes
   * `overflow-x: auto` (a side effect of its `overflow-y: auto`), so every descendant looked
   * reachable while `.layout` quietly clipped the lot.
   *
   * So a scroller only counts if it is not itself being clipped horizontally by a hidden ancestor.
   */
  const clippedByHiddenAncestor = el => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.overflowX === 'hidden' && n.scrollWidth > n.clientWidth + 2) return true;
      if (s.overflowX === 'auto' || s.overflowX === 'scroll') return false;  // a real scroller above
    }
    return false;
  };
  /**
   * Visually-hidden text is CLIPPED ON PURPOSE — the standard sr-only recipe is a 1px box with
   * `overflow: hidden`, which trips the same measurement. Excluded by shape rather than by class
   * name, so a page that rolls its own sr-only span is not reported either.
   */
  const isVisuallyHidden = el => el.clientWidth <= 2 || el.clientHeight <= 2;

  const describe = el =>
    `${el.tagName.toLowerCase()}.${(typeof el.className === 'string' ? el.className : '').slice(0, 60) || '(no class)'}`;

  const out = [];

  // Rule 1 — the routed page pane must fit its width. This is the one that catches the real bugs.
  const main = document.querySelector('.main');
  if (main && main.scrollWidth > main.clientWidth + 2) {
    out.push({
      what: 'main', why: 'PAGE PANE SCROLLS SIDEWAYS',
      over: main.scrollWidth - main.clientWidth, box: main.clientWidth,
    });
  }

  // Rule 2 — genuinely clipped content, which rule 1 cannot see.
  for (const el of document.querySelectorAll('body *')) {
    if (el.scrollWidth <= el.clientWidth + 2) continue;
    if (isVisuallyHidden(el)) continue;
    let reachable = false;
    for (let n = el; n; n = n.parentElement) {
      if (scrollsX(n) && !clippedByHiddenAncestor(n)) { reachable = true; break; }
    }
    if (reachable) continue;
    out.push({ what: describe(el), why: 'CLIPPED — no scroller above it', over: el.scrollWidth - el.clientWidth, box: el.clientWidth });
  }

  // Rule 3 — reachable, but is there anything a person would SEE that says so?
  for (const el of document.querySelectorAll('body *')) {
    if (!scrollsX(el)) continue;
    if (el.scrollWidth <= el.clientWidth + 2) continue;       // fits: no affordance needed
    if (isVisuallyHidden(el)) continue;
    if (el.clientWidth < 120) continue;                        // too small to be a content scroller
    if (el.classList.contains('main')) continue;               // rule 1 owns this one

    // A native scrollbar only counts if it actually takes layout space. Overlay scrollbars — this
    // platform's default — report zero here, which is precisely the invisible case.
    const nativeBarPx = el.offsetHeight - el.clientHeight;

    // The drawn control the `hscrollTop` directive inserts immediately BEFORE its host.
    const prev = el.previousElementSibling;
    const track = prev && prev.classList.contains('hscroll-top') ? prev : null;
    const thumb = track ? track.querySelector('.hscroll-top-thumb') : null;
    let drawnVisible = false;
    if (track && thumb) {
      const t = track.getBoundingClientRect();
      const b = thumb.getBoundingClientRect();
      drawnVisible = getComputedStyle(track).display !== 'none'
        && t.width > 0 && t.height >= 3
        && b.width > 0 && b.height >= 3;
    }

    if (nativeBarPx >= 4 || drawnVisible) continue;

    out.push({
      what: describe(el),
      why: track ? 'SCROLLS — control present but not visible' : 'SCROLLS — no visible affordance',
      over: el.scrollWidth - el.clientWidth, box: el.clientWidth,
    });
  }

  // A clipped child inside a clipped parent is one problem, not two — report the worst few.
  return out.sort((a, b) => b.over - a.over).slice(0, 6);
});

/**
 * The names and tags the Files table is measured with: long enough that the German table cannot fit by accident.
 * `.md` so the server accepts them as text. One folder with a long name, so a long DIRECTORY name is measured too.
 */
const SEED_FILES = [
  { path: '/Jahresabschlussbericht-Entwurf-2026-ueberarbeitet-final-v3.md', tags: ['finanzen', 'quartalsbericht', 'vertraulich'] },
  { path: '/Protokoll-der-Sitzung-des-Lenkungsausschusses-vom-dreizehnten-Oktober.md', tags: ['protokoll'] },
  { path: '/kurz.md', tags: [] },
  { path: '/Sicherheitskonzept-Zugriffsrechte/Berechtigungsmatrix-fuer-alle-Mitarbeitenden.md', tags: ['sicherheit', 'zugriff'] },
];

/** The token the STATE file carries: the app keeps its session token in `localStorage.ythril_token`. */
const sessionToken = () => {
  if (!STATE) throw new Error('SEED=1 needs STATE: the seed writes through the REST API with the session token');
  const state = JSON.parse(readFileSync(STATE, 'utf8'));
  const token = state.origins?.flatMap(o => o.localStorage ?? []).find(item => item.name === 'ythril_token')?.value;
  if (!token) throw new Error(`no ythril_token in ${STATE}`);
  return token;
};

/**
 * Put the Files table's fixture in the first space. Idempotent (a write replaces) and additive (nothing is deleted).
 * Returns the space it wrote to, so the run can say where.
 */
async function seedFilesTab() {
  const headers = { Authorization: `Bearer ${sessionToken()}`, 'Content-Type': 'application/json' };
  const listed = await (await fetch(`${BASE}/api/spaces`, { headers })).json();
  const space = (listed.spaces ?? [])[0]?.id;
  if (!space) throw new Error('SEED=1 found no space to write into');
  for (const { path, tags } of SEED_FILES) {
    const url = `${BASE}/api/files/${space}?path=${encodeURIComponent(path)}`;
    const answer = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ content: `# ${path}\n\nA seeded file for the responsive sweep.\n`, tags }) });
    if (!answer.ok) throw new Error(`seeding ${path} answered ${answer.status}: ${await answer.text()}`);
  }
  console.log(`seeded ${SEED_FILES.length} files in space "${space}"`);
  return space;
}

/**
 * Measure the Files table. Runs in page context.
 *
 * `treeOpen` and `paneOpen` say what state the page is in, so the one assertion that depends on them is
 * made only where it is expected to hold (see the docblock at the top).
 */
const measureFilesTable = ({ width, treeOpen, paneOpen }) => page.evaluate(({ width, treeOpen, paneOpen }) => {
  const out = [];
  const table = document.querySelector('app-file-listing table');
  const wrapper = document.querySelector('app-file-listing .table-wrapper');
  if (!table || !wrapper) return [{ what: 'app-file-listing', why: 'NO FILES TABLE ON THE PAGE', over: 0, box: 0 }];
  const rows = [...table.querySelectorAll('tbody tr')];
  if (rows.length < 2) return [{ what: 'app-file-listing', why: `ONLY ${rows.length} ROW(S): the fixture is not there (SEED=1?)`, over: 0, box: 0 }];

  // The table must not scroll sideways where the window has the room for it.
  const fitsExpected = !paneOpen && (width >= 1400 || (width >= 1024 && !treeOpen));
  const over = wrapper.scrollWidth - wrapper.clientWidth;
  if (fitsExpected && over > 1) {
    out.push({ what: 'files table', why: `SCROLLS SIDEWAYS at ${width}px with the tree ${treeOpen ? 'open' : 'closed'} and the pane closed`, over, box: wrapper.clientWidth });
  }

  // The actions column must be reachable WITHOUT scrolling: inside the wrapper's visible box, every button whole.
  const box = wrapper.getBoundingClientRect();
  const cells = [...table.querySelectorAll('td.actions-cell')];
  if (!cells.length) out.push({ what: 'files table', why: 'NO td.actions-cell: the actions column is not marked', over: 0, box: 0 });
  for (const cell of cells) {
    for (const button of cell.querySelectorAll('button')) {
      const r = button.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.right > box.right + 1 || r.left < box.left - 1) {
        out.push({ what: `button ${button.getAttribute('aria-label') ?? ''}`.trim(), why: 'ACTION NOT VISIBLE without scrolling the table', over: Math.round(Math.max(r.right - box.right, box.left - r.left)), box: Math.round(box.width) });
      }
    }
  }

  // A long name ellipsizes (title carries the whole of it) rather than widening the table.
  for (const name of table.querySelectorAll('.name-cell .file-name-btn')) {
    if (name.scrollWidth > name.clientWidth + 1 && getComputedStyle(name).textOverflow !== 'ellipsis') {
      out.push({ what: 'file-name-btn', why: 'LONG NAME CLIPPED WITHOUT AN ELLIPSIS', over: name.scrollWidth - name.clientWidth, box: name.clientWidth });
    }
    if (!name.getAttribute('title')) out.push({ what: 'file-name-btn', why: 'NAME HAS NO TITLE for the part an ellipsis hides', over: 0, box: 0 });
  }
  return out;
}, { width, treeOpen, paneOpen });

/**
 * The Files tab in the states the matrix names: tree open, tree closed, then the detail pane open on a file.
 * Called after the route has loaded. The tree toggle's state is remembered by the app in `localStorage`, so it is
 * set, and the page reloaded, rather than clicked (the toolbar's own label is a translation).
 */
async function sweepFilesTab(routeLabel, w) {
  for (const treeOpen of [true, false]) {
    await page.evaluate(open => localStorage.setItem('ythril.sidebar', open ? 'open' : 'closed'), treeOpen);
    await page.goto(BASE + FILES_TAB, { waitUntil: 'networkidle', timeout: 25_000 });
    await page.waitForSelector('app-file-listing table tbody tr', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(500);
    const state = { width: w, treeOpen, paneOpen: false };
    const label = `${routeLabel} [files table, tree ${treeOpen ? 'open' : 'closed'}]`;
    if (report(label, await measureFilesTable(state))) await shoot(label, w);

    // The pane open on a file: the table may scroll now, and its actions must still be reachable.
    const file = page.locator('app-file-listing tbody .file-name-btn:not(.dir)').first();
    if (await file.count()) {
      await file.click().catch(() => {});
      await page.waitForTimeout(500);
      const paneLabel = `${routeLabel} [files table, tree ${treeOpen ? 'open' : 'closed'}, pane open]`;
      if (report(paneLabel, await measureFilesTable({ ...state, paneOpen: true }))) await shoot(paneLabel, w);
    }
  }
  // Back to the app's default (the tree open), so the routes after this one are swept in the state a first visit sees.
  await page.evaluate(() => localStorage.setItem('ythril.sidebar', 'open'));
}

const report = (label, hits) => {
  if (!hits.length) return false;
  findings += hits.length;
  console.log(label);
  for (const f of hits) console.log(`    ${f.what} — ${f.why} (${f.over}px past a ${f.box}px box)`);
  return true;
};

const shoot = async (label, w) => {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/sweep-${localeLabel}${label.replace(/[^a-z0-9]+/gi, '_')}-${w}.png` });
};

/**
 * Click through a tab strip, measuring each panel.
 *
 * Re-queries by index on every iteration rather than holding element handles: activating a tab
 * re-renders the strip, and a stale handle would either throw or click the wrong control. Recursion is
 * capped at one extra level, which covers Review's sub-tabs and the file-detail segmented control
 * without wandering into dialogs.
 */
async function sweepTabs(routeLabel, w, depth = 0) {
  const count = await page.locator(TAB_SELECTOR).count();
  if (count === 0 || depth > 1) return;

  for (let i = 0; i < count; i++) {
    const tab = page.locator(TAB_SELECTOR).nth(i);
    let label = '';
    try {
      label = ((await tab.textContent()) ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
      await tab.click({ timeout: 3_000 });
    } catch {
      continue;   // a tab that vanished when a sibling was activated is not a finding
    }
    await page.waitForTimeout(450);   // deferred blocks and the first data fetch

    const panelLabel = `${routeLabel} > ${label || `tab#${i}`}`;
    if (report(panelLabel, await measure())) await shoot(panelLabel, w);

    // Sub-strips only: if activating this tab revealed MORE tabs than the strip we are walking.
    if (depth === 0 && (await page.locator(TAB_SELECTOR).count()) > count) {
      await sweepTabs(panelLabel, w, depth + 1);
    }
  }
}

if (process.env.SEED) await seedFilesTab();

for (const locale of LOCALES) {
  const ctx = await browser.newContext({ ...(STATE ? { storageState: STATE } : {}), ...(locale ? { locale } : {}) });
  // The app reads its language from localStorage before it renders: set it before the first script of every page.
  if (locale) await ctx.addInitScript(l => { try { localStorage.setItem('lang', l); } catch { /* storage is a convenience */ } }, locale);
  page = await ctx.newPage();
  localeLabel = locale ? `${locale}-` : '';
  if (locale) console.log(`\n########## locale ${locale} ##########`);

  for (const [w, h] of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h });
    console.log(`\n===== ${w}x${h} =====`);

    for (const route of ROUTES) {
      try {
        await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 25_000 });
      } catch {
        console.log(`${route}  — load timed out, skipped`);
        continue;
      }
      await page.waitForTimeout(700);   // let deferred blocks and async data settle

      if (report(route, await measure())) await shoot(route, w);
      if (route === FILES_TAB) await sweepFilesTab(route, w);
      else await sweepTabs(route, w);
    }
  }

  await ctx.close();
}

await browser.close();
console.log(`\nfindings: ${findings}`);
process.exit(findings ? 1 : 0);
