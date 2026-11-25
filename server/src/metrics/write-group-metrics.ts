/**
 * The write group's metric (Q-760, `brain/write-plan/write-group.ts`): groups that landed nothing, by why.
 *
 * ## What it prevents
 *
 * `registry.ts` is the registration file for every metric and is held at its size by the ratchet; it is being split into one module per concern
 * (`schema-convert-metrics.ts`, `sync-tombstone-metrics.ts`). This one lives in a leaf of the metrics seam, declared on the one registry, so the
 * registry grows by nothing and the group module holds no metric declaration of its own.
 *
 * ## Why it imports the registry
 *
 * The registry does not import this module (nothing it collects at scrape time reads a group), so importing `register` from it forms no cycle.
 * The group module counts every reason once with 0 when it loads, so each series exists from the first load of the writer.
 *
 * The name, label and help text are what dashboards and alert rules read (`docs/integration-guide/11-setup-api.md`).
 */
import { Counter } from 'prom-client';
import { register } from './registry.js';

/** Write groups that landed nothing, by reason (`GROUP_ABORT_REASONS`). */
export const writeGroupAbortsTotal = new Counter({
  name: 'ythril_write_group_aborts_total',
  help: 'Write groups that landed nothing, by reason (stale, duplicate_key, version_ceiling, retries, too_large, space_not_writable, failed)',
  labelNames: ['reason'] as const,
  registers: [register],
});
