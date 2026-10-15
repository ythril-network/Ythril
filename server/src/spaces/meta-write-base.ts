/**
 * What a schema write is merged OVER, and what it leaves — one answer for the planner that stores the write (`planSpaceMetaUpdate`) and
 * the rights check that prices it (`typeRuleEditsIn`).
 *
 * ## What it prevents
 *
 * The rights check priced a type-rule edit against a base it derived for itself, a second copy of the planner's — and it walked only the
 * types the BODY named. Under `typeSchemasMode: 'replace'` a type is removed by leaving it out, so a schema writer could delete every rule
 * of a space by replacing its types with a map that did not name the ruled ones (`a-type-dropped-with-its-rules-is-priced-as-a-rules-edit`):
 * what the write LEAVES was never asked. Both now ask this module: the base the write is merged over and the meta it leaves, so the two
 * cannot price and store different edits.
 *
 * ## The base
 *
 * The definitions a write changes are THIS INSTANCE'S OWN (`ownMeta`, once a network layer exists; `meta` is all its own until then):
 * `space.meta` is the effective meta, own laid under each layer, and a type both define is the union of the two there. A write that targets
 * a network (`targetNetwork`) changes that network's layer instead — and only a network that carries the space has one.
 */
import type { NetworkConfig, SpaceConfig, SpaceMeta, KnowledgeType, TypeSchema } from '../config/types.js';
import { mergeMetaFields } from './meta-fields.js';

/**
 * The definitions a write to `space` is merged over: the targeted network's layer for this space, or this instance's own definitions.
 * `undefined` when `targetNetwork` names no network that carries the space — a write the planner refuses; a caller that must price it
 * anyway prices it against nothing, so every rule it sends counts as an edit.
 */
export function metaWriteBase(
  space: Pick<SpaceConfig, 'id' | 'meta' | 'ownMeta'>,
  targetNetwork: string | undefined,
  networks: readonly Pick<NetworkConfig, 'id' | 'spaces' | 'schemaLayers'>[],
): Partial<SpaceMeta> | undefined {
  if (targetNetwork === undefined) return space.ownMeta ?? space.meta ?? {};
  const net = networks.find(n => n.id === targetNetwork && n.spaces.includes(space.id));
  return net ? net.schemaLayers?.[space.id] ?? {} : undefined;
}

/**
 * Deep-merge an incoming PATCH `meta` payload into the existing SpaceMeta.
 *
 * - Scalar fields (purpose, usageNotes, validationMode,
 *   strictLinkage) overwrite the existing value when present in `incoming`.
 * - `typeSchemas` is merged per-knowledge-type, then per-type-name:
 *   types present in `incoming` are added or updated; types *not* mentioned
 *   in the request body are left untouched.
 *
 * The `version`, `updatedAt`, and `previousVersions` housekeeping fields are
 * intentionally omitted from the return value — `updateSpace()` re-adds them.
 *
 * Exported for testing as well as for the planner. The merge/replace decision is pure and is where a deletion was
 * silently lost for as long as it was; a unit test that reaches it directly is worth more than one that has to
 * stand up Docker and a network to observe the same branch.
 */
export function mergeSpaceMeta(
  existing: SpaceMeta,
  incoming: Partial<SpaceMeta>,
  typeSchemasMode: 'merge' | 'replace' = 'merge',
): Omit<SpaceMeta, 'version' | 'updatedAt' | 'previousVersions'> {
  // Spread the existing base (drop housekeeping fields that updateSpace re-adds)
  const { version: _v, updatedAt: _u, previousVersions: _pv, ...existingBase } = existing;

  // Every field by its kind (`spaces/meta-fields.ts`), which is where `whenDuePasses` and `stampSkew` used to fall out of a
  // list of six: a scalar replaces when STATED (`!== undefined`, never truthiness — `suppressEmbeddings: false` is how an
  // operator turns suppression back off), an object replaces whole, and the types are merged below.
  //
  // typeSchemas — merge per-KT, per-type: incoming types add/update, existing untouched types preserved.
  // Under `replace` the payload is authoritative instead, so a type absent from it is deleted. Note the
  // guard is on `!== undefined`, so `replace` with `typeSchemas: {}` clears every type — which is the only
  // way to express "this space declares nothing" and has to be reachable.
  return mergeMetaFields(existingBase as Record<string, unknown>, incoming as Record<string, unknown>, (existingTs, incomingTs) => {
    if (typeSchemasMode === 'replace') return incomingTs;
    const had = (existingTs ?? {}) as Partial<Record<KnowledgeType, Record<string, TypeSchema>>>;
    const mergedTs: Partial<Record<KnowledgeType, Record<string, TypeSchema>>> = { ...had };
    for (const [kt, ktMap] of Object.entries(incomingTs as object) as [KnowledgeType, Record<string, TypeSchema> | undefined][]) {
      if (!ktMap) continue;
      mergedTs[kt] = { ...(had[kt] ?? {}), ...ktMap };
    }
    return mergedTs;
  }) as Omit<SpaceMeta, 'version' | 'updatedAt' | 'previousVersions'>;
}
