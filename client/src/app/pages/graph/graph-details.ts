/**
 * The graph side panel's detail table — deriving, filtering and sorting the rows.
 *
 * Extracted from `graph.component.ts` (2065 lines) as part of the god-file split. Pure by design: no
 * Angular, no HTTP, no DOM. Everything here is pinned by `graph.component.characterization.spec.ts`,
 * which was written and mutation-validated against the ORIGINAL component before this file existed —
 * so behaviour is preserved by construction, not by inspection.
 *
 * Follows the `pages/brain/recall-grouping.ts` precedent: a plain module beside the component rather
 * than an injectable, because nothing here needs DI or holds state. The component's `computed()`
 * signals call straight into these functions.
 *
 * Two behaviours below look like oversights and are deliberately preserved — the split is not the
 * place to change them, and each is characterized so changing it later is a visible decision:
 *
 *   - Fact and chrono rows read DIFFERENT primary fields (`fact` / `title`) with a shared fallback
 *     to `description`, which is why the two mappers are not collapsed into one.
 *   - Chrono rows always carry an EMPTY properties bag, even though chrono records can hold
 *     schema-defined properties (#397). Surfacing them is a feature decision.
 */

/** One row of the side panel's detail table. */
export interface DetailRow {
  id: string;
  kind: 'fact' | 'chrono';
  description: string;
  tags: string[];
  properties: Record<string, unknown>;
  createdAt: string;
  raw: Record<string, unknown>;
}

/**
 * What opening a detail popup actually needs.
 *
 * The template used to build four full `DetailRow` literals — seven fields each — at the click
 * handlers, of which the handler reads exactly two. The copies had already drifted (they passed a bare
 * `{}` for `properties` where the table's rows pass the record's own), harmlessly only because nothing
 * read the field. Narrowing the parameter deletes the duplication instead of relocating it; a full
 * `DetailRow` still satisfies this shape, so the table's own rows pass through unchanged.
 */
export interface DetailRef {
  id: string;
  kind: 'fact' | 'chrono';
}

/** How the table is currently filtered and ordered. */
export interface DetailView {
  type: 'all' | 'fact' | 'chrono';
  text: string;
  field: 'description' | 'createdAt';
  asc: boolean;
}

/** Records as they arrive from the API — only the fields this table reads are required. */
interface MemoryLike {
  _id: string;
  fact?: string;
  description?: string;
  tags?: string[];
  properties?: Record<string, unknown>;
  createdAt: string;
}
interface ChronoLike {
  _id: string;
  title?: string;
  description?: string;
  tags: string[];
  createdAt: string;
}

/** A memory's display text: its fact, falling back to its description. */
export function memoryText(m: MemoryLike): string {
  return m.fact || m.description || '';
}

/** A chrono entry's display text: its title, falling back to its description. */
export function chronoText(c: ChronoLike): string {
  return c.title || c.description || '';
}

/**
 * All rows for the selected node, facts first.
 *
 * Order matters: it is the tie-break whenever two records share a sort key, so it is the difference
 * between a stable table and one that reshuffles on re-render.
 */
export function buildDetailRows(facts: readonly MemoryLike[], chrono: readonly ChronoLike[]): DetailRow[] {
  return [
    ...facts.map((m): DetailRow => ({
      id: m._id,
      kind: 'fact',
      description: memoryText(m),
      tags: m.tags ?? [],
      properties: m.properties ?? {},
      createdAt: m.createdAt,
      raw: m as unknown as Record<string, unknown>,
    })),
    ...chrono.map((c): DetailRow => ({
      id: c._id,
      kind: 'chrono',
      description: chronoText(c),
      tags: c.tags,
      properties: {},          // see the header note — deliberately not read from the record
      createdAt: c.createdAt,
      raw: c as unknown as Record<string, unknown>,
    })),
  ];
}

/**
 * Narrow by kind, then by a case-insensitive substring of the description, then order.
 *
 * The three compose rather than override — the text filter applies within the chosen kind, and the
 * sort applies to whatever survived. Sorts a copy: the caller's array is derived state and mutating it
 * in place would mean a signal's value changing without a write, which OnPush would never see.
 */
export function filterAndSortDetails(rows: readonly DetailRow[], view: DetailView): DetailRow[] {
  let out = rows as readonly DetailRow[];
  if (view.type !== 'all') out = out.filter(r => r.kind === view.type);

  const needle = view.text.toLowerCase();
  if (needle) out = out.filter(r => r.description.toLowerCase().includes(needle));

  return [...out].sort((a, b) => {
    const va = view.field === 'description' ? a.description.toLowerCase() : a.createdAt;
    const vb = view.field === 'description' ? b.description.toLowerCase() : b.createdAt;
    return view.asc ? (va < vb ? -1 : va > vb ? 1 : 0)
                    : (va > vb ? -1 : va < vb ? 1 : 0);
  });
}

/**
 * What clicking a column header does.
 *
 * The asymmetry is the whole behaviour: re-clicking the ACTIVE column reverses it, but clicking a NEW
 * column always starts ascending rather than inheriting the previous column's direction. Inheriting
 * would mean the same click producing different orders depending on history.
 */
export function nextSort(
  current: { field: 'description' | 'createdAt'; asc: boolean },
  field: 'description' | 'createdAt',
): { field: 'description' | 'createdAt'; asc: boolean } {
  return current.field === field ? { field, asc: !current.asc } : { field, asc: true };
}
