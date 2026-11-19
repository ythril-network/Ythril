/**
 * MCP `space_schema_rdf` (Q-751): a space's schema as an OWL ontology and SHACL shapes, the tool half of `GET /api/spaces/:id/schema-rdf`.
 * Both run `rdf/schema-export-act.ts`, so the doors take the same parameters and answer the same bytes and refusals. The document is carried
 * once, in the first text block; the summary as JSON in the second and in `structuredContent` (declared by `outputSchema`). Rights come
 * from `TOOL_RIGHTS`: `schema: read`. A personal view is refused by the dispatcher, as for every schema tool.
 */
import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { rdfSchemaExportAct, RDF_SCHEMA_FORMATS, RDF_SCHEMA_REFUSAL_CODES } from '../../rdf/schema-export-act.js';
import { toolRefusalOfAct } from '../../util/errors.js';
import { EXPORT_OK } from '../../export/export-statuses.js';
import { schemaFingerprintOf } from '../../spaces/schema-stamp.js';

export const RDF_SCHEMA_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    space: { type: 'string' }, format: { type: 'string', enum: [...RDF_SCHEMA_FORMATS] }, mediaType: { type: 'string' },
    ontology: { type: 'string' }, version: { type: 'string' }, fingerprint: { type: 'string' },
    leftOut: { type: 'array', items: { type: 'object', properties: { where: { type: 'string' }, field: { type: 'string' }, reason: { type: 'string' } } } },
  },
  required: ['space', 'format', 'mediaType', 'ontology', 'version', 'fingerprint', 'leftOut'],
} as const;

export const space_schema_rdfTool: ToolHandler = {
  name: 'space_schema_rdf',
  description: 'Export the schema of a space as RDF: an OWL ontology (what its own types and properties mean) and SHACL shapes (what its '
    + 'records may hold), in Turtle or JSON-LD. The ontology is `<base>schema`, versioned by the schema fingerprint every record names '
    + '(`version`), and that version address is the shapes graph each `export_rdf` page names: validate an export with these shapes. Every '
    + 'description, name and value rule the schema states reaches the shapes; terms mapped to outside vocabularies get no statement of their '
    + 'own. The document comes back once, in the first text block; the second block and `structuredContent` hold the summary (ontology, '
    + 'version, fingerprint, what was left out). Needs `schema: read`; a personal view has no schema of its own and is refused. The space '
    + `needs RDF switched on and a settled base. Same as GET /api/spaces/:id/schema-rdf. Refusals carry a code: ${RDF_SCHEMA_REFUSAL_CODES.join(', ')}.`,
  mutating: false,
  skipSchemaValidation: true,
  spaceRequired: true,
  outputSchema: RDF_SCHEMA_OUTPUT_SCHEMA,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      format: { type: 'string', enum: [...RDF_SCHEMA_FORMATS], description: 'turtle (the default) or jsonld. Anything else is refused (`rdf_bad_format`).' },
    },
    required: ['space'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const r = rdfSchemaExportAct({
      spaceId: ctx.callSpace, format: ctx.args['format'], caller: ctx.callerRecord ?? { rights: ctx.rights ?? null }, fingerprintOf: schemaFingerprintOf,
    });
    if (r.status !== EXPORT_OK) throw toolRefusalOfAct(r.status, r.error, { error: r.error, code: r.code, ...(r.detail ?? {}) });
    ctx.recordAuditChanges?.(r.auditChanges);
    return {
      content: [{ type: 'text' as const, text: r.text }, { type: 'text' as const, text: JSON.stringify(r.summary) }],
      structuredContent: { ...r.summary },
    };
  },
};
