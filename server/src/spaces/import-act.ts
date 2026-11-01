/**
 * The admin import as a space act: its body lands a body the door spooled and validated, under its space's hold; its spool is the act's input
 * and lives exactly as long as the act (bundle-40 R1 as amended by 2R3, Q-267).
 *
 * ## What went wrong before it
 *
 * The import ran inline in the request: nothing closed its space to other writers while it landed, a restart half-way left nothing saying it
 * was owed, and its result existed only in the answer. As an act it registers after the body is on disk and valid (never before: a malformed
 * body is the door's 400 and no act ever stands for it), holds its space (`space_being_imported`), resumes after a crash from the spool it
 * names, and forgets what the space received when it completes, so the next sync converges with the network (D-69).
 *
 * ## The spool
 *
 * `<data root>/import-spool/<spool id>.json`, written by the door through the master secret's chunked envelope when one is configured. The
 * entry names the spool by id, never by path; the path is resolved under the spool root with a containment check when the body runs
 * ({@link spoolPathOf}). It is removed when the act completes, when it fails for good, and at the next start when no standing act names it.
 *
 * An import act never needs abandoning: its input was validated before it was registered, a store failure is retried by the runner, and a
 * resumed act whose spool is gone completes as FAILED (its completion row says so) and removes itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, getDataRoot } from '../config/loader.js';
import type { SpaceActEntry } from '../config/types.js';
import { mkdirPrivateSync } from '../util/fs-modes.js';
import { LruMap } from '../util/lru-map.js';
import { isMissingPath } from '../files/stored-bytes.js';
import { log, peerText } from '../util/log.js';
import { indexExportBody, type ExportBodyIndex } from '../sync/export-stream.js';
import { arrivalRefusal } from '../sync/arrivals.js';
import { importSpool, restoreOriginOf, type ImportResult } from '../sync/space-import.js';
import { defineSpaceActBody, defineSpaceActBootSweep, registerOwnSpaceAct, spaceActsOfKind, type SpaceActBodyOutcome } from './space-act-runner.js';

const KIND = 'import' as const;

/** The directory under the data root that holds the bodies of standing imports. */
export const IMPORT_SPOOL_DIR = 'import-spool';

/** `<data root>/import-spool`. */
export function spoolRoot(): string {
  return path.join(getDataRoot(), IMPORT_SPOOL_DIR);
}

const SPOOL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The file of spool `id`, or null when the id is not one the door mints (so it cannot leave the spool root). */
export function spoolPathOf(id: string): string | null {
  if (!SPOOL_ID.test(id)) return null;
  const root = spoolRoot();
  const file = path.join(root, `${id}.json`);
  return path.dirname(file) === root ? file : null;
}

/** Make the spool root (0700) and answer it. */
export function ensureSpoolRoot(): string {
  const root = spoolRoot();
  mkdirPrivateSync(root);
  return root;
}

/** Remove spool `id`; a spool already gone is not a failure. */
export function removeSpool(id: string): void {
  const file = spoolPathOf(id);
  if (file) fs.rmSync(file, { force: true });
}

/** Does any import stand now, on any space: the door lets one run at a time. */
export function importStanding(): boolean {
  return spaceActsOfKind(getConfig(), KIND).length > 0;
}

/** Does a document take part in the repeated-id rule of a body: only one the writer would not refuse (it refuses before it collapses). */
const competes = (family: string, doc: Record<string, unknown>): boolean => arrivalRefusal(doc, { seqOptional: family === 'files' }) === null;

/** Index a spooled body for an import: the door's validation and the body's resume read it the same way. */
export function indexSpool(file: string, maxDocuments: number): Promise<ExportBodyIndex> {
  return indexExportBody(file, { maxDocuments, competes });
}

/** The index the door read, kept for the body's first run so the body is not read whole a third time. A resume reads it again. */
const indexes = new Map<string, ExportBodyIndex>();
/** The result each completed import's body came to, by entry id, for the door that waits for it; bounded, the oldest first out. */
const results = new LruMap<string, ImportResult>(32);

/**
 * Register the import of the body spooled as `spoolId` (validated whole, `index`) into `spaceId`, in a config write of its own, and answer its
 * entry id. THROWS `SpaceActsClosedError` once shutdown closed the runner.
 */
export function registerImport(spaceId: string, spoolId: string, index: ExportBodyIndex): string {
  indexes.set(spoolId, index);
  try { return registerOwnSpaceAct({ kind: KIND, localId: spaceId, spoolId }); }
  catch (err) { indexes.delete(spoolId); throw err; }
}

/** The result the body of entry `entryId` came to, once; undefined when it has not completed (or was read already). */
export function takeImportResult(entryId: string): ImportResult | undefined {
  const r = results.get(entryId);
  results.delete(entryId);
  return r;
}

/** The import's body: land the spool in pages, then (after the completion write) remove it. */
async function importBody({ entry }: { entry: Readonly<SpaceActEntry> }): Promise<SpaceActBodyOutcome> {
  const spoolId = entry.spoolId ?? '';
  const file = spoolPathOf(spoolId);
  const forget = (): void => { indexes.delete(spoolId); removeSpool(spoolId); };
  if (!file || !fs.existsSync(file)) {
    return {
      failedFinally: {
        status: 410,
        message: `The import into space '${entry.localId}' cannot complete: the body it was given is no longer on disk. Nothing was written; import the export again.`,
      },
      afterCompletion: forget,
    };
  }
  const index = indexes.get(spoolId) ?? await indexSpool(file, Number.MAX_SAFE_INTEGER);
  const cfg = getConfig();
  const result = await importSpool(entry.localId, file, index, { origin: restoreOriginOf(index.envelope, cfg.instanceId, entry.localId) });
  results.set(entry.id, result);
  const totals = Object.values(result.results);
  return {
    counts: {
      inserted: totals.reduce((n, r) => n + r.inserted, 0), updated: totals.reduce((n, r) => n + r.updated, 0),
      refused: totals.reduce((n, r) => n + r.errors, 0), deletedOnRestore: totals.reduce((n, r) => n + (r.deletedOnRestoreTotal ?? 0), 0),
      due: totals.reduce((n, r) => n + (r.dueTotal ?? 0), 0),
    },
    afterCompletion: forget,
  };
}

/** The start's sweep: every spool no standing import names is removed (a door that died between the spool and the act left it). */
function sweepOrphanSpools(standing: readonly SpaceActEntry[]): void {
  const named = new Set(standing.map(e => e.spoolId).filter((id): id is string => typeof id === 'string'));
  let names: string[];
  try { names = fs.readdirSync(spoolRoot()); } catch (err) { if (isMissingPath(err)) return; throw err; }
  for (const name of names) {
    if (named.has(name.replace(/\.json$/, ''))) continue;
    try { fs.rmSync(path.join(spoolRoot(), name), { force: true, recursive: true }); log.info(`removed an import spool no standing import names: ${peerText(name)}`); }
    catch (err) { log.warn(`an import spool no standing import names could not be removed (${peerText(name)}): ${peerText(err)}`); }
  }
}

defineSpaceActBody(KIND, importBody);
defineSpaceActBootSweep(KIND, sweepOrphanSpools);
