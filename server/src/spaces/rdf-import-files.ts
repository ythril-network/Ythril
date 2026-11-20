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
 *   cleanup list calls it, so a space created later under the id shows nothing of the old one.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { validate as isUuid } from 'uuid';
import { getDataRoot } from '../config/loader.js';
import { log, peerText } from '../util/log.js';
import { isMissingPath } from '../util/path-present.js';
import type { RdfFormat } from '../rdf/serialize.js';
import type { ImportMode } from '../rdf/import-reasons.js';
import type { RdfImportReport } from '../rdf/import-report.js';
import { openImportFolder, readSpoolLines, removeImportFolder, writeWholeSpoolFile, type ImportFolder } from '../rdf/import-spool.js';
import type { SpaceMeta } from '@ythril-network/schema';

/** The folder under the data root that holds the files of standing RDF imports. */
export const RDF_IMPORT_DIR = 'rdf-import';
/** The folder under the data root that holds the reports of RDF imports. */
export const RDF_IMPORT_REPORT_DIR = 'rdf-import-reports';
/** How long an import's report is kept for the status doors. */
export const RDF_IMPORT_REPORT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

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
   * The type schemas the dry plan and every commit window judge by: read once under the hold (when the translation began) and kept here, so a
   * schema that arrives from a network meanwhile governs the writes after the import, never half of it.
   */
  planSchema?: SpaceMeta['typeSchemas'];
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

/** Remove the reports and the import folders of `spaceId`: the space was deleted, and the files that name it go with it. */
export async function dropRdfImportsOfSpace(spaceId: string): Promise<void> {
  const reports = path.join(getDataRoot(), RDF_IMPORT_REPORT_DIR);
  let names: string[] = [];
  try { names = await fsp.readdir(reports); } catch (err) { if (!isMissingPath(err)) throw err; }
  for (const name of names) {
    const id = name.replace(/\.spool$/, '');
    if (!isUuid(id)) continue;
    const report = await readReport(id, 0).catch(() => null);
    if (report?.space === spaceId) await fsp.rm(path.join(reports, name), { force: true });
  }
  const root = path.join(getDataRoot(), RDF_IMPORT_DIR);
  try { names = await fsp.readdir(root); } catch (err) { if (isMissingPath(err)) return; throw err; }
  for (const name of names) {
    const dir = folderPathOf(name);
    if (!dir) continue;
    const state = await readState(await openImportFolder(dir)).catch(() => null);
    if (state?.space === spaceId) await removeImportFolder(dir);
  }
}
