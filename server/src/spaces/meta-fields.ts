/**
 * What each key of a space's meta IS when two metas are merged — one table, read by every merge (`Q-217`; R5-5, R6-5; D-i3).
 *
 * Defined in `@ythril-network/schema` (`schema/src/meta-fields.ts`, with the table and what it prevents), because the meta body refuses to
 * load when it accepts a key this table has no kind for, and the body is the package's. Re-exported so every merge of the server —
 * `mergeSpaceMeta`, `mergeReplicatedMeta`, `applyMetaRound`, the effective-meta type edits and the layer clash scan — reads the one
 * table.
 */
export {
  META_FIELD_KINDS, metaFieldKind, PER_TYPE_META_FIELD, unknownMetaFields, MAX_UNKNOWN_NAMES, type MetaFieldKind,
} from '@ythril-network/schema';
// The merges and the bounded naming are the server's, not app API: the package keeps them behind `./internal` (Q-668).
export { eachTypeDefinition, mergeTypeDefinition, mergeMetaFields, boundedNames } from '@ythril-network/schema/internal';
