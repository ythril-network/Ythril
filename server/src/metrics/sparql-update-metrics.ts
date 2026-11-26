/**
 * The SPARQL Update counter (bundle-272, Q-761; vet-3 S9): `ythril_sparql_update_total{outcome}`, one per Update the act ended, by how it
 * ended: `landed`, or the code it answered (`sparql_update_refused`, `sparql_update_conflict`, `write_group_outcome_unknown`, ...).
 *
 * Its own module, as `write-group-metrics.ts`: `registry.ts` is held by the size ratchet. An operator reads a rising `sparql_update_conflict`
 * as Updates losing races on busy records, and any `write_group_outcome_unknown` or `sparql_update_cascade_incomplete` as one to look into.
 */
import { Counter } from 'prom-client';
import { register } from './registry.js';

export const sparqlUpdateTotal = new Counter({
  name: 'ythril_sparql_update_total',
  help: 'SPARQL Updates ended, by outcome: landed, or the code the Update was answered with',
  labelNames: ['outcome'] as const,
  registers: [register],
});
