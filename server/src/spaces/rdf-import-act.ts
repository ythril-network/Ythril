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
 *   (`rdf/import-plan.ts`), and only when nothing was refused commits, kind by kind over the whole import, what a record points at first (A1, `IMPORT_OP_ORDER`:
 *   entities, facts, chrono entries, edges; the planners' own order writes facts first, which loses a fact's links to an entity of the same file). Any refusal
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
 * - **A schema left behind by a refused import, or records stamped by a schema the space does not hold (Q-955).** With `schema` set the door
 *   proposes the schema the file's classes and shapes build (the schema door's shared step, after the source base is settled, its groups bounded),
 *   and judges it as its write would be (`schema: write`, rules at `admin`, the planner) before a byte of data is judged. The act translates and
 *   dry-plans by the proposed schema, and only then writes it, once, through the settings write act, as the caller read again, with the version the
 *   door read as `ifMatch`; every answer of the write but an applied one ends the act with the schema door's code and nothing written. The planners
 *   then judge and stamp by the stored schema, whose fingerprint must be the one the proposal gave. A resume that finds it stored writes nothing again.
 *   The schema's groups are not imported as records (counted as not taken, `schema`); without `schema` the import is as it was.
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
  RDF_IMPORT_ADDRESS_MAX, RDF_IMPORT_DIR, RDF_IMPORT_REPORT_DIR, RDF_IMPORT_REPORT_KEEP_MS, folderPathOf, holdFolder, keepReport, readReport,
  rdfImportSchemaStep, readState, sweepRdfImportOrphans, sweepReports, writeState, type ActState, type ImportOptions, type SchemaAsked,
} from './rdf-import-files.js';
import { rdfSpaceState, type RdfCaller } from '../rdf/rdf-space-state.js';
import type { RdfFormat } from '../rdf/serialize.js';
import { parseRdf } from '../rdf/parse.js';
import {
  RDF_UNSUPPORTED_ENCODING, RDF_UPLOAD_COOLDOWN, RDF_UPLOAD_STALLED, RDF_UPLOAD_TOO_SLOW, rdfDocumentRefusalOf, rdfFormatOf, refusal, type RdfDocumentRefusal,
} from '../rdf/rdf-document.js';
import {
  RDF_IMPORT_GRAPH_BASES_MAX, RDF_IMPORT_GRAPH_BASE_MIN_CHARS, RDF_IMPORT_GRAPH_BASE_MAX_CHARS, RDF_IMPORT_INFER_SUPPORT_MAX, RdfImportParams, RdfImportStatusParams,
  rdfImportParamsOf,
} from './rdf-import-params.js';
import { addressNames, recordOfAddress, type AddressNames } from '../rdf/term-reverse.js';
import type { RecordKind } from '../rdf/term-iri.js';
import type { Quad, Term } from '../rdf/literals.js';
import {
  IMPORT_OP_ORDER, ReportBuilder, emptyKinds, emptyUnchanged, rdfImportAuditChanges, type RdfImportReport,
} from '../rdf/import-report.js';
import { unknownSpaceAnswer } from './unknown-space.js';
import { spaceWriteClosedNow } from './space-write-gate.js';

export { RDF_IMPORT_REASONS_NAMED_MAX, rdfImportAuditChanges, type RdfImportReport } from '../rdf/import-report.js';
export { RDF_IMPORT_DIR, RDF_IMPORT_REPORT_DIR, RDF_IMPORT_REPORT_KEEP_MS };
import {
  RdfImportBoundExceeded, openImportFolder, openOperationSpool, removeImportFolder, removeOperations, reopenSortedGroups, resortedSpool, sortedSpool,
  type ImportFolder, type ImportSpoolBounds, type QuadGroup,
} from '../rdf/import-spool.js';
import { ImportIndex, type IndexedRecord } from '../rdf/import-index.js';
import { TripletSets, assertRecordsWithinBound, type DigestSet } from '../rdf/import-count.js';
import { counted } from '../rdf/import-upload.js';
import { defaultSourceBase, graphsWithoutBase, noteGraphs, type GraphsSeen } from '../rdf/import-default-source.js';
import {
  groupSubjectOf, quadsToOps, recordKey, recordKindOfGroup, type MintedRecord, type QuadsToOpsContext, type RecordOp,
} from '../rdf/quads-to-ops.js';
import {
  STORED_RECORD_LINKS_OVER_BOUND, StoredRecordUnreadable, commitWindow, dryPlanWindow, importReadSet, loadStoredRecords, seededIdOf, type MintedEnd,
} from '../rdf/import-plan.js';

const KIND = 'rdf-import' as const;

/** Operations planned and committed per window. */
const WINDOW_DEFAULT = 500;
export { RDF_IMPORT_ADDRESS_MAX };
export {
  RDF_IMPORT_GRAPH_BASES_MAX, RDF_IMPORT_GRAPH_BASE_MIN_CHARS, RDF_IMPORT_GRAPH_BASE_MAX_CHARS, RDF_IMPORT_INFER_SUPPORT_MAX, RdfImportParams, RdfImportStatusParams,
};
/** The HTTP statuses the act and its doors answer with, each named, so no refusal below carries a bare number. */
const HTTP = {
  OK: 200, ACCEPTED: 202, BAD_REQUEST: 400, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, GONE: 410, TOO_LARGE: 413, UNSUPPORTED_MEDIA: 415, UNPROCESSABLE: 422,
  UNAVAILABLE: 503,
} as const;
/** What the fact doors answer at the brain's hard storage limit; the tool, which does not carry it, answers an error result. */
const INSUFFICIENT_STORAGE = 507;
const OP_ORDER = IMPORT_OP_ORDER;

// ── Refusal codes ─────────────────────────────────────────────────────────────────────────────────────────────

export const RDF_IMPORT_REFUSED = 'rdf_import_refused';
export const RDF_IMPORT_BAD_PARAM = 'rdf_import_bad_param';
export const RDF_IMPORT_SEVERAL_GRAPHS = 'rdf_import_several_graphs';
export const RDF_IMPORT_NOT_FOUND = 'rdf_import_not_found';
export const RDF_IMPORT_BUSY = 'rdf_import_busy';
export const RDF_IMPORT_SPACE_CHANGED = 'rdf_import_space_changed';
export const RDF_IMPORT_FILES_LOST = 'rdf_import_files_lost';
export const RDF_IMPORT_STATE_UNREADABLE = 'rdf_import_state_unreadable';
export const RDF_IMPORT_STORAGE_EXCEEDED = 'storage_exceeded';
/** An upload that sent nothing for the upload's idle bound (408; the connection is closed after the answer): the document reader's code. */
export const RDF_IMPORT_UPLOAD_STALLED = RDF_UPLOAD_STALLED;
/** The code every space-act door answers an act the closed runner interrupted with (`api/admin-space-transfer.ts`). */
export const RDF_IMPORT_SHUTTING_DOWN = 'shutting_down';
/** What the import answers when it reads a file: the reader's words for what it did not do. */
const NOTHING_IMPORTED = 'nothing was imported';

/** Every code an import door or a status door answers: its own, the document reader's, the space state's, and the existence rule's. */
export const RDF_IMPORT_REFUSAL_CODES: readonly string[] = Object.freeze([
  RDF_IMPORT_REFUSED, RDF_IMPORT_BAD_PARAM, RDF_IMPORT_SEVERAL_GRAPHS, RDF_IMPORT_NOT_FOUND, RDF_IMPORT_BUSY, RDF_IMPORT_SPACE_CHANGED,
  RDF_UNSUPPORTED_ENCODING, RDF_IMPORT_FILES_LOST, RDF_IMPORT_STATE_UNREADABLE, RDF_IMPORT_STORAGE_EXCEEDED, RDF_IMPORT_SHUTTING_DOWN, RDF_UPLOAD_STALLED,
  RDF_UPLOAD_TOO_SLOW, RDF_UPLOAD_COOLDOWN,
  'rdf_malformed', 'rdf_relative_iri', 'rdf_remote_context', 'rdf_jsonld_not_streamable', 'rdf_bound_exceeded', 'rdf_gzip_invalid',
  'rdf_unsupported_format', 'rdf_unsupported', 'rdf_source_failed',
  'rdf_not_enabled', 'rdf_base_conflict', 'rdf_base_shared', 'rdf_base_nested', 'rdf_term_clash', 'rdf_unwritable', 'space_not_found',
  // With `schema` set (Q-955): the schema door's own codes, answered by the shared step for the same causes.
  'schema_rdf_bad_param', 'schema_rdf_rung', 'schema_rdf_networked', 'schema_rdf_not_empty', 'schema_rdf_changed', 'schema_rdf_refused',
]);
/** The not-taken reason of a schema construct's statements, which an import with `schema` builds the schema from and does not import as records. */
export const RDF_IMPORT_SCHEMA_NOT_TAKEN = 'schema';
/** The not-taken reason of a declaring group of a source `from` did not ask for: never a record, never built (Q-755, design revision 3). */
export const RDF_IMPORT_SCHEMA_NOT_ASKED = 'schema-not-asked';

/** The door's decisions a translation run takes, when a schema step made them: the groups to skip, those not asked for, the pairs to leave out. */
const decidedOf = (by: object): Pick<TranslateRun, 'skip' | 'notAsked' | 'leaveOut'> =>
  ('skip' in by && 'notAsked' in by && 'leaveOut' in by
    ? { skip: by.skip as ReadonlySet<string>, notAsked: by.notAsked as ReadonlySet<string>, leaveOut: by.leaveOut as ReadonlySet<string> }
    : {});

// ── Test knobs ────────────────────────────────────────────────────────────────────────────────────────────────

interface RdfImportKnobs {
  window?: number;
  maxRecords?: number;
  /** Replaces `SCHEMA_RDF_MAX_QUADS` as the bound of the schema groups an import with `schema` collects. */
  schemaMaxQuads?: number;
  /** Replaces `SCHEMA_INFER_MAX_PREDICATES` as the most distinct predicates a file's records may use for a schema to be inferred (Q-755). */
  schemaInferMaxPredicates?: number;
  /**
   * Replace `SCHEMA_INFER_MAX_CLASSES` (the most distinct classes a file's subjects may be typed with for a schema to be inferred) and
   * `SCHEMA_INFER_MAX_PAIRS` (the most (subject, predicate) pairs of subjects stated by several graphs the inference remembers).
   */
  schemaInferMaxClasses?: number; schemaInferMaxPairs?: number;
  /** Replaces the upload's idle bound for this door alone (`util/upload-reader.ts`, whose pace knob reaches every door; a test that waits for it). */
  uploadIdleMs?: number;
  bounds?: Partial<ImportSpoolBounds>;
  hooks?: {
    beforeCommit?: () => unknown;
    afterCommitWindow?: (committed: number) => void;
    /** After the translation read the store for one window of the file (a seam for a change made while the file is translated). */
    duringTranslation?: () => unknown;
    /** When a door has taken the one place to read an upload in (a seam for a second import that must meet it held). */
    afterDoorTaken?: () => void;
    /** After the door sorted the file and before the act is registered. */
    beforeRegister?: () => unknown;
    /** After the act is registered and before it runs (a seam for a change a network makes to the space in between). */
    afterRegister?: () => unknown;
    /** In a commit window, after the window was planned and before its plans are committed. */
    beforeCommitPlans?: () => unknown;
    /** In an act with a schema step, after the dry plan passed and before the schema is written. */
    beforeSchemaWrite?: () => unknown;
    /** In an act with a schema step, after the schema was written and before `planned` is kept. */
    afterSchemaWrite?: () => unknown;
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
  /** The groups an import with `schema` builds the schema from (by key): not records, each statement counted as not taken. */
  skip?: ReadonlySet<string>;
  /** Of `skip`, the declaring groups of a source `from` did not ask for: counted apart (`schema-not-asked`), Q-755. */
  notAsked?: ReadonlySet<string>;
  /** The (kind, type, predicate) pairs a schema inferred from the data left out (`leaveOutKey`): their statements are `not-inferred`. */
  leaveOut?: ReadonlySet<string>;
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
  /** `planMetaFor(planSchema)`, made once at the start of a run (and again after a schema step wrote the schema). */
  planMeta: object | null;
  /**
   * An act's schema step (Q-955): run after the dry plan passed and before `planned` is kept. Answers how the act ends when the write is refused,
   * or null when it goes on (having set `planSchema` and `planMeta` to the stored schema).
   */
  schemaStep?: () => Promise<SpaceActBodyOutcome | null>;
}

/**
 * Pass 1: every subject's kind, and an id minted for each new one under it (an address under this space's base whose record is stored keeps
 * its stored id); the triplets the file asserts and reifies.
 */
async function indexPass(run: TranslateRun): Promise<{ index: ImportIndex; asserted: DigestSet; reified: DigestSet }> {
  const names = namesByGraph(run.meta, run.options);
  const index = new ImportIndex(knobs.maxRecords !== undefined ? { maxRecords: knobs.maxRecords } : {});
  // The door's count held the same sets under the same bound before this act was registered, so they cannot pass it here.
  const triplets = new TripletSets(knobs.maxRecords);
  for await (const window of windowsOf(run.groups(), windowSize())) {
    const candidates: Array<{ key: string; kind: RecordKind; id: string }> = [];
    const fresh: Array<{ key: string; kind: RecordKind }> = [];
    for (const group of window) {
      if (run.skip?.has(group.key)) continue;
      const n = names(group.graph?.value);
      triplets.addGroup(group.quads, n);
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
  return { index, asserted: triplets.asserted, reified: triplets.reified };
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
    for await (const all of windowsOf(run.groups(), windowSize())) {
      const window = run.skip ? all.filter(g => !run.skip!.has(g.key)) : all;
      for (const g of all) {
        if (run.skip?.has(g.key)) run.builder.notTaken(run.notAsked?.has(g.key) ? RDF_IMPORT_SCHEMA_NOT_ASKED : RDF_IMPORT_SCHEMA_NOT_TAKEN, g.quads.length);
      }
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
          stored, minted, asserted, reified, ...(run.leaveOut ? { leaveOut: run.leaveOut } : {}),
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
  const unchanged = emptyUnchanged();
  const refused = new Set<string>();
  for await (const w of opWindows(run.folder)) {
    const kind = w[0]!.kind;
    const result = await dryPlanWindow(run.spaceId, w, kind === 'edge' ? edges : importReadSet(run.spaceId), seeds, run.planMeta!);
    result.unchanged.forEach((same, i) => { if (same && result.plans[i]) unchanged[kind] += 1; });
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
  builder.report.unchanged = unchanged;
  return refused;
}

/**
 * Pass 3: every operation dry-planned with the real planners; refusals answered, the counts of what would land kept.
 *
 * A record the dry plan refuses is not written, so a record that names it must not be judged with it present. The records are planned in the
 * import's order (`IMPORT_OP_ORDER`: entities, facts, chrono, edges; what a record points at first), each window in a read set of its own and
 * seeded from the whole import's seeds, and a record of a later window that names a record an earlier window refused was judged with it present: the plan
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
    const { leftOut, linksNotWritten } = await commitWindow(run.spaceId, rest, minted, run.planMeta!, knobs.hooks?.beforeCommitPlans);
    // A record that landed without every link the file states for it (a record they point at went meanwhile) is named, never lost without a word.
    for (const op of linksNotWritten) run.builder.linksNotWritten(op.kind, op.correlation);
    // A record the store no longer let be written is named in the report, and the windows after this one no longer find its minted id present.
    for (const { op } of leftOut) {
      run.builder.leftOutAtCommit(op.kind, op.correlation, op.op);
      const id = seededIdOf(op);
      if (id !== undefined) minted.delete(id);
    }
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
async function planAndCommit(run: Run): Promise<'refused' | 'planned' | 'completed' | { ended: SpaceActBodyOutcome }> {
  const state = run.state;
  run.planMeta = planMetaFor(run.spaceId, run.planSchema);
  const minted = await mintedEndsOf(run.folder);
  if (!state || state.phase === 'translated') {
    run.builder = await dryPlanPass(run, minted);
    if (run.builder.refused) return 'refused';
    const ended = run.schemaStep ? await run.schemaStep() : null;
    if (ended) return { ended };
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
/**
 * The one line the end of an import leaves in the log (lens finding L6): the import, its space and counts, never an address or a value of a record (the
 * report keeps those, behind the status door's rung). The act is counted by the runner (`ythril_space_acts_total{kind="rdf-import"}`: an import that wrote
 * is `completed`, one that was refused or cannot go on is `failed`), so a metric of its own would count each end twice.
 */
function sayEnd(spaceId: string, importId: string, how: 'completed' | 'refused' | 'failed', report: RdfImportReport | null, code?: string): void {
  const sum = (k: 'inserted' | 'converged'): number => (report ? OP_ORDER.reduce((n, kind) => n + report.kinds[kind][k], 0) : 0);
  log.info(`RDF import ${importId} into space '${peerText(spaceId)}' ${how}${code ? ` (${code})` : ''}: ${sum('inserted')} inserted, ${sum('converged')} converged, ${report?.reasonCount ?? 0} reason(s)`);
}

/** The import's body: run the passes from its state, then (after the completion write) remove its folder. */
async function rdfImportBody({ entry }: { entry: Readonly<SpaceActEntry> }): Promise<SpaceActBodyOutcome> {
  const id = entry.spoolId ?? '';
  const dir = folderPathOf(id);
  const forget = async (): Promise<void> => { if (dir) await removeImportFolder(dir); };
  /** The act cannot go on and never will: an input failure, with the status and code its door answers by (kept in the report). */
  const gone = async (status: number, code: string, why: string, detail?: Record<string, unknown>): Promise<SpaceActBodyOutcome> => {
    const kept = await readReport(id).catch(() => null);
    const failure = { status, code, ...(detail ? { detail } : {}) };
    if (kept) await keepReport({ ...kept, status: 'failed', error: why, failure, endedAt: new Date().toISOString() }).catch(() => undefined);
    sayEnd(entry.localId, id, 'failed', kept, code);
    return { failedFinally: { status, message: `The RDF import into space '${entry.localId}' cannot complete: ${why} Nothing more is written.` }, afterCompletion: forget };
  };
  /** The translation or the dry plan refused: nothing was written, the report says why, and the space is released. */
  const refused = async (run: Run): Promise<SpaceActBodyOutcome> => {
    const report = { ...run.builder.report, endedAt: new Date().toISOString(), status: 'refused' as const };
    await keepReport(report);
    sayEnd(entry.localId, id, 'refused', report);
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
  // An import with `schema` set (Q-955) carries its proposal in its own file (`rdf-import-schema-step.ts`); a state written before had none. The file
  // is read only where the step is still used (the translation and the dry plan, then the write): past them the schema is written and the file is not needed.
  const beforeCommit = state.phase === 'received' || state.phase === 'translated';
  const wired = state.schemaStep ? rdfImportSchemaStep() : null;
  const step = wired && beforeCommit ? await wired.schemaStepOfFolder(folder, state) : null;
  if (step?.kind === 'ended') return gone(step.status, step.code, step.why);
  // The space's RDF state is asked before the dry plan only: once the first window is committed nothing ends the act but finishing.
  if (beforeCommit) {
    const space = rdfSpaceState(getConfig(), entry.localId, undefined, schemaFingerprintOf);
    const blocked = wired?.schemaStepBlocks(state, entry.localId, space.ok ? null : space.code) ?? null;
    if (blocked) return gone(blocked.status, blocked.code, blocked.why);
    if (!space.ok) return gone(space.status, space.code, `RDF is no longer usable on the space (${space.code}).`);
    if (state.phase === 'received') {
      // What the door sorted the file by is compared with what the space says now: a schema the network decided can have moved the base after the act
      // was registered. Before the first window that ends the act (the sort and the record count were made by the old addressing); after it nothing does.
      if (state.sortedBy && (space.meta.rdf?.base !== state.sortedBy.base || space.meta.rdf?.vocab !== state.sortedBy.vocab)) {
        return gone(HTTP.CONFLICT, RDF_IMPORT_SPACE_CHANGED, 'the space\'s RDF base or vocabulary changed after the file was read.');
      }
      // The meta, the mode and the type schemas are read once, now that the space is held, and kept: the translation, the dry plan and every commit
      // window judge by this one read. With a schema step they are the proposal's (stored form for the planners; resolved for the translation's names).
      state.options = { ...state.options, mode: space.meta.validationMode ?? 'off' };
      const groups = reopenSortedGroups(folder, state.sortedFile);
      // The door's decisions are read from the step file (Q-755): the groups it skipped and the pairs it left out, never inferred again.
      const by = step ? await wired!.translationBy(step.merged, space.meta, groups, step.from, wired!.decidedOfStep(step)) : { planSchema: structuredClone(space.meta.typeSchemas ?? {}), meta: space.meta };
      state.planSchema = by.planSchema;
      run.planSchema = state.planSchema;
      try {
        await translateStage({ spaceId: entry.localId, folder, meta: by.meta, options: state.options, groups, builder: run.builder, ...decidedOf(by) });
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
  // The schema written once after the dry plan passed; the planners then judge and stamp by the stored schema.
  if (step) run.schemaStep = async () => {
    const done = await wired!.writeSchemaOfAct({ spaceId: entry.localId, state, step, ...(knobs.hooks ? { hooks: knobs.hooks } : {}) });
    if (done.kind === 'ended') return gone(done.status, done.code, done.why, done.detail);
    run.planSchema = state.planSchema = done.typeSchemas;
    run.planMeta = planMetaFor(entry.localId, run.planSchema);
    run.builder.report.schema = done.report;
    return null;
  };
  const outcome = await planAndCommit(run);
  if (outcome === 'refused') return refused(run);
  if (typeof outcome === 'object') return outcome.ended;
  const report = { ...run.builder.report, endedAt: new Date().toISOString() };
  await keepReport({ ...report, status: 'completed' });
  sayEnd(entry.localId, id, 'completed', report);
  emitWebhookEvent({
    event: 'bulk.write', spaceId: entry.localId,
    entry: { source: 'rdf.import', importId: id, inserted: countsOf(report, 'inserted'), updated: countsOf(report, 'converged'), errorCount: 0 },
  });
  return { ...auditOf(report), afterCompletion: forget };
}

const countsOf = (r: RdfImportReport, k: 'inserted' | 'converged'): Record<string, number> =>
  Object.fromEntries(OP_ORDER.map(kind => [kind, r.kinds[kind][k]]));

/** The completion row's counts, and the schema step's fingerprints and flag (written when nobody waits for the act; the row's allowlist keeps what it names). */
function auditOf(r: RdfImportReport): { counts: Record<string, number>; auditFields: Record<string, string | boolean> } {
  const changes = rdfImportAuditChanges(r);
  return {
    counts: Object.fromEntries(changes.flatMap((c): Array<[string, number]> => (typeof c.to === 'number' ? [[c.field, c.to]] : []))),
    auditFields: Object.fromEntries(changes.flatMap((c): Array<[string, string | boolean]> => (typeof c.to !== 'number' && c.field.startsWith('schema') ? [[c.field, c.to]] : []))),
  };
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

/** A refusal: its status, our sentence, its code, and what more a caller reads (the shape the RDF document front half declares). */
export type RdfImportRefusal = RdfDocumentRefusal;

/** An import's report, finished (or a dry run's). */
export interface RdfImportDone { kind: 'report'; status: typeof HTTP.OK; report: RdfImportReport }

/** An import that goes on (or that will be retried): 202, its id and where its status is read, and when it is retried when it is owed. */
export interface RdfImportRunning { kind: 'running'; status: typeof HTTP.ACCEPTED; importId: string; location: string; retryAt?: string }

export type RdfImportAnswer = RdfImportDone | RdfImportRunning | RdfImportRefusal;

/** The body both doors answer a running import with: one shape, so the doors cannot differ. */
export function runningBodyOf(a: RdfImportRunning): { importId: string; status: 'running'; location: string; retryAt?: string } {
  return { importId: a.importId, status: 'running', location: a.location, ...(a.retryAt ? { retryAt: a.retryAt } : {}) };
}

/**
 * The space's RDF base or vocabulary is not what the door sorted the file by: the spool's grouping (a chrono's time nodes with their owner) and
 * the record count were made by the addressing the space had then, and the act reads the meta again under its hold.
 */
class SpaceChangedUnderDoor extends Error {
  constructor(readonly what: 'base' | 'schema') { super(`the space's ${what} changed under the door`); }
}

/** A door is reading a file into its spool: one at a time, instance-wide, from before the first byte until its act is registered or it answered. */
let doorHeld = false;

/**
 * Run an RDF import for a door. Never throws for a caller's mistake: every refusal is an answer. A fault that is not the caller's (the store,
 * the disk) is thrown to the door.
 */
export async function rdfImportAct(input: RdfImportInput): Promise<RdfImportAnswer> {
  const parsed = RdfImportParams.safeParse(rdfImportParamsOf(input.params));
  if (!parsed.success) return refusal(HTTP.BAD_REQUEST, RDF_IMPORT_BAD_PARAM, refusalOfParse(parsed.error).error);
  const p = parsed.data;
  // `schema`, `from` and the inference's thresholds (Q-955, Q-755): `from` without `schema`, and a threshold without `data` in `from`, are
  // refused by the step's one judgement. An import that names none of them is an import of data alone, as it always was.
  const infer = { functional: p.inferFunctional, minSupport: p.inferMinSupport, minConfidence: p.inferMinConfidence };
  const asksSchema = (p.schema ?? 'none') !== 'none' || p.from !== undefined || Object.values(infer).some(v => v !== undefined);
  const schema = asksSchema ? rdfImportSchemaStep().schemaAskedOf(p.schema, p.from, infer) : null;
  if (schema?.kind === 'refused') return schema;
  const cfg = getConfig();
  // The one existence rule: an id that is not a configured space (a view included: an import writes into a space) is answered as missing.
  const unknown = unknownSpaceAnswer(null, input.spaceId, false, cfg);
  if (unknown) return refusal(unknown.status, unknown.body.code ?? 'space_not_found', unknown.body.error);
  // With `schema` set the import writes the space's type schemas: `schema: write` besides the import's own rung, a dry run too, before a byte is read.
  const rung = schema ? rdfImportSchemaStep().schemaRungRefusal(input.spaceId, input.caller) : null;
  if (rung) return rung;
  // A space another act holds (a restore, a migration, a conversion, an import) takes no import: answered with that act's own code, as every
  // write door answers it, before a byte of the file is read. A dry run writes nothing and is not asked, unless it builds a schema: it would
  // answer by a schema the holding act may yet change (C7).
  const closed = p.dryRun === true && schema === null ? null : spaceWriteClosedNow(input.spaceId);
  if (closed) return refusal(closed.status, closed.body.code, closed.body.error);
  const read = rdfFormatOf(p.format, input.contentType, input.contentEncoding, 'the import');
  if (!read.ok) return read.refusal;
  const format = read.format;
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
  knobs.hooks?.afterDoorTaken?.();
  let released = false;
  const releaseDoor = (): void => { if (!released) { released = true; doorHeld = false; } };
  try {
    return await readAndRun(input, options, state.meta, p.dryRun === true, releaseDoor, schema);
  } finally {
    releaseDoor();
  }
}

/**
 * The door's own pass and what follows it: the file into its sorted spool and the bounds that need no store, then the dry run inline, or the state
 * written, the act registered and waited for within the runner's budget. The act reads the store; this reads none.
 */
async function readAndRun(
  input: RdfImportInput, given: ImportOptions, meta: SpaceMeta, dryRun: boolean, releaseDoor: () => void, schema: SchemaAsked | null,
): Promise<RdfImportAnswer> {
  const importId = uuidv4();
  const dir = folderPathOf(importId)!;
  // The sweep at the start never removes a folder a door is filling.
  const releaseFolder = holdFolder(importId);
  let handedOver = false;
  let kept: RdfImportReport | undefined;
  /** What the caller gave, and then the source the file names for itself when it gave none (R2): the one set of options the sort, the act and a dry run read. */
  let options = given;
  try {
    const folder = await openImportFolder(dir);
    const seen: GraphsSeen = { order: [], describing: new Set(), inDefaultGraph: false };
    const quads = parseRdf(counted(input.body, importBodyMaxBytes(getConfig()), 'rdf-import', knobs.uploadIdleMs), options.format, { blankNodePrefix: `b${importId.slice(0, 8)}-` });
    let sorted = await sortedSpool(noteGraphs(quads, seen), folder, { names: addressNames(meta, options.source), bounds: knobs.bounds ?? {} });
    const missing = graphsWithoutBase(seen, options);
    if (missing.length > 0) {
      return refusal(HTTP.BAD_REQUEST, RDF_IMPORT_SEVERAL_GRAPHS, `The file holds ${seen.order.length - seen.describing.size} data graphs and ${missing.length} of them have no source base: `
        + 'name one per graph in graphBase ("<graph address> <source base>"), or import one graph at a time', { graphsWithoutBase: missing.slice(0, RDF_IMPORT_GRAPH_BASES_MAX) });
    }
    // The file's one data graph is its source when none was given: known only now, so the file is sorted again by the addresses it is read by.
    const fileBase = defaultSourceBase(options.format, seen, options, meta);
    if (fileBase !== null) {
      options = { ...options, source: { base: fileBase } };
      sorted = await resortedSpool(sorted, folder, { names: addressNames(meta, options.source), bounds: knobs.bounds ?? {} });
    }
    // The schema the file builds (Q-955), proposed now that the source base is settled, and judged as its write would be: a refusal here writes
    // nothing and registers nothing.
    const built = schema
      ? await rdfImportSchemaStep().schemaAtDoor({
        spaceId: input.spaceId, caller: input.caller, options, groups: sorted.groups, schema, dryRun, maxQuads: knobs.schemaMaxQuads, maxPredicates: knobs.schemaInferMaxPredicates,
        maxClasses: knobs.schemaInferMaxClasses, maxPairs: knobs.schemaInferMaxPairs,
      })
      : null;
    if (built?.kind === 'refused') return built;
    // What the translation reads by: with a schema, the proposal's names and the door's decisions (the groups skipped, the pairs left out).
    const by = built
      ? await rdfImportSchemaStep().translationBy(built.merged, meta, sorted.groups, built.asked.from, { skip: built.keys, notAsked: built.notAsked, leaveOut: built.leaveOut })
      : { planSchema: meta.typeSchemas ?? {}, meta };
    // The records the file will make, subjects and bare edges, counted from the spool alone: a file that cannot fit is answered 413 here. With a
    // schema the edges are counted under the names the proposal gives (Q-755 F8): a label the file declares or infers is a label here too.
    await assertRecordsWithinBound(sorted.groups(), namesByGraph(by.meta, options), sorted.subjects, knobs.maxRecords);
    const report: RdfImportReport = {
      importId, space: input.spaceId, status: dryRun ? 'dry-run' : 'running', dryRun, format: options.format, mode: options.mode,
      quads: sorted.quads, subjects: sorted.subjects, kinds: emptyKinds(), unchanged: emptyUnchanged(), reasons: [], reasonCount: 0, reasonsByCode: {}, notTaken: {},
      startedAt: new Date().toISOString(),
    };
    if (dryRun) {
      // Inline: a dry run registers no act and holds nothing, so its translation reads the store as it is when it reads it.
      if (built) report.schema = { ...built.report, written: false };
      const run: Run = { spaceId: input.spaceId, folder, builder: new ReportBuilder(report), state: null, commit: false, planSchema: by.planSchema, planMeta: null };
      await translateStage({ spaceId: input.spaceId, folder, meta: by.meta, options, groups: sorted.groups, builder: run.builder, ...decidedOf(by) });
      const outcome = run.builder.refused ? 'refused' : await planAndCommit(run);
      const done = { ...run.builder.report, endedAt: new Date().toISOString() };
      return outcome === 'refused' ? refusedAnswer({ ...done, status: 'refused' }) : { kind: 'report', status: HTTP.OK, report: done };
    }
    await writeState(folder, {
      importId, space: input.spaceId, options, sortedFile: sorted.file, phase: 'received', committed: 0, report,
      sortedBy: { ...(meta.rdf?.base !== undefined ? { base: meta.rdf.base } : {}), ...(meta.rdf?.vocab !== undefined ? { vocab: meta.rdf.vocab } : {}) },
      ...(built ? await rdfImportSchemaStep().keepSchemaStep(folder, built, input.caller) : {}),
    });
    await keepReport(report);
    kept = report;
    void sweepReports(Date.now()).catch(err => log.warn(`the RDF import report sweep failed: ${peerText(err)}`));
    await knobs.hooks?.beforeRegister?.();
    // Asked in the step that registers the act, nothing awaited between: from the registration on a caller's schema write is refused (the gate), so the
    // addressing the act reads under its hold is the one asked here. A space the import can no longer be made in is the act's first answer, not this.
    const now = rdfSpaceState(getConfig(), input.spaceId, input.caller, schemaFingerprintOf);
    if (now.ok && (now.meta.rdf?.base !== meta.rdf?.base || now.meta.rdf?.vocab !== meta.rdf?.vocab)) throw new SpaceChangedUnderDoor('base');
    // The schema the proposal was built on is the one stored now, asked in the same step: from the registration on no caller's schema write lands.
    if (built && rdfImportSchemaStep().storedVersion(input.spaceId) !== built.version) throw new SpaceChangedUnderDoor('schema');
    const entryId = registerOwnSpaceAct({ kind: KIND, localId: input.spaceId, spoolId: importId });
    handedOver = true;
    releaseFolder();
    releaseDoor();
    await knobs.hooks?.afterRegister?.();
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
  if (err instanceof SpaceChangedUnderDoor) {
    const what = err.what === 'schema' ? "The space's schema" : "The space's RDF base or vocabulary";
    return refusal(HTTP.CONFLICT, RDF_IMPORT_SPACE_CHANGED, `${what} changed while the file was being read; nothing was imported: send the file again`);
  }
  if (err instanceof RdfImportBoundExceeded) {
    return refusal(HTTP.TOO_LARGE, err.code, `The file is over the import's bound ${err.bound} (${err.limit}); nothing was imported`, { bound: err.bound, limit: err.limit });
  }
  // A stalled upload, a body over the byte bound, a file the reader refuses: the document's own failures, answered as every RDF door answers them.
  return rdfDocumentRefusalOf(err, format, NOTHING_IMPORTED);
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
    return refusal(report.failure.status, report.failure.code, report.error ?? 'The import cannot complete; nothing more is written', { importId, ...(report.failure.detail ?? {}) });
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
