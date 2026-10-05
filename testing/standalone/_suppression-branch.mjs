/**
 * The block of `embedStoredRecord` that runs when a record is SUPPRESSED — the one place a stale vector is removed.
 *
 * ## The question it answers
 *
 * "Does the suppression branch itself unset the vector?" A gate that asks it of the whole file, or of a slice from
 * an anchor, is satisfied by ANY `$unset: UNSET_VECTOR` in `embed-record.ts` — and the failure path (the embedder
 * threw, the vector is of text that is gone) writes the very same unset a few lines below. Deleting the suppression
 * branch's own unset then leaves the gate green, because the failure branch still spells it, and a suppressed record
 * keeps the vector the flag exists to remove.
 *
 * So the branch is bounded by STRUCTURE: the `if` whose condition consults `embeddingSuppressedFor`, and the block
 * that follows it. Its end is its own closing brace, not a character count, so the failure branch cannot be inside it.
 *
 * Three gates asked this (`an-inline-embed-honours-suppression`, `exclusion-does-not-hide-from-traversal`,
 * `suppress-embeddings-wiring`), each with a looser window of its own. One question, one module.
 */
import assert from 'node:assert/strict';
import { bodyOf, blockAfter } from './_structural-window.mjs';

/** The single spelling of "remove the vector and its model" (`sync/local-only-fields.ts`). */
export const UNSETS_THE_VECTOR = /\$unset:\s*UNSET_VECTOR\b/;

/**
 * @param src  `embed-record.ts` with its comments stripped
 * @returns the `{ … }` block of the suppression branch of `embedStoredRecord`, braces included
 */
export function suppressionBranchOf(src) {
  const body = bodyOf(src, 'embedStoredRecord', 'the suppression branch');
  const call = body.indexOf('embeddingSuppressedFor(');
  assert.notEqual(call, -1, 'embedStoredRecord no longer consults suppression — re-anchor this gate');
  const ifAt = body.lastIndexOf('if (', call);
  assert.notEqual(ifAt, -1, 'the suppression check is not in an `if` condition — re-anchor this gate');
  const block = blockAfter(body, ifAt, 'the suppression branch');
  // The call must sit in THIS `if`'s condition, not in a statement the `if` merely follows.
  assert.ok(!/;/.test(body.slice(ifAt, call)),
    'the suppression check is not inside the condition of the `if` this gate found — re-anchor it');
  assert.ok(body.indexOf(block, ifAt) > call, 'the block found does not follow the suppression check');
  return block;
}
