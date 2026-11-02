/**
 * What the edges and links that LANDED in one transfer point at that is not here — checked once the transfer is whole,
 * recorded once per dangling end, for a strict-linkage space.
 *
 * ## What this prevents (bundle-30 I8, pre-ship data-integrity and performance lenses)
 *
 * The check ran fire-and-forget right after each PAGE landed.
 * <!-- replicated-family-order -->
 * A pull lands its families one page at a time in `REPLICATED_FAMILIES` order, now facts, entities, chrono, filemeta, edges, links;
 * in the order the list had then (it is quoted as history in `sync/replicated-families.ts`) an edge to a chrono entry, or a
 * link to a file, created in the same interval was checked while its target was still to be pulled, and recorded as a
 * violation. Each record had a fresh uuid that nothing dedupes, so every later re-landing of the edge added another.
 * This is the copy that RECORDS rather than refuses (the y-flows red flag `red-flag-architecture-copy-that-records`): an operator reads each of those as real damage. And
 * every landed edge cost two unawaited `findOne`s, every link one — about twenty thousand on a 50-page pull.
 *
 * So a door collects what landed (`add`) and checks once (`run`) when its transfer is whole: a pull after every
 * family of the space's transfer, a push after the request's page — with the families the sender has still to push
 * after it named as `stillToCome` (`familiesAfter`), and the target families the sender says stopped early earlier in its cycle (`incomplete`,
 * bundle-39 D4) beside them. The push door's request is ONE family, because the sender pushes
 * one per request; that is why the families travel targets first (`REPLICATED_FAMILIES`, bundle-30 I13), and why an
 * edge to a chrono entry pushed in the old order (edges before chrono) was still recorded after I8.
 *
 * The check is one by-id read per target kind (`readStoredById`, chunked), in a write bound of its own, so its cost is
 * bounded by the transfer rather than by the pool and its time by the bound. The pull awaits it (in a `finally`, so a
 * fetch that rejects mid-cycle still checks what landed); the push door STARTS it and answers (`start`). A target in a
 * family that may still arrive (`stillToCome`) is not checked: it may be in what was not served yet, and recording it
 * would be the false violation this exists to prevent.
 *
 * ## Once per dangling end
 *
 * A violation's `_id` is derived from what it says — the document, the field, the target — and written with
 * `$setOnInsert`, so checking the same edge again (an edit lands, a page is re-sent) finds the record already there.
 * The webhook fires only for the one that was new. A record an instance made before ids were derived (a random uuid) is
 * adopted by the derived one when its end is checked again, not duplicated beside it (`oldRecordsOf`, Q-336).
 *
 * It only RECORDS, never throws: sync ingest is validated, counted and let in, and a refusal would hold the
 * watermark and stop the channel. A failure to record is logged once per run.
 */
import { derivedV4Id } from '../util/derived-id.js';
import { col } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { notFlaggedIfFile } from '../files/live-file-row.js';
import { outsideWriteBound, withinWriteBound } from '../db/write-bound.js';
import { readStoredById } from '../db/read-by-id.js';
import { isWellFormedRef, collectionForStoredKind, edgeEndpointKind } from '../brain/entity-refs.js';
import { isStrictLinkage } from '../spaces/space-lookup.js';
import { emitWebhookEvent } from '../webhooks/dispatcher.js';
import { log, peerText } from '../util/log.js';
import { DetachedWork } from '../util/detached-work.js';
import type { RefKind } from '../config/types-knowledge.js';
import type { LinkViolationDoc } from '../config/types.js';
import type { SpacePart } from '../db/space-collection.js';
import { REFERENCE_FAMILIES } from './replicated-families.js';

interface Arrived { _id: string; [k: string]: unknown }

/** One end of a landed record that must exist here: where the violation is filed, and what it points at. */
interface Target {
  docId: string;
  docType: LinkViolationDoc['docType'];
  field: string;
  kind: RefKind;
  id: string;
  /** Set when the reference is malformed: recorded whatever is stored, never looked up. */
  malformed?: string;
}

/**
 * The ends of one landed edge or link, each against the kind it DECLARES — shape and collection from
 * `brain/entity-refs.ts`, because assuming entity would record a legitimate file endpoint as a violation.
 */
function targetsOf(key: 'edges' | 'links', doc: Arrived): Target[] {
  if (key === 'edges') {
    return (['from', 'to'] as const).map((field) => {
      const id = String(doc[field]);
      const kind = edgeEndpointKind((field === 'from' ? doc['fromKind'] : doc['toKind']) as RefKind | undefined);
      return { docId: doc._id, docType: 'edge', field, kind, id,
        ...(isWellFormedRef(kind, id) ? {} : { malformed: `${field} '${id}' is not a valid ${kind} reference` }) };
    });
  }
  // A link is filed under the record it hangs from. A file is keyed by its path, which is why the shape test is
  // the kind's own: every other kind is a UUID.
  const fromKind = doc['fromKind'] as RefKind;
  const kind = doc['toKind'] as RefKind;
  const id = String(doc['to']);
  const field = `${fromKind}.${kind}`;
  return [{ docId: String(doc['from']), docType: fromKind, field, kind, id,
    ...(isWellFormedRef(kind, id) ? {} : { malformed: `${field} contains non-UUID value '${id}'` }) }];
}

/**
 * A violation's id, derived from what it says, so the same dangling end is one record however often it is checked.
 * Through `util/derived-id.ts`: the target is a peer's text, and parts joined with a separator let a crafted target
 * collide two violations into one record (bundle-30 I13).
 */
function violationId(t: Target): string {
  return derivedV4Id('ythril.link-violation', t.docType, t.docId, t.field, t.id);
}

// The families whose records hold references — the ones this check collects — are declared beside the family rows (`replicated-families.ts`), where
// `TARGET_KEYS` derives from them; re-exported because this check is what reads them and the order gate asks it.
export { REFERENCE_FAMILIES };
const holdsReferences = (key: string): key is typeof REFERENCE_FAMILIES[number] =>
  (REFERENCE_FAMILIES as readonly string[]).includes(key);

export class LinkageCheck {
  private readonly landed: Target[] = [];

  /** `sender` is the peer the door proves, which is what a violation names. */
  constructor(private readonly spaceId: string, private readonly sender: string) {}

  /** Note a record that LANDED. Anything but an edge or a link has no targets and is ignored. */
  add(key: string, doc: Arrived): void {
    if (!holdsReferences(key)) return;
    if (!isStrictLinkage(this.spaceId)) return;
    this.landed.push(...targetsOf(key, doc));
  }

  /**
   * Check what landed, once, and record each dangling end once. `stillToCome` names the collections a target may
   * still arrive in this cycle — a transfer that stopped early, or a family the sender pushes after this request: a
   * target there is not checked. Never throws.
   *
   * **In a write bound of its own** (bundle-30 I13): every read and write it issues ends within the per-operation
   * bound and the scope's deadline (`db/write-bound.ts`), never inheriting a hold's scope and never left unbounded. A
   * check the store stalls is logged as failed rather than waited on for ever.
   */
  async run({ stillToCome = [] }: { stillToCome?: readonly SpacePart[] } = {}): Promise<void> {
    const targets = this.landed.splice(0);
    if (targets.length === 0) return;
    await outsideWriteBound(() => withinWriteBound(async () => {
      try {
        await recordViolations(this.spaceId, this.sender, await missingTargets(this.spaceId, targets, stillToCome));
      } catch (err) {
        log.error(`Could not check the strict-linkage targets of ${targets.length} landed reference(s) in space `
          + `'${peerText(this.spaceId)}': ${peerText(err)}`);
      }
    }));
  }

  /**
   * Start the check WITHOUT waiting for it — for the push door, which answers first (bundle-30 I13). The door's
   * write bound is what promises a stalled push a `503` before the sender's timeout, and awaiting the check after the
   * page, outside that bound, held the answer for as long as the store stalled. The records it checks have landed and
   * the check only records, so nothing the answer says depends on it.
   */
  start(opts: { stillToCome?: readonly SpacePart[] } = {}): void {
    started.start(() => this.run(opts));
  }
}

/** Checks started and not yet finished (`start`). */
const started = new DetachedWork('strict-linkage check');

/** Test seam: resolves once every check already started has finished. Never called by the server. */
export async function whenLinkageChecksSettle(): Promise<void> {
  await started.settled();
}

/**
 * The targets that are not here: a malformed one always, a well-formed one when no record of its kind holds its id.
 * One read per target kind (`readStoredById`, chunked); a target whose family is `stillToCome` is not judged.
 */
async function missingTargets(
  spaceId: string, targets: readonly Target[], stillToCome: readonly SpacePart[],
): Promise<Array<Target & { reason: string }>> {
  const missing: Array<Target & { reason: string }> = [];
  const byKind = new Map<RefKind, Target[]>();
  for (const t of targets) {
    if (t.malformed) { missing.push({ ...t, reason: t.malformed }); continue; }
    const part = collectionForStoredKind(t.kind);
    if (part !== null && stillToCome.includes(part)) continue;
    // Pushed onto the kind's own list: copying it per target was quadratic, ~0.8 s at 20 000 (bundle-30 I13).
    const ofKind = byKind.get(t.kind);
    if (ofKind) ofKind.push(t); else byKind.set(t.kind, [t]);
  }
  for (const [kind, ofKind] of byKind) {
    // Per kind, because the collection is the kind's: only a FILE target can be a flagged row. A deleted file counted
    // as present is an edge or a link resolving onto an audit record, which strict linkage then never reports.
    // A kind no collection holds (a pulled edge whose `fromKind` fails its schema) names nothing that exists: every end of it is missing.
    const part = collectionForStoredKind(kind);
    const present = part === null ? new Map<string, unknown>()
      : await readStoredById(spaceCollection(spaceId, part), ofKind.map(t => t.id), {}, { filter: notFlaggedIfFile(kind) });
    for (const t of ofKind) {
      if (!present.has(t.id)) missing.push({ ...t, reason: `${t.field} references non-existent ${kind} '${t.id}'` });
    }
  }
  return missing;
}

/** What identifies a dangling end by what its record SAYS — the fields a pre-bundle-30 row shares with the derived one. */
const endOf = (v: Pick<LinkViolationDoc, 'docType' | 'docId' | 'field' | 'reason'>): string =>
  JSON.stringify([v.docType, v.docId, v.field, v.reason]);

/**
 * The records of these ends that a RANDOM id names — what an instance upgraded from before bundle-30 holds — by the
 * derived id that now names the end: the ids to remove, and the earliest date any of them was detected.
 *
 * ## What this prevents (Q-336)
 *
 * Before bundle-30 a violation was inserted with a random uuid and nothing dedupes it. Its `docId`, `docType`, `field` and
 * `reason` are the ones this check writes today, but its id is not the derived one, so the first re-landing of an old
 * dangling end after the upgrade filed a SECOND record of it and announced `link_violation.created` for something the
 * operator had been told long ago. No boot migration: the adoption happens when the end is checked again, in the one read
 * this check already makes of the collection.
 *
 * Read by `docId` (the one field every end of a document shares), and matched in memory on the rest. A row whose id IS a
 * derived one of this batch is the record itself, not an old one.
 */
async function oldRecordsOf(spaceId: string, docs: ReadonlyMap<string, LinkViolationDoc>):
  Promise<Map<string, { ids: string[]; detectedAt: string }>> {
  const derivedByEnd = new Map<string, string>();
  for (const doc of docs.values()) derivedByEnd.set(endOf(doc), doc._id);
  const docIds = [...new Set([...docs.values()].map(d => d.docId))];
  const rows = await col<LinkViolationDoc>(spaceCollection(spaceId, 'linkViolations'))
    .find({ docId: { $in: docIds } } as never, { projection: { docId: 1, docType: 1, field: 1, reason: 1, detectedAt: 1 } })
    .toArray();
  const old = new Map<string, { ids: string[]; detectedAt: string }>();
  for (const row of rows) {
    const derived = derivedByEnd.get(endOf(row));
    if (derived === undefined || docs.has(row._id)) continue;
    const seen = old.get(derived);
    if (!seen) old.set(derived, { ids: [row._id], detectedAt: row.detectedAt });
    else { seen.ids.push(row._id); if (row.detectedAt < seen.detectedAt) seen.detectedAt = row.detectedAt; }
  }
  return old;
}

/**
 * Record each dangling end once — by its derived id, `$setOnInsert` — and announce only the ones that are new. An end an
 * old random-id record already names is ADOPTED (`oldRecordsOf`): the derived record takes the earliest old
 * `detectedAt`, the old ones are removed once it is stored, and nothing is announced, because the end is not new.
 */
async function recordViolations(spaceId: string, sender: string, missing: ReadonlyArray<Target & { reason: string }>): Promise<void> {
  if (missing.length === 0) return;
  const detectedAt = new Date().toISOString();
  const docs = new Map<string, LinkViolationDoc>();
  for (const t of missing) {
    const _id = violationId(t);
    docs.set(_id, { _id, spaceId, docId: t.docId, docType: t.docType, field: t.field,
      reason: t.reason, peerInstanceId: sender, detectedAt });
  }
  const old = await oldRecordsOf(spaceId, docs);
  const all = [...docs.values()].map(doc => ({ ...doc, detectedAt: old.get(doc._id)?.detectedAt ?? doc.detectedAt }));
  const violations = col<LinkViolationDoc>(spaceCollection(spaceId, 'linkViolations'));
  const res = await violations.bulkWrite(
    all.map(doc => ({ updateOne: { filter: { _id: doc._id } as never, update: { $setOnInsert: doc } as never, upsert: true } })),
    { ordered: false },
  );
  // After the derived records are stored, so a failure in between leaves both and the next check adopts again.
  const adopted = [...old.values()].flatMap(o => o.ids);
  if (adopted.length > 0) await violations.deleteMany({ _id: { $in: adopted } } as never);
  for (const index of Object.keys(res.upsertedIds ?? {})) {
    const doc = all[Number(index)]!;
    if (old.has(doc._id)) continue;
    emitWebhookEvent({ event: 'link_violation.created', spaceId, entry: doc as unknown as Record<string, unknown> });
  }
}
