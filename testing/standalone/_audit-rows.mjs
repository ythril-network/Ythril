/**
 * The audit rows a step left, read once the writer has finished — the question "what did this act audit", asked once for every -db test
 * that asks it.
 *
 * ## Why a module
 *
 * `logAuditEntry` is fire-and-forget and its inserts run concurrently on the pool, so a row written after another can land first and a
 * row written by the act under test can land after the test's read. Each test that counted rows waited for its own reason (a sleep, a
 * barrier row, a count that held still), and a count read too early is a pass for "nothing was audited". The writer exposes how many
 * inserts are still on the wire (`auditWritesPending`); this waits for that to reach zero twice running, then reads.
 *
 * ## What it does not do
 *
 * It does not wait for a write that has not STARTED: an act that writes its row after an await of its own must have been awaited by the
 * caller first. A test that asserts a row is ABSENT awaits the act, then reads here.
 */
import { elapse } from '../_shared/sleep.mjs';

/**
 * Every row of `audit_log` matching `filter`, oldest first, once no insert is pending (read twice, so an insert that starts between the
 * two reads is not missed).
 *
 * @param {{ getDb: () => import('mongodb').Db }} mongo  the harness module `openTestMongo` returned
 * @param {object} [filter]
 */
export async function auditRowsOf(mongo, filter = {}) {
  const { auditWritesPending } = await import('../../server/dist/audit/audit.js');
  for (let still = 0, i = 0; still < 2 && i < 400; i++) {
    if (auditWritesPending() === 0) still++; else still = 0;
    await elapse(15, 'sampler interval: the audit writer\'s pending inserts are read at a fixed rate until none is on the wire');
  }
  return mongo.getDb().collection('audit_log').find(filter).sort({ timestamp: 1 }).toArray();
}
