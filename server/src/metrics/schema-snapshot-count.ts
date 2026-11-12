/**
 * Count what became of a schema snapshot without importing the metrics registry (`ythril_schema_snapshot_total{outcome}`, Q-735 and Q-738, bundle-265).
 *
 * ## The question it answers
 *
 * "How does the snapshot writer (`spaces/schema-snapshot-store.ts`) or the receiver (`sync/schema-snapshot-fetch.ts`) say what became of a snapshot,
 * when the registry reaches the modules that import them?" The registry cannot be imported by them (`no-runtime-import-cycles`), so it gives this leaf a
 * sink when it loads, as `metrics/scan-hold-count.ts` does for its counter; a count made before then (a unit test that never loads the registry) is
 * dropped, as no scrape would have read it.
 *
 * ## What it prevents
 *
 * One family, one label, one list. The outcomes are a hand-written list in the registry and again at each call: an outcome added to one and not the other
 * is a series nobody declared at zero. {@link SCHEMA_SNAPSHOT_OUTCOMES} is the one list: the registry pre-declares one series per entry and `note` takes
 * only a member of it.
 */
import { countSink } from './count-sink.js';

/**
 * What became of a snapshot: `written` (this server kept a version of its own or a layer's), `fetched` (kept from a member), `not_held` (the member
 * holds no such version), `route_missing` (the member has no such route), `lost_space` (the member no longer has the space), `not_shared` (the member serves no such version to this member: it was built from a network this member is not in), `refused_rung` (the member
 * refused this token the schema), `refused_hash`, `refused_shape` and `over_cap` (the text a member sent was refused), `failed` (anything else that went
 * wrong), `behind` (a fetched snapshot's links say this variation lags the sender's).
 */
export const SCHEMA_SNAPSHOT_OUTCOMES = [
  'written', 'fetched', 'not_held', 'route_missing', 'lost_space', 'not_shared', 'refused_rung', 'refused_hash', 'refused_shape', 'over_cap', 'failed', 'behind',
] as const;

/** An outcome, as `ythril_schema_snapshot_total` labels it. */
export type SchemaSnapshotOutcome = typeof SCHEMA_SNAPSHOT_OUTCOMES[number];

const outcomes = countSink<[outcome: SchemaSnapshotOutcome]>();

/** Called once by the registry, at load. */
export const setSchemaSnapshotSink = outcomes.set;

/** `ythril_schema_snapshot_total`, as the writer and the receiver count it: one snapshot, under what became of it. */
export const schemaSnapshotTotal = { note: outcomes.add };