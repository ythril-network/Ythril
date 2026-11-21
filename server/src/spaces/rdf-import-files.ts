/**
 * The files an RDF import leaves on disk, and who may remove them (bundle-270, second review F8, F9 and F12; slice S6, Q-753).
 *
 * ## Where they live
 *
 * `<data root>/rdf-import/<import id>/`: the sorted spool, the index, the operations per kind and the act's state, all through the master
 * secret's chunked envelope when one is configured, removed when the act ends. The report of each import is kept for
 * {@link RDF_IMPORT_REPORT_KEEP_MS} under `<data root>/rdf-import-reports/`, where the status doors read it.
 *
 * ## What it prevents, because the rule is inside
 *
 * - **A sweep that removes a live upload.** The start's sweep removed every folder no standing import names, and a door that had just received a
 *   file (a client that re-sends its upload right after a restart) has a folder no act names yet. A door holds its folder from the moment it
 *   makes it until its act is registered or it gave up ({@link holdFolder}), and the sweep asks the live answer for each folder before it removes
 *   it ({@link sweepRdfImportOrphans}): a folder is removed only when it is held by no door and named by no standing act, so a caller of the
 *   sweep cannot forget the hold.
 * - **A report served past its life.** {@link readReport} answers `null` for a report older than the keep window, whether or not the sweep has
 *   run, so a caller never reads a file the sweep would remove.
 * - **A space's files that outlive it.** {@link dropRdfImportsOfSpace} removes the reports and folders of a deleted space; the space deletion's
 *   cleanup list calls it, so a space created later under the id shows nothing of the old one. {@link renameRdfImportsOfSpace} is its twin for a rename
 *   (the rename's data move calls it): the files follow the space to its new id, by the same walk, so the old id is left with none.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { validate as isUuid } from 'uuid';
import { getDataRoot } from '../config/loader.js';
import { log, peerText } from '../util/log.js';
import { isMissingPath } from '../util/path-present.js';
import type { RdfFormat } from '../rdf/serialize.js';
import type { ImportMode } from '../rdf/import-reasons.js';
import type { RdfImportReport, RdfImportSchemaReport } from '../rdf/import-report.js';
import { openImportFolder, readSpoolLines, removeImportFolder, writeWholeSpoolFile, type ImportFolder, type QuadGroup } from '../rdf/import-spool.js';
import type { SpaceMeta } from '@ythril-network/schema';
import type { TokenRights } from '../config/rights-shape.js';
import type { RdfCaller } from '../rdf/rdf-space-state.js';
import type { RdfDocumentRefusal } from '../rdf/rdf-document.js';
import type { SchemaMode, SchemaSource } from '../rdf/schema-from-rdf.js';

/** The folder under the data root that holds the files of standing RDF imports. */
export const RDF_IMPORT_DIR = 'rdf-import';
/** The folder under the data root that holds the reports of RDF imports. */
export const RDF_IMPORT_REPORT_DIR = 'rdf-import-reports';
/** How long an import's report is kept for the status doors. */
export const RDF_IMPORT_REPORT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The longest address a parameter of an RDF import door may carry (the tools' input schemas state the same bound). Here, in the leaf both import
 * acts read, so the schema door and the data import (which calls the schema door's shared step) import no act of the other's.
 */
export const RDF_IMPORT_ADDRESS_MAX = 2048;

/** The file name of an import's schema step in its folder (`SchemaStepFile`). */
const SCHEMA_STEP_FILE = 'schema.spool';

/**
 * The schema an import with `schema` set builds (Q-955), kept in its own file beside the spool so the state stays small: the types the file
 * changes (what the write sends), the type schemas the space would hold after it in their stored form (`$ref`s kept: what the dry plan judges by),
 * and what the report names of it.
 */
export interface SchemaStepFile {
  changed: Record<string, Record<string, unknown>>;
  merged: SpaceMeta['typeSchemas'];
  typesAdded: string[];
  typesChanged: string[];
  fingerprintBefore: string;
}

export async function writeSchemaStep(folder: ImportFolder, step: SchemaStepFile): Promise<void> {
  await writeWholeSpoolFile(folder, SCHEMA_STEP_FILE, [JSON.stringify(step)]);
}

export async function readSchemaStep(folder: ImportFolder): Promise<SchemaStepFile> {
  for await (const line of readSpoolLines(folder, SCHEMA_STEP_FILE)) return JSON.parse(line) as SchemaStepFile;
  throw new Error('The import\'s schema step is empty.');
}

/** What an import with `schema` asks for: the schema door's mode, and the declarations it reads. */
export interface SchemaAsked { kind: 'asked'; mode: SchemaMode; from: SchemaSource[] }

/**
 * The schema the door built: the changed types (what the write sends) and the version they were proposed against, how many changes they make,
 * the type schemas the space holds after the write (stored form), the schema groups they came from, and what the report says of them.
 */
export interface DoorSchema {
  kind: 'built';
  changed: Record<string, Record<string, unknown>>;
  version: number;
  changes: number;
  merged: SpaceMeta['typeSchemas'];
  keys: Set<string>;
  report: Omit<RdfImportSchemaReport, 'written'>;
}

/** How an act with a schema step ends for good: its status, code, sentence, and what more its answer carries. */
export interface SchemaStepEnd { kind: 'ended'; status: number; code: string; why: string; detail?: Record<string, unknown> }
/** A schema step done: the stored type schemas the planners judge and stamp by from now on, and what the report says of the step. */
export interface SchemaStepDone { kind: 'done'; typeSchemas: SpaceMeta['typeSchemas']; report: RdfImportSchemaReport }

/**
 * The schema step's functions (`rdf-import-schema-step.ts`), as the import act calls them. The step reaches the settings write chain, whose
 * modules sit in one import cycle with the tools; the act importing the step would pull the act and its tool into that cycle
 * (`check-i-architecture-dependency-direction`), so the step registers itself here and the act asks for it ({@link rdfImportSchemaStep}).
 */
export interface RdfImportSchemaStep {
  schemaAskedOf(schema: string | undefined, from: readonly string[] | undefined): SchemaAsked | null | RdfDocumentRefusal;
  schemaRungRefusal(spaceId: string, caller: RdfCaller | undefined): RdfDocumentRefusal | null;
  schemaAtDoor(input: {
    spaceId: string; caller: RdfCaller | undefined; options: ImportOptions; groups: () => AsyncGenerator<QuadGroup, void, undefined>; schema: SchemaAsked;
    dryRun: boolean; maxQuads: number | undefined;
  }): Promise<DoorSchema | RdfDocumentRefusal>;
  keepSchemaStep(folder: ImportFolder, built: DoorSchema, caller: RdfCaller | undefined): Promise<Pick<ActState, 'schemaStep' | 'caller'>>;
  schemaStepOfFolder(folder: ImportFolder, state: ActState): Promise<(SchemaStepFile & { kind: 'file' }) | null | SchemaStepEnd>;
  schemaStepBlocks(state: ActState, spaceId: string, rdfCode: string | null): SchemaStepEnd | null;
  translationBy(merged: SpaceMeta['typeSchemas'], meta: SpaceMeta, groups: () => AsyncGenerator<QuadGroup, void, undefined>, keys?: Set<string>):
    Promise<{ planSchema: SpaceMeta['typeSchemas']; meta: SpaceMeta; skip: Set<string> }>;
  writeSchemaOfAct(input: { spaceId: string; state: ActState; step: SchemaStepFile; hooks?: { beforeSchemaWrite?: () => unknown; afterSchemaWrite?: () => unknown } }):
    Promise<SchemaStepEnd | SchemaStepDone>;
  storedVersion(spaceId: string): number;
}

let schemaStepImpl: RdfImportSchemaStep | null = null;
/** Register the schema step (its own module does, when it is loaded: the import's REST route loads it). */
export function defineRdfImportSchemaStep(step: RdfImportSchemaStep): void { schemaStepImpl = step; }
/** The registered schema step; a server whose wiring never loaded it is a fault, thrown, never a refusal of the caller. */
export function rdfImportSchemaStep(): RdfImportSchemaStep {
  if (!schemaStepImpl) throw new Error('The RDF import\'s schema step is not wired: rdf-import-schema-step.ts was never loaded.');
  return schemaStepImpl;
}

/** How an import reads its file: the space's mode, blank subjects, and the source bases (one for the file, one per graph). */
export interface ImportOptions {
  format: RdfFormat;
  mode: ImportMode;
  blankNodes: 'refuse' | 'mint';
  source?: { base: string; vocab?: string };
  graphBases: Record<string, string>;
}

/** What the act keeps beside its spool so a resumed act goes on where it was. */
export interface ActState {
  importId: string;
  space: string;
  options: ImportOptions;
  /** The sorted file the door left in the folder (`SortedSpool.file`): the act reads its groups back with it. */
  sortedFile: string;
  /**
   * Where the act stands: `received` (the door has the file sorted; the act translates it under its hold), `translated`, `planned`,
   * `committing`.
   */
  phase: 'received' | 'translated' | 'planned' | 'committing';
  committed: number;
  report: RdfImportReport;
  /**
   * The space's RDF base and vocabulary the door sorted the file by (a chrono entry's time nodes belong to their record by them, and the record count
   * is made by them). The act reads them again under its hold and, before its first window, ends as an input failure when they differ (R4): a schema
   * the network decided can change them after the act was registered. Absent in a state written before this was kept: nothing is compared then.
   */
  sortedBy?: { base?: string; vocab?: string };
  /**
   * The type schemas the dry plan and every commit window judge by: read once under the hold (when the translation began) and kept here, so a
   * schema that arrives from a network meanwhile governs the writes after the import, never half of it.
   */
  planSchema?: SpaceMeta['typeSchemas'];
  /**
   * An import with `schema` set (Q-955): the version of the meta the door's proposal read (the act ends when it moved before the translation),
   * the fingerprint the space's schema has once the proposal is written (a resume that finds it stored writes nothing again), and how many
   * changes the proposal makes (none: nothing is written). The proposal itself is in its own file ({@link readSchemaStep}). Absent in a state
   * written before the schema step existed, and in an import without `schema`: the act runs as it always did.
   */
  schemaStep?: { version: number; fingerprint: string; changes: number };
  /**
   * Who started an import with `schema` set: the act writes the schema as that caller, reads its token again by `id` before the write
   * (`stored`: the id was a stored token's when the door read it), and the audit names it. Absent without `schemaStep`.
   */
  caller?: { id?: string; rights?: TokenRights | null; stored: boolean };
}

/** The folder of import `id`, or null when the id is not one the door mints (so it cannot leave the import root). */
export function folderPathOf(id: string): string | null {
  if (!isUuid(id)) return null;
  const root = path.join(getDataRoot(), RDF_IMPORT_DIR);
  const dir = path.join(root, id);
  return path.dirname(dir) === root ? dir : null;
}

const STATE_FILE = 'state.spool';
const reportFile = (id: string): string => `${id}.spool`;
const reportFolder = (): Promise<ImportFolder> => openImportFolder(path.join(getDataRoot(), RDF_IMPORT_REPORT_DIR));

export async function writeState(folder: ImportFolder, state: ActState): Promise<void> {
  await writeWholeSpoolFile(folder, STATE_FILE, [JSON.stringify(state)]);
}

export async function readState(folder: ImportFolder): Promise<ActState> {
  for await (const line of readSpoolLines(folder, STATE_FILE)) return JSON.parse(line) as ActState;
  throw new Error('The import state is empty.');
}

/** Keep `report` for the status doors. */
export async function keepReport(report: RdfImportReport): Promise<void> {
  await writeWholeSpoolFile(await reportFolder(), reportFile(report.importId), [JSON.stringify(report)]);
}

/** The report of import `id`, or null when none is kept or the one kept is past its life. */
export async function readReport(id: string, now: number = Date.now()): Promise<RdfImportReport | null> {
  try {
    const folder = await reportFolder();
    if (now - (await fsp.stat(path.join(folder.dir, reportFile(id)))).mtimeMs > RDF_IMPORT_REPORT_KEEP_MS) return null;
    for await (const line of readSpoolLines(folder, reportFile(id))) return JSON.parse(line) as RdfImportReport;
  } catch (err) {
    if (isMissingPath(err)) return null;
    throw err;
  }
  return null;
}

/** Remove the reports older than the keep window. */
export async function sweepReports(now: number): Promise<void> {
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

// ── The folders a door holds ──────────────────────────────────────────────────────────────────────────────────

const held = new Set<string>();

/** Hold the folder of import `id` for a door that is filling it; the answer releases the hold (once, whatever the number of calls). */
export function holdFolder(id: string): () => void {
  held.add(id);
  return () => { held.delete(id); };
}

/** Is a folder removable: held by no door and named by no standing act, as of now. */
const removable = (name: string, standing: (id: string) => boolean): boolean => !held.has(name) && !standing(name);

/**
 * The start's sweep: every import folder no door holds and no standing import names is removed (the answer is asked again before each removal,
 * since a door may register its act while the sweep walks), and every report past its keep window.
 */
export async function sweepRdfImportOrphans(standing: (id: string) => boolean): Promise<void> {
  const root = path.join(getDataRoot(), RDF_IMPORT_DIR);
  let names: string[];
  try { names = await fsp.readdir(root); } catch (err) { if (isMissingPath(err)) names = []; else throw err; }
  for (const name of names) {
    const dir = folderPathOf(name);
    if (!dir || !removable(name, standing)) continue;
    try { await removeImportFolder(dir); log.info(`removed an RDF import folder no standing import names: ${peerText(name)}`); }
    catch (err) { log.warn(`an RDF import folder no standing import names could not be removed (${peerText(name)}): ${peerText(err)}`); }
  }
  await sweepReports(Date.now());
}

/**
 * What to do with each report and each import folder that names a space: the one walk the deletion and the rename share, so neither can miss a file
 * the other finds (the walk reads a report at any age, a folder by its state, and skips what is not named by an id this instance minted).
 */
async function forEachImportOfSpace(spaceId: string, on: {
  report: (file: string, report: RdfImportReport) => Promise<void>;
  folder: (dir: string, state: ActState) => Promise<void>;
}): Promise<void> {
  const reports = path.join(getDataRoot(), RDF_IMPORT_REPORT_DIR);
  let names: string[] = [];
  try { names = await fsp.readdir(reports); } catch (err) { if (!isMissingPath(err)) throw err; }
  for (const name of names) {
    const id = name.replace(/\.spool$/, '');
    if (!isUuid(id)) continue;
    const report = await readReport(id, 0).catch(() => null);
    if (report?.space === spaceId) await on.report(path.join(reports, name), report);
  }
  const root = path.join(getDataRoot(), RDF_IMPORT_DIR);
  try { names = await fsp.readdir(root); } catch (err) { if (isMissingPath(err)) return; throw err; }
  for (const name of names) {
    const dir = folderPathOf(name);
    if (!dir) continue;
    const state = await readState(await openImportFolder(dir)).catch(() => null);
    if (state?.space === spaceId) await on.folder(dir, state);
  }
}

/** Remove the reports and the import folders of `spaceId`: the space was deleted, and the files that name it go with it. */
export async function dropRdfImportsOfSpace(spaceId: string): Promise<void> {
  await forEachImportOfSpace(spaceId, {
    report: (file) => fsp.rm(file, { force: true }),
    folder: (dir) => removeImportFolder(dir),
  });
}

/**
 * Move the reports and the import folders of `oldId` to `newId`: the space was renamed, and its imports are its own history, as its files are. The
 * id inside each is rewritten (a report keeps its age, so the keep window does not start again; a folder's state and the report it carries both
 * name the space). Left under the old id, a space created later under it could read them. Idempotent: a file already rewritten names `newId`
 * and is not walked again, so a resumed rename does the rest.
 */
export async function renameRdfImportsOfSpace(oldId: string, newId: string): Promise<void> {
  await forEachImportOfSpace(oldId, {
    report: async (file, report) => {
      const { atime, mtime } = await fsp.stat(file);
      await keepReport({ ...report, space: newId });
      await fsp.utimes(file, atime, mtime);
    },
    folder: async (dir, state) => {
      await writeState(await openImportFolder(dir), { ...state, space: newId, report: { ...state.report, space: newId } });
    },
  });
}
