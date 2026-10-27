/**
 * Leave a 6.0 database as a 5.6 build can run on it (bundle-81, design rev 8 §3 "Rollback", decisions 10 and 37).
 *
 * ## What it does, in seven steps, each idempotent
 *
 * Steps 5 to 7 (Q-624) run FIRST, because step 5 may refuse and a refused run changes nothing: see {@link rollBackForks} (unresolved entity, edge and chrono
 * forks refused or, with `--discard-unresolved-forks`, discarded with no tombstones; the partial edge identity and `{ from: 1 }` dropped; every
 * `_resolvedElsewhere` mark unset). Then:
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
import { POSITION_FIELDS, TOMBSTONE_LOCAL_FIELDS, WRITTEN_HERE, RESOLVED_ELSEWHERE } from './local-only-fields.js';
import { FORKING_FAMILIES } from './upsert-plan.js';
import { isPartialIdentity, isFromIndex, type ListedIndex } from '../spaces/edge-identity-index.js';
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
 * The tool refused because unresolved versions of a kind 5.6 does not know are stored (Q-624 step 5): nothing was changed. The entry point prints
 * the message and exits non-zero.
 */
export class UnresolvedForksRefusal extends Error {
  override readonly name = 'UnresolvedForksRefusal';
}

/** The families 5.6 does not know forks of: every forking family but facts, which forked in 5.6 already. */
const sixZeroForkFamilies = (): string[] => FORKING_FAMILIES.filter(f => f !== FIVE_SIX_FORKING_FAMILY);
/** The one family whose forks 5.6 knows. */
const FIVE_SIX_FORKING_FAMILY = 'facts';

/**
 * Steps 5 to 7 of leaving 6.0 (Q-624, design rev 4 §14), each idempotent.
 *  5. Count the rows carrying `forkOf` in the families 5.6 does not know forks of. Any, and no `discardUnresolvedForks`: refuse, one line per space with the
 *     counts per kind, changing nothing. With it: delete them with NO tombstones (5.6 peers would not hold them), saying per space how many went.
 *  6. Drop the partial edge identity index and `{ from: 1 }`, so 5.6 builds its full identity index over rows it can index (it would hit E11000 otherwise).
 *  7. `$unset` the `_resolvedElsewhere` marks on every forking collection: 5.6's merkle hashes every field it does not exclude.
 */
async function rollBackForks(db: Db, spaces: readonly string[], discard: boolean, log: (line: string) => void): Promise<void> {
  const counted = new Map<string, Array<[string, number]>>();
  for (const spaceId of spaces) {
    const perKind: Array<[string, number]> = [];
    for (const family of sixZeroForkFamilies()) {
      const n = await db.collection(spaceCollection(spaceId, family as never)).countDocuments({ forkOf: { $exists: true } });
      if (n > 0) perKind.push([family, n]);
    }
    if (perKind.length > 0) counted.set(spaceId, perKind);
  }
  if (counted.size > 0 && !discard) {
    for (const [spaceId, perKind] of counted) log(`${spaceId}: unresolved forks 5.6 cannot read: ${perKind.map(([f, n]) => `${n} ${f}`).join(', ')}`);
    throw new UnresolvedForksRefusal('unresolved entity, edge or chrono forks are stored and 5.6 cannot read them: resolve them in Review, or run with --discard-unresolved-forks. Nothing was changed.');
  }
  for (const [spaceId, perKind] of counted) {
    let gone = 0;
    for (const [family] of perKind) gone += (await db.collection(spaceCollection(spaceId, family as never)).deleteMany({ forkOf: { $exists: true } })).deletedCount ?? 0;
    log(`${spaceId}: ${gone} unresolved forks discarded (${perKind.map(([f, n]) => `${n} ${f}`).join(', ')}), no tombstones written`);
  }
  for (const spaceId of spaces) {
    const edges = db.collection(spaceCollection(spaceId, 'edges'));
    const indexes = await edges.listIndexes().toArray().catch(() => [] as ListedIndex[]) as ListedIndex[];
    for (const ix of indexes) if (isPartialIdentity(ix) || isFromIndex(ix)) await edges.dropIndex(String(ix.name));
    for (const family of FORKING_FAMILIES) {
      await db.collection(spaceCollection(spaceId, family)).updateMany({ [RESOLVED_ELSEWHERE]: { $exists: true } }, { $unset: { [RESOLVED_ELSEWHERE]: '' } });
    }
  }
}

/**
 * Roll the positions back on `db`. `log` is called with each line. Throws on the first failure, leaving what was done done: every step is idempotent, so the tool
 * is run again. Refuses ({@link UnresolvedForksRefusal}) before it changes anything while unresolved forks 5.6 cannot read are stored, unless
 * `discardUnresolvedForks`.
 */
export async function rollBackPositions(db: Db, { log, discardUnresolvedForks = false }: { log: (line: string) => void; discardUnresolvedForks?: boolean }): Promise<RollbackResult> {
  await rollBackForks(db, await spacesOf(db), discardUnresolvedForks, log);
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
