/**
 * A type map whose stored schema text sits a chosen number of bytes under the schema size bound, built by measuring.
 *
 * ## The question it answers
 *
 * *"What types give a schema of exactly `bound - slack` bytes?"* A spec of the room check needs a stored schema at the bound, so that a write
 * of a few bytes' growth is the write that crosses it. The text is the server's own (`schemaTextOf`, what a snapshot row stores), measured, never
 * estimated from the types: the canonical text's overhead per type is the server's to change.
 *
 * ## The guard a hand-written copy drops
 *
 * The last padding type's description is resized once from what its first build measured, and the result is measured again and asserted equal to the
 * target: a text off by a few bytes would turn "crosses the bound by growth" into "already over it" and the row would pass for the wrong reason.
 */
import assert from 'node:assert/strict';

/** The most characters a type's description may hold. */
const DESCRIPTION_MAX = 4000;

/**
 * @param {(meta: object) => string} schemaTextOf  the server's schemaTextOf (loaded by the caller after its instance booted)
 * @param {number} target  the stored text's size in UTF-8 bytes
 * @param {string} [kind]  the knowledge type the types go in
 * @returns {Record<string, Record<string, object>>}  `typeSchemas` whose text is exactly `target` bytes
 */
export function typesOfSize(schemaTextOf, target, kind = 'entity') {
  const bytesOf = (types) => Buffer.byteLength(schemaTextOf({ typeSchemas: { [kind]: types } }), 'utf8');
  const bigType = () => ({ description: 'd'.repeat(DESCRIPTION_MAX) });
  // The first type of a map costs a comma less than each later one: the per-type cost is read from the second.
  const first = bytesOf({ big00000: bigType() });
  const per = bytesOf({ big00000: bigType(), big00001: bigType() }) - first;
  // Whole big types leave a remainder of two to three of them: four padding types share it, the last resized by what was measured.
  const count = Math.floor((target - first) / per) - 1;
  assert.ok(count >= 1, 'the target is too small for this builder');
  const bigs = Object.fromEntries(Array.from({ length: count }, (_, i) => [`big${String(i).padStart(5, '0')}`, bigType()]));
  const remainder = target - bytesOf(bigs);
  const PADS = 4;
  const shared = Math.floor((remainder - PADS * (per - DESCRIPTION_MAX)) / PADS) - 1;
  const padded = (last) => ({ ...bigs, ...Object.fromEntries(Array.from({ length: PADS }, (_, i) => [`pad${i}`, { description: 'p'.repeat(i === PADS - 1 ? last : shared) }])) });
  const length = 1 + (target - bytesOf(padded(1)));
  assert.ok(length >= 1 && length <= DESCRIPTION_MAX, `the last padding type would need ${length} characters: the filler is mis-sized`);
  const types = padded(length);
  assert.equal(bytesOf(types), target, 'the measured schema text is not the target size');
  return { [kind]: types };
}
