/**
 * A bulk item the strict schema refuses is reported as a row that carries the SAME refusal a single-record caller reads,
 * beside the published `reason` string (`Q-315`, R5-3).
 *
 * ## The finding
 *
 * A single-record write the schema refuses answers `{ error: 'schema_violation', message, introduced, preExisting,
 * violations }`. The same refusal inside `save_bulk` or `POST /api/brain/spaces/:id/bulk` is a row `{ type, index, reason }`
 * whose `reason` is `schema_violation: ` and every reason of the merged record glued with `; ` — the reasons of
 * violations the record ALREADY had included, so a caller reading the row cannot tell the field that blocked the item
 * from one that did not. A caller that handles the refusal had to special-case bulk and parse a sentence.
 *
 * ## What is held (additive: the published `reason` stays a string)
 *
 *  - **`violation`**: every schema refusal's row gains `violation` — the refusal body WITHOUT its duplicate list:
 *    `{ error: 'schema_violation', message, introduced, preExisting }` and no `violations` key (every row of `introduced` and
 *    `preExisting` is already in it; the second list is the bloat a 500-item batch pays for 500 times).
 *  - **`reason` is derived from `introduced`**: the prefix `schema_violation: ` and the reasons of what the item INTRODUCED, joined
 *    with `; ` — the blocking fault. What the record already had is in `violation.preExisting` and is not in the sentence.
 *  - **Both doors, one row.** `POST /api/brain/spaces/:id/bulk` and `save_bulk` answer the same rows for the same batch.
 *  - **A top-level edge's refusal** is a row of the same shape, so the rule is not the entity's alone.
 *
 * ## Seen red
 *
 * On 85c4c564 a refused row has no `violation`, and its `reason` joins the pre-existing violation's reason with the
 * introduced one.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-bulk-refusal-row-carries-its-violation-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';

const skip = await mongoSkipReason();

const SPACE = 'bulkviolation';
const META = {
  validationMode: 'strict',
  typeSchemas: {
    entity: { person: { propertySchemas: { age: { type: 'number', maximum: 10 }, status: { type: 'string', enum: ['open', 'closed'] } } } },
    edge: { knows: { propertySchemas: { since: { type: 'number' } } } },
  },
};
const AUTHOR = { instanceId: 'bulkviolation-receiver', instanceLabel: 'Receiver' };
const T0 = '2026-09-01T00:00:00.000Z';

let door, bulkRouter;

const entity = (_id, name, properties, seq) => ({ _id, spaceId: SPACE, name, type: 'person', tags: [], properties, author: AUTHOR, createdAt: T0, updatedAt: T0, seq });

/** The batch through each door; both answer `{ errors }` — REST as the body of a 207, MCP as `structuredContent`. */
const DOORS = {
  'POST /api/brain/spaces/:spaceId/bulk': async (body) => {
    const h = door.routeHandler(bulkRouter, 'post', '/spaces/:spaceId/bulk');
    const out = await door.request(h, { params: { spaceId: SPACE }, body });
    assert.equal(out.status, 207, `the bulk route answered ${out.status}: ${JSON.stringify(out.body)}`);
    return out.body.errors;
  },
  'save_bulk': async (body) => {
    const out = await door.call('save_bulk', { space: SPACE, ...body });
    assert.equal(out.result.isError, false, out.text);
    return out.structured.errors;
  },
};

describe('a refused bulk item reports the one refusal body beside its reason', { skip }, () => {
  before(async () => {
    door = await openToolDoor({ suite: 'bulkviolation', spaces: [{ id: SPACE, label: SPACE, folders: [], meta: META }] });
    ({ bulkRouter } = await import('../../server/dist/api/brain/bulk.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(SPACE); });

  for (const [name, send] of Object.entries(DOORS)) {
    describe(name, () => {
      it('an item that introduces a violation: a row with `violation` and no duplicate `violations` list', async () => {
        const errors = await send({ entities: [{ name: 'Ann', type: 'person', properties: { age: 12 } }] });
        assert.equal(errors.length, 1, JSON.stringify(errors));
        const [row] = errors;
        assert.deepEqual([row.type, row.index], ['entity', 0]);
        assert.ok(row.violation && typeof row.violation === 'object', `the row has no \`violation\`: ${JSON.stringify(row)}`);
        assert.deepEqual(Object.keys(row.violation).sort(), ['error', 'introduced', 'message', 'preExisting'],
          'the row\'s violation is not the refusal body without its duplicate `violations` list');
        assert.equal(row.violation.error, 'schema_violation');
        assert.deepEqual(row.violation.introduced, [{ field: 'properties.age', value: 12, reason: 'must be <= 10' }]);
        assert.deepEqual(row.violation.preExisting, []);
        assert.match(row.violation.message, /properties\.age/);
        assert.equal(row.reason, 'schema_violation: must be <= 10', 'the published reason string changed for a plain refusal');
      });

      it('an item that breaks one field while the record already broke another: the reason names only what the item introduced', async () => {
        const id = randomUUID();
        await door.coll(SPACE, 'entities').insertOne(entity(id, 'Bob', { age: 50 }, 1));
        const { bumpSeq } = await import('../../server/dist/util/seq.js');
        await bumpSeq(SPACE, 1);
        const errors = await send({ entities: [{ id, name: 'Bob', type: 'person', properties: { status: 'bogus' } }] });
        assert.equal(errors.length, 1, JSON.stringify(errors));
        const [row] = errors;
        assert.deepEqual(row.violation.introduced.map(v => v.field), ['properties.status'], JSON.stringify(row.violation));
        assert.deepEqual(row.violation.preExisting.map(v => v.field), ['properties.age'],
          'the violation the record already had is not reported as pre-existing');
        assert.ok(!('violations' in row.violation));
        assert.equal(row.reason, `schema_violation: ${row.violation.introduced.map(v => v.reason).join('; ')}`,
          'the reason is not `schema_violation: ` and the introduced reasons joined with `; `');
        assert.doesNotMatch(row.reason, /must be <= 10/, 'the reason names the pre-existing violation, which did not block the item');
      });

      it('a top-level edge refused by its edge schema is a row of the same shape', async () => {
        const [a, b] = [randomUUID(), randomUUID()];
        await door.coll(SPACE, 'entities').insertMany([entity(a, 'A', {}, 1), entity(b, 'B', {}, 2)]);
        const { bumpSeq } = await import('../../server/dist/util/seq.js');
        await bumpSeq(SPACE, 2);
        const errors = await send({ edges: [{ from: a, to: b, label: 'knows', properties: { since: 'long ago' } }] });
        assert.equal(errors.length, 1, JSON.stringify(errors));
        const [row] = errors;
        assert.equal(row.type, 'edge');
        assert.deepEqual(Object.keys(row.violation ?? {}).sort(), ['error', 'introduced', 'message', 'preExisting'], JSON.stringify(row));
        assert.ok(row.violation.introduced.some(v => v.field.endsWith('properties.since')), JSON.stringify(row.violation.introduced));
        assert.match(row.reason, /^schema_violation: /);
      });

      it('an item the schema accepts has no `violation`, and one refused item does not hide the others', async () => {
        const errors = await send({
          entities: [{ name: 'Ok', type: 'person', properties: { age: 3 } }, { name: 'Bad', type: 'person', properties: { age: 99 } }],
        });
        assert.deepEqual(errors.map(e => e.index), [1], 'the row does not name the refused item\'s index');
        assert.ok(errors[0].violation);
      });
    });
  }

  it('the two doors answer the same row for the same item', async () => {
    const body = { entities: [{ name: 'Ann', type: 'person', properties: { age: 12 } }] };
    const [rest, mcp] = [await DOORS['POST /api/brain/spaces/:spaceId/bulk'](body), await DOORS.save_bulk(body)];
    assert.deepEqual(mcp, rest, 'the doors answered different rows for one refused item');
  });
});
