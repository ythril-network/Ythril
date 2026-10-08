/**
 * A document a peer PUSHES and the same document this instance PULLS are decided by one rule, and leave the same
 * stored state (Q-204, Q-225).
 *
 * ## The rule
 *
 * Push and pull are two doors to one arrival. The push door plans each page with `planPushArrivals` — a held
 * tombstone governs a record its issuer authored, an equal-seq divergent fact FORKS within the caps, an in-page
 * unique-key collision is decided first-accepted-wins — and validates every document against its `Incoming*`
 * schema. The pull door accepted by seq alone (`planSeqUpserts`) and validated nothing. So the same document
 * delivered the other way round resurrected a deleted record, dropped one side of a divergence, stored a key the
 * schema strips, and stored a field of the wrong type. Each door is individually defensible; the gap is only
 * visible by sending one document through both.
 *
 * ## How the table is built — derived, never listed
 *
 * - **The verdicts** are the planner's own union (`export type …Verdict = …` in `server/src/sync/`), read from the
 *   source with a floor. Every verdict must have a row, so a verdict the planner gains and this table lacks fails.
 * - **The families** are `REPLICATED_FAMILIES`; the tombstone rows run for every family with a tombstone type
 *   (`TOMBSTONE_TYPE_OF`). Every family gets the generic rows (new, newer, older, equal, a wrong-typed field, an
 *   undeclared key). The wrong-typed field is the first required string field of the family's `Incoming*` schema
 *   that the fixture carries, so it is read out of the schema the push door validates with.
 * - **The doors**: `POST /batch-upsert` (what a real peer pushes), the family's single route where it has one (one
 *   document at a time, in page order), and the REAL engine's pull (`runSyncForPeer`) from a fake peer serving the
 *   same page. The pushing token proves the same peer the pull reads from, so "who delivered it" is one answer.
 * - **One aliased space** (`spaceMap`): the rows that read local state by space run there too.
 *
 * ## What "the same" means
 *
 * The stored rows of the family's collection and of the space's tombstones, field for field. A fork's
 * `seq`, `createdAt` and `updatedAt` are left out of the comparison: the seq comes from a counter both doors reach
 * by different paths, and a fork's `createdAt` has its own test (`a-fork-keeps-its-copys-created-at-db`).
 *
 * ## The one deliberate difference, stated as a row
 *
 * A chrono `type` outside this space's vocabulary is dropped on PUSH only: on pull the receiver's schema comes
 * from the same upstream, and dropping would lose the record for good (plan v3 §D, sync-protocol.md). Its row
 * expects the doors to differ in exactly that way.
 *
 * ## Seen red
 *
 * On the base (0b066822): the pull door stores a tombstoned record, keeps a superseded tombstone, skips a fork,
 * stores a wrong-typed field and an undeclared key, and stores a file whose `parentFileId` is not a string.
 *
 * Run: node --test testing/standalone/push-and-pull-decide-alike-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { incomingSchemas } from '../_shared/incoming-sync-schemas.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const L = 'alike';
const LA = 'alike-local';
const RA = 'alike-remote';
/** The pushing token proves the peer the pull reads from: one deliverer for both doors. */
const TOKEN = Object.freeze({ rights: { perSpace: {}, spaceAdmin: { floor: true, spaces: [] } }, peerInstanceId: PEER });
const OTHER_AUTHOR = Object.freeze({ instanceId: 'someone-else', instanceLabel: 'Someone else' });
const THIRD = 'third-instance';
const UNDECLARED = 'notDeclaredByTheSchema';

/** The planner's verdict union, read from the source: every `export type <X>Verdict = '…' | …;` under sync/. */
function plannerVerdicts() {
  const out = new Set();
  for (const f of fs.readdirSync('server/src/sync').filter(n => n.endsWith('.ts'))) {
    const src = fs.readFileSync(`server/src/sync/${f}`, 'utf8');
    for (const m of src.matchAll(/export type \w*Verdict\s*=([^;]+);/g)) {
      for (const v of m[1].matchAll(/'([A-Za-z]+)'/g)) out.add(v[1]);
    }
  }
  assert.ok(out.size >= 8, `only ${out.size} planner verdicts found under server/src/sync (${[...out]}) — re-anchor`);
  return out;
}

let door, families, tombstoneTypeOf, schemaOf, singleRouteOf;

/** A fresh fixture for a family, authored by the delivering peer unless a row says otherwise. */
const make = (key, space, id, seq, extra = {}) => {
  const b = { facts: build.fact, entities: build.entity, edges: build.edge, chrono: build.chrono, links: build.link,
    filemeta: build.filemeta }[key];
  assert.ok(b, `no fixture builder for family '${key}' — add one to _push-door.mjs build`);
  return b(space, id, seq, { author: { ...PEER_AUTHOR }, ...extra });
};
/** The text-like field a row changes to make two copies differ — one the family's schema DECLARES (a link has none). */
const TEXT = { facts: 'fact', entities: 'name', edges: 'description', chrono: 'title', links: null, filemeta: 'description' };
const idFor = (key, n) => (key === 'filemeta' ? `docs/${n}.md` : `${key}-${n}`);

/** The first required string field of the family's schema that the fixture carries, other than `_id`/`spaceId`. */
function wrongTypedField(key) {
  const shape = schemaOf(key).shape;
  const sample = make(key, L, 'x', 1);
  const field = Object.keys(shape).sort()
    .find(k => !['_id', 'spaceId'].includes(k) && shape[k].def?.type === 'string' && typeof sample[k] === 'string');
  assert.ok(field, `no required string field in the ${key} schema to mistype — re-anchor`);
  return field;
}

/**
 * The rows. Each: `family`, the push `verdict` it exercises, `seed(space)` -> `{ stored, tombstones }` in the local
 * space, `page(space)` -> the documents delivered, `check(snapshot)` -> a FIXTURE check on the push door's outcome
 * (the row does what it claims), and `differ` when the doors are meant to differ.
 */
function rows() {
  const out = [];
  const tomb = (space, key, id, seq, issuer) =>
    build.tombstone(space, id, tombstoneTypeOf[key], seq, { instanceId: issuer });
  const has = (snap, id, field, value) => snap.docs.some(d => d._id === id && (field === undefined || d[field] === value));
  // bundle-89 (Q-280): an ARRIVAL stores the version and the author the sender wrote — never this instance's own. Asked on the
  // landing rows below, on every family and every door (the byte doors, the import and the three stampers outside the arrival
  // doors are named in `an-arrival-stores-who-delivered-it-db`).
  const authoredBy = (snap, id, instanceId) => snap.docs.some(d => d._id === id && d.author?.instanceId === instanceId);
  for (const { payloadKey: key } of families) {
    const isFacts = key === 'facts';
    const id = idFor(key, 'r');
    const t = TEXT[key];
    out.push(
      { name: `${key}: a new record lands, stamped with its deliverer`, family: key, verdict: isFacts ? 'inserted' : 'upserted',
        seed: () => ({}), page: (s) => [make(key, s, id, 5)],
        check: (snap) => has(snap, id, 'seq', 5) && has(snap, id, 'deliveredBy', PEER) && authoredBy(snap, id, PEER) },
      // bundle-51: every arrival stores who delivered it, and every door the same one (the pushing token proves the peer the
      // pull reads from). A newer copy replaces the deliverer of the version it replaces.
      { name: `${key}: a newer copy replaces the stored one and the deliverer with it`, family: key, verdict: isFacts ? 'updated' : 'upserted',
        seed: (s) => ({ stored: [{ ...make(key, s, id, 3), deliveredBy: 'the-earlier-deliverer' }] }),
        page: (s) => [make(key, s, id, 5)],
        check: (snap) => has(snap, id, 'seq', 5) && has(snap, id, 'deliveredBy', PEER) && authoredBy(snap, id, PEER) },
      { name: `${key}: a newer copy replaces the stored one`, family: key, verdict: isFacts ? 'updated' : 'upserted',
        seed: (s) => ({ stored: [make(key, s, id, 3, t ? { [t]: 'old' } : {})] }),
        page: (s) => [make(key, s, id, 5, t ? { [t]: 'new' } : {})],
        check: (snap) => (t ? has(snap, id, t, 'new') : has(snap, id, 'seq', 5)) },
      { name: `${key}: an older copy is skipped`, family: key, verdict: 'skipped',
        seed: (s) => ({ stored: [make(key, s, id, 5, t ? { [t]: 'kept' } : {})] }),
        page: (s) => [make(key, s, id, 3, t ? { [t]: 'older' } : {})],
        check: (snap) => (t ? has(snap, id, t, 'kept') : has(snap, id, 'seq', 5)) },
      { name: `${key}: an equal, identical copy is skipped`, family: key, verdict: 'skipped',
        seed: (s) => ({ stored: [make(key, s, id, 5, t ? { [t]: 'same' } : {})] }),
        page: (s) => [make(key, s, id, 5, t ? { [t]: 'same' } : {})], check: (snap) => has(snap, id, 'seq', 5) },
      { name: `${key}: a wrong-typed field is refused (Q-225)`, family: key, verdict: 'rejected',
        seed: () => ({}), page: (s) => [make(key, s, id, 5, { [wrongTypedField(key)]: 12345 })],
        check: (snap) => !has(snap, id) },
      { name: `${key}: an undeclared key is treated as the schema treats it (Q-225)`, family: key,
        verdict: key === 'filemeta' ? 'rejected' : (isFacts ? 'inserted' : 'upserted'),
        seed: () => ({}), page: (s) => [make(key, s, id, 5, { [UNDECLARED]: 'x' })],
        check: (snap) => snap.docs.every(d => !(UNDECLARED in d)) },
    );
    if (tombstoneTypeOf[key] === undefined) continue;
    out.push(
      { name: `${key}: a held tombstone at or above the seq refuses the record`, family: key, verdict: 'tombstoned', aliased: true,
        seed: (s) => ({ tombstones: [tomb(s, key, id, 7, PEER)] }), page: (s) => [make(key, s, id, 5)],
        check: (snap) => !has(snap, id) && snap.tombstones.some(x => x._id === id) },
      { name: `${key}: a newer record supersedes a stale tombstone, which is cleaned up`, family: key,
        verdict: isFacts ? 'inserted' : 'upserted',
        seed: (s) => ({ tombstones: [tomb(s, key, id, 3, PEER)] }), page: (s) => [make(key, s, id, 5)],
        check: (snap) => has(snap, id, 'seq', 5) && !snap.tombstones.some(x => x._id === id) },
      { name: `${key}: author != tombstone issuer, the deliverer PROVES it is the author: the record lands`, family: key,
        verdict: isFacts ? 'inserted' : 'upserted',
        seed: (s) => ({ tombstones: [tomb(s, key, id, 7, THIRD)] }), page: (s) => [make(key, s, id, 5)],
        check: (snap) => has(snap, id, 'seq', 5) },
      { name: `${key}: author != tombstone issuer, the deliverer is NOT the author: the tombstone governs`, family: key,
        verdict: 'tombstoned',
        seed: (s) => ({ tombstones: [tomb(s, key, id, 7, THIRD)] }), page: (s) => [make(key, s, id, 5, { author: { ...OTHER_AUTHOR } })],
        check: (snap) => !has(snap, id) },
      // bundle-51 (D-14 = C): a tombstone applied on the UPSTREAM's say-so is stored via it, and does not refuse that same
      // upstream's later version of the record — on every door alike (`a-tombstone-from-the-upstream-deletes-what-it-relayed-db`
      // holds the rest: a lateral peer's copy of it is still refused, and a tombstone not stored via the upstream still governs).
      { name: `${key}: a tombstone stored via the delivering upstream does not refuse that upstream's later version of a third author's record`,
        family: key, verdict: isFacts ? 'inserted' : 'upserted',
        seed: (s) => ({ tombstones: [{ ...tomb(s, key, id, 7, THIRD), storedVia: PEER }] }),
        page: (s) => [make(key, s, id, 5, { author: { instanceId: THIRD, instanceLabel: THIRD } })],
        check: (snap) => has(snap, id, 'seq', 5) },
    );
  }

  // Facts: the fork rules.
  out.push(
    { name: 'facts: an equal-seq divergent copy forks', family: 'facts', verdict: 'forked', aliased: true,
      seed: (s) => ({ stored: [make('facts', s, 'f', 5, { fact: 'mine' })] }),
      page: (s) => [make('facts', s, 'f', 5, { fact: 'theirs' })],
      check: (snap) => has(snap, 'f', 'fact', 'mine') && snap.docs.some(d => d.forkOf === 'f' && d.fact === 'theirs') },
    { name: 'facts: a divergent copy at the fan-out cap is refused, nothing written', family: 'facts', verdict: 'forkRefused',
      seed: (s) => ({ stored: [make('facts', s, 'f', 5, { fact: 'mine' }),
        ...Array.from({ length: 10 }, (_, i) => make('facts', s, `sib-${i}`, 20 + i, { fact: `sib ${i}`, forkOf: 'f' }))] }),
      page: (s) => [make('facts', s, 'f', 5, { fact: 'theirs' })],
      check: (snap) => !snap.docs.some(d => d.fact === 'theirs') },
  );
  // Unique-key collisions: in one page, and against a stored record.
  for (const key of ['edges', 'links']) {
    const twin = key === 'edges'
      ? { from: 'ent-a', to: 'ent-b', label: 'knows' }
      : { from: 'fact-a', fromKind: 'fact', to: 'ent-b', toKind: 'entity' };
    out.push(
      { name: `${key}: two ids, one unique key, in one page: the first accepted wins`, family: key, verdict: 'duplicate', single: false,
        seed: () => ({}), page: (s) => [make(key, s, `${key}-one`, 5, twin), make(key, s, `${key}-two`, 6, twin)],
        check: (snap) => has(snap, `${key}-one`) && !has(snap, `${key}-two`) },
      { name: `${key}: a record holding a stored record's unique key under another id is not applied`, family: key, verdict: 'duplicate',
        seed: (s) => ({ stored: [make(key, s, `${key}-held`, 3, twin)] }), page: (s) => [make(key, s, `${key}-new`, 5, twin)],
        check: (snap) => has(snap, `${key}-held`) && !has(snap, `${key}-new`) },
    );
  }
  // File metadata: a parentFileId that is not a string is a chunk claim the schema refuses, never a top-level file.
  for (const [what, v] of [['a number', 42], ['zero', 0], ['false', false], ['null', null], ['an object', {}], ['an array', ['x']]]) {
    out.push({ name: `filemeta: a parentFileId that is ${what} is refused (Q-225)`, family: 'filemeta', verdict: 'rejected',
      seed: () => ({}), page: (s) => [make('filemeta', s, 'docs/chunky.md', 5, { parentFileId: v })],
      check: (snap) => !has(snap, 'docs/chunky.md') });
  }
  // The one deliberate difference.
  out.push({ name: 'chrono: a type outside the vocabulary is dropped on push only (stated difference)', family: 'chrono',
    verdict: 'unknownType', differ: 'push drops it, pull stores it',
    seed: () => ({}), page: (s) => [make('chrono', s, 'chrono-odd', 5, { type: 'not-a-chrono-type' })],
    check: (snap) => !has(snap, 'chrono-odd') });
  return out;
}

/** The stored outcome of a row in a local space: the family's rows and the tombstones, comparable across doors. */
async function snapshot(local, key, knownIds) {
  const fam = families.find(f => f.payloadKey === key);
  const docs = (await door.coll(local, fam.collection).find({}).sort({ _id: 1 }).toArray()).map(d => {
    const out = { ...d };
    if (out.forkOf && !knownIds.has(out._id)) { delete out.seq; delete out.createdAt; delete out.updatedAt; }
    return out;
  });
  const tombstones = await door.coll(local, 'tombstones').find({}, { projection: { _id: 1, seq: 1, type: 1, instanceId: 1, storedVia: 1 } })
    .sort({ _id: 1 }).toArray();
  return { docs, tombstones };
}

async function seedLocal(local, seeded) {
  if (seeded.stored?.length) {
    const fam = families.find(f => f.payloadKey === seeded.family);
    /*
     * bundle-51: a stored record is one THIS DELIVERER delivered — it carries `deliveredBy`, as every arrival stores it. A row
     * seeded without one is a record stored before the stamp existed, which the pull's cycle stamps once (the back-fill) and the
     * push never does, so the same seed would leave the two doors' stored rows differing by a field neither row is about.
     */
    await door.coll(local, fam.collection).insertMany(seeded.stored.map(d => ({ deliveredBy: PEER, ...d })));
  }
  if (seeded.tombstones?.length) await door.coll(local, 'tombstones').insertMany(seeded.tombstones);
}

/** Run one row through one door; returns the stored outcome. */
async function through(doorName, row, local) {
  await door.reset();
  const remote = door.remoteOf(local);
  const seeded = { family: row.family, ...row.seed(local) };
  await seedLocal(local, seeded);
  const page = row.page(remote);
  const knownIds = new Set([...(seeded.stored ?? []).map(d => d._id), ...page.map(d => d._id)]);
  const at = { spaceId: remote, networkId: door.NET, token: TOKEN };
  if (doorName === 'batch') {
    const r = await door.push('/batch-upsert', { [row.family]: page }, at);
    assert.equal(r.code, 200, `${row.name}: batch-upsert answered ${r.code} ${JSON.stringify(r.body)}`);
  } else if (doorName === 'single') {
    for (const d of page) await door.push(singleRouteOf[row.family], d, at);
  } else {
    door.state.records[remote] = { [row.family]: page };
    await door.sync();
  }
  await door.settled();
  return snapshot(local, row.family, knownIds);
}

describe('push and pull decide alike (Q-204, Q-225)', { skip }, () => {
  let ROWS;
  before(async () => {
    door = await openPullDoor({ suite: 'push-pull-alike', spaces: [L, LA], spaceMap: { [RA]: LA } });
    ({ REPLICATED_FAMILIES: families } = await import('../../server/dist/sync/replicated-families.js'));
    ({ TOMBSTONE_TYPE_OF: tombstoneTypeOf } = await import('../../server/dist/config/types.js'));
    const shared = await import('../../server/dist/api/sync/_shared.js');
    const schemas = new Map(incomingSchemas(shared));
    const { FAMILIES } = await import('./_push-door.mjs');
    const schemaName = { facts: 'IncomingFactDoc', entities: 'IncomingEntityDoc', edges: 'IncomingEdgeDoc',
      chrono: 'IncomingChronoDoc', links: 'IncomingLinkDoc', filemeta: 'IncomingFileMetaDoc' };
    schemaOf = (key) => {
      const s = schemas.get(schemaName[key]);
      assert.ok(s, `no Incoming schema for family '${key}' — the fixture table and the schemas drifted`);
      return s;
    };
    singleRouteOf = Object.fromEntries(Object.entries(FAMILIES).map(([k, f]) => [k, f.single]));
    ROWS = rows();
  });
  after(async () => { await door?.close(); });

  it('the table covers every planner verdict and every replicated family', () => {
    assert.ok(families.length >= 6, `only ${families.length} replicated families`);
    const verdicts = plannerVerdicts();
    const missing = [...verdicts].filter(v => !ROWS.some(r => r.verdict === v));
    assert.deepEqual(missing, [], `planner verdicts with no row: ${missing}`);
    const uncovered = families.filter(f => !ROWS.some(r => r.family === f.payloadKey)).map(f => f.payloadKey);
    assert.deepEqual(uncovered, [], `replicated families with no row: ${uncovered}`);
    assert.ok(ROWS.length >= 40, `only ${ROWS.length} rows — the derivation shrank`);
  });

  it('every row does on the push door what it claims (fixture check)', async () => {
    const wrong = [];
    for (const row of ROWS) {
      const snap = await through('batch', row, L);
      if (!row.check(snap)) wrong.push(`${row.name}: ${JSON.stringify(snap)}`);
    }
    assert.deepEqual(wrong, [], 'rows whose push outcome is not what the row claims — the FIXTURE is wrong, not the doors');
  });

  it('every row leaves the same stored state through batch push, single push and pull — all or none', async () => {
    const differ = [];
    for (const row of ROWS) {
      const spaces = row.aliased ? [L, LA] : [L];
      for (const local of spaces) {
        const where = local === LA ? ' [aliased space]' : '';
        const batch = await through('batch', row, local);
        const pulled = await through('pull', row, local);
        const single = singleRouteOf[row.family] && row.single !== false ? await through('single', row, local) : null;
        // Field for field, key order aside: the push door's schema parse re-orders keys, which no reader sees.
        if (single && !isDeepStrictEqual(single, batch)) differ.push(`${row.name}${where}: single push != batch push`);
        const same = isDeepStrictEqual(pulled, batch);
        if (row.differ) {
          if (same || !row.check(batch) || row.check(pulled)) differ.push(`${row.name}${where}: expected the stated difference (${row.differ})`);
        } else if (!same) {
          differ.push(`${row.name}${where}: pull stored ${JSON.stringify(pulled)} where push stored ${JSON.stringify(batch)}`);
        }
      }
    }
    assert.deepEqual(differ, [], `${differ.length} row(s) decided differently by the doors`);
  });
});
