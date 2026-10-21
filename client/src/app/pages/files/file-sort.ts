import type { FileEntry } from '../../core/api.types';

/** The columns the listing sorts by; '' is the server's own order. */
export type FileSortField = '' | 'name' | 'status' | 'size' | 'modified';

/**
 * A directory listing in the order its column asks for.
 *
 * Sorted CLIENT-side, which is honest here and only here: `listFiles` returns a whole directory in one response (no limit/skip), so this
 * reorders the complete set. The paginated record tabs sort server-side for exactly the opposite reason: there, a client sort would reorder
 * one page and lie about the rest.
 *
 * Folders always come first. This is a file explorer, and interleaving directories with files by size or date makes the tree unnavigable;
 * the chosen column orders WITHIN each group, with the name as the stable tiebreak. Moved out of `file-manager.component.ts` (frozen by the
 * size ratchet) when personal views needed lines there: it is a pure function of its three arguments.
 */
export function sortFileEntries(list: FileEntry[], field: FileSortField, dir: 'asc' | 'desc'): FileEntry[] {
  if (!field) return list;
  const sign = dir === 'asc' ? 1 : -1;
  const key = (e: FileEntry): string | number => {
    switch (field) {
      case 'size': return e.size ?? 0;
      case 'modified': return e.modified ?? '';
      case 'status': return e.embeddingStatus ?? '';
      default: return e.name.toLowerCase();
    }
  };
  return [...list].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    const ka = key(a), kb = key(b);
    if (ka === kb) return a.name.localeCompare(b.name);   // stable, human tiebreak
    return (typeof ka === 'number' && typeof kb === 'number')
      ? (ka - kb) * sign
      : String(ka).localeCompare(String(kb)) * sign;
  });
}
