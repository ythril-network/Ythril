/**
 * A text as HTML: nothing in it can open a tag, end an attribute or start an entity, so it reads as the characters it contains.
 *
 * Needed wherever a value that somebody else wrote (an imported file, a type name, a document heading) enters a string that is then bound
 * as HTML: Angular's sanitizer strips what is dangerous, but it KEEPS `<b>`, `<i>` and `<a>`, so a name carrying them would render as
 * markup rather than as the name. The markdown renderer's fallback block and the import-conflict dialog use this one copy (the Help page's anchor
 * labels keep their own attribute-only escape, because `help-links.ts` is deliberately import-free so a gate can load it as it stands).
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
