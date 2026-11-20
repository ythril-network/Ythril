/**
 * MCP `import_rdf` and `import_rdf_status` (bundle-270, slice S6, Q-753): an RDF document into a space, all or nothing, and what an import did
 * or is doing; the tool halves of `POST /api/brain/spaces/:spaceId/import/rdf` and `GET .../import/rdf/:importId`.
 *
 * ## What it prevents
 *
 * Both doors run `spaces/rdf-import-act.ts`, which owns the parameters (the same names on both doors), the bounds, the act, the report and
 * every refusal's sentence and code. This module hands it the inline document (bounded by the MCP body limit before it reaches here) and
 * shapes the answer: the report as JSON in the text block and in `structuredContent`; a refusal as the act's status and code, with the report
 * of a refused import in `structuredContent`. Registered in `mcp/tools/index.ts`, priced in `TOOL_RIGHTS` (`knowledge: write` for both: a dry
 * run and a status answer what is stored), recorded as `rdf.import` (`MCP_TOOL_OPERATIONS`).
 */
import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { TOOL_REFUSAL_STATUSES, toolRefusalOfAct } from '../../util/errors.js';
import { JSON_BODY_MAX_BYTES } from '../../config/body-limits.js';
import { RDF_FORMATS } from '../../rdf/serialize.js';
import {
  rdfImportAct, rdfImportAuditChanges, rdfImportStatusAct, runningBodyOf, RDF_IMPORT_REASONS_NAMED_MAX, RDF_IMPORT_REFUSAL_CODES, type RdfImportRefusal,
  RDF_IMPORT_ADDRESS_MAX, RDF_IMPORT_GRAPH_BASES_MAX, RDF_IMPORT_GRAPH_BASE_MIN_CHARS, RDF_IMPORT_GRAPH_BASE_MAX_CHARS,
} from '../../spaces/rdf-import-act.js';

/** The act's refusal as the tool's: its status and code, and what more it carries (a refused import's report) as structured content. */
function refusalOf(r: RdfImportRefusal): Error {
  // A status the tool does not carry (the storage limit's 507) is an error result in the act's own sentence and code, as the fact tool's is.
  if (!(TOOL_REFUSAL_STATUSES as readonly number[]).includes(r.status)) return new Error(`${r.error} (${r.code})`);
  return toolRefusalOfAct(r.status as Parameters<typeof toolRefusalOfAct>[0], r.error, { error: r.error, code: r.code, ...(r.detail ?? {}) });
}

async function* inline(text: string): AsyncGenerator<string, void, undefined> {
  yield text;
}

export const import_rdfTool: ToolHandler = {
  name: 'import_rdf',
  description: 'Import an RDF document into a space: Turtle, TriG, N-Quads or JSON-LD, sent inline. ALL OR NOTHING: the whole file is read, '
    + 'translated and checked against the space\'s schema before anything is written; one statement the space refuses (in a strict space, a '
    + 'value its schema refuses; in every mode, a statement with no Ythril form) refuses the whole file, and the answer names each reason with '
    + `its statements (the first ${RDF_IMPORT_REASONS_NAMED_MAX}, the rest counted). In a warn or off space the reasons that mode records are `
    + 'answered and the import lands. Records stated under this space\'s own addresses are updated in place and nothing is taken away; every '
    + 'other subject becomes a NEW record with an id this instance mints, so importing the same foreign file twice makes the records twice '
    + '(run it with dryRun first to see the counts). Same as POST /api/brain/spaces/:spaceId/import/rdf.\n\n'
    + 'COST: needs `knowledge: write`, for a dry run too. While the import writes, the space takes no other writes, no schema change and no '
    + 'sync; a large file holds it for minutes. When it does not finish within the call the answer is `status: running` with its `importId`: '
    + 'ask import_rdf_status. The document is at most the MCP body limit; a larger file goes through the REST route. '
    + `Every refusal carries its code (${RDF_IMPORT_REFUSAL_CODES.length} of them, listed in the guide's RDF import section).`,
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      document: { type: 'string', minLength: 1, maxLength: JSON_BODY_MAX_BYTES, description: 'The RDF document itself, as text, in the format named by `format`; read whole before anything is written.' },
      format: { type: 'string', enum: [...RDF_FORMATS], description: 'turtle, trig, nquads or jsonld: the document\'s format (required here; REST reads Content-Type).' },
      dryRun: { type: 'boolean', description: 'true: read, translate and check everything, write nothing, and answer what would land and every reason. Default false.' },
      blankNodes: { type: 'string', enum: ['refuse', 'mint'], description: 'A subject that is a blank node: refused (the default), or a new record each.' },
      sourceBase: { type: 'string', minLength: 1, maxLength: RDF_IMPORT_ADDRESS_MAX, description: 'The base of the space the file was exported from, when it is another space: its addresses are then read as that space\'s records and terms (default: the file\'s one data graph\'s name).' },
      sourceVocab: { type: 'string', minLength: 1, maxLength: RDF_IMPORT_ADDRESS_MAX, description: 'The vocabulary of that space, when it is not <sourceBase>vocab/.' },
      graphBase: {
        type: 'array', maxItems: RDF_IMPORT_GRAPH_BASES_MAX,
        items: { type: 'string', minLength: RDF_IMPORT_GRAPH_BASE_MIN_CHARS, maxLength: RDF_IMPORT_GRAPH_BASE_MAX_CHARS },
        description: 'For a file of several data graphs (a view\'s export): one "<graph address> <source base>" per graph. A file of several graphs is refused without them.',
      },
      schema: { description: 'Not available yet: building a schema from the file is refused by name (rdf_import_schema_not_available).' },
    },
    required: ['space', 'document', 'format'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { document, ...params } = ctx.args as Record<string, unknown>;
    const answer = await rdfImportAct({
      spaceId: ctx.callSpace, params, body: inline(typeof document === 'string' ? document : ''), caller: ctx.callerRecord ?? { rights: ctx.rights ?? null },
    });
    if (answer.kind === 'running') {
      const running = runningBodyOf(answer);
      return { content: [{ type: 'text' as const, text: JSON.stringify(running) }], structuredContent: running };
    }
    if (answer.kind === 'refused') {
      const report = answer.detail?.['report'];
      if (report && typeof report === 'object') ctx.recordAuditChanges?.(rdfImportAuditChanges(report as Parameters<typeof rdfImportAuditChanges>[0]));
      throw refusalOf(answer);
    }
    ctx.recordAuditChanges?.(rdfImportAuditChanges(answer.report));
    return { content: [{ type: 'text' as const, text: JSON.stringify(answer.report) }], structuredContent: { ...answer.report } };
  },
};

export const import_rdf_statusTool: ToolHandler = {
  name: 'import_rdf_status',
  description: 'What an RDF import of a space did, or is doing: its status (running, completed, refused, failed), the records it inserted and '
    + 'updated per kind, every reason with its statements, and the statements it did not take, by why. Same as GET '
    + '/api/brain/spaces/:spaceId/import/rdf/:importId. Needs `knowledge: write` on the space; a report is kept for seven days.',
  mutating: false,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      importId: { type: 'string', format: 'uuid', description: 'The importId an import_rdf answer gave; an id of another space\'s import is answered as not found.' },
    },
    required: ['space', 'importId'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const answer = await rdfImportStatusAct({ spaceId: ctx.callSpace, params: { importId: ctx.args['importId'] } });
    if (answer.kind === 'refused') throw refusalOf(answer);
    return { content: [{ type: 'text' as const, text: JSON.stringify(answer.report) }], structuredContent: { ...answer.report } };
  },
};
