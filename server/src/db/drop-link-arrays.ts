/**
 * Clear the six link arrays off every stored record, once, on the boot that first runs 5.0.
 *
 * ## Why undeclaring them is not enough, and the reason is the HASH
 *
 * 5.0 removes `fact.entityIds`, `chrono.entityIds`/`memoryIds` and `file.entityIds`/`memoryIds`/`chronoIds`
 * from the document types, the ingest schemas and every reader. A key already on disk survives all of that:
 * TypeScript describes what the code expects, not what Mongo holds.
 *
 * **And `brain/merkle.ts` hashes facts and chrono entries by EXCLUSION.** `DERIVED_FIELDS` names what is
 * left out and everything else is hashed, so a leftover `entityIds` is still part of a space's hash — for
 * as long as it is there, on whichever instances happen to still have it. Two peers holding identical data,
 * one of which was upgraded from 4.x and one of which was not, would then disagree on every space hash and
 * log `MERKLE_DIVERGENCE` every cycle, permanently, about nothing. The check is advisory, so nothing ever
 * contradicts it — and a permanent false alarm teaches an operator to ignore the one signal that means data
 * really is missing.
 *
 * **Files are the other polarity and need no migration.** `FILE_HASH_PROJECTION` is an INCLUSION list, so
 * dropping the three names from it is enough: a leftover key on a file record is already outside the hash.
 * They are `$unset` here anyway, because a stored field nothing declares is a field the next reader
 * rediscovers.
 *
 * ## Why a boot migration over synced data is allowed here
 *
 * The rule against it exists because a peer on the old build writes the old shape back and the two disagree
 * for ever. That cannot happen: `MIN_PEER_VERSION` derives from our own major, so a 5.0 instance refuses
 * every peer below 5.0.0 at the handshake with a `426`. Every peer runs this same migration over the same
 * fields, so they converge without exchanging anything — the same argument `rekey-memory-kind-to-fact.ts`
 * makes, and it is the argument the peer floor exists to support.
 *
 * ## AFTER the link conversion, and that ordering is load-bearing
 *
 * `convertLinksOnBoot` reads these arrays to create the link records that replace them. Run this first and
 * it deletes the only copy of an unconverted space's pre-upgrade links — silently, because an empty array
 * and a converted array look identical to everything downstream. So this runs last, and only over spaces
 * the conversion has MARKED: a space whose walk failed keeps its arrays, and `assertLinkRecords` refuses to
 * read it until somebody fixes that.
 *
 * ## No tombstone, and no seq bump
 *
 * The record's CONTENT did not change — a field that no longer exists was removed from its storage, and
 * every peer is doing the same thing to the same rows on its own boot. A tombstone would be an instruction
 * to delete something the peer has already handled, and a seq bump would make every record in every space
 * look newer than its copy on a peer that has also migrated it, dragging a full re-pull of the entire
 * corpus behind a change that moved no data.
 */
import { getDb } from './mongo.js';
import { getConfig } from '../config/loader.js';
import { log } from '../util/log.js';

/** The six, written out: they no longer exist anywhere to derive them from. That is the point of this file. */
const ARRAYS_BY_SUFFIX: Record<string, readonly string[]> = {
  facts: ['entityIds'],
  chrono: ['entityIds', 'memoryIds'],
  files: ['entityIds', 'memoryIds', 'chronoIds'],
};

export interface LinkArrayDropOutcome {
  /** Records cleared, per collection. Absent means the collection had none left. */
  cleared: Record<string, number>;
  /** Spaces skipped because their links were never converted — their arrays are the only copy. */
  unconverted: string[];
}

/**
 * Best-effort and idempotent: a second boot finds nothing to clear.
 *
 * It never throws. One space's failure must not stop an instance, for the same reason the conversion does
 * not refuse the boot — and unlike the conversion, nothing downstream depends on this having run: a
 * leftover array is a wrong hash, not wrong data.
 */
export async function dropLinkArrays(): Promise<LinkArrayDropOutcome> {
  const out: LinkArrayDropOutcome = { cleared: {}, unconverted: [] };
  const db = getDb();

  for (const space of getConfig().spaces) {
    if (space.completeLinkage !== true) {
      // The arrays ARE this space's links until the conversion has walked it. See the note above.
      out.unconverted.push(space.id);
      continue;
    }
    for (const [suffix, fields] of Object.entries(ARRAYS_BY_SUFFIX)) {
      const name = `${space.id}_${suffix}`;
      try {
        const res = await db.collection(name).updateMany(
          { $or: fields.map(f => ({ [f]: { $exists: true } })) },
          { $unset: Object.fromEntries(fields.map(f => [f, ''])) },
        );
        if (res.modifiedCount > 0) out.cleared[name] = res.modifiedCount;
      } catch (err) {
        log.warn(`drop-link-arrays: ${name} failed, will retry next boot: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const total = Object.values(out.cleared).reduce((a, b) => a + b, 0);
  if (total > 0) log.info(`drop-link-arrays: cleared the retired link arrays off ${total} record(s)`);
  if (out.unconverted.length > 0) {
    log.warn(`drop-link-arrays: ${out.unconverted.length} space(s) still hold their links as arrays and were `
      + `left alone — ${out.unconverted.join(', ')}. Their link reads are refused until \`npm run links:convert\` `
      + 'has walked them cleanly; that refusal names the space.');
  }
  return out;
}
