/**
 * Every seq-keyset read — the record pages, the push, the tombstone route and the push of tombstones — is answered from a compound
 * `(seq, _id)` index with NO sort stage in the plan it runs, on a new space and on one that already exists, and the upgrade creates and drops
 * indexes in an order that cannot leave a read without one (bundle-52, `Q-277`).
 *
 * ## Why the index is the fix's other half
 *
 * Reading a run of equal seqs in a stable order means sorting `{ seq: 1, _id: 1 }`. The indexes today are `{ seq: 1 }` (and
 * `{ type: 1, seq: 1 }` on tombstones; the files collection has none at all), which cannot deliver that order: every page would
 * read the matching range and sort it in memory. So each reader is two index-bounded finds against a compound, and this file
 * holds that the compound is there, that the planner uses it with no sort, and how it gets there:
 *
 *  1. **A NEW space** (`initSpace`, whose collections do not exist yet) is created with the compound and not with `{ seq: 1 }`.
 *  2. **`initSpace` on an EXISTING collection creates neither.** It runs for every space at every boot, BEFORE the server listens
 *     (`index.ts`), so a build of a compound over a large collection there is a boot that does not finish; and it must not put
 *     `{ seq: 1 }` back after the background pass dropped it.
 *  3. **`ensureQueryIndexes`** (the background pass) builds the compound on an existing space and drops `{ seq: 1 }` /
 *     `{ type: 1, seq: 1 }` only AFTER the compound's build has resolved; a build that fails drops nothing.
 *  4. **A simulated boot, twice, around the drop** does not recreate `{ seq: 1 }`.
 *  5. **explain()** on every keyset reader, shaped as production issues it (files with `parentFileId: { $exists: false }`, the push
 *     with `author.instanceId`, the tombstone route typed and typeless): the winning plan scans the compound and has no SORT stage, and
 *     no REJECTED plan that sorts reads anything but the `_id` index (the planner always enumerates and sorts an `_id` range scan for the
 *     tie find and loses to the compound; probed on the harness Mongo).
 *
 * ## What is derived
 *
 * The readers are the replicated families (`REPLICATED_FAMILIES`) and the two tombstone shapes; `SEQ_KEYSET_INDEXES`
 * (`util/seq-keyset.js`) must declare an index for each (floor 8). The reads are built by `seqKeysetFilters` when the module
 * exists, so a change of its shapes is what is measured, and by the shapes the design names until then.
 *
 * ## The shape this file expects `SEQ_KEYSET_INDEXES` entries to have (a proposal, since the pure tests pin only the keys)
 *
 *     { part: <space collection suffix>, keys: { seq: 1, _id: 1 } }   // part: 'facts' | ... | 'tombstones'
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-keyset-read-uses-its-index-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { loadDistModule } from './_load-dist-module.mjs';
import { replicatedFixtureFamilies } from './_seq-tie-families.mjs';

const skip = await mongoSkipReason();
const S = 'keysetidx';
const SEEDED = 300;
const families = await replicatedFixtureFamilies();

const COMPOUND = { seq: 1, _id: 1 };
const TYPED_COMPOUND = { type: 1, seq: 1, _id: 1 };
const BARE = { seq: 1 };
const TYPED_BARE = { type: 1, seq: 1 };
const keyName = (keys) => Object.keys(keys).join(',');

/**
 * The readers, as production issues them: the part, the filter beside the range, and the index the read must scan.
 * `pull` is the page route's (a family's own filter only); `push` adds what a non-directional network's sender adds.
 */
const READERS = [
  ...families.flatMap(f => [
    { name: `${f.payloadKey} page`, part: f.collection, extra: f.pushFilter ?? {}, want: COMPOUND },
    { name: `${f.payloadKey} push`, part: f.collection, extra: { 'author.instanceId': 'sender', ...(f.pushFilter ?? {}) }, want: COMPOUND },
  ]),
  { name: 'tombstones typeless', part: 'tombstones', extra: {}, want: COMPOUND },
  { name: 'tombstones typed', part: 'tombstones', extra: { type: 'fact' }, want: TYPED_COMPOUND },
];
/** Each part that has a reader, with the compounds it must carry and the bare indexes it must not. */
const PARTS = [...new Set(READERS.map(r => r.part))].map(part => ({
  part,
  compounds: part === 'tombstones' ? [COMPOUND, TYPED_COMPOUND] : [COMPOUND],
  bares: part === 'tombstones' ? [BARE, TYPED_BARE] : [BARE],
}));

let door, mongo, keyset, initSpace, ensureQueryIndexes, newSpaceKeys;

const coll = (part) => mongo.col(`${S}_${part}`);
const keysOf = async (part) => (await coll(part).listIndexes().toArray()).map(ix => keyName(ix.key)).filter(k => k !== '_id');
const has = (keys, index) => keys.includes(keyName(index));

/** Every stage name under a plan node, flattened. */
function stagesOf(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (typeof node.stage === 'string') out.push(node.stage);
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach(n => stagesOf(n, out)); else if (v && typeof v === 'object') stagesOf(v, out);
  }
  return out;
}
/** The key patterns of every IXSCAN under a plan node. */
function indexScans(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.stage === 'IXSCAN' && node.keyPattern) out.push(keyName(node.keyPattern));
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach(n => indexScans(n, out)); else if (v && typeof v === 'object') indexScans(v, out);
  }
  return out;
}

/** The two finds of one keyset read, by the module when it exists and by the design's shapes until it does. */
function keysetFinds(after, horizon, extra) {
  const m = keyset.mod;
  if (m && typeof m.seqKeysetFilters === 'function') {
    const { tie, range } = m.seqKeysetFilters(after, horizon, extra);
    return [tie, range].filter(Boolean);
  }
  return [
    { $and: [{ seq: after.seq, _id: { $gt: after.id } }, extra] },
    { $and: [{ seq: { $gt: after.seq, $lt: horizon } }, extra] },
  ];
}
const SORT = { seq: 1, _id: 1 };

/** A space as an upgraded 5.x one has it: the bare indexes and not the compounds. */
async function asUpgradedSpace() {
  for (const { part, bares } of PARTS) {
    await coll(part).dropIndexes();
    for (const b of bares) await coll(part).createIndex(b);
  }
}
const problems = async (check) => {
  const out = [];
  for (const p of PARTS) out.push(...(await check(p, await keysOf(p.part))));
  return out;
};

describe('every seq-keyset read is answered from its index', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'keysetidx', spaces: [{ id: S, label: S, folders: [], meta: { suppressEmbeddings: true } }] });
    mongo = door.mongo;
    keyset = await loadDistModule('../../server/dist/util/seq-keyset.js', import.meta.url);
    ({ initSpace } = await import('../../server/dist/spaces/lifecycle.js'));
    ({ ensureQueryIndexes } = await import('../../server/dist/spaces/ensure-query-indexes.js'));
    // What `initSpace` made of collections that did not exist yet: read before any case touches them.
    newSpaceKeys = Object.fromEntries(await Promise.all(PARTS.map(async ({ part }) => [part, await keysOf(part)])));
    for (const { part } of PARTS) {
      await coll(part).insertMany(Array.from({ length: SEEDED }, (_, i) => ({
        _id: `d-${String(i + 1).padStart(4, '0')}`, spaceId: S, seq: Math.ceil((i + 1) / 3),
        // `from`/`to`/`label` distinct per row: the edge and link collections carry a unique index on their identity.
        from: `from-${i}`, to: `to-${i}`, label: 'rel', fromKind: 'fact', toKind: 'entity',
        type: i % 2 === 0 ? 'fact' : 'entity', author: { instanceId: i % 3 === 0 ? 'sender' : 'other' },
        ...(part === 'files' && i % 10 === 0 ? { parentFileId: 'd-0001' } : {}),
      })));
    }
  });
  after(async () => { await door?.close(); });

  it('derives the readers and the parts, so an empty set cannot pass', () => {
    assert.ok(READERS.length >= 14, `only ${READERS.length} readers: ${READERS.map(r => r.name).join(', ')}`);
    assert.ok(PARTS.length >= 7, `only ${PARTS.length} parts`);
  });

  it('SEQ_KEYSET_INDEXES exists and declares an index for every reader (floor 8)', () => {
    assert.ok(keyset.mod, 'server/src/util/seq-keyset.ts does not exist, and this rule is about its SEQ_KEYSET_INDEXES');
    const declared = keyset.mod.SEQ_KEYSET_INDEXES;
    assert.ok(Array.isArray(declared) || (declared && typeof declared[Symbol.iterator] === 'function'), 'SEQ_KEYSET_INDEXES is not a list');
    const entries = [...declared].map(e => ({ part: e.part ?? e.collection ?? e.coll, keys: e.keys ?? e.key }));
    assert.ok(entries.length >= 8, `SEQ_KEYSET_INDEXES declares ${entries.length} index(es); the readers need 8 (six families and two tombstone shapes)`);
    for (const e of entries) assert.ok(e.part && e.keys, `an entry has no { part, keys }: ${JSON.stringify(e)}`);
    const missing = PARTS.flatMap(p => p.compounds.filter(c => !entries.some(e => e.part === p.part && keyName(e.keys) === keyName(c)))
      .map(c => `${p.part}(${keyName(c)})`));
    assert.deepEqual(missing, [], 'a reader has no declared index');
    const bare = entries.filter(e => keyName(e.keys) === 'seq' || keyName(e.keys) === 'type,seq').map(e => `${e.part}(${keyName(e.keys)})`);
    assert.deepEqual(bare, [], 'the declaration still names a bare seq index the compound replaces');
  });

  describe('a NEW space', () => {
    it('is created with each compound and with no bare seq index', async () => {
      const wrong = PARTS.flatMap(({ part, compounds, bares }) => [
        ...compounds.filter(c => !has(newSpaceKeys[part], c)).map(c => `${part} lacks (${keyName(c)})`),
        ...bares.filter(b => has(newSpaceKeys[part], b)).map(b => `${part} has the bare (${keyName(b)})`),
      ]);
      assert.deepEqual(wrong, [], `initSpace on a space whose collections did not exist made: ${JSON.stringify(newSpaceKeys)}`);
    });
  });

  describe('initSpace on an EXISTING collection (it runs every boot, before the server listens)', () => {
    beforeEach(async () => { await asUpgradedSpace(); });

    it('builds no compound on an upgraded space, and leaves its bare indexes alone (guard: holds at base)', async () => {
      await initSpace(S, { waitForVectorReady: false });
      const wrong = await problems(async ({ part, compounds, bares }, keys) => [
        ...compounds.filter(c => has(keys, c)).map(c => `${part}: initSpace built (${keyName(c)}) on an existing collection`),
        ...bares.filter(b => !has(keys, b)).map(b => `${part}: initSpace dropped (${keyName(b)})`),
      ]);
      assert.deepEqual(wrong, [], 'a compound built before listen is a boot that does not finish on a large collection');
    });

    it('does not create a bare seq index on a collection that lost it', async () => {
      for (const { part } of PARTS) await coll(part).dropIndexes();
      await initSpace(S, { waitForVectorReady: false });
      const wrong = await problems(async ({ part, compounds, bares }, keys) => [
        ...bares.filter(b => has(keys, b)).map(b => `${part}: initSpace created the bare (${keyName(b)})`),
        ...compounds.filter(c => has(keys, c)).map(c => `${part}: initSpace created (${keyName(c)}) on an existing collection`),
      ]);
      assert.deepEqual(wrong, [], 'initSpace on an existing collection creates no seq index of any kind');
    });
  });

  describe('ensureQueryIndexes (the background pass)', () => {
    let events;
    let proto; let realCreate; let realDrop;
    beforeEach(async () => {
      await asUpgradedSpace();
      events = [];
      proto = Object.getPrototypeOf(coll('facts'));
      realCreate = proto.createIndex; realDrop = proto.dropIndex;
      proto.createIndex = async function recordCreate(keys, ...rest) {
        const r = await realCreate.call(this, keys, ...rest);
        events.push({ op: 'created', coll: this.collectionName, keys: keyName(keys) });
        return r;
      };
      proto.dropIndex = async function recordDrop(name, ...rest) {
        events.push({ op: 'drop', coll: this.collectionName, name: String(name) });
        return realDrop.call(this, name, ...rest);
      };
    });
    const unpatch = () => { proto.createIndex = realCreate; proto.dropIndex = realDrop; };

    it('builds each compound on an existing space and drops the bare index only after the compound exists', async () => {
      try { await ensureQueryIndexes(); } finally { unpatch(); }
      const wrong = await problems(async ({ part, compounds, bares }, keys) => [
        ...compounds.filter(c => !has(keys, c)).map(c => `${part}: no (${keyName(c)}) after the pass`),
        ...bares.filter(b => has(keys, b)).map(b => `${part}: the bare (${keyName(b)}) is still there`),
      ]);
      assert.deepEqual(wrong, [], `after the pass an existing space has ${JSON.stringify(Object.fromEntries(await Promise.all(PARTS.map(async p => [p.part, await keysOf(p.part)]))))}`);
      const nameOf = (keys) => Object.entries(keys).map(([k, v]) => `${k}_${v}`).join('_');
      const replacedBy = (b) => (b.type ? TYPED_COMPOUND : COMPOUND);
      const early = PARTS.flatMap(({ part, bares }) => bares.flatMap((b) => {
        const dropAt = events.findIndex(e => e.op === 'drop' && e.coll === `${S}_${part}` && e.name === nameOf(b));
        const builtAt = events.findIndex(e => e.op === 'created' && e.coll === `${S}_${part}` && e.keys === keyName(replacedBy(b)));
        return dropAt !== -1 && (builtAt === -1 || builtAt > dropAt) ? [`${part}: (${keyName(b)}) dropped before (${keyName(replacedBy(b))}) was built`] : [];
      }));
      assert.deepEqual(early, [], 'the bare index is the only one a reader has until the compound exists');
    });

    it('a build that fails drops nothing (guard: holds at base)', async () => {
      const realCreateIndex = proto.createIndex;
      proto.createIndex = async function failing(keys, ...rest) {
        if ('_id' in keys && 'seq' in keys) throw new Error('the build was killed');
        return realCreateIndex.call(this, keys, ...rest);
      };
      try { await door.logsDuring?.(() => ensureQueryIndexes()); } catch { /* the walk reports; nothing here depends on it */ } finally { unpatch(); }
      const gone = await problems(async ({ part, bares }, keys) => bares.filter(b => !has(keys, b)).map(b => `${part}: (${keyName(b)}) was dropped though no compound exists`));
      assert.deepEqual(gone, [], 'a killed or failed build must leave every reader its old index');
    });

    it('a boot, the background pass, and a second boot do not bring the bare index back', async () => {
      try {
        await initSpace(S, { waitForVectorReady: false }); // boot 1, before listen
        await ensureQueryIndexes();                         // boot 1, background
        await initSpace(S, { waitForVectorReady: false }); // boot 2, before listen: runs for every space, every boot
        await ensureQueryIndexes();                         // boot 2, background
      } finally { unpatch(); }
      const wrong = await problems(async ({ part, compounds, bares }, keys) => [
        ...bares.filter(b => has(keys, b)).map(b => `${part}: the bare (${keyName(b)}) is back`),
        ...compounds.filter(c => !has(keys, c)).map(c => `${part}: no (${keyName(c)})`),
      ]);
      assert.deepEqual(wrong, [], 'initSpace recreated an index the background pass dropped, so every boot pays for a second index on every write');
    });
  });

  describe('explain(), shaped as production reads', () => {
    before(async () => {
      // The state a finished upgrade (or a new space) leaves: the compounds and not the bare indexes.
      for (const { part } of PARTS) await coll(part).dropIndexes();
      await initSpace(S, { waitForVectorReady: false });
      await ensureQueryIndexes();
    });

    for (const reader of READERS) {
      it(`${reader.name}: both finds scan (${keyName(reader.want)}) with no sort`, async () => {
        const finds = keysetFinds({ seq: 50, id: 'd-0150' }, 1_000_000, reader.extra);
        assert.ok(finds.length >= 1, 'the keyset produced no read');
        const wrong = [];
        for (const filter of finds) {
          const ex = await coll(reader.part).find(filter).sort(SORT).limit(201).explain('queryPlanner');
          const winning = ex.queryPlanner.winningPlan;
          const rejected = ex.queryPlanner.rejectedPlans ?? [];
          // A rejected plan that sorts is allowed ONLY when it reads indexes that do not lead with `seq`: the planner always
          // enumerates an `_id` range scan for the tie find (`seq = s AND _id > x`), and, for a file page, a scan of the
          // `{ parentFileId: 1 }` index for its `$exists: false` filter (production's own index, kept for the chunk-grouping
          // reads); it sorts them and loses to the compound (probed on MongoDB 7, with the `parentFileId` index present — a
          // `$nor` or `null` spelling of the filter is enumerated just the same, so the plan cannot be removed from the list).
          // What must never appear is a sorting plan over an index that DOES lead with `seq`: a bare `{ seq: 1 }` the compound
          // did not displace, which is the blocking sort this file exists to rule out.
          const sortsOver = (plan) => stagesOf(plan).some(st => st.startsWith('SORT'));
          const notSeqLed = (plan) => indexScans(plan).every(k => !k.startsWith('seq') && !k.includes(',seq'));
          const sorts = [winning, ...rejected].filter(p => sortsOver(p) && (p === winning || !notSeqLed(p)));
          const scans = indexScans(winning);
          if (sorts.length > 0) wrong.push(`${JSON.stringify(filter)}: a plan sorts (${sorts.flatMap(p => stagesOf(p)).filter(st => st.startsWith('SORT')).join(', ')}) over ${sorts.flatMap(p => indexScans(p)).join(', ') || 'no index'}`);
          if (!scans.includes(keyName(reader.want))) wrong.push(`${JSON.stringify(filter)}: the winning plan scans ${scans.join(', ') || 'no index'}, not (${keyName(reader.want)})`);
        }
        assert.deepEqual(wrong, [], `${reader.name}: the keyset read is not answered from its compound index`);
      });
    }
  });
});
