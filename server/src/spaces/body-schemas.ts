/**
 * The request-body schemas for the space routes, and the two helpers that read them.
 *
 * ## Why they are here and not in the router
 *
 * They were all in `api/spaces.ts`, which is the file the god-file ratchet has raised four times with the note
 * *"a fourth raise of one file is the signal to split it instead of raising a fifth time"*. Two of those raises
 * were single Zod lines, because both `SpaceMetaBody` and `TypeSchemaZ` are `.strict()` — an unlisted field is
 * REJECTED, not ignored, so there is no "put it beside the feature" for a field the API must accept. The schemas
 * are what keeps pulling that file upward, so the schemas are what moved.
 *
 * The immediate reason is a cycle. `planSpaceMetaUpdate` in `meta-update.ts` needs `UpdateSpaceBody`, and the
 * router imports the planner — so leaving the schema in the router would be `spaces.ts -> meta-update.ts ->
 * spaces.ts`. Moving them here is what makes both surfaces able to reach one copy of the validation, which is the
 * whole point of B-2: the rights matrix decides what a token may do, and the surface must not also decide whether
 * the same rules apply.
 *
 * ## What is deliberate in here
 *
 * **Every body here is `.strict()`, and that took an owner ruling.** For a while four were strict and six were not:
 * `SpaceMetaBody`, `TypeSchemasZ`, `PropertySchemaZ` and `DupeActionRuleBody` refused an unknown key while the six
 * top-level bodies dropped one. The asymmetry was inherited verbatim from the router when these were extracted —
 * deliberately, because an extraction that also alters behaviour is an extraction nobody can verify — and it was a
 * real defect the whole time:
 *
 *     PATCH {"meta":{"validationMdoe":"strict"}}     -> 400, refused one level down
 *     PATCH {"label":"x","validaitonMode":"strict"}  -> 200, label applied and the typo silently gone
 *
 * One misspelling, refused inside `meta` and swallowed outside it. A typo in `faceDescriptorDims` created a space
 * at the default width and reported 201.
 *
 * It waited on a ruling rather than on work because closing it is BREAKING for any integrator currently sending a
 * key we ignore — they get a 400 where they used to get a 200. Owner ruled A on 2026-08-15: refuse. The nested
 * `meta` body has been strict since it was written and nobody has complained, so the asymmetry was the accident and
 * the strictness was always the intent.
 *
 * `space-bodies-are-strict.test.js` derives the list from THIS file rather than from a copy, so a body added later
 * without `.strict()` fails the build instead of quietly rejoining the lenient half.
 */
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { MERGE_FNS } from '../config/types-knowledge.js';
import { getSchemaLibrary } from '../config/loader.js';
import { takeBackLibraryDefinition } from './library-ref-expansion.js';
import { isSsrfSafeUrl, SSRF_SAFE_MESSAGE } from '../util/ssrf.js';
import { SPACE_PURPOSE_MAX, SCHEMA_DESCRIPTION_MAX, PROPERTY_DESCRIPTION_MAX } from './_shared.js';
import { DOC_EXTRACTION_MODES_IN, IMAGE_LEVELS, AUDIO_LEVELS, VIDEO_LEVELS, TEXT_LEVELS } from '../config/types.js';
import { KNOWLEDGE_TYPES } from '../config/types-knowledge.js';
import { hasReDoSRisk, REDOS_REFUSAL } from '../util/redos.js';
import type { KnowledgeType, SpaceMeta, TypeSchema } from '../config/types.js';
import { RECORD_TYPES } from '../config/types.js';
import { DATE_PASSED_VALUES } from '../brain/chrono-date-policy.js';
import { MAX_SPACE_IDS, MAX_CREATE_FOLDERS } from '../util/request-bounds.js';
import { isObjectInternalKey } from '../util/object-internal-keys.js';
import { NAME_QUOTED, peerText } from '../util/log.js';
import { META_FIELD_KINDS, MAX_UNKNOWN_NAMES, PER_TYPE_META_FIELD, boundedNames } from './meta-fields.js';
import {
  TypeRuleZ, SpaceRuleZ, MAX_RULES_PER_TYPE, MAX_RULES_PER_SPACE, ruleMapIssues, typeRuleIssues, spaceRuleIssues, applicableRuleIssues,
  readingStoredRules, type RuleIssue,
} from './schema-rules.js';

// ── Zod schema for PropertySchema ──────────────────────────────────────────
/**
 * One property's constraints, as a space's type schema declares them.
 *
 * `mergeFn` is refined against `type` rather than accepted freely: an `avg` on a string is not a merge strategy,
 * it is a silent no-op at merge time.
 */
/**
 * A regex a schema may store — refused here if the instance would decline to RUN it.
 *
 * `Q-7`. `safeRegexTest` will not evaluate a pattern with a quantified group containing a quantifier, and it
 * signals that by returning `false` — indistinguishable from "the value does not match". Accepted at save
 * time, such a pattern rejects EVERY record of its type for ever, with an error naming the value. So the
 * refusal belongs here, where the author is standing and can fix it.
 *
 * ONE definition, used by `propertySchemas.*.pattern` and by `namingPattern`. Written twice, the second copy
 * is the one that gets forgotten — and a schema is only as safe as the weaker of its two pattern fields.
 */
const SchemaPatternZ = z.string().max(500).refine(p => !hasReDoSRisk(p), { message: REDOS_REFUSAL });

export const PropertySchemaZ = z.object({
  /*
   * `F-24` step one. Free text, never parsed, bounded so a note cannot become a payload: 2000 for a
   * property and 4000 for a type below, matching the space `purpose` it is the smaller sibling of.
   * `.strict()` here means an unlisted key is REJECTED, so without this line a caller sending one
   * would get a 400 for a field the type declares.
   */
  description: z.string().max(PROPERTY_DESCRIPTION_MAX).optional(),
  type: z.enum(['string', 'number', 'boolean', 'date']).optional(),
  enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  pattern: SchemaPatternZ.optional(),
  mergeFn: z.enum(MERGE_FNS).optional(),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
}).strict().refine(data => {
  if (!data.mergeFn) return true;
  const numericFns = new Set(['avg', 'min', 'max', 'sum']);
  const booleanFns = new Set(['and', 'or', 'xor']);
  if (data.type === 'number') return numericFns.has(data.mergeFn);
  if (data.type === 'boolean') return booleanFns.has(data.mergeFn);
  // mergeFn requires a compatible type declaration
  if (data.type === 'string' || data.type === 'date') return false;
  // No type declared but mergeFn given — allow if the fn could be valid for some type
  return numericFns.has(data.mergeFn) || booleanFns.has(data.mergeFn);
}, {
  message: 'mergeFn is incompatible with the declared type (numeric fns require type "number", boolean fns require type "boolean")',
});

/**
 * One member of an `endpoints` list: an entity type name, or the explicit `UNTYPED` bucket.
 *
 * The `entity:` prefix is accepted and means the same as a bare name. It exists so the vocabulary can widen if
 * fact or chrono links ever become edges — and any OTHER knowledge-type prefix is refused with a message that
 * says why, rather than being read as a type name that happens to contain a colon.
 *
 * Refusing rather than stripping matters here: the object is `.strict()`, so a caller who writes
 * `fact:note` today gets told the grammar is reserved instead of silently declaring an entity type called
 * "fact:note" that nothing will ever match.
 */
export const EndpointMemberZ = z.string().min(1).max(200).refine(
  (v) => {
    const colon = v.indexOf(':');
    if (colon < 0) return true;
    return v.slice(0, colon) === 'entity';
  },
  {
    message: 'an endpoints member is an entity type name, optionally written "entity:<type>". Other knowledge-type '
      + 'prefixes (fact:, chrono:, edge:) are reserved for when those records can be edge endpoints, and are '
      + 'refused now so they cannot be read as type names later. Use "UNTYPED" for entities with no type.',
  },
);

/**
 * A map the caller names by key — the types under a knowledge type, the properties under a type, the rules under a space — refused when
 * a key names an object's INTERNALS (`z.preprocess(refuseInternalKeys, z.record(...))`).
 *
 * `out[key] = value` with such a key does not add a key: it replaces the prototype of the object being built, so a type
 * called by one of those names was accepted by the body and then silently NOT STORED, and a library `$ref` comparison and the merges
 * below it all read an object whose shape the caller chose. The body is the one place every door's schema passes, so the refusal is
 * here (`util/object-internal-keys.ts` answers the question).
 *
 * It runs on the INPUT, before the record is read, and that is the point: zod's record parser skips the prototype key without handing it
 * to the key schema, so a refinement on the key would never see the one name that matters most.
 */
const refuseInternalKeys = (value: unknown, ctx: { addIssue(issue: { code: 'custom'; message: string; input?: unknown }): void }): unknown => {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).some(isObjectInternalKey)) {
    ctx.addIssue({
      code: 'custom',
      input: value,
      message: 'a type, a property or a rule cannot be named after an object\'s internals (the prototype, the constructor): it would reach the object instead of holding a definition',
    });
    return z.NEVER;
  }
  return value;
};

/**
 * A `rules` map (F-46) — a type's own (`TypeRuleZ`) or the space's (`SpaceRuleZ`), at most `max` of them — whose SHAPE is judged here:
 * the count, each name and each entry, by `ruleMapIssues` in `spaces/schema-rules.ts`, the module that also holds the limits. Whether
 * each rule is one the instance can APPLY is judged where its kind is known (`TypeSchemasZ` and `SpaceMetaBody` below).
 *
 * The entries are refused as refinement issues rather than by an inner object schema, and that is deliberate: a type body is a union
 * (a `$ref` or an inline definition), and an inner failure inside the inline branch is reported as "no branch matched" with the `$ref`
 * branch's "unrecognized keys" beside it — a refusal of a rule that names every field of the type but the rule. A rule NAMED like an
 * object's internals is refused on the input, as a type or a property is.
 */
function rulesMapOf<R extends z.ZodType>(ruleZ: R, max: number) {
  // Typed as the map it admits: every entry it lets through is one `ruleZ` accepted.
  return z.preprocess(refuseInternalKeys, z.record(z.string(), z.unknown()).superRefine((map, ctx) => {
    for (const issue of ruleMapIssues(map, ruleZ, max)) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  })) as unknown as z.ZodType<Record<string, z.output<R>>>;
}

/*
 * EVERY write of a type schema parses through here — the space meta PATCH and `schema_update`, `PUT .../schema`, the
 * single-type PUT, space creation, the dry-run, a peer's replicated meta, a passed round, the library (`parseSpaceMeta`,
 * `parseTypeSchema` below mint the only value a store accepts) — so the preprocess below is the one place a
 * library type's round trip is handled (`Q-168`). The meta returns a library type as `{ $ref, ...definition }`; the
 * preprocess takes that back to `{ $ref }` when the definition is the entry's, and refuses it, naming the fields,
 * when it was edited. It runs BEFORE the strict union because the strict union is what refused the round trip. See
 * `library-ref-expansion.ts`.
 */
export const TypeSchemaZ = z.preprocess(takeBackLibraryDefinition, z.union([
  // Reference to a schema library entry
  z.object({
    $ref: z.string().regex(/^library:[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/, '$ref must be in format "library:<name>"'),
  }).strict(),
  // Inline schema definition
  z.object({
    description: z.string().max(SCHEMA_DESCRIPTION_MAX).optional(),
    namingPattern: SchemaPatternZ.optional(),
    propertySchemas: z.preprocess(refuseInternalKeys, z.record(z.string().min(1).max(200), PropertySchemaZ)).optional(),
    // The schema tier of record > schema > space. `.strict()` above means an unlisted key is REJECTED, so
    // without this the field would be stripped from every PATCH and the feature would silently not exist.
    retention: z.object({
      days: z.number().int().positive().max(36500).optional(),
      contentDays: z.number().int().positive().max(36500).optional(),
    }).strict().refine(v => v.days !== undefined || v.contentDays !== undefined, {
      message: 'retention needs days, contentDays, or both',
    }).optional(),
    // Same reasoning as `retention` above, and the same tier. Absent means NOT STATED and falls through to the
    // space setting — which is why this is a plain optional boolean and not defaulted to `false` here. A default
    // would turn "said nothing" into "said no" at the edge, and the tier resolver would never see the space.
    suppressEmbeddings: z.boolean().optional(),
    /*
     * `F-26`: what a passed due moment MEANS for this type. The schema tier of schema > space, and the same
     * reason as the two above for it having to be listed at all — `.strict()` rejects an unlisted key, so
     * without this line every PATCH carrying it is a 400 and the field silently does not exist.
     *
     * Chrono only, and refused elsewhere rather than ignored, the way `retention.contentDays` is: a Zod
     * schema for one type object cannot see which collection it was filed under, so that check lives in
     * `schema-validation.ts` where the collection is known.
     *
     * The enum is `DATE_PASSED_VALUES`, not a second copy of the two strings — a vocabulary written twice is
     * the defect this repository produces most.
     */
    whenDuePasses: z.enum(DATE_PASSED_VALUES).optional(),
    /*
     * Edge-collection only, and refused elsewhere rather than ignored — the same treatment
     * `retention.contentDays` gets off chrono. Enforced in `schema-validation.ts`, which is where the
     * collection is known; a Zod schema for one type object cannot see which collection it was filed under.
     *
     * `.strict()` above is why this line has to exist at all: without it every PATCH carrying `endpoints` is a
     * 400 and the field silently does not exist.
     */
    endpoints: z.object({
      from: z.array(EndpointMemberZ).min(1).max(50).optional(),
      to: z.array(EndpointMemberZ).min(1).max(50).optional(),
    }).strict().refine(v => v.from !== undefined || v.to !== undefined, {
      message: 'endpoints needs from, to, or both — an empty object constrains nothing and is more likely a typo',
    }).optional(),
    /*
     * Ships with `endpoints` deliberately: two attributes of one capability, and shipping them apart pays the
     * five-places tax twice on the same object. Reported or refused follows the space `validationMode`, like
     * every other rule here, rather than inventing a second control.
     */
    functional: z.boolean().optional(),
    // F-46: the type's own CEL rules, by name. Part of the type, so replaced with it; what each may be is judged in TypeSchemasZ.
    rules: rulesMapOf(TypeRuleZ, MAX_RULES_PER_TYPE).optional(),
  }).strict(),
]));

/**
 * The inline branch of {@link TypeSchemaZ} — one type's own definition — READ OUT of it, never restated. The schema library's entry body is
 * built from its shape (`api/schema-library.ts`, `Q-215`): it kept a hand-made copy that drifted (no `description`, no `whenDuePasses`, a
 * ReDoS naming pattern accepted, a PATCH that merged two keys of the eight the body took), and a copy "kept in step by a comment" is the
 * defect this repository produces most. The tolerant reader asks it which keys a type may carry.
 */
export const InlineTypeSchemaZ = TypeSchemaZ.def.out.options[1];
if (!InlineTypeSchemaZ?.shape?.namingPattern) {
  throw new Error('TypeSchemaZ no longer has its inline branch second in the union: re-anchor InlineTypeSchemaZ');
}

/**
 * Type-schema fields that only mean something on ONE collection.
 *
 * ## Why this list exists at all
 *
 * `retention.contentDays` is chrono-only, and three places said it was rejected elsewhere — its own docblock,
 * `chrono-retention.ts`, and `docs/integration-guide/04f-write-semantics.md`, which is an integrator's
 * authoritative reference. It was accepted, stored and silently ignored: `CONTENT_TIER_COLLECTIONS` was read in
 * exactly one place, the RESOLVER, which returns `undefined` for a non-chrono collection long after the write
 * was accepted.
 *
 * So an operator could set a content window on an entity type, get a 200, see it in their config, and watch it
 * do nothing for ever.
 *
 * ## One list rather than three guards
 *
 * `endpoints` and `functional` are edge-only for the same reason `contentDays` is chrono-only: each names
 * something the other collections do not have. Written as three separate checks, the third is the one somebody
 * forgets — which is precisely how the first came to be documented and absent for months.
 *
 * The REASON travels with the row so the refusal can say it. An operator who sets `endpoints` on an entity type
 * is making a reasonable guess about where the constraint lives rather than a typo, and "unrecognised key" would
 * leave them no better off.
 */
const COLLECTION_SCOPED_FIELDS: ReadonlyArray<{
  /** Dotted path within one type object. */
  path: string;
  /** The one knowledge type it means anything on. */
  only: KnowledgeType;
  /** Why it is scoped, in the refusal message. */
  why: string;
}> = [
  {
    path: 'endpoints',
    only: 'edge',
    why: 'it declares what may sit at each END of a relationship, and only an edge has ends',
  },
  {
    path: 'functional',
    only: 'edge',
    why: 'it limits how many edges with this label one subject may have, and only an edge has a subject and an '
      + 'object',
  },
  {
    path: 'retention.contentDays',
    only: 'chrono',
    why: 'the fields it drops are a chrono entry\'s — its description, its embedding and its matched text — so on '
      + 'another collection it names nothing. Use retention.days to delete records of any type',
  },
  {
    path: 'whenDuePasses',
    only: 'chrono',
    why: 'it says what a passed DUE MOMENT means, and only a chrono entry has one — nothing else in the brain '
      + 'carries a date the clock is compared against',
  },
];

/** The value at a dotted path, or `undefined`. Only two levels are needed and only two are supported. */
function atPath(obj: unknown, path: string): unknown {
  if (obj === null || typeof obj !== 'object') return undefined;
  const [head, ...rest] = path.split('.');
  const here = (obj as Record<string, unknown>)[head!];
  return rest.length === 0 ? here : atPath(here, rest.join('.'));
}

/**
 * The knowledge-type keys are SINGULAR, and `.strict()` means the plural spelling is a 400 rather than a no-op.
 *
 * The `superRefine` is where a collection-scoped field is refused, and this is the only layer that CAN: a
 * `TypeSchemaZ` validates one type object and cannot know whether it arrived under `entity` or `edge`, while the
 * resolver knows the collection but runs long after the write was accepted.
 */
/**
 * One per-type map per knowledge type, DERIVED from the tuple rather than written out.
 *
 * **This schema is `.strict()`, which makes it the only thing in the product that can REFUSE a key here** —
 * a fifth knowledge type would be rejected by this door while every other site accepted it, and the refusal
 * would name a body that is correct everywhere else. So it is the real authority on which kinds hold a type
 * schema, and it was a hand-written copy of the answer.
 *
 * `one-definition-of-the-knowledge-types.test.js` could not see it: that gate matches the four names as
 * QUOTED literals, and here they were property names.
 *
 * The cast is what `z.object` needs to keep its per-key inference after `fromEntries`, which widens the key
 * type to `string`. The SHAPE is still built from the tuple, so a fifth type joins this door on the commit
 * that declares it.
 */
const perTypeMap = () => z.preprocess(refuseInternalKeys, z.record(z.string().min(1).max(200), TypeSchemaZ)).optional();

/**
 * The collection-scoped fields `schema` carries that do not belong under `collection`, as `{ path, message }` — the one answer for
 * every door that stores a type definition: the strict body below (every typeSchemas write and a peer's meta), the single-type
 * PUT, and the schema library, whose entry names its collection in `knowledgeType` and is refused for the same field the same way.
 */
export function collectionScopeIssues(collection: string, schema: unknown): { path: string[]; message: string }[] {
  const issues: { path: string[]; message: string }[] = [];
  for (const field of COLLECTION_SCOPED_FIELDS) {
    if (field.only === collection) continue;
    if (atPath(schema, field.path) === undefined) continue;
    issues.push({
      path: field.path.split('.'),
      message: `${field.path} may only be set on an ${field.only} type, and this is under ${collection}: ${field.why}.`,
    });
  }
  return issues;
}

export const TypeSchemasZ = z.object(
  Object.fromEntries(KNOWLEDGE_TYPES.map(k => [k, perTypeMap()])) as Record<KnowledgeType, ReturnType<typeof perTypeMap>>,
).strict().superRefine((maps, ctx) => {
  for (const [collection, types] of Object.entries(maps)) {
    if (!types) continue;
    for (const [typeName, schema] of Object.entries(types as Record<string, unknown>)) {
      for (const issue of collectionScopeIssues(collection, schema)) {
        ctx.addIssue({ code: 'custom', path: [collection, typeName, ...issue.path], message: issue.message });
      }
      // F-46: each of the type's rules is one this instance can apply to a record of THIS collection, reading only what the type
      // declares, and the set is within the cost budget. Here and not in the type body, because only here is the collection known.
      for (const issue of typeRuleIssues(collection, schema)) {
        ctx.addIssue({ code: 'custom', path: [collection, typeName, ...issue.path], message: issue.message });
      }
    }
  }
});

/**
 * Return names of any `$ref` library entries referenced in typeSchemas that do not
 * exist in the instance schema library.  Used to reject PATCH/PUT early with 422.
 */
export function findBrokenLibraryRefs(typeSchemas: z.infer<typeof TypeSchemasZ> | undefined): string[] {
  if (!typeSchemas) return [];
  const library = getSchemaLibrary();
  const broken: string[] = [];
  for (const ktMap of Object.values(typeSchemas)) {
    if (!ktMap) continue;
    for (const schema of Object.values(ktMap)) {
      if (typeof schema === 'object' && schema !== null && '$ref' in schema) {
        const ref = (schema as { $ref: string }).$ref;
        const name = ref.startsWith('library:') ? ref.slice('library:'.length) : ref;
        if (!library.some(e => e.name === name) && !broken.includes(name)) {
          broken.push(name);
        }
      }
    }
  }
  return broken;
}

/**
 * `typeSchemas` without the types whose `$ref` names a library entry this instance lacks, and those types as
 * `kind:Type` (`Q-60`). For schema ARRIVING from a network: refusing it whole for one missing entry left a member
 * with no schema at all for a space whose other types were fine, and the space's posture with it.
 */
export function withoutBrokenLibraryRefs(meta: ParsedSpaceMeta): { meta: ParsedSpaceMeta; dropped: string[] } {
  const typeSchemas = meta.typeSchemas as Record<string, Record<string, unknown> | undefined> | undefined;
  if (!typeSchemas) return { meta, dropped: [] };
  const names = new Set(getSchemaLibrary().map(e => e.name));
  const dropped: string[] = [];
  const out: Record<string, Record<string, unknown>> = {};
  for (const [kt, ktMap] of Object.entries(typeSchemas)) {
    if (!ktMap) continue;
    out[kt] = {};
    for (const [type, schema] of Object.entries(ktMap)) {
      const ref = typeof schema === 'object' && schema !== null && '$ref' in schema ? String((schema as { $ref: unknown }).$ref) : null;
      const name = ref?.startsWith('library:') ? ref.slice('library:'.length) : ref;
      if (name !== null && !names.has(name)) { dropped.push(`${kt}:${type}`); continue; }
      out[kt]![type] = schema;
    }
  }
  // A subset of what was parsed is parsed: nothing here is new, so the brand is kept (and this is the file that may keep it).
  return dropped.length === 0 ? { meta, dropped } : { meta: { ...meta, typeSchemas: out } as ParsedSpaceMeta, dropped };
}

/** The 422 body for a broken `$ref`, naming what is missing — "invalid schema" sends the caller to the wrong file. */
export function brokenRefsError(brokenRefs: string[]): string {
  return `Schema library ${brokenRefs.length === 1 ? 'entry' : 'entries'} not found: ${brokenRefs.join(', ')}. `
    + `Create ${brokenRefs.length === 1 ? 'it' : 'them'} via POST /api/schema-library before referencing.`;
}

/** A type that references a library entry filed under another kind: `kind`/`type` is the reference, `entryKind` the entry's. */
export interface WrongKindLibraryRef { entry: string; kind: string; type: string; entryKind: string }

/**
 * The `$ref`s in `typeSchemas` whose library entry is filed under a different knowledge type than the type that references it.
 *
 * An entity type that references an EDGE entry takes `endpoints` and `functional` from it, which only mean something on an edge:
 * every door accepted the reference and the fields never applied (`Q-215`). Checked against THIS instance's library, at the save of
 * the reference — never inside the shared parse, because a peer's library is its own, and an entry that names nothing here is the
 * broken-reference refusal's business ({@link findBrokenLibraryRefs}), not this one's.
 */
export function findWrongKindLibraryRefs(typeSchemas: z.infer<typeof TypeSchemasZ> | undefined): WrongKindLibraryRef[] {
  if (!typeSchemas) return [];
  const library = getSchemaLibrary();
  const wrong: WrongKindLibraryRef[] = [];
  for (const [kind, types] of Object.entries(typeSchemas)) {
    if (!types) continue;
    for (const [type, schema] of Object.entries(types)) {
      const ref = typeof schema === 'object' && schema !== null && '$ref' in schema ? String((schema as { $ref: unknown }).$ref) : null;
      if (ref === null) continue;
      const entry = library.find(e => e.name === (ref.startsWith('library:') ? ref.slice('library:'.length) : ref));
      if (entry && entry.knowledgeType !== kind) wrong.push({ entry: entry.name, kind, type, entryKind: entry.knowledgeType });
    }
  }
  return wrong;
}

/** The 422 body for a `$ref` of the wrong kind, naming the entry, the type and what each is. */
export function wrongKindRefsError(wrong: WrongKindLibraryRef[]): string {
  return wrong.map(w => `Schema library entry '${w.entry}' is filed under ${w.entryKind}, so it cannot define the ${w.kind} type '${w.type}': `
    + `its fields only mean something on ${w.entryKind === 'edge' ? 'an edge' : `a ${w.entryKind}`}.`).join(' ')
    + ' Reference an entry of the right kind, or define the type inline.';
}

export const SpaceMetaBody = z.object({
  purpose: z.string().max(SPACE_PURPOSE_MAX).optional(),
  usageNotes: z.string().max(50_000).optional(),
  validationMode: z.enum(['off', 'warn', 'strict']).optional(),
  typeSchemas: TypeSchemasZ.optional(),
  strictLinkage: z.boolean().optional(),
  // The lowest of the three suppression tiers. `.strict()` above is why this has to be listed at all: without
  // it the field would be REJECTED as unknown, not silently ignored — which is the right failure, but still a
  // failure for a field the type now declares.
  suppressEmbeddings: z.boolean().optional(),
  // `F-26`: the space tier. Absent is today's behaviour, so an instance that sets nothing sees no change.
  whenDuePasses: z.enum(DATE_PASSED_VALUES).optional(),
  /*
   * `Q-217`: read by `brain/stamp-skew.ts`, declared on `SpaceMeta`, documented as writable in `04f-write-semantics.md` — and
   * refused by this body, so no door could set it and a peer layer carrying it was refused whole. An object replaced whole by a
   * merge (`spaces/meta-fields.ts`). `warnMinutes: 0` DISABLES the check; the stamp properties are names, first parseable wins.
   */
  stampSkew: z.object({
    warnMinutes: z.number().min(0).max(525_600).optional(),
    properties: z.array(z.string().min(1).max(200)).max(20).optional(),
  }).strict().optional(),
  // F-46: the CEL rules every record of the space is held to, beside each type's own. Replaced whole by every merge.
  rules: rulesMapOf(SpaceRuleZ, MAX_RULES_PER_SPACE).optional(),
}).strict().superRefine((meta, ctx) => {
  // F-46: each space rule is one this instance can apply to every kind it names, and what APPLIES to one record (a type's own rules
  // and the space's for its kind) is at most MAX_APPLICABLE_RULES and within the cost budget — refused here, never truncated at write.
  for (const issue of [...spaceRuleIssues(meta.rules), ...applicableRuleIssues(meta)]) {
    ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  }
});

// A key this body accepts that the merge table has no kind for would be carried by no merge: a write answered success and
// the value not stored (`Q-217`). Refuse to load, so the omission is made at the commit that adds the key and never after it.
for (const key of Object.keys(SpaceMetaBody.shape)) {
  if (!Object.hasOwn(META_FIELD_KINDS, key)) {
    throw new Error(`SpaceMetaBody accepts '${key}' and spaces/meta-fields.ts gives it no merge kind: say how a merge treats it`);
  }
}

/**
 * The fields the server OWNS: it writes them, `GET` returns them, and a caller may not set them.
 *
 * They are stripped from an incoming `meta` rather than rejected by `.strict()`. Reported by an integrator
 * doing the obvious thing — `GET` a space, edit one field of `meta.typeSchemas`, `PATCH` it back — and getting
 * `unrecognized_keys` for three fields they never wrote and cannot omit without knowing to. Their ask was
 * *"either merge, or do not return what you will not accept"*, and this is the second half; the merge half
 * already shipped as `mergeSpaceMeta`.
 *
 * **Only these, and `.strict()` still rejects everything else.** That distinction is the whole design:
 * a key the server itself emitted is echo-back noise and dropping it costs the caller nothing, while an
 * unknown key is a typo — and silently ignoring `validationMdoe` would let someone believe they had turned
 * validation on. Stripping everything would trade a real diagnostic for a convenience.
 *
 * The dry-run endpoint has stripped exactly these since it was written, so before this the two endpoints
 * disagreed about whether a round-tripped body was acceptable. One of them had to be wrong; the one that
 * accepted it was right.
 *
 * ## `needsReindex` joined the list, and the round-trip test is why
 *
 * It is derived state on the meta response — whether the space holds embeddings from a different model — added
 * so an MCP caller can poll after `reindex`. The moment `GET` returned it, a caller doing the obvious thing
 * (`GET`, edit one field, `PATCH` it back) got `unrecognized_keys` for a field they never wrote, which is
 * exactly the report this strip exists to answer. CI caught it: `type-schema-crud.test.js` round-trips a real
 * response rather than a hand-built body, so it fails the moment the response grows a field the PATCH refuses.
 *
 * The rule for anything added to this response in future: **derived, server-written, and echoed back means it
 * belongs here** — otherwise "do not return what you will not accept" is broken again.
 */
/*
 * `actualSchema` joined these at 5.0, when `er_model` folded into the space meta. It is DERIVED — counted
 * from the records the space actually holds — so a caller who GETs the meta, edits one field and PATCHes
 * the whole object back would otherwise be refused for sending something nobody can write. That is the
 * rule this list exists for: do not return what you will not accept.
 *
 * `reindexRun` joined in Q-99 part 2 — a running reindex's progress beside `needsReindex` — for the same reason, and
 * the same round-trip test caught it the same way.
 */
/*
 * `invalidRules` joined with F-46: the stored rules that no longer compile, named on the meta answer — derived, and echoed back by a
 * caller who round-trips the meta.
 */
export const SERVER_OWNED_META_FIELDS = ['version', 'updatedAt', 'previousVersions', 'needsReindex', 'reindexRun', 'actualSchema', 'invalidRules'] as const;

/** Drop the server-owned housekeeping fields from an incoming `meta`, leaving everything else to Zod. */
export function stripServerOwnedMeta(meta: unknown): unknown {
  if (meta == null || typeof meta !== 'object' || Array.isArray(meta)) return meta;
  const copy: Record<string, unknown> = { ...(meta as Record<string, unknown>) };
  for (const f of SERVER_OWNED_META_FIELDS) delete copy[f];
  return copy;
}

// ── The one parse, and the only value a store accepts (`Q-216`) ─────────────────────────────────────────────────────

declare const PARSED: unique symbol;

/**
 * A type definition the body parsed, or one that is IDENTICAL to what a store already holds. A brand and nothing at runtime: it
 * is the type of what {@link parseTypeSchema} (and the library's, through {@link parseInlineDefinition}) return, so a function that is
 * handed one has been handed a thing the one body accepted. A plain `TypeSchema` is not one, and neither is an object literal
 * with the same fields: it can be made in this module and nowhere else (`every-schema-storing-path-parses-through-the-one-body-schema`).
 */
export type ParsedTypeSchema = TypeSchema & { readonly [PARSED]: 'type-schema' };

/**
 * A space meta the body parsed — every part either parsed by the call that made it or identical to what the store it is for already
 * held. The only meta `storeNetworkLayer`, `commitOwnMetaEdit`, `updateSpace`'s meta write and space creation take, so a path that
 * stores a meta without parsing it is a type error and not a review finding: a passed network round used to reach the stores
 * with no parse at all, and `effectiveMeta` then dropped the layer that no longer parsed, silently (`Q-216`).
 */
export type ParsedSpaceMeta = SpaceMeta & { readonly [PARSED]: 'space-meta' };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** An OWN property, even for a name that would reach the prototype by assignment (a hostile type name must reach the parse intact). */
function setOwn(into: Obj, key: string, value: unknown): void {
  Object.defineProperty(into, key, { value, enumerable: true, writable: true, configurable: true });
}

/** The unknown names a tolerant reader met, collected up to the bound and counted beyond it (`boundedNames` says them). */
class UnknownNames {
  private readonly kept: string[] = [];
  private extra = 0;
  add(name: string): void { if (this.kept.length < MAX_UNKNOWN_NAMES) this.kept.push(name); else this.extra++; }
  list(): string[] { return boundedNames(this.kept, this.kept.length + this.extra); }
}

/** The keys a zod object accepts. Read from the schema, so a field added to it is known to the reader on the same commit. */
const keysOf = (schema: { shape: Record<string, unknown> }): Set<string> => new Set(Object.keys(schema.shape));

/** `value` without the keys `known` lacks, each one named under `path`. A value that is not an object is left for the body to refuse. */
function withoutUnknownKeys(value: unknown, known: Set<string>, path: string, names: UnknownNames): unknown {
  if (!isObj(value)) return value;
  const out: Obj = {};
  for (const [k, v] of Object.entries(value)) {
    if (known.has(k)) setOwn(out, k, v); else names.add(`${path}.${k}`);
  }
  return out;
}

/** One type definition read for what this release knows. A `$ref` is one unit the body judges, and is left alone. */
function readKnownType(def: unknown, path: string, names: UnknownNames): unknown {
  if (!isObj(def) || typeof def['$ref'] === 'string') return def;
  const out = withoutUnknownKeys(def, keysOf(InlineTypeSchemaZ), path, names) as Obj;
  const props = out['propertySchemas'];
  if (isObj(props)) {
    const known = keysOf(PropertySchemaZ);
    const next: Obj = {};
    for (const [name, ps] of Object.entries(props)) setOwn(next, name, withoutUnknownKeys(ps, known, `${path}.propertySchemas.${name}`, names));
    out['propertySchemas'] = next;
  }
  if (isObj(out['retention'])) out['retention'] = withoutUnknownKeys(out['retention'], keysOf(InlineTypeSchemaZ.shape.retention.unwrap()), `${path}.retention`, names);
  if (isObj(out['endpoints'])) out['endpoints'] = withoutUnknownKeys(out['endpoints'], keysOf(InlineTypeSchemaZ.shape.endpoints.unwrap()), `${path}.endpoints`, names);
  return out;
}

/**
 * `raw` with every meta key, knowledge-type key and type field this release has never heard of left out, and each one named.
 * The tolerant reader's whole mechanism: what it keeps is then parsed by the strict body, so a field that is KNOWN and WRONG still
 * refuses the meta. A type or property NAMED like an object's internals is not unknown, it is invalid, and reaches the body whole.
 */
function readKnownMeta(raw: Obj, names: UnknownNames): Obj {
  const metaKeys = keysOf(SpaceMetaBody);
  const out: Obj = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!metaKeys.has(k)) { names.add(k); continue; }
    if (k !== PER_TYPE_META_FIELD || !isObj(v)) { setOwn(out, k, v); continue; }
    const kinds = new Set<string>(KNOWLEDGE_TYPES);
    const types: Obj = {};
    for (const [kind, defs] of Object.entries(v)) {
      if (!kinds.has(kind)) { names.add(`${k}.${kind}`); continue; }
      if (!isObj(defs)) { setOwn(types, kind, defs); continue; }
      const defsOut: Obj = {};
      for (const [name, def] of Object.entries(defs)) setOwn(defsOut, name, readKnownType(def, `${k}.${kind}.${name}`, names));
      setOwn(types, kind, defsOut);
    }
    setOwn(out, k, types);
  }
  return out;
}

/** The part of a refusal a person reads: for a union (a type is a `$ref` or an inline definition) the branch that is about the field. */
function reasonOf(issue: z.core.$ZodIssue): string {
  const branches = (issue as { errors?: z.core.$ZodIssue[][] }).errors;
  if (issue.code === 'invalid_union' && Array.isArray(branches) && branches.length > 0) {
    const real = branches.find(b => b.length > 0 && b.every(i => i.code !== 'unrecognized_keys' && i.path[0] !== '$ref')) ?? branches[branches.length - 1]!;
    const first = real[0];
    return first ? `${first.path.length ? `${first.path.join('.')}: ` : ''}${reasonOf(first)}` : issue.message;
  }
  return issue.message;
}

/** `kind:Type — reason` for a failing type, `field — reason` for a failing top-level field: where a refusal says WHAT was refused. */
function failedParts(issues: readonly z.core.$ZodIssue[]): string[] {
  const out: string[] = [];
  for (const issue of issues) {
    const [head, kind, type] = issue.path;
    const part = head === PER_TYPE_META_FIELD && kind !== undefined && type !== undefined ? `${String(kind)}:${String(type)}` : String(head ?? 'meta');
    const line = peerText(`${part} — ${reasonOf(issue)}`, { max: NAME_QUOTED });
    if (!out.includes(line)) out.push(line);
    if (out.length >= 20) break;
  }
  return out;
}

/** Rule refusals found outside a zod parse, as the error a parse would have given: one shape for every refusal of a meta. */
function ruleIssuesError(issues: readonly RuleIssue[]): z.ZodError {
  return new z.ZodError(issues.map(i => ({ code: 'custom' as const, path: i.path, message: i.message, input: undefined })));
}

/** What {@link parseSpaceMeta} answers. */
export type MetaParse =
  | { ok: true; meta: ParsedSpaceMeta; unknown: string[] }
  | { ok: false; message: string; failed: string[] };

/** How {@link parseSpaceMeta} reads. */
export interface MetaParseOptions {
  /**
   * The meta this one is read against — what the store it is for already holds. A part EQUAL to it is carried as it is and only what
   * DIFFERS is parsed: a write is answerable for what it changes, and a stored type a stricter body would refuse today (one saved
   * before a rule existed) must not wedge every later write that merely repeats it.
   */
  against?: SpaceMeta;
  /**
   * Keep what this release knows and name the rest, instead of refusing the meta for a key it has never heard of (R6-7). For what a
   * peer or a vote sends; never for a caller's own write, where an unknown key is a typo. A key that is KNOWN and wrong still refuses.
   */
  tolerant?: boolean;
}

/**
 * Parse a meta through `SpaceMetaBody` and mint the only value a store takes (`Q-216`).
 *
 * The one entry: a PATCH's merged result, a network layer arriving, the result of a passed round and space creation all end
 * here. Without `against` the whole meta is parsed. With it every part equal to `against` is carried and the rest is parsed — the
 * result is `ParsedSpaceMeta` because each part is one or the other.
 */
export function parseSpaceMeta(input: unknown, options: MetaParseOptions = {}): MetaParse {
  const stripped = stripServerOwnedMeta(input);
  if (!isObj(stripped)) return { ok: false, message: 'a meta must be an object', failed: ['meta'] };
  const names = new UnknownNames();
  const candidate = options.tolerant ? readKnownMeta(stripped, names) : stripped;

  // What to parse: everything, or what differs from what the store holds (a changed field, and inside the types a changed type).
  const stored: Obj = options.against ? (stripServerOwnedMeta(options.against) as Obj) : {};
  let toParse: Obj = candidate;
  if (options.against) {
    toParse = {};
    for (const [k, v] of Object.entries(candidate)) {
      if (k !== PER_TYPE_META_FIELD || !isObj(v)) {
        if (!isDeepStrictEqual(v, stored[k])) setOwn(toParse, k, v);
        continue;
      }
      const storedTypes = isObj(stored[k]) ? stored[k] as Obj : {};
      const changed: Obj = {};
      for (const [kind, defs] of Object.entries(v)) {
        if (!isObj(defs)) { setOwn(changed, kind, defs); continue; }
        const storedDefs = isObj(storedTypes[kind]) ? storedTypes[kind] as Obj : {};
        const changedDefs: Obj = {};
        for (const [name, def] of Object.entries(defs)) if (!isDeepStrictEqual(def, storedDefs[name])) setOwn(changedDefs, name, def);
        if (Object.keys(changedDefs).length > 0) setOwn(changed, kind, changedDefs);
      }
      if (Object.keys(changed).length > 0) setOwn(toParse, k, changed);
    }
  }

  const result = SpaceMetaBody.safeParse(toParse);
  if (!result.success) return { ok: false, message: result.error.message, failed: failedParts(result.error.issues) };
  const parsed = result.data as Obj;
  if (!options.against) return { ok: true, meta: parsed as unknown as ParsedSpaceMeta, unknown: names.list() };

  // F-46: what APPLIES to one record is judged on the meta as it will be stored — the part parsed above cannot see a stored type's rules
  // beside new space rules — and only for what this write changed, so an unrelated edit never re-judges a stored type.
  const changedTypes = new Set<string>();
  for (const [kind, defs] of Object.entries(isObj(toParse[PER_TYPE_META_FIELD]) ? toParse[PER_TYPE_META_FIELD] as Obj : {})) {
    for (const name of Object.keys(isObj(defs) ? defs : {})) changedTypes.add(`${kind}:${name}`);
  }
  const applicable = applicableRuleIssues(candidate, { spaceRules: Object.hasOwn(toParse, 'rules'), types: changedTypes });
  if (applicable.length > 0) {
    const error = ruleIssuesError(applicable);
    return { ok: false, message: error.message, failed: failedParts(error.issues) };
  }

  // Put the parts back in the order they arrived: a parsed part where one was parsed, the carried one where it was not.
  const out: Obj = {};
  for (const [k, v] of Object.entries(candidate)) {
    if (k !== PER_TYPE_META_FIELD || !isObj(v)) { setOwn(out, k, Object.hasOwn(parsed, k) ? parsed[k] : v); continue; }
    const parsedTypes = isObj(parsed[k]) ? parsed[k] as Obj : {};
    const types: Obj = {};
    for (const [kind, defs] of Object.entries(v)) {
      if (!isObj(defs)) { setOwn(types, kind, defs); continue; }
      const parsedDefs = isObj(parsedTypes[kind]) ? parsedTypes[kind] as Obj : {};
      const defsOut: Obj = {};
      for (const [name, def] of Object.entries(defs)) setOwn(defsOut, name, Object.hasOwn(parsedDefs, name) ? parsedDefs[name] : def);
      setOwn(types, kind, defsOut);
    }
    setOwn(out, k, types);
  }
  return { ok: true, meta: out as unknown as ParsedSpaceMeta, unknown: names.list() };
}

/** What a peer sent as a space's meta, read tolerantly (R6-7): the parsed meta of what this release knows, and the names of what it does not. */
export function readPeerMeta(incoming: unknown): MetaParse {
  return parseSpaceMeta(incoming, { tolerant: true });
}

/**
 * What a layer (or an own meta) a store ALREADY HOLDS says, for laying it under or over another: every part of it that is valid today,
 * and the names of the parts that are not (`Q-216`).
 *
 * A stored meta was parsed when it was stored, so this is not a gate, and it must not behave like one. `effectiveMeta` used to
 * parse each stored layer WHOLE and drop the layer when it failed — silently, so a member held a layer it did not run, and one type
 * saved before a rule existed (a pattern a stricter body refuses today) took every good type of its layer with it. A part that no
 * longer parses is left out of what is read and named in `skipped`; everything else is read. The whole parse goes first, so the case that
 * matters (nothing is wrong) costs one parse and not one per type.
 */
export function readStoredMeta(stored: unknown): { meta: Obj; skipped: string[] } {
  // A stored rule that no longer compiles is the rule engine's to skip and report (`invalidRulesOf`), never a reason to leave out the
  // type that carries it: the save-time rule checks are off while what a store holds is read.
  return readingStoredRules(() => readStoredMetaParts(stored));
}

function readStoredMetaParts(stored: unknown): { meta: Obj; skipped: string[] } {
  const stripped = stripServerOwnedMeta(stored);
  if (!isObj(stripped)) return { meta: {}, skipped: [] };
  const known = readKnownMeta(stripped, new UnknownNames());
  const whole = SpaceMetaBody.safeParse(known);
  if (whole.success) return { meta: whole.data as Obj, skipped: [] };

  const skipped = new UnknownNames();
  const out: Obj = {};
  const accept = (candidate: Obj): Obj | undefined => {
    const part = SpaceMetaBody.safeParse(candidate);
    return part.success ? part.data as Obj : undefined;
  };
  for (const [key, value] of Object.entries(known)) {
    if (key !== PER_TYPE_META_FIELD || !isObj(value)) {
      const part = accept({ [key]: value });
      if (part && Object.hasOwn(part, key)) setOwn(out, key, part[key]); else skipped.add(key);
      continue;
    }
    const kinds: Obj = {};
    for (const [kind, defs] of Object.entries(value)) {
      if (!isObj(defs)) { skipped.add(`${key}.${kind}`); continue; }
      const kept: Obj = {};
      for (const [name, def] of Object.entries(defs)) {
        const part = accept({ [key]: { [kind]: { [name]: def } } });
        const types = isObj(part?.[key]) ? (part![key] as Obj)[kind] : undefined;
        if (isObj(types) && Object.hasOwn(types, name)) setOwn(kept, name, types[name]); else skipped.add(`${kind}:${name}`);
      }
      if (Object.keys(kept).length > 0 || Object.keys(defs).length === 0) setOwn(kinds, kind, kept);
    }
    setOwn(out, key, kinds);
  }
  return { meta: out, skipped: skipped.list() };
}

/**
 * One type definition for `kind`, parsed with the collection it is filed under — the one answer for the single-type PUT, which parsed
 * `TypeSchemaZ` ALONE and so could not see that `endpoints` on an entity type is refused. `typeName` is the caller's, so a name that
 * names an object's internals is refused here as it is everywhere else.
 */
export function parseTypeSchema(kind: KnowledgeType, typeName: string, input: unknown):
  { ok: true; schema: ParsedTypeSchema } | { ok: false; message: string } {
  const result = TypeSchemasZ.safeParse({ [kind]: { [typeName]: input } });
  if (!result.success) return { ok: false, message: result.error.message };
  const schema = (result.data[kind] as Obj | undefined)?.[typeName];
  if (!isObj(schema)) return { ok: false, message: `type '${peerText(typeName, { max: NAME_QUOTED })}' did not parse to a definition` };
  return { ok: true, schema: schema as unknown as ParsedTypeSchema };
}

/**
 * One inline type definition — `body`, the inline branch or the schema library's entry body, which is built from it — parsed, and
 * checked against the collection it is filed under: the same collection-scope refusal the inline doors make. The library entry names
 * its collection in `knowledgeType`; without the second half `endpoints` on an entity entry was stored, and every space that
 * referenced the entry ran a constraint that could never apply (`Q-215`). The library passes its own body, so the two doors differ in
 * exactly the one field the library refuses (`retention`) and nowhere else.
 */
export function parseInlineDefinition(body: z.ZodType, kind: KnowledgeType, schema: unknown):
  { ok: true; schema: ParsedTypeSchema } | { ok: false; message: string } {
  const result = body.safeParse(schema);
  if (!result.success) return { ok: false, message: result.error.message };
  const scope = collectionScopeIssues(kind, result.data);
  if (scope.length > 0) return { ok: false, message: scope.map(i => i.message).join(' ') };
  // F-46: the entry's rules are judged for the collection it is filed under, as an inline type's are.
  const rules = typeRuleIssues(kind, result.data);
  if (rules.length > 0) return { ok: false, message: ruleIssuesError(rules).message };
  return { ok: true, schema: result.data as ParsedTypeSchema };
}

/**
 * The keys of a library entry's schema — an inline definition's fields, less `retention`, which an entry refuses. Derived from the
 * body, so `deleteFields` recognises every key the entry can hold and a field added to the body is recognised on the same commit.
 */
export const LIBRARY_SCHEMA_KEYS: readonly string[] = Object.freeze(Object.keys(InlineTypeSchemaZ.shape).filter(k => k !== 'retention'));

/**
 * Why a `deleteFields` path names nothing a library entry's schema has, or `undefined` when it names something it can hold (even
 * if it is not set now). The first segment must be a schema key; inside `endpoints` the second must be `from` or `to`. A typo is
 * refused naming it rather than ignored: ignored, the caller believes a constraint was removed while it still validates records.
 */
export function libraryDeletePathProblem(path: string): string | undefined {
  const [head, second, ...rest] = path.split('.');
  if (head === undefined || !LIBRARY_SCHEMA_KEYS.includes(head)) return `'${peerText(path, { max: NAME_QUOTED })}' starts with no key a library schema has`;
  if (head === 'endpoints' && second !== undefined && (!keysOf(InlineTypeSchemaZ.shape.endpoints.unwrap()).has(second) || rest.length > 0)) {
    return `'${peerText(path, { max: NAME_QUOTED })}' names nothing inside endpoints (from, to)`;
  }
  if (head !== 'endpoints' && head !== 'propertySchemas' && head !== 'rules' && second !== undefined) {
    return `'${peerText(path, { max: NAME_QUOTED })}' goes inside ${head}, which holds a single value`;
  }
  return undefined;
}

/**
 * `base` with its type schemas set to `typeSchemas` — for an edit of a space's own definitions, which commits whatever its callback
 * returns and so cannot refuse. The map is parsed against `base` (nothing the map repeats is parsed again, everything it changes is),
 * and a map that does not parse THROWS: the callers hand a map `TypeSchemasZ` parsed or one they built only of `$ref`s, so reaching
 * the throw is a defect to be found, never a refusal to hand a caller.
 */
export function withTypeSchemas(base: SpaceMeta, typeSchemas: unknown): ParsedSpaceMeta {
  const parsed = parseSpaceMeta({ ...base, [PER_TYPE_META_FIELD]: typeSchemas }, { against: base });
  if (!parsed.ok) throw new Error(`a type schema map that was already parsed did not parse: ${parsed.failed.join('; ')}`);
  return parsed.meta;
}

/**
 * A meta that is DERIVED from metas a store already holds, each of which was parsed when it was stored — the effective meta
 * (own definitions laid under each network layer) is the only one. It is the named trusted source, so the cast lives here and
 * nowhere else; anything that arrives from outside goes through {@link parseSpaceMeta}.
 */
export function derivedFromStored(meta: SpaceMeta): ParsedSpaceMeta {
  return meta as ParsedSpaceMeta;
}

/**
 * The same idea one level up: fields a `GET /api/spaces/:id` EMITS that a `PATCH` does not accept.
 *
 * ## Why `.strict()` needed this to land with it
 *
 * A caller who GETs a space, edits one field and PATCHes the whole object back is doing the obvious thing —
 * it is how the `meta` strip came to exist, reported by an integrator who got `unrecognized_keys` for three
 * fields they had never written and could not omit without knowing to. That strip covered `meta` only,
 * because the top-level body was lenient and dropped everything anyway.
 *
 * Making the top level strict without this would have turned that round-trip into a 400 — a regression
 * dressed as a fix, and the identical mistake the token mint route already made once: `.strict()` alone
 * turned a round-tripped body into a 400 there, and the fix was a strip plus strictness, never either alone.
 *
 * ## The two halves are the point
 *
 * The strip keeps the round-trip working. The strictness is what refuses `validaitonMode`. Only the fields
 * WE emit are dropped, so a typo is still a typo — `faceDescriptorDim` is not on this list and never will be,
 * because it is not something a GET response contains.
 *
 * `id` is here because it identifies the space in the path, not in the body; renaming goes through
 * `POST /:id/rename`, so an `id` in a PATCH body is a round-tripped value rather than a request. `folders`
 * and `proxyFor` are create-only — `CreateSpaceBody` accepts them and `UpdateSpaceBody` deliberately does
 * not, since a populated proxy cannot be re-pointed by an edit.
 */
export const SERVER_OWNED_SPACE_FIELDS = ['builtIn', 'usageGiB', 'indexStatus', 'networks'] as const;

/**
 * Fields a CREATE accepts and an UPDATE does not, so they are round-trip noise only on the update path.
 *
 * Split from the list above rather than merged into it, and the red-team suite is what forced the split:
 * `mass-assignment.test.js` posts `{id, label, builtIn: true}` to `POST /api/spaces` and requires a **201**
 * with `builtIn` not injectable. Stripping `id` on create would have thrown away a field the create body
 * legitimately accepts — the caller's chosen space id, silently replaced by a generated one.
 *
 * `faceDescriptorDims` is deliberately in NEITHER list, and it is no longer create-only. It is accepted on
 * PATCH and refused by STATE rather than by surface: `refuseFaceWidthChange` answers 409 when the gallery
 * holds descriptors or its index is already built at another width, and permits it otherwise. Keeping it out
 * of both lists is what makes that refusal reachable — a field on the strip list is dropped before any
 * handler sees it, so the caller would get a 200 for a change that did not happen.
 */
export const CREATE_ONLY_SPACE_FIELDS = ['id', 'folders', 'proxyFor'] as const;

/**
 * Drop the server-owned top-level fields from an incoming space body, leaving everything else to Zod.
 *
 * `forUpdate` also drops the create-only fields. What counts as server-owned depends on the OPERATION, and
 * one list for both would have to be either too generous on create (swallowing a chosen `id`) or too strict
 * on update (400ing a round-tripped `folders`).
 */
export function stripServerOwnedSpace(body: unknown, opts: { forUpdate?: boolean } = {}): unknown {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return body;
  const copy: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const f of SERVER_OWNED_SPACE_FIELDS) delete copy[f];
  if (opts.forUpdate) for (const f of CREATE_ONLY_SPACE_FIELDS) delete copy[f];
  return copy;
}

// proxyFor accepts either the wildcard sentinel ['*'] or a list of specific space IDs
export const ProxyForZ = z.union([
  // `['*']` exactly — an array of one literal rather than a tuple, so its bound is a count a validator can read.
  z.array(z.literal('*')).length(1),
  z.array(z.string().min(1).max(40)).min(1).max(MAX_SPACE_IDS),
]);

export const CreateSpaceBody = z.object({
  id: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/).optional(),
  label: z.string().min(1).max(200),
  folders: z.array(z.string()).max(MAX_CREATE_FOLDERS).optional(),
  maxGiB: z.number().positive().optional(),
  // Bounds rather than an enum — 128 (MobileFaceNet class) and 512 (ArcFace, AdaFace, FaceNet, EdgeFace) are
  // today's answers, and pinning an enum would make the next model a code change.
  //
  // Also on the UPDATE body now, refused by STATE rather than by surface. The old comment here said the field
  // was absent from PATCH because "a populated gallery cannot be re-dimensioned, so offering the field on
  // PATCH would be offering a change the index build then refuses" — true of a POPULATED gallery and false of
  // an empty one, which is the case an operator asked about on 2026-08-20 and neither the schema nor the guide
  // covered. See `spaces/face-width-change.ts`.
  faceDescriptorDims: z.number().int().min(64).max(4096).optional(),
  proxyFor: ProxyForZ.optional(),
  meta: SpaceMetaBody.optional(),
}).strict();

export const DeleteSpaceBody = z.object({
  confirm: z.literal(true),
}).strict();

export const RenameSpaceBody = z.object({
  newId: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/),
}).strict();

export const DupeActionRuleBody = z.object({
  minScore: z.number().min(0).max(1),
  action: z.enum(['flag', 'automerge', 'notify']),
  types: z.array(z.enum(RECORD_TYPES)).max(RECORD_TYPES.length).optional(),
  webhookUrl: z.string().url().refine(isSsrfSafeUrl, { message: SSRF_SAFE_MESSAGE }).optional(),
}).strict();

/** One bucket's window: a positive day count, or 0/null to clear it. Same bounds as the legacy scalar. */
const TtlWindowZ = z.number().int().nonnegative().max(36500).nullable().optional();

/**
 * The fields that count as "you asked for something" — an update naming none of them is an empty request.
 *
 * **One list, read twice.** The guard and the sentence it fails with used to be two hand-written copies of
 * twelve names, and a field added to the schema but forgotten in one of them is the worse half of this
 * codebase's commonest defect: the body parses, the guard refuses it, and the message lists everything the
 * caller could have sent EXCEPT the field they did send.
 *
 * `typeSchemasMode` is deliberately absent — it qualifies `meta`, so a body carrying only that has still
 * asked for nothing.
 */
const UPDATABLE = [
  'label', 'maxGiB', 'meta', 'dupeRules', 'dupeMergeSurvivor', 'dupeRulesOnInsert', 'recordTtlDays',
  'documentExtraction', 'imageAnalysis', 'audioAnalysis', 'videoAnalysis', 'textAnalysis', 'completeLinkage',
] as const;

export const UpdateSpaceBody = z.object({
  label: z.string().min(1).max(200).optional(),
  maxGiB: z.number().positive().nullable().optional(),
  /**
   * The face gallery's descriptor width. Same bounds as on create, because it is the same number.
   *
   * Accepted here and refused by `refuseFaceWidthChange` when the space's STATE forbids it — descriptors
   * stored, or an index already built at another width. Not `nullable`: there is no "unset it" operation,
   * because absence resolves to 128 and writing 128 says the same thing more clearly.
   */
  faceDescriptorDims: z.number().int().min(64).max(4096).optional(),
  meta: SpaceMetaBody.optional(),
  /**
   * How `meta.typeSchemas` combines with what is already stored. Default `merge`, which is the behaviour
   * this endpoint has always had and which an integrator specifically asked for — a caller that edits one
   * type must not have to resend the other forty.
   *
   * `replace` makes the payload authoritative: types absent from it are REMOVED. It exists because there
   * was otherwise no way to delete a type at all. The settings UI deleted one, sent a payload that simply
   * did not mention it, and `mergeSpaceMeta` faithfully preserved it — so a deletion could be performed,
   * saved, and silently not happen. Reported by an integrator whose space had 21 foreign types they could
   * not remove by any sequence of UI actions.
   *
   * Deliberately NOT a new endpoint. `PUT :id/schema` already replaces wholesale, but it calls
   * `updateSpace()` directly and so bypasses the network vote that a meta change on a networked space
   * has to go through. Routing the UI's Save there would have traded a silent no-op for a silent
   * consensus bypass.
   */
  typeSchemasMode: z.enum(['merge', 'replace']).optional(),
  /**
   * Propose `meta` to ONE network carrying the space, as that network's definition (`F-39.5`), instead of editing
   * this instance's own. The owner's rule for a space in two networks is that a clash never stops data and a
   * combined definition is proposed by hand, by vote: this is that proposal. It merges over the network's layer,
   * opens a round on that network alone, and a body carrying anything but `meta` and `typeSchemasMode` is refused,
   * because nothing else about a space is the network's to vote on.
   */
  targetNetwork: z.string().uuid().optional(),
  dupeRules: z.array(DupeActionRuleBody).max(20).optional(),
  dupeMergeSurvivor: z.enum(['older', 'newer']).optional(),
  dupeRulesOnInsert: z.boolean().optional(),
  // F10: auto-TTL in days — the SPACE tier of record > schema > space. 0/null clears it; a positive value
  // stamps every new/updated record with no closer window.
  //
  // TWO shapes. The scalar came first and is accepted forever, because a space that set one keeps working and
  // this is local config a read-side widening can absorb. The object is per BUCKET, five of them: a space does
  // not hold one kind of thing, and files share this tier while having no type for the schema tier to reach.
  recordTtlDays: z.union([
    TtlWindowZ,
    z.object({
      entity: TtlWindowZ, fact: TtlWindowZ, edge: TtlWindowZ, chrono: TtlWindowZ, file: TtlWindowZ,
    }).strict().refine(v => Object.values(v).some(x => x !== undefined), {
      message: 'recordTtlDays needs at least one of entity, fact, edge, chrono or file',
    }),
  ]).nullable().optional(),
  // F11-c: per-space document-extraction mode override. null clears it (inherit the instance default).
  // `max` is accepted as the legacy spelling of `repair` and normalised on the way in.
  documentExtraction: z.enum(DOC_EXTRACTION_MODES_IN).nullable().optional(),
  // Per-space analysis level for the other media classes, capped by the instance ceiling.
  // null clears the override so the space follows the instance again.
  imageAnalysis: z.enum(IMAGE_LEVELS).nullable().optional(),
  audioAnalysis: z.enum(AUDIO_LEVELS).nullable().optional(),
  videoAnalysis: z.enum(VIDEO_LEVELS).nullable().optional(),
  textAnalysis: z.enum(TEXT_LEVELS).nullable().optional(),
  /**
   * `M-2`: this space's links are all link RECORDS. Local and never voted — see `SpaceConfig.completeLinkage`
   * for why the interface it sits on is the behaviour and not a filing decision.
   */
  completeLinkage: z.boolean().optional(),
}).strict().refine(d => UPDATABLE.some(k => d[k] !== undefined), {
  message: `At least one of ${UPDATABLE.slice(0, -1).join(', ')}, or ${UPDATABLE[UPDATABLE.length - 1]} must be provided`,
});

export const ReorderSpacesBody = z.object({
  ids: z.array(z.string().min(1).max(40)).min(1).max(MAX_SPACE_IDS),
}).strict();

export const PutSchemaBody = z.object({
  typeSchemas: TypeSchemasZ,
}).strict();
