/**
 * When a page of the app has LOADED, for a browser sweep that measures it (`Q-401`).
 *
 * ## What it prevents
 *
 * A sweep that measures a page after a fixed pause has guessed how long the first data load takes. On a slow instance it
 * measures the skeleton, and the report is clean about a page it never saw. A quiet network (`waitUntil: 'networkidle'`)
 * is not the answer either: it says the requests in flight have ended, not that a deferred block has rendered what they
 * brought. What does mean "loaded" is the loading indicators being gone, and the sweeps had each written that list — so
 * it is here, once.
 *
 * The list is what the app shows while a page is still loading, and nothing else: the Overview's shimmer lines
 * (`app-skeleton-lines`), the `.loading-overlay` every page and tab puts up while its request is out, the file tree's
 * `.tree-spinner`, and a panel marked `aria-busy`. Each is an `@if`/`@defer` branch, gone from the DOM once the data has
 * landed. A bare `.spinner` is NOT here: a button shows one while it reindexes or backs up, which is a state and not a load,
 * and a wait on it would hang.
 *
 * Both waits throw on a miss, so a sweep fails rather than measuring a page that did not load.
 */

/** What the app shows while a page is still loading. */
export const LOADING = 'app-skeleton-lines, .loading-overlay, .tree-spinner, section[aria-busy="true"]';

/**
 * The routed page's own element. The shell's `main.main` holds `.page-help`, the `<router-outlet>`, and — once the route has
 * rendered — the routed component right after the outlet. The outlet itself is there from the first paint of the shell, so a
 * selector it can match (`:not(.page-help)`) would hold before any page exists.
 */
export const ROUTED_PAGE = 'main.main > router-outlet + *';

/**
 * Resolve when nothing in {@link LOADING} is on `page`; throw after `timeout`.
 *
 * @param {import('playwright').Page} page
 * @param {number} [timeout]
 */
export const loadingGone = (page, timeout = 10_000) =>
  page.waitForFunction((sel) => !document.querySelector(sel), LOADING, { timeout });

/**
 * Resolve when `loaded` is on `page` and {@link loadingGone}: the page is measured after its data, never after a guessed
 * pause.
 *
 * @param {import('playwright').Page} page
 * @param {string} loaded selector of an element that exists only once the thing being measured has rendered
 * @param {number} [timeout]
 */
export async function pageLoaded(page, loaded, timeout = 10_000) {
  await page.waitForSelector(loaded, { timeout });
  await loadingGone(page, timeout);
}
