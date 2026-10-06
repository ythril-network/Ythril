/**
 * The id a rendered heading gets: GitHub's heading-anchor slug, and its `-1`, `-2` suffix for a repeated heading.
 *
 * ## The question it answers
 *
 * "What anchor does this heading have in the rendered document?" Asked by `MarkdownRenderService` when it renders a
 * heading, and by the gate that holds every Help link's `#anchor` to a heading the view has
 * (`every-help-page-links-only-to-pages-the-help-view-has`), which runs THESE functions over the real headings rather than
 * restating the rule — a second copy of it is how a link checker comes to agree with itself.
 *
 * Pure and import-free so the gate can load it as it stands.
 */

/**
 * GitHub's heading-anchor slug, because that is the dialect the documents are already written in.
 *
 * The user guide's table of contents alone carries 30 anchor links, and every one of them was authored
 * against GitHub's rules: lowercase, strip anything that is not a word character, space or hyphen, spaces
 * to hyphens. That is why this is not "some slug function" — an implementation that merely produced
 * *stable* ids would still leave every one of those links pointing at nothing.
 *
 * They read `](userguide/02-brain.md#facts)` since the guide was split into chapters, which changes
 * nothing here: the Help page joins the chapters into one document and strips the file prefix, so the
 * fragment still has to resolve against a heading THIS function turned into an id.
 *
 * Note em-dashes: `## Brain — Review tab` drops the dash and keeps both spaces, giving the double hyphen
 * in `#brain--review-tab`. Matching that oddity is the point.
 */
export function headingSlug(text: string): string {
  return text.trim().toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s/g, '-');
}

/**
 * The text of a heading as the reader sees it, from the inline HTML the renderer made of it: tags dropped, and the
 * entities the renderer escapes (`&amp; &lt; &gt; &quot; &#39;`) put back. Slugged from the HTML as it stands, an `&` became
 * `&amp;` and left `amp` in the id (`## A & B` → `a-amp-b`, where GitHub, and every link in the guides, says `a--b`).
 */
export function headingTextOf(inlineHtml: string): string {
  return inlineHtml.replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&amp;/g, '&');
}

/**
 * DOMPurify's namespace for an `id` that would shadow a property of `document`: the form of the id that cannot (its own
 * `SANITIZE_NAMED_PROPS_PREFIX`; the sanitizer applies it to every id only when asked to, and we apply it to the ones it
 * would otherwise remove).
 */
export const NAMED_PROP_PREFIX = 'user-content-';

/**
 * Would an element with this `id` shadow a property of `document` or of a form (DOM clobbering)? The sanitizer's own question,
 * asked the way it asks it (`value in document || value in formElement`): it removes such an id, leaving `id=""` — and `## Links`
 * (`document.links`) was a heading no link could reach. False where there is no DOM to ask (the gate loads this in Node).
 */
export function isDomPropertyName(id: string): boolean {
  if (typeof document === 'undefined') return false;
  return id in document || id in document.createElement('form');
}

/**
 * The id a heading with this slug gets in the sanitized document: the slug, or — when the sanitizer would remove it —
 * `user-content-<slug>`. `clobbers` is the question above; the gate passes one that asks a jsdom document.
 */
export function headingIdFor(slug: string, clobbers: (id: string) => boolean = isDomPropertyName): string {
  return clobbers(slug) ? NAMED_PROP_PREFIX + slug : slug;
}

/** The ids an element addressed by `#fragment` may have: the fragment itself, or its namespaced form (`headingIdFor`). */
export function elementIdsFor(fragment: string): readonly string[] {
  return [fragment, NAMED_PROP_PREFIX + fragment];
}

/** Adds `-1`, `-2`, … to repeated slugs, as GitHub does, so duplicate headings stay addressable. One per rendered document. */
export function makeSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text: string) => {
    const base = headingSlug(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
}
