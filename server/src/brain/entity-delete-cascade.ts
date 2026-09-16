/**
 * Deleting an entity AND the relationships that block it — behind a preview and a token.
 *
 * ## The ruling, and why the shape is the ruling
 *
 * Owner, 2026-09-02 (`P-29`): *"a preview that returns what WOULD go, then a delete that quotes back a token
 * from the preview."* The recommendation had been to add nothing and improve the refusal; the owner took the
 * version of the cascade that recommendation described as the only one worth having.
 *
 * **A flag was refused, and the reason is not caution.** The guard's whole value is the pause. An entity is a
 * hub: the records a cascade would remove are not visible in the call, there is no undo, and a flag saying
 * *"I looked"* cannot be checked. A token quoted back from a preview CAN be.
 *
 * The reporter this came from spent four probes — `?cascade=true`, `?force=true`, `?deleteEdges=true`,
 * `?withEdges=true` — before implementing clear-then-delete by hand, because the `409` listed the blocking
 * ids and never said a cascade existed. So the third part of this is that the refusal names both routes.
 *
 * ## What the token is, and the three things it deliberately is not
 *
 * A SHA-256 over the space, the entity, and the SORTED blocking set. Nothing else.
 *
 * **Not stored.** Nothing to leak, nothing to sweep, nothing to lose on a restart — and a sweep that lapses
 * turns a refusal into an acceptance, silently.
 *
 * **Not keyed.** The token proves the caller saw THIS set. Anyone who can compute it already knows the set,
 * and knowing the set is the thing being proved — the `409` prints the ids too, deliberately. A secret would
 * buy the appearance of unforgeability and nothing else.
 *
 * **Not expiring.** *"An expiry alone is not enough"* — and it is also not necessary. A token that still
 * matches means the set has not moved, which is exactly when the operator's decision is still good; an expiry
 * would refuse a correct decision and accept a stale one whenever the clock happened to agree.
 *
 * ## What it does NOT delete
 *
 * **The entity at the other end of each edge.** A cascade takes the relationships, not the records they join.
 *
 * **A face label.** `entityDeleteBlockers` reports face records and does not block on them, because a face
 * label is an annotation the system inferred and blocking would make *"delete this person"* the one thing an
 * operator cannot do for the subject whose data is biometric. So they are not in the cascade set either —
 * `deleteEntity` unlabels them, which is what it has always done.
 */
import { createHash } from 'node:crypto';
import { col, asFilter } from '../db/mongo.js';
import { entityDeleteBlockers } from './entity-delete-guard.js';
import { deleteEntity } from './entities.js';
import { deleteEdge } from './edges.js';
import type { BacklinkEntry } from './entities.js';
import type { WebhookActor } from '../webhooks/dispatcher.js';
import type { EdgeDoc } from '../config/types.js';

/** What a preview answers: the set, and the token that authorises removing exactly it. */
export interface CascadePreview {
  entityId: string;
  /** Every record the cascade would remove. Face labels are absent — see the module header. */
  removes: BacklinkEntry[];
  token: string;
}

/**
 * The token for one entity and one set — derived, so the preview and the verifier cannot disagree.
 *
 * Sorted before hashing, because the blocking set comes back in whatever order the scans ran and two
 * orderings of one set must not be two tokens. That is the difference between a check and a coin flip.
 */
export function cascadeTokenFor(spaceId: string, entityId: string, removes: readonly BacklinkEntry[]): string {
  const set = removes.map(r => `${r.type}:${r._id}`).sort().join(',');
  return createHash('sha256').update(`cascade:${spaceId}:${entityId}:${set}`, 'utf8').digest('hex').slice(0, 32);
}

/**
 * What deleting this entity would remove, and the token that authorises removing it.
 *
 * The set is `entityDeleteBlockers`' — the SAME one the `409` computes. A preview that differed from the
 * refusal would be worse than none: the operator would approve a list the delete does not use, which is the
 * failure the two steps exist to prevent, arriving through the step meant to prevent it.
 *
 * An entity with nothing pointing at it previews an EMPTY set and still gets a token. Letting an empty set
 * through without one is the tempting shortcut, and it would make the delete behave differently depending on
 * a race: the operator calls it, an edge lands, and the same call now takes a record they never saw.
 */
export async function previewEntityCascade(spaceId: string, entityId: string): Promise<CascadePreview> {
  const block = await entityDeleteBlockers(spaceId, entityId);
  const removes = block?.blocking ?? [];
  return { entityId, removes, token: cascadeTokenFor(spaceId, entityId, removes) };
}

/** Either the cascade ran, or it was refused and the caller is told which list moved. */
export type CascadeResult =
  | { ok: true; removed: BacklinkEntry[] }
  | { ok: false; error: string; preview: CascadePreview };

/**
 * Delete the entity and everything blocking it, if `token` matches the set as it stands NOW.
 *
 * The set is recomputed rather than taken from the caller — a caller-supplied list is a caller-supplied
 * decision about what to delete, and the token would then authorise a list somebody wrote rather than a list
 * somebody read.
 *
 * On a refusal the CURRENT preview comes back with it, so the caller's next step is one call rather than two:
 * a refusal that says only *"stale"* sends them back to the preview route to find out what changed.
 */
export async function deleteEntityCascade(
  spaceId: string,
  entityId: string,
  token: unknown,
  actor?: WebhookActor,
): Promise<CascadeResult> {
  const preview = await previewEntityCascade(spaceId, entityId);
  if (typeof token !== 'string' || token !== preview.token) {
    return {
      ok: false,
      preview,
      error: 'cascadeToken does not match what would be removed. Either it is missing, it names a different '
        + 'entity, or the list changed since the preview — call the preview again and quote the token it '
        + 'returns. The token binds to the SET, so a record added since you looked cannot be deleted by a '
        + 'decision taken before it existed.',
    };
  }

  /*
   * The EDGES first, then the entity — and each edge through `deleteEdge`, not a bulk delete.
   *
   * `deleteEdge` writes the tombstone. Without one, the next pull from any peer that still holds the edge
   * brings it back, pointing at an entity that no longer exists: the dangling reference `strictLinkage`
   * refused the delete for in the first place, restored by the sync that was supposed to spread the fix.
   */
  const removed: BacklinkEntry[] = [];
  for (const b of preview.removes) {
    if (b.type !== 'edge') continue;
    if (await deleteEdge(spaceId, b._id, actor)) removed.push(b);
  }

  /*
   * Anything blocking that is NOT an edge is left, and the delete below then refuses again.
   *
   * That is deliberate rather than unfinished. `M-2` made a fact, a chrono entry or a file able to block a
   * delete through its link arrays, and removing one of those is deleting somebody's RECORD — not the
   * relationship between two records, which is all an edge is. The owner's ruling is about edges: *"either
   * remove edges by hand or use A when you are sure."*
   */
  const stillBlocking = preview.removes.filter(b => b.type !== 'edge');
  if (stillBlocking.length > 0) {
    return {
      ok: false,
      preview: await previewEntityCascade(spaceId, entityId),
      error: `Cannot delete: ${stillBlocking.map(b => `${b.type} ${b._id}`).join(', ')} still reference this `
        + 'entity, and a cascade removes EDGES only — a fact, chrono entry or file that names it is a '
        + 'record of its own, not a relationship. Edit those to drop the reference first.',
    };
  }

  await deleteEntity(spaceId, entityId, actor);
  return { ok: true, removed };
}

/** The ids of the edges a cascade would remove — for a caller that wants the set without the token. */
export async function cascadeEdgeIds(spaceId: string, entityId: string): Promise<string[]> {
  const rows = await col<EdgeDoc>(`${spaceId}_edges`)
    .find(asFilter<EdgeDoc>({ spaceId, $or: [{ from: entityId }, { to: entityId }] }), { projection: { _id: 1 } })
    .toArray() as Array<{ _id: string }>;
  return rows.map(r => r._id);
}
