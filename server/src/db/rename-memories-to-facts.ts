/**
 * Rename every `<space>_memories` collection to `<space>_facts`, once, on boot.
 *
 * ## Why this exists and why it cannot be skipped
 *
 * 5.0 renames the knowledge type `memory` to `fact`, and the collection name is derived from the type. An
 * instance that upgrades without this finds no `<space>_facts` collection, creates an empty one, and
 * reports zero facts in a space that holds thousands. Nothing errors: a read of a collection that does not
 * exist is an empty result, which is the same shape as a space nobody has written to.
 *
 * **That is the whole danger.** A migration that fails loudly is an outage; this one would fail silently
 * and look like data loss to the operator and like an empty space to every agent.
 *
 * ## Why a BOOT migration is allowed here, when synced data migrations must be lazy
 *
 * The rule is that a migration touching SYNCED CONTENT must be lazy, because a peer on the old build writes
 * the old shape back and the two instances then disagree for ever. This migration does not touch content:
 * it renames a container. Every document inside keeps its `_id`, its fields and its hash, so what
 * replicates is unchanged and a peer cannot undo it.
 *
 * The wire format IS changing in the same release — `entryType: 'memory'` becomes `'fact'` — and that half
 * is protected differently: `MIN_PEER_VERSION` derives from our own major, so a 5.0 instance refuses any
 * peer below 5.0.0 at the handshake with a `426`. A network upgrades together or not at all.
 *
 * ## Idempotent, and it says what it did
 *
 * Renaming is skipped when the target already exists, so a second boot is a no-op. It runs before any
 * service reads a collection, and it logs one line per space — an operator upgrading a busy instance should
 * be able to see this happen rather than infer it from the counts afterwards.
 *
 * **A target that already exists alongside a non-empty source is NOT quietly skipped.** That means a
 * half-finished migration or a hand-made collection, and merging them by guessing which document wins is
 * the kind of repair that loses data quietly. It is reported and left alone for a human.
 */
import { getDb } from './mongo.js';
import { log } from '../util/log.js';

/**
 * The suffix pair, written out. NOT derived from `COLLECTION_SUFFIX`, and deliberately so: the map holds the
 * NEW name only, and this file is the one place the OLD name must survive. A bulk rename of `_memories`
 * across the server swept this constant too on the first pass, which would have made the migration rename
 * `_facts` to `_facts` and silently do nothing — the exact failure it exists to prevent, wearing its own
 * clothes.
 */
const OLD_SUFFIX = '_memories';
const NEW_SUFFIX = '_facts';

export interface RenameOutcome {
  renamed: string[];
  skipped: string[];
  conflicts: string[];
}

export async function renameMemoriesToFacts(): Promise<RenameOutcome> {
  const db = getDb();
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name);
  const out: RenameOutcome = { renamed: [], skipped: [], conflicts: [] };

  for (const from of names.filter(n => n.endsWith(OLD_SUFFIX))) {
    const to = from.slice(0, -OLD_SUFFIX.length) + NEW_SUFFIX;

    if (names.includes(to)) {
      // Both exist. Which one is authoritative is not a question this code can answer.
      const oldCount = await db.collection(from).estimatedDocumentCount();
      if (oldCount === 0) {
        out.skipped.push(from);
        continue;
      }
      out.conflicts.push(from);
      log.warn(`Rename skipped: both ${from} (${oldCount} documents) and ${to} exist. `
        + 'A previous migration did not finish, or one was created by hand. Merge them and remove '
        + `${from} — this instance is serving ${to} and cannot see the other.`);
      continue;
    }

    await db.collection(from).rename(to);
    out.renamed.push(to);
    log.info(`Renamed ${from} to ${to} (the knowledge type \`memory\` became \`fact\` at 5.0)`);
  }

  if (out.renamed.length > 0) {
    log.info(`Renamed ${out.renamed.length} collection(s) from ${OLD_SUFFIX} to ${NEW_SUFFIX}.`);
  }
  return out;
}
