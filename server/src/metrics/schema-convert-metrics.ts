/**
 * The schema conversion metrics (Q-746, `spaces/schema-convert-run.ts`): what conversion runs did with each record they read, and how many
 * spaces have a run going.
 *
 * ## What it prevents
 *
 * `registry.ts` is the registration file for every metric and is held at its size by the ratchet; it is being split into one module per concern
 * (`sync-tombstone-metrics.ts` was the first). These two live in a leaf of the metrics seam, declared on the one registry, so the registry grows by
 * nothing and the run module holds no metric declaration of its own.
 *
 * ## Why it imports the registry, unlike `sync-tombstone-metrics.ts`
 *
 * The registry does not import this module (nothing it collects at scrape time reads a conversion), so importing `register` from it forms no
 * cycle. It is loaded with the run module, which the boot loads (`bootstrap.ts`, the resume), so the series exist from the start of every
 * configured instance.
 *
 * Names, labels and help texts are what dashboards and alert rules read (`docs/integration-guide/11-setup-api.md`).
 */
import { Counter, Gauge } from 'prom-client';
import { register } from './registry.js';

/**
 * What runs did with each record they read: `stamped` (a conforming copy given the run's fingerprint, quietly), `rewritten` (the steps changed
 * it), `unconverted` (an item written), `moved` (another write landed first), `edge_restamped` (an edge of a re-typed entity stamped again).
 */
export const schemaConvertRecordsTotal = new Counter({
  name: 'ythril_schema_convert_records_total',
  help: 'Records a schema conversion run read, by what it did with each',
  labelNames: ['outcome'] as const,
  registers: [register],
});

/** The outcomes of {@link schemaConvertRecordsTotal}, the one list: each series starts at zero, and the run counts only a member of it. */
export const SCHEMA_CONVERT_OUTCOMES = ['stamped', 'rewritten', 'unconverted', 'moved', 'edge_restamped'] as const;
for (const outcome of SCHEMA_CONVERT_OUTCOMES) schemaConvertRecordsTotal.labels({ outcome }).inc(0);

/** How many spaces have a schema conversion run that is not finished (0 when none): set by the watcher and the boot only when every space was read. */
export const schemaConvertRunsInProgress = new Gauge({
  name: 'ythril_schema_convert_runs_in_progress',
  help: 'Number of spaces with a schema conversion run going (0 when none)',
  registers: [register],
});
