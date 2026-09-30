/**
 * A list in the reader's language — "a, b and c", "a, b und c", "a, b i c" — never a hard-coded comma.
 *
 * Written privately in the network join dialog first; the shortened-answer advice (`Q-116`) is the second caller,
 * which is why it is a module. The guard a hand copy drops is the fallback: `Intl.ListFormat` throws on a locale
 * the browser does not know, and a thrown render is a blank notice.
 */
export function formatList(items: readonly string[], language: string): string {
  try { return new Intl.ListFormat(language || 'en', { type: 'conjunction' }).format(items); } catch { return items.join(', '); }
}
