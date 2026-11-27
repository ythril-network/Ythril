/**
 * The triple index counters (bundle-273, Q-764, pre-ship lens finding O1).
 *
 * - `ythril_rdf_index_reads_total{source}`: one per space a SPARQL or Linked Data query reads, by where it read it: `index`, or `records` (the
 *   index was absent, unbuilt, stale, behind or built for another form, or a rebuild swapped it while the query read it). A rising `records`
 *   share on a space whose index should be ready is the one to look into.
 * - `ythril_rdf_index_rebuilds_total{reason,outcome}`: one per rebuild, by why it started (`admin` for the door, else the upkeep's reason:
 *   `missing`, `stale`, `journal`, `form`, `verify`, `unused-terms`) and how it ended (`built`, `busy`, `no-form`, `form-changed`, `stopped`, or
 *   `failed` when it threw). A rising `failed` is a rebuild the upkeep retries after longer waits.
 *
 * Its own module, as `sparql-update-metrics.ts`: `registry.ts` is held by the size ratchet.
 */
import { Counter } from 'prom-client';
import { register } from './registry.js';

export const rdfIndexReadsTotal = new Counter({
  name: 'ythril_rdf_index_reads_total',
  help: 'Spaces a query read, by source: index, or records (the index could not serve it)',
  labelNames: ['source'] as const,
  registers: [register],
});

export const rdfIndexRebuildsTotal = new Counter({
  name: 'ythril_rdf_index_rebuilds_total',
  help: 'Triple index rebuilds ended, by the reason they started and their outcome',
  labelNames: ['reason', 'outcome'] as const,
  registers: [register],
});
