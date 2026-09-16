/**
 * The one answer to "may this entity be deleted, and if not, what is holding it" — for both doors.
 *
 * ## Why this is a module and not two route bodies
 *
 * It was two route bodies. The REST route answered
 * `409 {error: 'Cannot delete: entity has inbound references', backlinks: [{type, _id}]}`; the MCP tool threw
 * `Cannot delete entity '<id>': still referenced by edge <id>, fact <id>`. One rule, a different sentence
 * each, structured rows on one door and prose on the other, and each door carrying its own copy of the
 * face-row exemption. A caller's experience of the same refusal depended on which client they had picked,
 * which is the defect this codebase produces most.
 *
 * ## And every sentence describing it named the wrong direction
 *
 * The fleet integrator, 2026-08-30T2137Z §2: their rows carried only OUTBOUND edges and the delete was refused
 * with *"inbound references"*. They filtered on `to`, found nothing, and kept 409ing.
 *
 * The guard was right — `findEntityReferences` queries `$or: [{from}, {to}]`, and an edge left pointing FROM a
 * deleted entity dangles exactly as much as one pointing at it. What was wrong was the error message, the
 * function's name, its docblock and the integration guide, all saying inbound. A reader who checked our source
 * to resolve the message's ambiguity was told the same wrong thing a second time.
 *
 * So the message states no direction, and each ROW carries the end that matched — which is what the reporter
 * actually needed, because it names the query that clears it.
 */
import { col, asFilter } from '../db/mongo.js';
import type { EdgeDoc } from '../config/types.js';
import { isStrictLinkage } from '../spaces/proxy.js';
import { findEntityReferences, type BacklinkEntry } from './entities.js';
import type { RefKind } from '../config/types-knowledge.js';
import { spaceCollection } from '../db/space-collection.js';

/** What blocks a delete, and the sentence to say about it. `null` from the check means "go ahead". */
export interface EntityDeleteBlock {
  /**
   * The refusal, stating no direction and naming what is holding the entity.
   *
   * One string for both doors: REST puts it in `error`, MCP throws it. A refusal that reads differently
   * depending on the client is how an integrator ends up with two mental models of one rule.
   */
  message: string;
  /**
   * Every reference found, INCLUDING the face labels that do not block — so a caller can warn "this will
   * unlabel N faces" while still being told the delete is refused for a different reason. Filtering them out
   * of the report as well as out of the verdict would lose that.
   */
  backlinks: BacklinkEntry[];
  /** The subset that actually refuses the delete: everything except a face label. */
  blocking: BacklinkEntry[];
}

/** Human phrase for one row — `edge abc at the from end`, `fact def`. */
function describe(b: BacklinkEntry): string {
  return b.end ? `${b.type} ${b._id} (at its ${b.end === 'both' ? 'both ends' : `${b.end} end`})`
    : `${b.type} ${b._id}`;
}

/**
 * Which end of an edge names this entity.
 *
 * A separate read from `findEntityReferences`, and deliberately so: that function is the coverage surface for
 * *"is every kind of reference found"* and has its own gate, so widening what it returns would put a second
 * responsibility inside it. This asks a narrower question about the rows it already found.
 */
async function endsOfEdges(spaceId: string, entityId: string, ids: readonly string[]): Promise<Map<string, 'from' | 'to' | 'both'>> {
  if (ids.length === 0) return new Map();
  const docs = await col<EdgeDoc>(spaceCollection(spaceId, 'edges'))
    .find(asFilter<EdgeDoc>({ _id: { $in: ids } } as never), { projection: { _id: 1, from: 1, to: 1 } })
    .toArray() as Array<{ _id: string; from?: string; to?: string }>;
  const out = new Map<string, 'from' | 'to' | 'both'>();
  for (const d of docs) {
    const isFrom = d.from === entityId;
    const isTo = d.to === entityId;
    // A self-loop is one document with two matching ends. Reporting `from` alone would send the caller
    // looking for an edge whose other end is the same record.
    if (isFrom && isTo) out.set(String(d._id), 'both');
    else if (isFrom) out.set(String(d._id), 'from');
    else if (isTo) out.set(String(d._id), 'to');
  }
  return out;
}

/**
 * What stops this entity being deleted, or `null` when nothing does.
 *
 * Consults `strictLinkage` itself rather than leaving that to each door: a setting checked in two places is a
 * setting one door eventually stops honouring. A space that opted out gets `null` whatever is pointing at the
 * record, which is what the opt-out is bought for.
 */
/**
 * What stops this record being deleted, or `null` if nothing does.
 *
 * **`targetKind` since 4.0**, defaulting to `entity` because that is every existing caller. Until `M-2` gave
 * the three unread link fields a reader, deleting a fact that a chrono entry named was never refused —
 * even under `strictLinkage`, which is the strongest setting on offer — because nothing could see the
 * reference. The chrono entry was then left pointing at a record that does not exist, which is the outcome
 * the setting is bought to prevent.
 *
 * It is a BEHAVIOUR CHANGE a running script can hit, which is why it is in the deprecation notice for the six
 * array fields rather than only in a changelog line about them.
 */
export async function entityDeleteBlockers(spaceId: string, entityId: string, targetKind: RefKind = 'entity'): Promise<EntityDeleteBlock | null> {
  if (!isStrictLinkage(spaceId)) return null;

  const found = await findEntityReferences(spaceId, entityId, targetKind);
  if (found.length === 0) return null;

  const ends = await endsOfEdges(spaceId, entityId,
    found.filter(b => b.type === 'edge').map(b => b._id));
  const backlinks: BacklinkEntry[] = found.map(b => {
    const end = b.type === 'edge' ? ends.get(b._id) : undefined;
    return end ? { ...b, end } : b;
  });

  /*
   * Face labels are reported and never block. `deleteEntity` unlabels them in the same operation, so they
   * cannot dangle — and blocking on them would make "delete this person" the one thing an operator cannot do
   * for the subject whose data is biometric. It was written out twice, once per door; here it is the reason
   * `blocking` and `backlinks` are two fields.
   */
  const blocking = backlinks.filter(b => b.type !== 'face');
  if (blocking.length === 0) return null;

  return {
    message: `Cannot delete: ${targetKind} still has references — ${blocking.map(describe).join(', ')}. `
      + `Delete or relink those first; there is no cascade delete for ${targetKind === 'entity' ? 'an entity' : `a ${targetKind}`}.`,
    backlinks,
    blocking,
  };
}
