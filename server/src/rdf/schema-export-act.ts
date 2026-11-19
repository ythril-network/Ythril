/**
 * A space's schema exported as OWL and SHACL: the one act `GET /api/spaces/:id/schema-rdf` and MCP `space_schema_rdf` run (Q-751, design
 * r4 §6). Each door only puts the document on its wire.
 *
 * ## What it prevents
 *
 * - **Two doors that differ.** The format (Turtle or JSON-LD, by `format`, then the REST `Accept`, `export-format.ts`), the rung
 *   (`schema: read`), the refusals and their codes, and the document's bytes are decided here.
 * - **Names that are not settled, or a refusal that tells too much.** `rdf-space-state.ts` refuses a space with RDF off and one whose base a
 *   network contests, naming the network only to who may read it.
 * - **More than the space's own words.** The graph is `schemaGraph`'s (slice C) over the resolved meta and the fingerprint every record
 *   names; the instance's library namespaces are handed in so a term under one is the space's own, and a namespace no term of this space
 *   uses is neither declared nor named. The version address it writes is the one each records export names as its shapes graph. No
 *   standard term states the reverse (which data graphs a shapes graph checks), so none is written.
 * - **A silent drop.** A schema value the graph leaves out (`SchemaLeftOut`) is named in the closing comment and the summary.
 */
import type { TokenRights } from '../config/rights-shape.js';
import { getConfig } from '../config/loader.js';
import { holdsRung } from '../auth/reachable-spaces.js';
import { schemaGraph, type SchemaLeftOut } from './schema-owl-shacl.js';
import { createRdfWriter, type RdfFormat } from './serialize.js';
import { chooseRdfFormat, rdfContentDisposition, rdfContentType, RDF_MEDIA_TYPES } from './export-format.js';
import { rdfSpaceState, type RdfCaller } from './rdf-space-state.js';

/** The formats the schema export offers. */
export const RDF_SCHEMA_FORMATS: readonly RdfFormat[] = Object.freeze(['turtle', 'jsonld']);
export const RDF_SCHEMA_RUNG = 'rdf_schema_rung';
/** Every refusal code the schema export answers. */
export const RDF_SCHEMA_REFUSAL_CODES: readonly string[] = Object.freeze(['rdf_bad_format', 'rdf_format_not_acceptable', RDF_SCHEMA_RUNG, 'rdf_not_enabled', 'rdf_base_conflict']);

/** What the schema export says about itself. */
export interface RdfSchemaSummary {
  space: string;
  format: RdfFormat;
  mediaType: string;
  ontology: string;
  version: string;
  fingerprint: string;
  leftOut: SchemaLeftOut[];
}

export type RdfSchemaOutcome =
  | { status: 200; text: string; summary: RdfSchemaSummary; contentType: string; disposition: string; auditChanges: Array<{ field: string; to: string | number }> }
  | { status: 400 | 403 | 406 | 409; error: string; code: string; detail?: Record<string, unknown> };

/** Export the schema of `spaceId`. */
export function rdfSchemaExportAct(input: { spaceId: string; format?: unknown; accept?: string | undefined; caller: RdfCaller | undefined }): RdfSchemaOutcome {
  const { spaceId, caller } = input;
  const rights: TokenRights | null | undefined = caller?.rights;
  if (!rights || (rights.instanceAdmin !== true && !holdsRung(rights, spaceId, 'schema', 'read'))) {
    return { status: 403, error: `Exporting the schema of a space needs schema: read on it, which this token does not hold on '${spaceId}'`, code: RDF_SCHEMA_RUNG };
  }
  const choice = chooseRdfFormat({ format: input.format, accept: input.accept, members: 1, offered: RDF_SCHEMA_FORMATS });
  if (!choice.ok) return { status: choice.status, error: choice.error, code: choice.code, detail: { formats: choice.formats } };
  const cfg = getConfig();
  const state = rdfSpaceState(cfg, spaceId, caller);
  if (!state.ok) return { status: state.status, error: state.error, code: state.code, ...(state.detail ? { detail: state.detail } : {}) };
  const graph = schemaGraph(state.meta, state.fingerprint, { namespaces: Object.values(cfg.schemaLibraryNamespaces ?? {}) });
  const writer = createRdfWriter(choice.format, { prefixes: graph.prefixes });
  const comment = graph.leftOut.length === 0 ? undefined
    : `ythril-schema-export: ${graph.leftOut.length} schema values left out: ${graph.leftOut.map(l => `${l.where} ${l.field} (${l.reason})`).join(', ')}`;
  const text = writer.open() + writer.write({ quads: graph.quads }) + writer.close(comment);
  const summary: RdfSchemaSummary = {
    space: spaceId, format: choice.format, mediaType: RDF_MEDIA_TYPES[choice.format], ontology: graph.ontology, version: graph.version,
    fingerprint: state.fingerprint, leftOut: graph.leftOut,
  };
  return {
    status: 200, text, summary,
    contentType: rdfContentType(choice.format, writer.version),
    disposition: rdfContentDisposition(spaceId, choice.format, '-schema'),
    auditChanges: [{ field: 'format', to: choice.format }, { field: 'fingerprint', to: state.fingerprint }, { field: 'leftOut', to: graph.leftOut.length }],
  };
}
