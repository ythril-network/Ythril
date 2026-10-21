/**
 * The audit operations an instance-wide act set writes when it ENDS, declared where the middleware can re-export them without importing
 * the restore or the migrate (bundle-157, R4.3, R5.7). The request is audited by its route (`data.restore.requested`,
 * `data.migrate.requested`); what the set came to is one row more, written when it ends. Its path names the backup and the set
 * (`internal:<kind>:<backupId>:<setId>`), so an operator finds the outcome by the backup it went through - and never by a target URI.
 */

/** Every space's restore act completed. */
export const RESTORE_COMPLETED_OPERATION = 'data.restore.completed';
/** An operator abandoned the restore; the spaces whose acts had not completed keep what their acts reached. */
export const RESTORE_ABANDONED_OPERATION = 'data.restore.abandoned';

/**
 * The migrate's copy is in the new database and the instance continues there. Written by the copy INTO THE TARGET's audit log, since
 * this process's database is the one the instance leaves: a row written here would land where nobody reads it.
 */
export const MIGRATE_COMPLETED_OPERATION = 'data.migrate.completed';
/** The migrate ended without completing and the old URI stands. Written into the database being kept, this process's own. */
export const MIGRATE_FAILED_OPERATION = 'data.migrate.failed';
