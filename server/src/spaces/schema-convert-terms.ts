/**
 * The terms of the Convert act and of the read of a run's status that the act, the route and the MCP tools share (Q-746, bundle-284 design r5
 * section 2.3): the start's parameters, the refusal codes, and the shapes of a caller and of an answer.
 *
 * ## What it prevents
 *
 * **The conversion joining the server's largest import cycle.** The MCP tools are registered by the tools index, which is a module of that cycle,
 * so whatever a tool module imports, and whatever that reaches, is drawn into it unless it reaches nothing of the cycle. The tools read their
 * parameters, bounds and codes from HERE, which imports no module of the server but the knowledge kinds and the rights' type, and they reach the
 * acts through the port `useSchemaConvertActs` (`mcp/tools/schema-convert.ts`), wired by the route module the application mounts. So neither the
 * acts nor the run, the converter, the items or the metrics they reach are modules of that cycle, whose size a ceiling holds from growing
 * (`check-i-architecture-dependency-direction`). A term moved here is re-exported by the module it came from, for that module's own readers.
 */
import { z } from 'zod';
import { isDeclarableTypeName, TYPE_NAME_MAX } from '@ythril-network/schema/internal';
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
 * The start's parameters, every key judged by the act: `types` and `steps` are taken as sent here and judged by their own refusals in the act, so a
 * bad `types` and a bad `steps` answer by their own codes on both doors. Strict: a key this capability has no parameter for is refused, never ignored.
 */
export const SchemaConvertBody = z.object({ types: z.unknown(), steps: z.unknown() }).strict();

/** One named type: a knowledge kind and a type name (an edge's type is its label). The run's own whole-kind marker is not a type name. */
export const ConvertTypeZ = z.object({
  kind: z.enum(KNOWLEDGE_TYPES),
  type: z.string().min(1).max(TYPE_NAME_MAX).refine(name => isDeclarableTypeName(name) && name !== '*', 'is not a type name'),
}).strict();
