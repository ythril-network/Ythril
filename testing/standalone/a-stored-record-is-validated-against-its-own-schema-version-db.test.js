/**
 * The live check of a schema can judge each stored record against the version it carries (`against: 'stamp'`), alike on both doors
 * (Q-743; bundle-267 design r3 §5, §7 "-db, validate"; r2 "Validate stamp mode"; vet DI 4/5, perf 4/5, R5, S5, T5, docs 1/6).
 *
 * ## The contract (written before the code)
 *
 * - `POST /api/spaces/:id/validate-schema` and MCP `schema_validate` take `against: 'current' | 'stamp'` (default `current`), and
 *   always echo it, so a caller can tell an older server that dropped the key.
 * - `stamp` only in stored mode: with `meta` or `sample` it is `400 against_needs_stored`.
 * - In stamp mode a record is judged against the text of its own version; a record whose version is not held is COUNTED, not listed,
 *   per fingerprint, and an unversioned one is counted: `skipped: { unversioned, notHeld: { <fp>: n } }`, counting this call.
 * - Edges of several versions on one page are grouped by version, and their endpoints are read once per page, not per group.
 *
 * ## Fixture
 *
 * v1: person requires `p`; edge `knows` from person. v2 (current): person requires `q`; `knows` from org. Records: P1 person@v1 with p,
 * P2 person@v2 with q, O1 org@v2, two persons at a version not held, three unstamped persons with q; edges E1 P1->P2 @v1, E2 P1->O1 @v2,
 * E3 O1->O1 @v2. Against current: P1, E1 and E2 break the schema. Against the stamp: only E2.
 *
 * ## Seen red at b299cde3
 *
 * `against` is dropped silently (the body is not strict), so the answer has no `against` echo and no `skipped`, stamp mode answers what
 * current mode answers, and `against` with `meta` is not refused (new code).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openViewDoors } from './_view-doors.mjs';
import { openPushDoor } from './_push-door.mjs';
import { recordOf, saveVersion, readsDuring, undocumentedKeys } from './_schema-version-fixtures.mjs';

const skip = await mongoSkipReason();

const SUITE = 'svvalidate';
const V = 'svval';
const META = { suppressEmbeddings: true, validationMode: 'strict' };
const NOT_HELD = 'e'.repeat(64);

const version = (prop, fromType) => ({ ...META, typeSchemas: {
  entity: { person: { propertySchemas: { [prop]: { type: 'string', required: true } } }, org: {} },
  edge: { knows: { endpoints: { from: [fromType] } } },
} });

let d, v1, v2;
const ID = { P1: 'en-000001', P2: 'en-000002', O1: 'en-000003' };

/**
 * An administrator's key, a fresh one per call: the stored-data check is rate limited per token (five runs a minute across both doors),
 * and the cases here run it more often than that. The limit is not the subject.
 */
let serial = 0;
const freshKey = async () => (await d.mint(`svval-admin-${++serial}`, {}, { admin: true })).key;

/** Both doors: `{ status, refused, body, text }`. */
const DOORS = {
  'REST POST /api/spaces/:id/validate-schema': async (body) => {
    const r = await d.rest(await freshKey(), 'POST', `/api/spaces/${V}/validate-schema`, body);
    return { status: r.status, refused: r.status >= 400, body: r.body, text: r.text };
  },
  'MCP schema_validate': async (body) => {
    const r = await d.mcp(await freshKey(), 'schema_validate', { space: V, ...body });
    let parsed = r.structured;
    if (!parsed) { try { parsed = JSON.parse(r.text); } catch { parsed = undefined; } }
    return { status: r.status, refused: r.isError, body: parsed, text: r.text };
  },
};

/** The ids of the records an answer lists with at least one violation. */
function violatingIds(body) {
  const out = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') {
      if (typeof v._id === 'string' && Array.isArray(v.violations) && v.violations.length > 0) out.add(v._id);
      Object.values(v).forEach(walk);
    }
  };
  walk(body);
  return [...out].sort();
}

describe('a stored record is validated against its own schema version (real MongoDB, both doors)', { skip }, () => {
  before(async () => {
    d = await openViewDoors({ suite: SUITE, openDoor: () => openPushDoor({ suite: SUITE, monitorCommands: true, spaces: [{ id: V, label: V, folders: [], meta: META }] }) });
    v1 = await saveVersion(V, version('p', 'person'));
    v2 = await saveVersion(V, version('q', 'org'));
    const ents = d.door.coll(V, 'entities');
    await ents.insertMany([
      recordOf('entities', V, 1, { type: 'person', fp: v1.fp, properties: { p: 'x' } }),
      recordOf('entities', V, 2, { type: 'person', fp: v2.fp, properties: { q: 'y' } }),
      recordOf('entities', V, 3, { type: 'org', fp: v2.fp }),
      recordOf('entities', V, 4, { type: 'person', fp: NOT_HELD, properties: { q: 'w' } }),
      recordOf('entities', V, 5, { type: 'person', fp: NOT_HELD, properties: { q: 'w' } }),
      ...[6, 7, 8].map(i => recordOf('entities', V, i, { type: 'person', properties: { q: 'z' } })),
    ]);
    await d.door.coll(V, 'edges').insertMany([
      recordOf('edges', V, 11, { type: 'knows', fp: v1.fp, from: ID.P1, to: ID.P2 }),
      recordOf('edges', V, 12, { type: 'knows', fp: v2.fp, from: ID.P1, to: ID.O1 }),
      recordOf('edges', V, 13, { type: 'knows', fp: v2.fp, from: ID.O1, to: ID.O1 }),
    ]);
  });
  after(async () => { await d?.close(); });

  for (const [door, run] of Object.entries(DOORS)) {
    describe(door, () => {
      it('against current (the default) and against the stamp judge a record valid under its own version differently, and echo which', async () => {
        const byDefault = await run({});
        assert.ok(!byDefault.refused, byDefault.text.slice(0, 300));
        assert.equal(byDefault.body?.against, 'current', 'against is not echoed, or does not default to current');
        assert.deepEqual(violatingIds(byDefault.body), ['ed-000011', 'ed-000012', ID.P1].sort());
        const current = await run({ against: 'current' });
        assert.equal(current.body?.against, 'current');
        assert.deepEqual(violatingIds(current.body), violatingIds(byDefault.body));
        const stamp = await run({ against: 'stamp' });
        assert.ok(!stamp.refused, stamp.text.slice(0, 300));
        assert.equal(stamp.body?.against, 'stamp', 'stamp mode is not echoed');
        assert.deepEqual(violatingIds(stamp.body), ['ed-000012'], 'a record valid under the version it carries is reported, or E2 (invalid under its own) is not');
      });

      it('counts records whose version is not held per fingerprint, and unversioned records, without listing them', async () => {
        const stamp = await run({ against: 'stamp' });
        assert.ok(!stamp.refused, stamp.text.slice(0, 300));
        assert.deepEqual(stamp.body?.skipped, { unversioned: 3, notHeld: { [NOT_HELD]: 2 } });
        for (const id of ['en-000004', 'en-000005', 'en-000006', 'en-000007', 'en-000008']) {
          assert.ok(!violatingIds(stamp.body).includes(id), `${id} is listed: a record with no version to judge it by became a row`);
        }
      });

      it('against stamp with a proposed meta or a sample is 400 against_needs_stored', async () => {
        for (const extra of [{ meta: version('q', 'org') }, { sample: { kind: 'entity', record: { name: 'n', type: 'person', properties: { q: 'x' } } } }]) {
          const r = await run({ against: 'stamp', ...extra });
          assert.ok(r.refused, `${Object.keys(extra)[0]} with against stamp was answered: ${r.text.slice(0, 200)}`);
          if (door.startsWith('REST')) assert.equal(r.status, 400);
          assert.match(r.text, /against_needs_stored/);
        }
      });
    });
  }

  it('edges of two versions on one page are judged by group, and their endpoints are read once, as in current mode', async () => {
    const client = d.door.mongo.getMongo();
    const reads = async (body) => (await readsDuring(client, `${V}_entities`, () => DOORS['MCP schema_validate'](body)));
    const cur = await reads({ against: 'current' });
    const stamp = await reads({ against: 'stamp' });
    assert.equal(stamp.result.body?.against, 'stamp', 'stamp mode is not what ran');
    assert.equal(stamp.sent.length, cur.sent.length, `stamp mode read the entities ${stamp.sent.length} times, current mode ${cur.sent.length}: endpoints are read per version group`);
  });

  it('the new request key and answer keys are where the integration guide documents the check (06a, Validate Schema)', async () => {
    const stamp = await DOORS['MCP schema_validate']({ against: 'stamp' });
    const keys = ['against', ...Object.keys(stamp.body?.skipped ?? {})];
    assert.ok(keys.includes('notHeld') && keys.includes('unversioned'), `the answer has no skipped counts: ${JSON.stringify(stamp.body?.skipped)}`);
    assert.deepEqual(await undocumentedKeys('integration-guide/06a-schema-api.md', 'Validate Schema', [...keys, 'skipped', 'against_needs_stored']), []);
  });
});
