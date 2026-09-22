/**
 * Turn a space's existing array entries into link records — the one-off an operator runs after upgrading.
 *
 * ## Why it is a script and not a boot migration
 *
 * Link records SYNC. A boot migration writing synced data means every instance in a network independently
 * decides to create the same records at whatever moment it happens to restart, which is a large write burst
 * nobody asked for and a divergence report for as long as the peers disagree. `_REFERENCE.md →
 * migration-strategy` states the rule: synced data migrates lazily or on demand, and only LOCAL state may
 * migrate at boot.
 *
 * On demand is what this is. The operator picks the moment.
 *
 * ## Running it twice is a no-op, and that is load-bearing
 *
 * A link's id is a UUIDv5 over the two records and the class, so the second run computes the same ids and
 * `reconcileLinks` finds them already there. Nothing is written, nothing is duplicated, and nothing has to
 * remember whether the script has run — which means an interrupted run is fixed by running it again rather
 * than by working out where it stopped.
 *
 * ## It never deletes an array
 *
 * These documents replicate by whole-document replace, so a peer on an older build would restore any array
 * this removed — and a space where the two disagree lets whichever reader wins decide what is true. Creating
 * is safe at any time; removing is gated on a version floor and is not this script's job (`D-6`).
 *
 * ## What `completeLinkage` then means
 *
 * Set on the space when a conversion finishes with no failures: *"on THIS instance, every link in this space
 * is also a link record."* It is `SpaceConfig` and not `SpaceMeta` deliberately — meta is voted and applied
 * network-wide, so a marker there would announce one instance's finished conversion as everybody's.
 */
import { col, asFilter } from '../db/mongo.js';
import { nextSeq } from '../util/seq.js';
import { getConfig } from '../config/loader.js';
import { updateSpace } from '../spaces/spaces.js';
import { reconcileLinksForDocument, LINK_BEARING_COLLECTIONS } from './links.js';
import { LINK_CLASSES, legacyField } from './link-adjacency.js';
import { log } from '../util/log.js';
import { spaceCollection } from '../db/space-collection.js';

/** What one space's conversion did, per collection and in total. */
export interface ConversionReport {
  /**
   * Parent file records stamped with a `seq` they did not have — see `stampFileMetaSeqs`.
   *
   * OPTIONAL because the conversion itself no longer stamps: only the operator-run script does, and only
   * it fills this in. A boot conversion leaves it absent, which is the honest report of what it did.
   */
  fileSeqsStamped?: number;
  spaceId: string;
  /** Documents walked, by collection suffix. */
  scanned: Record<string, number>;
  /** Link records created. A re-run reports 0 and that is success, not a no-op to worry about. */
  added: number;
  /** Documents whose reconcile threw. Non-zero means `completeLinkage` is NOT set. */
  failed: number;
}

/** How many documents are read per round trip. Large enough to be quick, small enough not to hold a space's worth in memory. */
const PAGE = 200;

/**
 * Convert one space.
 *
 * Paged by `_id` rather than by `skip`: a skip-paged walk over a collection being written to at the same
 * time can visit a document twice and miss another entirely, and the one it misses is silent.
 */
/**
 * Give every parent file record a `seq`, so a file's metadata written before 4.0 can reach a peer.
 *
 * ## Why it is here and not a boot migration
 *
 * `P-32` made a file's metadata replicate, and the sync mechanism is seq-ordered: the page cursor is
 * `seq: { $gt: n }`, which never matches a document without one. So a record stamped before 4.0 simply does
 * not page to a peer until it is next written — correct, silent, and permanent for a file nobody edits.
 *
 * A boot migration over synced data is forbidden (`_REFERENCE.md → migration-strategy`): every instance in
 * a network would independently decide to stamp the same records at whatever moment it happened to restart,
 * and each would win the last-writer-wins comparison against the others in turn.
 *
 * So it rides in the script an operator already runs once after upgrading, and it is idempotent the same
 * way: a record that has a seq is left alone.
 *
 * ## And it stopped being true the moment conversion learned to run at boot
 *
 * This was called from `convertSpaceLinks`, which was only ever the script's function — until
 * `convertLinksOnBoot` started calling the same function at every startup on 2026-09-17. The paragraph
 * above then described a rule the code no longer kept, and nothing said so: the gate that refuses boot
 * migrations over synced data reads a function's own body and cannot follow three calls.
 *
 * **The version floor does not rescue it, which is why this is not simply sanctioned.** A 5.0 instance
 * refuses every 4.x peer, so no older peer can revert a link record — that is the argument that makes the
 * link conversion safe at boot. It says nothing here: every 5.0 peer in the network stamps the same records
 * with ITS OWN `seq` counter at whatever moment it happened to restart, so the same file record arrives at
 * each peer with a different number and the whole document is replaced each time one wins.
 *
 * So the call moved OUT of `convertSpaceLinks` and into `scripts/convert-links.mjs`, where the operator
 * path already was. A caller now has to reach for this by name, which is the only place the boot walk in
 * `no-boot-migration-on-synced-data` can see it.
 *
 * **Chunks are skipped**, because a chunk never replicates — it is derived from the blob and the receiver
 * makes its own.
 */
export async function stampFileMetaSeqs(spaceId: string): Promise<number> {
  let stamped = 0;
  for (;;) {
    const doc = await col<{ _id: string }>(spaceCollection(spaceId, 'files')).findOne(
      asFilter<{ _id: string }>({ seq: { $exists: false }, parentFileId: { $exists: false } }),
      { projection: { _id: 1 } },
    ) as { _id: string } | null;
    if (!doc) break;
    // One seq PER RECORD. A shared seq at a page boundary would leave the rest of that group unreachable,
    // because the cursor continues from the last item with `seq > since` and would step straight over them.
    await col(spaceCollection(spaceId, 'files')).updateOne(
      asFilter({ _id: doc._id }), { $set: { seq: await nextSeq(spaceId) } } as never,
    );
    stamped++;
  }
  return stamped;
}

/** What one space's conversion WOULD do — counted, with nothing written. */
export interface ConversionPreview {
  spaceId: string;
  /** Already converted on this instance, so the arrays are no longer the write surface. */
  converted: boolean;
  /** Records carrying a non-empty array, by class label (`fact.entityIds` and its five siblings). */
  records: Record<string, number>;
  /** Array entries across those records — the CEILING on links this space can gain, not the count. */
  entries: Record<string, number>;
  /** Link records the space already holds. Run the preview again after converting: this rises, the rest does not. */
  links: number;
}

/**
 * Count what a conversion would walk, writing nothing.
 *
 * ## Why a separate function and not a dry-run flag through `convertSpaceLinks`
 *
 * A dry run threaded through the writer is the defect this repository produces most — one rule, two
 * implementations, and the weaker one wins silently. A preview sharing the writer's path is one forgotten
 * `if` away from writing; a preview re-deriving the writer's decisions is a second implementation of them
 * that drifts.
 *
 * So this answers a DIFFERENT and strictly simpler question: how much is there. It reads the same class
 * table the writer reads, and makes no attempt to predict how many links result — an array entry naming a
 * record that no longer exists produces none, and two entries naming the same pair produce one. `entries`
 * is a ceiling and is named as one.
 *
 * ## What it is for
 *
 * An operator asked to run a migration against live data, who cannot see its scale beforehand and has been
 * told nothing about reversing it, defers it. That is the whole finding. This turns *"five repositories of
 * writers and no idea"* into a number per space, and gives a before-and-after they can read themselves.
 */
export async function previewSpaceLinks(spaceId: string): Promise<ConversionPreview> {
  const out: ConversionPreview = {
    spaceId,
    converted: getConfig().spaces.find(s => s.id === spaceId)?.completeLinkage === true,
    records: {},
    entries: {},
    links: await col(spaceCollection(spaceId, 'links')).countDocuments(asFilter({ spaceId })),
  };

  /*
   * DERIVED from the class table, so a seventh link class appears here on the day it is declared. A
   * hand-written list of six field names is the shape this file's own header argues against.
   *
   * `legacyField` and not a property of the class: 5.0 took the six arrays off the document types, and
   * this file is the ONE place that still knows they can be on disk — a space that never converted
   * holds its pre-upgrade links in them and nowhere else. Reading stored data the type no longer
   * declares is what a migration is for, and keeping the name on `LinkClass` would have offered it to
   * every reader instead.
   */
  for (const c of LINK_CLASSES) {
    const nonEmpty = asFilter({ [legacyField(c.toKind)]: { $exists: true, $ne: [] } });
    out.records[c.label] = await col(`${spaceId}_${c.collection}`).countDocuments(nonEmpty);
    const grouped = await col(`${spaceId}_${c.collection}`).aggregate([
      { $match: nonEmpty },
      // `$isArray` because a legacy record can carry the key as something that is not an array, and `$size`
      // on a non-array fails the whole aggregation rather than skipping that one document.
      { $group: { _id: null, n: { $sum: { $cond: [{ $isArray: `$${legacyField(c.toKind)}` }, { $size: `$${legacyField(c.toKind)}` }, 0] } } } },
    ]).toArray() as Array<{ n?: number }>;
    out.entries[c.label] = grouped[0]?.n ?? 0;
  }

  return out;
}

export async function convertSpaceLinks(spaceId: string): Promise<ConversionReport> {
  const report: ConversionReport = { spaceId, scanned: {}, added: 0, failed: 0 };

  for (const [suffix, fromKind] of Object.entries(LINK_BEARING_COLLECTIONS)) {
    if (!fromKind) continue;
    report.scanned[suffix] = 0;
    let after: string | undefined;

    for (;;) {
      const filter: Record<string, unknown> = after === undefined ? {} : { _id: { $gt: after } };
      const docs = await col<{ _id: string }>(`${spaceId}_${suffix}`)
        .find(asFilter<{ _id: string }>(filter))
        .sort({ _id: 1 })
        .limit(PAGE)
        .toArray() as Array<Record<string, unknown> & { _id: string }>;
      if (docs.length === 0) break;

      for (const doc of docs) {
        report.scanned[suffix] = (report.scanned[suffix] ?? 0) + 1;
        try {
          /*
           * ADDITIVE, and the COUNT comes from the writer rather than from a measurement around it.
           *
           * Both halves were wrong together. The desired set is built from the legacy ARRAYS, so a link
           * that already existed as a RECORD — which is what `linkEntities` wrote before `Q-28` — was
           * named by nothing and got deleted, with a tombstone, so the loss replicated to every peer.
           * A migration announced as *"additive: nothing is removed"* removed data.
           *
           * And the count was a countDocuments DELTA reported as *"N link(s) created"*: one creation
           * and one removal netted to `0`, indistinguishable from nothing to do, and a lone removal
           * printed `-1`. A live instance printed exactly that. `reconcileLinks` already returns both
           * numbers; measuring around it was a second implementation of a count it hands back.
           */
          const { added } = await reconcileLinksForDocument(spaceId, doc._id, fromKind, doc, { additive: true });
          report.added += added;
        } catch (err) {
          // One bad document must not stop the walk. It is counted, and the count is what withholds the
          // marker — a conversion that skipped a record and then claimed completeness is the failure this
          // whole design exists to avoid.
          report.failed++;
          log.warn(`convert links ${spaceId}/${suffix}/${doc._id}: ${err}`);
        }
      }
      after = docs[docs.length - 1]?._id;
    }
  }

  return report;
}

/**
 * Convert every space this instance holds, then mark the ones that finished clean.
 *
 * The marker is written per space and only when that space's walk had no failures. A single space that could
 * not be converted must not stop the others from being marked, and must not be marked itself.
 */
export async function convertAllLinks(): Promise<ConversionReport[]> {
  const reports: ConversionReport[] = [];
  for (const space of getConfig().spaces) {
    // A proxy space holds no documents of its own — it aggregates its members, which are converted in their
    // own right. Walking it would find nothing and then mark it complete on the strength of that.
    if (space.proxyFor && space.proxyFor.length > 0) continue;
    const report = await convertSpaceLinks(space.id);
    if (report.failed === 0) updateSpace(space.id, { completeLinkage: true });
    reports.push(report);
  }
  return reports;
}
