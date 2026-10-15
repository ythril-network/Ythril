/**
 * From the moment a space act is REGISTERED, every writer of that space is closed — in the writer, not at a door (bundle-106 PR A, X1, X2).
 *
 * ## The rule this holds, and the red it is seen at
 *
 * `spaceWriteRefusal` read only `pendingSpaceOp` and the not-configured clause, and it was asked by the FILE door alone. So a wipe that
 * had concluded and was queued (or draining, or owed after a failed attempt) closed nothing: a fact, an entity, an edge, a chrono
 * entry, an admin import, an admin-token sync push all landed in a space the act then emptied. The rule is that the standing
 * predicate (`spaceActStands`, §2.5a) is asked by EVERY writer, per write unit, and a refusal is one typed error that both doors
 * answer alike (§2.6b). Each row below stands an act entry up in the live config exactly as the runner's registration leaves it
 * (`_space-act-harness.mjs`) and calls the REAL writer; the writer is red on the base because it stores the record.
 *
 * ## Rows (design v5 §6.1)
 *
 * - R-X1a (the closure half): an entry that is only `registered` closes the writers at once — no body, no drain has happened.
 * - R-X2a: the admin import's writer (`writeArrivals` with `restore`) refuses and stores nothing.
 * - R-X2b: an instance-admin token's `/batch-upsert` is answered `409`, and stores nothing.
 * - R-X2c: a `save_bulk` admitted before the registration lands the stage it had started and refuses the next stage.
 * - R-X2d: one refused write answers `409` with the same `code` and the same text on the REST sender, `POST /api/<tool>` and MCP.
 * - R-X2e: a typed wipe closes only the families it covers, and a deletion closes every family.
 * - R-X2f: a token without the write rung gets the rung's `403`, never the closure's `409`.
 * - R-X2g: a peer token's push is answered `423 space_held` and never `409`, on the door's first look and in the race
 *   where its first chunk was admitted before the registration.
 *
 * ## Controls that pass on the base, on purpose
 *
 * A space with no entry takes every write (so a refusal is the entry's, not the harness's); another space takes writes while one is
 * closed (the closure is per space); a `facts` wipe leaves entity and file writes alone (the typed half of X2e).
 *
 * Run: `node --test testing/standalone/a-registered-space-act-closes-every-writer-db.test.js` (a Mongo the harness accepts; a prior
 * `npm run build` in server/).
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { ADMIN_TOKEN, peerToken, build } from './_push-door.mjs';
import { parkWrites } from './_write-faults.mjs';
import { seedActEntry, clearActEntries } from './_space-act-harness.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const VICTIM = 'closingspace';
const OTHER = 'openspace';
const CODE_OF = { wipe: 'space_being_wiped', delete: 'space_being_deleted', rename: 'space_being_renamed' };

describe('a registered space act closes every writer of its space', { skip }, () => {
  let door, loader, gate, writers;

  before(async () => {
    door = await openToolDoor({ suite: 'actclosure', spaces: [
      { id: VICTIM, label: VICTIM, folders: [] }, { id: OTHER, label: OTHER, folders: [] },
    ] });
    loader = await import('../../server/dist/config/loader.js');
    gate = await import('../../server/dist/spaces/space-write-gate.js');
    writers = {
      fact: await import('../../server/dist/brain/fact.js'),
      entity: await import('../../server/dist/brain/entities.js'),
      edge: await import('../../server/dist/brain/edges.js'),
      chrono: await import('../../server/dist/brain/chrono.js'),
      bulk: await import('../../server/dist/brain/bulk.js'),
      arrivals: await import('../../server/dist/sync/arrivals.js'),
      files: await import('../../server/dist/files/files.js'),
    };
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    clearActEntries(loader);
    for (const s of [VICTIM, OTHER]) for (const c of ['facts', 'entities', 'edges', 'chrono', 'links', 'tombstones']) await door.coll(s, c).deleteMany({});
  });
  afterEach(() => clearActEntries(loader));

  const A = 'bbbbbbbb-0000-4000-8000-0000000c0a01';
  const B = 'bbbbbbbb-0000-4000-8000-0000000c0b02';
  /** Every record writer, each as a call that STORES into `space` when the space takes writes, and the collection it stores into. */
  const WRITES = {
    fact: { family: 'facts', run: (s) => writers.fact.saveFact(s, 'a fact written while an act stands', [], [], undefined, undefined, 'note') },
    entity: { family: 'entities', run: (s) => writers.entity.upsertEntity(s, 'Closed Entity', 'concept', [], {}, 'x') },
    chrono: { family: 'chrono', run: (s) => writers.chrono.createChrono(s, { title: 'closed event', type: 'event', startsAt: '2026-01-01T00:00:00.000Z' }) },
    edge: { family: 'edges', seed: true, run: (s) => writers.edge.upsertEdge(s, A, B, 'knows') },
    bulk: { family: 'facts', run: (s) => writers.bulk.bulkWrite(s, { facts: [{ fact: 'a bulk fact', type: 'note' }] }) },
  };
  const seedEndpoints = async (s) => door.coll(s, 'entities').insertMany([
    { _id: A, spaceId: s, name: 'A', type: 'person', tags: [], seq: 1 }, { _id: B, spaceId: s, name: 'B', type: 'person', tags: [], seq: 1 }]);
  const stored = async (s, family) => door.coll(s, family).countDocuments({ _id: { $nin: [A, B] } });

  async function refused(promise) {
    try { await promise; } catch (err) { return err; }
    return null;
  }

  it('control: a space with no act takes every writer, so a refusal below is the entry\'s', async () => {
    await seedEndpoints(OTHER);
    for (const [name, w] of Object.entries(WRITES)) {
      const err = await refused(w.run(OTHER));
      assert.equal(err, null, `the ${name} writer refused a space with no act: ${err?.message}`);
      assert.ok(await stored(OTHER, w.family) >= 1, `the ${name} writer stored nothing in a space that takes writes`);
    }
  });

  for (const kind of ['wipe', 'delete', 'rename']) {
    it(`R-X1a: a ${kind} entry that is only REGISTERED refuses every record writer with the typed refusal, and nothing lands`, async () => {
      await seedEndpoints(VICTIM); await seedEndpoints(OTHER);
      await seedActEntry(loader, { kind, localId: VICTIM, state: 'registered', ...(kind === 'rename' ? { newId: 'renamedspace' } : {}) });
      for (const [name, w] of Object.entries(WRITES)) {
        const err = await refused(w.run(VICTIM));
        assert.ok(err, `the ${name} writer stored into a space with a registered ${kind} standing`);
        assert.ok(gate.isSpaceNotWritable(err), `the ${name} writer's refusal is not the space-closed refusal: ${err?.message}`);
        assert.equal(err.code, CODE_OF[kind], `the ${name} writer's refusal carries the wrong code: ${err.code}`);
        assert.equal(await stored(VICTIM, w.family), 0, `the ${name} writer's record landed although it was refused`);
        assert.equal(await refused(w.run(OTHER)), null, `the closure of ${VICTIM} refused a write to ${OTHER}`);
      }
    });
  }

  for (const state of ['draining', 'running', 'owed']) {
    it(`R-X1a: an entry in state '${state}' closes the writers as a registered one does`, async () => {
      await seedActEntry(loader, { kind: 'wipe', localId: VICTIM, state, attempts: state === 'owed' ? 1 : 0, retryAt: state === 'owed' ? '2099-01-01T00:00:00.000Z' : undefined });
      const err = await refused(WRITES.fact.run(VICTIM));
      assert.ok(err && gate.isSpaceNotWritable(err), `a '${state}' entry did not close the fact writer: ${err?.message ?? 'it stored'}`);
    });
  }

  it('R-X2a: the admin import\'s writer (writeArrivals, restore) refuses a space with a standing wipe and stores nothing', async () => {
    await seedActEntry(loader, { kind: 'wipe', localId: VICTIM });
    const doc = build.fact(VICTIM, 'cccccccc-0000-4000-8000-0000000c0001', 1);
    const err = await refused(writers.arrivals.writeArrivals(VICTIM, 'facts', 'fact', [doc], { restore: true }));
    assert.ok(err && gate.isSpaceNotWritable(err), `the import's writer did not refuse: ${err?.message ?? 'it wrote'}`);
    assert.equal(err.code, 'space_being_wiped');
    assert.equal(await door.coll(VICTIM, 'facts').countDocuments({}), 0, 'the import landed a record in a space being wiped');
  });

  it('R-X2b: an instance-admin token\'s /batch-upsert into a space with a standing wipe is answered 409 and stores nothing', async () => {
    await seedActEntry(loader, { kind: 'wipe', localId: VICTIM });
    const r = await door.push('/batch-upsert', { facts: [build.fact(VICTIM, 'cccccccc-0000-4000-8000-0000000c0002', 1)] },
      { spaceId: VICTIM, token: ADMIN_TOKEN });
    assert.equal(r.code, 409, `the admin push was answered ${r.code}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.code, 'space_being_wiped');
    assert.equal(await door.coll(VICTIM, 'facts').countDocuments({}), 0, 'the admin push landed a record in a space being wiped');
  });

  it('R-X2c: a save_bulk admitted before the registration lands the stage it began and is refused at the next stage', async () => {
    const proto = Object.getPrototypeOf(door.mongo.col('probe'));
    const park = parkWrites(proto);
    try {
      // The commit's order is facts, then entities (`write-plan/types.ts`); the first stage is held while the act registers.
      const first = park.arm(`${VICTIM}_facts`);
      const bulk = writers.bulk.bulkWrite(VICTIM, { facts: [{ fact: 'stage one fact', type: 'note' }], entities: [{ name: 'Stage Two Entity', type: 'concept' }] });
      const settled = bulk.then(r => ({ r }), err => ({ err }));
      await first.reached;
      await seedActEntry(loader, { kind: 'wipe', localId: VICTIM, state: 'registered' });
      first.release();
      const out = await settled;
      assert.equal(await door.coll(VICTIM, 'facts').countDocuments({}), 1, 'the stage admitted before the registration did not land');
      assert.equal(await door.coll(VICTIM, 'entities').countDocuments({}), 0, 'the stage after the registration landed in a space being wiped');
      const text = JSON.stringify(out.r ?? { error: String(out.err?.message) });
      assert.match(text, /being wiped|takes no writes/i, `the refused stage is not told why: ${text.slice(0, 400)}`);
    } finally { park.restore(); }
  });

  it('R-X2d: one refused write answers 409 with the same code and text on the REST sender, POST /api/<tool> and MCP', async () => {
    await seedEndpoints(VICTIM);
    await seedActEntry(loader, { kind: 'wipe', localId: VICTIM });
    const err = await refused(WRITES.edge.run(VICTIM));
    assert.ok(err, 'the writer did not refuse, so there is no refusal to answer on three doors');
    const edgeArgs = { space: VICTIM, from: A, to: B, label: 'knows' };
    const { sendCaughtFailure } = await import('../../server/dist/api/send-failure.js');
    const res = { statusCode: 200, body: undefined, headersSent: false, req: {}, setHeader() { return this; },
      status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    sendCaughtFailure(res, 'a fact write', err);
    const mcp = await door.call('save_edge', edgeArgs, { transport: 'mcp' });
    const rest = await door.call('save_edge', edgeArgs, { transport: 'rest' });
    assert.equal(res.statusCode, 409, `the REST sender answered ${res.statusCode}: ${JSON.stringify(res.body)}`);
    assert.equal(mcp.status, 409, `MCP answered ${mcp.status}: ${mcp.text}`);
    assert.equal(rest.status, 409, `POST /api/<tool> answered ${rest.status}: ${rest.text}`);
    for (const [door_, body] of [['REST sender', res.body], ['MCP', mcp.structured], ['POST /api/<tool>', rest.structured]]) {
      assert.equal(body?.code, 'space_being_wiped', `${door_} says ${JSON.stringify(body?.code)}`);
    }
    assert.equal(mcp.structured?.error, res.body?.error, 'MCP and the REST sender word the refusal differently');
    assert.equal(rest.structured?.error, res.body?.error, 'POST /api/<tool> and the REST sender word the refusal differently');
    assert.match(String(res.body?.error), /being wiped/);
    assert.match(String(res.body?.error), new RegExp(VICTIM));
  });

  it('R-X2e: a typed facts wipe refuses fact writes only; a deletion refuses every family, files included', async () => {
    await seedEndpoints(VICTIM);
    const entry = await seedActEntry(loader, { kind: 'wipe', localId: VICTIM, types: ['facts'] });
    assert.ok(gate.isSpaceNotWritable(await refused(WRITES.fact.run(VICTIM))), 'a facts wipe let a fact in');
    assert.equal(await refused(WRITES.entity.run(VICTIM)), null, 'a facts wipe refused an entity write it does not cover');
    assert.equal(await refused(writers.files.writeFile(VICTIM, 'typed.txt', 'x')), null, 'a facts wipe refused a file write it does not cover');
    assert.equal(gate.spaceWriteRefusal(VICTIM, 'files'), null, 'the gate reads a facts wipe as covering files');
    assert.ok(gate.spaceWriteRefusal(VICTIM, 'facts'), 'the gate does not refuse the family a facts wipe covers');
    loader.mutateConfig(cfg => { cfg.pendingSpaceActs = cfg.pendingSpaceActs.filter(e => e.id !== entry.id); });
    await seedActEntry(loader, { kind: 'delete', localId: VICTIM });
    for (const [name, w] of Object.entries(WRITES)) assert.ok(gate.isSpaceNotWritable(await refused(w.run(VICTIM))), `a deletion let the ${name} writer in`);
    assert.ok(gate.isSpaceNotWritable(await refused(writers.files.writeFile(VICTIM, 'deleted.txt', 'x'))), 'a deletion let a file write in');
  });

  it('R-X2f: a token without the write rung gets the rung\'s 403, never the closure\'s 409 (the closure is checked after the rungs)', async () => {
    await seedEndpoints(VICTIM);
    await seedActEntry(loader, { kind: 'wipe', localId: VICTIM });
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    const readOnly = { perSpace: { [VICTIM]: Object.fromEntries(SPACE_AREAS.map(a => [a, 'read'])) }, floor: {} };
    const edgeArgs = { space: VICTIM, from: A, to: B, label: 'knows' };
    const denied = await door.call('save_edge', edgeArgs, { rights: readOnly, transport: 'mcp' });
    assert.equal(denied.status, 403, `a read-only token was answered ${denied.status}: ${denied.text}`);
    assert.doesNotMatch(denied.text, /being wiped|takes no writes/i, 'the rung\'s refusal told a read-only token that a wipe runs');
    // The same row's positive half, red on the base: a token WITH the right meets the closure.
    const allowed = await door.call('save_edge', edgeArgs, { transport: 'mcp' });
    assert.equal(allowed.status, 409, `the token with the right was answered ${allowed.status}: ${allowed.text}`);
  });

  it('R-X2g: a peer\'s push of a space with a standing act is answered 423 space_held (never 409), on the door\'s look and in the admitted-then-registered race', async () => {
    await seedActEntry(loader, { kind: 'wipe', localId: VICTIM });
    const peer = peerToken('push-door-peer');
    const first = await door.push('/batch-upsert', { facts: [build.fact(VICTIM, 'cccccccc-0000-4000-8000-0000000c0003', 1)] }, { spaceId: VICTIM, token: peer });
    assert.equal(first.code, 423, `a peer push of a held space was answered ${first.code}: ${JSON.stringify(first.body)}`);
    assert.equal(first.body?.code, 'space_held');
    assert.equal(await door.coll(VICTIM, 'facts').countDocuments({}), 0, 'a peer push landed in a held space');

    // The race: the door's look finds no act, the push is parked at its first family's store write, the act registers, and the push goes on to its
    // NEXT write unit (the door admits at most one chunk of a family, so the next unit is the next family's `writeArrivals` call).
    clearActEntries(loader);
    const { REPLICATED_FAMILIES } = await import('../../server/dist/sync/replicated-families.js');
    assert.deepEqual(REPLICATED_FAMILIES.slice(0, 2).map(f => f.payloadKey), ['facts', 'entities'], 'the replicated families no longer start facts, entities: re-anchor this row');
    const proto = Object.getPrototypeOf(door.mongo.col('probe'));
    const park = parkWrites(proto);
    try {
      const gateAt = park.arm(`${VICTIM}_facts`);
      const answered = door.push('/batch-upsert', { facts: [build.fact(VICTIM, 'cccccccc-0000-4000-8000-0000000c0004', 1)],
        entities: [build.entity(VICTIM, 'cccccccc-0000-4000-8000-0000000c0005', 2)] }, { spaceId: VICTIM, token: peer });
      await gateAt.reached;
      await seedActEntry(loader, { kind: 'wipe', localId: VICTIM, state: 'registered' });
      gateAt.release();
      const r = await answered;
      assert.notEqual(r.code, 409, 'a peer meeting the closure in the race was answered 409 (a member failure on the sender)');
      assert.equal(r.code, 423, `the raced peer push was answered ${r.code}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body?.code, 'space_held');
      assert.equal(await door.coll(VICTIM, 'entities').countDocuments({}), 0, 'the unit after the registration landed in a space being wiped');
    } finally { park.restore(); }
  });

  it('R-X2 (the drain\'s count): a write unit is counted by the fence for its length and released when it ends or is refused — the drain waits for the unit in flight and no count leaks', async () => {
    const fence = await import('../../server/dist/sync/space-transfer-fence.js');
    assert.equal(typeof fence.spaceTransfersRunning, 'function', 'sync/space-transfer-fence.ts has no spaceTransfersRunning (§3.3a)');
    const proto = Object.getPrototypeOf(door.mongo.col('probe'));
    const park = parkWrites(proto);
    try {
      const unit = park.arm(`${OTHER}_facts`);
      const writing = WRITES.fact.run(OTHER);
      await unit.reached;
      assert.ok(fence.spaceTransfersRunning(OTHER) >= 1, 'a write unit in flight is not counted: the drain would not wait for it');
      unit.release();
      await writing;
      assert.equal(fence.spaceTransfersRunning(OTHER), 0, 'a finished write unit left its count behind');
    } finally { park.restore(); }
    await seedActEntry(loader, { kind: 'wipe', localId: VICTIM });
    assert.ok(gate.isSpaceNotWritable(await refused(WRITES.fact.run(VICTIM))));
    assert.equal(fence.spaceTransfersRunning(VICTIM), 0, 'a refused write left a count behind (a leak would hold every later drain)');
  });

  it('R-X2g: refusePeerWrite answers a peer token 423 space_held and an instance-admin token 409, from the writer\'s typed refusal', async () => {
    const shared = await import('../../server/dist/api/sync/_shared.js');
    assert.equal(typeof shared.refusePeerWrite, 'function', 'api/sync/_shared.ts has no refusePeerWrite (§2.6b)');
    const err = new gate.SpaceNotWritableError(VICTIM, 'it is being wiped');
    const asked = (token) => { const res = { code: 0, body: undefined, setHeader() { return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
      const handled = shared.refusePeerWrite(res, err, token); return { res, handled }; };
    const peer = asked(peerToken('push-door-peer'));
    assert.equal(peer.res.code, 423); assert.equal(peer.res.body?.code, 'space_held');
    const admin = asked(ADMIN_TOKEN);
    assert.equal(admin.res.code, 409, 'an instance-admin token is the operator\'s own tooling and gets the 409');
  });
});
