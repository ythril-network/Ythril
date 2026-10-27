/**
 * THE keep-writer of Review's resolve (Q-624, design rev 4 §9 step 2): make a fork's PARENT say exactly what the kept side says.
 *
 * ## Why it is its own module, and what it prevents
 *
 * It writes the parent, an ordinary record, never a fork row: so it writes through the one loop of a local edit (`writeAtReadVersion`, which also
 * refuses a fork row), and it is not one of the fork module's own writers of fork rows. Its one caller is `resolveFork` (`brain/forks.ts`), which
 * `a-forking-family-is-read-from-the-planner` holds: a keep that overwrites a record's whole body, `superseded`, `suppressEmbeddings` and `type`
 * included, reachable from more than the resolve would be a fourth way to write what the doors' `SYSTEM_FIELDS` refusal keeps from callers.
 *
 * What a hand-written copy would drop, inside: the `$unset` of a field the kept side lacks (a merge of fields leaves the parent's), the redaction
 * blank (what the comparison blanked is not written), and an edge's identity (never written here, so the parent edge's write guard still names it).
 */
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { admitSpaceWrite } from '../spaces/space-write-gate.js';
import { NEVER_RETURNED_PROJECTION } from './read-projection.js';
import { writeFilterFor } from './write-precondition.js';
import { writeAtReadVersion } from './write-at-read-version.js';
import { BODY_FIELDS_OF } from '../sync/authored-content.js';
import { FUNCTIONAL_GUARD } from '../sync/local-only-fields.js';
import type { BrainCollection } from '../config/types.js';

/** The fields an edge's identity is made of: equal in a fork and its subject by construction, never written by the keep. */
export const EDGE_IDENTITY_FIELDS = Object.freeze(['from', 'to', 'fromKind', 'toKind', 'label'] as const);

/**
 * Write `kept`'s whole body onto `parent` as a local edit stamped above `aboveVersion` (both versions), filtered by the parent's listed version
 * (`ifMatchSeq`). One `$set`/`$unset` over the family's body (`BODY_FIELDS_OF`); `blank` (a redaction's fields) is not written. Returns the parent as
 * stored, or null when it moved since it was listed.
 */
export async function writeKeptBody(
  spaceId: string, family: BrainCollection, parent: Record<string, unknown> & { _id: string }, kept: Record<string, unknown>,
  { aboveVersion, ifMatchSeq, blank }: { aboveVersion: number; ifMatchSeq: number; blank: readonly string[] },
): Promise<Record<string, unknown> | null> {
  const now = new Date().toISOString();
  const $set: Record<string, unknown> = { updatedAt: now };
  const $unset: Record<string, ''> = {};
  for (const f of BODY_FIELDS_OF[family] ?? []) {
    // An edge's identity is never written, so the parent edge's own write guard (`_functionalGuard`, a function of from and label) is carried: it
    // still names the edge, and it is never touched here (it is no body field).
    if (blank.includes(f) || (family === 'edges' && (EDGE_IDENTITY_FIELDS as readonly string[]).includes(f)) || f === FUNCTIONAL_GUARD) continue;
    if (kept[f] !== undefined) $set[f] = kept[f];
    else if (parent[f] !== undefined) $unset[f] = '';
  }
  const coll = col<Record<string, unknown> & { _id: string }>(spaceCollection(spaceId, family));
  return admitSpaceWrite(spaceId, family, () => writeAtReadVersion<Record<string, unknown>>(spaceId, family, parent._id, ifMatchSeq, (at) => {
    const update: Record<string, unknown> = { $set: { ...$set, ...at.patch } };
    if (Object.keys($unset).length > 0) update['$unset'] = $unset;
    return coll.findOneAndUpdate(asFilter<{ _id: string }>(writeFilterFor(parent._id, { readSeq: at.readSeq, ifMatchSeq })), update as never,
      { returnDocument: 'after', projection: NEVER_RETURNED_PROJECTION }) as Promise<Record<string, unknown> | null>;
  }, 'fork.resolve', aboveVersion));
}
