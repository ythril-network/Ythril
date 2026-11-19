/**
 * The item rows and the callers the unconverted list's database tests share (bundle-285 slice 1, Q-938): an item as the store keeps it, written
 * straight into a space's items, and the rights of a token that may read and write the knowledge area.
 *
 * ## Why a module
 *
 * Three tests of the list by several reasons, its counts per group and the bulk dismiss over a list all plant the same rows, and two older tests
 * had already written the same literal each. A row written per file drifts apart (one forgets `typeDefinition`, which the sweep reads, or
 * `detectedAt`, which the list sorts by), so the row is built here once.
 *
 * ## The guard a copy drops
 *
 * Every row carries ALL the fields the store writes (`UnconvertedItem`), so a list, a count and a sweep read the same row a run would have written.
 */

/** A target fingerprint no real schema has: the rows are planted, not converted toward one. */
export const TO_FP = 'f'.repeat(64);

/**
 * One item as `recordUnconvertedItem` would have stored it. `n` makes the record id and the time, so rows planted in a loop are told apart and the
 * list's order (newest first) is the reverse of `n`.
 */
export function itemRow(n, over = {}) {
  const recordId = over.recordId ?? `rec-${String(n).padStart(5, '0')}`;
  return {
    _id: over._id ?? `item-${recordId}`, kind: 'entity', recordId, type: 'person', seq: 1, fromFp: null, toFp: TO_FP, typeDefinition: 'planted',
    reason: 'not_conforming', violations: [{ field: 'properties.age', reason: 'must be a number' }], proposed: { set: [], unset: [] },
    status: 'open', detectedAt: new Date(Date.UTC(2026, 2, 1) + n * 1000).toISOString(), ...over,
  };
}

/** The items collection of `space` on an open door (`openConvertDoor`). */
export const itemsOf = (door, space) => door.mongo.col(door.spaceCollection(space, 'schemaConvertItems'));

/** Replace the items of `space` with `rows` (none planted by an earlier case stay). */
export async function plant(door, space, rows) {
  await itemsOf(door, space).deleteMany({});
  if (rows.length > 0) await itemsOf(door, space).insertMany(rows);
}

const AREAS = ['knowledge', 'files', 'schema', 'dataQuality', 'networks'];

/** The rights of an instance administrator, as the acts take them. */
export const ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(AREAS.map(a => [a, 'admin'])) };

/** The `{ open, dismissed }` of an answer's counts: what every answer carried before `openBy`, for a test that asks only those. */
export const openAndDismissed = (counts) => ({ open: counts.open, dismissed: counts.dismissed });
