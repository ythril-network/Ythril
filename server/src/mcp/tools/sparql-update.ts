/**
 * MCP `sparql_update` (bundle-272, Q-761): a SPARQL 1.1 Update on one space, the tool half of
 * `POST /api/brain/spaces/:spaceId/sparql/update` (and, through the tools door, `POST /api/sparql_update`).
 *
 * ## What it prevents
 *
 * - **Two doors that differ.** Both run `spaces/sparql-update-act.ts`, which owns the parameters, the bounds, every refusal's sentence and
 *   code and the counts; the dispatcher leaves `update` and the dataset to it (`argumentsJudgedByTheAct`).
 * - **A write a read-only token reaches.** Marked `mutating`, priced in `TOOL_RIGHTS` at `knowledge: write`; the schema rung is never asked
 *   and never implied.
 * - **An unaudited Update, or its text in the audit.** Recorded as the act `brain.sparql_update` (`MCP_TOOL_OPERATIONS`), by its counts.
 */
import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { toolRefusalOfAct, type ToolRefusalStatus } from '../../util/errors.js';
import { schemaFingerprintOf } from '../../spaces/schema-stamp.js';
import { SPARQL_QUERY_MAX_BYTES } from '../../rdf/sparql-engine.js';
import { SPARQL_LIMIT_DEFAULTS } from '../../config/sparql-limits.js';
import { SPARQL_UPDATE_REFUSAL_CODES } from '../../rdf/change-set-store.js';
import { auditChangesOf, sparqlUpdateAct, SPARQL_UPDATE_ACT_CODES, USING_GRAPH_URIS_MAX } from '../../spaces/sparql-update-act.js';

const STRINGS = { type: 'array', items: { type: 'string' }, maxItems: USING_GRAPH_URIS_MAX } as const;
const BYTES_PER_KIB = 1024;
const COUNTS = { type: 'object', properties: { entity: { type: 'integer' }, fact: { type: 'integer' }, chrono: { type: 'integer' }, edge: { type: 'integer' } } } as const;

export const SPARQL_UPDATE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    inserted: COUNTS, converged: COUNTS, deleted: COUNTS, recordsChanged: { type: 'integer' }, attempts: { type: 'integer' },
    ids: { type: 'object', description: 'The ids of the records the Update inserted, by kind.' },
    statements: {
      type: 'object', description: 'What became of the Update\'s statements: taken (part of a write; `removed` and `inserted` count only these), noops (no record held the removed value, or already held the inserted one) and notTaken (left out: recorded and dropped by the space\'s mode, or owned by the server).',
      properties: { removed: { type: 'integer' }, inserted: { type: 'integer' }, taken: { type: 'integer' }, noops: { type: 'integer' }, notTaken: { type: 'integer' } },
    },
    reasons: { type: 'array', description: 'The statements the space\'s mode recorded and dropped, named by their subject and predicate and the value\'s kind and length, with the rule (`code`, `message`, `kept`, `count`).', items: { type: 'object' } },
    notTaken: { type: 'array', description: 'The statements left out on purpose (the server owns them), grouped by why, named as `reasons` are.', items: { type: 'object' } },
  },
  required: ['inserted', 'converged', 'deleted', 'recordsChanged', 'attempts'],
} as const;

export const sparql_updateTool: ToolHandler = {
  name: 'sparql_update',
  description: 'Change the records of one space with a SPARQL 1.1 Update: INSERT DATA, DELETE DATA, DELETE/INSERT ... WHERE and DELETE WHERE, '
    + 'several joined by `;`. Same as POST /api/brain/spaces/:spaceId/sparql/update.\n\n'
    + 'WHOLE OR NOTHING: the statements become record writes by the rules every write door keeps (the schema, strict linkage, the functional '
    + 'rule); one refused statement refuses the Update (`sparql_update_refused`, naming the record and the rule) and nothing lands. A record '
    + 'is addressed by its address under the space\'s base; a new subject under an address of the space is inserted under a new id. An Update '
    + 'that deletes an entity something still names is refused (`sparql_update_referenced`, with its `backlinks`): delete or relink them in the '
    + 'same Update. An Update that met another write is run again, at most 3 times, then `sparql_update_conflict`. More records changed than '
    + '`sparql.maxRecordsChanged` is `sparql_too_many_changes`. `write_group_outcome_unknown`: read back before sending it again.\n\n'
    + 'NOT HERE: graph management (CLEAR, DROP, CREATE, ADD, MOVE, COPY, LOAD), SERVICE and other graphs. Cost: one Update at a time per '
    + 'token; an Update that deletes counts as a destructive call. Needs `knowledge: write`. '
    + `Refusals carry a code: ${[...SPARQL_UPDATE_ACT_CODES, ...SPARQL_UPDATE_REFUSAL_CODES].join(', ')}, and the query endpoint's text codes.`,
  mutating: true,
  argumentsJudgedByTheAct: ['update', 'using-graph-uri', 'using-named-graph-uri'],
  spaceRequired: true,
  outputSchema: SPARQL_UPDATE_OUTPUT_SCHEMA,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      update: { type: 'string', minLength: 1, maxLength: SPARQL_QUERY_MAX_BYTES, description: `The SPARQL 1.1 Update text (at most ${SPARQL_QUERY_MAX_BYTES / BYTES_PER_KIB} KiB). At most \`sparql.maxRecordsChanged\` records changed (default ${SPARQL_LIMIT_DEFAULTS.maxRecordsChanged}).` },
      'using-graph-uri': { ...STRINGS, description: 'The SPARQL protocol\'s USING: only the space\'s own graph may be named.' },
      'using-named-graph-uri': { ...STRINGS, description: 'The SPARQL protocol\'s USING NAMED: only the space\'s own graph may be named.' },
    },
    required: ['space'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const a = ctx.args;
    const answer = await sparqlUpdateAct({
      spaceId: ctx.callSpace, update: a['update'], usingGraphUri: a['using-graph-uri'], usingNamedGraphUri: a['using-named-graph-uri'],
      caller: ctx.callerRecord ?? { rights: ctx.rights ?? null }, callerKey: ctx.rateKey, ...(ctx.actor ? { actor: ctx.actor } : {}),
      fingerprintOf: schemaFingerprintOf,
      // An Update that throws still leaves its row of counts (outcome `failed`). ToolContext carries no abort signal, so no `signal` is passed on this door.
      recordAudit: (audit) => ctx.recordAuditChanges?.(auditChangesOf(audit)),
    });
    ctx.recordAuditChanges?.(auditChangesOf(answer.audit));
    if (!answer.ok) throw toolRefusalOfAct(answer.status as ToolRefusalStatus, answer.error, answer.body);
    const text = `Landed: ${answer.body.recordsChanged} record(s) changed in ${answer.body.attempts} attempt(s).`;
    return { content: [{ type: 'text' as const, text }, { type: 'text' as const, text: JSON.stringify(answer.body) }], structuredContent: { ...answer.body } };
  },
};
