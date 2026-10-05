/**
 * The stalled-write case of every holder of a seq hold — what to call, what to lock — and the fixture each case runs
 * against: the table two -db tests walk, `a-write-inside-a-seq-hold-always-ends-db` (the write ends within the bound
 * and the hold is released) and `a-write-the-bound-ended-never-lands-db` (and then nothing it would have written lands).
 *
 * ## Why a module
 *
 * The second test is a rule over every holder the first one derives a case for. A table in the first file's body
 * cannot be imported (a test file runs its tests when it is loaded), so the second would copy it, and the copy that
 * drifts is the holder the rule silently stopped covering. One table, here.
 *
 * ## What it does not do
 *
 * It does not derive the holders — `a-write-inside-a-seq-hold-always-ends-db` does, and fails when a derived holder has
 * no case here. Fixtures are literal on purpose: the derivation decides a case is owed, not this table.
 */
import { build } from './_push-door.mjs';
import { holdDocumentLock } from './_write-faults.mjs';

export const AUTHOR = { instanceId: 'push-door-peer', instanceLabel: 'Peer' };
export const T0 = '2026-09-01T00:00:00.000Z';
export const E1 = 'aaaaaaaa-0000-4000-8000-0000000000e1';
export const E2 = 'aaaaaaaa-0000-4000-8000-0000000000e2';
export const F = 'bbbbbbbb-0000-4000-8000-0000000000f1';
export const ED = 'cccccccc-0000-4000-8000-0000000000ed';
export const C = 'dddddddd-0000-4000-8000-0000000000c1';
export const HELD_FILE = 'held.md';
export const LEGACY_FILE = 'legacy.md';
export const DIVERGENT = 'the same fact, said differently by the peer';

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
    fileMeta: await import('../../server/dist/files/file-meta.js'),
  };
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
  await door.setCounter(space, 6);
}

/**
 * One or more stalled runs per holder: what to call, and what to lock. `lock: 'counter'` locks the space's
 * counter row; a function returns its own lock. Fixtures are literal on purpose — the derivation decides a case
 * is owed, not this table.
 */
/**
 * Every holder's stalled-write cases for `S`, keyed by holder: `{ label, lock, run }` with `lock` either `'counter'` (the
 * space's counter row) or a function returning the lock — and then `collection`, the one it holds. `ctx` is
 * `{ door, mods }`, read when a case RUNS, so the table can be built when the tests are registered, before the door is open.
 */
export function holderCases(ctx, S) {
  return {
    // Re-anchored (bundle-30 §D, Q-204): the push's page accept moved to `sync/accept-page.ts` and serves the pull too;
    // the case still drives it through the push door, which forks the same way.
    'server/src/sync/accept-page.ts:acceptArrivingPage': [{
      label: 'a pushed fact that forks: the fork write, inside its block hold',
      collection: `${S}_facts`,
      lock: async () => holdDocumentLock(ctx.door.mongo, `${S}_facts`,
        { insert: { _id: ctx.mods.plan.forkIdFor(F, 3, DIVERGENT), spaceId: S, fact: 'lock', seq: 0 } }),
      run: () => ctx.door.push('/facts', build.fact(S, F, 3, { fact: DIVERGENT }), { spaceId: S }),
    }],
    'server/src/brain/chrono.ts:updateChrono': [{
      label: 'a chrono update', lock: 'counter',
      run: () => ctx.mods.chrono.updateChrono(S, C, { title: 'changed' }),
    }],
    // Re-keyed (bundle-30, Q-107 part 3a): the re-key's block is in `rekeyEdges`, one implementation for one edge or a batch.
    'server/src/brain/edge-rekey.ts:rekeyEdges': [{
      label: 'an edge re-keyed by a label change (its block, inside the update\'s transaction)', lock: 'counter',
      run: () => ctx.mods.edges.updateEdgeById(S, ED, { label: 'renamed' }),
    }],
    // Re-anchored (bundle-30 §A4): the edge label change's transaction is `inHeldTransaction`'s hold now, so the
    // derivation finds the holder there; driven through the edge label change, its first caller.
    'server/src/brain/held-transaction.ts:inHeldTransaction': [
      { label: 'an edge label change: the transaction under the horizon hold', lock: 'counter',
        run: () => ctx.mods.edges.updateEdgeById(S, ED, { label: 'renamed_again' }) },
      // Its second caller since bundle-30 §B3: one chunk of an entity cascade (delete + tombstones) per transaction.
      { label: 'an entity cascade chunk: the transaction under the horizon hold', lock: 'counter',
        run: async () => ctx.mods.cascade.deleteEntityCascade(S, E1, (await ctx.mods.cascade.previewEntityCascade(S, E1)).token) },
    ],
    'server/src/brain/edges.ts:updateEdgeById': [
      { label: 'an edge updated in place', lock: 'counter',
        run: () => ctx.mods.edges.updateEdgeById(S, ED, { tags: ['changed'] }) },
    ],
    'server/src/brain/entities.ts:updateEntityById': [{
      label: 'an entity update', lock: 'counter',
      run: () => ctx.mods.entities.updateEntityById(S, E1, { description: 'changed' }),
    }],
    'server/src/brain/fact.ts:updateFact': [{
      label: 'a fact update', lock: 'counter',
      run: () => ctx.mods.fact.updateFact(S, F, { fact: 'changed' }),
    }],
    'server/src/brain/links-conversion.ts:stampFileMetaSeqs': [{
      label: 'a legacy file record stamped with a seq', lock: 'counter',
      run: () => ctx.mods.conversion.stampFileMetaSeqs(S),
    }],
    // Re-keyed (bundle-30 §A4/§B2): the merge runs in `inHeldTransaction`, and its seq blocks are taken in the
    // transaction's callback, `relinkAndAbsorb`; driven through `executeMerge`, its one caller.
    'server/src/brain/merge.ts:relinkAndAbsorb': [{
      label: 'a merge: the relink seq blocks, inside its held transaction', lock: 'counter',
      run: async () => ctx.mods.merge.executeMerge(S, await ctx.door.coll(S, 'entities').findOne({ _id: E1 }),
        await ctx.door.coll(S, 'entities').findOne({ _id: E2 }), {}),
    }],
    // Re-keyed (bundle-30): `writeTombstone` is one tombstone through `writeTombstones`, whose block this is.
    'server/src/brain/tombstones.ts:writeTombstones': [{
      label: 'a tombstone write', lock: 'counter',
      run: () => ctx.mods.tombstones.writeTombstone(S, { _id: 'deleted-fact', type: 'fact' }),
    }],
    'server/src/brain/write-plan/commit.ts:writeStage': [{
      label: 'a planned create (save)', lock: 'counter',
      run: () => ctx.mods.fact.saveFact(S, 'a new fact', [], [], undefined, undefined, 'note'),
    }],
    'server/src/brain/write-plan/commit.ts:reconcileLinkRows': [{
      label: 'link rows reconciled', lock: 'counter',
      run: () => ctx.mods.commit.reconcileLinkRows(S, [{ from: F, fromKind: 'fact', desired: { entity: [E1] }, author: AUTHOR, minted: true }]),
    }],
    'server/src/files/file-meta.ts:upsertFileMeta': [{
      label: 'a file record created', lock: 'counter',
      run: () => ctx.mods.fileMeta.upsertFileMeta(S, 'new.md', 10),
    }],
    'server/src/files/file-meta.ts:setDerivedDescriptionIfUnset': [{
      label: 'a derived file description', lock: 'counter',
      run: () => ctx.mods.fileMeta.setDerivedDescriptionIfUnset(S, HELD_FILE, 'derived'),
    }],
    'server/src/files/file-meta.ts:updateFileMeta': [{
      label: 'a file record updated', lock: 'counter',
      run: () => ctx.mods.fileMeta.updateFileMeta(S, HELD_FILE, { description: 'changed' }),
    }],
    'server/src/files/file-meta.ts:markFileMetaDeleted': [{
      label: 'a file record marked deleted', lock: 'counter',
      run: () => ctx.mods.fileMeta.markFileMetaDeleted(S, HELD_FILE),
    }],
  };
}
