/**
 * Upgrade the place an operator's CONFIG still says `memory` after 5.0 renamed the type to `fact`.
 *
 * ## Why this is worse than the wire format
 *
 * The wire is protected: `MIN_PEER_VERSION` derives from our own major, so a peer below 5.0.0 is refused at
 * the handshake with a `426`. An operator's stored configuration has no handshake, and both of these fail
 * the same silent way — the setting stops applying and nothing says so.
 *
 * **`recordTtlDays: { memory: 30 }`** is a retention window. After the rename the key is unread, so the
 * records it governed are kept for ever. Nobody notices until the disk does.
 *
 * It produces no error, no warning and no metric. That is the whole reason this file exists rather than a
 * line in the release notes: a note is read by the operators who read notes.
 *
 * **The webhook half lives with the database migration**, not here — subscriptions are stored in Mongo,
 * not in the config file, and putting a Mongo update in the config loader is how a migration ends up
 * running at the wrong moment in boot.
 *
 * ## Why a rewrite and not an accept-both
 *
 * 5.0 is a hard break by decision, and accepting both spellings for ever is how a rename becomes permanent
 * dual vocabulary. This upgrades the file once, in place, and says what it changed. The equivalent for the
 * database is `db/rename-memories-to-facts.ts`, for the same reason and with the same shape.
 *
 * Idempotent: a config that has already been upgraded has no `memory` keys left to find.
 */
import type { SpaceConfig } from './types.js';
import { log } from '../util/log.js';

export interface ConfigRenameOutcome {
  /** Spaces whose `recordTtlDays.memory` became `recordTtlDays.fact`. */
  ttlWindows: string[];
}

/**
 * Rewrite in place, and report what moved so the caller can log it.
 *
 * Takes the spaces rather than the whole config so it can be exercised without a file on disk: the shape it
 * touches is the subject, and a test that has to write a config to check a key rename is testing the
 * loader.
 */
export function migrateMemoryToFact(spaces: SpaceConfig[] | undefined): ConfigRenameOutcome {
  const out: ConfigRenameOutcome = { ttlWindows: [] };

  for (const space of spaces ?? []) {
    const ttl = space.recordTtlDays;
    // A NUMBER is the space-wide default and has no per-type keys, so there is nothing to rename. Only the
    // per-kind object form carries the word.
    if (!ttl || typeof ttl !== 'object') continue;
    const windows = ttl as Record<string, unknown>;
    if (!('memory' in windows)) continue;
    // An existing `fact` wins: somebody set it deliberately on this build, and overwriting it with the old
    // value would undo a decision rather than complete a migration.
    if (!('fact' in windows)) windows['fact'] = windows['memory'];
    delete windows['memory'];
    out.ttlWindows.push(space.id);
  }

  if (out.ttlWindows.length > 0) {
    log.info(`Retention: renamed recordTtlDays.memory to .fact in ${out.ttlWindows.length} space(s): `
      + `${out.ttlWindows.join(', ')}. The window was unread after the type rename, so those records would `
      + 'have been kept for ever.');
  }
  return out;
}
