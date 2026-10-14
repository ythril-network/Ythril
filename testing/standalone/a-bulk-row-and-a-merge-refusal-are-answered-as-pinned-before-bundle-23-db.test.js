/**
 * What `bulk` reports for an item the schema refuses or flags, and what every merge door answers when the merged survivor would
 * break the schema — a CHARACTERIZATION of the answers BEFORE bundle-23 (`Q-93`, `Q-315`), green on base 85c4c564 and expected to
 * be EDITED by bundle-23 where it changes them.
 *
 * ## Why this file exists before the change
 *
 * Bundle-23 gives bulk's per-item refusal a structured `violation` beside its `reason` string, makes a merge's refusal the standard
 * body, and refuses a merge that brings an undeclared key into a strict space. Each is only reviewable against a record of today's
 * answer taken before the code that produced it is gone. Every expectation is a literal: derived from the server it would compare
 * the new code with itself.
 *
 * ## What it pins
 *
 * **Bulk, per item, on both doors** (`POST /api/brain/spaces/:id/bulk` answers `207`, `save_bulk` answers `200` — a refused item
 * is a ROW, never a failed call):
 *  - a strict space: the item is not stored and its row is `{ type, index, reason }` with `reason` =
 *    `schema_violation: <the reasons only>` — no field name, no `introduced` / `preExisting` split, and the reasons of violations the
 *    record ALREADY had are joined in. One refused item does not hide the others, and the row keeps the item's index.
 *  - a warn space: the item LANDS and its row reads `schema_warning: <field> — <reason>`.
 *  - the two doors answer the same rows for the same batch.
 *
 * **Merge, on every door that runs one** (the entity merge route, the duplicate review's merge, `graph_merge`):
 *  - a survivor that would break the strict schema is refused `400` and NOTHING is written. The REST body is `{ error, violations }`
 *    — not the standard refusal body (no `introduced`, no `preExisting`, no `message`, a hand-built `error` sentence); `graph_merge`
 *    answers `400` with `Error: <that sentence>` and structured content that holds `violations` only.
 *  - the survivor is judged WHOLE: a key the survivor brings in that its type declares with another type is refused, a key the type
 *    does not declare is MERGED, today.
 *  - in a warn space the same merge succeeds on every door.
 *
 * ## MCP pins fail rather than skip
 *
 * `mongoSkipReason()` skips on a laptop and THROWS under CI, so a runner without the test Mongo fails this file. The MCP half runs
 * through `callTool`, the dispatch the MCP transport calls.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-bulk-row-and-a-merge-refusal-are-answered-as-pinned-before-bundle-23-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPinDoors, spaceOf } from './_schema-refusal-pins.mjs';

const skip = await mongoSkipReason();
const STRICT = spaceOf('strict');
const WARN = spaceOf('warn');
const T0 = '2026-09-01T00:00:00.000Z';
const AUTHOR = { instanceId: 'pinmerge-receiver', instanceLabel: 'Receiver' };

const NUMBER_GOT_STRING = "expected type 'number', got 'string'";
const STRING_GOT_NUMBER = "expected type 'string', got 'number'";

let pins, ids, warnIds, handlers, bumpSeq;

/** The batch through each door, answering `{ status, errors, inserted, updated, text }` in one shape. */
const BULK = {
  'POST /api/brain/spaces/:spaceId/bulk': async (space, body) => {
    const out = await pins.bulkRest(space, body);
    return { status: out.status, errors: out.body.errors, inserted: out.body.inserted, updated: out.body.updated, body: out.body };
  },
  save_bulk: async (space, body) => {
    const out = await pins.call('save_bulk', { space, ...body });
    assert.equal(out.isError, false, out.text);
    return { status: out.status, errors: out.structured.errors, inserted: out.structured.inserted, updated: out.structured.updated, body: out.structured, text: out.text };
  },
};

describe('bulk rows and a merge refusal, as the doors answer them before bundle-23', { skip }, () => {
  before(async () => {
    pins = await openPinDoors({ suite: 'pinbulkmerge' });
    ({ bumpSeq } = await import('../../server/dist/util/seq.js'));
    const { entitiesRouter } = await import('../../server/dist/api/brain/entities.js');
    const { duplicatesRouter } = await import('../../server/dist/api/duplicates.js');
    handlers = {
      rest: pins.door.routeHandler(entitiesRouter, 'post', '/spaces/:spaceId/entities/:survivorId/merge/:absorbedId'),
      dupes: pins.door.routeHandler(duplicatesRouter, 'post', '/:id/merge'),
    };
  });
  after(async () => { await pins?.close(); });
  beforeEach(async () => { ids = await pins.seed(STRICT); warnIds = await pins.seed(WARN); });

  describe('bulk, per item', () => {
    for (const [door, send] of Object.entries(BULK)) {
      describe(door, () => {
        it('a strict space: the refused items are not stored, and a row says `schema_violation: <reason>` for each, with its index', async () => {
          const out = await send(STRICT, {
            entities: [{ name: 'Ok One', type: 'person', properties: { age: 3 } }, { name: 'Bad One', type: 'person', properties: { age: 'old' } }],
            edges: [{ from: ids.person1, to: ids.person2, label: 'employs' }],
          });
          assert.equal(out.status, door.startsWith('POST') ? 207 : 200);
          assert.deepEqual(out.errors, [
            { type: 'entity', index: 1, reason: `schema_violation: ${NUMBER_GOT_STRING}` },
            { type: 'edge', index: 0, reason: "schema_violation: 'employs' declares its from endpoint as one of: org" },
          ]);
          assert.deepEqual([out.inserted.entities, out.inserted.edges], [1, 0], 'one refused item hid the others, or a refused item was stored');
          const names = (await pins.stored(STRICT, 'entity')).map(d => d.name);
          assert.ok(names.includes('Ok One') && !names.includes('Bad One'), JSON.stringify(names));
          assert.equal((await pins.stored(STRICT, 'edge')).some(d => d.label === 'employs'), false);
        });

        it('a refused row has exactly `type`, `index` and `reason`: no field, no split, no structured violation', async () => {
          const out = await send(STRICT, { entities: [{ name: 'Bad Two', type: 'person', properties: { age: 'old' } }] });
          assert.equal(out.errors.length, 1, JSON.stringify(out.errors));
          assert.deepEqual(Object.keys(out.errors[0]).sort(), ['index', 'reason', 'type']);
        });

        it('an item that breaks one field while the record already broke another: the reason JOINS both, introduced first or not', async () => {
          const id = randomUUID();
          await pins.door.coll(STRICT, 'entities').insertOne({ _id: id, spaceId: STRICT, name: 'Bob', type: 'person', tags: [], properties: { age: 'old' }, seq: 50, author: AUTHOR, createdAt: T0, updatedAt: T0 });
          await bumpSeq(STRICT, 50);
          const out = await send(STRICT, { entities: [{ id, name: 'Bob', type: 'person', properties: { rank: 5 } }] });
          assert.equal(out.errors.length, 1, JSON.stringify(out.errors));
          const reasons = out.errors[0].reason.replace(/^schema_violation: /, '').split('; ').sort();
          assert.deepEqual(reasons, [NUMBER_GOT_STRING, STRING_GOT_NUMBER].sort(),
            'the reason does not carry both the introduced and the pre-existing reason');
        });

        it('a warn space: the item LANDS and its row reads `schema_warning: <field> — <reason>`', async () => {
          const out = await send(WARN, {
            entities: [{ name: 'Warned One', type: 'person', properties: { age: 'old' } }],
            edges: [{ from: warnIds.person1, to: warnIds.person2, label: 'employs' }],
          });
          assert.deepEqual(out.errors, [
            { type: 'entity', index: 0, reason: `schema_warning: properties.age — ${NUMBER_GOT_STRING}` },
            { type: 'edge', index: 0, reason: "schema_warning: fromType — 'employs' declares its from endpoint as one of: org" },
          ]);
          assert.deepEqual([out.inserted.entities, out.inserted.edges], [1, 1]);
          assert.ok((await pins.stored(WARN, 'entity')).some(d => d.name === 'Warned One'), 'the warned item did not land');
        });
      });
    }

    it('the two doors answer the same rows for the same batch', async () => {
      const batch = (n) => ({ entities: [{ name: `Same ${n}`, type: 'person', properties: { age: 'old' } }], edges: [{ from: ids.person1, to: ids.person2, label: 'employs' }] });
      const rest = await BULK['POST /api/brain/spaces/:spaceId/bulk'](STRICT, batch('rest'));
      const mcp = await BULK.save_bulk(STRICT, batch('mcp'));
      assert.deepEqual(mcp.errors, rest.errors);
    });

    it('save_bulk\'s text lists the rows as JSON after a one-line summary', async () => {
      const out = await BULK.save_bulk(STRICT, { entities: [{ name: 'Bad Three', type: 'person', properties: { age: 'old' } }] });
      assert.equal(out.text,
        'bulk_write complete — inserted: {"facts":0,"entities":0,"edges":0,"chrono":0}, updated: {"facts":0,"entities":0,"edges":0,"chrono":0}, '
        + 'connections: {"links":0,"edges":0}, errors: 1\n'
        + `[{"type":"entity","index":0,"reason":"schema_violation: ${NUMBER_GOT_STRING}"}]`);
    });
  });

  describe('merge', () => {
    /** Two entities of `type` in `space`, stored directly; the survivor is the older. Returns their ids. */
    async function pair(space, type, survivorProps = {}, absorbedProps = {}) {
      await pins.door.wipe(space);
      const [survivorId, absorbedId] = [randomUUID(), randomUUID()];
      const e = (_id, name, properties, seq) => ({ _id, spaceId: space, name, type, tags: [], properties, seq, author: AUTHOR, createdAt: T0, updatedAt: T0 });
      await pins.door.coll(space, 'entities').insertMany([e(survivorId, 'Survivor', survivorProps, 1), e(absorbedId, 'Absorbed', absorbedProps, 2)]);
      await bumpSeq(space, 2);
      return { survivorId, absorbedId };
    }

    /** The merge through each door; every one answers `{ status, body }`, `graph_merge` also `{ text, structured }`. */
    const DOORS = {
      'the entity merge route': async (space, p) => {
        const out = await pins.door.request(handlers.rest, { params: { spaceId: space, survivorId: p.survivorId, absorbedId: p.absorbedId } });
        return { status: out.status, body: out.body };
      },
      'the duplicate review\'s merge': async (space, p) => {
        const [aId, bId] = [p.survivorId, p.absorbedId].sort();
        const _id = `entity:${aId}:${bId}`;
        await pins.door.coll(space, 'dupe_candidates').insertOne({ _id, spaceId: space, type: 'entity', aId, bId,
          aSeq: aId === p.survivorId ? 1 : 2, bSeq: bId === p.survivorId ? 1 : 2, score: 0.99, status: 'open', detectedAt: 'x', updatedAt: 'x' });
        const out = await pins.door.request(handlers.dupes, { params: { id: _id } });
        return { status: out.status, body: out.body };
      },
      graph_merge: async (space, p) => {
        const out = await pins.call('graph_merge', { space, survivorId: p.survivorId, absorbedId: p.absorbedId });
        return { status: out.status, isError: out.isError, text: out.text, structured: out.structured };
      },
    };

    /** What a merge could have written: the entities and the tombstones, whole. */
    const snapshot = async (space) => ({
      entities: await pins.stored(space, 'entity'),
      tombstones: await pins.door.coll(space, 'tombstones').find({}).sort({ _id: 1 }).toArray(),
    });

    /** The refusal sentence a merge answers for a survivor that would break the schema after absorbing. */
    const sentence = (space, p, what) => `merge refused: the survivor '${p.survivorId}' would violate the schema of space '${space}' after absorbing '${p.absorbedId}' — ${what}`;

    const REFUSALS = [
      {
        name: 'a survivor of a type outside the space\'s entity allowlist',
        type: 'thing', survivor: {}, absorbed: {},
        what: 'type: not in entityTypes allowlist: person, org',
        violations: [{ field: 'type', value: 'thing', reason: 'not in entityTypes allowlist: person, org' }],
      },
      {
        name: 'a survivor that takes a property value of the wrong type from the absorbed entity',
        type: 'person', survivor: { age: 3 }, absorbed: { rank: 5 },
        what: `properties.rank: ${STRING_GOT_NUMBER}`,
        violations: [{ field: 'properties.rank', value: 5, reason: STRING_GOT_NUMBER }],
      },
    ];

    for (const refusal of REFUSALS) {
      describe(refusal.name, () => {
        for (const [door, merge] of Object.entries(DOORS)) {
          it(`${door}: 400, the pinned answer, and nothing is written`, async () => {
            const p = await pair(STRICT, refusal.type, refusal.survivor, refusal.absorbed);
            const before_ = await snapshot(STRICT);
            const out = await merge(STRICT, p);
            const error = sentence(STRICT, p, refusal.what);
            assert.equal(out.status, 400, JSON.stringify(out));
            if (door === 'graph_merge') {
              assert.equal(out.isError, true);
              assert.equal(out.text, `Error: ${error}`);
              assert.deepEqual(out.structured, { violations: refusal.violations });
            } else {
              assert.deepEqual(out.body, { error, violations: refusal.violations });
            }
            assert.deepEqual(await snapshot(STRICT), before_, `${door}: a refused merge wrote something`);
          });
        }
      });
    }

    it('a refused merge answers `{ error, violations }` and NOT the standard refusal body: no `introduced`, `preExisting` or `message`', async () => {
      const p = await pair(STRICT, 'thing');
      const out = await DOORS['the entity merge route'](STRICT, p);
      assert.deepEqual(Object.keys(out.body).sort(), ['error', 'violations']);
    });

    for (const [door, merge] of Object.entries(DOORS)) {
      it(`${door}: a key the survivor's type does not DECLARE is merged today, in a strict space, and stored`, async () => {
        const p = await pair(STRICT, 'person', { age: 3 }, { zzNotDeclared: 1 });
        const out = await merge(STRICT, p);
        assert.equal(out.status, 200, JSON.stringify(out));
        const survivor = (await pins.stored(STRICT, 'entity')).find(d => d._id === p.survivorId);
        assert.deepEqual(survivor.properties, { age: 3, zzNotDeclared: 1 });
        assert.equal((await pins.stored(STRICT, 'entity')).some(d => d._id === p.absorbedId), false, 'the absorbed entity was not removed');
      });

      it(`${door}: in a warn space the merge that a strict space refuses succeeds`, async () => {
        const p = await pair(WARN, 'thing');
        const out = await merge(WARN, p);
        assert.equal(out.status, 200, JSON.stringify(out));
        assert.deepEqual((await pins.stored(WARN, 'entity')).map(d => d._id), [p.survivorId]);
      });
    }

    it('and what a successful merge answers, by door: the keys of each body', async () => {
      const keys = {};
      for (const [door, merge] of Object.entries(DOORS)) {
        const p = await pair(WARN, 'thing');
        const out = await merge(WARN, p);
        keys[door] = door === 'graph_merge' ? Object.keys(out.structured).sort() : Object.keys(out.body).sort();
      }
      assert.deepEqual(keys, {
        'the entity merge route': ['absorbedId', 'deletedDuplicateEdgeIds', 'duplicateEdgeWarnings', 'endpointRuleWarnings', 'merged', 'relinked'],
        'the duplicate review\'s merge': ['status', 'survivorId'],
        graph_merge: ['absorbedId', 'deletedDuplicateEdgeIds', 'endpointRuleWarnings', 'survivor'],
      });
    });
  });
});
