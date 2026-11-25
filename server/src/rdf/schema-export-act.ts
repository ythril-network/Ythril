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
 *   about that document (its address, and its fragments' `<address>#...`, with the blank nodes they reach), and `formats` names the formats
 *   the door offers. The same `term` answers the ontology (`<base>schema`) and a shape (`<base>schema/shape/<kind>/<type>`, its property
 *   shapes with it); `used` gives a type records use and the schema does not declare its definition (S3b).
 */
import { z } from 'zod';
import { refusalOfParse } from '../util/log.js';
import { EXPORT_OK, EXPORT_BAD_REQUEST, EXPORT_NOT_ACCEPTABLE, EXPORT_CONFLICT } from '../export/export-statuses.js';
import { getConfig } from '../config/loader.js';
import type { KnowledgeType } from '@ythril-network/schema';
import { schemaGraph, usedTypeDefinition, usedPropertiesDefinition, type SchemaLeftOut } from './schema-owl-shacl.js';
import type { TermKind } from './term-iri.js';
import type { Quad, Term } from './literals.js';
import { createRdfWriter, RdfWriteError, type RdfFormat } from './serialize.js';
import { chooseRdfFormat, rdfContentDisposition, rdfContentType, RDF_MEDIA_TYPES, RDF_BAD_FORMAT } from './export-format.js';
import {
  rdfSpaceState, holderOfAddress, RDF_BASE_SHARED, RDF_BASE_NESTED, RDF_UNWRITABLE, RdfUnwritable, unwritableRefusal, type RdfCaller, type FingerprintOf,
} from './rdf-space-state.js';

/** The formats the schema export offers. */
export const RDF_SCHEMA_FORMATS: readonly RdfFormat[] = Object.freeze(['turtle', 'jsonld']);
/** The parameters both doors take (the REST `Accept` header beside them). */
export const RdfSchemaParams = z.object({ format: z.enum(['turtle', 'jsonld']).optional() });
/** Every refusal code the schema export answers. */
export const RDF_SCHEMA_REFUSAL_CODES: readonly string[] = Object.freeze([RDF_BAD_FORMAT, 'rdf_format_not_acceptable', 'rdf_not_enabled', 'rdf_base_conflict', RDF_BASE_SHARED, RDF_BASE_NESTED, 'rdf_term_clash', RDF_UNWRITABLE]);

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

/**
 * Does `subject` speak about the term at `term`: the term itself, or one of its properties (`<term>#<prop>`)? An address's document is the
 * part before its fragment (RFC 3986); a term's address is a document (a vocab holds no `#`), so its properties are the subjects whose
 * document it is.
 */
function aboutTerm(subject: string, term: string): boolean {
  const fragment = subject.indexOf('#');
  return (fragment < 0 ? subject : subject.slice(0, fragment)) === term;
}

/** The blank nodes a term holds: itself, a list's members, a triple term's parts. */
function blanksIn(t: Term, into: string[]): void {
  if (t.kind === 'blank') into.push(t.id);
  else if (t.kind === 'list') for (const item of t.items) blanksIn(item, into);
  else if (t.kind === 'triple') { blanksIn(t.subject, into); blanksIn(t.object, into); }
}

/**
 * The statements about the document `term` (its subjects whose document it is), with every blank node they reach and that node's own
 * statements, so a range, a guard or a rule is answered whole and no answer names a blank node it does not describe. In graph order.
 */
function aboutTermWhole(quads: readonly Quad[], term: string): Quad[] {
  const reached = new Set<string>();
  const queue: string[] = [];
  const reach = (q: Quad): void => {
    const found: string[] = [];
    blanksIn(q.object, found);
    for (const id of found) if (!reached.has(id)) { reached.add(id); queue.push(id); }
  };
  for (const q of quads) if (q.subject.kind === 'iri' && aboutTerm(q.subject.value, term)) reach(q);
  const bySubject = new Map<string, Quad[]>();
  for (const q of quads) {
    if (q.subject.kind !== 'blank') continue;
    const held = bySubject.get(q.subject.id);
    if (held) held.push(q); else bySubject.set(q.subject.id, [q]);
  }
  for (let i = 0; i < queue.length; i++) for (const q of bySubject.get(queue[i]!) ?? []) reach(q);
  return quads.filter(q => (q.subject.kind === 'iri' ? aboutTerm(q.subject.value, term) : reached.has(q.subject.id)));
}

/** A type a record of the space uses, which the door names when it asks for that type's vocab address (`term`). */
export interface UsedType { kind: KnowledgeType; type: string }

/** The properties records of an untyped kind use (the names the door found), which it names when it asks for the kind's own vocab document (`term`). */
export interface UsedProperties { kind: TermKind; names: readonly string[] }

/**
 * Export the schema of `spaceId`: the current one, or the held `version`; whole, or only the statements about `term`. With `used`, the
 * type `term` names that records use: when the schema writes nothing about it (the schema does not declare it), its definition is
 * `usedTypeDefinition`'s, so the vocab address of a type records use always answers (bundle-271, S3b).
 */
export function rdfSchemaExportAct(input: {
  spaceId: string; format?: unknown; accept?: string | undefined; caller: RdfCaller | undefined; fingerprintOf: FingerprintOf;
  version?: SchemaVersionInput; term?: string; formats?: readonly RdfFormat[]; used?: UsedType; usedProperties?: UsedProperties;
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
  let graph = term === undefined ? whole : { ...whole, quads: aboutTermWhole(whole.quads, term) };
  if (term !== undefined && input.used !== undefined && graph.quads.length === 0) {
    const defined = usedTypeDefinition(meta, input.used.kind, input.used.type);
    // Only the type `term` names: a `used` that names another type adds nothing.
    if (defined.every(q => q.subject.kind === 'iri' && q.subject.value === term)) graph = { ...graph, quads: defined };
  }
  if (term !== undefined && input.usedProperties !== undefined && graph.quads.length === 0) {
    // The document of an untyped kind: its properties records use, each a fragment of it (`<term>#<prop>`); a name that is none of the document's adds nothing.
    const defined = usedPropertiesDefinition(meta, input.usedProperties.kind, input.usedProperties.names);
    if (defined.every(q => q.subject.kind === 'iri' && aboutTerm(q.subject.value, term))) graph = { ...graph, quads: defined };
  }
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
