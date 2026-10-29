/**
 * An edge that ARRIVES (a peer's push, a peer's page, an admin import) is judged against THIS instance's `endpoints` and `functional`
 * rules with its ends resolved, and a breach it introduces is RECORDED in the arrival's sinks — never refused (Q-443, decision P-21 = C:
 * "checks, lets everything in, reports").
 *
 * ## Why the arrival statistic under-reported
 *
 * The arrival recorder judged an edge by `violationsOfRecord`, which handed `validateEdge` no resolved ends. `endpoints` needs the TYPE
 * of the entity at each end and `functional` needs how many other edges the subject already has, and the validator skips a rule whose
 * input it was not given, so an edge from an org to a person under a label declaring `from: [person]` was stored and counted clean, and
 * a second edge for a functional subject too. The local write path resolved both (`plan-edge.ts`); the arrival never did.
 *
 * ## The rule, and the door each case is held on
 *
 * Four doors, one rule (`_arrival-doors.mjs`): the single push route (`POST /api/sync/edges`), `POST /api/sync/batch-upsert`, the
 * engine's PULL, and the admin import. The receiver's own rules and the receiver's own stored data decide (D-9): the type of an end is the
 * type of the entity THIS instance stores, and the count is of the chosen-version edges THIS instance stores.
 *
 *  (a) an edge from an org to a person records `fromType` and `toType`, in warn and in strict;
 *  (b) a second `worksAt` for a subject that already stores one records `functional` on the ARRIVING edge, and only on it;
 *      a stored edge that arrives again beside it is not recounted;
 *  (c) two new edges for one subject in one page: the first records nothing, the second records `functional`;
 *  (d) an entity that arrives in the same page as the edge to it is checked as the type it arrives with;
 *  (e) a breaking edge that arrives again, as a newer version, records nothing the second time (the replaced copy had it);
 *  (f) an end that resolves to nothing is not checked: a dangling end records no `fromType` / `toType`;
 *  (g) an `off` space records nothing and stores the same arrival;
 *  (h) a `strict` space stores every one of them and never mints the write guard: the recorder refuses nothing.
 *
 * ## What each door can say
 *
 * Rows per document where the door has them (single push, import), the count of documents recorded where it has one (batch, import), and
 * the NAMES of the fields in the log line and the sync history row (batch, pull, which answer no rows). Names and counts, never values.
 *
 * Run: a Mongo the harness accepts, then
 *      node --test testing/standalone/an-arriving-edge-is-recorded-against-its-endpoint-and-functional-rules-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { arrivalHarness } from './_arrival-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const MODES = Object.freeze(['strict', 'warn', 'off']);
/** The fields the two rules record under: the only names this file looks for in a sink. */
const RULE_FIELDS = Object.freeze(['fromType', 'toType', 'functional']);

/** `worksAt` is functional and runs from a person to an org. Literal on purpose: a fixture derived from the server asserts the server equals itself. */
const metaOf = (validationMode) => ({
  validationMode,
  suppressEmbeddings: true,
  typeSchemas: {
    entity: { person: {}, org: {} },
    edge: { worksAt: { functional: true, endpoints: { from: ['person'], to: ['org'] } } },
  },
});

const POOL = { strict: 3, warn: 10, off: 3 };
const SHARED = 2;
const names = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const PULL_POOL = Object.fromEntries(MODES.map(m => [m, names(`aepull${m}`, POOL[m])]));
const SHARED_POOL = Object.fromEntries(MODES.map(m => [m, names(`aeshared${m}`, SHARED)]));
const ALL_SPACES = MODES.flatMap(m => [...PULL_POOL[m], ...SHARED_POOL[m]]);
const META = Object.fromEntries(MODES.flatMap(m => [...PULL_POOL[m], ...SHARED_POOL[m]].map(id => [id, metaOf(m)])));
const turn = { strict: 0, warn: 0, off: 0 };
const pulled = { strict: 0, warn: 0, off: 0 };

const harness = arrivalHarness({ peerPrefix: 'aerec-peer-' });
const DOORS = harness.doors('edges');
let door;

/** A space a case starts from: a new one for a pull (a once-per-window line must not hide a second recording), a wiped shared one otherwise. */
async function freshSpace(doorName, mode) {
  if (doorName === 'pull') {
    const id = PULL_POOL[mode][pulled[mode]++];
    assert.ok(id, `the pull pool of ${POOL[mode]} ${mode} spaces ran out — enlarge POOL`);
    return id;
  }
  const id = SHARED_POOL[mode][turn[mode]++ % SHARED];
  await door.wipe(id);
  return id;
}

/** Four entities every case may use: two people and two orgs. */
const people = (space) => [build.entity(space, 'p1', 1, { type: 'person' }), build.entity(space, 'p2', 2, { type: 'person' })];
const orgs = (space) => [build.entity(space, 'o1', 3, { type: 'org' }), build.entity(space, 'o2', 4, { type: 'org' })];
const seedEntities = (space) => door.coll(space, 'entities').insertMany([...people(space), ...orgs(space)]);
const seedEdges = (space, docs) => door.coll(space, 'edges').insertMany(docs.map(d => ({ ...d })));
const worksAt = (space, id, from, to, seq, extra = {}) => build.edge(space, id, seq, { from, to, label: 'worksAt', ...extra });
const storedEdges = async (space) => new Map((await door.coll(space, 'edges').find({}).toArray()).map(d => [d._id, d]));

/**
 * What an observation recorded, as `{ id -> fields }` where the door names ids, and as the SET of rule field names every door can name.
 * A door with rows is read from its rows; a door with none (batch, pull) from its log line and history row, which carry names and counts.
 */
function recordedBy(d, obs) {
  const byId = new Map();
  for (const r of obs.rows) if (RULE_FIELDS.includes(r.field)) byId.set(r.id, [...(byId.get(r.id) ?? []), r.field].sort());
  const fields = new Set();
  if (d.perDocRows) {
    for (const r of obs.rows) fields.add(r.field);
  } else {
    const text = `${obs.lines.join('\n')}\n${obs.history ?? ''}`;
    for (const m of text.matchAll(/\b(fromType|toType|functional) \(\d+\)|"name":"(fromType|toType|functional)"/g)) fields.add(m[1] ?? m[2]);
  }
  return { byId, fields: new Set([...fields].filter(f => RULE_FIELDS.includes(f))) };
}

/**
 * Hold what an arrival recorded to `expected`: `[[id, [fields]], ...]`. Every door is held to the NAMES; a door that names ids to the ids;
 * a door that counts to the count of documents. Said with the whole observation so a red case shows what the door DID say.
 */
function assertRecorded(name, d, obs, expected) {
  const said = `rows ${JSON.stringify(obs.rows)}, count ${obs.batchCount}, lines ${JSON.stringify(obs.lines.filter(l => RULE_FIELDS.some(f => l.includes(f))))}, history ${obs.history ?? '(none)'}`;
  const got = recordedBy(d, obs);
  const want = new Set(expected.flatMap(([, fs]) => fs));
  assert.deepEqual([...got.fields].sort(), [...want].sort(), `the ${name} door recorded other rule fields than expected (${said})`);
  if (d.perDocRows) {
    assert.deepEqual([...got.byId].sort(), expected.map(([id, fs]) => [id, [...fs].sort()]).sort(), `the ${name} door named other documents or fields than expected (${said})`);
  }
  if (d.counted) assert.equal(obs.batchCount, expected.length, `the ${name} door counted other than ${expected.length} recorded document(s) (${said})`);
}

describe('an arriving edge is recorded against the endpoint and functional rules', { skip }, () => {
  before(async () => {
    door = await harness.open({ suite: 'arrivingedgerules', spaces: ALL_SPACES, meta: META });
  });
  after(async () => { await harness.close(); });

  for (const [name, d] of Object.entries(DOORS)) {
    describe(name, () => {
      const fresh = (mode) => freshSpace(name, mode);

      it('the pools are in place, so the cases below do not pass over nothing', () => {
        assert.ok(ALL_SPACES.length >= MODES.length * 3, 'the fresh spaces were not derived');
        assert.ok(Object.values(META).every(m => m.typeSchemas.edge.worksAt.functional === true && m.typeSchemas.edge.worksAt.endpoints.from[0] === 'person'), 'a pool space lacks the rules');
      });

      for (const mode of ['warn', 'strict']) {
        it(`(a) an edge from an org to a person records both ends in a ${mode} space, and is stored`, async () => {
          const space = await fresh(mode);
          await seedEntities(space);
          const obs = await d.arrive(space, [worksAt(space, 'A', 'o1', 'p1', 10)]);
          assert.ok((await storedEdges(space)).has('A'), 'the edge was not stored');
          assertRecorded(name, d, obs, [['A', ['fromType', 'toType']]]);
        });
      }

      it('(b) a second edge for a functional subject records `functional` on the ARRIVING edge, and a stored edge that arrives beside it is not recounted', async () => {
        const space = await fresh('warn');
        await seedEntities(space);
        await seedEdges(space, [worksAt(space, 'F1', 'p1', 'o1', 11)]);
        // F1 arrives again as a newer version, AFTER the edge that gives its subject a second one: it must not be recounted for the other.
        const obs = await d.arrive(space, [worksAt(space, 'F2', 'p1', 'o2', 12), worksAt(space, 'F1', 'p1', 'o1', 13, { weight: 2 })]);
        const held = await storedEdges(space);
        assert.deepEqual(['F1', 'F2'].map(id => held.get(id)?.seq), [13, 12], 'an arrival was not stored');
        assertRecorded(name, d, obs, [['F2', ['functional']]]);
      });

      it('(c) two new edges for one subject in one page: the first records nothing, the second records `functional`', async () => {
        const space = await fresh('warn');
        await seedEntities(space);
        const obs = await d.arrive(space, [worksAt(space, 'N1', 'p2', 'o1', 20), worksAt(space, 'N2', 'p2', 'o2', 21)]);
        assert.equal((await storedEdges(space)).size, 2, 'an arrival was not stored');
        assertRecorded(name, d, obs, [['N2', ['functional']]]);
      });

      it('(d) an entity that arrives in the same page as the edge to it is checked as the type it arrives with', async () => {
        const space = await fresh('warn');
        // Both ends are NEW: a person and a second person. `to` must be an org, so only `toType` is recorded.
        const obs = await d.arrive(space, [worksAt(space, 'X', 'newP', 'newQ', 30)], {
          entities: [build.entity(space, 'newP', 1, { type: 'person' }), build.entity(space, 'newQ', 2, { type: 'person' })],
        });
        assert.ok((await storedEdges(space)).has('X'), 'the edge was not stored');
        assertRecorded(name, d, obs, [['X', ['toType']]]);
      });

      it('(e) a breaking edge that arrives again as a newer version records nothing the second time', async () => {
        const space = await fresh('warn');
        await seedEntities(space);
        await seedEdges(space, [worksAt(space, 'F1', 'p1', 'o1', 11)]);
        const first = await d.arrive(space, [worksAt(space, 'F2', 'p1', 'o2', 12), worksAt(space, 'A', 'o1', 'p1', 10)]);
        assertRecorded(name, d, first, [['F2', ['functional']], ['A', ['fromType', 'toType']]]);
        const again = await d.arrive(space, [worksAt(space, 'F2', 'p1', 'o2', 14, { weight: 2 }), worksAt(space, 'A', 'o1', 'p1', 15, { weight: 2 })]);
        const held = await storedEdges(space);
        assert.deepEqual(['F2', 'A'].map(id => held.get(id)?.seq), [14, 15], 'the newer version was not stored, so "the second time" is not shown');
        assertRecorded(name, d, again, []);
      });

      it('(f) an end that resolves to nothing is not checked, beside an edge that is', async () => {
        const space = await fresh('warn');
        await seedEntities(space);
        const obs = await d.arrive(space, [
          worksAt(space, 'A', 'o1', 'p1', 10),
          worksAt(space, 'D1', 'ghost1', 'ghost2', 11),
          worksAt(space, 'D2', 'p2', 'ghost3', 12),
        ]);
        assert.deepEqual([...(await storedEdges(space)).keys()].sort(), ['A', 'D1', 'D2'], 'an arrival was not stored');
        assertRecorded(name, d, obs, [['A', ['fromType', 'toType']]]);
      });

      it('(g) an off space stores the same arrival and records nothing, where a warn space records it', async () => {
        const warn = await fresh('warn');
        const off = await fresh('off');
        for (const space of [warn, off]) await seedEntities(space);
        const inWarn = await d.arrive(warn, [worksAt(warn, 'A', 'o1', 'p1', 10)]);
        assertRecorded(name, d, inWarn, [['A', ['fromType', 'toType']]]);
        const inOff = await d.arrive(off, [worksAt(off, 'A', 'o1', 'p1', 10)]);
        assert.ok((await storedEdges(off)).has('A'), 'the off space did not store the edge');
        assertRecorded(name, d, inOff, []);
      });

      it('(h) a strict space stores every one of them, never mints the write guard, and records them', async () => {
        const space = await fresh('strict');
        await seedEntities(space);
        await seedEdges(space, [worksAt(space, 'F1', 'p1', 'o1', 11)]);
        const obs = await d.arrive(space, [worksAt(space, 'F2', 'p1', 'o2', 12), worksAt(space, 'A', 'o1', 'p1', 10)]);
        const held = await storedEdges(space);
        assert.deepEqual([...held.keys()].sort(), ['A', 'F1', 'F2'], 'a strict space refused an arriving edge: the recorder never refuses');
        assert.equal(held.get('F2')?._functionalGuard, undefined, 'an arrival minted the write guard: a second edge for a subject must be able to land');
        assertRecorded(name, d, obs, [['F2', ['functional']], ['A', ['fromType', 'toType']]]);
      });
    });
  }
});
