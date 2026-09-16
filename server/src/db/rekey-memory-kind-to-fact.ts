/**
 * Move every edge and link whose endpoint kind said `memory` onto the id it now derives from `fact`.
 *
 * ## Why renaming the type is not enough
 *
 * An edge's `_id` and a link's `_id` are DERIVED, not random — `edgeIdFor` hashes
 * `(from, to, label, fromKind, toKind)` so two peers that never talk arrive at the same id for the same
 * relationship. That is what `brain/edge-id.ts` exists for, and it works precisely because the inputs are
 * stable.
 *
 * 5.0 changes one of those inputs. A relationship stored as `fromKind: 'memory'` is under an id computed
 * from the word `memory`; from now on the same relationship derives an id computed from `fact`. Nothing
 * rewrites the stored row, so **the two drift apart in three ways, and every one of them is quiet**:
 *
 * - **A read finds nothing.** `reconcileLinks` and every traverse query filter on `fromKind`/`toKind`. A
 *   fact's existing link rows still say `memory`, so they match no query: "what points at this?" answers
 *   nothing, on a record with a dozen connections, with a 200 and an empty array.
 * - **A write collides.** The edges collection carries a unique index on `(from, to, label)`. The next peer
 *   to create that relationship derives the NEW id, inserts, and hits the index — the duplicate-key loop
 *   that deriving the id was introduced to remove, arriving back through the rename.
 * - **A delete is never served.** A tombstone's `type` is the knowledge type, and the map that serves them
 *   is keyed by it. A stored `type: 'memory'` is absent from the 5.0 map, so the peer asking for tombstones
 *   gets a well-formed response that simply omits it, and the record it deleted lives on there for ever.
 * - **A queued embedding never runs.** An embed job's `_id` is `<recordType>:<recordId>` and the worker
 *   resolves the collection from the type it stored. A job queued before the upgrade names a type that no
 *   longer exists, so the record it was going to embed never enters meaning-ranked search — and the queue
 *   reports it as pending for ever rather than as failed.
 *
 * ## Why this rewrites rows on a SYNCED collection, when synced migrations must be lazy
 *
 * The rule against boot-migrating synced content exists because a peer on the old build writes the old shape
 * back and the two disagree for ever. That cannot happen here: `MIN_PEER_VERSION` derives from our own
 * major, so a 5.0 instance refuses any peer below 5.0.0 at the handshake with a `426`. Every peer on the
 * network runs this same migration, over the same stored fields, through the same pure derivation — so they
 * converge on identical ids without exchanging anything.
 *
 * ## And that convergence is why there is NO TOMBSTONE, which is the opposite of what `rekeyEdge` does
 *
 * `brain/edge-rekey.ts` moves an edge at runtime and writes a real tombstone for the old id, because one
 * instance is making a change the others have to be told about. Here every instance makes the same change to
 * the same row on its own boot. A tombstone would be an instruction to delete a row the peer has already
 * migrated itself — noise at best. At worst it is wrong: `applyRemoteTombstone` only deletes a document
 * authored by the tombstone's issuer, so of two peers holding one peer-authored edge the tombstone is
 * dropped on one side and applied on the other, and they end up disagreeing about a row they had agreed on.
 *
 * The seq is left alone for the same reason. The row's CONTENT did not change — only the word one of its
 * fields spells a kind with — so there is nothing for a peer to pull.
 *
 * ## Idempotent, and a collision is reported rather than resolved
 *
 * A second boot finds no `memory` kinds left. If the target id is already taken the two rows are a genuine
 * duplicate of one relationship, and picking a winner is a decision this code cannot make: it is logged with
 * both ids and left alone, exactly as the collection rename treats a both-exist pair.
 */
import { getDb } from './mongo.js';
import { log } from '../util/log.js';
import { edgeIdFor } from '../brain/edge-id.js';
import { linkIdFor } from '../brain/links.js';
import type { RefKind } from '../config/types-knowledge.js';

/**
 * The old spelling, written out. NOT derived from anything — every derivation in the server now answers
 * `fact`, and this file is the one place the word `memory` must still exist. A bulk rename swept the
 * equivalent constant in `rename-memories-to-facts.ts` on its first pass, which would have made that
 * migration rename `_facts` to `_facts` and silently do nothing.
 */
const OLD_KIND = 'memory';
const NEW_KIND: RefKind = 'fact';

/** What a row keyed on kinds looks like, for both collections. Deliberately loose: this reads old shapes. */
interface KindedRow {
  _id: string;
  from: string;
  to: string;
  label?: string;
  fromKind?: string;
  toKind?: string;
  [k: string]: unknown;
}

export interface KindRekeyOutcome {
  /** Rows moved onto a new id, per collection suffix. */
  moved: Record<string, number>;
  /** Rows whose kind changed but whose id did not — nothing to move. */
  updatedInPlace: number;
  /** Rows left alone because the id they now derive is already taken by another row. */
  collisions: string[];
  /** Tombstones whose `type` was rewritten, so the deletion is served to peers again. */
  tombstones: number;
  /** Queued embed jobs re-keyed onto the new record type. */
  embedJobs: number;
}

const suffixOf = (name: string, suffix: string): string | null =>
  name.endsWith(suffix) ? name.slice(0, -suffix.length) : null;

export async function rekeyMemoryKindToFact(): Promise<KindRekeyOutcome> {
  const db = getDb();
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name);
  const out: KindRekeyOutcome = { moved: {}, updatedInPlace: 0, collisions: [], tombstones: 0, embedJobs: 0 };

  for (const name of names) {
    const isEdges = suffixOf(name, '_edges') !== null;
    const isLinks = suffixOf(name, '_links') !== null;
    if (!isEdges && !isLinks) continue;

    const coll = db.collection<KindedRow>(name);
    const stale = await coll.find({
      $or: [{ fromKind: OLD_KIND }, { toKind: OLD_KIND }],
    }).toArray();
    if (stale.length === 0) continue;

    for (const row of stale) {
      const fromKind = (row.fromKind === OLD_KIND ? NEW_KIND : row.fromKind) as RefKind | undefined;
      const toKind = (row.toKind === OLD_KIND ? NEW_KIND : row.toKind) as RefKind | undefined;

      // A link's label is derived from its kinds and is not stored, so the two collections compute their id
      // through the function that owns each shape rather than through one re-implementation here.
      const newId = isLinks
        ? linkIdFor(row.from, fromKind as RefKind, row.to, toKind as RefKind)
        : edgeIdFor(row.from, row.to, row.label ?? '', fromKind, toKind);

      if (newId === row._id) {
        await coll.updateOne({ _id: row._id }, { $set: { fromKind, toKind } });
        out.updatedInPlace += 1;
        continue;
      }

      const taken = await coll.findOne({ _id: newId }, { projection: { _id: 1 } });
      if (taken) {
        out.collisions.push(`${name}:${row._id}`);
        log.warn(`Re-key skipped in ${name}: ${row._id} now derives ${newId}, which another row already `
          + 'holds. Both describe the same connection and merging them is a decision this code cannot '
          + 'make — remove one by hand.');
        continue;
      }

      // Insert BEFORE delete: a crash between the two leaves a duplicate a re-run reports, where the other
      // order would leave the connection gone with nothing left to report it.
      await coll.insertOne({ ...row, _id: newId, fromKind, toKind });
      await coll.deleteOne({ _id: row._id });
      out.moved[name] = (out.moved[name] ?? 0) + 1;
    }
  }

  /*
   * AND THE TOMBSTONES, which carry the knowledge type rather than a ref kind.
   *
   * These are not re-keyed — a tombstone's `_id` is the id of the document it deletes, and that did not
   * change. Only the word naming what kind of thing it was.
   */
  for (const name of names.filter(n => n.endsWith('_tombstones'))) {
    const res = await db.collection(name).updateMany({ type: OLD_KIND }, { $set: { type: NEW_KIND } });
    out.tombstones += res.modifiedCount;
  }

  /*
   * AND THE EMBED QUEUE. Local state, never replicated — but the same derived-identifier failure: a job
   * whose `_id` and `recordType` still say `memory` is claimed by a worker that cannot resolve the
   * collection, so it neither embeds nor reports, and the queue shows it pending for ever.
   *
   * Re-keyed rather than dropped: dropping a job loses the only record that a document is waiting to be
   * embedded, and nothing would re-enqueue it until somebody edits the document.
   */
  for (const name of names.filter(n => n.endsWith('_embed_jobs'))) {
    const coll = db.collection<{ _id: string; recordId?: string; [k: string]: unknown }>(name);
    for (const job of await coll.find({ recordType: OLD_KIND }).toArray()) {
      const newId = `${NEW_KIND}:${job.recordId ?? job._id.slice(OLD_KIND.length + 1)}`;
      if (await coll.findOne({ _id: newId }, { projection: { _id: 1 } })) {
        // A job for the same record already exists under the new key. The queue de-duplicates by id, so the
        // two are one piece of work — dropping the stale one is the de-duplication, not a loss.
        await coll.deleteOne({ _id: job._id });
      } else {
        await coll.insertOne({ ...job, _id: newId, recordType: NEW_KIND });
        await coll.deleteOne({ _id: job._id });
      }
      out.embedJobs += 1;
    }
  }

  const movedTotal = Object.values(out.moved).reduce((a, b) => a + b, 0);
  if (movedTotal > 0 || out.updatedInPlace > 0 || out.tombstones > 0 || out.embedJobs > 0) {
    log.info(`Re-keyed ${movedTotal} edge/link row(s) and ${out.embedJobs} embed job(s), and rewrote `
      + `${out.tombstones} tombstone type(s) after `
      + `the knowledge type \`${OLD_KIND}\` became \`${NEW_KIND}\`. Their ids are derived from the kind, so `
      + 'without this a fact\'s existing connections would answer no query.');
  }
  return out;
}
