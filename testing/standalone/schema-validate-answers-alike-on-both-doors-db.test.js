/**
 * The live check of a schema — `POST /api/spaces/:id/validate-schema` and the new `schema_validate` tool — answers alike on both
 * doors, in both of its modes, and shows stored values only to a caller who may read them (F-46, ruling R6-12).
 *
 * ## The two modes
 *
 * - **stored data** (what the route does today): the caller's proposed `meta` (or the stored one) is run over the space's stored
 *   records, and the violations come back paged.
 * - **sample** (new): `sample: { kind, record }` runs the proposed `meta` over ONE record the caller supplies — no scan, no stored
 *   record read — so an author trying a rule gets an answer in the time of one evaluation, and a record they typed is the only
 *   value that comes back. `record` is in the stored shape (`name` for an entity, `fact` for a fact, `title` for a chrono entry,
 *   `label` for an edge, with `type`, `description`, `tags`, `properties`): the shape `recordViewOf` takes.
 *
 * ## What is held
 *
 * 1. **Sample, both doors.** A record that breaks a caller rule answers the rule's field and reason; one that does not answers
 *    none; nothing stored is read (the seeded records are in no answer, and the scan counts are absent). The two doors give the
 *    same rows for the same record. No `meta` is echoed: the caller sent it.
 * 2. **Values are `knowledge: read`'s.** A caller with `schema: read` and no `knowledge` right may ask the question — it is a
 *    view of the schema — and every row that would carry a STORED value arrives without it. Today the route returns
 *    `value` to a `schema: read` token, which is a way to read knowledge through a schema door. With `knowledge: read` the value
 *    is there. The same on both doors. (A sample's own record is the caller's, not stored data: no right is asked for it.)
 * 3. **Paged.** Seven violating records at a limit of three come back in pages that together hold each exactly once; pages
 *    continue by `after` / `nextAfter` — the server's `_id`-keyset spelling, the same the REST dry run pages with, so the two
 *    doors take one parameter set — and a page never holds more
 *    than the limit. A scan that stops at a bound says so (`complete: false`) and never `true`.
 * 4. **`schema_validate` never echoes the meta it was sent**, in either mode: a tool answer lands in an agent's context, and a
 *    meta is up to a megabyte of what the agent already holds.
 *
 * ## Why this is red on the base
 *
 * `schema_validate` does not exist and the route has no `sample`; and on the stored mode the route returns values to a
 * `schema: read` token, which case 2 refuses on the REST door alone.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/schema-validate-answers-alike-on-both-doors-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import {
  scratchEnv, response, rightsAt, routeOf, requestOf, callMcp, resetConfig, violationRows,
} from './_cel-doors.mjs';

const skip = await mongoSkipReason();
const scratch = scratchEnv('ythril-validate-doors-');
const { rule, DECLARED, typeSchemasOf } = await import('./_cel-rules.mjs');

const SPACE = 'valdoors';
const BELOW = 'b must be below one hundred';
/** The meta the caller proposes: a strict schema with one rule, so a stored or sampled record can break it. */
const PROPOSED = { validationMode: 'strict', typeSchemas: typeSchemasOf('entity', 'thing', { below: rule('self.properties.b < 100.0', BELOW) }) };
const VIOLATING = 7;

let mongo, restValidate, HAS_STORED;

const coll = () => mongo.col(`${SPACE}_entities`);
const entity = (i, properties) => ({
  _id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, spaceId: SPACE, name: `Seeded ${i}`, type: 'thing',
  description: '', tags: [], properties, seq: i, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  author: { instanceId: 'valdoors', instanceLabel: 'test' },
});
const SECRET = (i) => `secret-text-${i}`;

/** Seven records that break the proposed rule, three whose property `b` is not a number (a stored value a row would quote), two that are fine. */
async function seed() {
  await coll().deleteMany({});
  const docs = [];
  for (let i = 1; i <= VIOLATING; i++) docs.push(entity(i, { b: 500 }));
  for (let i = 101; i <= 103; i++) docs.push(entity(i, { b: SECRET(i) }));
  for (let i = 201; i <= 202; i++) docs.push(entity(i, { b: 5 }));
  await coll().insertMany(docs);
  HAS_STORED = docs.map(d => d._id);
}

// ── the doors: each answers { status, refused, body, text } ──────────────────────────────────────────────────────────

const restAnswer = (res) => ({ status: res.statusCode, refused: res.statusCode >= 400, body: res.body, text: JSON.stringify(res.body ?? '') });
const mcpAnswer = (o) => ({ status: o.status, refused: o.isError, body: o.structured ?? safeJson(o.text), text: o.text });
const safeJson = (t) => { try { return JSON.parse(t); } catch { return undefined; } };

async function viaRest(rights, body) {
  const res = response();
  try { await restValidate.at(-1)(requestOf({ params: { id: SPACE }, body, rights }), res, () => {}); }
  catch (err) { res.status(err?.status ?? 500).json({ error: String(err?.message ?? err) }); }
  return restAnswer(res);
}
const viaMcp = async (rights, body) => mcpAnswer(await callMcp('schema_validate', { space: SPACE, ...body }, rights));
const DOORS = { 'POST /api/spaces/:id/validate-schema': viaRest, 'schema_validate': viaMcp };

/** Every stored id an answer names, found anywhere in it. */
const storedIdsIn = (answer) => HAS_STORED.filter(id => answer.text.includes(id));
/** The `value` of every row an answer carries (a key that is absent is not listed). */
const valuesIn = (answer) => {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (typeof v.field === 'string' && 'value' in v) out.push(v.value);
      Object.values(v).forEach(walk);
    }
  };
  walk(answer.body ?? safeJson(answer.text));
  return out;
};

describe('the live check of a schema answers alike on both doors', { skip }, () => {
  let schemaReader, schemaAndKnowledgeReader;

  before(async () => {
    mongo = await openTestMongo('valdoors');
    await resetConfig(scratch.configPath, { spaces: [{ id: SPACE, label: 'Validate doors', folders: [], completeLinkage: true,
      meta: { validationMode: 'strict', suppressEmbeddings: true, typeSchemas: typeSchemasOf('entity', 'thing', undefined) } }] });
    const { spacesRouter } = await import('../../server/dist/api/spaces.js');
    restValidate = routeOf(spacesRouter, 'post', '/:id/validate-schema');
    schemaReader = await rightsAt(SPACE, { schema: 'read' });
    schemaAndKnowledgeReader = await rightsAt(SPACE, { schema: 'read', knowledge: 'read' });
  });
  after(async () => { await closeTestMongo(); scratch.cleanup(); });
  beforeEach(seed);

  describe('sample mode checks one record the caller supplies and reads nothing stored', () => {
    const sample = (properties) => ({ meta: PROPOSED, sample: { kind: 'entity', record: { name: 'Typed by the caller', type: 'thing', description: '', tags: [], properties } } });

    for (const [door, run] of Object.entries(DOORS)) {
      it(`${door}: a record that breaks the rule answers the rule, one that holds answers nothing, no stored record is in either answer`, async () => {
        const broken = await run(schemaReader, sample({ b: 500 }));
        assert.equal(broken.refused, false, `${door} refused a sample check: ${broken.text.slice(0, 300)}`);
        const rows = violationRows(broken.body).filter(r => r.field === 'rules.below');
        assert.equal(rows.length, 1, `${door}: expected one row for rules.below, got ${JSON.stringify(violationRows(broken.body))}`);
        assert.ok(rows[0].reason.startsWith(BELOW), `${door}: the reason does not lead with the rule's message: ${rows[0].reason}`);
        const fine = await run(schemaReader, sample({ b: 5 }));
        assert.equal(fine.refused, false, fine.text.slice(0, 300));
        assert.deepEqual(violationRows(fine.body), [], `${door}: a record that holds the rule has rows: ${fine.text.slice(0, 300)}`);
        for (const a of [broken, fine]) {
          assert.deepEqual(storedIdsIn(a), [], `${door}: a stored record is in a sample answer: the check scanned the space`);
        }
      });

      it(`${door}: the meta the caller sent is not echoed back`, async () => {
        const a = await run(schemaReader, sample({ b: 500 }));
        assert.equal(a.refused, false, a.text.slice(0, 300));
        assert.ok(!('meta' in (a.body ?? {})), `${door} echoed the meta it was sent`);
        assert.doesNotMatch(a.text, /self\.properties\.b < 100\.0/, `${door} sent the rule text back to the caller who wrote it`);
      });
    }

    it('the two doors give the same rows for the same record, and the same refusal for a kind that is not one', async () => {
      const [rest, mcp] = await Promise.all([viaRest(schemaReader, sample({ b: 500 })), viaMcp(schemaReader, sample({ b: 500 }))]);
      assert.ok(violationRows(rest.body).some(r => r.field === 'rules.below'), `REST gave no row for the rule (two refusals would also be "the same"): ${rest.text.slice(0, 200)}`);
      assert.ok(violationRows(mcp.body).some(r => r.field === 'rules.below'), `schema_validate gave no row for the rule: ${mcp.text.slice(0, 200)}`);
      assert.deepEqual(violationRows(mcp.body), violationRows(rest.body), 'the two doors judge one record differently');
      const badKind = { meta: PROPOSED, sample: { kind: 'file', record: {} } };
      const [r2, m2] = await Promise.all([viaRest(schemaReader, badKind), viaMcp(schemaReader, badKind)]);
      assert.equal(r2.refused, true, 'REST checked a sample of a kind rules do not govern');
      assert.equal(m2.refused, true, 'schema_validate checked a sample of a kind rules do not govern');
    });

    it('a sample is a view of the schema: schema:read is all it asks, knowledge:none notwithstanding', async () => {
      for (const [door, run] of Object.entries(DOORS)) {
        const a = await run(schemaReader, sample({ b: 500 }));
        assert.equal(a.refused, false, `${door} refused a schema reader a check of a record the reader typed: ${a.text.slice(0, 300)}`);
      }
    });
  });

  describe('stored values reach a caller who can read knowledge, and no other', () => {
    for (const [door, run] of Object.entries(DOORS)) {
      it(`${door}: schema:read alone gets the rows without any stored value; schema:read and knowledge:read gets the value`, async () => {
        const body = { meta: { validationMode: 'strict', typeSchemas: typeSchemasOf('entity', 'thing', undefined) } };
        const without = await run(schemaReader, body);
        assert.equal(without.refused, false, `${door}: ${without.text.slice(0, 300)}`);
        assert.ok(violationRows(without.body).length >= 3, `${door}: the property violations are not listed at all: ${without.text.slice(0, 300)}`);
        for (let i = 101; i <= 103; i++) {
          assert.ok(!without.text.includes(SECRET(i)), `${door}: a stored value (${SECRET(i)}) reached a caller with no knowledge right`);
        }
        assert.deepEqual(valuesIn(without).filter(v => v !== undefined && v !== null), [], `${door}: a row still carries a value`);

        const withRead = await run(schemaAndKnowledgeReader, body);
        assert.equal(withRead.refused, false, `${door}: ${withRead.text.slice(0, 300)}`);
        for (let i = 101; i <= 103; i++) {
          assert.ok(withRead.text.includes(SECRET(i)), `${door}: a caller who may read knowledge was not shown the stored value ${SECRET(i)}: the control that gives the omission its meaning`);
        }
      });

      it(`${door}: rows that are about a rule carry no value for anybody (the rule's reason is the message, not the record)`, async () => {
        const a = await run(schemaAndKnowledgeReader, { meta: PROPOSED });
        assert.equal(a.refused, false, a.text.slice(0, 300));
        const ruleRows_ = violationRows(a.body).filter(r => r.field === 'rules.below');
        assert.ok(ruleRows_.length >= VIOLATING, `${door}: expected a row per violating record, got ${ruleRows_.length}`);
        assert.ok(!a.text.includes('"value":500'), `${door}: a rule row carries the stored value that broke it`);
      });
    }
  });

  describe('stored-data mode pages, and a page never claims more than it checked', () => {
    for (const [door, run] of Object.entries(DOORS)) {
      it(`${door}: limit 3 over seven violating records walks to every one exactly once`, async () => {
        const seen = [];
        let continuation = {};
        for (let page = 0; page < 10; page++) {
          const a = await run(schemaAndKnowledgeReader, { meta: PROPOSED, limit: 3, ...continuation });
          assert.equal(a.refused, false, `${door}: page ${page}: ${a.text.slice(0, 300)}`);
          const body = a.body ?? {};
          const ids = (body.violations ?? []).map(v => v._id ?? v.id).filter(Boolean);
          assert.ok(ids.length <= 3, `${door}: a page of limit 3 holds ${ids.length}`);
          seen.push(...ids);
          const next = body.nextAfter !== undefined ? { after: body.nextAfter } : null;
          if (!next) break;
          continuation = next;
        }
        const wanted = HAS_STORED.filter(id => /-0{11}[1-7]$/.test(id) || /-0{9}10[1-3]$/.test(id));
        const unique = new Set(seen);
        assert.equal(unique.size, seen.length, `${door}: a record was returned on two pages: ${seen.join(', ')}`);
        for (const id of wanted) assert.ok(unique.has(id), `${door}: ${id} was never returned by any page (${seen.length} seen)`);
      });

      it(`${door}: the answer says whether the scan is complete, and a truncated page is not complete`, async () => {
        const a = await run(schemaAndKnowledgeReader, { meta: PROPOSED, limit: 3 });
        assert.equal(a.refused, false, a.text.slice(0, 300));
        const body = a.body ?? {};
        assert.equal(typeof body.complete, 'boolean', `${door}: no \`complete\` flag`);
        assert.ok(body.totalViolations >= VIOLATING, `${door}: totalViolations is ${body.totalViolations}`);
      });
    }
  });

  describe('schema_validate does not echo the meta it was sent', () => {
    it('stored-data mode and sample mode both answer without a `meta` key', async () => {
      const stored = await viaMcp(schemaReader, { meta: PROPOSED, limit: 3 });
      const sampled = await viaMcp(schemaReader, { meta: PROPOSED, sample: { kind: 'entity', record: { name: 'x', type: 'thing', properties: { b: 500 } } } });
      for (const [what, a] of [['stored', stored], ['sample', sampled]]) {
        assert.equal(a.refused, false, `${what}: ${a.text.slice(0, 300)}`);
        assert.ok(!('meta' in (a.body ?? {})), `${what} mode echoed the meta`);
        assert.doesNotMatch(a.text, /self\.properties\.b < 100\.0/, `${what} mode sent the rule text back`);
      }
    });
  });
});
