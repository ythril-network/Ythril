/**
 * A type renamed by a vote on a network keeps the old type in the schema and moves the records to the new one, on every member (Q-745, Q-746;
 * bundle-284 design r5 section 4.2, owner's answer O4: a network's type is handled like a delete vote, which never removes a type).
 *
 * ## The rule
 *
 * A network never removes a type: a `meta_change` round merges per type name, so a type the change does not carry is kept. A `renameType` step
 * therefore adds the target type to the schema and leaves the source where it is; the records move when the round passes, on each member, by the
 * run the round starts (the run reaches the source type as well as the target). After it, no record is of the old type, the old type is still
 * declared and still accepts a write, and both instances hold the same records.
 *
 * ## The setup
 *
 * A organises a club carrying one space; A's own definitions declare `person` with `fullName`; B joins by invite and holds the space. A writes three
 * entities of type `person`, B receives them, and A saves a definition of a new type `human` (the same property) with
 * `renameType` from `person` to `human`. The organiser's own yes passes the round on A at once, so A's run moves its copies before B has heard of the
 * round; the test reads A's finished run and only then lets B sync, so B's copies arrive already moved (the same fixed order as
 * `a-conversion-carried-by-a-vote-converges-on-every-member`, whose header says why a club).
 *
 * ## What is asserted, on BOTH instances, and what each defect would turn red
 *
 * 1. **The run names both types** (`entity:person` and `entity:human`) on A and on B, and B applied the step (none refused). Red when a type step's
 *    source is not reached (the records of `person` would stay), or a member refuses a step that belongs to the round.
 * 2. **The records moved**: each of the three is type `human` on both instances with its properties unchanged and the same id, at a newer version
 *    that is the one A's conversion gave it (no second rewrite on B), and no entity of type `person` is left on either. Red when a member leaves the
 *    old type, when the move drops or changes a property, or when it is made twice.
 * 3. **The old type is kept**: A's schema still declares `person` beside `human`, and a new entity of type `person` written on A afterwards is
 *    accepted and stays of that type. Red when a round or a run removes the source type from the schema.
 * 4. **No fork, no unconverted item and one Merkle root.** Red when two instances' views of one record diverge.
 *
 * Run: node --test testing/sync/a-type-renamed-on-a-network-keeps-the-old-type-and-moves-the-records.test.js
 * (needs the test stack: `npm run test:up`; the stack is built from the tree under test)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { INSTANCES, patch, createTestSpace, syncUntil } from './helpers.js';
import {
  tokenOf, entityType, text, setOwnSchema, writeEntities, recordOn, holdsAll, metaOn, conversionOf, runEnds, runEndsHere, forksIn, rootOn, itemsOf,
  entitiesOfType, joinedClub,
} from './_schema-convert-pair.mjs';

const RUN = Date.now();
const A = INSTANCES.a;
const B = INSTANCES.b;

const BEFORE = entityType('person', { fullName: text() });
const AFTER = entityType('human', { fullName: text() });
const STEPS = [{ op: 'renameType', kind: 'entity', from: 'person', to: 'human' }];
const NAMES = ['ada', 'bo', 'cy'];
const ROWS = NAMES.map(n => ({ name: `${n} ${RUN}`, type: 'person', properties: { fullName: n } }));

let tA, tB, space, club, SPACE;
let ids = [];
/** id -> what A held after A's run was complete, before B had heard of the round. */
const convertedOnA = {};
/** id -> the version both held before the conversion. */
const before_ = {};

before(async () => {
  tA = tokenOf('a');
  tB = tokenOf('b');
  space = await createTestSpace('cvtype', [[A, tA]]);
  SPACE = space.id;
  await setOwnSchema(A, tA, SPACE, BEFORE);
  club = await joinedClub({ label: `cvtype-${RUN}`, space: SPACE });
  ids = await writeEntities(A, tA, SPACE, ROWS);
  await syncUntil(B, tB, club.networkId, () => holdsAll(B, tB, SPACE, ids), 'B to hold the three records A wrote', { timeoutMs: 90_000 });
  for (const id of ids) before_[id] = await recordOn(B, tB, SPACE, id);
});

after(async () => {
  await club?.remove();
  await space?.remove();
});

const typesOf = (run) => run.types.map(t => `${t.kind}:${t.type}`).sort();

describe('a type renamed on a network keeps the old type and moves the records', () => {
  it('A saves the new type with the step: A\'s run reaches the source type as well as the target and moves A\'s copies', async () => {
    const r = await patch(A, tA, `/api/spaces/${SPACE}`, { meta: AFTER, convertRecords: { steps: STEPS } });
    assert.equal(r.status, 200, `the save on the organiser: ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.convert?.state, 'started', `the save did not start a run: ${JSON.stringify(r.body.convert)}`);
    assert.deepEqual(r.body.convert.types.map(t => `${t.kind}:${t.type}`).sort(), ['entity:human', 'entity:person'], 'the save names the source and the target type');
    const run = await runEndsHere({ base: A, token: tA, space: SPACE, who: 'A' });
    assert.deepEqual(typesOf(run), ['entity:human', 'entity:person']);
    assert.equal(run.counts.rewritten, ids.length, `A moved the copies of the old type: ${JSON.stringify(run.counts)}`);
    assert.equal(run.counts.unconverted, 0);
    for (const id of ids) convertedOnA[id] = await recordOn(A, tA, SPACE, id);
  });

  it('B hears of the passed round at its next sync and applies the step; its copies arrive moved', async () => {
    const run = await runEnds({ base: B, token: tB, networkId: club.networkId, space: SPACE, who: 'B' });
    assert.deepEqual(run.steps, STEPS, 'B applied the step the proposer signed');
    assert.deepEqual(run.stepsRefused, [], `B refused the step: ${JSON.stringify(run.stepsRefused)}`);
    assert.deepEqual(typesOf(run), ['entity:human', 'entity:person'], 'B\'s run reaches the source type too');
    assert.equal(run.counts.rewritten, 0, `B moved copies A had already moved: ${JSON.stringify(run.counts)}`);
    assert.equal(run.counts.unconverted, 0);
  });

  it('after one more sync the two instances report one root for the space', async () => {
    let rootA, rootB;
    await syncUntil(A, tA, club.networkId, async () => {
      [rootA, rootB] = [await rootOn(A, tA, SPACE), await rootOn(B, tB, SPACE)];
      return rootA !== undefined && rootA === rootB;
    }, 'A and B to report one Merkle root for the space', { timeoutMs: 90_000, onTimeout: () => `A ${rootA}, B ${rootB}` });
  });

  it('every record is of the new type on both instances, at the version A gave it, with its properties and id unchanged', async () => {
    for (const [i, id] of ids.entries()) {
      for (const [who, base, token] of [['A', A, tA], ['B', B, tB]]) {
        const held = await recordOn(base, token, SPACE, id);
        assert.equal(held.type, 'human', `${who} holds ${NAMES[i]} as type ${held.type}: the type step was not applied`);
        assert.deepEqual(held.properties, { fullName: NAMES[i] }, `${who}: the move changed the properties of ${NAMES[i]}`);
        assert.equal(held.seq, convertedOnA[id].seq, `${who} holds ${NAMES[i]} at version ${held.seq}, not the one A's move gave it (${convertedOnA[id].seq})`);
        assert.ok(held.seq > before_[id].seq, `${who}: the move took no newer version`);
        assert.equal(held.forkOf, undefined, `${who} holds ${NAMES[i]} as a fork`);
      }
    }
    for (const [who, base, token] of [['A', A, tA], ['B', B, tB]]) {
      assert.deepEqual((await entitiesOfType(base, token, SPACE, 'person')).map(e => e._id), [], `${who} still holds entities of the old type`);
      assert.deepEqual((await entitiesOfType(base, token, SPACE, 'human')).map(e => e._id).sort(), [...ids].sort(), `${who} does not hold exactly the moved records`);
    }
  });

  it('the old type is kept: A\'s schema declares both types and still accepts a new entity of the old one', async () => {
    const declared = (await metaOn(A, tA, SPACE)).typeSchemas?.entity ?? {};
    assert.ok(declared.person, 'the round or the run removed the source type from A\'s schema');
    assert.ok(declared.human, 'the new type is not in A\'s schema');
    const [id] = await writeEntities(A, tA, SPACE, [{ name: `later ${RUN}`, type: 'person', properties: { fullName: 'later' } }]);
    assert.equal((await recordOn(A, tA, SPACE, id)).type, 'person', 'a write of the kept type changed its type');
  });

  it('B\'s schema declares the new type and no run left a record behind', async () => {
    assert.ok((await metaOn(B, tB, SPACE)).typeSchemas?.entity?.human, 'the new type did not reach B\'s schema');
    for (const [who, base, token] of [['A', A, tA], ['B', B, tB]]) {
      assert.deepEqual(await itemsOf(base, token, SPACE), [], `${who} lists a record it could not move`);
      assert.equal((await conversionOf(base, token, SPACE)).state, 'complete');
    }
  });

  it('no fork on either instance', async () => {
    for (const [who, base, token] of [['A', A, tA], ['B', B, tB]]) {
      assert.equal(await forksIn(base, token, SPACE), 0, `${who} holds a fork`);
    }
  });
});
