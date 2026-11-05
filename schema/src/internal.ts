/**
 * `@ythril-network/schema/internal` — what the Ythril server shares with this package beyond the schema API: the text renderer its logger
 * formats lines with, the bounded cache, the plain-object and object-internals questions, the canonical JSON text, and the rule
 * engine's compile hook its evaluator runs. Each is defined here once and re-exported by the server module that used to define it.
 * And the schema helpers only the server calls (Q-668): the meta merges, the reads of a peer's and a stored meta, the library
 * installer, and the `$ref` finders and their wording behind `libraryRefRefusal` — kept out of the app entry, whose names are a list.
 *
 * Not a stable API for an app: it moves with the server. An app imports `@ythril-network/schema`.
 */
export * from './index.js';
export {
  findBrokenLibraryRefs, findWrongKindLibraryRefs, brokenRefsError, wrongKindRefsError, withoutBrokenLibraryRefs,
  readPeerMeta, readStoredMeta, withTypeSchemas, derivedFromStored,
} from './space-meta.js';
export { mergeMetaFields, mergeTypeDefinition, eachTypeDefinition, boundedNames } from './meta-fields.js';
export { useSchemaLibrary } from './library.js';
export { LruMap, type LruWeight } from './lru-map.js';
export { isPlainObject, ownValue } from './plain-object.js';
export { isObjectInternalKey, isObjectPrototypeName } from './object-internal-keys.js';
export { canonicalJson } from './canonical-json.js';
export { errorHeader, textOf, render, escapeLineBreaks, redact, redactSecrets, logSafe } from './text.js';
export {
  ruleEngine, ENGINE_INPUT_CAPS, compileRule, rulesIn, namesKinds, spaceRuleKinds,
  type CompiledRule, type Refs, type StoredRule,
} from './rules.js';
