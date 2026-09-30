/**
 * Which guide section documents which page.
 *
 * One table instead of a "?" hand-placed in every page header: the shell resolves the active URL against
 * this and renders a single help control. A page absent from the table renders **no** control, which is
 * the honest outcome — a help link that lands on the top of a 900-line guide has moved the search rather
 * than answered it, so "we have no section for this yet" must look different from "here is the section".
 *
 * `anchor` is a GitHub-style heading slug (see `headingSlug` in `MarkdownRenderService`), because that is
 * the dialect the documents' own tables of contents already use. Every entry here is checked against the
 * real headings in `docs/` by the `help-anchor-coverage` gate — an anchor that does not resolve scrolls
 * nowhere and reports nothing, which is precisely the kind of silent failure preflight exists for.
 *
 * Matching is longest-prefix, so a more specific route wins over the section it sits in.
 */
export interface HelpTarget {
  /** A `HELP_DOCS` id. */
  doc: string;
  /** Heading slug within that guide. */
  anchor: string;
}

export const HELP_ANCHORS: { prefix: string; target: HelpTarget }[] = [
  { prefix: '/settings/spaces', target: { doc: 'userguide', anchor: 'settings--spaces' } },
  { prefix: '/settings/tokens', target: { doc: 'userguide', anchor: 'settings--tokens' } },
  { prefix: '/settings/networks', target: { doc: 'userguide', anchor: 'settings--networks' } },
  { prefix: '/settings/media-processing', target: { doc: 'userguide', anchor: 'settings--media-processing' } },
  { prefix: '/settings/storage', target: { doc: 'userguide', anchor: 'settings--storage' } },
  { prefix: '/settings/data', target: { doc: 'userguide', anchor: 'settings--data' } },
  { prefix: '/settings/audit-log', target: { doc: 'userguide', anchor: 'settings--audit-log' } },
  { prefix: '/settings/webhooks', target: { doc: 'userguide', anchor: 'settings--webhooks' } },
  { prefix: '/settings/embedding', target: { doc: 'userguide', anchor: 'settings--embedding' } },
  // Preferences got its own section when it gained the Date and time setting (Q-146); MFA, embedded on the same
  // page, is the section right after it. The entry used to read `/settings/mfa`, which nothing routes to.
  { prefix: '/settings/preferences', target: { doc: 'userguide', anchor: 'settings--preferences' } },
  // `/schema-library`, NOT `/settings/schema-library`: the latter was never a route. A dead duplicate of the
  // page under pages/settings/ made it look like one, so the real page had no Help target at all while the
  // table looked complete. The route-coverage test below is what stops that recurring.
  { prefix: '/schema-library', target: { doc: 'userguide', anchor: 'schema-library' } },
  { prefix: '/brain', target: { doc: 'userguide', anchor: 'brain' } },
  { prefix: '/files', target: { doc: 'userguide', anchor: 'files' } },
];

/**
 * The help target for a URL, or null when the page has none.
 *
 * Longest prefix wins: `/settings/schema-library` must not be answered by a `/settings` entry, and
 * `/brain` must not swallow a future `/brain/something` with its own section.
 *
 * The Help page itself is deliberately excluded — a help link on the help page is furniture.
 */
export function helpTargetFor(url: string): HelpTarget | null {
  const path = url.split(/[?#]/)[0];
  if (path.startsWith('/settings/help')) return null;
  let best: { prefix: string; target: HelpTarget } | null = null;
  for (const entry of HELP_ANCHORS) {
    if (path !== entry.prefix && !path.startsWith(`${entry.prefix}/`)) continue;
    if (!best || entry.prefix.length > best.prefix.length) best = entry;
  }
  return best?.target ?? null;
}
