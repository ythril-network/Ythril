/**
 * The one gate every schema write to a space passes: refused while an RDF import stands for that space (bundle-270, plan amendment A3).
 *
 * ## What it prevents
 *
 * An RDF import judges a whole file against the space's schema in a dry plan, then commits it kind by kind, and its commit never refuses
 * (amendment A1): everything the store would refuse was refused by the dry plan, by the same planners. A schema edited between the two, or
 * across a restart of the act, would make the commit meet a schema its dry plan never saw (a property made required, a type removed, the
 * validation mode raised) and fail item after item, leaving the act owed for ever and the space closed. The space write gate already closes
 * the space to record writes while any act stands; nothing closed it to schema writes, which live in the config, not in a collection.
 *
 * So the store's schema writers ask this gate before they write: `updateSpace` when it is handed a meta, `commitOwnMetaEdit` (the per-type
 * writes and every own-definition edit), and the meta update before it writes anything (the space PATCH and MCP `schema_update`, so a write
 * that also carries local settings changes none of them). A refusal is the space write gate's own error with the act's own code, so every
 * door answers it as it answers a record write the act refuses (`spaceActAnswer`: 409 `space_being_imported`, the sentence naming the RDF import). The import's own body
 * passes by its scope (`space-act-scope.ts`), for the schema step a later slice adds.
 */
import { getConfig, isConfigLoaded } from '../config/loader.js';
import { SPACE_ACT_KINDS } from '../config/types-space-acts.js';
import { spaceActsOfSpace } from './space-act-runner.js';
import { spaceActInScope } from './space-act-scope.js';
import { SpaceNotWritableError } from './space-write-gate.js';

/** The act kind that closes its space to schema writes. */
const HOLDS_THE_SCHEMA = 'rdf-import' as const;

/**
 * Throw the act's refusal when an RDF import stands for `spaceId` (other than the act this call runs in); return quietly otherwise. Called by
 * every writer of a space's schema before it writes anything.
 */
export function assertSchemaWritable(spaceId: string): void {
  if (!isConfigLoaded()) return;
  const own = spaceActInScope();
  const standing = spaceActsOfSpace(getConfig(), spaceId).find(e => e.kind === HOLDS_THE_SCHEMA && e.id !== own);
  if (!standing) return;
  const spec = SPACE_ACT_KINDS[HOLDS_THE_SCHEMA];
  throw new SpaceNotWritableError(
    spaceId, `${spec.writeRefusalWhy()}; its schema is held too, since the import is judged by the schema it started with`, spec.writeRefusalCode,
  );
}
