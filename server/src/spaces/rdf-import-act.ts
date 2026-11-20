/**
 * The RDF import into a space, from a request to records landed: the one act `POST /api/brain/spaces/:spaceId/import/rdf` and MCP
 * `import_rdf` run, the space act that holds the space while it lands, and the status both status doors answer (bundle-270, slice S6, Q-753;
 * plan section 3 (b)-(e), amendments A1, A3, A6, A8, A10, A11; second review F1, F2, F4, F6, F7, F10, F11, F12).
 *
 * ## What it prevents
 *
 * - **Two doors that differ.** Parameters, defaults, bounds, every refusal and its code, and the report are decided here; a door only reads its
 *   body off its wire and puts the answer back on it. The parameters are judged by one schema (`RdfImportParams`) before anything else runs.
 * - **A stranger's file landing half.** The door reads the whole file into a sorted spool (`rdf/import-spool.ts`), answers what it can know
 *   without the store at once (a malformed file: 400 with its place; a file over a bound, the record bound counted from the spool alone
 *   included: 413 naming it), registers the act and answers with its `importId`. The act, which holds the space, builds the import's index
 *   (bare edges counted: each is a record of it), translates every group (`rdf/quads-to-ops.ts`; a refusal of the translation ends the act as an
 *   input failure that releases the space, read from the status door), then dry-plans every operation with the real planners
 *   (`rdf/import-plan.ts`), and only when nothing was refused commits, kind by kind in the store's order over the whole import (A1). Any refusal
 *   of a planner refuses the whole import in every mode: nothing lands, every reason is answered with its statements (named up to
 *   {@link RDF_IMPORT_REASONS_NAMED_MAX}, the rest counted), and the act ends as an input failure that RELEASES the space (A11). A reason the
 *   mode records is answered, and the import goes on. A record the dry plan refuses is not written, so the plan runs again without it until no
 *   record is judged with a refused one present (`dryPlanPass`).
 * - **The store read before the space is held.** Nothing that reads the store runs before the act holds the space: the translation copies the
 *   stored fields of a record a file converges onto, so a change a caller made meanwhile would be overwritten by the older copy, and a record
 *   deleted meanwhile would come back under a new id. The door's pass reads the body and sorts it, and answers before it has read a record.
 *   (A dry run holds nothing and answers what the store held when it read it.)
 * - **A supplied id made an identity.** Every new subject's id is minted here, once, before any group is translated, and kept in the import's
 *   index (`rdf/import-index.ts`) beside its spool; an edge stated as a bare triple is minted under its triplet. The operations carry the ids
 *   into the act's folder, so a commit resumed after a crash plans the same operations under the same ids and converges onto what its first
 *   attempt landed: no record is written twice.
 * - **A space changed under the import.** The act holds the space as every act does (no other writer, its sync exchange held), and no schema
 *   write a caller starts reaches it (`schema-write-gate.ts`, A3). A schema a network decides meanwhile (a passed round, an arriving layer) is
 *   stored as it always is and cannot break the import: the type schemas are read once, under the hold, kept in the act's state, and the dry plan
 *   and every commit window judge and stamp by them (`planMetaFor`); the schema stored meanwhile governs the writes after the import.
 * - **A resumed commit that is ended by the space.** The space's RDF state is asked before the dry plan only: once the first window is
 *   committed nothing ends the act but finishing.
 * - **A dry run that is a write.** A dry run needs the import's own rung (A10), translates and dry-plans inline, registers no act, holds
 *   nothing and writes no record; its folder is removed before it answers.
 * - **A value of the file repeated.** A refusal, a report and the audit row name statements by their subject, predicate and the kind of their
 *   object; a literal is shown as its datatype and length, never its text, and a planner's refusal by its code and the fields it names.
 * - **A failure the act will retry answered as a failure.** An act that stays owed (it is retried) is answered 202 with its `importId`; an input
 *   failure (its files are gone, the space can no longer hold it, its file is over a bound) is answered by its own status and code, the same on
 *   both doors.
 *
 * Where its files live and who may remove them: `rdf-import-files.ts`.
 */
import fsp from 'node:fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import type { SpaceMeta } from '@ythril-network/schema';
import { getConfig } from '../config/loader.js';
import type { SpaceActEntry } from '../config/types.js';
import { importBodyMaxBytes } from '../config/body-limits.js';
import { log, peerText, refusalOfParse } from '../util/log.js';
import { isMissingPath } from '../util/path-present.js';
import { checkQuota, QuotaError } from '../quota/quota.js';
import { emitWebhookEvent } from '../webhooks/dispatcher.js';
import { planMetaFor, schemaFingerprintOf } from './schema-stamp.js';
import {
  defineSpaceActBody, defineSpaceActBootSweep, registerOwnSpaceAct, runSpaceAct, spaceActsOfKind, type SpaceActBodyOutcome,
} from './space-act-runner.js';
import { awaitDoorActs } from './door-acts.js';
import {
  RDF_IMPORT_DIR, RDF_IMPORT_REPORT_DIR, RDF_IMPORT_REPORT_KEEP_MS, folderPathOf, holdFolder, keepReport, readReport, readState,
  sweepRdfImportOrphans, sweepReports, writeState, type ActState, type ImportOptions,
} from './rdf-import-files.js';
import { rdfSpaceState, type RdfCaller } from '../rdf/rdf-space-state.js';
import { RDF_FORMATS, type RdfFormat } from '../rdf/serialize.js';
import { RDF_MEDIA_TYPES } from '../rdf/export-format.js';
import { parseRdf, RdfParseError } from '../rdf/parse.js';
import { addressNames, recordOfAddress, type AddressNames } from '../rdf/term-reverse.js';
import type { RecordKind } from '../rdf/term-iri.js';
import { stdIri, type Quad, type Term } from '../rdf/literals.js';
import {
  IMPORT_OP_ORDER, ReportBuilder, emptyKinds, rdfImportAuditChanges, type RdfImportReport,
} from '../rdf/import-report.js';
import { unknownSpaceAnswer } from './unknown-space.js';

export { RDF_IMPORT_REASONS_NAMED_MAX, rdfImportAuditChanges, type RdfImportReport } from '../rdf/import-report.js';
export { RDF_IMPORT_DIR, RDF_IMPORT_REPORT_DIR, RDF_IMPORT_REPORT_KEEP_MS };
import { ythrilIri } from '../rdf/ythril-vocabulary.js';
import {
  RdfImportBoundExceeded, openImportFolder, openOperationSpool, removeImportFolder, removeOperations, reopenSortedGroups, sortedSpool,
  type ImportFolder, type ImportSpoolBounds, type QuadGroup,
} from '../rdf/import-spool.js';
import { ImportIndex, type IndexedRecord } from '../rdf/import-index.js';
import { DigestSet, assertRecordsWithinBound } from '../rdf/import-count.js';
import {
  groupSubjectOf, quadsToOps, recordKey, recordKindOfGroup, tripletsOfGroup, type MintedRecord, type QuadsToOpsContext, type RecordOp,
} from '../rdf/quads-to-ops.js';
import {
  STORED_RECORD_LINKS_OVER_BOUND, StoredRecordUnreadable, commitWindow, dryPlanWindow, importReadSet, loadStoredRecords, seededIdOf, type MintedEnd,
} from '../rdf/import-plan.js';

const KIND = 'rdf-import' as const;

/** Operations planned and committed per window. */
const WINDOW_DEFAULT = 500;
/** The longest address a parameter may carry (the tool's input schema states the same bound). */
export const RDF_IMPORT_ADDRESS_MAX = 2048;
/** The most per-graph source bases one request names. */
export const RDF_IMPORT_GRAPH_BASES_MAX = 64;
/** A graph base is `"<graph address> <source base>"`: at least one character each side of the space, and at most two addresses and the space. */
export const RDF_IMPORT_GRAPH_BASE_MIN_CHARS = 3;
export const RDF_IMPORT_GRAPH_BASE_MAX_CHARS = RDF_IMPORT_ADDRESS_MAX * 2 + 1;
/** The HTTP statuses the act and its doors answer with, each named, so no refusal below carries a bare number. */
const HTTP = {
  OK: 200, ACCEPTED: 202, BAD_REQUEST: 400, NOT_FOUND: 404, CONFLICT: 409, GONE: 410, TOO_LARGE: 413, UNSUPPORTED_MEDIA: 415, UNPROCESSABLE: 422,
  UNAVAILABLE: 503,
} as const;
/** What the fact doors answer at the brain's hard storage limit; the tool, which does not carry it, answers an error result. */
const INSUFFICIENT_STORAGE = 507;
const OP_ORDER = IMPORT_OP_ORDER;

// ── Refusal codes ─────────────────────────────────────────────────────────────────────────────────────────────

export const RDF_IMPORT_REFUSED = 'rdf_import_refused';
export const RDF_IMPORT_BAD_PARAM = 'rdf_import_bad_param';
export const RDF_IMPORT_SCHEMA_NOT_AVAILABLE = 'rdf_import_schema_not_available';
export const RDF_IMPORT_SEVERAL_GRAPHS = 'rdf_import_several_graphs';
export const RDF_IMPORT_NOT_FOUND = 'rdf_import_not_found';
export const RDF_IMPORT_BUSY = 'rdf_import_busy';
export const RDF_IMPORT_UNSUPPORTED_ENCODING = 'rdf_unsupported_encoding';
export const RDF_IMPORT_FILES_LOST = 'rdf_import_files_lost';
export const RDF_IMPORT_STATE_UNREADABLE = 'rdf_import_state_unreadable';
export const RDF_IMPORT_STORAGE_EXCEEDED = 'storage_exceeded';
/** The code every space-act door answers an act the closed runner interrupted with (`api/admin-space-transfer.ts`). */
export const RDF_IMPORT_SHUTTING_DOWN = 'shutting_down';
export const RDF_IMPORT_BODY_TOO_LARGE_BOUND = 'importBodyMaxBytes';

/** Every code an import door or a status door answers: its own, the reader's, the space state's, and the existence rule's. */
export const RDF_IMPORT_REFUSAL_CODES: readonly string[] = Object.freeze([
  RDF_IMPORT_REFUSED, RDF_IMPORT_BAD_PARAM, RDF_IMPORT_SCHEMA_NOT_AVAILABLE, RDF_IMPORT_SEVERAL_GRAPHS, RDF_IMPORT_NOT_FOUND, RDF_IMPORT_BUSY,
  RDF_IMPORT_UNSUPPORTED_ENCODING, RDF_IMPORT_FILES_LOST, RDF_IMPORT_STATE_UNREADABLE, RDF_IMPORT_STORAGE_EXCEEDED, RDF_IMPORT_SHUTTING_DOWN,
  'rdf_malformed', 'rdf_relative_iri', 'rdf_remote_context', 'rdf_jsonld_not_streamable', 'rdf_bound_exceeded', 'rdf_gzip_invalid',
  'rdf_unsupported_format', 'rdf_unsupported', 'rdf_source_failed',
  'rdf_not_enabled', 'rdf_base_conflict', 'rdf_base_shared', 'rdf_term_clash', 'rdf_unwritable', 'space_not_found',
]);

// ── Parameters ────────────────────────────────────────────────────────────────────────────────────────────────

/** A source base per graph: `"<graph address> <source base>"`, one value each. */
const GRAPH_BASE = z.string().min(RDF_IMPORT_GRAPH_BASE_MIN_CHARS).max(RDF_IMPORT_GRAPH_BASE_MAX_CHARS).regex(/^\S+ \S+$/, 'a graph base is "<graph address> <source base>"');

/**
 * The parameters both doors take, judged before any logic runs. NOT strict: a door passes only these names. `schema` is named so that a
 * request carrying it is refused by name (the schema step is the next slice's), never silently ignored.
 */
export const RdfImportParams = z.object({
  format: z.enum(RDF_FORMATS as unknown as [RdfFormat, ...RdfFormat[]]).optional(),
  dryRun: z.boolean().optional(),
  blankNodes: z.enum(['refuse', 'mint']).optional(),
  sourceBase: z.string().min(1).max(RDF_IMPORT_ADDRESS_MAX).optional(),
  sourceVocab: z.string().min(1).max(RDF_IMPORT_ADDRESS_MAX).optional(),
  graphBase: z.array(GRAPH_BASE).max(RDF_IMPORT_GRAPH_BASES_MAX).optional(),
  schema: z.unknown().optional(),
});

/** The status doors' parameter. */
export const RdfImportStatusParams = z.object({ importId: z.string().uuid() });

const bool = (v: unknown): unknown => (v === 'true' ? true : v === 'false' ? false : v);
const list = (v: unknown): unknown => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);

/** A REST query or a tool's arguments as the parameters take them: booleans from their strings, one graph base or several. */
function paramsOf(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    format: raw['format'], dryRun: bool(raw['dryRun']), blankNodes: raw['blankNodes'], sourceBase: raw['sourceBase'],
    sourceVocab: raw['sourceVocab'], graphBase: list(raw['graphBase']), schema: raw['schema'],
  };
}

// ── Test knobs ────────────────────────────────────────────────────────────────────────────────────────────────

interface RdfImportKnobs {
  window?: number;
  maxRecords?: number;
  bounds?: Partial<ImportSpoolBounds>;
  hooks?: {
    beforeCommit?: () => unknown;
    afterCommitWindow?: (committed: number) => void;
    /** After the translation read the store for one window of the file (a seam for a change made while the file is translated). */
    duringTranslation?: () => unknown;
    /** After the door sorted the file and before the act is registered. */
    beforeRegister?: () => unknown;
    /** In a commit window, after the window was planned and before its plans are committed. */
    beforeCommitPlans?: () => unknown;
  };
}
let knobs: RdfImportKnobs = {};
/** Replace the figures and hooks a test sets, or all of them with `null`. */
export function setRdfImportKnobsForTest(k: RdfImportKnobs | null): void { knobs = k ?? {}; }
const windowSize = (): number => knobs.window ?? WINDOW_DEFAULT;

// ── The passes ────────────────────────────────────────────────────────────────────────────────────────────────

/** The address names of each graph: its own source base when one was given for it, else the file's. */
function namesByGraph(meta: SpaceMeta, options: ImportOptions): (graph: string | undefined) => AddressNames {
  const fileNames = addressNames(meta, options.source);
  const perGraph = new Map(Object.entries(options.graphBases).map(([g, base]) => [g, addressNames(meta, { base })]));
  return (graph) => (graph !== undefined ? perGraph.get(graph) ?? fileNames : fileNames);
}

/** The minted ids, read through the index: a new subject's id, and a bare edge's id minted under its triplet the first time it is asked. */
class MintedThroughIndex extends Map<string, MintedRecord> {
  constructor(private readonly index: ImportIndex) { super(); }
  override get(key: string): MintedRecord | undefined {
    const known = this.index.get(key);
    if (known) return known.stored ? undefined : { kind: known.kind, id: known.id };
    // Only a triplet key (a JSON array) is minted here: every subject was minted, or not, before the translation began.
    if (!key.startsWith('[')) return undefined;
    const minted: IndexedRecord = { kind: 'edge', id: uuidv4(), stored: false };
    this.index.set(key, minted);
    return { kind: minted.kind, id: minted.id };
  }
  override has(key: string): boolean { return this.get(key) !== undefined; }
}

/** Groups in windows of `size`. */
async function* windowsOf<T>(items: AsyncIterable<T>, size: number): AsyncGenerator<T[], void, undefined> {
  let w: T[] = [];
  for await (const item of items) {
    w.push(item);
    if (w.length >= size) { yield w; w = []; }
  }
  if (w.length > 0) yield w;
}

/** The record address of a subject or object under this space's base, or null. */
function spaceRecordOf(term: Term, names: AddressNames): { kind: RecordKind; id: string } | null {
  if (term.kind !== 'iri') return null;
  const read = recordOfAddress(term.value, names);
  return read.answer === 'record' && read.of === 'space' ? { kind: read.kind, id: read.id } : null;
}

/**
 * What the translation works with: the sorted file's groups, the space's meta and the options the file is read under. It runs in the act, under
 * its hold (a dry run's inline), so a bound it meets (the index's record bound, bare edges counted) ends the act as an input failure and a stored
 * record it cannot read is a refusal in the report.
 */
interface TranslateRun {
  spaceId: string;
  folder: ImportFolder;
  meta: SpaceMeta;
  options: ImportOptions;
  groups: () => AsyncGenerator<QuadGroup, void, undefined>;
  builder: ReportBuilder;
}

/** What the act's passes work with: the operations the translation left in the folder, and where the act stands (`null`: a dry run). */
interface Run {
  spaceId: string;
  folder: ImportFolder;
  /** Replaced by the report the last dry plan pass built (the one whose refusals name every record that was judged without a refused one). */
  builder: ReportBuilder;
  state: ActState | null;
  commit: boolean;
  /** The type schemas every planner call of this run judges and stamps by (an act's are its state's, read once under the hold). */
  planSchema: SpaceMeta['typeSchemas'];
  /** `planMetaFor(planSchema)`, made once at the start of a run. */
  planMeta: object | null;
}

/**
 * Pass 1: every subject's kind, and an id minted for each new one under it (an address under this space's base whose record is stored keeps
 * its stored id); the triplets the file asserts and reifies.
 */
async function indexPass(run: TranslateRun): Promise<{ index: ImportIndex; asserted: DigestSet; reified: DigestSet }> {
  const names = namesByGraph(run.meta, run.options);
  const index = new ImportIndex(knobs.maxRecords !== undefined ? { maxRecords: knobs.maxRecords } : {});
  const asserted = new DigestSet();
  const reified = new DigestSet();
  for await (const window of windowsOf(run.groups(), windowSize())) {
    const candidates: Array<{ key: string; kind: RecordKind; id: string }> = [];
    const fresh: Array<{ key: string; kind: RecordKind }> = [];
    for (const group of window) {
      const n = names(group.graph?.value);
      const t = tripletsOfGroup(group.quads);
      t.asserted.forEach(k => asserted.add(k));
      t.reified.forEach(k => reified.add(k));
      const head = group.quads[0];
      if (!head) continue;
      const kind = recordKindOfGroup(group.quads, { names: n, mode: run.options.mode, blankNodes: run.options.blankNodes });
      if (kind === null || kind === 'file') continue;
      const key = groupSubjectOf(head.subject, n);
      const address = spaceRecordOf(head.subject.kind === 'iri' ? { kind: 'iri', value: key } : head.subject, n);
      if (address && address.kind === kind) candidates.push({ key, kind, id: address.id });
      else fresh.push({ key, kind });
    }
    const stored = await loadStoredRecords(run.spaceId, candidates.map(c => ({ kind: c.kind, id: c.id })));
    for (const c of candidates) {
      if (stored.has(recordKey(c.kind, c.id))) index.set(c.key, { kind: c.kind, id: c.id, stored: true });
      else fresh.push({ key: c.key, kind: c.kind });
    }
    for (const f of fresh) if (!index.has(f.key)) index.set(f.key, { kind: f.kind, id: uuidv4(), stored: false });
  }
  return { index, asserted, reified };
}

/**
 * The nodes a quad names: its subject and its object, and the ends of a triple term in object position (an edge reifier's statement:
 * `rdf:reifies <<( s p o )>>`), nested ones too. A stored record the file names only there is an end the translator must know (review U3).
 */
function nodesOf(q: Quad): Term[] {
  const nodes: Term[] = [q.subject];
  const visit = (t: Term): void => {
    if (t.kind === 'triple') { visit(t.subject); visit(t.object); } else nodes.push(t);
  };
  visit(q.object);
  return nodes;
}

/** Pass 2: every group translated into operations, spooled per kind; reasons and statements not taken counted. */
async function translatePass(run: TranslateRun, index: ImportIndex, asserted: DigestSet, reified: DigestSet): Promise<void> {
  const names = namesByGraph(run.meta, run.options);
  const minted = new MintedThroughIndex(index);
  await removeOperations(run.folder);
  const ops = await openOperationSpool(run.folder);
  try {
    for await (const window of windowsOf(run.groups(), windowSize())) {
      const wants: Array<{ kind: RecordKind; id: string }> = [];
      for (const group of window) {
        const n = names(group.graph?.value);
        for (const q of group.quads) {
          for (const term of nodesOf(q)) {
            const r = spaceRecordOf(term, n);
            if (r) wants.push(r);
          }
        }
      }
      const stored = await loadStoredRecords(run.spaceId, wants);
      await knobs.hooks?.duringTranslation?.();
      for (const group of window) {
        const ctx: QuadsToOpsContext = {
          names: names(group.graph?.value), meta: run.meta, mode: run.options.mode, blankNodes: run.options.blankNodes,
          stored, minted, asserted, reified,
        };
        const out = quadsToOps(group.quads, ctx);
        for (const op of out.ops) await ops.append(op.kind, op);
        out.reasons.forEach(r => run.builder.translation(r));
        out.notTaken.forEach(nt => run.builder.notTaken(nt.why));
      }
    }
  } finally {
    await ops.close();
  }
  await index.write(run.folder);
}

/**
 * The translation's passes, in order: every subject's kind and id (the index), then every group translated into operations. Reasons are the
 * builder's. A stored record the translation cannot read (its links are over the bound) refuses the import, named in the report.
 */
async function translateStage(run: TranslateRun): Promise<void> {
  try {
    const { index, asserted, reified } = await indexPass(run);
    await translatePass(run, index, asserted, reified);
  } catch (err) {
    if (!(err instanceof StoredRecordUnreadable)) throw err;
    run.builder.planner(err.kind, err.id, { code: STORED_RECORD_LINKS_OVER_BOUND });
  }
}

/** Every operation, kind by kind in the store's order, in windows of one kind. */
async function* opWindows(folder: ImportFolder): AsyncGenerator<RecordOp[], void, undefined> {
  const ops = await openOperationSpool(folder);
  let w: RecordOp[] = [];
  let kind: string | null = null;
  for await (const item of ops.read(OP_ORDER)) {
    if ((kind !== null && item.kind !== kind) || w.length >= windowSize()) { yield w; w = []; }
    kind = item.kind;
    w.push(item.op as RecordOp);
  }
  if (w.length > 0) yield w;
}

/** The records the import inserts, by id: what the dry plan and the commit seed as present (with an entity's type). */
async function mintedEndsOf(folder: ImportFolder): Promise<Map<string, MintedEnd>> {
  const ends = new Map<string, MintedEnd>();
  for await (const w of opWindows(folder)) {
    for (const op of w) {
      if (op.op !== 'insert' || op.kind === 'edge') continue;
      ends.set(op.id, op.kind === 'entity' ? { kind: 'entity', type: op.fields.type ?? null } : { kind: op.kind });
    }
  }
  return ends;
}

/**
 * One dry plan over every operation, with `seeds` as the records the import brings: refusals go to `builder`, the counts of what would land
 * are kept. Answers the ids of the records it refused (the planner took back their seed within a window; the others are named here, since
 * the records of other kinds and windows were planned in read sets of their own).
 */
async function dryPlanOnce(run: Run, builder: ReportBuilder, seeds: ReadonlyMap<string, MintedEnd>): Promise<Set<string>> {
  const edges = importReadSet(run.spaceId);
  const kinds = emptyKinds();
  const refused = new Set<string>();
  for await (const w of opWindows(run.folder)) {
    const kind = w[0]!.kind;
    const result = await dryPlanWindow(run.spaceId, w, kind === 'edge' ? edges : importReadSet(run.spaceId), seeds, run.planMeta!);
    for (const refusal of result.refusals) {
      const op = w[refusal.index]!;
      builder.planner(refusal.kind, op.correlation, refusal);
      const id = seededIdOf(op);
      if (id !== undefined) refused.add(id);
    }
    for (const taken of result.unseeded) refused.add(taken.id);
    for (const plan of result.plans) if (plan) kinds[kind][plan.op === 'insert' ? 'inserted' : 'converged'] += 1;
  }
  builder.report.kinds = kinds;
  return refused;
}

/**
 * Pass 3: every operation dry-planned with the real planners; refusals answered, the counts of what would land kept.
 *
 * A record the dry plan refuses is not written, so a record that names it must not be judged with it present. The records are planned in the
 * commit's order (facts, entities, chrono, edges), and a fact that links an entity was planned before the entity's refusal was known: the plan
 * runs again, on a fresh read set and a fresh report, without the records it refused, until a run refuses none that it had still seeded. Each
 * run takes at least one id out of a finite set of seeds, so it ends; its last report is the one that names every record judged without the
 * refused ones (and holds the refusals of every earlier run too, since a refused record stays refused).
 */
async function dryPlanPass(run: Run, minted: ReadonlyMap<string, MintedEnd>): Promise<ReportBuilder> {
  const seeds = new Map(minted);
  const base = run.builder.report;
  for (;;) {
    const attempt = new ReportBuilder(structuredClone(base));
    const refused = await dryPlanOnce(run, attempt, seeds);
    // A seed taken out is a record the next run plans without: `delete` says whether this run's refusals still had it.
    if (![...refused].map(id => seeds.delete(id)).some(Boolean)) return attempt;
  }
}

/** Pass 4: every operation committed, window by window, from where an earlier attempt stopped. */
async function commitPass(run: Run, minted: Map<string, MintedEnd>): Promise<void> {
  const state = run.state!;
  await knobs.hooks?.beforeCommit?.();
  let seen = 0;
  for await (const w of opWindows(run.folder)) {
    if (seen + w.length <= state.committed) { seen += w.length; continue; }
    const rest = w.slice(Math.max(0, state.committed - seen));
    seen += w.length;
    await commitWindow(run.spaceId, rest, minted, run.planMeta!, knobs.hooks?.beforeCommitPlans);
    knobs.hooks?.afterCommitWindow?.(state.committed + rest.length);
    state.committed += rest.length;
    await writeState(run.folder, state);
  }
}

/** The state and the report kept at a phase boundary (an act's only: a dry run has none). */
async function persist(run: Run, phase: ActState['phase']): Promise<void> {
  const state = run.state;
  if (!state) return;
  state.phase = phase;
  state.report = run.builder.report;
  await writeState(run.folder, state);
  await keepReport(run.builder.report);
}

/**
 * Run the act's passes from where `run.state` stands (a dry run from the start, with no state), the translation having been done: the dry plan
 * (only from `translated`), then the commit. Answers the report's status; never writes a record before every operation was dry-planned without
 * a refusal. The planners judge and stamp by `run.planSchema`, the one schema of the whole run.
 */
async function planAndCommit(run: Run): Promise<'refused' | 'planned' | 'completed'> {
  const state = run.state;
  run.planMeta = planMetaFor(run.spaceId, run.planSchema);
  const minted = await mintedEndsOf(run.folder);
  if (!state || state.phase === 'translated') {
    run.builder = await dryPlanPass(run, minted);
    if (run.builder.refused) return 'refused';
    await persist(run, 'planned');
  }
  if (!run.commit) return 'planned';
  if (state!.phase === 'planned') await persist(run, 'committing');
  await commitPass(run, minted);
  return 'completed';
}

// ── The act's body ────────────────────────────────────────────────────────────────────────────────────────────

/** The type schemas stored for `spaceId` now. */
const storedTypeSchemas = (spaceId: string): SpaceMeta['typeSchemas'] => getConfig().spaces.find(s => s.id === spaceId)?.meta?.typeSchemas ?? {};

/** The import's body: run the passes from its state, then (after the completion write) remove its folder. */
async function rdfImportBody({ entry }: { entry: Readonly<SpaceActEntry> }): Promise<SpaceActBodyOutcome> {
  const id = entry.spoolId ?? '';
  const dir = folderPathOf(id);
  const forget = async (): Promise<void> => { if (dir) await removeImportFolder(dir); };
  /** The act cannot go on and never will: an input failure, with the status and code its door answers by (kept in the report). */
  const gone = async (status: number, code: string, why: string): Promise<SpaceActBodyOutcome> => {
    const kept = await readReport(id).catch(() => null);
    if (kept) await keepReport({ ...kept, status: 'failed', error: why, failure: { status, code }, endedAt: new Date().toISOString() }).catch(() => undefined);
    return { failedFinally: { status, message: `The RDF import into space '${entry.localId}' cannot complete: ${why} Nothing more is written.` }, afterCompletion: forget };
  };
  /** The translation or the dry plan refused: nothing was written, the report says why, and the space is released. */
  const refused = async (run: Run): Promise<SpaceActBodyOutcome> => {
    const report = { ...run.builder.report, endedAt: new Date().toISOString(), status: 'refused' as const };
    await keepReport(report);
    return {
      failedFinally: {
        status: HTTP.CONFLICT,
        message: `The RDF import into space '${entry.localId}' was refused: ${report.reasonCount} reason(s), nothing was written; `
          + `its report is at GET /api/brain/spaces/${entry.localId}/import/rdf/${id}.`,
      },
      afterCompletion: forget,
    };
  };
  if (!dir) return gone(HTTP.GONE, RDF_IMPORT_FILES_LOST, 'its files are not named by an id this instance minted.');
  try { await fsp.access(dir); } catch (err) {
    if (isMissingPath(err)) return gone(HTTP.GONE, RDF_IMPORT_FILES_LOST, 'its files are no longer on disk.');
    throw err;
  }
  const folder = await openImportFolder(dir);
  let state: ActState;
  try { state = await readState(folder); } catch (err) {
    if (isMissingPath(err) || err instanceof SyntaxError) return gone(HTTP.UNPROCESSABLE, RDF_IMPORT_STATE_UNREADABLE, 'its state can no longer be read.');
    throw err;
  }
  const run: Run = {
    spaceId: entry.localId, folder, builder: new ReportBuilder(state.report), state, commit: true, planSchema: state.planSchema ?? {}, planMeta: null,
  };
  // The space's RDF state is asked before the dry plan only: once the first window is committed nothing ends the act but finishing.
  if (state.phase === 'received' || state.phase === 'translated') {
    const space = rdfSpaceState(getConfig(), entry.localId, undefined, schemaFingerprintOf);
    if (!space.ok) return gone(space.status, space.code, `RDF is no longer usable on the space (${space.code}).`);
    if (state.phase === 'received') {
      // The meta, the mode and the type schemas are read once, now that the space is held, and kept: the translation, the dry plan and every commit
      // window judge by this one read.
      state.options = { ...state.options, mode: space.meta.validationMode ?? 'off' };
      state.planSchema = structuredClone(space.meta.typeSchemas ?? {});
      run.planSchema = state.planSchema;
      try {
        await translateStage({
          spaceId: entry.localId, folder, meta: space.meta, options: state.options, groups: reopenSortedGroups(folder, state.sortedFile), builder: run.builder,
        });
      } catch (err) {
        if (err instanceof RdfImportBoundExceeded) return gone(HTTP.TOO_LARGE, err.code, `the file is over the import's bound ${err.bound} (${err.limit}).`);
        throw err;
      }
      if (run.builder.refused) return refused(run);
      await persist(run, 'translated');
    } else {
      state.planSchema ??= storedTypeSchemas(entry.localId);
      run.planSchema = state.planSchema;
    }
  }
  const outcome = await planAndCommit(run);
  if (outcome === 'refused') return refused(run);
  const report = { ...run.builder.report, endedAt: new Date().toISOString() };
  await keepReport({ ...report, status: 'completed' });
  emitWebhookEvent({
    event: 'bulk.write', spaceId: entry.localId,
    entry: { source: 'rdf.import', importId: id, inserted: countsOf(report, 'inserted'), updated: countsOf(report, 'converged'), errorCount: 0 },
  });
  return { counts: countsForAudit(report), afterCompletion: forget };
}

const countsOf = (r: RdfImportReport, k: 'inserted' | 'converged'): Record<string, number> =>
  Object.fromEntries(OP_ORDER.map(kind => [kind, r.kinds[kind][k]]));

/** The completion row's counts (written when nobody waits for the act). */
function countsForAudit(r: RdfImportReport): Record<string, number> {
  return Object.fromEntries(rdfImportAuditChanges(r).filter(c => typeof c.to === 'number').map(c => [c.field, c.to as number]));
}

/** Is an RDF import standing now that names the folder `id`. */
const standingNames = (id: string): boolean => spaceActsOfKind(getConfig(), KIND).some(e => e.spoolId === id);

defineSpaceActBody(KIND, rdfImportBody);
defineSpaceActBootSweep(KIND, () => {
  void sweepRdfImportOrphans(standingNames).catch(err => log.warn(`the RDF import sweep failed: ${peerText(err)}`));
});

/** Does an RDF import stand now, on any space. */
export function rdfImportStanding(): boolean {
  return spaceActsOfKind(getConfig(), KIND).length > 0;
}

// ── The door ──────────────────────────────────────────────────────────────────────────────────────────────────

/** What a door hands the act. */
export interface RdfImportInput {
  spaceId: string;
  /** The REST query or the tool's arguments; only the parameters' names are read. */
  params: Record<string, unknown>;
  /** The document: the REST body as it arrives, or the tool's inline text. */
  body: AsyncIterable<Uint8Array | string>;
  /** REST: the `Content-Type` header (the format when `format` is not given). */
  contentType?: string;
  /** REST: the `Content-Encoding` header. */
  contentEncoding?: string;
  caller: RdfCaller | undefined;
}

/** A refusal: its status, our sentence, its code, and what more a caller reads. */
export interface RdfImportRefusal { kind: 'refused'; status: number; error: string; code: string; detail?: Record<string, unknown> }

/** An import's report, finished (or a dry run's). */
export interface RdfImportDone { kind: 'report'; status: typeof HTTP.OK; report: RdfImportReport }

/** An import that goes on (or that will be retried): 202, its id and where its status is read, and when it is retried when it is owed. */
export interface RdfImportRunning { kind: 'running'; status: typeof HTTP.ACCEPTED; importId: string; location: string; retryAt?: string }

export type RdfImportAnswer = RdfImportDone | RdfImportRunning | RdfImportRefusal;

/** The body both doors answer a running import with: one shape, so the doors cannot differ. */
export function runningBodyOf(a: RdfImportRunning): { importId: string; status: 'running'; location: string; retryAt?: string } {
  return { importId: a.importId, status: 'running', location: a.location, ...(a.retryAt ? { retryAt: a.retryAt } : {}) };
}

const refusal = (status: number, code: string, error: string, detail?: Record<string, unknown>): RdfImportRefusal =>
  ({ kind: 'refused', status, code, error, ...(detail ? { detail } : {}) });

/** The format a media type names (parameters such as `; version=1.2` and `; charset` aside), or undefined. */
function formatOfMediaType(contentType: string | undefined): RdfFormat | undefined {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  return RDF_FORMATS.find(f => RDF_MEDIA_TYPES[f] === type);
}

/** The body is over the import body bound (`importBodyMaxBytes`): answered 413 naming it. */
class BodyTooLarge extends Error {
  constructor(readonly limit: number) { super('the body is over the import body bound'); }
}

/** `body` counted against `max` bytes as it arrives. */
async function* counted(body: AsyncIterable<Uint8Array | string>, max: number): AsyncGenerator<Uint8Array | string, void, undefined> {
  let n = 0;
  for await (const chunk of body) {
    n += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (n > max) throw new BodyTooLarge(max);
    yield chunk;
  }
}

const RDF_TYPE = stdIri('rdf', 'type').value;
const REPORT_CLASS = ythrilIri('ExportReport');
const HAS_PART = stdIri('dcterms', 'hasPart').value;

/** The graphs a file names, and which of them only describe the file (an export's description graph). */
interface GraphsSeen { order: string[]; describing: Set<string> }

/** `quads` passed on unchanged, with the graphs they name noted in `seen`. */
async function* noteGraphs(quads: AsyncIterable<Quad>, seen: GraphsSeen): AsyncGenerator<Quad, void, undefined> {
  const known = new Set<string>();
  for await (const q of quads) {
    const g = q.graph?.value;
    if (g !== undefined) {
      if (!known.has(g)) { known.add(g); seen.order.push(g); }
      if (q.predicate.value === HAS_PART || (q.predicate.value === RDF_TYPE && q.object.kind === 'iri' && q.object.value === REPORT_CLASS)) seen.describing.add(g);
    }
    yield q;
  }
}

/** A door is reading a file into its spool: one at a time, instance-wide, from before the first byte until its act is registered or it answered. */
let doorHeld = false;

/** The data graphs a file names that have no source base, when it names several (a view's export): refused unless each has its base (A8). */
function graphsWithoutBase(seen: GraphsSeen, options: ImportOptions): string[] {
  const data = seen.order.filter(g => !seen.describing.has(g));
  if (data.length <= 1) return [];
  return data.filter(g => !Object.hasOwn(options.graphBases, g));
}

/**
 * Run an RDF import for a door. Never throws for a caller's mistake: every refusal is an answer. A fault that is not the caller's (the store,
 * the disk) is thrown to the door.
 */
export async function rdfImportAct(input: RdfImportInput): Promise<RdfImportAnswer> {
  const parsed = RdfImportParams.safeParse(paramsOf(input.params));
  if (!parsed.success) return refusal(HTTP.BAD_REQUEST, RDF_IMPORT_BAD_PARAM, refusalOfParse(parsed.error).error);
  const p = parsed.data;
  if (p.schema !== undefined) {
    return refusal(HTTP.BAD_REQUEST, RDF_IMPORT_SCHEMA_NOT_AVAILABLE, 'schema: building a schema from the file is not available yet; import the data into a space whose schema is set, and leave schema out');
  }
  const cfg = getConfig();
  // The one existence rule: an id that is not a configured space (a view included: an import writes into a space) is answered as missing.
  const unknown = unknownSpaceAnswer(null, input.spaceId, false, cfg);
  if (unknown) return refusal(unknown.status, unknown.body.code ?? 'space_not_found', unknown.body.error);
  const format = p.format ?? formatOfMediaType(input.contentType);
  if (!format) {
    return refusal(HTTP.UNSUPPORTED_MEDIA, 'rdf_unsupported_format', `The document's format is not one the import reads: send ${RDF_FORMATS.map(f => RDF_MEDIA_TYPES[f]).join(', ')}, or name it in format`);
  }
  const encoding = (input.contentEncoding ?? 'identity').trim().toLowerCase();
  if (encoding !== 'identity' && encoding !== 'gzip' && encoding !== '') {
    return refusal(HTTP.UNSUPPORTED_MEDIA, RDF_IMPORT_UNSUPPORTED_ENCODING, 'The document is sent plain or gzipped (Content-Encoding: gzip); no other encoding is read');
  }
  const state = rdfSpaceState(cfg, input.spaceId, input.caller, schemaFingerprintOf);
  if (!state.ok) return refusal(state.status, state.code, state.error, state.detail);
  // No prototype: a graph named like an inherited key (`toString`, `__proto__`) is a graph like any other, never a base already given.
  const graphBases: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const pair of p.graphBase ?? []) {
    const [graph, base] = pair.split(' ') as [string, string];
    graphBases[graph] = base;
  }
  const options: ImportOptions = {
    format, mode: state.meta.validationMode ?? 'off', blankNodes: p.blankNodes ?? 'refuse', graphBases,
    ...(p.sourceBase !== undefined ? { source: { base: p.sourceBase, ...(p.sourceVocab !== undefined ? { vocab: p.sourceVocab } : {}) } } : {}),
  };
  try { namesByGraph(state.meta, options); } catch (err) {
    if (err instanceof TypeError) return refusal(HTTP.BAD_REQUEST, RDF_IMPORT_BAD_PARAM, `sourceBase, sourceVocab or graphBase: ${err.message}`);
    throw err;
  }
  // The brain's hard storage limit, asked as the fact doors ask it (a dry run writes nothing and is not asked).
  if (p.dryRun !== true) {
    try { await checkQuota('brain'); } catch (err) {
      if (err instanceof QuotaError) return refusal(INSUFFICIENT_STORAGE, RDF_IMPORT_STORAGE_EXCEEDED, err.message, { storageExceeded: true });
      throw err;
    }
  }
  if (doorHeld) return refusal(HTTP.CONFLICT, RDF_IMPORT_BUSY, 'Another RDF import is being read in on this instance: try again when it has been answered');
  doorHeld = true;
  let released = false;
  const releaseDoor = (): void => { if (!released) { released = true; doorHeld = false; } };
  try {
    return await readAndRun(input, options, state.meta, p.dryRun === true, releaseDoor);
  } finally {
    releaseDoor();
  }
}

/**
 * The door's own pass and what follows it: the file into its sorted spool and the bounds that need no store, then the dry run inline, or the state
 * written, the act registered and waited for within the runner's budget. The act reads the store; this reads none.
 */
async function readAndRun(input: RdfImportInput, options: ImportOptions, meta: SpaceMeta, dryRun: boolean, releaseDoor: () => void): Promise<RdfImportAnswer> {
  const importId = uuidv4();
  const dir = folderPathOf(importId)!;
  // The sweep at the start never removes a folder a door is filling.
  const releaseFolder = holdFolder(importId);
  let handedOver = false;
  let kept: RdfImportReport | undefined;
  try {
    const folder = await openImportFolder(dir);
    const seen: GraphsSeen = { order: [], describing: new Set() };
    const quads = parseRdf(counted(input.body, importBodyMaxBytes(getConfig())), options.format, { blankNodePrefix: `b${importId.slice(0, 8)}-` });
    const sorted = await sortedSpool(noteGraphs(quads, seen), folder, { names: addressNames(meta, options.source), bounds: knobs.bounds ?? {} });
    const missing = graphsWithoutBase(seen, options);
    if (missing.length > 0) {
      return refusal(HTTP.BAD_REQUEST, RDF_IMPORT_SEVERAL_GRAPHS, `The file holds ${seen.order.length - seen.describing.size} data graphs and ${missing.length} of them have no source base: `
        + 'name one per graph in graphBase ("<graph address> <source base>"), or import one graph at a time', { graphsWithoutBase: missing.slice(0, RDF_IMPORT_GRAPH_BASES_MAX) });
    }
    // The records the file will make, subjects and bare edges, counted from the spool alone: a file that cannot fit is answered 413 here.
    await assertRecordsWithinBound(sorted.groups(), namesByGraph(meta, options), sorted.subjects, knobs.maxRecords);
    const report: RdfImportReport = {
      importId, space: input.spaceId, status: dryRun ? 'dry-run' : 'running', dryRun, format: options.format, mode: options.mode,
      quads: sorted.quads, subjects: sorted.subjects, kinds: emptyKinds(), reasons: [], reasonCount: 0, reasonsByCode: {}, notTaken: {},
      startedAt: new Date().toISOString(),
    };
    if (dryRun) {
      // Inline: a dry run registers no act and holds nothing, so its translation reads the store as it is when it reads it.
      const run: Run = { spaceId: input.spaceId, folder, builder: new ReportBuilder(report), state: null, commit: false, planSchema: meta.typeSchemas ?? {}, planMeta: null };
      await translateStage({ spaceId: input.spaceId, folder, meta, options, groups: sorted.groups, builder: run.builder });
      const outcome = run.builder.refused ? 'refused' : await planAndCommit(run);
      const done = { ...run.builder.report, endedAt: new Date().toISOString() };
      return outcome === 'refused' ? refusedAnswer({ ...done, status: 'refused' }) : { kind: 'report', status: HTTP.OK, report: done };
    }
    await writeState(folder, { importId, space: input.spaceId, options, sortedFile: sorted.file, phase: 'received', committed: 0, report });
    await keepReport(report);
    kept = report;
    void sweepReports(Date.now()).catch(err => log.warn(`the RDF import report sweep failed: ${peerText(err)}`));
    await knobs.hooks?.beforeRegister?.();
    const entryId = registerOwnSpaceAct({ kind: KIND, localId: input.spaceId, spoolId: importId });
    handedOver = true;
    releaseFolder();
    releaseDoor();
    return await waitForAct(input.spaceId, importId, entryId);
  } catch (err) {
    // Never registered (the door failed, or shutdown closed the runner): the report kept a moment ago must not say "running" for seven days.
    if (kept && !handedOver) {
      await keepReport({ ...kept, status: 'failed', error: 'The import was not registered: the request failed before its act began. Nothing was written.', endedAt: new Date().toISOString() })
        .catch(() => undefined);
    }
    const answer = doorRefusalOf(err, options.format);
    if (answer) return answer;
    throw err;
  } finally {
    releaseFolder();
    if (!handedOver) await removeImportFolder(dir).catch(err => log.warn(`an RDF import folder could not be removed: ${peerText(err)}`));
  }
}

/** A strict refusal's answer: 409, the report beside it. */
function refusedAnswer(report: RdfImportReport): RdfImportRefusal {
  return refusal(HTTP.CONFLICT, RDF_IMPORT_REFUSED, `The import was refused and nothing was written: ${report.reasonCount} reason(s), each with its statements in the report`, { report });
}

/** The answer to a fault of the door's own pass that is the file's, or null. */
function doorRefusalOf(err: unknown, format: RdfFormat): RdfImportRefusal | null {
  if (err instanceof RdfImportBoundExceeded) {
    return refusal(HTTP.TOO_LARGE, err.code, `The file is over the import's bound ${err.bound} (${err.limit}); nothing was imported`, { bound: err.bound, limit: err.limit });
  }
  if (err instanceof BodyTooLarge) {
    return refusal(HTTP.TOO_LARGE, 'rdf_bound_exceeded', `The body is over the import body bound (${err.limit} bytes); nothing was imported`, { bound: RDF_IMPORT_BODY_TOO_LARGE_BOUND, limit: err.limit });
  }
  if (err instanceof RdfParseError) {
    if (err.code === 'rdf_bound_exceeded') {
      return refusal(HTTP.TOO_LARGE, err.code, `The file is over the reader's bound ${err.bound ?? ''}; nothing was imported`, { ...(err.bound ? { bound: err.bound } : {}), ...(err.place ? { place: err.place } : {}) });
    }
    const where = err.place ? ` at line ${err.place.line}${err.place.column === undefined ? '' : `, column ${err.place.column}`}` : '';
    const why = err.code === 'rdf_malformed' ? `is not well-formed ${format}${where}` : `cannot be read${where} (${err.code})`;
    return refusal(err.code === 'rdf_unsupported_format' ? HTTP.UNSUPPORTED_MEDIA : HTTP.BAD_REQUEST, err.code, `The file ${why}; nothing was imported`, err.place ? { place: err.place } : undefined);
  }
  return null;
}

/**
 * Wait for the act within the runner's budget: 200 with its report, 409 with a refusal's, the failure's own status and code for an input failure
 * (kept in its report), 503 for a shutdown, and 202 with the `importId` while it runs or when it stays owed (a failure the act retries is no
 * failure to a caller: it will land, and a caller who sent the file again would import it twice).
 */
async function waitForAct(spaceId: string, importId: string, entryId: string): Promise<RdfImportAnswer> {
  const location = `/api/brain/spaces/${encodeURIComponent(spaceId)}/import/rdf/${importId}`;
  const wait = await awaitDoorActs([entryId], [runSpaceAct(entryId, { waiter: true, via: 'door' }).then(r => [r])]);
  if (!wait.finished) return { kind: 'running', status: HTTP.ACCEPTED, importId, location };
  const settled = wait.results[0]!;
  const report = await readReport(importId);
  if (settled.ok && report) return { kind: 'report', status: HTTP.OK, report };
  if (report?.status === 'refused') return refusedAnswer(report);
  if (settled.interrupted) return refusal(HTTP.UNAVAILABLE, RDF_IMPORT_SHUTTING_DOWN, 'shutting down; the import resumes after the next start', { importId });
  if (report?.status === 'failed' && report.failure) {
    return refusal(report.failure.status, report.failure.code, report.error ?? 'The import cannot complete; nothing more is written', { importId });
  }
  return { kind: 'running', status: HTTP.ACCEPTED, importId, location, ...(settled.retryAt ? { retryAt: settled.retryAt } : {}) };
}

// ── The status door ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * A report as the status door answers it: from the act when one holds the import (an owed act says when it is retried), and never "running" for
 * an import no act holds (a door that failed between keeping its report and registering the act): that one failed, and nothing more is written.
 */
function reportAsHeld(report: RdfImportReport): RdfImportReport {
  if (report.status !== 'running') return report;
  const act = spaceActsOfKind(getConfig(), KIND).find(e => e.spoolId === report.importId);
  if (!act) {
    return { ...report, status: 'failed', error: 'No act holds this import: it did not reach its act. Nothing was written.', endedAt: report.endedAt ?? new Date().toISOString() };
  }
  return act.retryAt ? { ...report, retryAt: act.retryAt } : report;
}

/** What an import did or is doing, for a caller with the import's rung on its space. */
export async function rdfImportStatusAct(input: { spaceId: string; params: Record<string, unknown> }): Promise<RdfImportDone | RdfImportRefusal> {
  const parsed = RdfImportStatusParams.safeParse({ importId: input.params['importId'] });
  if (!parsed.success) return refusal(HTTP.BAD_REQUEST, RDF_IMPORT_BAD_PARAM, refusalOfParse(parsed.error).error);
  const unknown = unknownSpaceAnswer(null, input.spaceId);
  if (unknown) return refusal(unknown.status, unknown.body.code ?? 'space_not_found', unknown.body.error);
  const report = await readReport(parsed.data.importId);
  // Another space's import is answered as one that does not exist: its id says nothing to a caller of this space.
  if (!report || report.space !== input.spaceId) return refusal(HTTP.NOT_FOUND, RDF_IMPORT_NOT_FOUND, 'No import of this space has that id (a report is kept for seven days)');
  return { kind: 'report', status: HTTP.OK, report: reportAsHeld(report) };
}
