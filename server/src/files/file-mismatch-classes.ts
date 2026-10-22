/**
 * The ways a file's record can be out of step with its bytes - the values of `class` in a restore's files report and of the
 * `ythril_restore_files_out_of_step_total` counter, and the keys the classifier (`files/disk-against-rows.ts`) fills.
 *
 * Its own file, with no imports, because the metrics registry declares a series for each class at 0 and the classifier imports half the
 * server (the database, the sync rules): a list in the classifier would make the registry import it, and the registry is imported by the
 * modules the classifier reaches - a cycle that leaves a constant uninitialised at load. One list, here, read by both.
 *
 * The first three are the pull's repair reasons (`FileRepairReason`, `files/bytes-arrived.ts`); the last two are the restore's own and
 * are NOT repair reasons - the pull's counters never produce them.
 */
export const FILE_MISMATCH_CLASSES = [
  'missing_row', 'stale_row', 'unprocessed', 'row_without_bytes', 'soft_deleted_with_bytes',
] as const;

export type FileMismatchClass = (typeof FILE_MISMATCH_CLASSES)[number];
