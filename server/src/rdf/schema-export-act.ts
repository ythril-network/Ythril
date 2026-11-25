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
 * - **A second site that builds or writes a schema graph** (bundle-271, Q-758, r2 R1.4 [M3]). The Linked Data addresses of a schema version
 *   (`/ld/<space>/schema/<fp>`) and of a vocabulary term (`/ld/<space>/vocab/...`) are answered by this act: `version` builds the graph of a
 *   held version (its types and rules, under the space's current RDF names) in place of the current one, `term` keeps only the statements
 *   about that term (its address, and its properties' `<address>#...`), and `formats` names the formats the door offers.
 */
import { z } from 'zod';
import { refusalOfParse } from '../util/log.js';
import { EXPORT_OK, EXPORT_BAD_REQUEST, EXPORT_NOT_ACCEPTABLE, EXPORT_CONFLICT } from '../export/export-statuses.js';
import { getConfig } from '../config/loader.js';
import { schemaGraph, type SchemaLeftOut } from './schema-owl-shacl.js';
import { createRdfWriter, RdfWriteError, type RdfFormat } from './serialize.js';
import { chooseRdfFormat, rdfContentDisposition, rdfContentType, RDF_MEDIA_TYPES, RDF_BAD_FORMAT } from './export-format.js';
import {
  rdfSpaceState, holderOfAddress, RDF_BASE_SHARED, RDF_UNWRITABLE, RdfUnwritable, unwritableRefusal, type RdfCaller, type FingerprintOf,
} from './rdf-space-state.js';

/** The formats the schema export offers. */
export const RDF_SCHEMA_FORMATS: readonly RdfFormat[] = Object.freeze(['turtle', 'jsonld']);
/** The parameters both doors take (the REST `Accept` header beside them). */
export const RdfSchemaParams = z.object({ format: z.enum(['turtle', 'jsonld']).optional() });
/** Every refusal code the schema export answers. */
export const RDF_SCHEMA_REFUSAL_CODES: readonly string[] = Object.freeze([RDF_BAD_FORMAT, 'rdf_format_not_acceptable', 'rdf_not_enabled', 'rdf_base_conflict', RDF_BASE_SHARED, 'rdf_term_clash', RDF_UNWRITABLE]);

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
  | {
    status: typeof EXPORT_OK; text: string; summary: RdfSchemaSummary; contentType: string; disposition: string;
    auditChanges: Array<{ field: string; to: string | number }>;
    /** The statements written (after `term` kept its own). */
    statements: number;
  }
  | { status: typeof EXPORT_BAD_REQUEST | typeof EXPORT_NOT_ACCEPTABLE | typeof EXPORT_CONFLICT; error: string; code: string; detail?: Record<string, unknown> };

/** A held schema version: its fingerprint and the schema it holds (`versionMetaOf`), built under the space's current RDF names. */
export interface SchemaVersionInput { fingerprint: string; typeSchemas: Record<string, unknown>; rules: Record<string, unknown> }

/** Does `subject` speak about the term at `term`: the term itself, or one of its properties (`<term>#<prop>`)? */
const aboutTerm = (subject: string, term: string): boolean => subject === term || subject.startsWith(`${term}#`);

/** Export the schema of `spaceId`: the current one, or the held `version`; whole, or only the statements about `term`. */
export function rdfSchemaExportAct(input: {
  spaceId: string; format?: unknown; accept?: string | undefined; caller: RdfCaller | undefined; fingerprintOf: FingerprintOf;
  version?: SchemaVersionInput; term?: string; formats?: readonly RdfFormat[];
}): RdfSchemaOutcome {
  // The rung (`schema: read`) is asked before this act on every door: the route's guard and the dispatcher answer a token without it.
  const { spaceId, caller } = input;
  const parsed = RdfSchemaParams.safeParse({ format: input.format });
  if (!parsed.success) return { status: EXPORT_BAD_REQUEST, error: refusalOfParse(parsed.error).error, code: RDF_BAD_FORMAT };
  const choice = chooseRdfFormat({ format: parsed.data.format, accept: input.accept, members: 1, offered: input.formats ?? RDF_SCHEMA_FORMATS });
  if (!choice.ok) return { status: choice.status, error: choice.error, code: choice.code, detail: { formats: choice.formats } };
  const cfg = getConfig();
  const state = rdfSpaceState(cfg, spaceId, caller, input.fingerprintOf);
  if (!state.ok) return { status: state.status, error: state.error, code: state.code, ...(state.detail ? { detail: state.detail } : {}) };
  const meta = input.version ? { ...state.meta, typeSchemas: input.version.typeSchemas, rules: input.version.rules } as typeof state.meta : state.meta;
  const fingerprint = input.version?.fingerprint ?? state.fingerprint;
  const whole = schemaGraph(meta, fingerprint, { namespaces: Object.values(cfg.schemaLibraryNamespaces ?? {}) });
  const term = input.term;
  const graph = term === undefined ? whole
    : { ...whole, quads: whole.quads.filter(q => q.subject.kind === 'iri' && aboutTerm(q.subject.value, term)) };
  const comment = graph.leftOut.length === 0 ? undefined
    : `ythril-schema-export: ${graph.leftOut.length} schema values left out: ${graph.leftOut.map(l => `${l.where} ${l.field} (${l.reason})`).join(', ')}`;
  let writer: ReturnType<typeof createRdfWriter>;
  let text: string;
  try {
    writer = createRdfWriter(choice.format, { prefixes: graph.prefixes });
    text = writer.open() + writer.write({ quads: graph.quads }) + writer.close(comment);
  } catch (err) {
    if (!(err instanceof RdfWriteError)) throw err;
    return unwritableRefusal(new RdfUnwritable(holderOfAddress(state.meta, err.value), err.value));
  }
  const summary: RdfSchemaSummary = {
    space: spaceId, format: choice.format, mediaType: RDF_MEDIA_TYPES[choice.format], ontology: graph.ontology, version: graph.version,
    fingerprint, leftOut: graph.leftOut,
  };
  return {
    status: EXPORT_OK, text, summary,
    contentType: rdfContentType(choice.format, writer.version),
    disposition: rdfContentDisposition(spaceId, choice.format, '-schema'),
    auditChanges: [{ field: 'format', to: choice.format }, { field: 'fingerprint', to: fingerprint }, { field: 'leftOut', to: graph.leftOut.length }],
    statements: graph.quads.length,
  };
}
