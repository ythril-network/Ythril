/**
 * A schema save that carries `convertRecords` STARTS the conversion run on this instance, after the schema is stored, and says so on the
 * answer (`Q-745`, `Q-746`, bundle-284 design r5 sections 2.2, 4.1 and 5.1).
 *
 * ## What it prevents
 *
 * Slice 5a made both doors take and check the steps, and slice 2 built the run, but nothing connected them: a save with `convertRecords` was
 * accepted and converted nothing, and the caller was told nothing either way. The run must start from the save itself, with the types
 * `typesToConvert` names (the changed types, the dropped ones on a space in no network, the sources of type steps), and only once the schema
 * it converts toward is the one stored: a run started before the store would carry the OLD fingerprint and restart at once, and one started
 * for a refused save would rewrite records toward a schema that never landed. A run that cannot be started must not undo the save that
 * already landed: the answer says so instead.
 *
 * ## What holds
 *
 * - `PATCH /api/spaces/:id` and MCP `schema_update` with `convertRecords` on a space in no network each start ONE run: source kind `write`,
 *   the checked steps, the types `typesToConvert` gives, and `toFp` the fingerprint of the schema as stored by the save;
 * - both answer `convert: { state: 'started', types, toFp }`, the same shape on both doors;
 * - a refused save starts no run, and a save without `convertRecords` starts none and answers no `convert`;
 * - a run the store refuses to start leaves the saved schema in place, and the answer says `convert.state: 'not_started'` with the reason;
 * - a networked save whose round is still open starts nothing here and answers `convert.state: 'after_vote'`.
 *
 * Run: node --test testing/standalone/a-schema-change-with-convert-starts-a-run-db.test.js
 * (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir, callRoute } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';
import { P1 } from './_vote-round-sites.mjs';
import { waitForValue } from '../_shared/wait-for.mjs';

const dir = tempInstanceDir('ythril-save-starts-run-');
const skip = await mongoSkipReason();
const SPACE = 'people';
const NET = '22222222-2222-4222-8222-222222222222';
const RIGHTS = { instanceAdmin: true, perSpace: {} };
const string = { type: 'string' };

const PERSON_BEFORE = { propertySchemas: { fullName: string, status: { type: 'string', enum: ['a', 'b'] } } };
const PERSON_AFTER = { propertySchemas: { name: string, status: { type: 'string', enum: ['x', 'y'] } } };
const STEPS = {
  steps: [
    { op: 'renameProperty', kind: 'entity', type: 'Person', from: 'fullName', to: 'name' },
    { op: 'mapEnum', kind: 'entity', type: 'Person', property: 'status', values: { a: 'x', b: 'y' } },
  ],
};
const BAD_ENUM = { steps: [STEPS.steps[0], { ...STEPS.steps[1], values: { a: 'x', b: 'not-in-the-schema' } }] };
const EDIT = { typeSchemas: { entity: { Person: PERSON_AFTER } } };

describe('a schema change with convertRecords starts a run', { skip }, () => {
  let inst, mongo, run, stamp, spaceCollection;
  let doors;
  before(async () => {
    mongo = await openTestMongo('save_starts_run');
    inst = await bootSchemaInstance(dir, {
      spaces: [
        { id: SPACE, label: 'People', folders: [], meta: { typeSchemas: { entity: { Person: PERSON_BEFORE } } } },
        { id: 'general', label: 'General', builtIn: true, folders: [] },
      ],
    });
    const { spacesRouter } = await import('../../server/dist/api/spaces.js');
    const tools = await import('../../server/dist/mcp/tools/spaces.js');
    run = await import('../../server/dist/spaces/schema-convert-run.js');
    stamp = await import('../../server/dist/spaces/schema-stamp.js');
    ({ spaceCollection } = await import('../../server/dist/db/space-collection.js'));
    const mcpCtx = (args) => ({ callSpace: SPACE, callSpaces: [SPACE], accessibleSpaceIds: [SPACE], viewReads: new Map(), args: { space: SPACE, ...args }, rights: RIGHTS });
    doors = {
      rest: async (convertRecords) => {
        const r = await callRoute(spacesRouter, 'patch', '/:id', { params: { id: SPACE }, body: { meta: EDIT, ...(convertRecords ? { convertRecords } : {}) }, authToken: { rights: RIGHTS } });
        return { status: r.code, body: r.body };
      },
      mcp: async (convertRecords) => {
        const r = await tools.schema_updateTool.handle(mcpCtx({ ...EDIT, ...(convertRecords ? { convertRecords } : {}) }));
        const text = (r.content ?? []).map(c => c.text ?? '').join('\n');
        const m = /Error \((\d{3})\)/.exec(text);
        return { status: r.isError ? Number(m?.[1] ?? 500) : 200, text, body: r.structuredContent };
      },
    };
  });
  after(async () => { run?.stopSchemaConvertWatcher(); inst?.close(); await closeTestMongo(); });

  const runs = () => mongo.getDb().collection(spaceCollection(SPACE, 'schemaConvertRun'));
  const runDoc = () => runs().findOne({ _id: 'run' });
  const fp = () => stamp.readMetaForWrite(SPACE).stamp.fp;
  const version = () => inst.heldMeta(SPACE).version ?? 0;
  /** What `typesToConvert` names for this edit on a space in no network: the changed type, and no type step's source. */
  const expectedTypes = () => run.typesToConvert({ changedTypes: ['entity:Person'], droppedTypes: [], inNetwork: false, steps: STEPS.steps })
    .map(t => ({ kind: t.kind, type: t.type }));

  beforeEach(async () => {
    run.stopSchemaConvertWatcher();
    inst.reset();
    inst.loader.getConfig().networks.splice(0);
    await runs().drop().catch(() => {});
  });

  for (const door of ['rest', 'mcp']) {
    const name = door === 'rest' ? 'PATCH /api/spaces/:id' : 'MCP schema_update';

    it(`${name}: a solo save with convertRecords starts one run after the schema is stored, and answers convert.state 'started'`, async () => {
      const fpBefore = fp();
      const a = await doors[door](STEPS);
      assert.equal(a.status, 200, JSON.stringify(a.body ?? a.text));
      const fpAfter = fp();
      assert.notEqual(fpAfter, fpBefore, 'precondition: the save moved the fingerprint');

      const doc = await waitForValue(runDoc, 5_000, 50, undefined, { what: 'the run document' });
      assert.deepEqual(doc.sources.map(s => ({ kind: s.kind, ...(s.roundId ? { roundId: s.roundId } : {}) })), [{ kind: 'write' }], JSON.stringify(doc.sources));
      assert.equal(doc.toFp, fpAfter, 'the run was started toward a schema other than the one the save stored');
      assert.deepEqual(doc.steps, STEPS.steps);
      assert.deepEqual(doc.types.map(t => ({ kind: t.kind, type: t.type })), expectedTypes());
      assert.equal(doc.owed, false, 'a save-started run is not owed: only a passed vote makes a run owed');
      assert.equal(doc.generation, 1, `the save started more than one run: generation ${doc.generation}`);

      assert.ok(a.body?.convert, `the answer says nothing of the run: ${JSON.stringify(a.body)}`);
      assert.deepEqual(a.body.convert, { state: 'started', types: expectedTypes(), toFp: fpAfter });
    });

    it(`${name}: a refused save starts no run`, async () => {
      const a = await doors[door](BAD_ENUM);
      assert.equal(a.status, 400);
      await new Promise(r => setTimeout(r, 300));
      assert.equal(await runDoc(), null, 'a refused save started a run');
    });

    it(`${name}: a save without convertRecords starts no run and answers no convert`, async () => {
      const a = await doors[door](undefined);
      assert.equal(a.status, 200, JSON.stringify(a.body ?? a.text));
      await new Promise(r => setTimeout(r, 300));
      assert.equal(await runDoc(), null, 'a save that chose no conversion started a run');
      assert.equal('convert' in (a.body ?? {}), false, `a save without convertRecords answered a convert: ${JSON.stringify(a.body)}`);
    });

    it(`${name}: a run the store refuses to start leaves the saved schema in place and says so`, async () => {
      // A collection whose validator refuses every document: the run document cannot be written, so the start fails after the save landed.
      await mongo.getDb().createCollection(spaceCollection(SPACE, 'schemaConvertRun'), { validator: { $expr: { $eq: [1, 0] } }, validationAction: 'error' });
      const v = version();
      const a = await doors[door](STEPS);
      assert.equal(a.status, 200, `a failed start failed the save: ${JSON.stringify(a.body ?? a.text)}`);
      assert.equal(version(), v + 1, 'the save was undone by the failed start');
      assert.ok(inst.heldTypes(SPACE).entity.Person.propertySchemas.name, 'the saved schema is not in place');
      assert.equal(await runDoc(), null);
      assert.equal(a.body?.convert?.state, 'not_started', `the answer does not say the run was not started: ${JSON.stringify(a.body)}`);
      assert.equal(typeof a.body.convert.error, 'string');
      assert.deepEqual(a.body.convert.types, expectedTypes());
    });

    it(`${name}: a networked save whose round is still open starts nothing here and answers convert.state 'after_vote'`, async () => {
      const signing = await import('../../server/dist/util/signing.js');
      signing.ensureInstanceKeypair();
      inst.loader.getConfig().networks.push({
        id: NET, label: 'Net', type: 'closed', origin: 'created', syncSchedule: '', spaces: [SPACE], votingDeadlineHours: 24,
        createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [],
        members: [{ instanceId: P1, label: 'peer', url: 'https://peer.example', tokenHash: 'h', direction: 'both' }],
      });
      const a = await doors[door](STEPS);
      assert.equal(a.status, door === 'rest' ? 202 : 200, JSON.stringify(a.body ?? a.text));
      assert.equal(a.body?.convert?.state, 'after_vote', `the answer does not say the run waits for the vote: ${JSON.stringify(a.body)}`);
      assert.deepEqual(a.body.convert.types, run.typesToConvert({ changedTypes: ['entity:Person'], droppedTypes: [], inNetwork: true, steps: STEPS.steps })
        .map(t => ({ kind: t.kind, type: t.type })));
      await new Promise(r => setTimeout(r, 300));
      assert.equal(await runDoc(), null, 'a save that only opened a vote started a run');
    });
  }
});
