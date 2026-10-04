/**
 * What the edges and links that LANDED in one transfer point at that is not here — checked once the transfer is whole,
 * recorded once per dangling end, for a strict-linkage space.
 *
 * ## What this prevents (bundle-30 I8, pre-ship data-integrity and performance lenses)
 *
 * The check ran fire-and-forget right after each PAGE landed. A pull lands its families one page at a time in
 * `REPLICATED_FAMILIES` order — facts, entities, edges, chrono, links, filemeta — so an edge to a chrono entry, or a
 * link to a file, created in the same interval was checked while its target was still to be pulled, and recorded as a
 * violation. Each record had a fresh uuid that nothing dedupes, so every later re-landing of the edge added another.
 * This is the copy that RECORDS rather than refuses (CLAUDE.md): an operator reads each of those as real damage. And
 * every landed edge cost two unawaited `findOne`s, every link one — about twenty thousand on a 50-page pull.
 *
 * So a door collects what landed (`add`) and checks once (`run`) when its transfer is whole: a pull after every
 * family of the space's transfer, a push after the request's page. The check is one `$in` read per target kind per
 * chunk, awaited, so its cost is bounded by the transfer rather than by the pool. A target in a family whose
 * transfer stopped early (`stillToCome`) is not checked: it may be in what was not served yet, and recording it
 * would be the false violation this exists to prevent.
 *
 * ## Once per dangling end
 *
 * A violation's `_id` is derived from what it says — the document, the field, the target — and written with
 * `$setOnInsert`, so checking the same edge again (an edit lands, a page is re-sent) finds the record already there.
 * The webhook fires only for the one that was new.
 *
 * It only RECORDS, never throws: sync ingest is validated, counted and let in, and a refusal would hold the
 * watermark and stop the channel. A failure to record is logged once per run.
 */
import { createHash } from 'node:crypto';
import { col } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { outsideWriteBound } from '../db/write-bound.js';
import { isWellFormedRef, collectionForRefKind, edgeEndpointKind } from '../brain/entity-refs.js';
import { isStrictLinkage } from '../spaces/proxy.js';
import { emitWebhookEvent } from '../webhooks/dispatcher.js';
import { log, peerText } from '../util/log.js';
import type { RefKind } from '../config/types-knowledge.js';
import type { LinkViolationDoc } from '../config/types.js';
import type { SpacePart } from '../db/space-collection.js';

/** How many target ids one existence read asks for. */
const IDS_PER_READ = 1000;

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

/** A violation's id, derived from what it says, so the same dangling end is one record however often it is checked. */
function violationId(t: Target): string {
  const h = createHash('sha256').update(`${t.docType}\u0000${t.docId}\u0000${t.field}\u0000${t.id}`).digest('hex');
  // Shaped as a v4 UUID, which is what the type and every reader of a violation id expect.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16]!, 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export class LinkageCheck {
  private readonly landed: Target[] = [];

  /** `sender` is the peer the door proves, which is what a violation names. */
  constructor(private readonly spaceId: string, private readonly sender: string) {}

  /** Note a record that LANDED. Anything but an edge or a link has no targets and is ignored. */
  add(key: string, doc: Arrived): void {
    if (key !== 'edges' && key !== 'links') return;
    if (!isStrictLinkage(this.spaceId)) return;
    this.landed.push(...targetsOf(key, doc));
  }

  /**
   * Check what landed, once, and record each dangling end once. `stillToCome` names the collections whose transfer
   * stopped early this cycle: a target there is not checked. Never throws.
   */
  async run({ stillToCome = [] }: { stillToCome?: readonly SpacePart[] } = {}): Promise<void> {
    const targets = this.landed.splice(0);
    if (targets.length === 0) return;
    await outsideWriteBound(async () => {
      try {
        const missing: Array<Target & { reason: string }> = [];
        const byKind = new Map<RefKind, Target[]>();
        for (const t of targets) {
          if (t.malformed) { missing.push({ ...t, reason: t.malformed }); continue; }
          if (stillToCome.includes(collectionForRefKind(t.kind))) continue;
          byKind.set(t.kind, [...(byKind.get(t.kind) ?? []), t]);
        }
        for (const [kind, ofKind] of byKind) {
          const ids = [...new Set(ofKind.map(t => t.id))];
          const present = new Set<string>();
          for (let i = 0; i < ids.length; i += IDS_PER_READ) {
            const found = await col<{ _id: string }>(spaceCollection(this.spaceId, collectionForRefKind(kind)))
              .find({ _id: { $in: ids.slice(i, i + IDS_PER_READ) } } as never, { projection: { _id: 1 } }).toArray();
            for (const d of found) present.add(d._id);
          }
          for (const t of ofKind) {
            if (!present.has(t.id)) missing.push({ ...t, reason: `${t.field} references non-existent ${kind} '${t.id}'` });
          }
        }
        await this.record(missing);
      } catch (err) {
        log.error(`Could not check the strict-linkage targets of ${targets.length} landed reference(s) in space `
          + `'${peerText(this.spaceId)}': ${peerText(err)}`);
      }
    });
  }

  private async record(missing: Array<Target & { reason: string }>): Promise<void> {
    if (missing.length === 0) return;
    const detectedAt = new Date().toISOString();
    const docs = new Map<string, LinkViolationDoc>();
    for (const t of missing) {
      const _id = violationId(t);
      docs.set(_id, { _id, spaceId: this.spaceId, docId: t.docId, docType: t.docType, field: t.field,
        reason: t.reason, peerInstanceId: this.sender, detectedAt });
    }
    const all = [...docs.values()];
    const res = await col<LinkViolationDoc>(spaceCollection(this.spaceId, 'linkViolations')).bulkWrite(
      all.map(doc => ({ updateOne: { filter: { _id: doc._id } as never, update: { $setOnInsert: doc } as never, upsert: true } })),
      { ordered: false },
    );
    for (const index of Object.keys(res.upsertedIds ?? {})) {
      const doc = all[Number(index)]!;
      emitWebhookEvent({ event: 'link_violation.created', spaceId: this.spaceId, entry: doc as unknown as Record<string, unknown> });
    }
  }
}
