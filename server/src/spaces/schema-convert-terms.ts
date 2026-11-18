/**
 * The terms of the Convert act and of the read of a run's status that the act, the route and the MCP tools share (Q-746, bundle-284 design r5
 * section 2.3): the start's parameters, the refusal codes, and the shapes of a caller and of an answer.
 *
 * ## What it prevents
 *
 * **Two statements of one bound.** The act parses a start with {@link SchemaConvertBody}, and the MCP tool writes its `types` parameter from
 * {@link SchemaConvertTypesZ} (zod's converter), so the doors, the act and the bounds gate (`a-tool-and-its-route-agree-on-bounds`) read one set of
 * bounds. A leaf (it imports no module of the server but the knowledge kinds, the rights' type and the heavy-call rail's figure), so the run, the
 * acts, the route and the tool may all read it. A term moved here is re-exported by the module it came from, for that module's own readers.
 */
import { z } from 'zod';
import { CONVERSION_STEPS_MAX, isDeclarableTypeName, TYPE_NAME_MAX } from '@ythril-network/schema/internal';
import { KNOWLEDGE_TYPES } from '../config/types-knowledge.js';
import type { TokenRights } from '../config/rights-shape.js';
import { HEAVY_CALLS_PER_WINDOW } from '../rate-limit/heavy-tool.js';

/** The most types one start may name. */
export const SCHEMA_CONVERT_TYPES_MAX = 50;

/**
 * The codes the doors refuse with, one list: the acts answer from it and a text that names them (the tool's description) is checked against it.
 * `schema_convert_running` is the run module's (`startSchemaConvertRun`), `bad_conversion_step` the one a schema save answers too, and
 * `schema_convert_rate_limited` the heavy-call rail's, which a start is priced on.
 */
export const SCHEMA_CONVERT_REFUSAL_CODES = [
  'bad_convert_types', 'too_many_convert_types', 'bad_convert_request', 'bad_conversion_step', 'knowledge_rung', 'space_admin_required', 'schema_convert_running',
  'schema_convert_rate_limited',
] as const;

/** The words of a start the heavy-call rail refused (429 `schema_convert_rate_limited`), as the other heavy doors word theirs. */
export const SCHEMA_CONVERT_RATE_LIMITED = `a conversion start is rate limited — at most ${HEAVY_CALLS_PER_WINDOW} heavy calls a minute per token, counted across `
  + 'both doors and shared with the server\'s other heavy calls; try again shortly';

/** What an act answers: the HTTP status is the contract, so both doors carry it; a refusal carries `{ error, code?, step? }`. */
export interface SchemaConvertActResult { readonly status: number; readonly body: Record<string, unknown> }

/**
 * Who is asking: the rights the call is judged by (`undefined` or `null`: a caller that presented none holds nothing), and the key the heavy-call
 * rail counts a start against: the calling token's id, or its address when it has none (what `callTool` hands a tool as `rateKey`).
 */
export interface SchemaConvertCaller {
  readonly rights: TokenRights | null | undefined;
  readonly rateKey: string;
}

/**
 * The {@link SchemaConvertCaller} of a REST request: the rights of the token the guards accepted, and its id (else the request's address) as the
 * key, the key `callTool` gives a tool, so the routes and the tools spend one allowance. Read by the conversion routes and by a schema save's price.
 */
export function schemaConvertCallerOf(req: { authToken?: unknown; ip?: string }): SchemaConvertCaller {
  const token = req.authToken as { id?: string; rights?: TokenRights } | undefined;
  return { rights: token?.rights, rateKey: token?.id ?? req.ip ?? '' };
}

/** One named type: a knowledge kind and a type name (an edge's type is its label). The run's own whole-kind marker is not a type name. */
export const ConvertTypeZ = z.object({
  kind: z.enum(KNOWLEDGE_TYPES)
    .describe('The kind of the records to convert: `entity`, `fact`, `edge` or `chrono`. A kind that is none of them refuses the whole call and starts nothing.'),
  type: z.string().min(1).max(TYPE_NAME_MAX).refine(name => isDeclarableTypeName(name) && name !== '*', 'is not a type name')
    .describe('The type name (for an edge, its label). Naming a type no record has costs nothing.'),
}).strict();

/** The types of a start: at least one, at most {@link SCHEMA_CONVERT_TYPES_MAX}, each a named type. */
export const SchemaConvertTypesZ = z.array(ConvertTypeZ).min(1).max(SCHEMA_CONVERT_TYPES_MAX);

/**
 * The start's parameters, the bounds both doors state: {@link SchemaConvertTypesZ}, and `steps`, which may be left out and holds at most the schema
 * package's `CONVERSION_STEPS_MAX` (what each step says is judged against the schema by the act, `conversionStepIssues`, by step index). The act
 * names a broken bound by its own code (`bad_convert_types`, `too_many_convert_types`, `bad_convert_request`, `bad_conversion_step`), never by this
 * schema's words, and the MCP tool declares `types` from this schema. Strict: a key this capability has no parameter for is refused, never ignored.
 */
export const SchemaConvertBody = z.object({
  types: SchemaConvertTypesZ,
  steps: z.array(z.unknown()).max(CONVERSION_STEPS_MAX).optional(),
}).strict();
