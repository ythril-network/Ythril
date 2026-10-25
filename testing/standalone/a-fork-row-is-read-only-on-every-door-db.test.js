/**
 * A fork row is read-only to every ordinary door; it changes by resolve, by delete and by arrival only (Q-624 design §8, test 21).
 *
 * ## What it prevents
 *
 * A fork row is an ordinary record of its kind, replicated and listed. Any door that edits a record by id could therefore edit it:
 * `update_fact` on a fork succeeds today. An edit of a fork changes a body whose id was derived from it (M3), so the row stops verifying
 * at every peer; a RELABEL of a fork edge re-keyed it onto its subject's derived id through `rekeyEdge` with `forkOf` carried over, and
 * the next create of that triplet then collided in the store for ever (data integrity lens 1). So one refusal, `refuseForkEdit`
 * (`ForkRowReadOnly`, `409 fork_row_read_only`), sits in the shared read every writer passes: `writeAtReadVersion`'s stored read (which
 * must PROJECT `forkOf`, or it is handed a row that never says it is a fork), and `ReadSet.stored()` for a forking kind (the one door
 * every `save_*` and `save_bulk` plan reads a stored copy through).
 *
 * ## The rule, over every door and every forking kind
 *
 *  - an update, by REST (the brain router's PATCH) and by MCP, naming a fork of each kind answers `fork_row_read_only`, and the row is as it was;
 *  - an edge relabel naming a fork edge is refused the same way (the re-key path), and nothing is re-keyed;
 *  - `save_bulk` by id onto a fork (fact, entity, chrono: an edge item has no id to name one by) is refused, and nothing is written;
 *  - `graph_merge` naming a fork is refused;
 *  - a delete of the fork alone SUCCEEDS and is tombstoned here, and removes only that row.
 *
 * ## ReadSet.stored() (S7)
 *
 * For a forking kind, `stored()` handed a row that carries `forkOf` throws `ForkRowReadOnly`; handed a row that does not, it returns it;
 * and a kind that does not fork (a link, a file) returns even a row that carries a field spelled `forkOf`, because the refusal is about
 * the kinds that fork. The read set is built over an injected reader, as `ReadSet`'s constructor allows, so the rows are exactly these.
 *
 * Run: node --test testing/standalone/a-fork-row-is-read-only-on-every-door-db.test.js  (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { snapshotParts, changedParts, RECORD_PARTS } from './_space-snapshot.mjs';
import { FORK_KINDS, initForkFixtures, seedFork, reviewDoors, findHandler } from './_fork-kinds.mjs';
import { fakeRes } from './_vote-round-instance.mjs';

const skip = await mongoSkipReason();
const S = 'q624readonly';
const REFUSAL = /fork_row_read_only|unresolved version|cannot be edited/;

/** How each kind is edited: the REST PATCH path, the body that changes only the main field, and the MCP tool with its arguments. */
const EDIT = {
  fact:   { path: '/spaces/:spaceId/facts/:id',    body: { fact: 'edited' },             tool: 'update_fact' },
  entity: { path: '/spaces/:spaceId/entities/:id', body: { name: 'Edited' },            tool: 'update_entity' },
  chrono: { path: '/spaces/:spaceId/chrono/:id',   body: { title: 'Edited' },           tool: 'update_chrono' },
  edge:   { path: '/spaces/:spaceId/edges/:id',    body: { description: 'edited' },      tool: 'update_edge' },
};

describe('a fork row is read-only on every door', { skip }, () => {
  let door; let doors; let routers; let mongo; let deleteFns;

  before(async () => {
    door = await openPushDoor({ suite: 'q624t3_readonly', spaces: [{ id: S, label: 'Read only', folders: [], meta: {} }] });
    await initForkFixtures();
    doors = await reviewDoors(door, S);
    mongo = await import('../../server/dist/db/mongo.js');
    routers = {
      fact: (await import('../../server/dist/api/brain/facts.js')).memoriesRouter,
      entity: (await import('../../server/dist/api/brain/entities.js')).entitiesRouter,
      chrono: (await import('../../server/dist/api/brain/chrono.js')).chronoRouter,
      edge: (await import('../../server/dist/api/brain/edges.js')).edgesRouter,
    };
    deleteFns = {
      fact: (await import('../../server/dist/brain/fact.js')).deleteFact,
      entity: (await import('../../server/dist/brain/entities.js')).deleteEntity,
      chrono: (await import('../../server/dist/brain/chrono.js')).deleteChrono,
      edge: (await import('../../server/dist/brain/edges.js')).deleteEdge,
    };
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  /** A subject and one fork of it, per kind; ids are UUIDs so the tool schemas accept them. */
  async function subjectAndFork(kind) {
    const k = FORK_KINDS[kind];
    const id = randomUUID();
    if (kind === 'edge') {
      const { edgeIdFor } = await import('../../server/dist/brain/edge-id.js');
      const [a, b] = [randomUUID(), randomUUID()];
      await door.coll(S, 'entities').insertMany([build.entity(S, a, 1), build.entity(S, b, 1)]);
      const subject = edgeIdFor(a, b, 'knows', 'entity', 'entity');
      await door.coll(S, 'edges').insertOne(k.row(S, subject, 5, { from: a, to: b, label: 'knows', description: 'subject' }));
      return { subject, fork: await seedFork(door, S, 'edge', subject, 5, { from: a, to: b, label: 'knows', ...k.alt }) };
    }
    await door.coll(S, k.family).insertOne(k.row(S, id, 5, { pos: 5, posAtSeq: 5 }));
    return { subject: id, fork: await seedFork(door, S, kind, id, 5, k.alt) };
  }

  const restPatch = async (kind, id, body) => {
    const handler = findHandler(routers[kind], 'patch', EDIT[kind].path);
    assert.ok(handler, `no PATCH ${EDIT[kind].path}`);
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    const rights = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    const res = { ...fakeRes(), end() { this.sent = true; return this; } };
    await handler({ method: 'PATCH', params: { spaceId: S, id }, body, query: {}, authToken: { rights }, headers: {}, get: () => undefined }, res);
    return { ok: res.code < 400, code: res.code, text: JSON.stringify(res.body ?? '') };
  };

  for (const kind of Object.keys(FORK_KINDS)) {
    describe(kind, () => {
      it('an update by REST and by MCP naming the fork is refused fork_row_read_only, and the row is as it was', async () => {
        const { fork } = await subjectAndFork(kind);
        const k = FORK_KINDS[kind];
        const before = await door.coll(S, k.family).findOne({ _id: fork._id });
        const rest = await restPatch(kind, fork._id, EDIT[kind].body);
        assert.equal(rest.ok, false, `REST: a PATCH of a ${kind} fork was accepted`);
        assert.equal(rest.code, 409, `REST: ${rest.code} ${rest.text}`);
        assert.match(rest.text, REFUSAL, `REST: the refusal does not say the row is read-only: ${rest.text}`);
        const mcp = await doors.mcp(EDIT[kind].tool, { space: S, id: fork._id, ...EDIT[kind].body });
        assert.equal(mcp.ok, false, `MCP: ${EDIT[kind].tool} on a fork was accepted`);
        assert.match(mcp.sentence ?? mcp.text, REFUSAL, `MCP: the refusal does not say the row is read-only: ${mcp.sentence ?? mcp.text}`);
        assert.deepEqual(await door.coll(S, k.family).findOne({ _id: fork._id }), before, `a refused update of a ${kind} fork changed the row`);
      });

      it('a delete of the fork alone succeeds, is tombstoned here, and removes that row only', async () => {
        const { subject, fork } = await subjectAndFork(kind);
        const k = FORK_KINDS[kind];
        assert.equal(await deleteFns[kind](S, fork._id), true, 'the delete of a fork alone was refused');
        assert.equal(await door.coll(S, k.family).countDocuments({ _id: fork._id }), 0, 'the fork is still stored');
        assert.equal(await door.coll(S, k.family).countDocuments({ _id: subject }), 1, 'deleting a fork removed its subject');
        assert.equal((await door.coll(S, 'tombstones').findOne({ _id: fork._id }))?.issuedHere, true, 'no tombstone issued here for the fork');
      });
    });
  }

  it('an edge relabel naming a fork edge is refused and re-keys nothing', async () => {
    const { fork } = await subjectAndFork('edge');
    const before = await snapshotParts(mongo, S, RECORD_PARTS);
    const r = await doors.mcp('update_edge', { space: S, id: fork._id, label: 'employs' });
    assert.equal(r.ok, false, 'a relabel of a fork edge was accepted: it re-keys the fork onto its subject\'s derived id');
    assert.match(r.sentence ?? r.text, REFUSAL, r.sentence ?? r.text);
    assert.deepEqual(changedParts(before, await snapshotParts(mongo, S, RECORD_PARTS)), [], 'a refused relabel wrote something');
  });

  for (const kind of ['fact', 'entity', 'chrono']) {
    it(`${kind}: save_bulk by id onto a fork is refused and writes nothing`, async () => {
      const { fork } = await subjectAndFork(kind);
      const before = await snapshotParts(mongo, S, RECORD_PARTS);
      const field = { fact: 'facts', entity: 'entities', chrono: 'chrono' }[kind];
      const r = await doors.mcp('save_bulk', { space: S, [field]: [{ id: fork._id, ...EDIT[kind].body }] });
      assert.equal(r.ok, false, `save_bulk wrote a ${kind} fork by id`);
      assert.match(r.sentence ?? r.text, REFUSAL, r.sentence ?? r.text);
      assert.deepEqual(changedParts(before, await snapshotParts(mongo, S, RECORD_PARTS)), [], 'a refused bulk wrote something');
    });
  }

  it('graph_merge naming a fork as either side is refused', async () => {
    const { fork } = await subjectAndFork('entity');
    const other = randomUUID();
    await door.coll(S, 'entities').insertOne(build.entity(S, other, 3));
    for (const args of [{ survivorId: fork._id, absorbedId: other }, { survivorId: other, absorbedId: fork._id }]) {
      const r = await doors.mcp('graph_merge', { space: S, resolutions: [], ...args });
      assert.equal(r.ok, false, 'graph_merge accepted a fork');
      assert.match(r.sentence ?? r.text, REFUSAL, r.sentence ?? r.text);
    }
  });

  describe('ReadSet.stored()', () => {
    const readerOf = (rows) => async (_coll, ids) => rows.filter(r => ids.includes(r._id));
    const storedOf = async (kind, row) => {
      const { ReadSet } = await import('../../server/dist/brain/write-plan/read-set.js');
      const set = new ReadSet(S, readerOf([row]));
      await set.load({ records: { [kind]: [row._id] } });
      return set;
    };

    for (const kind of Object.keys(FORK_KINDS)) {
      it(`${kind}: throws ForkRowReadOnly for a row that carries forkOf, and returns one that does not`, async () => {
        const plain = { _id: 'plain', seq: 3 };
        const fork = { _id: 'fork', seq: 3, forkOf: 'plain' };
        assert.equal((await storedOf(kind, plain)).stored(kind, 'plain')._id, 'plain', 'a row that is no fork was refused');
        const { ForkRowReadOnly } = await import('../../server/dist/brain/forks.js');
        assert.equal(typeof ForkRowReadOnly, 'function', 'brain/forks.js exports no ForkRowReadOnly');
        const set = await storedOf(kind, fork);
        assert.throws(() => set.stored(kind, 'fork'), ForkRowReadOnly, `${kind}: the read set handed a fork row to a planner`);
      });
    }

    it('a kind that does not fork returns a row whatever it carries', async () => {
      // A file is the one non-forking kind a read set loads records of (a link has no record collection of its own to read by id).
      const set = await storedOf('file', { _id: 'f1', seq: 3, forkOf: 'x' });
      assert.equal(set.stored('file', 'f1')._id, 'f1');
    });
  });
});
