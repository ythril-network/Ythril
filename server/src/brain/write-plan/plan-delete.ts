/**
 * A record DELETE as a planned write (`Q-963`, design d): decided against the read set, written by a write group (`commitWriteGroup`) inside
 * its one transaction beside the group's inserts and converges.
 *
 * ## The question it answers
 *
 * *"May this stored record be deleted as part of this batch, and at which version?"* The planner refuses what no transaction could fix: a
 * record that is not stored (`NotFoundError`), an unresolved version (`ForkRowReadOnly`, through `ReadSet.stored`: a fork is resolved, never
 * deleted by id) and a record whose version is at the ceiling sync accepts (`RecordVersionAtCeiling`: its tombstone would be refused by
 * every peer). What depends on the group's own result is judged by the group, inside its transaction: the delete guard (`deleteBlockersOfEach`,
 * strict linkage: nothing may still name the record, no implicit cascade, owner D-91) and whether the record is still at the version planned.
 *
 * ## The part a caller cannot drop
 *
 * The read set is told (`noteDeleted`): a later plan of the same batch sees the record gone, so an edge to a deleted entity fails its end
 * check, and a functional edge swapped in one batch (the old one deleted, the new one inserted) is not counted twice at its subject.
 */
import { NotFoundError, notFoundSentence } from '../../util/errors.js';
import { MAX_INGEST_SEQ } from '../../util/seq.js';
import { RecordVersionAtCeiling } from '../write-precondition.js';
import type { ReadSet } from './read-set.js';
import type { PlanKind, WritePlan } from './types.js';

/**
 * Plan the deletion of the stored `kind` record `id`; the read set must have loaded it (`ReadWant.records`). Notes the delete in `rs`.
 *
 * @throws NotFoundError when it is not stored; `ForkRowReadOnly` for an unresolved version; `RecordVersionAtCeiling` at the version ceiling.
 */
export function planDelete(rs: ReadSet, kind: PlanKind, id: string): WritePlan {
  const stored = rs.stored(kind, id);
  if (!stored) throw new NotFoundError(notFoundSentence('Record', id));
  const seq = typeof stored.seq === 'number' ? stored.seq : null;
  // Its tombstone takes a version above the record's: past the ceiling, every receiver refuses it.
  if (seq !== null && seq >= MAX_INGEST_SEQ) throw new RecordVersionAtCeiling(id);
  rs.noteDeleted(kind, id);
  return {
    kind, spaceId: rs.spaceId, id, op: 'delete', expectSeq: seq, result: stored,
    enqueue: false, minted: false, dupeRules: false,
  };
}
