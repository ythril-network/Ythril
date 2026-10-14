/**
 * The stored-data dry run (`POST /api/spaces/:id/validate-schema`) answers a stored value only to a caller who may read the
 * stored data, pages by an `_id` cursor, and reads a fixed projection (R6-12; security S10, data-integrity S13).
 *
 * ## The finding
 *
 * The dry run is a `schema: read` route, and it answers every violation row with the stored VALUE of the property that broke
 * the rule. A token that may read the schema and nothing else (`knowledge: none`) could therefore read stored records
 * through it, a row at a time — the one route in the schema area that reflected the data. The scan itself read whole
 * documents (vectors included) for entities, facts and chrono, and ended at ten thousand records per collection with no way to
 * reach the rest. The design (R6-12): EVERY value-bearing row needs `knowledge: read`, else the row names the field and the
 * reason and omits the value; the projection is fixed server-side (never a caller's, never with vectors); stored-data mode
 * pages by an `_id` cursor.
 *
 * ## What is held
 *
 *  - **Values need knowledge:read.** A caller holding `schema: read` and `knowledge: none` gets the rows with `field` and
 *    `reason` and no `value`, and the stored value appears nowhere in the answer; a caller holding `knowledge: read` (and the
 *    instance admin) gets the values as before.
 *  - **A cursor, not an offset.** `{ limit }` bounds a page; the answer carries `nextCursor` while records are left, and the
 *    request's `cursor` continues from it. Rows come in ascending `_id` order, the pages are disjoint, their union is every
 *    violating record exactly once, and the last page has no `nextCursor` and says `complete`.
 *  - **A fixed projection.** Each read of a record collection (entities, edges, facts, chrono) carries a projection that
 *    leaves the vector out, and a `projection` sent in the body changes nothing about what is read.
 *
 * The parameter names `cursor` / `nextCursor` are this test's reading of "pages by `_id` cursor" (R6-12, DI S13): the plan does
 * not spell them. The MCP half is the new `schema_validate` tool (both modes, same rights): it is part of the F-46 slice and
 * is held where that tool is tested, not here.
 *
 * ## Seen red
 *
 * On 85c4c564 a `schema: read` caller receives the stored value in every row, there is no `nextCursor`, and the entity, fact
 * and chrono reads carry no projection (only edges do).
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-stored-data-dry-run-keeps-values-from-readers-and-pages-by-cursor-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';

const skip = await mongoSkipReason();

const SPACE = 'dryrunrights';
const META = { validationMode: 'strict', typeSchemas: { entity: { person: { propertySchemas: { age: { type: 'number' } } } } } };
const SECRET = 'SECRET-STORED-VALUE';
const COUNT = 25;
const ids = Array.from({ length: COUNT }, (_, i) => `ent-${String(i).padStart(3, '0')}`);

const rightsOf = (areas) => ({
  instanceAdmin: false, createSpaces: false, perSpace: {},
  floor: { knowledge: 'none', files: 'none', schema: 'none', dataQuality: 'none', networks: 'none', ...areas },
});
const SCHEMA_READER = rightsOf({ schema: 'read' });
const DATA_READER = rightsOf({ schema: 'read', knowledge: 'read' });

let door;
let spacesRouter;

describe('the stored-data dry run', { skip }, () => {
  before(async () => {
    door = await openToolDoor({ suite: 'dryrunrights', spaces: [{ id: SPACE, label: SPACE, folders: [], meta: META }] });
    ({ spacesRouter } = await import('../../server/dist/api/spaces.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.wipe(SPACE);
    await door.coll(SPACE, 'entities').insertMany(ids.map((_id, i) => ({
      _id, spaceId: SPACE, name: `person ${i}`, type: 'person', tags: [], properties: { age: `${SECRET}-${i}` }, seq: i + 1,
      embedding: [0.25, 0.5, 0.75],
    })));
  });

  /** POST /api/spaces/:id/validate-schema with no meta in the body: the stored-data dry run of the space's own schema. */
  const dryRun = (body = {}, rights = door.ADMIN) =>
    door.request(door.routeHandler(spacesRouter, 'post', '/:id/validate-schema'), { params: { id: SPACE }, body, rights });

  describe('values', () => {
    it('a caller who may read the schema and not the data gets the rows without the stored value', async () => {
      const out = await dryRun({}, SCHEMA_READER);
      assert.equal(out.status, 200, JSON.stringify(out.body).slice(0, 300));
      assert.ok(out.body.violations.length > 0, 'the dry run found nothing to report: the fixture is not what it was meant to be');
      for (const row of out.body.violations) {
        for (const v of row.violations) {
          assert.ok(v.field && v.reason, `a row lost its field or its reason: ${JSON.stringify(v)}`);
          assert.ok(!('value' in v), `${row._id}: the row carries the stored value to a caller without knowledge:read`);
        }
      }
      assert.ok(!JSON.stringify(out.body).includes(SECRET), 'a stored value reached a caller without knowledge:read');
    });

    it('a caller who may read the data, and the instance admin, get the values', async () => {
      for (const [who, rights] of [['knowledge reader', DATA_READER], ['instance admin', door.ADMIN]]) {
        const out = await dryRun({}, rights);
        assert.equal(out.status, 200, `${who}: ${JSON.stringify(out.body).slice(0, 300)}`);
        const values = out.body.violations.flatMap(r => r.violations.map(v => v.value));
        assert.ok(values.length > 0 && values.every(v => typeof v === 'string' && v.startsWith(SECRET)), `${who}: the values were withheld: ${JSON.stringify(values.slice(0, 3))}`);
      }
    });
  });

  describe('paging', () => {
    it('pages by an _id cursor: disjoint ascending pages whose union is every record once, the last one complete', async () => {
      const seen = [];
      let cursor;
      let pages = 0;
      let last;
      do {
        const out = await dryRun({ limit: 10, ...(cursor !== undefined ? { cursor } : {}) });
        assert.equal(out.status, 200, JSON.stringify(out.body).slice(0, 300));
        const rows = out.body.violations.filter(r => r.collection === 'entities').map(r => r._id);
        assert.ok(rows.length <= 10, `a page of limit 10 carried ${rows.length} rows`);
        assert.deepEqual(rows, [...rows].sort(), 'the page is not in ascending _id order');
        if (seen.length) assert.ok(rows.every(id => id > seen.at(-1)), 'a page repeats or precedes what an earlier page answered');
        seen.push(...rows);
        last = out.body;
        cursor = out.body.nextCursor ?? undefined;
        pages += 1;
        assert.ok(pages <= COUNT, 'the cursor never reaches an end');
      } while (cursor !== undefined);
      assert.equal(pages, 3, `${COUNT} records at limit 10 came in ${pages} page(s) — the first page has no nextCursor, so the rest cannot be reached`);
      assert.deepEqual(seen, ids, 'the pages together are not every violating record exactly once');
      assert.equal(last.complete, true, 'the last page does not say the scan is complete');
    });

    it('a page that leaves records says so: not complete, with a cursor', async () => {
      const out = await dryRun({ limit: 10 });
      assert.equal(out.body.complete, false, 'a first page of 10 of 25 says the scan is complete');
      assert.ok(typeof out.body.nextCursor === 'string' && out.body.nextCursor.length > 0, `no nextCursor: ${JSON.stringify(Object.keys(out.body))}`);
    });
  });

  describe('projection', () => {
    /** The projection of every `find` the dry run sent to each record collection of the space. */
    async function projectionsRead(body) {
      const proto = Object.getPrototypeOf(door.coll(SPACE, 'entities'));
      const original = proto.find;
      const wanted = new Map(['entities', 'edges', 'facts', 'chrono'].map(k => [door.coll(SPACE, k).collectionName, k]));
      const reads = {};
      proto.find = function (filter, options, ...rest) {
        const kind = wanted.get(this.collectionName);
        if (kind) (reads[kind] ??= []).push(options?.projection);
        return original.call(this, filter, options, ...rest);
      };
      try { await dryRun(body); } finally { proto.find = original; }
      return reads;
    }

    /** True when `projection` leaves the vector out: an exclusion naming it, or an inclusion not naming it. */
    const leavesVectorOut = (p) => {
      if (!p || typeof p !== 'object' || Object.keys(p).length === 0) return false;
      const inclusion = Object.values(p).some(v => v === 1 || v === true);
      return inclusion ? !p.embedding : p.embedding === 0 || p.embedding === false;
    };

    for (const kind of ['entities', 'edges', 'facts', 'chrono']) {
      it(`${kind}: every read carries a projection that leaves the vector out`, async () => {
        const reads = await projectionsRead({});
        assert.ok(reads[kind]?.length, `the dry run did not read ${kind} with find()`);
        for (const p of reads[kind]) assert.ok(leavesVectorOut(p), `${kind}: read with projection ${JSON.stringify(p)} — the whole document, vector included`);
      });
    }

    it('a projection in the body changes nothing about what is read', async () => {
      const plain = await projectionsRead({});
      const steered = await projectionsRead({ projection: { name: 1 }, fields: ['name'] });
      assert.deepEqual(steered, plain, 'the read followed the caller\'s projection');
    });
  });
});
