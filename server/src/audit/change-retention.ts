/**
 * A shorter life for the `changes` payload than for the audit entry that carries it.
 *
 * Owner decision, 2026-07-28: brain RECORD edits (facts, entities, edges, chrono, file meta) may
 * record old→new values, **with a TTL**. That TTL is the mitigation for what made the feature a
 * decision rather than a slice — recording record edits copies user content into a second store with
 * different access rules, and record writes are the hot bulk path.
 *
 * ── Why the TTL cannot be the entry's TTL ────────────────────────────────────────────────────────
 *
 * The obvious implementation is a shorter `_expireAt` on those entries, letting the existing Mongo TTL
 * index handle it. That would be wrong. A TTL index deletes the whole **document**, so it would take
 * who / when / route / status with it — shortening the audit TRAIL for exactly the operations the
 * feature exists to make auditable. The trail is the durable part; the content is the sensitive part,
 * and they want different lifetimes.
 *
 * So this sweep unsets `changes` in place. The entry survives its full `audit.retentionDays` and still
 * answers "who edited that fact, and when". Only "and here is what it used to say" expires early.
 *
 * ── Redaction is recorded, not silent ───────────────────────────────────────────────────────────
 *
 * A swept entry gets `changesRedacted: true` rather than simply losing a field. An audit reader who
 * finds no `changes` must be able to tell "this operation records no changes" from "it did, and they
 * have aged out" — otherwise the log quietly implies nothing was captured, which is its own small lie.
 */
import { col, asFilter } from '../db/mongo.js';
import { getConfig } from '../config/loader.js';
import { log } from '../util/log.js';

/**
 * IMPORTED, not spelled again.
 *
 * This file had `const COLLECTION = '_audit_log'` from the day it was written (#491, 2026-07-28). The audit
 * log has been `audit_log` since #61. So the sweep ran every ten minutes against a collection nothing has
 * ever written to, across **fourteen releases**, and redacted nothing — while the documentation promised a
 * 14-day window on the `changes` payload and `doc-cited-constants` kept the number honest.
 *
 * It was silent rather than wrong-looking because `updateMany` on a non-existent collection succeeds with
 * `modifiedCount: 0`, and the sweep logs only when the count is above zero. Zero redacted is exactly what a
 * healthy instance with nothing aged out also reports.
 */
import { AUDIT_COLLECTION } from './audit.js';

const COLLECTION = AUDIT_COLLECTION;

/** Days a `changes` payload survives when the operation is a brain record edit. */
export const DEFAULT_RECORD_CHANGE_RETENTION_DAYS = 14;

/**
 * Operations whose `changes` carry user record content and therefore expire early.
 *
 * Admin/config operations are deliberately absent: `space.update`, `network.update` and friends record
 * a label or a boolean an operator set, which is not user content and is the audit log's core value.
 * Those keep the full retention.
 */
export const RECORD_CHANGE_OPERATIONS: readonly string[] = [
  'fact.update',
  'entity.update',
  'edge.update',
  'chrono.update',
  'file.meta.update',
  'entity.merge',
];

/** Resolved retention in days; falls back to the default outside a loaded config. */
export function recordChangeRetentionDays(): number {
  try {
    const v = getConfig().audit?.recordChangeRetentionDays;
    return typeof v === 'number' && v > 0 ? v : DEFAULT_RECORD_CHANGE_RETENTION_DAYS;
  } catch {
    return DEFAULT_RECORD_CHANGE_RETENTION_DAYS;   // pre-setup
  }
}

/**
 * The cutoff before which a record-edit entry's `changes` should no longer exist.
 *
 * Exported and pure so the policy is testable without a database — the sweep itself is a one-line
 * `updateMany` around it.
 */
export function changesCutoff(now: number = Date.now(), retentionDays = DEFAULT_RECORD_CHANGE_RETENTION_DAYS): Date {
  return new Date(now - retentionDays * 86_400_000);
}

/**
 * Should this entry's changes be redacted now?
 *
 * Pure decision, kept separate from the query so the rule can be tested directly:
 *   - only record-content operations expire early;
 *   - only entries that still HAVE changes (re-sweeping a redacted entry is a no-op, not an update);
 *   - only entries older than the cutoff.
 */
export function shouldRedact(
  entry: { operation?: string; timestamp?: string; changes?: unknown; changesRedacted?: boolean },
  cutoff: Date,
): boolean {
  if (!entry.operation || !RECORD_CHANGE_OPERATIONS.includes(entry.operation)) return false;
  if (entry.changesRedacted) return false;
  if (entry.changes === undefined || entry.changes === null) return false;
  if (!entry.timestamp) return false;
  return new Date(entry.timestamp).getTime() < cutoff.getTime();
}

/**
 * Unset `changes` on record-edit entries past the retention window.
 *
 * Returns the number redacted. Never throws — this is housekeeping, and a failed sweep must not take
 * anything else down with it.
 */
export async function redactExpiredChanges(now: number = Date.now()): Promise<number> {
  const cutoff = changesCutoff(now, recordChangeRetentionDays());
  try {
    const res = await col(COLLECTION).updateMany(
      asFilter({
        operation: { $in: RECORD_CHANGE_OPERATIONS },
        timestamp: { $lt: cutoff.toISOString() },
        changes: { $exists: true },
      }),
      { $unset: { changes: '' }, $set: { changesRedacted: true } },
    );
    const n = res.modifiedCount ?? 0;
    if (n > 0) log.info(`Audit: redacted changes on ${n} record-edit entr${n === 1 ? 'y' : 'ies'} older than ${cutoff.toISOString()}`);
    // The FIRST sweep of a process reports even when it redacted nothing, and names the collection and how
    // many candidate entries it can see.
    //
    // This is the line that would have exposed the wrong-collection bug on day one. A sweep that speaks only
    // on success is indistinguishable from a sweep pointed at nothing: `updateMany` on a collection that does
    // not exist returns `modifiedCount: 0`, which is also what a healthy instance with nothing aged out
    // returns. Once per process is the whole cost — this runs every six hours, and a per-sweep info line
    // would be noise nobody reads, which is its own way of hiding.
    if (!_announced) {
      _announced = true;
      const seen = await col(COLLECTION).countDocuments(
        asFilter({ operation: { $in: RECORD_CHANGE_OPERATIONS } }),
        { limit: 1_000 },
      ).catch(() => -1);
      log.info(`Audit change-retention: sweeping '${COLLECTION}', ${recordChangeRetentionDays()}d window, `
        + `${seen < 0 ? 'count unavailable' : `${seen} record-edit entr${seen === 1 ? 'y' : 'ies'} present`}, `
        + `${n} redacted this pass`);
    }
    return n;
  } catch (err) {
    log.warn(`Audit change-retention sweep: ${err}`);
    return 0;
  }
}

import { sweepLegacyArrayWriterNotes } from '../brain/legacy-array-writers.js';

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;   // 6h — the same cadence as the other housekeeping sweeps
let _timer: NodeJS.Timeout | null = null;

/** Whether this process has already reported one sweep. Reset by `stopAuditChangeRetention` for tests. */
let _announced = false;

/**
 * Start the sweep. Always on: it only removes content that policy says should already be gone, and an
 * instance that never records record changes simply matches nothing.
 */
export function startAuditChangeRetention(): void {
  if (_timer) return;
  _timer = setInterval(() => {
    void redactExpiredChanges();
    /*
     * The conversion pre-flight's notes age out on the same timer, and riding this one is the point.
     *
     * They are a different collection with a much longer clock — a note holds a token id and a field name
     * and no user content, which is why it can be kept for 90 days where a `changes` array cannot. What
     * they share is being housekeeping nobody will remember to schedule, and a second unref'd 6-hourly
     * timer to sweep one small collection is a second thing that can be forgotten to start.
     */
    void sweepLegacyArrayWriterNotes()
      .catch(err => log.warn(`Legacy array-writer note sweep: ${err}`));
  }, SWEEP_INTERVAL_MS);
  _timer.unref();   // housekeeping must never hold the process open
  log.debug('Audit change-retention sweep started');
}

export function stopAuditChangeRetention(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
  // Also clear the once-per-process announcement, so a test that starts the sweep twice sees it twice.
  // A latch that outlives its owner is a test seam that lies about the second run.
  _announced = false;
}
