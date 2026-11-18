/**
 * A schema change that carries conversion steps converts the records on EVERY member, and a copy one member already converted is not rewritten
 * again by the next (Q-745, Q-746; bundle-284 design r5 sections 4.1, 5.1 "Copies another member already converted", 5.3 step 0, amendment A2: owner,
 * 2026-11-18, "B but sync first so if another instance already converted its taken from there and be skipped").
 *
 * ## The rule
 *
 * A passed `meta_change` round that carries `convertRecords` starts a conversion run on each member that applies it. Each run reads every copy of the
 * changed type that its instance holds, whoever wrote it. A record the steps change is rewritten, a record that already fits is stamped in place with
 * no new version, and a run a vote started on a networked space asks each peer it pulls from for one sync before it reads its first page, so a copy
 * a peer already converted arrives converted and is only stamped. After the vote and a sync the two instances hold the same records, each of them
 * converted once, with no fork.
 *
 * ## The setup, and why the order of events is fixed
 *
 * A organises a club carrying one space; A's own definitions declare `person` with `fullName` and a `status` of `a` or `b`; B joins by invite and holds
 * the space. A writes four entities of type `person` (three the steps change, one that has neither property and so already fits any version of the
 * type) and B receives them. A then saves the new definition (`name`, `status` of `x` or `y`) with a `renameProperty` and a `mapEnum`.
 * A club's organiser decides a round by its own yes, so the round passes on A at once and A's run converts A's copies BEFORE B has heard of the round:
 * the test reads A's finished run and the versions it left, and only then lets B sync. B hears of the passed round as a member that never saw it open
 * (the organiser serves the passed round), applies it, and its run asks A for one sync first. What B holds when that run reads its first page is what
 * A converted, so B has nothing left to rewrite. The closed network's second yes passes the same round on a member by the same function; the club is
 * used because its order is fixed and a closed network's two members would convert at the same moment.
 *
 * ## What is asserted, on BOTH instances (each read through its own door), and what each defect would turn red
 *
 * 1. **A's own run**: the save answers `convert.state: 'started'`; A's run is `complete`, sourced from the round, with `rewritten` 3, `stamped` 1,
 *    `unconverted` 0. Red when a passed round starts no run on its proposer, or the steps are not the ones saved.
 * 2. **B's run**: `complete`, sourced from the round, holding the steps (none refused), having asked one peer (`syncedFirst.asked` 1), and
 *    `rewritten` 0. Red when a member does not start a run from a round it adopts, when it applies none of the steps it should, when its run does not
 *    sync first (it would read its unconverted copies and rewrite them: `rewritten` above 0), or when it rewrites what a peer already converted.
 * 3. **The records**: each of the three holds its converted properties (`name` and the mapped `status`, no `fullName`) on both instances; its
 *    version is the one A's conversion gave it, on both (B did not write it again, and nothing of B's travelled back and moved A's), and it is newer
 *    than before with a newer change date. Red when a member keeps the old shape, rewrites twice, or a copy diverges.
 * 4. **The record that already fitted** keeps its version, change date and position on both instances (a stamp is not an edit: nothing replicated),
 *    and carries each instance's own current fingerprint. Red when a stamp moves a version or a date, or is not applied.
 * 5. **No fork** on either instance, **no unconverted item** on either, and **one Merkle root** for the space (it covers every id and version).
 *    Red when two members' conversions of one record collide, or one record is left behind.
 *
 * ## What it cannot hold
 *
 * Which of two members converts first when both start at the same moment: nothing here makes that a race. `a-member-that-refuses-the-steps-takes-the-
 * schema-and-reviews-its-records` and `steps-a-relayer-adds-are-not-applied` run on a closed network, where the members do start together.
 *
 * Run: node --test testing/sync/a-conversion-carried-by-a-vote-converges-on-every-member.test.js
 * (needs the test stack: `npm run test:up`; the stack is built from the tree under test)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { INSTANCES, patch, createTestSpace, syncUntil } from './helpers.js';
import {
  tokenOf, entityType, text, oneOf, setOwnSchema, writeEntities, recordOn, holdsAll, fingerprintOn, conversionOf, runEnds, runEndsHere,
  forksIn, rootOn, itemsOf, joinedClub,
} from './_schema-convert-pair.mjs';

const RUN = Date.now();
const A = INSTANCES.a;
const B = INSTANCES.b;

const BEFORE = entityType('person', { fullName: text(), status: oneOf('a', 'b') });
const AFTER = entityType('person', { name: text(), status: oneOf('x', 'y') });
const STEPS = [
  { op: 'renameProperty', kind: 'entity', type: 'person', from: 'fullName', to: 'name' },
  { op: 'mapEnum', kind: 'entity', type: 'person', property: 'status', values: { a: 'x', b: 'y' } },
];
const ROWS = {
  ada: { name: `Ada ${RUN}`, type: 'person', properties: { fullName: 'Ada', status: 'a' } },
  bo: { name: `Bo ${RUN}`, type: 'person', properties: { fullName: 'Bo', status: 'b' } },
  cy: { name: `Cy ${RUN}`, type: 'person', properties: { fullName: 'Cy', status: 'a' } },
  plain: { name: `Plain ${RUN}`, type: 'person', properties: {} },
};
const CONVERTED = { ada: { name: 'Ada', status: 'x' }, bo: { name: 'Bo', status: 'y' }, cy: { name: 'Cy', status: 'x' } };
const REWRITTEN = Object.keys(CONVERTED);

let tA, tB, space, club, SPACE;
/** name -> id of each record A wrote. */
const ids = {};
/** name -> `{ a, b }`: what each instance held of the record after B received it and before the conversion. */
const before_ = {};
/** name -> what A held of the record when A's run was complete, before B had heard of the round. */
const convertedOnA = {};
let aRun, bRun;

before(async () => {
  tA = tokenOf('a');
  tB = tokenOf('b');
  space = await createTestSpace('cvvote', [[A, tA]]);
  SPACE = space.id;
  await setOwnSchema(A, tA, SPACE, BEFORE);
  club = await joinedClub({ label: `cvvote-${RUN}`, space: SPACE });
  const written = await writeEntities(A, tA, SPACE, Object.values(ROWS));
  Object.keys(ROWS).forEach((name, i) => { ids[name] = written[i]; });
  await syncUntil(B, tB, club.networkId, () => holdsAll(B, tB, SPACE, Object.values(ids)), 'B to hold the four records A wrote', { timeoutMs: 90_000 });
  for (const name of Object.keys(ROWS)) {
    before_[name] = { a: await recordOn(A, tA, SPACE, ids[name]), b: await recordOn(B, tB, SPACE, ids[name]) };
    assert.equal(before_[name].a.seq, before_[name].b.seq, `${name} is held at one version on both instances before the conversion`);
  }
});

after(async () => {
  await club?.remove();
  await space?.remove();
});

describe('a conversion carried by a vote converges on every member', () => {
  it('A saves the change with the steps: the organiser\'s own yes passes the round and A\'s run converts A\'s copies', async () => {
    const r = await patch(A, tA, `/api/spaces/${SPACE}`, { meta: AFTER, convertRecords: { steps: STEPS } });
    assert.equal(r.status, 200, `the save on the organiser: ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.convert?.state, 'started', `the save did not start a run on the instance whose yes passed the round: ${JSON.stringify(r.body.convert)}`);
    // A plain poll: a sync triggered from A here would let B hear of the round before A's conversion is finished.
    aRun = await runEndsHere({ base: A, token: tA, space: SPACE, who: 'A' });
    assert.deepEqual(aRun.steps, STEPS, 'A\'s run holds the steps that were saved');
    assert.deepEqual(aRun.stepsRefused, [], 'A refused none of its own steps');
    assert.equal(aRun.counts.rewritten, REWRITTEN.length, `A rewrote the copies the steps change: ${JSON.stringify(aRun.counts)}`);
    assert.equal(aRun.counts.stamped, 1, `A stamped the copy that already fitted: ${JSON.stringify(aRun.counts)}`);
    assert.equal(aRun.counts.unconverted, 0, 'A left nothing unconverted');
    for (const name of Object.keys(ROWS)) convertedOnA[name] = await recordOn(A, tA, SPACE, ids[name]);
  });

  it('B hears of the passed round at its next sync, and its run converts nothing a peer already converted', async () => {
    bRun = await runEnds({ base: B, token: tB, networkId: club.networkId, space: SPACE, who: 'B' });
    assert.deepEqual(bRun.steps, STEPS, 'B applied the steps the proposer signed');
    assert.deepEqual(bRun.stepsRefused, [], `B refused steps it should have applied: ${JSON.stringify(bRun.stepsRefused)}`);
    assert.equal(bRun.syncedFirst?.asked, 1, `B's run did not ask its one peer for a sync before it read: ${JSON.stringify(bRun.syncedFirst)}`);
    assert.equal(bRun.counts.rewritten, 0, `B rewrote copies A had already converted: ${JSON.stringify(bRun.counts)}`);
    assert.equal(bRun.counts.unconverted, 0, 'B left nothing unconverted');
    assert.ok(bRun.counts.stamped >= 1, `B did not stamp the copy that already fitted: ${JSON.stringify(bRun.counts)}`);
  });

  it('after one more sync the two instances report one root for the space', async () => {
    let rootA, rootB;
    await syncUntil(A, tA, club.networkId, async () => {
      [rootA, rootB] = [await rootOn(A, tA, SPACE), await rootOn(B, tB, SPACE)];
      return rootA !== undefined && rootA === rootB;
    }, 'A and B to report one Merkle root for the space', { timeoutMs: 90_000, onTimeout: () => `A ${rootA}, B ${rootB}` });
  });

  for (const name of REWRITTEN) {
    it(`${name}: both instances hold the converted record, at the version A's conversion gave it`, async () => {
      assert.ok(convertedOnA[name], 'A\'s conversion was read by the first case');
      const [onA, onB] = [await recordOn(A, tA, SPACE, ids[name]), await recordOn(B, tB, SPACE, ids[name])];
      for (const [who, held] of [['A', onA], ['B', onB]]) {
        assert.deepEqual(held.properties, CONVERTED[name], `${who} holds ${name} as ${JSON.stringify(held.properties)}: the steps were not applied`);
        assert.equal(held.type, 'person');
        assert.equal(held.seq, convertedOnA[name].seq, `${who} holds ${name} at version ${held.seq}, not the one A's conversion gave it (${convertedOnA[name].seq}): it was rewritten again`);
        assert.ok(held.seq > before_[name].a.seq, `${who}: the rewrite did not take a newer version`);
        assert.ok(held.updatedAt > before_[name].a.updatedAt, `${who}: a rewrite moves the change date`);
        assert.equal(held.forkOf, undefined, `${who} holds ${name} as a fork`);
      }
    });
  }

  it('the record that already fitted keeps its version and change date on both, and carries each instance\'s own fingerprint', async () => {
    const [fpA, fpB] = [await fingerprintOn(A, tA, SPACE), await fingerprintOn(B, tB, SPACE)];
    const [onA, onB] = [await recordOn(A, tA, SPACE, ids.plain), await recordOn(B, tB, SPACE, ids.plain)];
    for (const [who, held, fp] of [['A', onA, fpA], ['B', onB, fpB]]) {
      assert.equal(held.seq, before_.plain.a.seq, `${who}: a stamp moved the version of a record that needed no rewrite`);
      assert.equal(held.updatedAt, before_.plain.a.updatedAt, `${who}: a stamp moved the change date`);
      assert.deepEqual(held.properties, {});
      assert.equal(held.stamp, fp, `${who} did not stamp the record with the fingerprint it runs on`);
    }
  });

  it('each rewritten record carries the fingerprint of the instance that holds it', async () => {
    const [fpA, fpB] = [await fingerprintOn(A, tA, SPACE), await fingerprintOn(B, tB, SPACE)];
    for (const name of REWRITTEN) {
      assert.equal((await recordOn(A, tA, SPACE, ids[name])).stamp, fpA, `A's copy of ${name} carries another fingerprint than A runs on`);
      assert.equal((await recordOn(B, tB, SPACE, ids[name])).stamp, fpB, `B's copy of ${name} carries another fingerprint than B runs on`);
    }
  });

  it('no fork and no unconverted item on either instance', async () => {
    for (const [who, base, token] of [['A', A, tA], ['B', B, tB]]) {
      assert.equal(await forksIn(base, token, SPACE), 0, `${who} holds a fork: two members' conversions of one record collided`);
      assert.deepEqual(await itemsOf(base, token, SPACE), [], `${who} lists a record it could not convert`);
      assert.equal((await conversionOf(base, token, SPACE)).state, 'complete');
    }
  });
});
