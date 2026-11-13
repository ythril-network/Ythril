/**
 * Land the `schemaSnapshots` of an admin import body (Q-740, bundle-266, design r3 E-3 to E-6), after the records, inside the import act.
 *
 * ## What it does with each element
 *
 * Each element `{ fp, text, links }` goes through `keepVerifiedSnapshot` (the hash, the cap, the canonical shape, the shape of the links) and lands
 * as `fetched`: the envelope is no authority over origin (12-admin-api.md, own and foreign backups), and a version that is current here or a held
 * layer takes its own origin from the writer that keeps it. `from` is the envelope's `instanceId` only when that is an instance-id-shaped string
 * ({@link senderOf}); otherwise the row names no sender.
 *
 * ## What it prevents
 *
 * - **An import that fails over a version.** A refused text, or a write the store refused for a reason of its own, is skipped and counted
 *   (`refused`); the records have landed already and the gap scan owes the version afterwards. Only a store that is not answering ends the
 *   import, as it would a record write: the act fails and is retried whole.
 * - **A count nobody reads.** What it did is the answer's `schemaSnapshots: { landed, held, refused }`, the import's audit row (counts only), the
 *   metric (`imported`, `import_refused`, `failed`), and one warn line per import that refused any, naming at most {@link REFUSALS_NAMED} prefixes.
 */
import { storeIsNotAnswering } from '../db/store-condition.js';
import { isSchemaFingerprint } from '../spaces/schema-stamp.js';
import { schemaSnapshotTotal } from '../metrics/schema-snapshot-count.js';
import { log, peerList, peerText } from '../util/log.js';
import { keepVerifiedSnapshot } from './schema-snapshot-keep.js';

/** What an import did with the snapshots its body carried. */
export interface ImportedSnapshots {
  /** Rows this import inserted. */
  landed: number;
  /** Elements whose row was here already. */
  held: number;
  /** Elements skipped: not the text their fingerprint names, not the shape of an element, or a write the store refused. */
  refused: number;
}

/** How many refused fingerprint prefixes the warn line names. */
const REFUSALS_NAMED = 5;

/** The shape of an instance id this server takes as a sender's name: a short token of letters, digits and `.`, `_`, `:`, `-`. */
const INSTANCE_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

/** The sender an import's rows name: the envelope's `instanceId` when it is instance-id-shaped, else none. */
export function senderOf(envelope: ReadonlyMap<string, unknown>): string | undefined {
  const id = envelope.get('instanceId');
  return typeof id === 'string' && INSTANCE_ID_SHAPE.test(id) ? id : undefined;
}

/**
 * Land every element of `pages` in `spaceId` as `fetched` (from `from` when given). Throws only what a store that is not answering throws; every
 * other failure of one element is skipped and counted.
 */
export async function importSnapshots(spaceId: string, pages: AsyncIterable<readonly unknown[]>, from?: string): Promise<ImportedSnapshots> {
  const out: ImportedSnapshots = { landed: 0, held: 0, refused: 0 };
  const refusals: string[] = [];
  const refuse = (fp: unknown, why: string): void => {
    out.refused++;
    if (refusals.length < REFUSALS_NAMED) refusals.push(`${peerText(typeof fp === 'string' ? fp.slice(0, 12) : '(none)')} ${why}`);
  };
  for await (const page of pages) {
    for (const element of page) {
      const e = (element !== null && typeof element === 'object' && !Array.isArray(element) ? element : {}) as Record<string, unknown>;
      const fp = e['fp'];
      if (!isSchemaFingerprint(fp)) { schemaSnapshotTotal.note('import_refused'); refuse(fp, 'refused_shape'); continue; }
      try {
        const kept = await keepVerifiedSnapshot(spaceId, fp, e['text'], e['links'], from, 'imported');
        if (kept.outcome === 'written') out.landed++;
        else if (kept.outcome === 'held') out.held++;
        else if (kept.outcome === 'act_stands') refuse(fp, 'act_stands');
        else { schemaSnapshotTotal.note('import_refused'); refuse(fp, kept.outcome); }
      } catch (err) {
        if (storeIsNotAnswering(err)) throw err;
        schemaSnapshotTotal.note('failed');
        refuse(fp, `failed: ${peerText(err)}`);
      }
    }
  }
  if (out.refused > 0) {
    log.warn(`Import into space '${peerText(spaceId)}': ${out.refused} schema snapshot(s) of the body were not kept (${peerList(refusals, '; ')}); `
      + 'their records landed, and the gap scan asks members for those versions.');
  }
  return out;
}
