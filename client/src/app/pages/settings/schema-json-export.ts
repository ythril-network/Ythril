import type { Space, SpaceMeta } from '../../core/api.types';
import { saveBlob } from '../../core/authenticated-download';

/**
 * The Schema tab's "Export JSON": the space's type schemas as the editor holds them, saved as `<space>_schemas.json` (the file the schema
 * library's "Import from file" reads). Moved out of `space-schema-tab.component.ts` (over its size ceiling) beside "Export RDF" (Q-942).
 */
export function saveSchemaJson(space: Pick<Space, 'id' | 'label'>, meta: Partial<SpaceMeta>): void {
  const payload = {
    spaceId:     space.id,
    spaceLabel:  space.label,
    exportedAt:  new Date().toISOString(),
    typeSchemas: meta.typeSchemas ?? {},
  };
  saveBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `${space.id}_schemas.json`);
}
