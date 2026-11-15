/**
 * A space's schema versions, listed, read and compared (bundle-267, Q-742 without names; design r2 "Q-742 without names", r3 §4): the acts
 * behind `GET /api/spaces/:id/schema-versions` (query `fp`, `against`) and MCP `space_schema_versions`, so both doors take the same parameters and give the
 * same answers and refusals.
 *
 * ## What each answers
 *
 * - {@link listSchemaVersionsAct}: `{ versions: [{ fp, current, held, origin?, since?, counts }], ...the page fields }`, paged by `pageList`
 *   (`brain/list-page.ts`: `truncated`, `total`, `count`, `limit`, `skip`, `nextSkip` when cut, and the budget figures). The current version first (from the
 *   config, row or no row), then the held rows newest first, then each network layer of the current variation the config holds and no row does,
 *   then every fingerprint the records carry that no row holds (`held: false`; the empty schema is held everywhere). `counts` are the records of
 *   each stamped collection carrying the version, from the stamp index alone (`fingerprintTypesIn`: it reads the version index of four
 *   collections, no record). The order is the listing order only: no version chain.
 * - {@link readSchemaVersionAct}: `{ fp, current, held, schema: { typeSchemas, rules }, unread? }`, the schema as this release reads a stored one.
 * - {@link diffSchemaVersionAct}: `{ from, to, types, spaceRules, allowlists, unread }` (`spaces/schema-diff.ts`), `to` the current version by default.
 *
 * ## Who sees what
 *
 * A token bound to a peer sees only the versions the sync door would serve it (`servableTo` over the networks it shares the space in): a
 * version built from a network it is not in is left out of the list, and its read and diff answer `404 unknown_fingerprint`, the sync door's
 * spelling for a version this caller cannot have. A local token sees every version. A personal view never reaches here: these are schema-area
 * doors, which answer a view as an unknown space.
 *
 * ## Refusals
 *
 * `400 bad_fingerprint` for a fingerprint that is not 64 lowercase hex (on the path, or in `against`), `404 unknown_fingerprint` for one not
 * held or not this caller's to have, `400 against_needs_fp` for `against` without `fp` (both doors: the list, the read and the diff share one), a 400 for
 * a malformed budget or `skip`, and `503 schema_index_building` (thrown, `SchemaIndexBuilding`) while a collection lists no stamp index.
 *
 * ## The type forms (bundle-268, Q-744)
 *
 * `kind`, `kind` + `type`, `fps` + `kind` + `type` and `fp` + `against` + `kind` + `type` reach `schema-type-acts.ts` (the type list, a type's
 * history, where versions stand for a type) and the narrowed comparison, refused first, in one order, by `bad_kind`, `type_needs_kind`,
 * `fps_needs_type`, `kind_needs_type`, the type name's bound, `too_many_fps` and `bad_fingerprint`; a pass past its deadline is `503
 * schema_versions_busy` (thrown, `SchemaVersionsBusy`).
 */
import { z } from 'zod';
import { isSchemaFingerprint } from '@ythril-network/schema/internal';
import { resolveBudget, defaultBudgetChars, carriagesFor, budgetCeilingZ, type BudgetRequest } from '../brain/result-budget.js';
import { pageList } from '../brain/list-page.js';
import { refusalOfParse } from '../util/log.js';
import { variationOf, EMPTY_SCHEMA_FINGERPRINT } from './schema-stamp.js';
import { snapshots } from './schema-snapshot-store.js';
import { fingerprintTypesIn, STAMPED_COLLECTIONS, FINGERPRINT_TYPES_DEFAULT_MS, type StampedCollection } from './schema-snapshot-carried.js';
import { heldVersions, heldVersionsKept, versionMetaOf, type HeldVersion, type HeldProvenance } from './schema-version-text.js';
import { schemaVersionDiff, narrowedDiff } from './schema-diff.js';
import { unknownSpaceSentence } from './unknown-space.js';
import { mayHave as mayHaveIn } from './type-standing.js';
import { typeListAct, typeHistoryAct, typeStandingsAct, FPS_MAX } from './schema-type-acts.js';
import { KNOWLEDGE_TYPES, type KnowledgeType } from '../config/types-knowledge.js';
import { TYPE_NAME_MAX } from '@ythril-network/schema/internal';
import type { TokenRights } from '../config/rights-shape.js';
import { SCHEMA_INDEX_BUILDING, SCHEMA_VERSIONS_BUSY, BAD_FINGERPRINT, UNKNOWN_FINGERPRINT, badFingerprintSentence } from '../util/errors.js';

/** What an act answers: a body, or a refusal with its status and code. */
export type SchemaVersionsActResult =
  | { status: 200; body: Record<string, unknown> }
  | { status: 400 | 404; error: string; code?: string };

/**
 * Who is asking, as the acts need it: the networks a peer-bound token shares the space in (`undefined`: a local token), the door, and the
 * caller's rights (the type forms answer the facts read from records only to `knowledge: read` or an administrator: `mayReadRecordFacts`).
 */
export interface SchemaVersionsCaller {
  readonly shared: ReadonlySet<string> | undefined;
  readonly transport: 'mcp' | 'rest';
  readonly rights: TokenRights | null | undefined;
}

/** One entry of the list. */
interface VersionEntry {
  fp: string;
  current: boolean;
  held: boolean;
  origin?: string;
  since?: string;
  counts: Record<StampedCollection, number>;
}

/**
 * The codes the schema-version doors refuse with, one list: the acts answer from it, and a text that names them (the tool's description) is
 * checked against it. `bad_fingerprint` and `unknown_fingerprint` are the sync door's, read from their one declaration (`util/errors.ts`).
 */
export const SCHEMA_VERSION_REFUSAL_CODES = [
  BAD_FINGERPRINT, UNKNOWN_FINGERPRINT, 'against_needs_fp', SCHEMA_INDEX_BUILDING,
  // The type forms (bundle-268, Q-744 design r4 §5).
  'bad_kind', 'type_needs_kind', 'kind_needs_type', 'fps_needs_type', 'too_many_fps', SCHEMA_VERSIONS_BUSY,
] as const;
const AGAINST_NEEDS_FP = SCHEMA_VERSION_REFUSAL_CODES[2];
const [BAD_KIND, TYPE_NEEDS_KIND, KIND_NEEDS_TYPE, FPS_NEEDS_TYPE, TOO_MANY_FPS] =
  [SCHEMA_VERSION_REFUSAL_CODES[4], SCHEMA_VERSION_REFUSAL_CODES[5], SCHEMA_VERSION_REFUSAL_CODES[6], SCHEMA_VERSION_REFUSAL_CODES[7], SCHEMA_VERSION_REFUSAL_CODES[8]];

const badFingerprint = (where: string): SchemaVersionsActResult => ({ status: 400, error: badFingerprintSentence(where), code: BAD_FINGERPRINT });
const unknownFingerprint: SchemaVersionsActResult = {
  status: 404, error: 'This space holds no schema version with that fingerprint that this caller may read', code: UNKNOWN_FINGERPRINT,
};
/** A space gone between the door's check and the read: the one unknown-space sentence (`spaces/unknown-space.ts`). */
const unknownSpace = (spaceId: string): SchemaVersionsActResult => ({ status: 404, error: unknownSpaceSentence(spaceId) });

/** May the caller have this held version? THE answer of the standing pass (`type-standing.ts`), asked with this caller's networks. */
const mayHave = (v: HeldProvenance, caller: SchemaVersionsCaller): boolean => mayHaveIn(v, caller.shared);

/**
 * The parameters both doors take, with their bounds: the route's query (numbers through `queryInt`) and the tool's arguments are parsed by this
 * one schema, so the two cannot state different bounds (`a-tool-and-its-route-agree-on-bounds`). `fp`, `against`, `kind`, `type` and `fps`
 * are taken as sent here and judged by the acts, which answer each malformed one by its own code on both doors (`bad_fingerprint`,
 * `bad_kind`, `too_many_fps`, a `type` over `TYPE_NAME_MAX`). `fps` is a comma-separated list on the route and an array on the tool.
 */
export const SchemaVersionsParams = z.object({
  fp: z.string().optional(),
  against: z.string().optional(),
  kind: z.string().optional(),
  type: z.string().optional(),
  fps: z.union([z.string(), z.array(z.string())]).optional(),
  skip: z.number().min(0).multipleOf(1).optional(),
  maxChars: budgetCeilingZ().optional(),
  maxBytes: budgetCeilingZ().optional(),
  maxTokens: budgetCeilingZ().optional(),
});

/** The budget a call states, parsed by {@link SchemaVersionsParams} and refused in the words every budgeted door uses. */
function budgetOf(req: BudgetRequest & { skip?: unknown }, caller: SchemaVersionsCaller): { ok: true; budget: ReturnType<typeof resolveBudget> & { ok: true } } | { ok: false; error: string } {
  const parsed = SchemaVersionsParams.safeParse({ skip: req.skip, maxChars: req.maxChars, maxBytes: req.maxBytes, maxTokens: req.maxTokens });
  if (!parsed.success) return { ok: false, error: refusalOfParse(parsed.error).error };
  const budget = resolveBudget(req, defaultBudgetChars(caller.transport), carriagesFor(caller.transport));
  return budget.ok ? { ok: true, budget } : { ok: false, error: budget.error };
}

/** Records per version and stamped collection, from the stamp index alone. */
async function countsOf(spaceId: string): Promise<Map<string, Record<StampedCollection, number>>> {
  const out = new Map<string, Record<StampedCollection, number>>();
  for (const collection of STAMPED_COLLECTIONS) {
    for (const { fp, count } of await fingerprintTypesIn(spaceId, collection, { maxTimeMS: FINGERPRINT_TYPES_DEFAULT_MS })) {
      let counts = out.get(fp);
      if (!counts) { counts = zeroCounts(); out.set(fp, counts); }
      counts[collection] += count;
    }
  }
  return out;
}

const zeroCounts = (): Record<StampedCollection, number> =>
  Object.fromEntries(STAMPED_COLLECTIONS.map(c => [c, 0])) as Record<StampedCollection, number>;

/** The fingerprints of the space's snapshot rows, newest first. */
async function rowFingerprints(spaceId: string): Promise<string[]> {
  const rows = await snapshots(spaceId).find({}, { projection: { _id: 1, at: 1 }, maxTimeMS: FINGERPRINT_TYPES_DEFAULT_MS }).sort({ at: -1, _id: 1 }).toArray();
  return rows.map(r => r._id).filter(isSchemaFingerprint);
}

/** The versions of `spaceId`, one page of them. */
export async function listSchemaVersionsAct(
  spaceId: string, req: BudgetRequest & { skip?: unknown }, caller: SchemaVersionsCaller,
): Promise<SchemaVersionsActResult> {
  // Refused before anything is read: the bounds of both doors (`SchemaVersionsParams`) and the budget, in the words every budgeted door uses.
  const budget = budgetOf(req, caller);
  if (!budget.ok) return { status: 400, error: budget.error };
  const variation = variationOf(spaceId);
  if (!variation) return unknownSpace(spaceId);

  const counts = await countsOf(spaceId);
  const rowFps = await rowFingerprints(spaceId);
  const current = variation.stamp.fp;
  // The order of the list: current, the rows newest first, the configured layers no row holds, then what records carry and nothing holds.
  const order = [...new Set([current, ...rowFps, ...variation.layers.map(l => l.stamp.fp), ...counts.keys()])];
  // Held, how and since when, read without the texts: the list names versions, never their schemas.
  const held = await heldVersionsKept(spaceId, order);
  const versions: VersionEntry[] = [];
  for (const fp of order) {
    const v = held.get(fp);
    if (v && !mayHave(v, caller)) continue;
    // The empty schema is listed only where it is current or carried: every instance holds it, and a list of every space would name it.
    if (fp === EMPTY_SCHEMA_FINGERPRINT && fp !== current && !counts.has(fp)) continue;
    versions.push({
      fp, current: fp === current, held: v !== undefined,
      ...(v?.kept ? { origin: v.kept.origin } : {}),
      ...(v?.since !== undefined ? { since: v.since } : {}),
      counts: counts.get(fp) ?? zeroCounts(),
    });
  }
  // One page through the one pager of a held list (`pageList`): whole versions, under the budget, the cut reported. The list takes no row
  // limit, so the limit is the whole list and only the budget cuts it.
  const page = pageList(versions, { skip: req.skip, maxChars: req.maxChars, maxBytes: req.maxBytes, maxTokens: req.maxTokens }, {
    defaultLimit: Math.max(1, versions.length), budgetChars: defaultBudgetChars(caller.transport), carriages: carriagesFor(caller.transport),
  });
  if (!page.ok) return { status: 400, error: page.error };
  return { status: 200, body: { versions: page.rows, ...page.fields } };
}

/** One version this caller may have, or the refusal. */
async function versionFor(spaceId: string, fp: string, caller: SchemaVersionsCaller): Promise<HeldVersion | SchemaVersionsActResult> {
  const v = (await heldVersions(spaceId, [fp])).get(fp);
  return v && mayHave(v, caller) ? v : unknownFingerprint;
}

const isRefusal = (v: HeldVersion | SchemaVersionsActResult): v is SchemaVersionsActResult => 'status' in v;

/** One version's schema. The budget is taken and checked as on the list; a version is one unit, answered whole. */
export async function readSchemaVersionAct(
  spaceId: string, fp: string, req: BudgetRequest, caller: SchemaVersionsCaller,
): Promise<SchemaVersionsActResult> {
  if (!isSchemaFingerprint(fp)) return badFingerprint('fp');
  const budget = budgetOf(req, caller);
  if (!budget.ok) return { status: 400, error: budget.error };
  const variation = variationOf(spaceId);
  if (!variation) return unknownSpace(spaceId);
  const v = await versionFor(spaceId, fp, caller);
  if (isRefusal(v)) return v;
  const read = versionMetaOf(v.text);
  const unread = read ? read.unread : ['text'];
  return {
    status: 200,
    body: {
      fp, current: fp === variation.stamp.fp, held: true,
      schema: read?.meta ?? { typeSchemas: {}, rules: {} },
      ...(unread.length > 0 ? { unread } : {}),
    },
  };
}

/** What changed from version `fp` to `against` (`current` by default). The budget is taken and checked; a comparison is answered whole. */
export async function diffSchemaVersionAct(
  spaceId: string, fp: string, against: unknown, req: BudgetRequest, caller: SchemaVersionsCaller,
  narrowTo?: { kind: KnowledgeType; type: string },
): Promise<SchemaVersionsActResult> {
  if (!isSchemaFingerprint(fp)) return badFingerprint('fp');
  const to = against === undefined || against === 'current' ? 'current' : against;
  if (to !== 'current' && !isSchemaFingerprint(to)) return badFingerprint('against');
  const budget = budgetOf(req, caller);
  if (!budget.ok) return { status: 400, error: budget.error };
  const variation = variationOf(spaceId);
  if (!variation) return unknownSpace(spaceId);
  const toFp = to === 'current' ? variation.stamp.fp : to;
  const from = await versionFor(spaceId, fp, caller);
  if (isRefusal(from)) return from;
  const target = toFp === fp ? from : await versionFor(spaceId, toFp, caller);
  if (isRefusal(target)) return target;
  const diff = schemaVersionDiff(from.text, target.text);
  if (narrowTo) return { status: 200, body: { from: fp, to: toFp, kind: narrowTo.kind, type: narrowTo.type, ...narrowedDiff(diff, narrowTo.kind, narrowTo.type) } };
  return { status: 200, body: { from: fp, to: toFp, ...diff } };
}

/** The arguments of the one door, as both doors hand them over. */
export type SchemaVersionsArgs = { fp?: unknown; against?: unknown; skip?: unknown; kind?: unknown; type?: unknown; fps?: unknown } & BudgetRequest;

/** `fps` as sent: an array on the tool, one comma-separated value on the route (or a repeated one). */
function fpsOf(fps: unknown): unknown[] {
  if (Array.isArray(fps)) return fps.flatMap(v => (typeof v === 'string' ? v.split(',') : [v])).filter(v => v !== '');
  if (typeof fps === 'string') return fps.split(',').filter(v => v !== '');
  return [fps];
}

/**
 * The type forms (bundle-268, Q-744 design r4 §5), refused in a fixed order so every malformed request has one code: `bad_kind`, then
 * `type_needs_kind`, then `fps_needs_type` / `kind_needs_type`, then `too_many_fps` and `bad_fingerprint`. Two refusals carry their message and
 * no code, because no code of the list names them and a borrowed one would send an integrator to the wrong parameter: a `type` over its
 * bound, and `fps` sent together with `fp`.
 */
async function typeFormAct(spaceId: string, args: SchemaVersionsArgs, budget: BudgetRequest, caller: SchemaVersionsCaller): Promise<SchemaVersionsActResult> {
  const { kind, type, fps, fp, against } = args;
  if (kind !== undefined && !(KNOWLEDGE_TYPES as readonly unknown[]).includes(kind)) {
    return { status: 400, error: `\`kind\` must be one of: ${KNOWLEDGE_TYPES.join(', ')}`, code: BAD_KIND };
  }
  if (type !== undefined && kind === undefined) return { status: 400, error: '`type` names a type of a kind: send `kind` too', code: TYPE_NEEDS_KIND };
  if (fps !== undefined && type === undefined) {
    return kind === undefined
      ? { status: 400, error: '`fps` asks where versions stand for one type: send `kind` and `type` too', code: FPS_NEEDS_TYPE }
      : { status: 400, error: '`fps` with `kind` asks for one type: send `type` too', code: KIND_NEEDS_TYPE };
  }
  if (fp !== undefined && (against === undefined || type === undefined)) {
    return { status: 400, error: '`kind` with `fp` narrows a comparison to one type: send `against` and `type` too', code: KIND_NEEDS_TYPE };
  }
  if (type !== undefined && (typeof type !== 'string' || type.length < 1 || type.length > TYPE_NAME_MAX)) {
    return { status: 400, error: `\`type\` must be a type name of 1 to ${TYPE_NAME_MAX} characters` };
  }
  const k = kind as KnowledgeType;
  const budgetCheck = budgetOf({ ...budget, skip: args.skip }, caller);
  if (!budgetCheck.ok) return { status: 400, error: budgetCheck.error };
  if (fps !== undefined) {
    if (fp !== undefined) return { status: 400, error: '`fps` and `fp` are two forms: send one' };
    const list = fpsOf(fps);
    if (list.length > FPS_MAX) return { status: 400, error: `\`fps\` names at most ${FPS_MAX} fingerprints`, code: TOO_MANY_FPS };
    if (list.length === 0 || list.some(v => !isSchemaFingerprint(v))) return badFingerprint('every member of fps');
    return typeStandingsAct(spaceId, k, type as string, list as string[], caller);
  }
  if (fp !== undefined) {
    if (typeof fp !== 'string') return badFingerprint('fp');
    return diffSchemaVersionAct(spaceId, fp, against, budget, caller, { kind: k, type: type as string });
  }
  if (type !== undefined) return typeHistoryAct(spaceId, k, type as string, { ...budget, skip: args.skip }, caller);
  return typeListAct(spaceId, k, { ...budget, skip: args.skip }, caller);
}

/**
 * The one door of both the tool and the route onto the acts: no `fp` the list, `fp` the version, `fp` and `against` the comparison; with `kind`
 * (and `type`, `fps`) the type forms ({@link typeFormAct}). `against` alone is refused (`against_needs_fp`): it names what to compare WITH, and a
 * list compares nothing.
 */
export async function schemaVersionsToolAct(spaceId: string, args: SchemaVersionsArgs, caller: SchemaVersionsCaller): Promise<SchemaVersionsActResult> {
  const budget: BudgetRequest = { maxChars: args.maxChars, maxBytes: args.maxBytes, maxTokens: args.maxTokens };
  if (args.fp === undefined && args.against !== undefined) {
    return { status: 400, error: '`against` names what to compare `fp` with: send `fp` too', code: AGAINST_NEEDS_FP };
  }
  if (args.kind !== undefined || args.type !== undefined || args.fps !== undefined) return typeFormAct(spaceId, args, budget, caller);
  if (args.fp === undefined) return listSchemaVersionsAct(spaceId, { ...budget, skip: args.skip }, caller);
  if (typeof args.fp !== 'string') return badFingerprint('fp');
  return args.against === undefined
    ? readSchemaVersionAct(spaceId, args.fp, budget, caller)
    : diffSchemaVersionAct(spaceId, args.fp, args.against, budget, caller);
}
