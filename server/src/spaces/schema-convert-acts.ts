/**
 * The Convert act and the read of a run's status (Q-746, bundle-284 design r5 sections 2.3, 5.2 "an act gets 409", 5.4): the acts behind
 * `POST` and `GET /api/spaces/:id/schema-convert` and MCP `space_schema_convert` and `space_schema_conversion`, so both doors take the same parameters
 * and give the same answers and refusals. The route and the tool only translate.
 *
 * ## What starting does
 *
 * {@link schemaConvertStartAct} converts the records of the named types toward the schema the space has NOW, with optional steps. It changes no
 * schema, so it is never voted, and it does not sync first: its caller asked for it now. It reads every copy of those types this instance holds,
 * whoever last wrote it (a record a peer delivered, one whose author left the network, one written here): each record the steps change is
 * rewritten, so it gets a new version, moves to the top of every list sorted by change date and replicates to every peer; each record the steps
 * change nothing on and that conforms is stamped in place with no new version; a fork row is left alone; a record that cannot be converted becomes
 * an item. When another instance converts the same record at the same time, both write the same converted record and the later version wins; when
 * the two run with different steps (one of them refused its steps), the later write decides.
 *
 * It answers at once with `202 { state: 'started', toFp, types, steps }` (`steps` counts the steps the run holds); the conversion runs in the background
 * (`schema-convert-run.ts`). {@link schemaConvertStatusAct} answers how it went: the run as `schemaConvertStatus` gives it, or `{ state: 'none' }`
 * for a space that never had a run, and it writes nothing.
 *
 * ## What it prevents
 *
 * - **A mounting that forgets the rights.** A mass rewrite is the area's irreversible act, so the rights are decided HERE, in the order the answers
 *   are given on both doors: the space exists (404, or 410 for a retired id), then the knowledge rung (`knowledge_rung`: `admin` to start, `read` to
 *   read), then the space's own admin right to start (`space_admin_required`), then the body. A caller who may not start is told so, not what is wrong
 *   with its request. Starting asks the space's admin right on top of the rung because a rewrite lands on every peer: a token that holds `knowledge:
 *   admin` and does not administer the space is refused.
 * - **A step checked against a schema it was never written for.** The steps are held to the schema the space has now (`conversionStepIssues`, its
 *   "after" half: the new names are declared, and a renamed property's old name is not), and a split's conditions are judged against the type as the
 *   schema declares it. Its "before" half is not asked: the schema the records were written under is not known to an act, and the old names a
 *   conversion moves are by definition no longer declared. The one exception is a split: its conditions are read against the properties of the type it
 *   splits, so a split of a type the schema no longer declares is refused too (its conditions cannot be judged, and every record of the type would become
 *   an unconverted item). A refused step answers `400 bad_conversion_step` with its index in `step`, and nothing is started.
 * - **Two answers to one request.** Both doors hand the raw body to {@link schemaConvertStartAct}, which judges every key, so an unknown key (there is
 *   no opt-in parameter: every copy held here is converted) is refused alike by the route and the tool.
 * - **A second run on a run.** An unfinished run refuses an explicit start (`409 schema_convert_running`); only a schema save or a passed round joins
 *   one (`startSchemaConvertRun`).
 * - **A door that rewrites without the rail's price.** A start rewrites every record of its types, as heavy as a space data deletion, so it is
 *   priced on the heavy-call rail (`consumeHeavyToolCall`, keyed by the caller's token id or address, `SchemaConvertCaller.rateKey`) HERE, where
 *   the route and the tool share one allowance and neither can drop it; a caller over it is refused `429 schema_convert_rate_limited`. The price is
 *   asked after every other refusal, the busy one included, so a refused request costs the caller nothing.
 *
 * ## The answers
 *
 * `{ status, body }`; a refusal's body is `{ error, code?, step? }`. Refusals: `400 bad_convert_types` (no `types`, one that is not a `{ kind, type }`
 * of a knowledge kind and a type name, or the run's own whole-kind marker), `400 too_many_convert_types` (more than `SCHEMA_CONVERT_TYPES_MAX`),
 * `400 bad_convert_request` (any other key, or `steps` that is not a list), `400 bad_conversion_step`, `403 knowledge_rung`, `403
 * space_admin_required`, `409 schema_convert_running`, `429 schema_convert_rate_limited`.
 */
import { z } from 'zod';
import {
  conversionStepIssues,
  type ConversionStep, type ConversionMeta, type ConversionIssueCode,
} from '@ythril-network/schema/internal';
import type { TokenRights } from '../config/rights-shape.js';
import { holdsRung, rungRefusal } from '../auth/reachable-spaces.js';
import { isSpaceAdminFor } from '../auth/editor-scope.js';
import { refusalOfParse, peerText, NAME_QUOTED } from '../util/log.js';
import { isConfiguredSpace } from './space-lookup.js';
import { lostSpaceAnswer } from './unknown-space.js';
import { readMetaForWrite } from './schema-stamp.js';
import { startSchemaConvertRun, schemaConvertStatus } from './schema-convert-run.js';
import {
  SCHEMA_CONVERT_TYPES_MAX, SCHEMA_CONVERT_REFUSAL_CODES, SCHEMA_CONVERT_RATE_LIMITED, SchemaConvertBody, ConvertTypeZ,
  type SchemaConvertActResult, type SchemaConvertCaller,
} from './schema-convert-terms.js';
import { consumeHeavyToolCall } from '../rate-limit/heavy-tool.js';

// The terms both doors share live in `schema-convert-terms.ts`, a module the MCP tools may import without drawing this one into the server's
// largest import cycle; re-exported for the readers that name them here.
export { SCHEMA_CONVERT_REFUSAL_CODES, SchemaConvertBody, type SchemaConvertActResult, type SchemaConvertCaller };
const [BAD_TYPES, TOO_MANY_TYPES, BAD_REQUEST, BAD_STEP, KNOWLEDGE_RUNG, SPACE_ADMIN_REQUIRED, , RATE_LIMITED] = SCHEMA_CONVERT_REFUSAL_CODES;
/**
 * The statuses the acts answer with: a request refused for what it says, a caller refused for what it holds, a caller over the heavy-call rail, a
 * start accepted, a read answered.
 */
const BAD_BODY = 400;
const FORBIDDEN = 403;
const TOO_MANY_REQUESTS = 429;
const ACCEPTED = 202;
const OK = 200;

const refusal = (status: number, error: string, code?: string, extra: Record<string, unknown> = {}): SchemaConvertActResult =>
  ({ status, body: { error, ...(code ? { code } : {}), ...extra } });

/** The knowledge rung a call needs, then the space admin right a start needs on top of it; the refusal, or `null`. */
function rightsRefusal(spaceId: string, rights: TokenRights | null | undefined, needs: 'admin' | 'read'): SchemaConvertActResult | null {
  if (!rights) return refusal(FORBIDDEN, rungRefusal(needs, 'knowledge'), KNOWLEDGE_RUNG);
  if (!holdsRung(rights, spaceId, 'knowledge', needs)) return refusal(FORBIDDEN, rungRefusal(needs, 'knowledge', spaceId), KNOWLEDGE_RUNG);
  if (needs === 'admin' && rights.instanceAdmin !== true && !isSpaceAdminFor(rights, spaceId)) {
    return refusal(FORBIDDEN, `Converting records rewrites them on every peer, so it needs the admin right of space '${spaceId}', not only 'admin' on knowledge`, SPACE_ADMIN_REQUIRED);
  }
  return null;
}

/** The names the "before" half of a step's check judges: the schema the records were written under, which an act cannot know. */
const judgesBefore = (code: ConversionIssueCode): boolean => code.endsWith('_before');

/** Does `meta` declare a type of this kind and name? Own keys only: a record's type name is data, and `constructor` is not a declared type. */
function declaresType(meta: ConversionMeta | undefined, kind: string, type: string): boolean {
  const ofKind = (meta?.typeSchemas as Record<string, Record<string, unknown> | undefined> | undefined)?.[kind];
  return ofKind !== undefined && Object.hasOwn(ofKind, type);
}

/**
 * The first step the schema NOW cannot hold, as a refusal; `null` when every step holds. Held to the current schema as both the "before" and the "after"
 * (the schema package reads them alike), with every issue about the "before" dropped (see the docblock): a name the current schema still declares
 * under the same type gives none, a split's conditions are judged against the type as declared, and a renamed property still declared is refused.
 */
function stepRefusal(spaceId: string, steps: readonly ConversionStep[]): SchemaConvertActResult | null {
  const current = readMetaForWrite(spaceId).meta as ConversionMeta | undefined;
  const issues: { step: number; code: string; message: string }[] = conversionStepIssues(steps, current, current).filter(i => !judgesBefore(i.code));
  // A split of a type the schema no longer declares: the run judges its conditions against the type's declared properties, and a type that is gone declares
  // none, so every record of it would become an unconverted item. The "before" half would have named it; an act drops that half, so this is its one case.
  steps.forEach((s, step) => {
    // A step that is not a well-formed split is `conversionStepIssues`' to name (`malformed_step`); only a split that names its type is asked here.
    if (s?.op === 'splitType' && typeof s.kind === 'string' && typeof s.from === 'string' && !declaresType(current, s.kind, s.from)) {
      issues.push({ step, code: 'split_type_not_declared', message: `the ${s.kind} type '${peerText(s.from, { max: NAME_QUOTED })}' the split reads is no longer in the schema, so its conditions cannot be judged: `
        + 'declare the split with the schema change that removes the type (or put the type back first)' });
    }
  });
  issues.sort((a, b) => a.step - b.step);
  // A list over the bound names the first step past it, whatever its earlier steps are (as a schema save does): the bound is the first thing wrong with it.
  const issue = issues.find(i => i.code === 'too_many_steps') ?? issues[0];
  return issue
    ? refusal(BAD_BODY, `steps[${issue.step}]: ${issue.message}`, BAD_STEP, { step: issue.step })
    : null;
}

/** The refusal of the `types` of a request, or `null`: a list of one to the most a run takes, each a named type. */
function typesRefusal(raw: unknown): SchemaConvertActResult | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    return refusal(BAD_BODY, '`types` must be a list of the types to convert: [{ kind, type }, ...], at least one', BAD_TYPES);
  }
  if (raw.length > SCHEMA_CONVERT_TYPES_MAX) {
    return refusal(BAD_BODY, `\`types\` names at most ${SCHEMA_CONVERT_TYPES_MAX} types: ${raw.length} were sent`, TOO_MANY_TYPES);
  }
  const parsed = z.array(ConvertTypeZ).safeParse(raw);
  return parsed.success ? null : refusal(BAD_BODY, refusalOfParse(parsed.error).error, BAD_TYPES);
}

/**
 * The coded refusal of a start {@link SchemaConvertBody} refused, in the order a caller is told: a body that is not an object or holds a key the start
 * has no parameter for (`bad_convert_request`), then `types` ({@link typesRefusal}: `bad_convert_types`, `too_many_convert_types`), then `steps` (not
 * a list: `bad_convert_request`; over the bound: the step check, naming the first step past it as `bad_conversion_step`). The schema holds the bounds
 * the doors state and the gates compare; these name a broken one by the code both doors answer, never by the schema's words. A failure none of them
 * names is answered in the schema's words as a bad request: a request the schema refused is never started.
 */
function startRefusal(spaceId: string, input: unknown, error: z.ZodError): SchemaConvertActResult {
  const whole = refusal(BAD_BODY, refusalOfParse(error).error, BAD_REQUEST);
  const atRoot = error.issues.filter(i => i.path.length === 0);
  if (atRoot.length > 0) return refusal(BAD_BODY, refusalOfParse({ issues: atRoot }).error, BAD_REQUEST);
  const raw = (input ?? {}) as Record<string, unknown>;
  if (error.issues.some(i => i.path[0] === 'types')) return typesRefusal(raw['types']) ?? whole;
  const steps = raw['steps'];
  if (!Array.isArray(steps)) return refusal(BAD_BODY, '`steps` must be a list of conversion steps', BAD_REQUEST);
  return stepRefusal(spaceId, steps as ConversionStep[]) ?? whole;
}

/**
 * Start a run converting the records of the named types of `spaceId` toward its current schema (see the docblock): answers `202 { state: 'started', toFp,
 * types, steps }`, or the refusal. `input` is the request's body or the tool's arguments without `space`, as sent.
 */
export async function schemaConvertStartAct(spaceId: string, input: unknown, caller: SchemaConvertCaller): Promise<SchemaConvertActResult> {
  // The one existence rule (404, or 410 `space_retired` for a retired id).
  if (!isConfiguredSpace(spaceId)) return lostSpaceAnswer(null, spaceId);
  const denied = rightsRefusal(spaceId, caller.rights, 'admin');
  if (denied) return denied;

  const body = SchemaConvertBody.safeParse(input ?? {});
  if (!body.success) return startRefusal(spaceId, input, body.error);
  const steps = (body.data.steps ?? []) as ConversionStep[];
  const bad = stepRefusal(spaceId, steps);
  if (bad) return bad;

  // Priced on the heavy-call rail HERE, inside the act both doors run, so they spend one allowance per caller and neither can leave it out. The run
  // module asks the price once it found no unfinished run, so a start refused as busy costs the caller nothing; a refused one writes nothing.
  const admit = () => (consumeHeavyToolCall(caller.rateKey)
    ? null
    : { ok: false as const, status: TOO_MANY_REQUESTS, code: RATE_LIMITED, error: SCHEMA_CONVERT_RATE_LIMITED });
  const started = await startSchemaConvertRun({ spaceId, types: body.data.types, steps, source: { kind: 'act' }, admit });
  if (!started.ok) return refusal(started.status, started.error, started.code);
  const types = body.data.types.map(t => ({ kind: t.kind, type: t.type }));
  return { status: ACCEPTED, body: { state: 'started', toFp: started.run?.toFp ?? readMetaForWrite(spaceId).stamp.fp, types, steps: steps.length } };
}

/**
 * The run of `spaceId` as `schemaConvertStatus` gives it (state, target, types, steps, steps refused, sources, counts, what is left, the sync it
 * asked for first, failures), or `{ state: 'none' }` for a space that never had a run. Writes nothing.
 */
export async function schemaConvertStatusAct(spaceId: string, caller: SchemaConvertCaller): Promise<SchemaConvertActResult> {
  if (!isConfiguredSpace(spaceId)) return lostSpaceAnswer(null, spaceId);
  const denied = rightsRefusal(spaceId, caller.rights, 'read');
  if (denied) return denied;
  const status = await schemaConvertStatus(spaceId);
  return { status: OK, body: status ? { ...status } : { state: 'none' } };
}
