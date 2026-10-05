/**
 * Which page of the Help view a relative link in a guide points at.
 *
 * ## The question it answers
 *
 * "This link is written as `href` in a guide whose pages live in `fromDir` — which page of the view is it?" Asked by the
 * view when a link is clicked (`HelpComponent.onDocClick`) and by the gate that holds every guide's links to the pages the
 * view has (`every-help-page-links-only-to-pages-the-help-view-has`), which runs THIS function over every link rather than
 * restating the rule.
 *
 * ## What it prevents
 *
 * The guides are written for GitHub, where `](02-hosting.md)` in `integration-guide/03-auth-and-limits.md` is the page
 * beside it. The view joins a split guide's parts into one document, so a link no longer sits in a file: read as
 * `02-hosting.md` it matched no page and opened a dead tab on `assets/docs/02-hosting.md` — 42 links of the integration
 * guide and the user guide did. A link is resolved against the directory its guide's pages live in BEFORE it is looked up,
 * which keeps the guides correct on GitHub and in the app with no link rewritten.
 *
 * ## The guard a hand-written copy would drop
 *
 * A `..` that climbs out of the docs folder stays at the root rather than becoming a path nothing holds (the guides are all
 * inside it, so a link above it is one written for the repository root and means the docs root here), and a link that
 * names a page by its path from the docs root — the older spelling, `integration-guide/04-brain-api.md` from the user
 * guide — is still found after the resolved spelling is not.
 *
 * Pure and import-free so the gate can load it as it stands: no Angular, no `HELP_DOCS`; the pages are the caller's.
 */

/** A relative link to a markdown page: `userguide.md`, `./x.md#frag`, `../integration-guide/04-brain-api.md`. Anything else is not one. */
const MARKDOWN_LINK = /^((?:(?:\.{1,2}|[a-z0-9-]+)\/)*[a-z0-9-]+\.md)(?:#(.*))?$/i;

export interface HelpLink {
  /** The page the link names, from the docs root, when the view holds it; else `null`. */
  readonly page: string | null;
  /** The path as the link spells it with its leading `./` and `../` dropped: what a tab on the raw document is opened at. */
  readonly bare: string;
  /** The text after `#`, or `undefined`. */
  readonly fragment: string | undefined;
}

/** `path` joined onto `dir` (both from the docs root, `/`-separated), a `..` above the root staying at the root. */
function resolveFrom(dir: string, path: string): string {
  const out = dir ? dir.split('/') : [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return out.join('/');
}

/**
 * @param href the `href` of an anchor in a rendered guide
 * @param fromDir the directory, from the docs root, the guide's pages live in (`''` for a guide that is one file at the root)
 * @param holds whether the view has a page at this path from the docs root
 * @returns the link read as a link to a markdown page, or `null` when it is not one (an address, an anchor, a repository file)
 */
export function resolveHelpLink(href: string, fromDir: string, holds: (page: string) => boolean): HelpLink | null {
  const m = MARKDOWN_LINK.exec(href);
  if (!m) return null;
  const path = m[1]!;
  const bare = path.replace(/^(?:\.{0,2}\/)+/, '');
  const resolved = resolveFrom(fromDir, path);
  const page = holds(resolved) ? resolved : holds(bare) ? bare : null;
  return { page, bare, fragment: m[2] };
}

/** A guide as `HELP_DOCS` lists it: its index `file`, and the `parts` it is split into, if it is. */
export interface HelpGuide {
  readonly file: string;
  readonly parts?: readonly string[];
}

/** The pages a guide renders: its parts, or its own file when it is one file. (A split guide's index `file` is not rendered.) */
export const renderedPagesOf = (guide: HelpGuide): readonly string[] => guide.parts ?? [guide.file];

/**
 * The directory, from the docs root, a guide's pages live in: its parts' (they share one), or `''` for a guide that is one
 * file at the root. A link in the guide is resolved against it (`resolveHelpLink`).
 */
export function guideDir(guide: HelpGuide): string {
  const first = renderedPagesOf(guide)[0]!;
  return first.includes('/') ? first.slice(0, first.lastIndexOf('/')) : '';
}

/**
 * A part without what only makes sense on its own in a repository browser: its own H1 and the "Part of the …" backlink to an
 * index this view does not render. Concatenated, seventeen H1s and seventeen backlinks would be noise.
 */
export function stripPartHeader(chunk: string): string {
  return chunk
    .replace(/^#\s.*(\r?\n)+/, '')                                      // the part's own H1
    .replace(/^>\s*Part of the \[[^\]]*\]\([^)]*\)\.\s*(\r?\n)+/m, ''); // and its backlink
}

/**
 * A link from one part to a heading in another, `](04-brain-api.md#schema-validation)` on disk because that is what
 * resolves on GitHub, as a plain anchor: every part is in one document here, so the file prefix has to come off or the link
 * leaves the page. A link to a part with no fragment is left as it is — it is a page link, resolved by `resolveHelpLink`.
 */
export function foldPartLinks(text: string, files: readonly string[]): string {
  const names = files.map(f => f.split('/').pop()!);
  const prefix = new RegExp(`\\]\\((?:${names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(#[^)]+)\\)`, 'g');
  return text.replace(prefix, ']($1)');
}

/**
 * The id of the anchor at the start of a part in the joined document, derived from the part's file name
 * (`integration-guide/02-hosting.md` → `part:02-hosting`). The `:` is the point: the heading rule (`heading-slug.ts`) keeps word
 * characters, spaces and hyphens and nothing else, so no heading's id can equal it, and two parts of a guide differ in their
 * file name. A link to a page of the guide with no fragment scrolls here (`landingOf`).
 */
export const partAnchorId = (file: string): string => `part:${file.split('/').pop()!.replace(/\.md$/i, '')}`;

/**
 * A split guide's parts as ONE document, the way the view renders it (`HelpComponent`). One file is returned as it is.
 *
 * Each part starts at an anchor of its own (`partAnchorId`): the part's H1 is stripped, so without one a link to the part
 * (`](02-hosting.md)`, no fragment) names a place the document has no element at, and the click was a no-op (round W, V2).
 */
export function joinHelpParts(chunks: readonly string[], files: readonly string[]): string {
  if (chunks.length === 1) return chunks[0]!;
  return foldPartLinks(chunks.map((chunk, i) => `<div id="${partAnchorId(files[i]!)}"></div>\n\n${stripPartHeader(chunk)}`).join('\n\n'), files);
}

/**
 * Where, inside the guide that holds the page, a link lands: its fragment when it has one; else the start of the page it
 * names — a part's anchor in a split guide — and `undefined` (the top of the guide) for the guide's own file, which a split
 * guide does not render (`../integration-guide.md`), and for a guide that is one file. The view scrolls to it and the gate
 * that holds every link to the pages the view has asks the same question, so a link is held only if this ends at an element.
 */
export function landingOf(link: HelpLink, guide: HelpGuide): { readonly anchor: string | undefined } {
  if (link.fragment !== undefined) return { anchor: link.fragment };
  if (link.page !== null && guide.parts?.includes(link.page)) return { anchor: partAnchorId(link.page) };
  return { anchor: undefined };
}
