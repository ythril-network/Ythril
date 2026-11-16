/**
 * The sync tombstone metrics: what peer tombstones did here (applied, declined) and how many re-reads are still owed.
 *
 * ## What it prevents (Q-398)
 *
 * `registry.ts` is the registration file for every metric and had grown past its size limit by carrying the declarations
 * of a sync concern. The three tombstone metrics and their zero pre-declaration live here, beside the other leaves of the
 * metrics seam, so the registry holds one call that registers them and no sync rule.
 *
 * ## Why a function and not a module that imports `register`
 *
 * The registry imports this module, so this module cannot import the registry back (`no-runtime-import-cycles`; the `*-count.ts`
 * leaves in this folder say the same). The registry hands its `Registry` in and re-exports what comes back, so every caller keeps
 * importing the three metrics from `./registry.js` and no importer can load one without the other being registered.
 *
 * Names, labels and help texts are what dashboards and alert rules read (`docs/integration-guide/11-setup-api.md`); they do not
 * change with where they are declared.
 */
import { Counter, Gauge, type Registry } from 'prom-client';
import { TOMBSTONE_TYPES } from '../config/types-knowledge.js';

/** The metrics of the sync tombstone concern and the door that gives the owed count its reader. */
export interface SyncTombstoneMetrics {
  syncTombstonesAppliedTotal: Counter<'kind' | 'ground' | 'outcome'>;
  syncTombstonesDeclinedTotal: Counter<'kind' | 'reason'>;
  syncTombstoneRereadsOwed: Gauge;
  /** The owed count is read through this provider at scrape time; unregistered it reports 0 (see `declareSyncTombstoneMetrics`). */
  setRereadsOwedProvider: (fn: () => number) => void;
}

/**
 * Declares the three tombstone metrics on `register` and pre-declares their series at zero.
 *
 * Called once, by the registry. A second call on the same registry would register the names twice and throw.
 */
export function declareSyncTombstoneMetrics(register: Registry): SyncTombstoneMetrics {
  /**
   * Peer tombstones that deleted something here, by what they deleted and on which ground (bundle-51, D-14).
   *
   * `kind` is a record type or `file`; `ground` is `issuer` (the delivering peer proved the issuer and the issuer wrote
   * the object, as always) or `upstream` (the deliverer is this space's upstream and relayed the object — the D-14
   * ground). The second is the number an operator watches after upgrading: every deletion a publisher caused here that
   * the old rule would have declined.
   */
  const syncTombstonesAppliedTotal = new Counter({
    name: 'ythril_sync_tombstones_applied_total',
    help: 'Peer tombstones applied, by kind (record type or file), ground (issuer, upstream, absent) and outcome (deleted, already_newer)',
    labelNames: ['kind', 'ground', 'outcome'] as const,
    registers: [register],
  });

  /**
   * Peer tombstones this instance declined to apply, by kind and reason (`not_issuer`, `not_author`, `not_upstream`).
   *
   * A decline is a deletion that did not happen here, and a standing one is how a replica ends up holding what its source
   * deleted — so it is a series, not only a deduplicated log line. The reasons are the deletion authority's verdicts, one
   * set for records and files.
   */
  const syncTombstonesDeclinedTotal = new Counter({
    name: 'ythril_sync_tombstones_declined_total',
    help: 'Peer tombstones declined by the deletion authority, by kind (record type or file) and reason (not_issuer, not_author, not_upstream)',
    labelNames: ['kind', 'reason'] as const,
    registers: [register],
  });

  // Pre-declared, so a scrape before the first deletion reports 0 rather than nothing: absent and zero look identical on
  // a graph and mean opposite things (`recallDegradedTotal`). The kinds are the tombstone types plus `file`, derived.
  for (const kind of [...TOMBSTONE_TYPES, 'file']) {
    for (const ground of ['issuer', 'upstream']) syncTombstonesAppliedTotal.labels({ kind, ground }).inc(0);
    for (const reason of ['not_issuer', 'not_author', 'not_upstream']) syncTombstonesDeclinedTotal.labels({ kind, reason }).inc(0);
  }

  /**
   * One-time tombstone re-reads still owed: (upstream, space) pairs whose repair is not yet `'done'`.
   *
   * Counted from the config at scrape time through a provider, because the count needs the network model and the registry is
   * imported by nearly every file (`setPostureProvider` there says why a provider and not an import). Unregistered it
   * reports 0, the honest answer for "nothing has been computed". A value that stays above zero is a repair that keeps
   * stopping; the log line says where.
   */
  let rereadsOwedProvider: (() => number) | null = null;
  const setRereadsOwedProvider = (fn: () => number): void => {
    rereadsOwedProvider = fn;
  };
  const syncTombstoneRereadsOwed = new Gauge({
    name: 'ythril_sync_tombstone_rereads_owed',
    help: 'Upstream tombstone re-reads (per upstream and space) not yet completed — the one-time repair, after an upgrade, of deletions an upstream sent that this instance declined',
    registers: [register],
    collect() {
      try {
        this.set(rereadsOwedProvider?.() ?? 0);
      } catch {
        this.set(0);   // A metrics scrape must never be the thing that fails.
      }
    },
  });
  syncTombstoneRereadsOwed.set(0);

  return { syncTombstonesAppliedTotal, syncTombstonesDeclinedTotal, syncTombstoneRereadsOwed, setRereadsOwedProvider };
}
