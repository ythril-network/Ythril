/**
 * The schema step of an RDF data import with `schema` set (bundle-270, Q-955): the door's half (the file's schema groups, the proposal, its
 * judgement) and the act's half (the one write, from inside the act, after the data passed). Kept out of `rdf-import-act.ts`, which runs it.
 *
 * ## What it prevents
 *
 * - **A schema left behind by a refused import.** The door only proposes and judges (the schema door's shared step: `proposeSchemaFromRdf`,
 *   `judgeSchemaProposal`); nothing is written before the act's dry plan judged every record by the proposed schema. The act then writes it once
 *   through the settings write act (`writeSchemaProposal`), whose every answer but an applied one is a refusal with the schema door's code, so the
 *   act ends with nothing written and is never left owed by a refusal.
 * - **A write by a caller who lost the right.** The act reads the caller's token again by its id before the write: a token revoked, expired or
 *   narrowed below `schema: write` meanwhile ends the act `403 schema_rdf_rung`.
 * - **Records stamped by a schema the space does not hold.** After the write the stored schema's fingerprint must be the one the proposal gave;
 *   only then do the planners judge and stamp by the stored schema. A resume that finds it already stored writes nothing again.
 * - **An unbounded read.** The schema groups are collected up to the schema door's quad bound (`413 rdf_bound_exceeded`, `schemaRdfMaxQuads`)
 *   before anything maps them; a refusal naming graphs names at most `RDF_IMPORT_GRAPH_BASES_MAX` of them, each as capped peer text.
 */
import type { SpaceMeta } from '@ythril-network/schema';
import { getConfig } from '../config/loader.js';
import { peerText } from '../util/log.js';
import { isInstanceAdmin } from '../auth/instance-admin.js';
import { effectiveRung } from '../auth/mint-cap.js';
import { satisfies } from '../auth/required-rung.js';
import type { RdfCaller } from '../rdf/rdf-space-state.js';
import { refusal, type RdfDocumentRefusal } from '../rdf/rdf-document.js';
import { quadGroupKey, type ImportFolder, type QuadGroup } from '../rdf/import-spool.js';
import { schemaGroupsOf, SCHEMA_RDF_MAX_QUADS, type SchemaMode, type SchemaSource } from '../rdf/schema-from-rdf.js';
import { isMissingPath } from '../util/path-present.js';
import { schemaFingerprintOf } from './schema-stamp.js';
import { inlineResolvableRefs } from './schema-validation.js';
import {
  RDF_IMPORT_ADDRESS_MAX, defineRdfImportSchemaStep, readSchemaStep, writeSchemaStep, type ActState, type DoorSchema, type ImportOptions, type SchemaAsked,
  type SchemaStepDone, type SchemaStepEnd, type SchemaStepFile,
} from './rdf-import-files.js';
import {
  proposeSchemaFromRdf, judgeSchemaProposal, writeSchemaProposal, proposedBodyOf, SCHEMA_RDF_FROM_DEFAULT, SCHEMA_RDF_CHANGED, SCHEMA_RDF_RUNG,
  type SchemaProposal,
} from './schema-rdf-import-act.js';

/** The statuses this step answers with, each named. */
const HTTP = { BAD_REQUEST: 400, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, TOO_LARGE: 413, UNPROCESSABLE: 422 } as const;
/** The import's own codes this step answers (`RDF_IMPORT_*` in `rdf-import-act.ts`, which lists them). */
const BAD_PARAM = 'rdf_import_bad_param';
const SCHEMA_NOT_AVAILABLE = 'rdf_import_schema_not_available';
const SPACE_CHANGED = 'rdf_import_space_changed';
const STATE_UNREADABLE = 'rdf_import_state_unreadable';
/** The import's code for graphs read under several source bases (its own, `RDF_IMPORT_SEVERAL_GRAPHS`). */
const SEVERAL_GRAPHS = 'rdf_import_several_graphs';
const BOUND_EXCEEDED = 'rdf_bound_exceeded';
/** The name of the bound a schema option's 413 names (the schema door's own). */
const SCHEMA_QUAD_BOUND = 'schemaRdfMaxQuads';
/** The most graph addresses a refusal names (the import's `RDF_IMPORT_GRAPH_BASES_MAX`). */
const GRAPHS_NAMED_MAX = 64;
/** The most type names a report's schema step names of each list (all are counted). */
const SCHEMA_TYPES_NAMED_MAX = 500;

/** The fingerprint and the meta version stored for `spaceId` now. */
export const storedFingerprint = (spaceId: string): string => schemaFingerprintOf(getConfig().spaces.find(s => s.id === spaceId));
export const storedVersion = (spaceId: string): number => getConfig().spaces.find(s => s.id === spaceId)?.meta?.version ?? 0;
/** The group key of a blank node in its graph: the sorted spool's own. */
export const blankGroupKey = (id: string, graph: { value: string } | undefined): string =>
  quadGroupKey({ kind: 'blank', id }, graph ? { kind: 'iri', value: graph.value } : undefined);

/**
 * The refusal of a caller below `schema: write` on `spaceId`, or null: an import with `schema` set writes the space's type schemas, which the
 * settings write's field rungs price at `schema: write` (rules at `admin`, asked by the shared judgement). Asked at the door before a byte is read,
 * a dry run too (A10), and again by the act before its write, with the token read again.
 */
export function schemaRungRefusal(spaceId: string, caller: RdfCaller | undefined): RdfDocumentRefusal | null {
  if (caller && isInstanceAdmin(caller)) return null;
  if (caller?.rights && satisfies(effectiveRung(caller.rights, spaceId, 'schema'), 'write')) return null;
  return refusal(HTTP.FORBIDDEN, SCHEMA_RDF_RUNG, `Token needs 'write' on schema in space '${peerText(spaceId, { max: RDF_IMPORT_ADDRESS_MAX })}' to build a schema from the file (schema: write); nothing was imported`);
}

/** The caller as an act with a schema step keeps it: its id (and whether that is a stored token's), its rights, its legacy admin flag. */
export function callerSnapshotOf(caller: RdfCaller | undefined): NonNullable<ActState['caller']> {
  const id = caller?.id;
  return {
    ...(id !== undefined ? { id } : {}), ...(caller?.rights !== undefined ? { rights: caller.rights } : {}),
    stored: id !== undefined && getConfig().tokens.some(t => t.id === id),
  };
}

/**
 * The caller of an act with a schema step as it is now: a stored token read again by its id (`null` when it is gone or expired, so a revoked
 * token writes nothing after a resume), else the door's snapshot (a session that is no stored token).
 */
function callerNow(snapshot: ActState['caller']): RdfCaller | null {
  if (!snapshot) return null;
  if (!snapshot.stored || snapshot.id === undefined) return { ...snapshot };
  const token = getConfig().tokens.find(t => t.id === snapshot.id) as { id: string; rights?: RdfCaller['rights']; expiresAt?: string | null } | undefined;
  if (!token || (token.expiresAt && Date.parse(token.expiresAt) <= Date.now())) return null;
  return { id: token.id, rights: token.rights ?? null };
}

/** The `kind:type` names of the types `proposal` adds, and of those it changes. */
function typeNamesOf(proposal: SchemaProposal): { added: string[]; changed: string[] } {
  const added = new Set<string>();
  const all = new Set<string>();
  for (const c of proposal.answer.changes) {
    const name = `${c.kind}:${c.type}`;
    all.add(name);
    if (c.change === 'add-type') added.add(name);
  }
  return { added: [...added], changed: [...all].filter(n => !added.has(n)) };
}

/**
 * The door's half of the schema option: the file's schema groups collected within the schema door's quad bound (413 past it, before the
 * mapping), the proposal made under the file's one source base, and judged as its write would be (the rungs, the planner). Whether the space is
 * in a network is not asked here: the act's write asks it, in the step that applies (`refuseIfNetworked`), and its refusal carries the proposal;
 * a dry run, which writes nothing, is answered on a networked space as anywhere.
 */
export async function schemaAtDoor(input: {
  spaceId: string; caller: RdfCaller | undefined; options: ImportOptions; groups: () => AsyncGenerator<QuadGroup, void, undefined>; schema: SchemaAsked;
  dryRun: boolean; maxQuads: number | undefined;
}): Promise<DoorSchema | RdfDocumentRefusal> {
  const { spaceId, options, schema } = input;
  const bases = new Set(Object.values(options.graphBases));
  if (options.source) bases.add(options.source.base);
  if (bases.size > 1) {
    return refusal(HTTP.BAD_REQUEST, SEVERAL_GRAPHS, `schema: the file's graphs are read under ${bases.size} source bases, and a schema is built under one: `
      + 'import its schema with one base, or one graph at a time; nothing was imported', {
      graphBases: Object.keys(options.graphBases).slice(0, GRAPHS_NAMED_MAX).map(g => peerText(g, { max: RDF_IMPORT_ADDRESS_MAX })),
    });
  }
  const max = input.maxQuads ?? SCHEMA_RDF_MAX_QUADS;
  const found = await schemaGroupsOf(input.groups, blankGroupKey, max);
  if (found.kind === 'over') {
    return refusal(HTTP.TOO_LARGE, BOUND_EXCEEDED, `The file holds more than ${max} schema statements, the most a schema holds; nothing was imported`, { bound: SCHEMA_QUAD_BOUND, limit: max });
  }
  const proposal = proposeSchemaFromRdf(spaceId, found.quads, { from: schema.from, mode: schema.mode, ...(options.source ? { source: options.source } : {}) });
  if (proposal.kind === 'refused') return proposal;
  const proposed = (): ReturnType<typeof proposedBodyOf> => proposedBodyOf(spaceId, { mode: schema.mode, dryRun: input.dryRun }, schema.from, options.format, proposal);
  const judged = judgeSchemaProposal(spaceId, proposal, input.caller, proposed);
  if (judged.kind === 'refused') return judged;
  const names = typeNamesOf(proposal);
  return {
    kind: 'built', changed: proposal.changed as DoorSchema['changed'], version: proposal.version, changes: proposal.answer.changes.length,
    merged: judged.merged, keys: found.keys,
    report: {
      typesAdded: names.added.slice(0, SCHEMA_TYPES_NAMED_MAX), typesChanged: names.changed.slice(0, SCHEMA_TYPES_NAMED_MAX),
      typesAddedCount: names.added.length, typesChangedCount: names.changed.length,
      fingerprintBefore: storedFingerprint(spaceId),
      fingerprintAfter: judged.mergedMeta ? schemaFingerprintOf({ meta: judged.mergedMeta }) : storedFingerprint(spaceId),
      notice: {},
    },
  };
}

/**
 * What a door's `schema` and `from` ask for, or the refusal of a pair the import does not take: `from` without `schema` (or with `none`), and
 * `from: data` (a schema inferred from the records, not available yet). `null`: an import of data alone, as it always was.
 */
export function schemaAskedOf(schema: string | undefined, from: readonly string[] | undefined): SchemaAsked | null | RdfDocumentRefusal {
  if (schema === undefined || schema === 'none') {
    return from === undefined ? null : refusal(HTTP.BAD_REQUEST, BAD_PARAM, 'from: names what a schema is read from, and is sent with schema (generate, expand or update); leave it out to import the data alone');
  }
  if (from?.includes('data')) {
    return refusal(HTTP.BAD_REQUEST, SCHEMA_NOT_AVAILABLE, 'from: data: a schema read from the records themselves is not available yet; read it from the file\'s classes and shapes (from: declared, shacl, the default)');
  }
  return { kind: 'asked', mode: schema as SchemaMode, from: [...(from ?? SCHEMA_RDF_FROM_DEFAULT)] as SchemaSource[] };
}

/** What the door keeps of a built schema: its file beside the spool, and the state's fields (the version, the fingerprint after, the caller). */
export async function keepSchemaStep(folder: ImportFolder, built: DoorSchema, caller: RdfCaller | undefined): Promise<Pick<ActState, 'schemaStep' | 'caller'>> {
  const { report } = built;
  await writeSchemaStep(folder, {
    changed: built.changed, merged: built.merged, typesAdded: report.typesAdded, typesChanged: report.typesChanged, fingerprintBefore: report.fingerprintBefore,
  });
  return {
    schemaStep: { version: built.version, fingerprint: report.fingerprintAfter, changes: built.changes },
    caller: callerSnapshotOf(caller),
  };
}

/** The schema step an act carries, read from its folder: `null` for an act without one, `ended` when its file can no longer be read. */
export async function schemaStepOfFolder(folder: ImportFolder, state: ActState): Promise<(SchemaStepFile & { kind: 'file' }) | null | SchemaStepEnd> {
  if (!state.schemaStep) return null;
  try { return { kind: 'file', ...(await readSchemaStep(folder)) }; } catch (err) {
    if (isMissingPath(err) || err instanceof SyntaxError) return ended(HTTP.UNPROCESSABLE, STATE_UNREADABLE, 'its schema step can no longer be read.');
    throw err;
  }
}

/**
 * The checks an act with a schema step makes before its dry plan. The space's RDF state refusing (`rdfCode`) after the schema was written (a
 * resume) throws, so the act is owed, never ended with the schema written and no data. Before the translation (`received`), a schema stored since
 * the door read it (a round passed, a layer arrived) ends the act: the proposal was built against the old one.
 */
export function schemaStepBlocks(state: ActState, spaceId: string, rdfCode: string | null): SchemaStepEnd | null {
  if (!state.schemaStep) return null;
  if (rdfCode !== null && storedFingerprint(spaceId) === state.schemaStep.fingerprint) {
    throw new Error(`RDF is not usable on space '${spaceId}' now (${rdfCode}), and the import already wrote its schema: it is tried again.`);
  }
  if (rdfCode === null && state.phase === 'received' && storedVersion(spaceId) !== state.schemaStep.version) {
    return ended(HTTP.CONFLICT, SPACE_CHANGED, 'the space\'s schema changed after the file was read, and the schema the file builds was proposed against the old one.');
  }
  return null;
}

/**
 * What the translation and the planners read with a schema: the type schemas the space holds after the write in their stored form (`$ref`s kept,
 * what the planners judge by), the meta with them resolved (what the translation's names and context read), and the schema groups to skip
 * (`keys`; read again from the sorted file when not given).
 */
export async function translationBy(
  merged: SpaceMeta['typeSchemas'], meta: SpaceMeta, groups: () => AsyncGenerator<QuadGroup, void, undefined>, keys?: Set<string>,
): Promise<{ planSchema: SpaceMeta['typeSchemas']; meta: SpaceMeta; skip: Set<string> }> {
  const skip = keys ?? (await schemaGroupsOf(groups, blankGroupKey, null) as { keys: Set<string> }).keys;
  return { planSchema: structuredClone(merged ?? {}), meta: inlineResolvableRefs({ ...meta, typeSchemas: merged } as SpaceMeta), skip };
}

/** The proposal the write sends, made again from the act's schema step (the changed types and the version it was proposed against). */
function proposalOfStep(step: SchemaStepFile, version: number): SchemaProposal {
  return {
    kind: 'proposed', changed: step.changed, version, typesAdded: step.typesAdded.length, typesChanged: step.typesChanged.length,
    answer: { typeSchemas: (step.merged ?? {}) as SchemaProposal['answer']['typeSchemas'], taken: [], notTaken: [], changes: [], refusals: [], counts: { statements: 0, taken: 0, notTaken: 0, outside: 0 } },
  };
}

const ended = (status: number, code: string, why: string, detail?: Record<string, unknown>): SchemaStepEnd =>
  ({ kind: 'ended', status, code, why, ...(detail ? { detail } : {}) });

/**
 * The act's half, after the dry plan judged the data by the proposed schema and before `planned` is kept: the schema written once, through the
 * settings write act, as the caller read again, with the version the door read as `ifMatch` and a networked space refused. `hooks` are the
 * act's test seams around the write.
 */
export async function writeSchemaOfAct(input: {
  spaceId: string; state: ActState; step: SchemaStepFile; hooks?: { beforeSchemaWrite?: () => unknown; afterSchemaWrite?: () => unknown };
}): Promise<SchemaStepEnd | SchemaStepDone> {
  const { spaceId, state, step } = input;
  const plan = state.schemaStep!;
  let notice: Record<string, unknown> = {};
  if (plan.changes > 0 && storedFingerprint(spaceId) !== plan.fingerprint) {
    await input.hooks?.beforeSchemaWrite?.();
    const caller = callerNow(state.caller);
    if (!caller) return ended(HTTP.FORBIDDEN, SCHEMA_RDF_RUNG, 'the token that started it is gone, so the schema it builds is not written.');
    const rung = schemaRungRefusal(spaceId, caller);
    if (rung) return ended(rung.status, rung.code, `${rung.error}.`);
    const proposal = proposalOfStep(step, plan.version);
    const written = await writeSchemaProposal({
      spaceId, proposal, caller, rateKey: caller.id ?? state.importId,
      proposed: () => proposedBodyOf(spaceId, { mode: 'expand', dryRun: false }, [...SCHEMA_RDF_FROM_DEFAULT], state.options.format, proposal),
    });
    // A networked refusal carries the proposed types (`proposed`), as the schema door's does: the one asker of that question is the write.
    if (written.kind === 'refused') return ended(written.status, written.code, `${peerText(written.error, { max: RDF_IMPORT_ADDRESS_MAX })}.`, written.detail);
    notice = written.notice;
    await input.hooks?.afterSchemaWrite?.();
    if (storedFingerprint(spaceId) !== plan.fingerprint) {
      return ended(HTTP.CONFLICT, SCHEMA_RDF_CHANGED, 'the schema stored after its write is not the one the data was judged by.');
    }
  }
  const space = getConfig().spaces.find(s => s.id === spaceId);
  if (!space) return ended(HTTP.NOT_FOUND, 'space_not_found', 'the space is gone.');
  return {
    kind: 'done', typeSchemas: structuredClone(space.meta?.typeSchemas ?? {}),
    report: {
      written: plan.changes > 0, typesAdded: step.typesAdded.slice(0, SCHEMA_TYPES_NAMED_MAX), typesChanged: step.typesChanged.slice(0, SCHEMA_TYPES_NAMED_MAX),
      typesAddedCount: step.typesAdded.length, typesChangedCount: step.typesChanged.length,
      fingerprintBefore: step.fingerprintBefore, fingerprintAfter: schemaFingerprintOf(space), notice,
      ...(state.caller?.id !== undefined ? { caller: state.caller.id } : {}),
    },
  };
}

// The import act asks for these through `rdfImportSchemaStep()` (see `RdfImportSchemaStep` for why it does not import them).
defineRdfImportSchemaStep({
  schemaAskedOf, schemaRungRefusal, schemaAtDoor, keepSchemaStep, schemaStepOfFolder, schemaStepBlocks, translationBy, writeSchemaOfAct, storedVersion,
});
