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
        it('a strict space: the refused items are not stored, and a row says `schema_violation: <reason>` and its `violation` for each, with its index', async () => {
          const out = await send(STRICT, {
            entities: [{ name: 'Ok One', type: 'person', properties: { age: 3 } }, { name: 'Bad One', type: 'person', properties: { age: 'old' } }],
            edges: [{ from: ids.person1, to: ids.person2, label: 'employs' }],
          });
          assert.equal(out.status, door.startsWith('POST') ? 207 : 200);
          // bundle-23: r4.1 + R5-3 Q-315 (a bulk row gains `violation`, the structured refusal; `reason` stays the published string) — was { type, index, reason } only
          assert.deepEqual(out.errors, [
            { type: 'entity', index: 1, reason: `schema_violation: ${NUMBER_GOT_STRING}`,
              violation: { error: 'schema_violation', message: "The change violates this space's schema: properties.age.", introduced: [{ field: 'properties.age', reason: NUMBER_GOT_STRING, value: 'old' }], preExisting: [] } },
            { type: 'edge', index: 0, reason: "schema_violation: 'employs' declares its from endpoint as one of: org",
              violation: { error: 'schema_violation', message: "The change violates this space's schema: fromType.", introduced: [{ field: 'fromType', reason: "'employs' declares its from endpoint as one of: org", value: 'person' }], preExisting: [] } },
          ]);
          assert.deepEqual([out.inserted.entities, out.inserted.edges], [1, 0], 'one refused item hid the others, or a refused item was stored');
          const names = (await pins.stored(STRICT, 'entity')).map(d => d.name);
          assert.ok(names.includes('Ok One') && !names.includes('Bad One'), JSON.stringify(names));
          assert.equal((await pins.stored(STRICT, 'edge')).some(d => d.label === 'employs'), false);
        });

        it('a refused row has exactly `type`, `index`, `reason` and `violation`: the violation carries no duplicate `violations` array', async () => {
          const out = await send(STRICT, { entities: [{ name: 'Bad Two', type: 'person', properties: { age: 'old' } }] });
          assert.equal(out.errors.length, 1, JSON.stringify(out.errors));
          // bundle-23: R5-3 Q-315 (the row's `violation` holds { error, message, introduced, preExisting }, no `violations`) — was ['index', 'reason', 'type']
          assert.deepEqual(Object.keys(out.errors[0]).sort(), ['index', 'reason', 'type', 'violation']);
          assert.deepEqual(Object.keys(out.errors[0].violation).sort(), ['error', 'introduced', 'message', 'preExisting']);
        });

        it('an item that breaks one field while the record already broke another: the reason is the breaking fault only, the pre-existing one is not joined', async () => {
          const id = randomUUID();
          await pins.door.coll(STRICT, 'entities').insertOne({ _id: id, spaceId: STRICT, name: 'Bob', type: 'person', tags: [], properties: { age: 'old' }, seq: 50, author: AUTHOR, createdAt: T0, updatedAt: T0 });
          await bumpSeq(STRICT, 50);
          const out = await send(STRICT, { entities: [{ id, name: 'Bob', type: 'person', properties: { rank: 5 } }] });
          assert.equal(out.errors.length, 1, JSON.stringify(out.errors));
          const reasons = out.errors[0].reason.replace(/^schema_violation: /, '').split('; ').sort();
          // bundle-23: R5-3 Q-315 (`reason` is derived from violation.introduced only, the blocking fault; the pre-existing reason lives in violation.preExisting) — was both reasons joined with '; '
          assert.deepEqual(reasons, [STRING_GOT_NUMBER], 'the reason is not the introduced fault alone');
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

    it('save_bulk\'s text lists the rows as JSON after a one-line summary, each row with its `violation`', async () => {
      const out = await BULK.save_bulk(STRICT, { entities: [{ name: 'Bad Three', type: 'person', properties: { age: 'old' } }] });
      // bundle-23: R5-3 Q-315 (the JSON rows carry the row's `violation`) — was the row without it
      assert.equal(out.text,
        'bulk_write complete — inserted: {"facts":0,"entities":0,"edges":0,"chrono":0}, updated: {"facts":0,"entities":0,"edges":0,"chrono":0}, '
        + 'connections: {"links":0,"edges":0}, errors: 1\n'
        + `[{"type":"entity","index":0,"reason":"schema_violation: ${NUMBER_GOT_STRING}","violation":{"error":"schema_violation","message":"The change violates this space's schema: properties.age.","introduced":[{"field":"properties.age","reason":"${NUMBER_GOT_STRING}","value":"old"}],"preExisting":[]}}]`);
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
            // bundle-23: R5-3 Q-315 (a merge answers the standard refusal body, toStructured(): error 'schema_violation', message the sentence; graph_merge's text is the common MCP mapping) — was { error: <sentence>, violations } and `Error: <sentence>`
            const standard = { error: 'schema_violation', message: error, introduced: refusal.violations, preExisting: [], violations: refusal.violations };
            if (door === 'graph_merge') {
              assert.equal(out.isError, true);
              assert.equal(out.text, `Error: schema_violation: ${error}`);
              assert.deepEqual(out.structured, standard);
            } else {
              assert.deepEqual(out.body, standard);
            }
            assert.deepEqual(await snapshot(STRICT), before_, `${door}: a refused merge wrote something`);
          });
        }
      });
    }

    it('a refused merge answers the standard refusal body: `error` is the code, with `message`, `introduced`, `preExisting` and `violations`', async () => {
      const p = await pair(STRICT, 'thing');
      const out = await DOORS['the entity merge route'](STRICT, p);
      // bundle-23: R5-3 Q-315 (body becomes toStructured()) — was ['error', 'violations'] with the sentence in `error`
      assert.deepEqual(Object.keys(out.body).sort(), ['error', 'introduced', 'message', 'preExisting', 'violations']);
      assert.equal(out.body.error, 'schema_violation');
    });

    for (const [door, merge] of Object.entries(DOORS)) {
      it(`${door}: a key the absorbed entity brings in that the survivor's type does not DECLARE is refused in a strict space, and nothing is written`, async () => {
        const p = await pair(STRICT, 'person', { age: 3 }, { zzNotDeclared: 1 });
        const before_ = await snapshot(STRICT);
        const out = await merge(STRICT, p);
        // bundle-23: R6-10 Q-93 (keys brought in from the absorbed record are introduced in strict; the merge keeps 400) — was 200, merged and stored
        const error = sentence(STRICT, p, "properties.zzNotDeclared: property 'zzNotDeclared' is not declared on this type");
        const violations = [{ field: 'properties.zzNotDeclared', value: 1, reason: "property 'zzNotDeclared' is not declared on this type", declared: ['age', 'rank'] }];
        const standard = { error: 'schema_violation', message: error, introduced: violations, preExisting: [], violations };
        assert.equal(out.status, 400, JSON.stringify(out));
        if (door === 'graph_merge') assert.deepEqual(out.structured, standard);
        else assert.deepEqual(out.body, standard);
        assert.deepEqual(await snapshot(STRICT), before_, `${door}: a refused merge wrote something`);
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
