/**
 * The RDF import into a space, from a request to records landed: the one act `POST /api/brain/spaces/:spaceId/import/rdf` and MCP
 * `import_rdf` run, the space act that holds the space while it lands, and the status both status doors answer (bundle-270, slice S6, Q-753;
 * plan section 3 (b)-(e), amendments A1, A3, A6, A8, A10, A11).
 *
 * ## What it prevents
 *
 * - **Two doors that differ.** Parameters, defaults, bounds, every refusal and its code, and the report are decided here; a door only reads its
 *   body off its wire and puts the answer back on it. The parameters are judged by one schema (`RdfImportParams`) before anything else runs.
 * - **A stranger's file landing half.** The door reads the whole file into a sorted spool (`rdf/import-spool.ts`), builds the import's index
 *   (bare edges counted: each is a record of it) and translates every group (`rdf/quads-to-ops.ts`) before any act is registered, answering a
 *   malformed file (400 with its place) and a file over a bound, the index's record bound included (413 naming it), itself, and a reason the
 *   space's mode refuses (409 with the report) likewise: the space is never held for a file that cannot land. The act then dry-plans every
 *   operation with the real planners (`rdf/import-plan.ts`), and only when nothing was refused commits, kind by kind in the store's order over
 *   the whole import (A1). Any refusal of a planner refuses the whole import in every mode: nothing lands, every reason is answered with its
 *   statements (named up to {@link RDF_IMPORT_REASONS_NAMED_MAX}, the rest counted), and the act ends as an input failure that RELEASES the
 *   space (A11). A reason the mode records is answered, and the import goes on. A record the dry plan refuses is not written, so the plan
 *   runs again without it until no record is judged with a refused one present (`dryPlanPass`).
 * - **A supplied id made an identity.** Every new subject's id is minted here, once, before any group is translated, and kept in the import's
 *   index (`rdf/import-index.ts`) beside its spool; an edge stated as a bare triple is minted under its triplet. The operations carry the ids
 *   into the act's folder, so a commit resumed after a crash plans the same operations under the same ids and converges onto what its first
 *   attempt landed: no record is written twice.
 * - **A space changed under the import.** The act holds the space as every act does (no other writer, its sync exchange held), and while it
 *   stands no schema write reaches the space (`schema-write-gate.ts`, A3), so the commit lands under the schema the dry plan judged by.
 * - **A dry run that is a write.** A dry run needs the import's own rung (A10), translates and dry-plans inline, registers no act, holds
 *   nothing and writes no record; its folder is removed before it answers.
 * - **A value of the file repeated.** A refusal, a report and the audit row name statements by their subject, predicate and the kind of their
 *   object; a literal is shown as its datatype and length, never its text, and a planner's refusal by its code and the fields it names.
 *
 * ## Where its files live
 *
 * `<data root>/rdf-import/<import id>/`: the sorted spool, the index, the operations per kind and the act's state, all through the master
 * secret's chunked envelope when one is configured, removed when the act ends (and by the start's sweep when no standing act names them).
 * The report of each import is kept for {@link RDF_IMPORT_REPORT_KEEP_MS} under `<data root>/rdf-import-reports/`, where the status doors read
 * it, for any token with the import's rung on the import's space.
 */
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { v4 as uuidv4, validate as isUuid } from 'uuid';
import { z } from 'zod';
import type { SpaceMeta } from '@ythril-network/schema';
import { getConfig, getDataRoot } from '../config/loader.js';
import type { SpaceActEntry } from '../config/types.js';
import { importBodyMaxBytes } from '../config/body-limits.js';
import { log, peerText, refusalOfParse } from '../util/log.js';
import { isMissingPath } from '../util/path-present.js';
import { emitWebhookEvent } from '../webhooks/dispatcher.js';
import { schemaFingerprintOf } from './schema-stamp.js';
import {
  defineSpaceActBody, defineSpaceActBootSweep, registerOwnSpaceAct, runSpaceAct, spaceActsOfKind, type SpaceActBodyOutcome,
} from './space-act-runner.js';
import { awaitDoorActs } from './door-acts.js';
import { spaceActFailureAnswer } from './space-act-failure.js';
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
import { ythrilIri } from '../rdf/ythril-vocabulary.js';
import type { ImportMode } from '../rdf/import-reasons.js';
import {
  RdfImportBoundExceeded, openImportFolder, openOperationSpool, readSpoolLines, removeImportFolder, removeOperations,
  sortedSpool, writeWholeSpoolFile, type ImportFolder, type ImportSpoolBounds, type QuadGroup,
} from '../rdf/import-spool.js';
import { ImportIndex, type IndexedRecord } from '../rdf/import-index.js';
import {
  groupSubjectOf, quadsToOps, recordKey, recordKindOfGroup, tripletsOfGroup, type MintedRecord, type QuadsToOpsContext, type RecordOp,
} from '../rdf/quads-to-ops.js';
import {
  STORED_RECORD_LINKS_OVER_BOUND, StoredRecordUnreadable, commitWindow, dryPlanWindow, importReadSet, loadStoredRecords, seededIdOf, type MintedEnd,
} from '../rdf/import-plan.js';

const KIND = 'rdf-import' as const;

/** The folder under the data root that holds the files of standing RDF imports. */
export const RDF_IMPORT_DIR = 'rdf-import';
/** The folder under the data root that holds the reports of RDF imports. */
export const RDF_IMPORT_REPORT_DIR = 'rdf-import-reports';
/** How long an import's report is kept for the status doors. */
export const RDF_IMPORT_REPORT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** Operations planned and committed per window. */
const WINDOW_DEFAULT = 500;
/** The longest address a parameter may carry (the tool's input schema states the same bound). */
export const RDF_IMPORT_ADDRESS_MAX = 2048;
/** The most per-graph source bases one request names. */
export const RDF_IMPORT_GRAPH_BASES_MAX = 64;
/** A graph base is `"<graph address> <source base>"`: at least one character each side of the space, and at most two addresses and the space. */
export const RDF_IMPORT_GRAPH_BASE_MIN_CHARS = 3;
export const RDF_IMPORT_GRAPH_BASE_MAX_CHARS = RDF_IMPORT_ADDRESS_MAX * 2 + 1;
/** The bytes of a record key's digest in the act's sets: 128 bits, so a collision is not a thing a file can plan. */
const KEY_DIGEST_BYTES = 16;
/** The HTTP statuses the act and its doors answer with, each named, so no refusal below carries a bare number. */
const HTTP = { OK: 200, ACCEPTED: 202, BAD_REQUEST: 400, NOT_FOUND: 404, CONFLICT: 409, GONE: 410, TOO_LARGE: 413, UNSUPPORTED_MEDIA: 415, UNPROCESSABLE: 422, UNAVAILABLE: 503 } as const;
const OP_ORDER = IMPORT_OP_ORDER;

// ── Refusal codes ─────────────────────────────────────────────────────────────────────────────────────────────

export const RDF_IMPORT_REFUSED = 'rdf_import_refused';
export const RDF_IMPORT_BAD_PARAM = 'rdf_import_bad_param';
export const RDF_IMPORT_SCHEMA_NOT_AVAILABLE = 'rdf_import_schema_not_available';
export const RDF_IMPORT_SEVERAL_GRAPHS = 'rdf_import_several_graphs';
export const RDF_IMPORT_NOT_FOUND = 'rdf_import_not_found';
export const RDF_IMPORT_BUSY = 'rdf_import_busy';
export const RDF_IMPORT_UNSUPPORTED_ENCODING = 'rdf_unsupported_encoding';
export const RDF_IMPORT_BODY_TOO_LARGE_BOUND = 'importBodyMaxBytes';

/** Every code an import door or a status door answers of its own. */
export const RDF_IMPORT_REFUSAL_CODES: readonly string[] = Object.freeze([
  RDF_IMPORT_REFUSED, RDF_IMPORT_BAD_PARAM, RDF_IMPORT_SCHEMA_NOT_AVAILABLE, RDF_IMPORT_SEVERAL_GRAPHS, RDF_IMPORT_NOT_FOUND, RDF_IMPORT_BUSY,
  RDF_IMPORT_UNSUPPORTED_ENCODING, 'rdf_malformed', 'rdf_bound_exceeded', 'rdf_unsupported_format', 'rdf_not_enabled',
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
  hooks?: { beforeCommit?: () => unknown; afterCommitWindow?: (committed: number) => void };
}
let knobs: RdfImportKnobs = {};
/** Replace the figures and hooks a test sets, or all of them with `null`. */
export function setRdfImportKnobsForTest(k: RdfImportKnobs | null): void { knobs = k ?? {}; }
const windowSize = (): number => knobs.window ?? WINDOW_DEFAULT;

// ── Files ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The folder of import `id`, or null when the id is not one the door mints (so it cannot leave the import root). */
function folderPathOf(id: string): string | null {
  if (!isUuid(id)) return null;
  const root = path.join(getDataRoot(), RDF_IMPORT_DIR);
  const dir = path.join(root, id);
  return path.dirname(dir) === root ? dir : null;
}

const STATE_FILE = 'state.spool';
const reportFile = (id: string): string => `${id}.spool`;
const reportFolder = (): Promise<ImportFolder> => openImportFolder(path.join(getDataRoot(), RDF_IMPORT_REPORT_DIR));

/** What the act keeps beside its spool so a resumed act goes on where it was. */
interface ActState {
  importId: string;
  space: string;
  options: ImportOptions;
  /** Where the act stands: the door's pass ended with the translation, so the act begins at `translated`. */
  phase: 'translated' | 'planned' | 'committing';
  committed: number;
  report: RdfImportReport;
}

async function writeState(folder: ImportFolder, state: ActState): Promise<void> {
  await writeWholeSpoolFile(folder, STATE_FILE, [JSON.stringify(state)]);
}

async function readState(folder: ImportFolder): Promise<ActState> {
  for await (const line of readSpoolLines(folder, STATE_FILE)) return JSON.parse(line) as ActState;
  throw new Error('The import state is empty.');
}

/** Keep `report` for the status doors. */
async function keepReport(report: RdfImportReport): Promise<void> {
  await writeWholeSpoolFile(await reportFolder(), reportFile(report.importId), [JSON.stringify(report)]);
}

/** The report of import `id`, or null when none is kept. */
async function readReport(id: string): Promise<RdfImportReport | null> {
  try {
    for await (const line of readSpoolLines(await reportFolder(), reportFile(id))) return JSON.parse(line) as RdfImportReport;
  } catch (err) {
    if (isMissingPath(err)) return null;
    throw err;
  }
  return null;
}

/** Remove the reports older than the keep window. */
async function sweepReports(now: number): Promise<void> {
  const dir = path.join(getDataRoot(), RDF_IMPORT_REPORT_DIR);
  let names: string[];
  try { names = await fsp.readdir(dir); } catch (err) { if (isMissingPath(err)) return; throw err; }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (now - (await fsp.stat(file)).mtimeMs > RDF_IMPORT_REPORT_KEEP_MS) await fsp.rm(file, { force: true });
    } catch (err) { if (!isMissingPath(err)) log.warn(`an RDF import report could not be swept (${peerText(name)}): ${peerText(err)}`); }
  }
}

// ── The passes ────────────────────────────────────────────────────────────────────────────────────────────────

/** How an import reads its file: the space's mode, blank subjects, and the source bases (one for the file, one per graph). */
interface ImportOptions {
  format: RdfFormat;
  mode: ImportMode;
  blankNodes: 'refuse' | 'mint';
  source?: { base: string; vocab?: string };
  graphBases: Record<string, string>;
}

/** The address names of each graph: its own source base when one was given for it, else the file's. */
function namesByGraph(meta: SpaceMeta, options: ImportOptions): (graph: string | undefined) => AddressNames {
  const fileNames = addressNames(meta, options.source);
  const perGraph = new Map(Object.entries(options.graphBases).map(([g, base]) => [g, addressNames(meta, { base })]));
  return (graph) => (graph !== undefined ? perGraph.get(graph) ?? fileNames : fileNames);
}

/** A set of keys held as 128-bit digests: the triplets a file asserts and reifies, at a fixed cost per triplet. */
class DigestSet extends Set<string> {
  private static digest(key: string): string {
    return createHash('sha256').update(key).digest().subarray(0, KEY_DIGEST_BYTES).toString('latin1');
  }
  override add(key: string): this { return super.add(DigestSet.digest(key)); }
  override has(key: string): boolean { return super.has(DigestSet.digest(key)); }
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
 * What the door's translation works with: the sorted file's groups, the space's meta and the options the file is read under. The index and
 * the translation are the door's, before any act is registered, so a bound they meet (the index's record bound, bare edges counted) is a 413
 * at the door and a stored record they cannot read is a refusal in the report, never an act that fails after the caller was told 202.
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
 * The door's passes, in order: every subject's kind and id (the index), then every group translated into operations. Reasons are the
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
    const result = await dryPlanWindow(run.spaceId, w, kind === 'edge' ? edges : importReadSet(run.spaceId), seeds);
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
    await commitWindow(run.spaceId, rest, minted);
    knobs.hooks?.afterCommitWindow?.(state.committed + rest.length);
    state.committed += rest.length;
    await writeState(run.folder, state);
  }
}

/**
 * Run the act's passes from where `run.state` stands (a dry run from the start, with no state), the translation having been the door's.
 * Answers the report's status; never writes a record before every operation was dry-planned without a refusal.
 */
async function planAndCommit(run: Run): Promise<'refused' | 'planned' | 'completed'> {
  const state = run.state;
  const persist = async (phase: ActState['phase']): Promise<void> => {
    if (!state) return;
    state.phase = phase;
    state.report = run.builder.report;
    await writeState(run.folder, state);
    await keepReport(run.builder.report);
  };
  const minted = await mintedEndsOf(run.folder);
  if (!state || state.phase === 'translated') {
    run.builder = await dryPlanPass(run, minted);
    if (run.builder.refused) return 'refused';
    await persist('planned');
  }
  if (!run.commit) return 'planned';
  if (state!.phase === 'planned') await persist('committing');
  await commitPass(run, minted);
  return 'completed';
}

// ── The act's body ────────────────────────────────────────────────────────────────────────────────────────────

/** The import's body: run the passes from its state, then (after the completion write) remove its folder. */
async function rdfImportBody({ entry }: { entry: Readonly<SpaceActEntry> }): Promise<SpaceActBodyOutcome> {
  const id = entry.spoolId ?? '';
  const dir = folderPathOf(id);
  const forget = async (): Promise<void> => { if (dir) await removeImportFolder(dir); };
  const gone = async (status: number, why: string): Promise<SpaceActBodyOutcome> => {
    const kept = await readReport(id).catch(() => null);
    if (kept) await keepReport({ ...kept, status: 'failed', error: why, endedAt: new Date().toISOString() }).catch(() => undefined);
    return { failedFinally: { status, message: `The RDF import into space '${entry.localId}' cannot complete: ${why} Nothing more is written.` }, afterCompletion: forget };
  };
  if (!dir) return gone(HTTP.GONE, 'its files are not named by an id this instance minted.');
  try { await fsp.access(dir); } catch (err) {
    if (isMissingPath(err)) return gone(HTTP.GONE, 'its files are no longer on disk.');
    throw err;
  }
  const folder = await openImportFolder(dir);
  let state: ActState;
  try { state = await readState(folder); } catch (err) {
    if (isMissingPath(err) || err instanceof SyntaxError) return gone(HTTP.UNPROCESSABLE, 'its state can no longer be read.');
    throw err;
  }
  const cfg = getConfig();
  const space = rdfSpaceState(cfg, entry.localId, undefined, schemaFingerprintOf);
  if (!space.ok) return gone(HTTP.CONFLICT, `RDF is no longer usable on the space (${space.code}).`);
  const run: Run = { spaceId: entry.localId, folder, builder: new ReportBuilder(state.report), state, commit: true };
  const outcome = await planAndCommit(run);
  const report = { ...run.builder.report, endedAt: new Date().toISOString() };
  if (outcome === 'refused') {
    await keepReport({ ...report, status: 'refused' });
    return {
      failedFinally: {
        status: HTTP.CONFLICT,
        message: `The RDF import into space '${entry.localId}' was refused: ${report.reasonCount} reason(s), nothing was written; `
          + `its report is at GET /api/brain/spaces/${entry.localId}/import/rdf/${id}.`,
      },
      afterCompletion: forget,
    };
  }
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

/** The start's sweep: every import folder no standing import names is removed, and every report past its keep window. */
function sweepOrphans(standing: readonly SpaceActEntry[]): void {
  const named = new Set(standing.map(e => e.spoolId).filter((x): x is string => typeof x === 'string'));
  const root = path.join(getDataRoot(), RDF_IMPORT_DIR);
  void (async () => {
    let names: string[];
    try { names = await fsp.readdir(root); } catch (err) { if (isMissingPath(err)) names = []; else throw err; }
    for (const name of names) {
      const dir = folderPathOf(name);
      if (named.has(name) || !dir) continue;
      try { await removeImportFolder(dir); log.info(`removed an RDF import folder no standing import names: ${peerText(name)}`); }
      catch (err) { log.warn(`an RDF import folder no standing import names could not be removed (${peerText(name)}): ${peerText(err)}`); }
    }
    await sweepReports(Date.now());
  })().catch(err => log.warn(`the RDF import sweep failed: ${peerText(err)}`));
}

defineSpaceActBody(KIND, rdfImportBody);
defineSpaceActBootSweep(KIND, sweepOrphans);

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

export type RdfImportAnswer =
  | RdfImportDone
  | { kind: 'running'; status: typeof HTTP.ACCEPTED; importId: string; location: string }
  | RdfImportRefusal;

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

/** A door is reading a file into its spool: one at a time, instance-wide, from before the first byte until it answered. */
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
  if (doorHeld) return refusal(HTTP.CONFLICT, RDF_IMPORT_BUSY, 'Another RDF import is being read in on this instance: try again when it has been answered');
  doorHeld = true;
  try {
    return await readAndRun(input, options, state.meta, p.dryRun === true);
  } finally {
    doorHeld = false;
  }
}

/** The door's own pass and what follows it: the file into its spool, then the dry run inline or the act registered and waited for. */
async function readAndRun(input: RdfImportInput, options: ImportOptions, meta: SpaceMeta, dryRun: boolean): Promise<RdfImportAnswer> {
  const importId = uuidv4();
  const dir = folderPathOf(importId)!;
  const folder = await openImportFolder(dir);
  let handedOver = false;
  try {
    const seen: GraphsSeen = { order: [], describing: new Set() };
    const quads = parseRdf(counted(input.body, importBodyMaxBytes(getConfig())), options.format, { blankNodePrefix: `b${importId.slice(0, 8)}-` });
    const sorted = await sortedSpool(noteGraphs(quads, seen), folder, { names: addressNames(meta, options.source), bounds: knobs.bounds ?? {} });
    const missing = graphsWithoutBase(seen, options);
    if (missing.length > 0) {
      return refusal(HTTP.BAD_REQUEST, RDF_IMPORT_SEVERAL_GRAPHS, `The file holds ${seen.order.length - seen.describing.size} data graphs and ${missing.length} of them have no source base: `
        + 'name one per graph in graphBase ("<graph address> <source base>"), or import one graph at a time', { graphsWithoutBase: missing.slice(0, RDF_IMPORT_GRAPH_BASES_MAX) });
    }
    const report: RdfImportReport = {
      importId, space: input.spaceId, status: dryRun ? 'dry-run' : 'running', dryRun, format: options.format, mode: options.mode,
      quads: sorted.quads, subjects: sorted.subjects, kinds: emptyKinds(), reasons: [], reasonCount: 0, reasonsByCode: {}, notTaken: {},
      startedAt: new Date().toISOString(),
    };
    // The index and the translation are the door's, before any act is registered: a bound they meet answers 413 here (nothing registered, no
    // report kept), and a refusal of the translation answers 409 with the report, the space never held.
    const run: Run = { spaceId: input.spaceId, folder, builder: new ReportBuilder(report), state: null, commit: false };
    await translateStage({ spaceId: input.spaceId, folder, meta, options, groups: sorted.groups, builder: run.builder });
    if (dryRun) {
      const outcome = run.builder.refused ? 'refused' : await planAndCommit(run);
      const done = { ...run.builder.report, endedAt: new Date().toISOString() };
      return outcome === 'refused' ? refusedAnswer({ ...done, status: 'refused' }) : { kind: 'report', status: HTTP.OK, report: done };
    }
    if (run.builder.refused) {
      const refused: RdfImportReport = { ...run.builder.report, status: 'refused', endedAt: new Date().toISOString() };
      await keepReport(refused);
      return refusedAnswer(refused);
    }
    await writeState(folder, { importId, space: input.spaceId, options, phase: 'translated', committed: 0, report: run.builder.report });
    await keepReport(run.builder.report);
    void sweepReports(Date.now()).catch(err => log.warn(`the RDF import report sweep failed: ${peerText(err)}`));
    let entryId: string;
    try {
      entryId = registerOwnSpaceAct({ kind: KIND, localId: input.spaceId, spoolId: importId });
    } catch (err) {
      // Never registered (shutdown closed the runner): the report kept a moment ago must not say "running" for seven days.
      await keepReport({ ...report, status: 'failed', error: 'The import was not registered: the instance was shutting down. Nothing was written.' });
      throw err;
    }
    handedOver = true;
    return await waitForAct(input.spaceId, importId, entryId);
  } catch (err) {
    const answer = doorRefusalOf(err, options.format);
    if (answer) return answer;
    throw err;
  } finally {
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

/** Wait for the act within the runner's budget: 200 with its report, 409 with a refusal's, 202 while it runs, the failure's own answer else. */
async function waitForAct(spaceId: string, importId: string, entryId: string): Promise<RdfImportAnswer> {
  const location = `/api/brain/spaces/${encodeURIComponent(spaceId)}/import/rdf/${importId}`;
  const wait = await awaitDoorActs([entryId], [runSpaceAct(entryId, { waiter: true, via: 'door' }).then(r => [r])]);
  if (!wait.finished) return { kind: 'running', status: HTTP.ACCEPTED, importId, location };
  const settled = wait.results[0]!;
  const report = await readReport(importId);
  if (settled.ok && report) return { kind: 'report', status: HTTP.OK, report };
  if (report?.status === 'refused') return refusedAnswer(report);
  if (settled.interrupted) return refusal(HTTP.UNAVAILABLE, 'shutting down', 'shutting down; the import resumes after the next start', { importId });
  const failure = spaceActFailureAnswer(settled.cause ?? new Error(settled.error ?? 'the import did not complete'), 'local', `rdf import '${spaceId}'`);
  return refusal(failure.status, String(failure.body.code ?? 'space_act_failed'), failure.body.error, { importId, ...(settled.retryAt ? { retryAt: settled.retryAt } : {}) });
}

// ── The status door ───────────────────────────────────────────────────────────────────────────────────────────

/** What an import did or is doing, for a caller with the import's rung on its space. */
export async function rdfImportStatusAct(input: { spaceId: string; params: Record<string, unknown> }): Promise<RdfImportDone | RdfImportRefusal> {
  const parsed = RdfImportStatusParams.safeParse({ importId: input.params['importId'] });
  if (!parsed.success) return refusal(HTTP.BAD_REQUEST, RDF_IMPORT_BAD_PARAM, refusalOfParse(parsed.error).error);
  const unknown = unknownSpaceAnswer(null, input.spaceId);
  if (unknown) return refusal(unknown.status, unknown.body.code ?? 'space_not_found', unknown.body.error);
  const report = await readReport(parsed.data.importId);
  // Another space's import is answered as one that does not exist: its id says nothing to a caller of this space.
  if (!report || report.space !== input.spaceId) return refusal(HTTP.NOT_FOUND, RDF_IMPORT_NOT_FOUND, 'No import of this space has that id (a report is kept for seven days)');
  return { kind: 'report', status: HTTP.OK, report };
}
