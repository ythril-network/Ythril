/**
 * The stalled-write case of every holder of a record-position hold — what to call, what to lock — and the fixture each case runs
 * against: the table two -db tests walk, `a-write-inside-a-seq-hold-always-ends-db` (the write ends within the bound
 * and the hold is released) and `a-write-the-bound-ended-never-lands-db` (and then nothing it would have written lands).
 * (The tests keep their names from before bundle-81, when the hold was on the seq; it is on the landing POSITION now, `util/position-clock.ts`.)
 *
 * ## Why a module
 *
 * The second test is a rule over every holder the first one derives a case for. A table in the first file's body
 * cannot be imported (a test file runs its tests when it is loaded), so the second would copy it, and the copy that
 * drifts is the holder the rule silently stopped covering. One table, here.
 *
 * ## Where a case stalls, and why it is a record lock and not the counter
 *
 * A write now takes its VERSION first (`versionsFor`: one `findOneAndUpdate` on the counter, bounded by the write bound and holding
 * nothing) and only then holds its landing position (`withLandingStamp`) around the write itself. So a lock on the counter row stalls
 * the allocation, OUTSIDE any hold; the stall a hold is owed a case for is on a document the write inside it waits for. Every case here
 * locks one: a document the write updates, or an insert of the id it will create (an uncommitted insert makes the same-id write wait). A holder that
 * takes its stamps INSIDE its transaction (a cascade chunk, a merge, a claim-fenced derived write) stalls on the counter row instead (`lock: 'counter'`),
 * which there IS inside the position floor and is what the bound ends with its own timeout: a document lock inside a transaction is a write conflict
 * the driver retries, which `a-bounded-transaction-ends-and-holds-no-horizon-db` holds to the bound without asking how the caller is answered.
 * A stalled allocation is its own case, in `a-write-inside-a-seq-hold-always-ends-db`: it ends within the bound and holds no horizon.
 *
 * ## What it does not do
 *
 * It does not derive the holders — `a-write-inside-a-seq-hold-always-ends-db` does, and fails when a derived holder has
 * no case here. Fixtures are literal on purpose: the derivation decides a case is owed, not this table.
 */
import { build } from './_push-door.mjs';
import { PEER_TOKEN } from './_push-door.mjs';
import { holdForkLock, DIVERGENT } from './_stalled-write-doors.mjs';
import { holdDocumentLock } from './_write-faults.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { seedClaim } from './_media-claim.mjs';
import { forkIdOf } from './_fork-kinds.mjs';

export const AUTHOR = { instanceId: 'push-door-peer', instanceLabel: 'Peer' };
export const T0 = '2026-09-01T00:00:00.000Z';
export const E1 = 'aaaaaaaa-0000-4000-8000-0000000000e1';
export const E2 = 'aaaaaaaa-0000-4000-8000-0000000000e2';
export const F = 'bbbbbbbb-0000-4000-8000-0000000000f1';
export const ED = 'cccccccc-0000-4000-8000-0000000000ed';
export const C = 'dddddddd-0000-4000-8000-0000000000c1';
/** The parent an orphaned fact fork names: never stored, so the fork is an orphan (Q-624 section 9). */
export const GONE_PARENT = 'bbbbbbbb-0000-4000-8000-0000000000f0';
export const HELD_FILE = 'held.md';
export const LEGACY_FILE = 'legacy.md';

/** The server modules a case calls, loaded once. */
export async function loadHolderModules() {
  return {
    plan: await import('../../server/dist/sync/upsert-plan.js'),
    chrono: await import('../../server/dist/brain/chrono.js'),
    edges: await import('../../server/dist/brain/edges.js'),
    entities: await import('../../server/dist/brain/entities.js'),
    fact: await import('../../server/dist/brain/fact.js'),
    conversion: await import('../../server/dist/brain/links-conversion.js'),
    merge: await import('../../server/dist/brain/merge.js'),
    cascade: await import('../../server/dist/brain/entity-delete-cascade.js'),
    tombstones: await import('../../server/dist/brain/tombstones.js'),
    commit: await import('../../server/dist/brain/write-plan/commit.js'),
    linkId: await import('../../server/dist/brain/link-id.js'),
    fileMeta: await import('../../server/dist/files/file-meta.js'),
    files: await import('../../server/dist/files/files.js'),
    moveCascade: await import('../../server/dist/files/move-cascade.js'),
    // The writers of what a file's bytes made, including the one record-position holder among them (bundle-89).
    derivedFields: await import('../../server/dist/files/derived-fields.js'),
    // The file tombstones' module, whose position hold is the second instance of the horizon hold (`util/horizon-holds.ts`).
    fileTombstones: await import('../../server/dist/files/tombstones.js'),
    // The record stream's hold, asked whether one is open (`lowestHeldRecordPosition`).
    clock: await import('../../server/dist/util/position-clock.js'),
    recordStream: await import('../../server/dist/sync/record-position-stream.js'),
    // The repair of a space whose rows a 5.6 build left without a position (bundle-81): its block of fresh positions is a record-position holder.
    owed: await import('../../server/dist/sync/positions-owed.js'),
    // The fork module (Q-624): Review's resolve of an orphan and the re-mint a merge or a re-key runs both land rows under their own hold.
    forks: await import('../../server/dist/brain/forks.js'),
  };
}

/**
 * The lowest record position a write of `space` holds open right now, or undefined when none is: what every position-paged reader of the
 * space is served nothing past (`settledPositionCap`). The question both hold tests ask to tell "the write is inside its hold" from "it is not".
 */
export async function lowestHeldRecordPosition(space) {
  const clock = await import('../../server/dist/util/position-clock.js');
  const { recordPositions } = await import('../../server/dist/sync/record-position-stream.js');
  return clock.lowestOpenPosition(recordPositions, space);
}

/**
 * The value `seedHolderSpace` leaves the space's counter at: the highest seed record's seq. Exported so a case that has to
 * tell "the stalled write has been given its version" from "nothing has been allocated yet" compares against the seed instead of
 * repeating the number.
 */
export const SEEDED_COUNTER = 6;

/**
 * The record position a stalled write holds, once the store has GIVEN it its version: waits until the hold is registered AND the
 * space's counter has moved past `SEEDED_COUNTER`, then answers the lowest held position.
 *
 * ## What it prevents
 *
 * A fixture that treats "a hold exists" as "the write's version is allocated" acts while the allocation may still be in flight — and a
 * second writer's allocation sent in that window (a later `saveFact`, to show a pull passes the stalled write) can be applied first, so
 * the stalled write gets the later version and the premise "the later record is committed above the held one" is false. Found, as a
 * seq hold, by a probe under background Mongo load: 9 of 50 iterations inverted; on a quiet machine the two commands are applied in
 * send order and the case never failed. (A write takes its version BEFORE it holds a position now, so a registered hold already follows
 * its allocation; the second half stays, because the fixture's claim is about the counter, not about the order the code happens to run.)
 *
 * Every case that reads the held position to act on it goes through here, so none can forget the second half.
 *
 * ## What it is for, and what it is not
 *
 * A stall that is NOT on the counter row (a document lock on the record: the fact, the fork), where the allocation completes and the
 * write behind it stalls — so the counter moving is the observable proof that the allocation was answered. A counter-row lock
 * (`holdCounterLock`) stalls the allocation itself: the counter never moves past the seed and no hold is ever registered, so this waits for
 * nothing. Called for one anyway it still ENDS — at its deadline, with a message that says its diagnosis did not answer (`waitFor`
 * bounds every diagnosis itself, round X, W2), never at the runner's. It assumes ONE allocator in flight, as the cases are: a second
 * would make "the counter moved" ambiguous about whose allocation it was.
 *
 * @param {{ counter: (space: string) => Promise<number> }} door  the push door (`openPushDoor`)
 * @returns {Promise<number>} the held position; THROWS (naming what it saw) when the hold or the allocation never appeared
 */
export async function heldPositionTaken(door, space, { ms = 5000 } = {}) {
  await waitFor(async () => (await lowestHeldRecordPosition(space)) !== undefined && (await door.counter(space)) > SEEDED_COUNTER, ms, 5,
    async () => `hold ${await lowestHeldRecordPosition(space)}, counter ${await door.counter(space)} (seeded at ${SEEDED_COUNTER})`,
    { what: `a record position hold on '${space}' whose allocation the store has answered` });
  const held = await lowestHeldRecordPosition(space);
  if (held === undefined) throw new Error(`heldPositionTaken: the hold on '${space}' ended before it could be read — the write was not stalled`);
  return held;
}

/** The space every case of `holderCases(…, space)` runs in, seeded from nothing. */
export async function seedHolderSpace(door, space) {
  await door.wipe(space);
  await door.coll(space, 'entities').insertMany([
    { _id: E1, spaceId: space, name: 'One', type: 'thing', tags: [], properties: {}, author: AUTHOR, createdAt: T0, updatedAt: T0, seq: 1 },
    { _id: E2, spaceId: space, name: 'Two', type: 'thing', tags: [], properties: {}, author: AUTHOR, createdAt: T0, updatedAt: T0, seq: 2 },
  ]);
  await door.coll(space, 'facts').insertOne(build.fact(space, F, 3));
  await door.coll(space, 'edges').insertOne({ _id: ED, spaceId: space, from: E1, to: E2, fromKind: 'entity', toKind: 'entity',
    label: 'knows', tags: [], author: AUTHOR, createdAt: T0, updatedAt: T0, seq: 4 });
  await door.coll(space, 'chrono').insertOne(build.chrono(space, C, 5));
  await door.coll(space, 'files').insertMany([
    { _id: HELD_FILE, spaceId: space, path: HELD_FILE, tags: [], sizeBytes: 1, createdAt: T0, updatedAt: T0, seq: 6 },
    { _id: LEGACY_FILE, spaceId: space, path: LEGACY_FILE, tags: [], sizeBytes: 1, createdAt: T0, updatedAt: T0 },
  ]);
  await door.setCounter(space, SEEDED_COUNTER);
}

/**
 * One or more stalled runs per holder: what to call, and what to lock. `lock: 'counter'` locks the space's
 * counter row; a function returns its own lock. Fixtures are literal on purpose — the derivation decides a case
 * is owed, not this table.
 */
/**
 * One or more stalled runs per holder: `{ label, lock, collection, run }`, with `lock` a function returning the lock a write INSIDE the
 * hold waits on and `collection` the one it holds. `ctx` is `{ door, mods }` (and `fixture`, the door's fixture steps over the harness's own
 * client, when its test has one), read when a case RUNS, so the table can be built when the tests are registered, before the door is open.
 * Fixtures are literal on purpose — the derivation decides a case is owed, not this table.
 */
/** The orphaned fork each space's `resolveOrphan` case seeded, by space: its id is derived when the lock seeds it, and the run resolves that row. */
const orphanOf = new Map();

export function holderCases(ctx, S) {
  const mongo = () => (ctx.fixture ?? ctx.door).mongo;
  /** A lock on a document the write updates. */
  const recordLock = (part, id) => () => holdDocumentLock(mongo(), `${S}_${part}`, { filter: { _id: id } });
  /** A lock on the id a write is about to create: an uncommitted insert of it makes the same-id write wait. */
  const idLock = (part, id, doc = {}) => () => holdDocumentLock(mongo(), `${S}_${part}`, { insert: { _id: id, spaceId: S, ...doc } });
  return {
    // Re-anchored (bundle-81): the one writer of an arriving page is `writeArrivals`; the case still drives it through the push door,
    // which forks the same way.
    'server/src/sync/arrivals.ts:writeArrivals': [{
      label: 'a pushed fact that forks: the fork write, inside its landing hold',
      collection: `${S}_facts`,
      // A fixture step: over `ctx.fixture`'s client when the experiment has one, so an option the server's client carries on purpose
      // does not end the lock.
      lock: async () => holdForkLock(mongo(), ctx.mods.plan, S, F),
      run: () => ctx.door.push('/facts', build.fact(S, F, 3, { fact: DIVERGENT }), { spaceId: S }),
    }],
    // A peer's tombstone this instance keeps (a deletion it holds for a record it never had): its stored row lands under a hold too.
    'server/src/sync/tombstone-apply.ts:applyPeerTombstones': [{
      label: 'a peer\'s tombstone stored: its arrival landing, inside its hold',
      collection: `${S}_tombstones`,
      lock: idLock('tombstones', 'peer-deleted-fact', { type: 'fact', seq: 50 }),
      run: () => ctx.door.push('/tombstones', { tombstones: [build.tombstone(S, 'peer-deleted-fact', 'fact', 50, { instanceId: PEER_TOKEN.peerInstanceId })] }, { spaceId: S }),
    }],
    // Re-keyed (bundle-30, Q-107 part 3a): the re-key's block is in `rekeyEdges`, one implementation for one edge or a batch. Its writes
    // are in the update's held transaction, so the case stalls the delete of the old edge.
    'server/src/brain/edge-rekey.ts:rekeyEdges': [{
      label: 'an edge re-keyed by a label change (its landing, inside the update\'s transaction)', collection: `${S}_edges`,
      lock: recordLock('edges', ED),
      run: () => ctx.mods.edges.updateEdgeById(S, ED, { label: 'renamed' }),
    }],
    // The transaction's own floor hold (`withPositionFloorHeld`): a transaction holds the stream below its first position before it
    // writes anything. Driven through its callers: an edge label change and one chunk of an entity cascade.
    'server/src/brain/held-transaction.ts:inHeldTransaction': [
      { label: 'an edge label change: the transaction under the position floor', collection: `${S}_edges`, lock: recordLock('edges', ED),
        run: () => ctx.mods.edges.updateEdgeById(S, ED, { label: 'renamed_again' }) },
      { label: 'an entity cascade chunk: the transaction under the position floor', lock: 'counter',
        run: async () => ctx.mods.cascade.deleteEntityCascade(S, E1, (await ctx.mods.cascade.previewEntityCascade(S, E1)).token) },
    ],
    'server/src/brain/links-conversion.ts:stampFileMetaSeqs': [{
      label: 'a legacy file record stamped with a version and a position', collection: `${S}_files`, lock: recordLock('files', LEGACY_FILE),
      run: () => ctx.mods.conversion.stampFileMetaSeqs(S),
    }],
    // The merge runs in `inHeldTransaction` and takes its stamps inside it, so the counter row is what stalls it inside the floor.
    'server/src/brain/merge.ts:relinkAndAbsorb': [{
      label: 'a merge: its stamps, inside its held transaction', lock: 'counter',
      run: async () => ctx.mods.merge.executeMerge(S, await ctx.door.coll(S, 'entities').findOne({ _id: E1 }),
        await ctx.door.coll(S, 'entities').findOne({ _id: E2 }), {}),
    }],
    // The edge and link halves of the relink the merge and Review's fork resolve share (`brain/relink-references.ts`, bundle-81): each lands its rows under its own
    // hold, always inside the caller's `inHeldTransaction`, whose bound is what ends a stalled write. They are driven through the merge, the same way and on the same
    // stall as the merge's own case above (the counter row, which the stamp of the survivor waits on inside the floor): a document lock inside a transaction is the
    // bound's own answer (`inHeldTransaction`), which the cases of the edge re-key and the cascade hold, so the shared relink adds no write the bound does not end.
    // The seeded edge is a peer's (the re-key declines it, so it is written in place) and a link row from the fact to the absorbed entity is re-keyed onto the survivor.
    'server/src/brain/relink-references.ts:relinkEdgesOfRecord': [{
      label: 'a merge\'s edge relink, inside the merge\'s held transaction', lock: 'counter',
      run: async () => ctx.mods.merge.executeMerge(S, await ctx.door.coll(S, 'entities').findOne({ _id: E1 }),
        await ctx.door.coll(S, 'entities').findOne({ _id: E2 }), {}),
    }],
    'server/src/brain/relink-references.ts:relinkLinksOfRecord': [{
      label: 'a merge\'s link relink, inside the merge\'s held transaction', lock: 'counter',
      run: async () => {
        await ctx.door.coll(S, 'links').insertOne(build.link(S, 'link-to-the-absorbed', 7, { from: F, fromKind: 'fact', to: E2, toKind: 'entity' }));
        return ctx.mods.merge.executeMerge(S, await ctx.door.coll(S, 'entities').findOne({ _id: E1 }),
          await ctx.door.coll(S, 'entities').findOne({ _id: E2 }), {});
      },
    }],
    // Q-624: the re-mint (`brain/forks.ts`) moves a subject's forks onto its new id inside the CALLER's held transaction, landing the new rows under their own
    // hold. Driven through the merge, the same way and on the same stall as the relink cases above (the counter row, inside the floor): an entity fork of the
    // absorbed record is seeded, so the merge re-mints it onto the survivor. Its rows land inside the transaction, whose bound ends a stalled write.
    'server/src/brain/forks.ts:remintForks': [{
      label: 'a merge\'s fork re-mint, inside the merge\'s held transaction', lock: 'counter',
      run: async () => {
        const fork = { ...(await ctx.door.coll(S, 'entities').findOne({ _id: E2 })), description: 'the absorbed record, as a peer tells it', forkOf: E2, forkAt: 2 };
        fork._id = await forkIdOf('entities', E2, 2, fork);
        await ctx.door.coll(S, 'entities').insertOne(fork);
        return ctx.mods.merge.executeMerge(S, await ctx.door.coll(S, 'entities').findOne({ _id: E1 }),
          await ctx.door.coll(S, 'entities').findOne({ _id: E2 }), {});
      },
    }],
    // Q-624 section 9: Review keeps a fact fork whose parent is gone. The fork is unmarked in place, at a fresh version, under its own landing hold and outside any
    // transaction, so a lock on the fork row stalls the write inside the hold. The lock seeds the orphan first: the row exists only for this case.
    'server/src/brain/forks.ts:resolveOrphan': [{
      label: 'an orphaned fact fork kept: the fork unmarked in place, inside its landing hold',
      collection: `${S}_facts`,
      lock: async () => {
        const fork = { ...build.fact(S, 'orphan', 5, { fact: 'what the gone parent was told' }), forkOf: GONE_PARENT, forkAt: 5 };
        fork._id = await forkIdOf('facts', GONE_PARENT, 5, fork);
        await (ctx.fixture ?? ctx.door).coll(S, 'facts').insertOne(fork);
        orphanOf.set(S, fork._id);
        return holdDocumentLock(mongo(), `${S}_facts`, { filter: { _id: fork._id } });
      },
      run: () => ctx.mods.forks.resolveFork(S, { kind: 'fact', forkId: orphanOf.get(S), keep: 'fork', ifMatchSeq: 5, ifMatchParentSeq: 0 }),
    }],
    // The repair (`sync/positions-owed.ts`): every row with no position takes a fresh clock position, one block per chunk, held until its write ends. The seeded rows carry
    // a version and no position, which is exactly what a 5.6 build leaves; the write of one fact's position stalls.
    'server/src/sync/positions-owed.ts:repairRows': [{
      label: 'the repair of rows 5.6 left without a position: the block of fresh positions, inside its landing hold',
      collection: `${S}_facts`,
      lock: recordLock('facts', F),
      // `repairRows` itself, not `finishPositionsOf`: the latter is a walk, which reports a failure instead of throwing it and quarantines a space after one timeout, so
      // the second repetition of a gate that repeats the stall would skip the space without writing at all.
      run: () => ctx.mods.owed.repairRows(S, 'facts'),
    }],
    // `writeTombstone` is one tombstone through `writeTombstones`, whose landing this is.
    'server/src/brain/tombstones.ts:writeTombstones': [{
      label: 'a tombstone write', collection: `${S}_tombstones`, lock: idLock('tombstones', 'deleted-fact', { type: 'fact' }),
      run: async () => {
        const t = { _id: 'deleted-fact', type: 'fact' };
        await ctx.mods.tombstones.writeTombstone(S, t, await ctx.mods.tombstones.stampTombstones(S, [t]));
      },
    }],
    // Every update of a record in place is `writeAtReadVersion`'s: the read version, the compare-and-set and the landing hold in one place.
    'server/src/brain/write-at-read-version.ts:writeAtReadVersion': [
      { label: 'a fact update', collection: `${S}_facts`, lock: recordLock('facts', F),
        run: () => ctx.mods.fact.updateFact(S, F, { fact: 'changed' }) },
      { label: 'a chrono update', collection: `${S}_chrono`, lock: recordLock('chrono', C),
        run: () => ctx.mods.chrono.updateChrono(S, C, { title: 'changed' }) },
      { label: 'an entity update', collection: `${S}_entities`, lock: recordLock('entities', E1),
        run: () => ctx.mods.entities.updateEntityById(S, E1, { description: 'changed' }) },
      { label: 'an edge updated in place', collection: `${S}_edges`, lock: recordLock('edges', ED),
        run: () => ctx.mods.edges.updateEdgeById(S, ED, { tags: ['changed'] }) },
      { label: 'a file record updated', collection: `${S}_files`, lock: recordLock('files', HELD_FILE),
        run: () => ctx.mods.fileMeta.updateFileMeta(S, HELD_FILE, { description: 'changed' }) },
    ],
    // A planned write is the commit's: an update of an existing record by id, and the rows of a link reconcile.
    'server/src/brain/write-plan/commit.ts:writeStage': [{
      label: 'a planned update (save by id)', collection: `${S}_entities`, lock: recordLock('entities', E1),
      run: () => ctx.mods.entities.upsertEntity(S, 'One', 'thing', [], {}, 'rewritten', E1),
    }],
    'server/src/brain/write-plan/commit.ts:reconcileLinkRows': [{
      label: 'link rows reconciled (a new link row)', collection: `${S}_links`,
      lock: () => idLock('links', ctx.mods.linkId.linkIdFor(F, 'fact', E1, 'entity'))(),
      run: () => ctx.mods.commit.reconcileLinkRows(S, [{ from: F, fromKind: 'fact', desired: { entity: [E1] }, author: AUTHOR, minted: true }]),
    }],
    'server/src/files/file-meta.ts:upsertFileMeta': [{
      label: 'a file record created', collection: `${S}_files`, lock: idLock('files', 'new.md'),
      run: () => ctx.mods.fileMeta.upsertFileMeta(S, 'new.md', 10),
    }],
    // In `files/derived-fields.ts` since bundle-89, with the other writers of what the bytes produced. It takes its version only once its
    // conditions are answered, so the row it is pointed at must be writable — a decline would take no version and the hold this case is about would never be entered.
    'server/src/files/derived-fields.ts:setDerivedDescriptionIfUnset': [{
      label: 'a derived file description: its stamp, inside the held transaction of its claim', lock: 'counter',
      // The write is the run's, so it holds a claim (`_media-claim.mjs`): the claim's job document is part of the transaction.
      run: async () => ctx.mods.derivedFields.setDerivedDescriptionIfUnset(S, await seedClaim(S, HELD_FILE), HELD_FILE, 'derived'),
    }],
    // A file move's rows land in a held transaction, per batch (`carryBatch`): the destination's id is what the batch's insert waits for.
    'server/src/files/move-cascade.ts:carryBatch': [{
      label: 'a file move: its batch of moved rows, inside the move\'s held transaction', collection: `${S}_files`,
      // A move whose rows are not carried when the bound ends is OWED, not failed: its bytes have moved, and its answer is `MoveStillOwed` (the next call or the
      // sweep finishes it, `files/move-cascade.ts`). That is the designed answer, so the landing experiment reads it instead of the bound's plain timeout.
      endedAs: /MoveStillOwed/,
      // A move is several statements that each answer on their own clock before the carry (the rename of the bytes, the pending tombstones, the holds on its jobs).
      // The two variants of the landing experiment put ONE odd clock on every statement (a client `timeoutMS` of 1500 ms; every command a lateness late), which ends
      // the move before it reaches the stall or after it — not the question they ask. The base experiment reads this case.
      baseOnly: true,
      // The carry's insert meets the lock INSIDE a transaction, where a write conflict is answered at once and the whole transaction retried until the bound:
      // the write is alive for a moment per retry, and a 50 ms sample of `currentOp` missed it on every attempt of a CI repetition. The server's own account
      // is the proof instead: the move's hold (`file.move`) ended by the bound, which a carry no lock holds up never reaches.
      stallSaidBy: 'file.move',
      lock: async () => {
        // The bytes and the row first (a move needs both), then the lock on the id the move creates.
        // A move a stalled repetition left owed is remembered in this process by its pair of paths (`MoveStillOwed`), so every repetition moves a pair of its own.
        const n = ctx.moveRun = (ctx.moveRun ?? 0) + 1;
        await ctx.mods.files.writeFile(S, `move-src-${n}.md`, 'bytes to move');
        await ctx.mods.fileMeta.upsertFileMeta(S, `move-src-${n}.md`, 13);
        return holdDocumentLock(mongo(), `${S}_files`, { insert: { _id: `move-dst-${n}.md`, spaceId: S, path: `move-dst-${n}.md` } });
      },
      run: () => ctx.mods.moveCascade.moveFileCascade(S, `move-src-${ctx.moveRun}.md`, `move-dst-${ctx.moveRun}.md`),
    }],
    // The file tombstones' POSITION hold (bundle-71, Q-346): the second instance of the horizon hold. A tombstone has no seq,
    // so the stall is a document lock on the row the write waits for, and the hold is the module's own (`positionHold: true`
    // — `lowestUncommittedPosition` answers whether one is open, where a record hold is asked of `lowestHeldRecordPosition`).
    'server/src/files/tombstones.ts:publishSlice': [{
      label: 'a file tombstone published: its position stamp, inside its hold', positionHold: true, collection: `${S}_file_tombstones`,
      lock: async () => {
        // The act's pending row, written first; the publish's upsert of it is what waits behind the lock.
        const pending = await ctx.mods.fileTombstones.writePendingFileTombstones(S, ['position.md']);
        (ctx.pendings ??= new Map()).set(S, pending);
        return holdDocumentLock((ctx.fixture ?? ctx.door).mongo, `${S}_file_tombstones`, { filter: { _id: pending.docs[0]._id } });
      },
      run: () => ctx.mods.fileTombstones.confirmFileTombstones(ctx.pendings.get(S)),
    }],
    'server/src/files/tombstones.ts:storeRelayedFileTombstones': [{
      label: 'a relayed file tombstone kept to be passed on: its receive-time stamp, inside its hold', positionHold: true, collection: `${S}_file_tombstones`,
      lock: () => holdDocumentLock((ctx.fixture ?? ctx.door).mongo, `${S}_file_tombstones`,
        { insert: { _id: 'relayed-lock', spaceId: S, path: 'relayed.md', deletedAt: T0 } }),
      run: () => ctx.mods.fileTombstones.storeRelayedFileTombstones(S, [{ _id: 'relayed-lock', path: 'relayed.md', deletedAt: T0 }]),
    }],
    'server/src/files/tombstones.ts:positionLegacyFileTombstones': [{
      label: 'a tombstone stored before positions existed, given its position: inside its hold', positionHold: true, collection: `${S}_file_tombstones`,
      lock: async () => {
        await (ctx.fixture ?? ctx.door).coll(S, 'file_tombstones').insertOne({ _id: 'legacy-lock', spaceId: S, path: 'legacy-tomb.md', deletedAt: T0 });
        return holdDocumentLock((ctx.fixture ?? ctx.door).mongo, `${S}_file_tombstones`, { filter: { _id: 'legacy-lock' } });
      },
      run: () => ctx.mods.fileTombstones.positionLegacyFileTombstones(S),
    }],
  };
}
