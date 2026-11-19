/**
 * MCP `export_rdf` (Q-750; owner 2026-11-19: the first of an `export_*` family): the records of a space or of the caller's own personal
 * view as Turtle, TriG, N-Quads or JSON-LD, the tool half of `GET /api/brain/spaces/:spaceId/export/rdf`.
 *
 * ## What it prevents
 *
 * Both doors run `rdf/export-act.ts`, which owns the parameters, the bounds, the pages, the rights and every refusal's sentence and code;
 * the dispatcher's own check is skipped (`skipSchemaValidation`) so a wrong value is answered by the act's code (`rdf_bad_limit`...) as on
 * REST. This module only shapes the answer (MCP 2025-06-18, standards review row 15): the document once, in the first text block; the
 * summary as JSON in a second block for a client that does not read `structuredContent`; the summary alone in `structuredContent`,
 * declared by `outputSchema`. The export slot is released as soon as the page is built: nothing is left to send.
 *
 * Registered in `mcp/tools/index.ts`, priced in `TOOL_RIGHTS` (`knowledge: read`), recorded as the act `rdf.export` (`MCP_ACT_OPERATIONS`).
 */
import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { rdfExportAct, RDF_EXPORT_LIMIT_MAX, RDF_EXPORT_CURSOR_MAX, RDF_EDGE_DETAILS, RDF_EXPORT_REFUSAL_CODES } from '../../rdf/export-act.js';
import { RDF_FORMATS } from '../../rdf/serialize.js';
import { EXPORT_SLOTS_INSTANCE, EXPORT_SLOTS_PER_CALLER } from '../../export/export-slots.js';
import { viewReadOfCall } from '../../spaces/read-scope.js';
import { toolRefusalOfAct } from '../../util/errors.js';
import { budgetSizeSchema } from './_page-budget-schema.js';
import { KEYSET_PAGER } from '../../brain/result-budget.js';
import { schemaFingerprintOf } from '../../spaces/schema-stamp.js';

const STRINGS = { type: 'array', items: { type: 'string' } } as const;

/** The summary every answer carries in `structuredContent` and as its second text block. */
export const RDF_EXPORT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    space: { type: 'string' }, members: STRINGS, membersWithoutRdf: STRINGS, membersInConflict: STRINGS,
    format: { type: 'string', enum: [...RDF_FORMATS] }, mediaType: { type: 'string' }, edgeDetails: { type: 'string', enum: [...RDF_EDGE_DETAILS] },
    version: { type: ['string', 'null'] }, records: { type: 'integer' }, counts: { type: 'object', additionalProperties: { type: 'integer' } },
    complete: { type: 'boolean' }, nextAfter: { type: 'string' },
    skippedValues: {
      type: 'object',
      properties: {
        count: { type: 'integer' }, unnamed: { type: 'integer' },
        named: { type: 'array', items: { type: 'object', properties: { space: { type: 'string' }, recordId: { type: 'string' }, kind: { type: 'string' }, key: { type: 'string' }, reason: { type: 'string' } } } },
      },
      required: ['count', 'named', 'unnamed'],
    },
    fileTriplesWithheld: { type: 'boolean' }, truncated: { type: 'boolean' }, budgetChars: { type: 'integer' }, budgetBytes: { type: ['integer', 'null'] },
    charsReturned: { type: 'integer' }, bytesReturned: { type: 'integer' }, budgetBoundBy: STRINGS,
  },
  required: ['space', 'members', 'format', 'mediaType', 'edgeDetails', 'records', 'complete', 'skippedValues', 'fileTriplesWithheld'],
} as const;

export const export_rdfTool: ToolHandler = {
  name: 'export_rdf',
  description: 'Export the records of a space as RDF: Turtle, TriG, N-Quads or JSON-LD, one page per call, read back by any RDF tool. '
    + 'Name a personal view as `space` to export several spaces at once: each member space you read is its own named graph, and a member '
    + 'you cannot read is not mentioned at all. The document comes back once, in the first text block; the second block and '
    + '`structuredContent` hold the summary (records, `complete`, `nextAfter`, what was left out). Same as GET /api/brain/spaces/:spaceId/export/rdf.\n\n'
    + 'PAGES: a page ends at `limit` records or at the size ceiling (the first record always whole). While records are left the answer carries '
    + '`nextAfter`: pass it as `after` for the next page. A record written while you page is either wholly in or wholly out, and none comes twice. '
    + 'Cost: one call per page; raise `maxChars` for bigger pages.\n\n'
    + 'WHAT IS IN IT: every entity, fact, chrono, edge, link and file of the space under its RDF addresses. A property value that is not one plain '
    + 'value (a list or an object a direct database write left) is left out, counted and named in `skippedValues` and in the document, never '
    + 'silently dropped. File statements need `files: read` on their space: without it they are left out and `fileTriplesWithheld` says so. '
    + 'TriG, N-Quads and JSON-LD end with a small description graph naming each record graph and its shapes (`sh:shapesGraph`, the schema '
    + '`space_schema_rdf` exports); Turtle says the same in its last comment line.\n\n'
    + 'COST AND LIMITS: needs `knowledge: read`. At most '
    + `${EXPORT_SLOTS_INSTANCE} exports run at once on the instance and ${EXPORT_SLOTS_PER_CALLER} per token; another is refused (429, \`rdf_export_busy\`): try again shortly. `
    + `The space needs RDF switched on and a settled base. Refusals carry a code: ${RDF_EXPORT_REFUSAL_CODES.join(', ')}.`,
  mutating: false,
  // The act judges every parameter with the coded refusal the route answers (`rdf_bad_limit`, `rdf_bad_format`...).
  skipSchemaValidation: true,
  spaceRequired: true,
  outputSchema: RDF_EXPORT_OUTPUT_SCHEMA,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      format: { type: 'string', enum: [...RDF_FORMATS], description: 'turtle, trig, nquads or jsonld. Omit it for the default: Turtle for one space, TriG for a view of several (Turtle holds one graph, so it is refused for several: 406 `rdf_format_not_acceptable`).' },
      edgeDetails: { type: 'string', enum: [...RDF_EDGE_DETAILS], description: 'How an edge\'s own details (weight, type, properties) are stated. `rdf12` (the default for the text formats) is RDF 1.2, announced in the document: a reader older than RDF 1.2 cannot parse it. `reification` is the classic form every reader takes (and the only form JSON-LD carries).' },
      after: { type: 'string', minLength: 1, maxLength: RDF_EXPORT_CURSOR_MAX, description: 'The `nextAfter` of the previous page, to continue after it. Omit it to start from the beginning. Anything else is refused (`rdf_bad_after`).' },
      limit: { type: 'integer', minimum: 1, maximum: RDF_EXPORT_LIMIT_MAX, description: 'The most records in this page. Omit it to let the size ceiling alone end the page.' },
      ...budgetSizeSchema('record', KEYSET_PAGER),
    },
    required: ['space'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { format, edgeDetails, after, limit, maxChars, maxBytes, maxTokens } = ctx.args;
    const r = await rdfExportAct({
      spaceId: ctx.callSpace, viewMembers: viewReadOfCall(ctx, ctx.callSpace),
      params: { format, edgeDetails, after, limit, maxChars, maxBytes, maxTokens },
      caller: ctx.callerRecord ?? { rights: ctx.rights ?? null }, callerKey: ctx.rateKey, transport: ctx.transport, fingerprintOf: schemaFingerprintOf,
    });
    if ('error' in r) {
      throw toolRefusalOfAct(r.status, r.error, {
        error: r.error, code: r.code, ...(r.detail ?? {}), ...(r.retryAfterSeconds !== undefined ? { retryAfterSeconds: r.retryAfterSeconds } : {}),
      });
    }
    r.slot.release();
    ctx.recordAuditChanges?.(r.auditChanges);
    return {
      content: [{ type: 'text' as const, text: r.chunks.join('') }, { type: 'text' as const, text: JSON.stringify(r.summary) }],
      structuredContent: { ...r.summary },
    };
  },
};
