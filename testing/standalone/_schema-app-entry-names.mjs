/**
 * The names `@ythril/schema`'s app entry (`.`) exports: the ONE list, for the gates that hold something else to it.
 *
 * ## The question it answers
 *
 * *"Which values and which types is the package's public surface?"* Two gates ask it: the surface test
 * (`the-schema-packages-app-entry-names-a-fixed-surface.test.js`, which holds the built entry to these lists) and the README gate
 * (`the-schema-readme-names-every-name-of-the-app-entry.test.js`, which holds `schema/README.md`'s export table to them). A copy in
 * the second would drift from the first on the day an export is added, and the README would then be held to a surface that no longer
 * exists.
 *
 * A new public name is a deliberate edit here, in the same change as the export and the README row.
 */

/** The app entry's values. */
export const APP_VALUES = [
  'ALL_VIEW_FIELDS', 'BOOLEAN_MERGE_FNS', 'DATE_PASSED_VALUES', 'EndpointMemberZ', 'InlineTypeSchemaZ', 'KNOWLEDGE_TYPES',
  'LIBRARY_REF_PREFIX', 'LIBRARY_SCHEMA_KEYS', 'LOG_VALUE_MAX', 'LONGEST_CHECKED_STRING', 'MAX_APPLICABLE_RULES', 'MAX_MESSAGE_LENGTH',
  'MAX_PATTERN_LENGTH', 'MAX_RULES_PER_SPACE', 'MAX_RULES_PER_TYPE', 'MAX_RULE_LENGTH', 'MAX_UNKNOWN_NAMES', 'MERGE_FNS',
  'META_FIELD_KINDS', 'NAME_QUOTED', 'NUMERIC_MERGE_FNS', 'PER_TYPE_META_FIELD', 'PROPERTY_DESCRIPTION_MAX', 'PropertySchemaZ',
  'REDOS_REFUSAL', 'REFUSAL_NAMES_MAX', 'RULE_NAME_PATTERN', 'SCHEMA_DESCRIPTION_MAX', 'SERVER_OWNED_META_FIELDS', 'SPACE_PURPOSE_MAX',
  'SpaceMetaBody', 'SpaceRuleZ', 'TypeRuleZ', 'TypeSchemaZ', 'TypeSchemasZ', 'VIEW_FIELDS', 'applicableRuleIssues',
  'collectionScopeIssues', 'currentSchemaLibrary', 'hasReDoSRisk', 'libraryDefinitionOf', 'libraryDeletePathProblem',
  'libraryEntryNameOf', 'libraryRefRefusal', 'metaFieldKind', 'parseInlineDefinition', 'parseSpaceMeta', 'parseTypeSchema', 'peerList',
  'peerText', 'readingStoredRules', 'refusalOfParse', 'ruleMapIssues', 'spaceRuleIssues', 'stripServerOwnedMeta',
  'takeBackLibraryDefinition', 'typeRuleIssues', 'unknownMetaFields', 'unrecognizedKeysIssue', 'validateSpaceMeta', 'withSchemaLibrary',
];

/** The app entry's types (names with no value). */
export const APP_TYPES = [
  'BooleanMergeFn', 'ChangedRuleParts', 'DatePassedPolicy', 'KnowledgeType', 'MergeFn', 'MetaFieldKind', 'MetaParse',
  'MetaParseOptions', 'NumericMergeFn', 'ParseIssueLike', 'ParseRefusal', 'ParseRefusalIssue', 'ParseRefusalOptions', 'ParsedSpaceMeta',
  'ParsedTypeSchema', 'PropertySchema', 'RuleIssue', 'SchemaLibraryEntryLike', 'SchemaLibrarySource', 'SchemaRule', 'SpaceMeta',
  'SpaceSchemaRule', 'TypeSchema', 'ValidateSpaceMetaOptions', 'ValidationMode', 'ViewField', 'ViewKind', 'WrongKindLibraryRef',
];
