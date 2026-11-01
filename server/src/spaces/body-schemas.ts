/**
 * The request-body schemas for the space routes, and the space-schema bodies they hold.
 *
 * ## Where the schema bodies are
 *
 * The space meta body (`SpaceMetaBody`), the type-schema bodies (`TypeSchemasZ`, `TypeSchemaZ`, `PropertySchemaZ`) and the parses that
 * mint the only value a store accepts (`parseSpaceMeta`, `parseTypeSchema`, ...) are `@ythril/schema`'s (`schema/src/space-meta.ts`).
 * An app that writes a schema runs that validator in its own CI instead of a hand-made mirror of it, so the server and the app cannot
 * disagree about what a schema is. They are re-exported below, so every module here that imported them from this file still does —
 * and the one place a parse reads the instance (the schema library a `$ref` names) is handed over in `library-ref-expansion.ts`, which
 * this module imports so no parse can run before it.
 *
 * What stays here is the ROUTES' own: the bodies of create, update, rename, delete and reorder, the dupe rules, and the fields a `GET`
 * emits that a `PATCH` strips. They read the instance (media levels, request bounds, the SSRF check) and are no app's business.
 *
 * ## Why they are here and not in the router
 *
 * They were all in `api/spaces.ts`, which is the file the god-file ratchet has raised four times with the note
 * *"a fourth raise of one file is the signal to split it instead of raising a fifth time"*. The schemas are what kept pulling that
 * file upward, so the schemas are what moved — and `planSpaceMetaUpdate` in `meta-update.ts` needs `UpdateSpaceBody` while the router
 * imports the planner, so leaving the schema in the router would be a cycle.
 *
 * ## What is deliberate in here
 *
 * **Every body here is `.strict()`, and that took an owner ruling.** For a while four were strict and six were not:
 * `SpaceMetaBody`, `TypeSchemasZ`, `PropertySchemaZ` and `DupeActionRuleBody` refused an unknown key while the six
 * top-level bodies dropped one. It was a real defect the whole time:
 *
 *     PATCH {"meta":{"validationMdoe":"strict"}}     -> 400, refused one level down
 *     PATCH {"label":"x","validaitonMode":"strict"}  -> 200, label applied and the typo silently gone
 *
 * It waited on a ruling rather than on work because closing it is BREAKING for any integrator currently sending a
 * key we ignore — they get a 400 where they used to get a 200. Owner ruled A on 2026-08-15: refuse.
 *
 * `space-bodies-are-strict.test.js` derives the list from THIS file and from the package's, rather than from a copy, so a body added
 * later without `.strict()` fails the build instead of quietly rejoining the lenient half.
 */
import { z } from 'zod';
import { SpaceMetaBody, TypeSchemasZ, type ParsedTypeSchema } from '@ythril/schema';
import './library-ref-expansion.js';
import { isSsrfSafeUrl, SSRF_SAFE_MESSAGE } from '../util/ssrf.js';
import { DOC_EXTRACTION_MODES_IN, IMAGE_LEVELS, AUDIO_LEVELS, VIDEO_LEVELS, TEXT_LEVELS } from '../config/types.js';
import type { SchemaLibraryEntry } from '../config/types.js';
import { RECORD_TYPES, UNKNOWN_WRITE_FIELD_ANSWERS } from '../config/types.js';
import { MAX_SPACE_IDS, MAX_CREATE_FOLDERS } from '../util/request-bounds.js';

export {
  PropertySchemaZ, EndpointMemberZ, TypeSchemaZ, InlineTypeSchemaZ, collectionScopeIssues, TypeSchemasZ,
  findBrokenLibraryRefs, withoutBrokenLibraryRefs, brokenRefsError, findWrongKindLibraryRefs, wrongKindRefsError,
  SpaceMetaBody, SERVER_OWNED_META_FIELDS, stripServerOwnedMeta,
  parseSpaceMeta, readPeerMeta, readStoredMeta, parseTypeSchema, parseInlineDefinition, LIBRARY_SCHEMA_KEYS, libraryDeletePathProblem,
  withTypeSchemas, derivedFromStored,
  type WrongKindLibraryRef, type ParsedTypeSchema, type ParsedSpaceMeta, type MetaParse, type MetaParseOptions,
} from '@ythril/schema';

/**
 * A schema-library entry whose `schema` the library's parse accepted (`parseInlineDefinition`), or one the library already held.
 * The only entry `saveSchemaLibrary` takes, so a path that stores an entry without parsing its schema is a type error: the library is
 * where one stored pattern or rule runs in every space that references the entry. What the library already holds is of this type too
 * (`getSchemaLibrary`, through the loader's one named trusted source), which is what lets a write keep the entries it did not touch.
 */
export type ParsedLibraryEntry = SchemaLibraryEntry & { schema: ParsedTypeSchema };

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
export const CREATE_ONLY_SPACE_FIELDS = ['id', 'folders'] as const;

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
  'documentExtraction', 'imageAnalysis', 'audioAnalysis', 'videoAnalysis', 'textAnalysis', 'completeLinkage', 'unknownWriteFields',
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
  /**
   * THIS instance's answer to a top-level field a brain write does not take (`SpaceConfig.unknownWriteFields`, Q-320): `refuse` refuses the
   * write, `warn` (and `''` and `null`, which clear it) stores the record and names the field. Local and never voted, so it is applied
   * beside the other local settings and not with the meta. `''` is what the Settings form sends to clear.
   */
  unknownWriteFields: z.enum([...UNKNOWN_WRITE_FIELD_ANSWERS, '']).nullable().optional(),
}).strict().refine(d => UPDATABLE.some(k => d[k] !== undefined), {
  message: `At least one of ${UPDATABLE.slice(0, -1).join(', ')}, or ${UPDATABLE[UPDATABLE.length - 1]} must be provided`,
});

export const ReorderSpacesBody = z.object({
  ids: z.array(z.string().min(1).max(40)).min(1).max(MAX_SPACE_IDS),
}).strict();

export const PutSchemaBody = z.object({
  typeSchemas: TypeSchemasZ,
}).strict();
