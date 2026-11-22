/**
 * A space's schema built or extended from an RDF file of OWL, RDFS and SHACL, without data: the one act `POST /api/spaces/:id/schema-rdf` and
 * MCP `import_schema_rdf` run (bundle-270, Q-754, design revisions 2 and 3). The data import's schema option (Q-955) calls its shared step,
 * {@link proposeSchemaFromRdf}.
 *
 * ## What it prevents
 *
 * - **Two doors that differ.** Parameters (`SchemaRdfImportParams`, judged before anything else), rungs, bounds, every refusal and its code, and
 *   the answer are decided here; a door reads its body off its wire and puts the answer back on it.
 * - **A schema nobody approved.** The build is written through the settings write act (`space-meta-write-act.ts`), the chain PATCH and
 *   `schema_update` write through, so validation, library references, term clashes, the field rungs (rules need `schema: admin`) and the
 *   import's hold are that chain's and not a copy. Only the types the file changes are sent, in merge mode, with the version the door read as
 *   `ifMatch`: a type the file does not name is never re-sent, and a schema changed while the file was read is refused 412
 *   `schema_rdf_changed` rather than overwritten (challenge F3).
 * - **A dry run that answers unlike the write.** The planner runs for a dry run as well (F2): a refusal the write would meet, the dry run meets.
 * - **A vote round nobody asked for.** A space in a network is refused 409 `schema_rdf_networked`, carrying the dry-run answer (F6) and naming
 *   the doors that do open a round; the write is asked with `refuseIfNetworked`, so a space joined to a network while the file was read is
 *   refused in the step that would apply, and no round opens (F1). This is the one schema write on a networked space that is not a vote.
 * - **A space-level field taken from a file.** Only type schemas are built (amendment A7); the ontology's purpose, validation mode, strict
 *   linkage and rules are named as not taken.
 * - **An unbounded read.** The body is counted against this door's own byte bound and the upload's idle bound, a gzip body against the
 *   reader's ratio and this door's inflated bound, and the quads are collected up to {@link SCHEMA_RDF_MAX_QUADS} and refused 413 past it,
 *   before the mapping runs (F5). One build reads at a time per instance; a second is answered busy, never queued. The answer names at most
 *   {@link SCHEMA_RDF_ENTRIES_NAMED_MAX} statements of each list and counts them all; a refusal's reasons are capped and said through
 *   `peerText`.
 */
import { z } from 'zod';
import type { SpaceMeta, KnowledgeType } from '@ythril-network/schema';
import { getConfig } from '../config/loader.js';
import { peerText, refusalOfParse } from '../util/log.js';
import { isInstanceAdmin } from '../auth/instance-admin.js';
import { describeFieldRequirement } from '../auth/space-field-rights.js';
import { rdfSpaceState, RDF_TERM_CLASH, type RdfCaller } from '../rdf/rdf-space-state.js';
import { RDF_FORMATS, type RdfFormat } from '../rdf/serialize.js';
import { parseRdf } from '../rdf/parse.js';
import { counted, BodyTooLarge, RDF_IMPORT_UPLOAD_IDLE_MS } from '../rdf/import-upload.js';
import {
  RDF_BOUND_EXCEEDED, RDF_UNSUPPORTED_ENCODING, RDF_UNSUPPORTED_FORMAT, RDF_UPLOAD_STALLED, rdfDocumentRefusalOf, rdfFormatOf, rdfParamBool, rdfParamList,
  refusal, type RdfDocumentRefusal,
} from '../rdf/rdf-document.js';
import { addressNames, type SourceNames } from '../rdf/term-reverse.js';
import type { Quad } from '../rdf/literals.js';
import { RDF_IMPORT_REASONS_NAMED_MAX } from '../rdf/import-report.js';
import {
  generateRefusal, schemaFromRdf, SCHEMA_RDF_MAX_QUADS, type SchemaChange, type SchemaFromRdfAnswer, type SchemaMode, type SchemaSource, type TakenEntry,
} from '../rdf/schema-from-rdf.js';
import { meetStored, normalizedStored } from '../rdf/schema-from-rdf-modes.js';
import { Ledger, Store } from '../rdf/schema-from-rdf-store.js';
import type { InferFirst, InferredBlock, InferResult } from '../rdf/schema-from-data.js';
import { schemaFingerprintOf } from './schema-stamp.js';
import { inlineResolvableRefs } from './schema-validation.js';
import { assertSchemaWritable } from './schema-write-gate.js';
import { spaceWriteClosedAnswer } from './space-write-gate.js';
import { planSpaceMetaUpdate, type MetaUpdatePlan, type WriteCaller } from './meta-update.js';
import { writeSpaceMeta, fieldRefusalsOf, SPACE_META_WRITE_NETWORKED } from './space-meta-write-act.js';
import { typesAddedPastCap } from './types-added-past-cap.js';
import { unknownSpaceAnswer, lostSpaceAnswer } from './unknown-space.js';
import { RDF_IMPORT_ADDRESS_MAX } from './rdf-import-files.js';

export { SCHEMA_RDF_MAX_QUADS };

/** The most bytes a schema file's body may hold: a schema of a few thousand types is a few megabytes; the data import's bound is for records. */
export const SCHEMA_RDF_BODY_MAX_BYTES = 33_554_432;
/** How many times the plain bound a gzip schema body may inflate to, so a compressed file is never refused for being compressed. */
const INFLATED_TIMES_PLAIN = 4;
export const SCHEMA_RDF_INFLATED_MAX_BYTES = INFLATED_TIMES_PLAIN * SCHEMA_RDF_BODY_MAX_BYTES;
/** The statements a refusal reason names: a contradiction or collision is between two. */
const STATEMENTS_PER_REASON = 2;
/** The most taken, not-taken and change entries an answer names, each list; the counts are of every entry. */
export const SCHEMA_RDF_ENTRIES_NAMED_MAX = 500;
/** The longest text of one refusal reason an answer repeats (a reason quotes names the file chose). */
const REASON_TEXT_MAX = 300;
/** The names of the bounds a 413 names. */
const BODY_BOUND = 'schemaRdfBodyMaxBytes';
const QUAD_BOUND = 'schemaRdfMaxQuads';

/** The HTTP statuses the act answers with, each named. */
const HTTP = {
  OK: 200, BAD_REQUEST: 400, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, PRECONDITION_FAILED: 412, TOO_LARGE: 413, UNPROCESSABLE: 422,
} as const;

// ── Refusal codes ─────────────────────────────────────────────────────────────────────────────────────────────

export const SCHEMA_RDF_BAD_PARAM = 'schema_rdf_bad_param';
/** A caller below the rung a file with rules needs (`schema: admin`, the settings write's field rungs); `schema: write` is the guard's. */
export const SCHEMA_RDF_RUNG = 'schema_rdf_rung';
export const SCHEMA_RDF_NETWORKED = 'schema_rdf_networked';
export const SCHEMA_RDF_NOT_EMPTY = 'schema_rdf_not_empty';
export const SCHEMA_RDF_BUSY = 'schema_rdf_busy';
export const SCHEMA_RDF_CHANGED = 'schema_rdf_changed';
/** The file's schema refused: a contradiction, a name collision, an invalid type, a type cap, or the planner's verdict; every reason listed. */
export const SCHEMA_RDF_REFUSED = 'schema_rdf_refused';
const SPACE_NOT_FOUND = 'space_not_found';
/** What the door says it did not do because of a document refusal. */
const NOTHING_BUILT = 'no schema was built';

/** Every code either door answers: its own, the document reader's, the space state's, the existence rule's and the import hold's. */
export const SCHEMA_RDF_IMPORT_REFUSAL_CODES: readonly string[] = Object.freeze([
  SCHEMA_RDF_BAD_PARAM, SCHEMA_RDF_RUNG, SCHEMA_RDF_NETWORKED, SCHEMA_RDF_NOT_EMPTY, SCHEMA_RDF_BUSY, SCHEMA_RDF_CHANGED, SCHEMA_RDF_REFUSED,
  RDF_TERM_CLASH, RDF_UNSUPPORTED_FORMAT, RDF_UNSUPPORTED_ENCODING, RDF_UPLOAD_STALLED, RDF_BOUND_EXCEEDED,
  'rdf_malformed', 'rdf_relative_iri', 'rdf_remote_context', 'rdf_jsonld_not_streamable', 'rdf_gzip_invalid', 'rdf_unsupported', 'rdf_source_failed',
  'rdf_not_enabled', 'rdf_base_conflict', 'rdf_base_shared', 'rdf_unwritable', SPACE_NOT_FOUND, 'space_being_rdf_imported',
]);

// ── Parameters ────────────────────────────────────────────────────────────────────────────────────────────────

const MODES = ['generate', 'expand', 'update'] as const;
const SOURCES = ['declared', 'shacl'] as const;
/** What a `from` this door does not take is answered with: the sources it reads, and the door that infers a schema from records. */
export const SCHEMA_RDF_FROM_TEXT = 'from names declared (OWL and RDFS) or shacl (shapes); a schema inferred from the records (data) is built by import_rdf with schema and from: data';
/** What `from` reads when it is not given: the OWL and RDFS declarations and the shapes. */
export const SCHEMA_RDF_FROM_DEFAULT: readonly SchemaSource[] = Object.freeze([...SOURCES]);

/** The parameters both doors take, judged before any logic runs; a door passes only these names. */
export const SchemaRdfImportParams = z.object({
  format: z.enum(RDF_FORMATS as unknown as [RdfFormat, ...RdfFormat[]]).optional(),
  mode: z.enum(MODES),
  // A file without data has no records to infer a schema from: `data` is the data import's (`import_rdf` with `schema` and `from: data`, Q-755).
  from: z.array(z.enum(SOURCES, { error: SCHEMA_RDF_FROM_TEXT })).min(1).max(SOURCES.length).optional(),
  sourceBase: z.string().min(1).max(RDF_IMPORT_ADDRESS_MAX).optional(),
  sourceVocab: z.string().min(1).max(RDF_IMPORT_ADDRESS_MAX).optional(),
  dryRun: z.boolean().optional(),
}).strict().refine(p => p.sourceVocab === undefined || p.sourceBase !== undefined, { message: 'sourceVocab needs sourceBase', path: ['sourceVocab'] });
export type SchemaRdfImportParamsT = z.infer<typeof SchemaRdfImportParams>;

/** A REST query or a tool's arguments as the parameters take them: booleans from their strings, `from` as a list. Only the names are read. */
function paramsOf(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    format: raw['format'], mode: raw['mode'], from: rdfParamList(raw['from']), sourceBase: raw['sourceBase'], sourceVocab: raw['sourceVocab'],
    dryRun: rdfParamBool(raw['dryRun']),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

// ── Test knobs ────────────────────────────────────────────────────────────────────────────────────────────────

interface SchemaRdfImportKnobs {
  bodyMaxBytes?: number;
  uploadIdleMs?: number;
  maxQuads?: number;
  entriesNamedMax?: number;
  hooks?: {
    /** Before the mapping reads the quads (a seam that shows a file over the quad bound never reaches it). */
    beforeMapping?: () => void;
    /** After the planner's verdict and before the write (a seam for a change made to the space meanwhile). Synchronous. */
    beforeWrite?: () => void;
    /** After each name the inference of a data import claims (a seam that counts the spellings it probed). */
    afterNameClaim?: (probes: number) => void;
  };
}
let knobs: SchemaRdfImportKnobs = {};
/** Replace the figures and hooks a test sets, or all of them with `null`. */
export function setSchemaRdfImportKnobsForTest(k: SchemaRdfImportKnobs | null): void { knobs = k ?? {}; }

// ── Answers ───────────────────────────────────────────────────────────────────────────────────────────────────

/** A refusal: its status, our sentence, its code, and what more a caller reads (the shape the RDF document front half declares). */
export type SchemaRdfImportRefusal = RdfDocumentRefusal;

/** The changed types of a proposal, per kind: only the types the file adds or changes. */
export type ChangedTypeSchemas = Partial<Record<KnowledgeType, Record<string, unknown>>>;

/** What the file would make of the space's type schemas: the changed types, the mapping's answer, and the version of the meta it read. */
export interface SchemaProposal {
  kind: 'proposed';
  changed: ChangedTypeSchemas;
  answer: SchemaFromRdfAnswer;
  /** The stored meta's version when the proposal read it: the `ifMatch` its write carries. */
  version: number;
  typesAdded: number;
  typesChanged: number;
  /** A data import that infers its schema (Q-755): what the inference took and named, the pairs it leaves out, the label groups it skips. */
  inferred?: InferredBlock;
  leaveOut?: string[];
  labelKeys?: string[];
}

/** The body both doors answer a build or a dry run with. */
export interface SchemaRdfImportBody {
  space: string; mode: SchemaMode; from: ProposalSource[]; format: RdfFormat; dryRun: boolean; written: boolean; version: number;
  typeSchemas: ChangedTypeSchemas;
  changes: SchemaFromRdfAnswer['changes']; taken: SchemaFromRdfAnswer['taken']; notTaken: SchemaFromRdfAnswer['notTaken'];
  counts: SchemaFromRdfAnswer['counts'] & { changes: number; typesAdded: number; typesChanged: number };
  [notice: string]: unknown;
}

/** A build or a dry run answered: its body and the audit pair the doors hand their audit entry. */
export interface SchemaRdfImportDone {
  kind: 'done'; status: typeof HTTP.OK; body: SchemaRdfImportBody;
  audit: { before: Record<string, unknown>; after: Record<string, unknown> };
}

export type SchemaRdfImportAnswer = SchemaRdfImportDone | SchemaRdfImportRefusal;

/** What a door hands the act. */
export interface SchemaRdfImportInput {
  spaceId: string;
  /** The REST query or the tool's arguments; only the parameters' names are read. */
  params: Record<string, unknown>;
  /** The document: the REST body as it arrives, or the tool's inline text. */
  body: AsyncIterable<Uint8Array | string>;
  contentType?: string;
  contentEncoding?: string;
  /** Who calls: its rights decide the rung, and which networks a refusal may name. */
  caller: (RdfCaller & { id?: string }) | undefined;
  /** The heavy-call allowance's key (the token's id, or the request's address). */
  rateKey: string;
}

// ── The shared step ───────────────────────────────────────────────────────────────────────────────────────────

/** The mapping's refusals as the door's: the file's own contradictions and collisions are 422, a build into a space with types 409. */
function mappingRefusal(answer: SchemaFromRdfAnswer): SchemaRdfImportRefusal {
  const reasons = answer.refusals.slice(0, RDF_IMPORT_REASONS_NAMED_MAX).map(r => ({
    code: r.code, message: peerText(r.message, { max: REASON_TEXT_MAX }), statements: r.statements.slice(0, STATEMENTS_PER_REASON),
  }));
  const detail = { reasons, reasonCount: answer.refusals.length };
  if (answer.refusals.some(r => r.code === 'schema-not-empty')) {
    return refusal(HTTP.CONFLICT, SCHEMA_RDF_NOT_EMPTY, 'generate builds into a space with no type, and this one has types: use expand or update; nothing was written', detail);
  }
  if (answer.refusals.some(r => r.code === 'too-large')) {
    return refusal(HTTP.TOO_LARGE, RDF_BOUND_EXCEEDED, `The file is over the schema reader's bound (${SCHEMA_RDF_MAX_QUADS} statements); ${NOTHING_BUILT}`, { bound: QUAD_BOUND, limit: SCHEMA_RDF_MAX_QUADS });
  }
  return refusal(HTTP.UNPROCESSABLE, SCHEMA_RDF_REFUSED, `The file's schema is refused, each reason with its statements; ${NOTHING_BUILT}`, detail);
}

/** The changed types of `answer`, read from its changes: a type the file does not add to or change is not in it. */
function changedTypesOf(answer: SchemaFromRdfAnswer): { changed: ChangedTypeSchemas; added: number; changedCount: number } {
  const named = new Map<KnowledgeType, Set<string>>();
  const addedKeys = new Set<string>();
  for (const c of answer.changes) {
    if (!named.has(c.kind)) named.set(c.kind, new Set());
    named.get(c.kind)!.add(c.type);
    if (c.change === 'add-type') addedKeys.add(`${c.kind}\u0000${c.type}`);
  }
  const changed: ChangedTypeSchemas = {};
  let total = 0;
  for (const [kind, types] of named) {
    const all = answer.typeSchemas[kind] ?? {};
    // Own properties only, defined (never assigned): a type named like an inherited key is a type like any other.
    changed[kind] = Object.fromEntries([...types].filter(t => Object.hasOwn(all, t)).map(t => [t, all[t]]));
    total += types.size;
  }
  return { changed, added: addedKeys.size, changedCount: total - addedKeys.size };
}

/**
 * What `quads` would make of the type schemas of `spaceId` in `mode`: the types the file adds or changes, the mapping's answer, and the version
 * the stored meta had. The step the data import's schema option (Q-955) calls. Reads the stored schema (its library references resolved) and the
 * space's reverse names; writes nothing. A file the mapping refuses, a `generate` into a space with types, a source address that is not one, and
 * a write that would take a kind past the type cap counting only the types it adds, are answered as refusals.
 */
export async function proposeSchemaFromRdf(
  spaceId: string, quads: Iterable<Quad>, options: { from: readonly SchemaSource[]; mode: SchemaMode; source?: SourceNames; infer?: InferStep },
): Promise<SchemaProposal | SchemaRdfImportRefusal> {
  const space = getConfig().spaces.find(s => s.id === spaceId);
  if (!space) {
    const lost = lostSpaceAnswer(null, spaceId);
    return refusal(lost.status, lost.body.code ?? SPACE_NOT_FOUND, lost.body.error);
  }
  const meta = inlineResolvableRefs((space.meta ?? {}) as SpaceMeta);
  let names;
  try { names = addressNames(meta, options.source); } catch (err) {
    if (err instanceof TypeError) return refusal(HTTP.BAD_REQUEST, SCHEMA_RDF_BAD_PARAM, `sourceBase or sourceVocab: ${err.message}`);
    throw err;
  }
  knobs.hooks?.beforeMapping?.();
  // The mapping meets the types as they are STORED (R2): a type that is a reference to a library entry is kept whole there, and handed its
  // resolved copy it would be rebuilt as a concrete type that replaces the reference. The resolved meta serves the address names alone.
  const stored = space.meta?.typeSchemas ?? {};
  let answer: SchemaFromRdfAnswer;
  if (options.from.length > 0) {
    const read = schemaFromRdf(quads, { from: options.from, mode: options.mode, names, stored });
    if (read.refusals.length > 0) return mappingRefusal(read);
    answer = { ...read, changes: read.changes.map(c => ({ ...c, source: sourceOfChange(c, read.taken, options.from) })) };
  } else {
    // A schema inferred from the data alone reads no declaration: the mapping's own "space has types" question is asked all the same.
    const notEmpty = generateRefusal(options.mode, stored);
    answer = { typeSchemas: normalizedStored(stored), taken: [], notTaken: [], changes: [], refusals: notEmpty ? [notEmpty] : [], counts: { statements: 0, taken: 0, notTaken: 0, outside: 0 } };
    if (notEmpty) return mappingRefusal(answer);
  }
  let inferred: InferResult | undefined;
  if (options.infer) {
    // The inference reads the names after the declared answer, so a declared term is the file's and never inferred again; its types meet that
    // answer in `expand`, so a declared or stored definition stands (Q-755).
    const first = answer;
    const firstNames = addressNames(inlineResolvableRefs({ ...(space.meta ?? {}), typeSchemas: first.typeSchemas } as SpaceMeta), options.source);
    inferred = await options.infer({ typeSchemas: first.typeSchemas, names: firstNames, ...(knobs.hooks?.afterNameClaim ? { onClaim: knobs.hooks.afterNameClaim } : {}) });
    const met = meetStored('expand', inferred.built, first.typeSchemas, new Ledger(new Store([])));
    answer = { ...first, typeSchemas: met.typeSchemas, changes: [...first.changes, ...met.changes.map(c => ({ ...c, source: 'data' as const }))] };
  }
  const { changed, added, changedCount } = changedTypesOf(answer);
  // One cap over the whole proposal: the declared and the inferred types a write adds are counted together.
  const capped = typesAddedPastCap(meta.typeSchemas, changed);
  if (capped) {
    return refusal(HTTP.UNPROCESSABLE, SCHEMA_RDF_REFUSED, `${capped.error} ${NOTHING_BUILT}`, { reasons: [{ code: 'type-cap', message: capped.error }], reasonCount: 1 });
  }
  return {
    kind: 'proposed', changed, answer, version: space.meta?.version ?? 0, typesAdded: added, typesChanged: changedCount,
    ...(inferred ? { inferred: inferred.inferred, leaveOut: inferred.leaveOut, labelKeys: inferred.labelKeys } : {}),
  };
}

/** The inference step a data import hands the proposal: run on the declared answer's types and names (`schema-from-data.ts`). */
export type InferStep = (first: InferFirst) => Promise<InferResult>;

/** Which declarations a change of the declared answer came from: the OWL and RDFS axioms when one of its statements is theirs, else the shapes. */
function sourceOfChange(c: SchemaChange, taken: readonly TakenEntry[], from: readonly SchemaSource[]): 'declared' | 'shacl' {
  const mine = taken.filter(t => t.where.kind === c.kind && t.where.type === c.type && (c.prop === undefined || t.where.prop === c.prop));
  if (mine.some(t => t.source === 'declared')) return 'declared';
  if (mine.some(t => t.source === 'shacl')) return 'shacl';
  return from.includes('declared') ? 'declared' : 'shacl';
}

// ── The door ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A door is reading a schema file: one at a time, instance-wide, from before the first byte until it answered. */
let doorHeld = false;

/** The settings write's body for a proposal: only the changed types, merged over the stored ones. */
const writeBodyOf = (p: SchemaProposal): Record<string, unknown> => ({ meta: { typeSchemas: p.changed }, typeSchemasMode: 'merge' });

/** A refusal of the planner or of the settings write, as the door's (`proposed` is carried on a networked refusal). */
function chainRefusal(status: number, body: { error: string; code?: string }, proposed: SchemaRdfImportBody): SchemaRdfImportRefusal {
  if (status === HTTP.PRECONDITION_FAILED) {
    return refusal(HTTP.PRECONDITION_FAILED, SCHEMA_RDF_CHANGED, `The space's schema changed while the file was read; ${NOTHING_BUILT}: send the file again`);
  }
  if (body.code === SPACE_META_WRITE_NETWORKED) return networkedRefusal(proposed);
  if (body.code === RDF_TERM_CLASH) return refusal(HTTP.UNPROCESSABLE, RDF_TERM_CLASH, `${peerText(body.error, { max: REASON_TEXT_MAX })}; ${NOTHING_BUILT}`);
  const closed = status === HTTP.CONFLICT && typeof body.code === 'string' ? body : null;
  if (closed) return refusal(status, closed.code!, closed.error);
  return refusal(HTTP.UNPROCESSABLE, SCHEMA_RDF_REFUSED, `The schema the file builds is refused by the space's rules; ${NOTHING_BUILT}`, {
    reasons: [{ code: body.code ?? 'invalid-schema', message: peerText(body.error, { max: REASON_TEXT_MAX }) }], reasonCount: 1,
  });
}

/** The refusal of a caller whose rungs do not reach `fields` of the settings write (a type's rules need `schema: admin`). */
function rungRefusal(fields: readonly string[]): SchemaRdfImportRefusal {
  return refusal(HTTP.FORBIDDEN, SCHEMA_RDF_RUNG, `Not allowed to change ${fields.map(describeFieldRequirement).join(', ')}: ${NOTHING_BUILT}`);
}

function networkedRefusal(proposed: SchemaRdfImportBody): SchemaRdfImportRefusal {
  return refusal(HTTP.CONFLICT, SCHEMA_RDF_NETWORKED,
    `Space '${proposed.space}' is in a network, where a schema change is the network's to vote on and this door opens no vote: `
    + 'send the proposed types (in proposed.typeSchemas) through PATCH /api/spaces/:id or schema_update; nothing was written', { proposed });
}

/** The audit pair: the planner's snapshot on a build, nothing of the schema on a dry run; the counts and flags on both, never a value of the file. */
function auditOf(body: SchemaRdfImportBody, plan: MetaUpdatePlan['audit'] | null): SchemaRdfImportDone['audit'] {
  const facts = {
    dryRun: body.dryRun, format: body.format, mode: body.mode, statements: body.counts.statements, taken: body.counts.taken,
    notTaken: body.counts.notTaken, typesAdded: body.counts.typesAdded, typesChanged: body.counts.typesChanged,
  };
  return plan ? { before: { ...plan.before }, after: { ...plan.after, ...facts } } : { before: {}, after: facts };
}

/** The body of a proposal, its lists capped: what a door answers, and what a networked refusal carries as `proposed`. */
export function proposedBodyOf(
  spaceId: string, how: { mode: SchemaMode; dryRun: boolean }, from: ProposalSource[], format: RdfFormat, proposal: SchemaProposal,
): SchemaRdfImportBody {
  const max = knobs.entriesNamedMax ?? SCHEMA_RDF_ENTRIES_NAMED_MAX;
  const a = proposal.answer;
  return {
    space: spaceId, mode: how.mode, from, format, dryRun: how.dryRun, written: false, version: proposal.version,
    typeSchemas: proposal.changed, changes: a.changes.slice(0, max), taken: a.taken.slice(0, max), notTaken: a.notTaken.slice(0, max),
    counts: { ...a.counts, changes: a.changes.length, typesAdded: proposal.typesAdded, typesChanged: proposal.typesChanged },
    ...(proposal.inferred ? { inferred: proposal.inferred } : {}),
  };
}

/** What a proposal is read from: the declarations a file states, and for a data import the records themselves (`data`, Q-755). */
export type ProposalSource = SchemaSource | 'data';

/** The caller as the planner and the notices read it: its id, rights and legacy admin flag, nothing else. */
function writeCallerOf(caller: SchemaRdfImportInput['caller']): WriteCaller {
  if (!caller) return {};
  return { ...(caller.id ? { id: caller.id } : {}), ...(caller.rights ? { rights: caller.rights } : {}) };
}

/** A proposal the write would take: the type schemas the space holds after it (stored form, `$ref`s kept), and its whole merged meta. */
export interface JudgedProposal {
  kind: 'judged';
  /** What the space's type schemas are after the write: the planner's merge, or the mapping's own on a space whose write would be a vote. */
  merged: SpaceMeta['typeSchemas'];
  /** The planner's merged meta, from which the stored schema's fingerprint after the write is read; `undefined` where the write would be a vote. */
  mergedMeta: SpaceMeta | undefined;
}

/**
 * Judge `proposal` as its write would, without writing: the field rungs first (a file whose shapes give a type rules needs `schema: admin`), asked
 * by the write act's one function, then the planner's verdict. The step the schema door and the data import's schema option (Q-955) share, so a
 * dry run of either is refused what its write is refused. `proposed` is the body a networked refusal carries.
 */
export function judgeSchemaProposal(
  spaceId: string, proposal: SchemaProposal, caller: SchemaRdfImportInput['caller'], proposed: () => SchemaRdfImportBody,
): JudgedProposal | SchemaRdfImportRefusal {
  const instanceAdmin = !!caller && isInstanceAdmin(caller);
  const fields = fieldRefusalsOf(spaceId, writeBodyOf(proposal), { rights: caller?.rights, instanceAdmin });
  if (fields.length > 0) return rungRefusal(fields);
  const space = getConfig().spaces.find(s => s.id === spaceId);
  const verdict = planSpaceMetaUpdate({ spaceId, space, body: writeBodyOf(proposal), ifMatch: String(proposal.version), caller: writeCallerOf(caller) });
  if (!verdict.ok) return chainRefusal(verdict.refusal.status, verdict.refusal.body as { error: string; code?: string }, proposed());
  const mergedMeta = verdict.plan.mergedMeta as SpaceMeta | undefined;
  const merged = (mergedMeta?.typeSchemas ?? proposal.answer.typeSchemas) as SpaceMeta['typeSchemas'];
  return { kind: 'judged', merged: structuredClone(merged), mergedMeta };
}

/** A proposal written: the outcome's version, the audit pair the planner took, and the notices a PATCH of the same change answers. */
export interface WrittenProposal { kind: 'written'; version: number; audit: MetaUpdatePlan['audit']; notice: Record<string, unknown> }

/**
 * Write `proposal` through the settings write act, with the version it read as `ifMatch` and a networked space refused rather than voted on.
 * Every answer of the write other than an applied one is a refusal with the schema door's codes: the rungs (`schema_rdf_rung`), a lost space,
 * a moved version (`schema_rdf_changed`), a networked space or an outcome that is not applied (`schema_rdf_networked`), the hold, the planner.
 * A caller cannot leave an answer unmapped: there is no other way out of this function.
 */
export async function writeSchemaProposal(input: {
  spaceId: string; proposal: SchemaProposal; caller: SchemaRdfImportInput['caller']; rateKey: string; proposed: () => SchemaRdfImportBody;
}): Promise<WrittenProposal | SchemaRdfImportRefusal> {
  const { spaceId, proposal, caller } = input;
  const instanceAdmin = !!caller && isInstanceAdmin(caller);
  const written = await writeSpaceMeta({
    spaceId, body: writeBodyOf(proposal), ifMatch: String(proposal.version),
    caller: { record: writeCallerOf(caller), rights: caller?.rights, instanceAdmin },
    rateKey: input.rateKey, refuseIfNetworked: true,
  });
  if (written.kind === 'fields-refused') return rungRefusal(written.fields);
  if (written.kind === 'lost') {
    const lost = lostSpaceAnswer(null, spaceId);
    return refusal(lost.status, lost.body.code ?? SPACE_NOT_FOUND, lost.body.error);
  }
  if (written.kind === 'refused') return chainRefusal(written.status, written.body, input.proposed());
  if (written.outcome.outcome !== 'applied') return networkedRefusal(input.proposed());
  return { kind: 'written', version: written.outcome.space.meta?.version ?? proposal.version, audit: written.audit, notice: written.notice };
}

/**
 * Build or dry-run a schema from an RDF file for a door. Never throws for a caller's mistake or the space's state: every refusal is an answer.
 * A fault that is neither (the store, the disk) is thrown to the door.
 */
export async function schemaRdfImportAct(input: SchemaRdfImportInput): Promise<SchemaRdfImportAnswer> {
  const parsed = SchemaRdfImportParams.safeParse(paramsOf(input.params));
  if (!parsed.success) return refusal(HTTP.BAD_REQUEST, SCHEMA_RDF_BAD_PARAM, refusalOfParse(parsed.error).error);
  const p = parsed.data;
  const dryRun = p.dryRun === true;
  const cfg = getConfig();
  const unknown = unknownSpaceAnswer(null, input.spaceId, false, cfg);
  if (unknown) return refusal(unknown.status, unknown.body.code ?? SPACE_NOT_FOUND, unknown.body.error);
  // The rung (`schema: write`, a dry run too, amendment A10) is the doors' guard's: the route's `ROUTE_RIGHTS` row and the tool's
  // `TOOL_RIGHTS` row. The settings write's field rungs raise a file with rules to `admin` (`schema_rdf_rung` below).
  const state = rdfSpaceState(cfg, input.spaceId, input.caller, schemaFingerprintOf);
  if (!state.ok) return refusal(state.status, state.code, state.error, state.detail);
  // The import's hold, asked on every path before a byte is read: a dry run would answer by a schema the import may yet see change.
  try { assertSchemaWritable(input.spaceId); } catch (err) {
    const closed = spaceWriteClosedAnswer(err);
    if (!closed) throw err;
    return refusal(closed.status, closed.body.code, closed.body.error);
  }
  if (p.mode === 'generate' && Object.values(state.meta.typeSchemas ?? {}).some(m => m && Object.keys(m).length > 0)) {
    return refusal(HTTP.CONFLICT, SCHEMA_RDF_NOT_EMPTY, 'generate builds into a space with no type, and this one has types: use expand or update; nothing was written');
  }
  const read = rdfFormatOf(p.format, input.contentType, input.contentEncoding, 'the schema import');
  if (!read.ok) return read.refusal;
  if (doorHeld) return refusal(HTTP.CONFLICT, SCHEMA_RDF_BUSY, 'Another schema file is being read on this instance: try again when it has been answered');
  doorHeld = true;
  try {
    return await readAndBuild(input, p, dryRun, read.format);
  } finally {
    doorHeld = false;
  }
}

/** The quads of the body, collected up to the quad bound; `null` past it. */
async function quadsWithin(input: SchemaRdfImportInput, format: RdfFormat, max: number): Promise<Quad[] | null> {
  const body = counted(input.body, knobs.bodyMaxBytes ?? SCHEMA_RDF_BODY_MAX_BYTES, knobs.uploadIdleMs ?? RDF_IMPORT_UPLOAD_IDLE_MS);
  const held: Quad[] = [];
  for await (const q of parseRdf(body, format, { bounds: { maxInflatedBytes: SCHEMA_RDF_INFLATED_MAX_BYTES } })) {
    held.push(q);
    if (held.length > max) return null;
  }
  return held;
}

/** The body read under the bounds, the proposal, the planner's verdict, then the dry answer, the networked refusal or the write. */
async function readAndBuild(input: SchemaRdfImportInput, p: SchemaRdfImportParamsT, dryRun: boolean, format: RdfFormat): Promise<SchemaRdfImportAnswer> {
  const maxQuads = knobs.maxQuads ?? SCHEMA_RDF_MAX_QUADS;
  let quads: Quad[] | null;
  try {
    quads = await quadsWithin(input, format, maxQuads);
  } catch (err) {
    if (err instanceof BodyTooLarge) {
      return refusal(HTTP.TOO_LARGE, RDF_BOUND_EXCEEDED, `The body is over the schema import's byte bound (${err.limit} bytes); ${NOTHING_BUILT}`, { bound: BODY_BOUND, limit: err.limit });
    }
    const answer = rdfDocumentRefusalOf(err, format, NOTHING_BUILT);
    if (answer) return answer;
    throw err;
  }
  if (quads === null) {
    return refusal(HTTP.TOO_LARGE, RDF_BOUND_EXCEEDED, `The file holds more than ${maxQuads} statements, the most a schema file may hold; ${NOTHING_BUILT}`, { bound: QUAD_BOUND, limit: maxQuads });
  }
  const from = [...(p.from ?? SCHEMA_RDF_FROM_DEFAULT)];
  const source: SourceNames | undefined = p.sourceBase === undefined ? undefined : { base: p.sourceBase, ...(p.sourceVocab !== undefined ? { vocab: p.sourceVocab } : {}) };
  const proposal = await proposeSchemaFromRdf(input.spaceId, quads, { from, mode: p.mode, ...(source ? { source } : {}) });
  if (proposal.kind === 'refused') return proposal;
  const proposed = proposedBodyOf(input.spaceId, { mode: p.mode, dryRun }, from, format, proposal);

  // What the write would refuse, the dry run refuses (the shared judgement: the field rungs, then the planner's verdict).
  const judged = judgeSchemaProposal(input.spaceId, proposal, input.caller, () => proposed);
  if (judged.kind === 'refused') return judged;
  // A dry run writes nothing, and a build that changes nothing writes nothing either (R3): a write raises the version and pushes a history
  // snapshot, and a space in a network would be refused for a vote that has nothing to carry. Whether the space is in a network is asked once,
  // by the settings write below (`refuseIfNetworked`), whose refusal `chainRefusal` answers with the proposal.
  if (dryRun || proposal.answer.changes.length === 0) return { kind: 'done', status: HTTP.OK, body: proposed, audit: auditOf(proposed, null) };

  knobs.hooks?.beforeWrite?.();
  const written = await writeSchemaProposal({ spaceId: input.spaceId, proposal, caller: input.caller, rateKey: input.rateKey, proposed: () => proposed });
  if (written.kind === 'refused') return written;
  const body: SchemaRdfImportBody = { ...proposed, written: true, version: written.version, ...written.notice };
  return { kind: 'done', status: HTTP.OK, body, audit: auditOf(body, written.audit) };
}
