/**
 * Which space types use which schema-library entry — every entry, in ONE pass over the spaces (`Q-112`).
 *
 * The library page asked `GET /api/schema-library/:name/usages` once PER ENTRY to put "3 links" beside each row:
 * N requests to draw one page, each scanning every space's type schemas. The list answer now carries every entry's
 * count from one call to this, and the per-entry route reads the same function — so what counts as a use cannot
 * differ between the two: a type whose stored schema is `{ $ref: "library:<name>" }`.
 *
 * Reads the STORED schemas (`space.meta.typeSchemas`), where a library type is its reference, never the definition
 * a read joins beside it.
 */
import { KNOWLEDGE_TYPES } from '../config/types.js';

export interface LibraryUsage {
  spaceId: string;
  spaceLabel: string;
  knowledgeType: string;
  typeName: string;
}

interface SpaceLike {
  id: string;
  label: string;
  meta?: { typeSchemas?: Partial<Record<string, Record<string, unknown> | undefined>> };
}

const PREFIX = 'library:';

/** Entry name → every space type that references it, in space order and then knowledge-type order. */
export function libraryUsages(spaces: readonly SpaceLike[]): Map<string, LibraryUsage[]> {
  const out = new Map<string, LibraryUsage[]>();
  for (const space of spaces) {
    const ts = space.meta?.typeSchemas;
    if (!ts) continue;
    for (const kt of KNOWLEDGE_TYPES) {
      const ktMap = ts[kt];
      if (!ktMap) continue;
      for (const [typeName, schema] of Object.entries(ktMap)) {
        const ref = (schema as { $ref?: unknown } | null)?.$ref;
        if (typeof ref !== 'string' || !ref.startsWith(PREFIX)) continue;
        const name = ref.slice(PREFIX.length);
        const list = out.get(name) ?? [];
        list.push({ spaceId: space.id, spaceLabel: space.label, knowledgeType: kt, typeName });
        out.set(name, list);
      }
    }
  }
  return out;
}
