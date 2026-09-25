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
import { MERGE_FNS } from '../config/types-knowledge.js';
import { getSchemaLibrary } from '../config/loader.js';
import { isSsrfSafeUrl, SSRF_SAFE_MESSAGE } from '../util/ssrf.js';
import { SPACE_PURPOSE_MAX, SCHEMA_DESCRIPTION_MAX, PROPERTY_DESCRIPTION_MAX } from './_shared.js';
import { DOC_EXTRACTION_MODES_IN, IMAGE_LEVELS, AUDIO_LEVELS, VIDEO_LEVELS, TEXT_LEVELS } from '../config/types.js';
import { KNOWLEDGE_TYPES } from '../config/types-knowledge.js';
import { hasReDoSRisk, REDOS_REFUSAL } from '../util/redos.js';
import type { KnowledgeType } from '../config/types.js';
import { RECORD_TYPES } from '../config/types.js';
import { DATE_PASSED_VALUES } from '../brain/chrono-date-policy.js';

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

export const TypeSchemaZ = z.union([
  // Reference to a schema library entry
  z.object({
    $ref: z.string().regex(/^library:[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/, '$ref must be in format "library:<name>"'),
  }).strict(),
  // Inline schema definition
  z.object({
    description: z.string().max(SCHEMA_DESCRIPTION_MAX).optional(),
    namingPattern: SchemaPatternZ.optional(),
    propertySchemas: z.record(z.string().min(1).max(200), PropertySchemaZ).optional(),
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
  }).strict(),
]);

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
const perTypeMap = () => z.record(z.string().min(1).max(200), TypeSchemaZ).optional();

export const TypeSchemasZ = z.object(
  Object.fromEntries(KNOWLEDGE_TYPES.map(k => [k, perTypeMap()])) as Record<KnowledgeType, ReturnType<typeof perTypeMap>>,
).strict().superRefine((maps, ctx) => {
  for (const [collection, types] of Object.entries(maps)) {
    if (!types) continue;
    for (const [typeName, schema] of Object.entries(types as Record<string, unknown>)) {
      for (const field of COLLECTION_SCOPED_FIELDS) {
        if (field.only === collection) continue;
        if (atPath(schema, field.path) === undefined) continue;
        ctx.addIssue({
          code: 'custom',
          path: [collection, typeName, ...field.path.split('.')],
          message: `${field.path} may only be set on an ${field.only} type, and this is under ${collection}: `
            + `${field.why}.`,
        });
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

/** The 422 body for a broken `$ref`, naming what is missing — "invalid schema" sends the caller to the wrong file. */
export function brokenRefsError(brokenRefs: string[]): string {
  return `Schema library ${brokenRefs.length === 1 ? 'entry' : 'entries'} not found: ${brokenRefs.join(', ')}. `
    + `Create ${brokenRefs.length === 1 ? 'it' : 'them'} via POST /api/schema-library before referencing.`;
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
}).strict();

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
 */
export const SERVER_OWNED_META_FIELDS = ['version', 'updatedAt', 'previousVersions', 'needsReindex', 'actualSchema'] as const;

/** Drop the server-owned housekeeping fields from an incoming `meta`, leaving everything else to Zod. */
export function stripServerOwnedMeta(meta: unknown): unknown {
  if (meta == null || typeof meta !== 'object' || Array.isArray(meta)) return meta;
  const copy: Record<string, unknown> = { ...(meta as Record<string, unknown>) };
  for (const f of SERVER_OWNED_META_FIELDS) delete copy[f];
  return copy;
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
  z.tuple([z.literal('*')]),
  z.array(z.string().min(1).max(40)).min(1),
]);

export const CreateSpaceBody = z.object({
  id: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/).optional(),
  label: z.string().min(1).max(200),
  folders: z.array(z.string()).optional(),
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
  types: z.array(z.enum(RECORD_TYPES)).optional(),
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
  ids: z.array(z.string().min(1).max(40)).min(1),
}).strict();

export const PutSchemaBody = z.object({
  typeSchemas: TypeSchemasZ,
}).strict();
