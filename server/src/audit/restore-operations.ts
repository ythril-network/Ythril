/**
 * The audit operations a restore writes when its act set ENDS, declared where the middleware can re-export them without importing the
 * restore (bundle-157, R4.3, R5.7): the request is audited by its route (`data.restore.requested`); what the set came to is one row
 * more, written when its last space's act ends - completed, or abandoned with the spaces it left possibly half restored. Its path names
 * the backup (`internal:restore:<backupId>:<restoreId>`), so an operator finds the outcome by the backup they restored.
 */

/** Every space's restore act completed. */
export const RESTORE_COMPLETED_OPERATION = 'data.restore.completed';
/** An operator abandoned the restore; the spaces whose acts had not completed keep what their acts reached. */
export const RESTORE_ABANDONED_OPERATION = 'data.restore.abandoned';
