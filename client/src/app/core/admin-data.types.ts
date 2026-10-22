/**
 * What the Data page's restore, migrate and maintenance doors answer since a restore and a migrate became act sets (bundle-157).
 *
 * Typed to the server's own shapes (`db/restore-act.ts` `RestoreStarted`, `RestoreReport`, `RestoreAbandon`; `db/migrate-act.ts`
 * `MigrateStarted`; `maintenance.ts` `maintenanceState`), because the type they replaced (`{ ok: boolean }`) had not been sent for a
 * whole slice and the page still read any success as "Restore completed". A kind and a state stay the server's strings: the client has
 * words per kind and per state in its locales, never a closed set it would have to keep in step.
 */

/** The 202 of `POST /api/admin/data/restore`: the set registered, the spaces it restores, empties and leaves out. */
export interface RestoreStarted {
  restoreId: string;
  backupId: string;
  spaces: string[];
  /** Served here, absent from the backup: restored to empty. */
  emptied: string[];
  /** In the backup, not served here, and named in `leaveOut`: not restored. */
  leftOut: string[];
}

/** One class of a restored space's files report: how many files, and at most a share of their paths. */
export interface RestoreFileClass { count: number; paths: string[] }

/**
 * What a restore says of one space's files (`files` of the space's row, restore sets only): the classes that have a file, by the
 * server's class name (`missing_row`, `stale_row`, `unprocessed`, `row_without_bytes`, `soft_deleted_with_bytes`; read as the server's
 * string, so a newer server's class still shows), or the reason the check could not run.
 */
export type RestoreFilesReport =
  | { checked: true; classes: Record<string, RestoreFileClass> }
  | { checked: false; reason: string };

/** One space of a set's report. */
export interface ActSetSpaceReport {
  id: string;
  /** `owed`, `running`, `done` or `<kind>_abandoned` (`restore_abandoned`, `migrate_abandoned`); read as the server's string. */
  state: string;
  attempts: number;
  /** Our sentence for the last failure (never a driver's text). */
  lastError?: string;
  retryAt?: string;
  /** Another attempt meets the same input: only an abandon ends it. */
  needsAbandon?: true;
  completedAt?: string;
  edgeIndexes?: unknown;
  vectorIndexes?: unknown;
  /** A restore's check of the space's files against its restored records; absent on a migrate's rows. */
  files?: RestoreFilesReport;
}

/** Where a set stands, or how the last one ended: the part a restore's and a migrate's report share. */
export interface ActSetReport {
  /** `running`, `completed` or `abandoned`. */
  state: string;
  startedAt: string;
  endedAt?: string;
  /** The backup the set restores from, or (a migrate) the dump it copies; set once known. */
  backupId?: string;
  /** Our sentence for a failure that ended the whole set (never a driver's text, never a URI). */
  lastError?: string;
  done: number;
  total: number;
  spaces: ActSetSpaceReport[];
  emptied: string[];
  leftOut: string[];
}

/** `GET /api/admin/data/restore` while a restore stands, or after the last one. */
export interface RestoreReport extends ActSetReport {
  restoreId: string;
}

/** `GET /api/admin/data/restore`: the report, or `{ restore: null }` when no restore ever ran here. */
export type RestoreReportAnswer = RestoreReport | { restore: null };

/** `POST /api/admin/data/restore/abandon`: the spaces it released, which keep whatever their acts reached. */
export interface RestoreAbandoned {
  abandoned?: true;
  restoreId: string;
  backupId?: string;
  /** Released before their act completed: possibly half restored. */
  halfRestored: string[];
  completed: string[];
}

/** `POST /api/admin/data/migrate/abandon` (Q-564): the spaces it released. Nothing was saved: the old database stays in use. */
export interface MigrateAbandoned {
  abandoned?: true;
  migrateId: string;
  backupId?: string;
  released: string[];
  completed?: string[];
}

/** The 202 of `POST /api/admin/data/migrate`. */
export interface MigrateStarted {
  migrateId: string;
  spaces: string[];
}

/** `GET /api/admin/data/migrate`: the same report as a restore's (`spaces/act-set-report.ts`, one handler for both kinds). */
export interface MigrateReport extends ActSetReport {
  migrateId: string;
}

export type MigrateReportAnswer = MigrateReport | { migrate: null };

/** `GET|POST /api/admin/data/maintenance`: the manual toggle and the set that holds maintenance, apart. */
export interface MaintenanceState {
  active: boolean;
  manual: boolean;
  /** The kind of the instance-wide set holding maintenance, or null. */
  heldBy: string | null;
}

/** The report in an answer, or null for "none ever ran". */
export function reportOf<T extends ActSetReport>(answer: T | Record<string, null> | null | undefined): T | null {
  return answer && typeof answer === 'object' && Array.isArray((answer as Partial<ActSetReport>).spaces) ? (answer as T) : null;
}
