/**
 * MCP `import_schema_rdf` (bundle-270, Q-754): a space's type schemas built or extended from an RDF file of OWL, RDFS and SHACL, without data;
 * the tool half of `POST /api/spaces/:id/schema-rdf`.
 *
 * ## What it prevents
 *
 * Both doors run `spaces/schema-rdf-import-act.ts`, which owns the parameters (the same names on both doors), the rungs, the bounds, the answer
 * and every refusal's sentence and code. This module hands it the inline document (bounded by the MCP body limit before it reaches here) and
 * shapes the answer: the body as JSON in the text block and in `structuredContent`; a refusal as the act's status and code, its detail (a
 * networked refusal's `proposed`) as structured content, 412 `schema_rdf_changed` included. A status the tool does not carry is an error
 * result in the act's own sentence and code. Registered in `mcp/tools/index.ts`, priced in `TOOL_RIGHTS` (`schema: write`, a dry run
 * too), refused to a peer-bound token (`PEER_REFUSED_TOOLS`), recorded as `schema.rdf.import` (`MCP_TOOL_OPERATIONS`).
 */
import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { TOOL_REFUSAL_STATUSES, ToolRefusal, toolRefusalOfAct } from '../../util/errors.js';
import { mfaStepUpRefusalFor } from '../../auth/mfa-asked.js';
import { JSON_BODY_MAX_BYTES } from '../../config/body-limits.js';
import { RDF_FORMATS } from '../../rdf/serialize.js';
import { inlineRdfDocument } from '../../rdf/rdf-document.js';
import { RDF_IMPORT_ADDRESS_MAX } from '../../spaces/rdf-import-act.js';
import {
  schemaRdfImportAct, SCHEMA_RDF_IMPORT_REFUSAL_CODES, SCHEMA_RDF_ENTRIES_NAMED_MAX, SCHEMA_RDF_FROM_DEFAULT, type SchemaRdfImportRefusal,
} from '../../spaces/schema-rdf-import-act.js';

const FORBIDDEN = 403;

/** The act's refusal as the tool's: its status and code, and what more it carries as structured content. */
function refusalOf(r: SchemaRdfImportRefusal): Error {
  if (!(TOOL_REFUSAL_STATUSES as readonly number[]).includes(r.status)) return new Error(`${r.error} (${r.code})`);
  return toolRefusalOfAct(r.status as Parameters<typeof toolRefusalOfAct>[0], r.error, { error: r.error, code: r.code, ...(r.detail ?? {}) });
}

export const import_schema_rdfTool: ToolHandler = {
  name: 'import_schema_rdf',
  description: 'Build or extend the type schemas of a space from an RDF file of OWL classes and properties, RDFS and SHACL shapes (Turtle, '
    + 'TriG, N-Quads or JSON-LD, sent inline), without importing data. mode: generate builds a whole schema into a space with no type; expand '
    + 'adds the types and properties that are absent; update also changes the stored values the file states. Nothing is deleted, and a type '
    + 'the file does not name is left as it is; only type schemas are built, never the space\'s purpose, validation mode, strict linkage or '
    + 'rules. Every statement is answered as taken (the field it set) or not taken (why), named up to '
    + `${SCHEMA_RDF_ENTRIES_NAMED_MAX} of each and all counted. A file that contradicts itself, a name collision, an address clash or a `
    + 'reference to a missing library entry refuses the whole file and writes nothing; run with dryRun first to see what it would build. '
    + 'Same as POST /api/spaces/:id/schema-rdf.\n\n'
    + 'COST: needs `schema: write`, for a dry run too, and a file whose shapes give a type rules `schema: admin`. A space in a '
    + 'network is refused: there a schema change is the network\'s to vote on through schema_update, and the refusal '
    + 'carries the proposed types to send there. A caller the REST route would ask for a second factor is refused 403 here, a dry run too: this door has no channel for a code. The space needs RDF switched on. The document is at most the MCP body limit; a larger file '
    + `goes through the REST route. Every refusal carries its code (${SCHEMA_RDF_IMPORT_REFUSAL_CODES.length} of them, listed in the guide's `
    + '"RDF schema import" section).',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      document: { type: 'string', minLength: 1, maxLength: JSON_BODY_MAX_BYTES, description: 'The RDF document itself, as text, in the format named by `format`; read whole before anything is written.' },
      format: { type: 'string', enum: [...RDF_FORMATS], description: 'turtle, trig, nquads or jsonld: the document\'s format (required here; REST reads Content-Type).' },
      mode: { type: 'string', enum: ['generate', 'expand', 'update'], description: 'generate: a whole schema into a space with no type (refused with schema_rdf_not_empty otherwise). expand: add what is absent. update: also change the stored values the file states.' },
      from: {
        type: 'array', minItems: 1, maxItems: SCHEMA_RDF_FROM_DEFAULT.length, items: { type: 'string', enum: ['declared', 'shacl'] },
        description: 'Which declarations to read: declared (OWL and RDFS classes and properties), shacl (shapes). Default: both. A schema inferred '
          + 'from records (data) is not read here: import_rdf with schema and from: data builds it.',
      },
      sourceBase: { type: 'string', minLength: 1, maxLength: RDF_IMPORT_ADDRESS_MAX, description: 'The base of the space the file was exported from, when it is another space: its vocabulary\'s addresses are then read as type and property names, with no address of their own.' },
      sourceVocab: { type: 'string', minLength: 1, maxLength: RDF_IMPORT_ADDRESS_MAX, description: 'The vocabulary of that space, when it is not <sourceBase>vocab/. Needs sourceBase.' },
      dryRun: { type: 'boolean', description: 'true: read, build and check everything, write nothing, and answer what would be built. Default false.' },
    },
    required: ['space', 'document', 'format', 'mode'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    // The second factor, answered honestly and first: this door has no channel for a code, so a caller who would be asked for one on REST (the route's
    // `requireSpaceAuthMfaScoped`, a dry run too) is told where to go, before the document is read or the one-at-a-time slot is taken. The precedent's
    // rule (`network_reread`, `view_copy`), not a third divergence; the tool door (`POST /api/<tool>`) reaches this handler too, so it is closed here.
    const stepUp = mfaStepUpRefusalFor(ctx.callerRecord, 'Building a schema from an RDF file', { route: 'POST /api/spaces/:id/schema-rdf' });
    if (stepUp) throw new ToolRefusal(FORBIDDEN, stepUp);
    const { document, space: _space, ...params } = ctx.args as Record<string, unknown>;
    const caller = ctx.callerRecord ?? { rights: ctx.rights ?? null };
    const answer = await schemaRdfImportAct({
      spaceId: ctx.callSpace, params, body: inlineRdfDocument(typeof document === 'string' ? document : ''), caller,
      rateKey: ctx.rateKey,
    });
    if (answer.kind === 'refused') throw refusalOf(answer);
    ctx.recordChanges?.(answer.audit.before, answer.audit.after);
    return { content: [{ type: 'text' as const, text: JSON.stringify(answer.body) }], structuredContent: { ...answer.body } };
  },
};
