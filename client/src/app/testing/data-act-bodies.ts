/**
 * The answers the Data page's restore, abandon and migrate doors really give, as `{ status, body }` pairs - copied from the server source
 * at 35898b00 (bundle-157 I1-I3), never invented. Shared by the AdminApi spec and the Data page spec, so both hold one wire shape.
 *
 * Where each shape comes from:
 * - `POST /api/admin/data/restore`: `startRestore`'s `RestoreStarted` (202), the route's `backup_names_unserved_spaces` and
 *   `backup_not_whole` 400s, and `instanceWideActRefusal('restore', kind)` (409, `space_being_restored` / `space_being_migrated`);
 * - `GET /api/admin/data/restore`: `restoreReport()` (`RestoreReport`), or `{ restore: null }`;
 * - `POST /api/admin/data/restore/abandon`: `abandonRestore()` (200), `no_restore_standing` (404), `restore_act_running` (409);
 * - `POST /api/admin/data/migrate`: `startMigrate`'s `{ migrateId, spaces }` (202), the two `INFRA_MANAGED` 409s, `target_not_empty`;
 * - `GET /api/admin/data/migrate`: `actSetReport('migrate')` (`spaces/act-set-report.ts`), the restore report's shape with `migrateId`;
 *   a set that failed whole carries its own `lastError`;
 * - `GET /api/admin/data/maintenance`: `maintenanceState()` (`{ active, manual, heldBy }`).
 *
 * A fixture is allowed to be literal (project rule): these are the expected values, not derived from the code under test.
 */
import type { WireAnswer } from './space-act-bodies';

export const UNSERVED_SENTENCE = 'The backup holds space(s) this instance does not serve: \'old-notes\', \'retired\'. They were renamed or '
  + 'deleted after the backup, so their data has no space to be restored into. Name them in leaveOut to restore without them.';
export const NOT_WHOLE_SENTENCE = 'Backup \'2026-10-18T10-00-00-000Z\' cannot be restored: the manifest names a file the backup does not hold.';
export const RESTORING_SENTENCE = 'A restore cannot start: the instance is being restored from a backup; retry once the restore completes.';
export const MIGRATE_DURING_RESTORE_SENTENCE = 'A migrate cannot start: the instance is being restored from a backup; retry once the restore completes.';
export const INFRA_FLAG_SENTENCE = 'Database migration via API is disabled on this instance. The MongoDB connection is marked as infra-managed '
  + '(YTHRIL_MONGO_INFRA_MANAGED=true). Update the connection URI in your infrastructure configuration instead.';
export const INFRA_ENV_SENTENCE = 'Database migration via API is not possible on this instance: the MongoDB URI comes from the MONGO_URI '
  + 'environment variable, which overrides the configured one. Change it in your infrastructure configuration instead.';
export const TARGET_NOT_EMPTY_SENTENCE = 'The target database already holds data. A migrate copies into an empty database only: empty it, '
  + 'or name another, and migrate again.';
export const ABANDON_RUNNING_SENTENCE = 'A restore act is running for \'notes\'; abandon once it has ended.';
export const MIGRATE_ABANDON_RUNNING_SENTENCE = 'The migrate is copying the database now; abandon once its attempt has ended.';

/** The server's English for these refusals, which the Data page must never show: a spec asserts its absence. */
export const DATA_SERVER_SENTENCES = [
  UNSERVED_SENTENCE, NOT_WHOLE_SENTENCE, RESTORING_SENTENCE, MIGRATE_DURING_RESTORE_SENTENCE, INFRA_FLAG_SENTENCE, INFRA_ENV_SENTENCE,
  TARGET_NOT_EMPTY_SENTENCE, ABANDON_RUNNING_SENTENCE, MIGRATE_ABANDON_RUNNING_SENTENCE,
];

export const BACKUP_ID = '2026-10-18T10-00-00-000Z';

export const RESTORE_ANSWERS = {
  accepted: { status: 202, body: { restoreId: 'set-1', backupId: BACKUP_ID, spaces: ['general', 'notes', 'proj'], emptied: ['proj'], leftOut: [] } },
  acceptedOne: { status: 202, body: { restoreId: 'set-1', backupId: BACKUP_ID, spaces: ['general'], emptied: [], leftOut: [] } },
  acceptedLeavingOut: {
    status: 202,
    body: { restoreId: 'set-2', backupId: BACKUP_ID, spaces: ['general', 'notes'], emptied: [], leftOut: ['old-notes', 'retired'] },
  },
  unserved: { status: 400, body: { error: UNSERVED_SENTENCE, code: 'backup_names_unserved_spaces', spaces: ['old-notes', 'retired'] } },
  notWhole: { status: 400, body: { error: NOT_WHOLE_SENTENCE, code: 'backup_not_whole' } },
  restoring: { status: 409, body: { error: RESTORING_SENTENCE, code: 'space_being_restored' } },
} satisfies Record<string, WireAnswer>;

/** A `RestoreSpaceReport` row. */
export function restoreSpace(id: string, state: 'owed' | 'running' | 'done' | 'restore_abandoned' | 'migrate_abandoned', over: Record<string, unknown> = {}) {
  return { id, state, attempts: state === 'done' ? 0 : 1, ...over };
}

/** A `RestoreReport`, running unless `over` says otherwise. */
export function restoreReport(over: Record<string, unknown> = {}) {
  const spaces = (over['spaces'] as Array<{ state: string }> | undefined) ?? [
    restoreSpace('general', 'done', { completedAt: '2026-10-18T11:58:00.000Z', edgeIndexes: { failed: [] }, vectorIndexes: { rebuilding: [], failed: [] } }),
    restoreSpace('notes', 'owed', {
      attempts: 2, lastError: 'the backup holds records of collection \'notes_entities\' that one of its unique indexes refuses.',
      retryAt: '2026-10-18T12:05:00.000Z', needsAbandon: true,
    }),
    restoreSpace('proj', 'running'),
  ];
  return {
    restoreId: 'set-1', backupId: BACKUP_ID, state: 'running', startedAt: '2026-10-18T11:55:00.000Z',
    done: spaces.filter(s => s.state === 'done').length, total: spaces.length,
    spaces, emptied: ['proj'], leftOut: [],
    ...over,
  };
}

export const ABANDON_ANSWERS = {
  abandoned: { status: 200, body: { abandoned: true, restoreId: 'set-1', backupId: BACKUP_ID, halfRestored: ['notes', 'proj'], completed: ['general'] } },
  running: { status: 409, body: { error: ABANDON_RUNNING_SENTENCE, code: 'restore_act_running' } },
  none: { status: 404, body: { error: 'No restore is standing.', code: 'no_restore_standing' } },
} satisfies Record<string, WireAnswer>;

export const MIGRATE_ANSWERS = {
  accepted: { status: 202, body: { migrateId: 'set-9', spaces: ['general', 'notes'] } },
  infraFlag: { status: 409, body: { error: INFRA_FLAG_SENTENCE, code: 'INFRA_MANAGED' } },
  infraEnv: { status: 409, body: { error: INFRA_ENV_SENTENCE, code: 'INFRA_MANAGED' } },
  targetNotEmpty: { status: 409, body: { error: TARGET_NOT_EMPTY_SENTENCE, code: 'target_not_empty' } },
  duringRestore: { status: 409, body: { error: MIGRATE_DURING_RESTORE_SENTENCE, code: 'space_being_restored' } },
} satisfies Record<string, WireAnswer>;

/** `POST /api/admin/data/migrate/abandon` (Q-564): the set and the spaces it released; nothing is saved, the old database stays. */
export const MIGRATE_ABANDON_ANSWERS = {
  abandoned: { status: 200, body: { abandoned: true, migrateId: 'set-9', backupId: BACKUP_ID, released: ['general', 'notes'] } },
  running: { status: 409, body: { error: MIGRATE_ABANDON_RUNNING_SENTENCE, code: 'migrate_act_running' } },
  none: { status: 404, body: { error: 'No migrate is standing.', code: 'no_migrate_standing' } },
} satisfies Record<string, WireAnswer>;

/** A migrate report: the restore report's shape (one handler serves both), `migrateId` for `restoreId`. */
export function migrateReport(over: Record<string, unknown> = {}) {
  const spaces = [restoreSpace('general', 'done'), restoreSpace('notes', 'running')];
  return {
    migrateId: 'set-9', backupId: BACKUP_ID, state: 'running', startedAt: '2026-10-18T11:55:00.000Z', done: 1, total: 2, spaces,
    emptied: [], leftOut: [], ...over,
  };
}

/** The sentence a whole-set failure ends a migrate with: ours, naming the backup, never the URI. */
export const SET_FAILED_SENTENCE = `The migrate did not complete: the copy into the new database was refused. The instance stays on its database; the copy of it is backup '${BACKUP_ID}'.`;

export const MAINTENANCE = {
  off: { active: false, manual: false, heldBy: null },
  manual: { active: true, manual: true, heldBy: null },
  heldByRestore: { active: true, manual: false, heldBy: 'restore' },
  heldByMigrate: { active: true, manual: false, heldBy: 'migrate' },
};
