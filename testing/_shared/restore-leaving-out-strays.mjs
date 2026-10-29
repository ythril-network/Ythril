/**
 * Start a restore of a backup the test itself took, leaving out only the spaces OTHER tests created and deleted in between.
 *
 * ## Why this exists
 *
 * The integration files run side by side against one instance, and a backup is of the whole instance. Between a test's backup and
 * its restore, another file may create and delete a space of its own; the restore then refuses the whole backup by design
 * (`400 backup_names_unserved_spaces`), and the test fails for a space that is not its subject. Main's CI hit it twice, in two
 * files (runs 40765189225 and 40817842914), each with its own copy of the retry — this is the one copy.
 *
 * ## What it will not hide
 *
 * A space the test NAMES in `mustKeep` is never left out: if the restore says it is not served, that is the defect under test, and
 * this throws. The retry is taken only on that one refusal code; every other answer is returned as it came.
 *
 * @param {(body: object) => Promise<{status: number, body: any}>} postRestore  POSTs `body` to /api/admin/data/restore
 * @param {string} backupId
 * @param {{ mustKeep: string[] }} opts  the spaces the test's own assertions read
 * @returns {Promise<{status: number, body: any}>} the restore's answer (202 when it started)
 */
export async function restoreLeavingOutStrays(postRestore, backupId, { mustKeep }) {
  if (!Array.isArray(mustKeep) || mustKeep.length === 0) throw new Error('restoreLeavingOutStrays: name the spaces the test reads (mustKeep)');
  const first = await postRestore({ backupId });
  if (first.status !== 400 || first.body?.code !== 'backup_names_unserved_spaces') return first;
  const strays = first.body.spaces ?? [];
  const kept = strays.filter(s => mustKeep.includes(s));
  if (kept.length > 0) throw new Error(`the restore says a space this test reads is not served: ${kept.join(', ')} — ${JSON.stringify(first.body)}`);
  return postRestore({ backupId, leaveOut: strays });
}
