/**
 * A restore leaves a space with every index the declaration names - the TTL indexes included - and a unique index that does not
 * stand fails the act retryably with the hold kept (bundle-101, Q-445 design rev 5.1 items 3 and 7).
 *
 * ## The rule this holds, and why
 *
 * A restore drops every collection of the space and builds them again on empty collections (premise R1), so whatever it does not
 * build is missing until something else builds it. At df2e7534 the TTL indexes (`ttl_expireAt`, `ttl_contentExpireAt`,
 * `ttl_deletedAt`) are built only by the TTL sweep's start and by a meta update (R6): a restored space sweeps `_expireAt` by a
 * collection scan until the next boot. And a unique index whose build fails is reported as `edgeIndexes: { failed: [] }` (R3)
 * whatever happened, so a restore can lift its hold over a space without the index that refuses duplicates. The rule:
 *
 * - **every index a space's builders put on it stands after a restore** - derived from a fresh space that ran every per-space
 *   builder (`_space-index-declaration.mjs` `buildReferenceSpace`), and from the declaration;
 * - **one declaration, three spaces that agree**: a fresh `initSpace` plus the background pass, a restored space and
 *   `SPACE_INDEXES` hold the same indexes, compared by name, key, unique, sparse and partialFilterExpression (`lexical_text` may be
 *   absent on a store without text indexes, never different), with floors on the collections and on the declared indexes;
 * - **a unique index that does not stand fails the restore act retryably**: for EVERY unique index a space carries, its build is
 *   refused by the store during the restore, and the act is owed (a retry clock, no abandon owed), the space stays held (a local
 *   write is refused), the failure names the index, and the retry once the store builds it completes the act with the index there.
 *
 * ## Seen red
 *
 * At df2e7534: the first case on the TTL indexes (`ttl_expireAt` on facts, entities, edges, chrono and files, `ttl_contentExpireAt`,
 * `ttl_deletedAt` are on the fresh space and not on the restored one); the second on the declaration (`spaces/space-indexes.ts` is
 * not built); the third on the failure's words (the act is owed, but its error is the store's text and names no index).
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/every-declared-space-index-stands-after-a-restore-db.test.js`
 * (a prior `npm run build` in server/).
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { clearActEntries, resetRunnerForTest, untilRunnerIdle } from './_space-act-harness.mjs';
import { restoreModules, takeBackup, restoreAsActs, restoreEntries, startRestoreActs, settleRestoreActs } from './_restore-act.mjs';
import {
  loadSpaceIndexDeclaration, requireSpaceIndexDeclaration, indexesOfSpace, buildReferenceSpace, specDifference, indexId,
} from './_space-index-declaration.mjs';
import { failIndexBuild, storeIndexRefusal } from './_failing-index-build.mjs';

const skip = await mongoSkipReason();

const SUITE = 'q445restoreix';
const T = { timeout: 300_000 };
/** `reference` runs every builder; `passonly` is `initSpace` plus the background pass; `restored` and `broken` are restored. */
const SPACES = ['reference', 'passonly', 'restored', 'broken'];
/** The one index a store may be unable to build, by the design's own words ("lexical_text optional"). */
const OPTIONAL = 'lexical_text';
const COLLECTION_FLOOR = 10;
const DECLARED_FLOOR = 20;

let door, mods, writers, db;
/** Snapshots taken before any restore: a restore replaces every space of the backup, these included. */
let reference, passOnly;

/** Records in the main collections, so a restore loads something into each. */
async function seed(space) {
  await door.coll(space, 'facts').insertMany([1, 2].map(n => ({ _id: `${space}-f${n}`, spaceId: space, fact: `${space} ${n}`, tags: [], seq: n })));
  await door.coll(space, 'entities').insertOne({ _id: `${space}-n1`, spaceId: space, name: `${space} n`, type: 'thing', tags: [], properties: {}, seq: 3 });
  await door.coll(space, 'edges').insertOne(build.edge(space, `${space}-e1`, 4, { fromKind: 'entity', toKind: 'entity' }));
  await door.setCounter(space, 4);
}

let restoredOnce;
/** One restore of every space from one backup, run to its end; memoised, so two cases read one restore. */
function restoreEverySpace() {
  restoredOnce ??= (async () => {
    const backup = await takeBackup(SUITE, `all-${Date.now()}`);
    await restoreAsActs(mods, { backupId: backup.id });
    for (const r of await settleRestoreActs(mods.runner, mods.loader)) assert.equal(r.ok, true, `a restore act did not complete: ${JSON.stringify(r)}`);
    return indexesOfSpace(db, 'restored');
  })();
  return restoredOnce;
}

/** `indexId -> spec` minus the space's own name, comparable across spaces. */
const differencesAgainst = (expected, actual, { optional = [] } = {}) => {
  const out = [];
  for (const [id, { spec }] of expected) {
    const got = actual.get(id);
    if (!got) { if (!optional.includes(spec.name)) out.push(`${id} missing`); continue; }
    const diff = specDifference(spec, got.spec);
    if (diff.length) out.push(`${id} differs in ${diff.join(', ')}: expected ${JSON.stringify(spec)}, found ${JSON.stringify(got.spec)}`);
  }
  return out;
};

describe('every declared space index stands after a restore, and a unique one that does not fails the act retryably (real MongoDB)', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: SUITE, spaces: SPACES.map(id => ({ id, label: id, folders: [] })) });
    mods = await restoreModules();
    writers = { fact: await import('../../server/dist/brain/fact.js') };
    db = door.mongo.getDb();
    for (const s of SPACES) await seed(s);
    // The pass walks every configured space, so `passonly` is taken first, before the TTL builder runs on `reference` alone.
    const { ensureQueryIndexes } = await import('../../server/dist/spaces/ensure-query-indexes.js');
    await ensureQueryIndexes();
    passOnly = await indexesOfSpace(db, 'passonly');
    reference = await buildReferenceSpace(db, 'reference');
  });
  after(async () => { try { resetRunnerForTest(mods.runner); } catch { /* never loaded */ } await door?.close(); });
  beforeEach(() => { resetRunnerForTest(mods.runner); clearActEntries(mods.loader); });

  it('a restored space carries every index its builders put on a fresh space, the TTL indexes included, and every declared one', T, async () => {
    assert.ok(reference.size >= DECLARED_FLOOR, `the reference space carries ${reference.size} indexes: the builders read as not having run`);
    const restored = await restoreEverySpace();
    const missing = differencesAgainst(reference, restored, { optional: [OPTIONAL] });
    assert.deepEqual(missing, [], `a restore left the space without indexes its builders put on a fresh one: ${missing.join('; ')}`);
    const declared = await requireSpaceIndexDeclaration(assert);
    const notDeclared = differencesAgainst(new Map(declared.map(e => [e.id, e])), restored, { optional: [OPTIONAL] });
    assert.deepEqual(notDeclared, [], `a restore left the space without declared indexes: ${notDeclared.join('; ')}`);
  });

  it('a fresh initSpace plus the background pass, a restored space and the declaration hold the same indexes', T, async () => {
    const restored = await restoreEverySpace();
    const collections = new Set([...passOnly.values()].map(i => i.suffix));
    assert.ok(collections.size >= COLLECTION_FLOOR, `the fresh space has indexes on ${collections.size} collections: the read is broken`);
    const declaration = await loadSpaceIndexDeclaration();
    assert.ok(!declaration.missing, declaration.missing);
    assert.ok(declaration.entries.length >= DECLARED_FLOOR, `SPACE_INDEXES declares ${declaration.entries.length} indexes: too few to be every per-space index`);
    const declared = new Map(declaration.entries.map(e => [e.id, e]));
    assert.equal(declared.size, declaration.entries.length, 'two declared entries build one index name on one collection');
    const findings = [
      ...differencesAgainst(declared, passOnly, { optional: [OPTIONAL] }).map(f => `fresh: ${f}`),
      ...differencesAgainst(declared, restored, { optional: [OPTIONAL] }).map(f => `restored: ${f}`),
      ...[...passOnly.keys()].filter(id => !declared.has(id)).map(id => `fresh carries ${id}, which is not declared`),
      ...[...restored.keys()].filter(id => !declared.has(id)).map(id => `restored carries ${id}, which is not declared`),
    ];
    assert.deepEqual(findings, [], `the three disagree: ${findings.join('; ')}`);
  });

  it('a restore whose unique index build the store refuses fails the act retryably, keeps the hold, names the index, and the retry builds it', T, async () => {
    const declaration = await loadSpaceIndexDeclaration();
    const unique = new Map([...reference].filter(([, i]) => i.spec.unique));
    for (const e of declaration.entries ?? []) if (e.spec.unique) unique.set(e.id, e);
    assert.ok(unique.size >= 3, `only ${unique.size} unique indexes found (the edges' identity and guard, the links' pair): the derivation is broken`);
    const refusal = await storeIndexRefusal(db);
    const fault = failIndexBuild(Object.getPrototypeOf(db.collection('x')));
    const findings = [];
    try {
      for (const [id, { suffix, spec }] of unique) {
        resetRunnerForTest(mods.runner); clearActEntries(mods.loader);
        const coll = `broken_${suffix}`;
        const backup = await takeBackup(SUITE, `unique-${suffix}-${spec.name}-${Date.now()}`);
        fault.fail(coll, spec.name, refusal);
        await restoreAsActs(mods, { backupId: backup.id });
        const results = await Promise.all(startRestoreActs(mods.runner, mods.loader));
        const fired = fault.fired();
        fault.clear();
        const mine = results.find(r => r.localId === 'broken');
        const entry = restoreEntries(mods.loader).find(e => e.localId === 'broken');
        if (fired === 0) { findings.push(`${id}: the restore never built it`); continue; }
        if (mine?.ok !== false) { findings.push(`${id}: the restore completed with its build refused`); continue; }
        if (entry?.state !== 'owed' || !entry.retryAt || entry.needsAbandon) findings.push(`${id}: the failed act is not owed with a retry clock (${JSON.stringify(entry)})`);
        const words = `${mine.error ?? ''} ${mine.cause?.message ?? ''}`;
        if (!words.includes(spec.name)) findings.push(`${id}: the failure does not name the index (${words.trim().slice(0, 200)})`);
        const write = await writers.fact.saveFact('broken', 'while owed', [], [], undefined, undefined, 'note').then(() => 'taken', () => 'refused');
        if (write !== 'refused') findings.push(`${id}: the space took a local write while its restore is owed`);
        const at = Date.parse(entry?.retryAt ?? new Date().toISOString()) + 1000;
        await mods.runner.retryOwedSpaceActs(at);
        await untilRunnerIdle(mods.runner, mods.loader, { now: at });
        if (restoreEntries(mods.loader).some(e => e.localId === 'broken')) findings.push(`${id}: the retry did not complete the restore`);
        const now = (await indexesOfSpace(db, 'broken')).get(indexId(suffix, spec.name));
        if (!now || specDifference(spec, now.spec).length) findings.push(`${id}: after the retry the index is ${now ? `different (${JSON.stringify(now.spec)})` : 'missing'}`);
      }
    } finally {
      fault.restore();
    }
    assert.deepEqual(findings, [], `a restore over a refused unique index: ${findings.join('; ')}`);
  });
});
