/**
 * Mark a record as no longer true, whatever kind of record it is.
 *
 * ## Why this goes through the writers rather than the collection
 *
 * A `$set` straight onto the document would be four lines shorter and would silently not replicate. The
 * writers are where `seq` is advanced, and `seq` is what sync pages by — so a mark written around them sits
 * on one instance for ever while `brain/merkle.ts` hashes it and reports the space as divergent every cycle.
 * That is a permanent false alarm on the one signal that means data really is missing.
 *
 * They are also where the audit row and the webhook come from. A reviewer's judgement that changes a record
 * and leaves no audit trail is the opposite of what a review queue is for.
 *
 * ## One question, and it is not "update a record"
 *
 * This answers *"retire this record"* and nothing else. It does not take an `updates` bag — a shared
 * dispatcher that grew one would become a fifth writer with a switch in it, and every caller would start
 * depending on every other caller's fields. The kinds that can be retired are the ones that can be
 * contradicted, which is why `file` is absent rather than forgotten: a contradiction is a claim about two
 * records disagreeing, and a file's BYTES are not a claim.
 */
import { updateFact } from './fact.js';
import { updateEntityById } from './entities.js';
import { updateEdgeById } from './edges.js';
import { updateChrono } from './chrono.js';
import { RECORD_SUPERSEDED_FIELD, type RecordFlags } from './record-flag.js';
import { KNOWLEDGE_TYPES, type KnowledgeType, type RecordType } from '../config/types.js';

/**
 * Which writer retires which kind.
 *
 * ## A Map with a derived floor, rather than an object literal
 *
 * An object keyed `{ fact: …, entity: … }` writes the knowledge types out a second time, and
 * `one-definition-of-the-knowledge-types.test.js` refuses that for a reason worth keeping: whichever copy
 * is consulted becomes the authority on what the set IS, and the two then disagree the day a fifth kind
 * arrives. The assertion below inverts that — `KNOWLEDGE_TYPES` decides the set, and this map is checked
 * against it at load. A kind added to the tuple fails the boot here rather than losing its mark quietly.
 *
 * It is deliberately every KNOWLEDGE type and not every RECORD type: `file` is the difference, and a file
 * is excluded because a contradiction is a claim about two records disagreeing, and a file's bytes are not
 * a claim.
 */
type RetireWriter = (
  spaceId: string, id: string, updates: RecordFlags,
  deleteFieldsPaths?: string[], webhook?: { tokenId?: string; tokenLabel?: string },
) => Promise<unknown>;

const WRITERS = new Map<KnowledgeType, RetireWriter>([
  ['entity', updateEntityById],
  ['fact', updateFact],
  ['edge', updateEdgeById],
  ['chrono', updateChrono],
]);

const missing = KNOWLEDGE_TYPES.filter(t => !WRITERS.has(t));
if (missing.length > 0) {
  throw new Error(`retire-record.ts has no writer for: ${missing.join(', ')}. A knowledge type that cannot `
    + 'be marked superseded would resolve a contradiction and change nothing a reader can see.');
}

/** Is this a kind that can carry the mark? Narrows, so a caller cannot reach the map with `file`. */
export function canBeRetired(type: RecordType | string): type is KnowledgeType {
  return WRITERS.has(type as KnowledgeType);
}

/**
 * Write `superseded` onto one record, through its own writer.
 *
 * Returns whether a record was found and written. A caller that treats "not found" as success would report
 * a reviewer's decision as actioned when nothing changed — and the record it meant to mark is the one that
 * keeps coming back from recall looking current.
 */
export async function retireRecord(
  spaceId: string,
  type: KnowledgeType,
  id: string,
  webhook?: { tokenId?: string; tokenLabel?: string },
): Promise<boolean> {
  const write = WRITERS.get(type);
  if (!write) return false;
  const updated = await write(spaceId, id, { [RECORD_SUPERSEDED_FIELD]: true }, undefined, webhook);
  return updated != null;
}
