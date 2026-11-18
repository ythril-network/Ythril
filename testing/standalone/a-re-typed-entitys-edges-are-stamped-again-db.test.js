/**
 * The edges of an entity a conversion re-types are stamped again when they conform, without a new version (Q-746, bundle-284 design r5 section
 * 5.3 step 6, finding S11).
 *
 * ## The rule
 *
 * A rewrite that changes an entity's type takes the stamp off every edge at that entity (the endpoint rule reads the ends' types,
 * `retyped-entity-edges.ts`). The converter then classifies each of those edges again against the schema now and stamps the ones that conform
 * quietly: they carry the run's fingerprint, and their version, position and `updatedAt` do not move. An edge that does not conform stays
 * unstamped. The run counts them as `edgesRestamped`.
 *
 * ## What was wrong
 *
 * r3 re-typed the entities and left every edge at them unstamped: a schema conversion made the space's edges look unconverted (S11).
 *
 * Seen red on 14af4644: the run module is not built.
 *
 * Run: node --test testing/standalone/a-re-typed-entitys-edges-are-stamped-again-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openConvertDoor, CONVERT_META, SEEDED_AT } from './_schema-convert.mjs';
import { waitForValue } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
const S = 'retyped';
const RETYPE = { op: 'renameType', kind: 'entity', from: 'person', to: 'human' };
/** Before: `person`, and `org` for the far end, which no step touches (so each edge is re-typed at one end, once). */
const BEFORE = structuredClone(CONVERT_META);
BEFORE.typeSchemas.entity.org = {};
const AFTER = structuredClone(BEFORE);
AFTER.typeSchemas.entity.human = structuredClone(AFTER.typeSchemas.entity.person);

describe('a re-typed entity\'s edges are stamped again (real MongoDB)', { skip }, () => {
  let door, run, edgeIdFor;
  before(async () => {
    door = await openConvertDoor({ name: 'b284retyped', spaces: [S], metaOf: () => BEFORE });
    run = await door.runModule();
    ({ edgeIdFor } = await import('../../server/dist/brain/edge-id.js'));
  });
  after(async () => { run?.stopSchemaConvertWatcher(); await door?.close(); });

  it('an entity renameType: its conforming edges carry the run\'s fingerprint after the run, with no version move', async () => {
    const oldFp = door.fp(S);
    await door.seed(S, 'entities', [
      { _id: 'a', name: 'A', type: 'person', properties: { age: 1 }, schemaFingerprint: oldFp },
      { _id: 'b', name: 'B', type: 'org', properties: {}, schemaFingerprint: oldFp },
    ]);
    const good = { _id: edgeIdFor('a', 'b', 'knows'), from: 'a', to: 'b', label: 'knows', properties: { since: 2020 }, schemaFingerprint: oldFp };
    const bad = { _id: edgeIdFor('b', 'a', 'knows'), from: 'b', to: 'a', label: 'knows', properties: { since: 'long ago' }, schemaFingerprint: oldFp };
    const seededEdges = await door.seed(S, 'edges', [good, bad]);
    door.setMeta(S, AFTER);
    const toFp = door.fp(S);

    const started = await run.startSchemaConvertRun({ spaceId: S, types: [{ kind: 'entity', type: 'person' }], steps: [RETYPE], source: { kind: 'act' } });
    assert.equal(started.ok, true, JSON.stringify(started));
    const done = await waitForValue(async () => { const d = await door.runDoc(S); return d?.state === 'complete' ? d : null; },
      20_000, 100, undefined, { what: 'the run to complete' });

    assert.equal((await door.coll(S, 'entities').findOne({ _id: 'a' })).type, 'human', 'precondition: the entity was re-typed');
    const g = await door.coll(S, 'edges').findOne({ _id: good._id });
    const g0 = seededEdges.find(e => e._id === good._id);
    assert.equal(g.schemaFingerprint, toFp, 'a conforming edge of a re-typed entity was left unstamped');
    assert.equal(g.seq, g0.seq, 'the edge\'s version moved');
    assert.equal(g.pos, g0.pos, 'the edge\'s position moved');
    assert.equal(g.updatedAt, SEEDED_AT);
    const b = await door.coll(S, 'edges').findOne({ _id: bad._id });
    assert.equal(b.schemaFingerprint, undefined, 'an edge that does not conform keeps no stamp');
    assert.equal(done.counts.edgesRestamped, 1);
  });
});
