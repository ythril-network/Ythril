/**
 * Turn a space's existing array entries into link records — at every start, and from the operator's script.
 *
 * ## Where it runs
 *
 * It was written as a script the operator ran, because link records SYNC and the rule for synced data is
 * that it migrates lazily or on demand (`_REFERENCE.md → migration-strategy`). 5.0 removed the arrays, so
 * the owner had it run at every start instead (`links-convert-on-boot.ts`, which carries that reasoning);
 * the script (`npm run links:convert`, from a source checkout) is still the way to walk one space by name or
 * preview what a walk would do.
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
import { withSeq } from '../util/seq.js';
import { getConfig } from '../config/loader.js';
import { updateSpace } from '../spaces/spaces.js';
import { reconcileLinksForDocument, LINK_BEARING_COLLECTIONS } from './links.js';
import { LINK_CLASSES, legacyField } from './link-adjacency.js';
import { eachSpace, eachUnit } from '../util/housekeeping-walk.js';
import { declareStep } from '../util/housekeeping-signals.js';
import { spaceCollection } from '../db/space-collection.js';
import { LIVE_FILE_ROW } from '../files/live-file-row.js';
import { isProxy } from '../spaces/proxy.js';

/**
 * Whether a space is a SUBJECT of the link conversion: walked, marked, and reported when it was left behind.
 *
 * A proxy is not. It holds no records of its own — its members do, and they convert in their own right — so
 * walking one finds nothing and would then mark it complete on the strength of that, and it is never marked,
 * so any site asking only *"is it marked?"* reports it unconverted for ever. The array clear did exactly
 * that: every boot of an instance with a pre-5.0 proxy warned that the proxy still held its links as arrays
 * (`Q-78`). One question, asked by every site that chooses spaces for link work, so the next one cannot
 * answer it differently.
 */
export function linkConversionConcerns(space: NonNullable<Parameters<typeof isProxy>[0]>): boolean {
  return !isProxy(space);
}

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
      // `LIVE_FILE_ROW`, which is the `parentFileId` half this spelled out plus the flag: stamping a seq on the audit
      // record of a deleted file advances the space counter for a row no peer is ever offered.
      asFilter<{ _id: string }>({ seq: { $exists: false }, ...LIVE_FILE_ROW }),
      { projection: { _id: 1 } },
    ) as { _id: string } | null;
    if (!doc) break;
    // One seq PER RECORD. A shared seq at a page boundary would leave the rest of that group unreachable,
    // because the cursor continues from the last item with `seq > since` and would step straight over them.
    await withSeq(spaceId, (seq) => col(spaceCollection(spaceId, 'files')).updateOne(
      asFilter({ _id: doc._id }), { $set: { seq } } as never,
    ), 'file.stamp-seq');
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
    // The preview counts what the conversion will convert, so it takes the same files narrowing (below): a count that
    // included deleted files would promise link records the conversion then does not make.
    const nonEmpty = asFilter({ [legacyField(c.toKind)]: { $exists: true, $ne: [] },
      ...(c.collection === 'files' ? LIVE_FILE_ROW : {}) });
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

/** The step the conversion's failures are counted and said under (`util/housekeeping-signals.ts`). */
export const LINK_CONVERSION_STEP = declareStep('Link conversion');

/**
 * Convert ONE space and report it, as a walk of its own: the entry for a caller that has a single space in hand (the script's
 * named-space mode). It THROWS when the space itself could not be converted (a collection that cannot be read, a store that
 * stopped answering), as the walk it replaced did; a document that did not reconcile is `report.failed`, not a throw.
 *
 * A caller that already walks spaces does not call this: it calls {@link convertAndMarkSpaces}, which converts inside ITS walk.
 * Two walks nested would report one failure twice and count one timeout against two budgets.
 */
export async function convertSpaceLinks(spaceId: string): Promise<ConversionReport> {
  let report: ConversionReport | undefined;
  const walk = await eachSpace(LINK_CONVERSION_STEP, [spaceId], async () => { report = await convertSpaceInWalk(spaceId); }, { when: 'next boot' });
  if (report) return report;
  throw new Error(walk.failed[0]?.reason ?? 'the conversion did not run');
}

/**
 * Convert one space, inside a walk: the documents are the units (`eachUnit`), so a document that fails is reported by name and
 * counted, and a timeout or a store that stopped answering ends the SPACE at once. A catch of its own here would count a hung
 * space's every document as a document that did not reconcile and pay one bound for each of them.
 */
async function convertSpaceInWalk(spaceId: string): Promise<ConversionReport> {
  const report: ConversionReport = { spaceId, scanned: {}, added: 0, failed: 0 };

  for (const [suffix, fromKind] of Object.entries(LINK_BEARING_COLLECTIONS)) {
    if (!fromKind) continue;
    report.scanned[suffix] = 0;
    let after: string | undefined;

    for (;;) {
      // A link record replicates, so converting a deleted file's legacy array would push a link whose source the peer
      // holds a tombstone for. The preview above carries the same narrowing, so the two cannot disagree.
      const filter: Record<string, unknown> = {
        ...(suffix === 'files' ? LIVE_FILE_ROW : {}),
        ...(after === undefined ? {} : { _id: { $gt: after } }),
      };
      const docs = await col<{ _id: string }>(`${spaceId}_${suffix}`)
        .find(asFilter<{ _id: string }>(filter))
        .sort({ _id: 1 })
        .limit(PAGE)
        .toArray() as Array<Record<string, unknown> & { _id: string }>;
      if (docs.length === 0) break;

      // One bad document must not stop the walk. It is reported by name and counted, and the count is what withholds the
      // marker — a conversion that skipped a record and then claimed completeness is the failure this whole design exists
      // to avoid.
      const { failed } = await eachUnit(docs, doc => convertDocument(report, suffix, fromKind, doc), doc => `${suffix}/${doc._id}`);
      report.failed += failed.length;
      after = docs[docs.length - 1]?._id;
    }
  }

  return report;
}

/**
 * One document's links, added to `report`. A concise call from `eachUnit` on purpose: `no-boot-migration-on-synced-data` walks the
 * boot graph through a call and not into a closure's braces, so what a document's conversion reaches would be invisible to it.
 */
async function convertDocument(
  report: ConversionReport, suffix: string, fromKind: NonNullable<(typeof LINK_BEARING_COLLECTIONS)[string]>,
  doc: Record<string, unknown> & { _id: string },
): Promise<void> {
  report.scanned[suffix] = (report.scanned[suffix] ?? 0) + 1;
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
  const { added } = await reconcileLinksForDocument(report.spaceId, doc._id, fromKind, doc, { additive: true });
  report.added += added;
}

/** A space that was not converted, and why: what the boot ERROR line and the script's output name. */
export interface FailedLinkConversion { spaceId: string; reason: string }

/** What a conversion run did: a report per space it walked to the end, and every space that is NOT converted. */
export interface ConversionOutcome {
  reports: ConversionReport[];
  /**
   * Every space this run left unconverted and unmarked, in the order given, each with its reason: one that threw, one with
   * documents that did not reconcile, and one the run never reached (the store stopped answering, or the space is in
   * quarantine). A space absent from this list, and present in `reports`, is converted.
   */
  failedSpaces: FailedLinkConversion[];
}

/** Why a space whose walk finished is still not converted: the documents that did not reconcile. */
export function unreconciledReason(report: ConversionReport): string {
  return `${report.failed} document(s) failed to reconcile`;
}

/**
 * One space, inside `convertAndMarkSpaces`'s walk: converted, and marked only when no document failed. A concise call from the
 * walk on purpose (see {@link convertDocument}: the boot gate follows calls, not closure bodies).
 */
async function convertAndMarkSpace(spaceId: string, reports: ConversionReport[], unreconciled: Map<string, string>): Promise<void> {
  const report = await convertSpaceInWalk(spaceId);
  reports.push(report);
  if (report.failed > 0) { unreconciled.set(spaceId, unreconciledReason(report)); return; }
  updateSpace(spaceId, { completeLinkage: true });
}

/**
 * Convert each of `spaces` on its own and mark the ones that finished clean — the ONE place the rule "marked only on a clean
 * walk" is written, for the boot conversion and the operator's script alike (they had a copy each, and the weaker one is the
 * one that threw away the other spaces).
 *
 * The marker is written per space and only when that space's walk had no failures: `completeLinkage` makes a space refuse
 * array writes, so marking one whose walk was partial would start refusing writes for links that were never created. A space
 * that failed does not stop the others (`eachSpace`: isolated, bounded, one bound for a hung space, the walk ended for a store
 * that does not answer), is not marked, and is NAMED in `failedSpaces` with its reason, because a caller that was handed only
 * the reports could not tell "converted" from "never reached".
 */
export async function convertAndMarkSpaces(spaces: readonly { id: string }[]): Promise<ConversionOutcome> {
  const reports: ConversionReport[] = [];
  const unreconciled = new Map<string, string>();
  const walk = await eachSpace(LINK_CONVERSION_STEP, spaces, space => convertAndMarkSpace(space.id, reports, unreconciled), { when: 'next boot' });

  const threw = new Map(walk.failed.filter(f => f.unit === undefined).map(f => [f.spaceId, f.reason]));
  const reached = new Set(walk.outcomes.filter(o => o.status !== 'skipped').map(o => o.spaceId));
  const notReached = walk.storeDown ? 'not reached: the store stopped answering before this space'
    : walk.stalled ? 'not reached: several spaces in a row ran past their time bound, so the walk stopped'
      : 'skipped: it ran past its time bound recently and is waiting out its quarantine';
  const failedSpaces: FailedLinkConversion[] = [];
  for (const { id } of spaces) {
    const reason = threw.get(id) ?? unreconciled.get(id) ?? (reached.has(id) ? undefined : notReached);
    if (reason !== undefined) failedSpaces.push({ spaceId: id, reason });
  }
  return { reports, failedSpaces };
}

/**
 * Convert every space this instance holds, then mark the ones that finished clean ({@link convertAndMarkSpaces}). A proxy is
 * not walked: it holds no records of its own (`linkConversionConcerns`).
 */
export async function convertAllLinks(): Promise<ConversionOutcome> {
  return convertAndMarkSpaces(getConfig().spaces.filter(linkConversionConcerns));
}
