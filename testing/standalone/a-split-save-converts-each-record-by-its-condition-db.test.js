/**
 * A schema save that declares a `splitType` converts each record of the split type by the first condition that is true for it, through the real
 * `PATCH /api/spaces/:id` and the real `schema_update` tool (Q-745, Q-746; bundle-284 design r5 sections 1.2, 1.4, 5.3).
 *
 * This is a CHARACTERISATION test: the feature is built, and the test was written green against it. It exists because the pure tests judge a split
 * on a fake judge and the act's door test only refuses one, so no test saved a split through a door and saw it convert records, while the
 * integration guide (`06e-converting-records.md`, "Split a type") documents exactly that request.
 *
 * ## The request, as the page shows it
 *
 * `{ meta: { typeSchemas: { entity: { <target>: ... } } }, convertRecords: { steps: [{ op: 'splitType', kind: 'entity', from: 'person', cases: [...],
 * otherwise? }] } }` on `PATCH /api/spaces/:id` (the mounted application, as a client calls it), and the same fields as the arguments of `schema_update`
 * (dispatched through `callTool`). The save adds two target types (`activePerson`, `urgentPerson`) and leaves `person` declared; its two cases read
 * `self.properties.status == "open"` and `self.properties.priority == "high"`.
 *
 * ## The fixtures, each saved once per door (so four spaces)
 *
 * Five entities of type `person`: `open` (status open), `both` (status open and priority high: both conditions are true), `urgent` (status done,
 * priority high), `done` (status done, no priority) and `bare` (no properties at all). With `otherwise: 'person'` (the page's shape) and without
 * `otherwise` (a second fixture).
 *
 * ## What is asserted, and which defect turns each group red
 *
 * 1. **The answer, alike on both doors**: `convert.state` is `started`, `convert.types` names the source and both targets, `toFp` is the fingerprint
 *    the saved schema has. Red when a save with a split starts no run, names a type short (the source of a split is not reached), or one door answers
 *    another shape.
 * 2. **Each record lands where its first true condition says**: `open` and `both` are `activePerson` (a record for which both conditions are true goes
 *    to the first), `urgent` is `urgentPerson`, with properties unchanged, the run's fingerprint, a newer version and a newer change date. Red when the
 *    cases are read in another order, the last true case wins, a rewrite drops or changes a property, or a rewritten record is not stamped.
 * 3. **`otherwise`** (first fixture): `done` and `bare` stay `person`, are stamped in place and keep version and change date. Red when `otherwise` moves
 *    a record that need not move, or is applied as a rewrite.
 * 4. **A condition that reads a property the record lacks is false**: `bare` has neither property and `done` has no `priority`; neither raises, neither
 *    is listed, both fall through to `otherwise`. Red when an absent property is an error, or makes the record unconvertible.
 * 5. **No `otherwise`** (second fixture): `done` and `bare` are untouched (type, properties, version, no stamp) and each is an open item with the reason
 *    `no_case_matched`; the run counts them `unconverted` and still converts the other three. Red when an unmatched record is moved, stamped, dropped, or
 *    stops the run.
 *
 * Run: node --test testing/standalone/a-split-save-converts-each-record-by-its-condition-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openB81cDoor } from './_b81c-door.mjs';
import { waitForValue } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
const SEEDED_AT = '2026-01-01T00:00:00.000Z';
const string = { type: 'string' };

const BEFORE = {
  validationMode: 'strict',
  suppressEmbeddings: true,
  typeSchemas: { entity: { person: { propertySchemas: { status: string, priority: string } } } },
};
const TARGET = { propertySchemas: { status: string, priority: string } };
const EDIT = { typeSchemas: { entity: { activePerson: TARGET, urgentPerson: TARGET } } };
const CASES = [
  { when: 'self.properties.status == "open"', to: 'activePerson' },
  { when: 'self.properties.priority == "high"', to: 'urgentPerson' },
];
const SPLIT = { op: 'splitType', kind: 'entity', from: 'person', cases: CASES };
const WITH_OTHERWISE = { steps: [{ ...SPLIT, otherwise: 'person' }] };
const WITHOUT_OTHERWISE = { steps: [SPLIT] };

const ROWS = {
  open: { type: 'person', properties: { status: 'open' } },
  both: { type: 'person', properties: { status: 'open', priority: 'high' } },
  urgent: { type: 'person', properties: { status: 'done', priority: 'high' } },
  done: { type: 'person', properties: { status: 'done' } },
  bare: { type: 'person', properties: {} },
};
const MOVES = { open: 'activePerson', both: 'activePerson', urgent: 'urgentPerson' };
const EXPECTED_TYPES = [
  { kind: 'entity', type: 'activePerson' }, { kind: 'entity', type: 'person' }, { kind: 'entity', type: 'urgentPerson' },
];

/** One fixture per door and per form of the split: the door that saves it, the space it saves to and the steps it declares. */
const FIXTURES = [
  { door: 'rest', space: 'split-rest-with', convertRecords: WITH_OTHERWISE, otherwise: true },
  { door: 'mcp', space: 'split-mcp-with', convertRecords: WITH_OTHERWISE, otherwise: true },
  { door: 'rest', space: 'split-rest-without', convertRecords: WITHOUT_OTHERWISE, otherwise: false },
  { door: 'mcp', space: 'split-mcp-without', convertRecords: WITHOUT_OTHERWISE, otherwise: false },
];

describe('a split saved through a door converts each record by its condition (real MongoDB)', { skip }, () => {
  let door, run, stamp, spaceCollection, updateSpace;
  /** space -> { answer, seeded: name -> the row as seeded, ids: name -> id, fp, runDoc }. */
  const held = {};

  before(async () => {
    door = await openB81cDoor({ name: 'b284split', spaces: FIXTURES.map(f => f.space), app: true });
    run = await import('../../server/dist/spaces/schema-convert-run.js');
    stamp = await import('../../server/dist/spaces/schema-stamp.js');
    ({ spaceCollection } = await import('../../server/dist/db/space-collection.js'));
    ({ updateSpace } = await import('../../server/dist/spaces/spaces.js'));
    let seq = 100;
    for (const f of FIXTURES) {
      assert.ok(updateSpace(f.space, { meta: structuredClone(BEFORE) }), `updateSpace did not find ${f.space}`);
      const seeded = {};
      const docs = Object.entries(ROWS).map(([name, row]) => {
        seq += 1;
        const doc = { _id: `${f.space}-${name}`, spaceId: f.space, name, tags: [], createdAt: SEEDED_AT, updatedAt: SEEDED_AT, seq, pos: seq, posAtSeq: seq, ...structuredClone(row) };
        seeded[name] = doc;
        return doc;
      });
      await door.coll(f.space, 'entities').insertMany(docs);
      await door.setCounter(f.space, seq + 1_000);
      const answer = f.door === 'rest'
        ? await door.rest('PATCH', `/api/spaces/${f.space}`, { meta: EDIT, convertRecords: f.convertRecords })
        : await door.mcp('schema_update', { space: f.space, ...EDIT, convertRecords: f.convertRecords });
      const fp = stamp.readMetaForWrite(f.space).stamp.fp;
      const runDoc = await waitForValue(async () => {
        const d = await door.mongo.col(spaceCollection(f.space, 'schemaConvertRun')).findOne({ _id: 'run' });
        return d && d.state !== 'running' ? d : null;
      }, 30_000, 100, undefined, { what: `the conversion run of ${f.space} to end` });
      held[f.space] = { answer, seeded, fp, runDoc };
    }
  });

  after(async () => { run?.stopSchemaConvertWatcher(); await door?.close(); });

  const row = (space, name) => door.coll(space, 'entities').findOne({ _id: `${space}-${name}` });
  const items = (space) => door.mongo.col(spaceCollection(space, 'schemaConvertItems')).find({}).toArray();

  for (const f of FIXTURES) {
    const name = f.door === 'rest' ? 'PATCH /api/spaces/:id' : 'MCP schema_update';
    describe(`${name}, split ${f.otherwise ? 'with' : 'without'} otherwise`, () => {
      it('answers convert.state started with the source and both target types, and the saved schema\'s fingerprint', () => {
        const { answer, fp } = held[f.space];
        assert.equal(answer.status, 200, JSON.stringify(answer.body ?? answer.text));
        assert.deepEqual(answer.body?.convert, { state: 'started', types: EXPECTED_TYPES, toFp: fp }, JSON.stringify(answer.body?.convert));
      });

      it('runs once, from the save, with the declared split, and ends complete', () => {
        const { runDoc, fp } = held[f.space];
        assert.equal(runDoc.state, 'complete', JSON.stringify(runDoc));
        assert.equal(runDoc.toFp, fp);
        assert.deepEqual(runDoc.steps, f.convertRecords.steps);
        assert.deepEqual(runDoc.sources.map(s => s.kind), ['write']);
        assert.equal(runDoc.counts.rewritten, 3, JSON.stringify(runDoc.counts));
      });

      for (const [record, target] of Object.entries(MOVES)) {
        it(`${record}: lands in ${target} by its first true condition, with its properties, the run's stamp and a newer version`, async () => {
          const { seeded, fp } = held[f.space];
          const after = await row(f.space, record);
          assert.equal(after.type, target, `${record} is of type ${after.type}`);
          assert.deepEqual(after.properties, ROWS[record].properties, 'a split changes the type and no property');
          assert.equal(after.schemaFingerprint, fp, 'a rewritten record carries the run\'s fingerprint');
          assert.ok(after.seq > seeded[record].seq, 'a rewrite takes a newer version');
          assert.notEqual(after.updatedAt, SEEDED_AT, 'a rewrite moves the change date');
        });
      }

      if (f.otherwise) {
        for (const record of ['done', 'bare']) {
          it(`${record}: no case is true (a property it lacks reads false), so it stays person, stamped in place with its version and date`, async () => {
            const { seeded, fp, runDoc } = held[f.space];
            const after = await row(f.space, record);
            assert.equal(after.type, 'person');
            assert.deepEqual(after.properties, ROWS[record].properties);
            assert.equal(after.schemaFingerprint, fp, 'a record that stays is stamped in place');
            assert.equal(after.seq, seeded[record].seq, 'a stamp moves no version');
            assert.equal(after.updatedAt, SEEDED_AT, 'a stamp moves no change date');
            assert.equal(runDoc.counts.stamped, 2, JSON.stringify(runDoc.counts));
            assert.equal(runDoc.counts.unconverted, 0);
          });
        }
        it('lists nothing', async () => {
          assert.deepEqual(await items(f.space), []);
        });
      } else {
        for (const record of ['done', 'bare']) {
          it(`${record}: no case is true and there is no otherwise, so it is untouched and listed as no_case_matched`, async () => {
            const { seeded } = held[f.space];
            const after = await row(f.space, record);
            assert.equal(after.type, 'person', 'an unmatched record was moved');
            assert.deepEqual(after.properties, ROWS[record].properties);
            assert.equal(after.seq, seeded[record].seq, 'an unmatched record was written');
            assert.equal(after.updatedAt, SEEDED_AT);
            assert.equal(after.schemaFingerprint, undefined, 'an unmatched record was stamped');
            const mine = (await items(f.space)).filter(i => i.recordId === `${f.space}-${record}`);
            assert.equal(mine.length, 1, `${record} is listed ${mine.length} times`);
            assert.equal(mine[0].reason, 'no_case_matched');
            assert.equal(mine[0].kind, 'entity');
            assert.equal(mine[0].status, 'open');
          });
        }
        it('counts the two unmatched records unconverted and still converts the other three', () => {
          const { runDoc } = held[f.space];
          assert.equal(runDoc.counts.unconverted, 2, JSON.stringify(runDoc.counts));
          assert.equal(runDoc.counts.rewritten, 3);
          assert.equal(runDoc.counts.stamped, 0);
        });
      }
    });
  }

  it('the two doors answered alike: one list of types, one fingerprint for one schema', () => {
    for (const withOtherwise of [true, false]) {
      const [rest, mcp] = FIXTURES.filter(f => f.otherwise === withOtherwise).map(f => held[f.space]);
      assert.deepEqual(rest.answer.body.convert, mcp.answer.body.convert);
    }
  });
});
