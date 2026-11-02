/**
 * `@ythril/schema` — the vocabulary of a Ythril space schema and the validator the server runs on it.
 *
 * Start with {@link validateSpaceMeta}: hand it a space meta (and the schema-library entries its `$ref`s name) and it answers what a
 * Ythril instance would answer, without one. The rest is what that call is built from, for an app that needs one piece of it: the
 * types (`TypeSchema`, `SpaceMeta`, ...), the tuples (`KNOWLEDGE_TYPES`, `MERGE_FNS`, ...), the limits, the zod bodies and the parses.
 */
export * from './vocabulary.js';
export * from './limits.js';
export * from './redos.js';
export * from './view-fields.js';
// Named, not `export *` (Q-668): a helper the server needs is not app API by being written in a module this entry re-exports. The
// server-only names (merging, peer and stored reads, the library installer, the `$ref` finders) are in `./internal`.
export {
  META_FIELD_KINDS, metaFieldKind, PER_TYPE_META_FIELD, unknownMetaFields, MAX_UNKNOWN_NAMES, type MetaFieldKind,
} from './meta-fields.js';
export * from './library-ref-name.js';
export {
  withSchemaLibrary, currentSchemaLibrary, libraryDefinitionOf, takeBackLibraryDefinition,
  type SchemaLibraryEntryLike, type SchemaLibrarySource,
} from './library.js';
export {
  MAX_RULE_LENGTH, MAX_MESSAGE_LENGTH, MAX_RULES_PER_TYPE, MAX_RULES_PER_SPACE, MAX_APPLICABLE_RULES, RULE_NAME_PATTERN,
  LONGEST_CHECKED_STRING, TypeRuleZ, SpaceRuleZ, typeRuleIssues, spaceRuleIssues, applicableRuleIssues, ruleMapIssues,
  readingStoredRules, type RuleIssue, type ChangedRuleParts,
} from './rules.js';
export {
  NAME_QUOTED, LOG_VALUE_MAX, REFUSAL_NAMES_MAX, peerText, peerList, refusalOfParse, unrecognizedKeysIssue,
  type ParseRefusal, type ParseRefusalIssue, type ParseRefusalOptions, type ParseIssueLike,
} from './text.js';
export {
  PropertySchemaZ, EndpointMemberZ, TypeSchemaZ, InlineTypeSchemaZ, TypeSchemasZ, SpaceMetaBody, collectionScopeIssues,
  SERVER_OWNED_META_FIELDS, stripServerOwnedMeta, parseSpaceMeta, parseTypeSchema, parseInlineDefinition, LIBRARY_SCHEMA_KEYS,
  libraryDeletePathProblem,
  type ParsedTypeSchema, type ParsedSpaceMeta, type MetaParse, type MetaParseOptions, type WrongKindLibraryRef,
} from './space-meta.js';
export { validateSpaceMeta, libraryRefRefusal, type ValidateSpaceMetaOptions } from './validate.js';
