/**
 * Leave a 6.0 database as a 5.6 build can run on it (bundle-81, design rev 8 §3 "Rollback", decisions 10 and 37).
 *
 * ## What it does, in four steps, each idempotent
 *
 *  1. `$unset` every field 6.0 added, on every collection of every space that carries them (`SEQ_CARRYING`: the record families and the brain tombstones), read from
 *     the classes in `sync/local-only-fields.ts` and never written out here: `POSITION_FIELDS` (`pos`, `posAtSeq`), `writtenHere`, and the members of
 *     `TOMBSTONE_LOCAL_FIELDS` a 5.6 tombstone did not have (`issuedHere`; `storedVia` is a 5.x field and stays). On brain rows this is REQUIRED, not insurance: 5.6's
 *     merkle hashes every non-file field outside its own local-only list, which knows none of them, so every rolled-back space on a `merkle: true` network would log
 *     `MERKLE_DIVERGENCE` every cycle for data that is the same, and 5.6's reads would return the fields.
 *  2. Raise each space's counter to the highest version stored at or below the cap (`highestVersionBelowCapOf`), never lower it: a 5.6 local edit before its first arrival
 *     would otherwise be stamped below what it replaces.
 *  3. Mark every counter document `positionsOwed: 'repair'` and unset `positionsReadyAt`, so a re-upgrade repairs every space whether or not 5.6 wrote to it.
 *     `seqSeenBy6` is not touched: it is not the tool's to move.
 *  4. Say one line per space (`<space>: <n> rows cleared, counter <old> -> <new>`) and a total. The database address is never printed.
 *
 * ## Why it takes a `Db` and a `log`
 *
 * It runs with NO instance up (`node server/dist/tools/positions-rollback.js`, `tools/positions-rollback.ts`), against whatever 5.6 left, so it cannot use the
 * server's connection or its config loader (which runs the boot migrations and writes `config.json`). The spaces are found from the database itself: every space with a
 * counter document or a record collection.
 *
 * It is not an API capability: it runs against the store, not through a door, so the five-places rule does not apply. It is documented in `02b-upgrading.md`.
 */
import type { Db } from 'mongodb';
import { SEQ_CARRYING, highestVersionBelowCapOf } from '../util/seq.js';
import { SPACE_COLLECTIONS, parseSpaceCollection, spaceCollection } from '../db/space-collection.js';
import { POSITION_FIELDS, TOMBSTONE_LOCAL_FIELDS, WRITTEN_HERE } from './local-only-fields.js';
import { COUNTERS } from './positions-ready.js';

/** What the tool did to one space. */
export interface RolledBackSpace {
  readonly spaceId: string;
  readonly rowsCleared: number;
  readonly counterBefore: number | null;
  readonly counterAfter: number | null;
}

export interface RollbackResult {
  readonly spaces: readonly RolledBackSpace[];
  readonly rowsCleared: number;
}

/** A field a 5.x tombstone already carried: it is not 6.0's to remove. */
const FIVE_X_TOMBSTONE_FIELD = 'storedVia';

/** Every field 6.0 added to a stored row, derived from the classes that name them. */
const sixZeroFields = (): string[] => [...new Set([...POSITION_FIELDS, WRITTEN_HERE, ...[...TOMBSTONE_LOCAL_FIELDS].filter(f => f !== FIVE_X_TOMBSTONE_FIELD)])];

/** The spaces this database holds: those with a counter document and those with a record collection. */
async function spacesOf(db: Db): Promise<string[]> {
  const ids = new Set<string>();
  for (const d of await db.collection<{ _id: string }>(COUNTERS).find({}, { projection: { _id: 1 } }).toArray()) ids.add(d._id);
  const carrying = new Set(SEQ_CARRYING.map(part => SPACE_COLLECTIONS[part]));
  for (const c of await db.listCollections({}, { nameOnly: true }).toArray()) {
    const parsed = parseSpaceCollection(c.name);
    if (parsed && carrying.has(parsed.suffix as never)) ids.add(parsed.spaceId);
  }
  return [...ids].sort();
}

/**
 * Roll the positions back on `db`. `log` is called with each line. Throws on the first failure, leaving what was done done: every step is idempotent, so the tool
 * is run again.
 */
export async function rollBackPositions(db: Db, { log }: { log: (line: string) => void }): Promise<RollbackResult> {
  const fields = sixZeroFields();
  const hasAny = { $or: fields.map(f => ({ [f]: { $exists: true } })) };
  const unset = Object.fromEntries(fields.map(f => [f, ''] as const));
  const counters = db.collection<{ _id: string; seq?: number }>(COUNTERS);
  const done: RolledBackSpace[] = [];

  for (const spaceId of await spacesOf(db)) {
    let rowsCleared = 0;
    for (const part of SEQ_CARRYING) {
      const r = await db.collection(spaceCollection(spaceId, part)).updateMany(hasAny, { $unset: unset });
      rowsCleared += r.modifiedCount;
    }
    const highest = await highestVersionBelowCapOf(SEQ_CARRYING.map(part => db.collection(spaceCollection(spaceId, part))));
    const doc = await counters.findOne({ _id: spaceId });
    let counterBefore: number | null = null;
    let counterAfter: number | null = null;
    if (doc || highest > 0) {
      counterBefore = doc?.seq ?? 0;
      counterAfter = Math.max(counterBefore, highest);
      await counters.updateOne({ _id: spaceId }, { $set: { seq: counterAfter, positionsOwed: 'repair' }, $unset: { positionsReadyAt: '' } }, { upsert: true });
    }
    done.push({ spaceId, rowsCleared, counterBefore, counterAfter });
    log(`${spaceId}: ${rowsCleared} rows cleared, counter ${counterBefore ?? 'none'} -> ${counterAfter ?? 'none'}`);
  }

  const rowsCleared = done.reduce((n, s) => n + s.rowsCleared, 0);
  log(`total: ${rowsCleared} rows cleared in ${done.length} space(s); every space owes a repair at the next 6.0 start`);
  return { spaces: done, rowsCleared };
}
