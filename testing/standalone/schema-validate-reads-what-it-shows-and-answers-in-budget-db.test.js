/**
 * The stored-data schema check reads what it shows, answers within a byte budget, and refuses a bad body with the whole refusal
 * (b23 pre-ship wave 6, findings A1, P1 + Q-488, P2) — on both doors, `POST /api/spaces/:id/validate-schema` and MCP `schema_validate`.
 *
 * ## What is held
 *
 * 1. **A1 — a bad body answers `{ error, issues }`**, as every other parse door does (`refusalOfParse`), on REST and, as the
 *    tool's `structuredContent`, on MCP; the prose is the same sentence on both.
 * 2. **P1 — a page stops reading when it is full.** A stored-data call stops after the record that filled its `limit` violation rows
 *    (or at the scan bound, or the end) and does not read on to count violations it will not show. `progress.checked` is what THIS
 *    call read, `progress.total` is the space's record count, and the `checked` of the pages sums to the record count when the walk
 *    reaches its end — no record is read on two pages. `totalViolations` is gone.
 * 3. **P2 — the answer goes through the byte budget.** `maxChars` / `maxBytes` / `maxTokens` are taken on both doors; the default
 *    differs by door (the one sanctioned divergence: 25 000 on MCP, 50 000 on REST), both disclose the number they used, a page cut by
 *    the budget continues with `nextAfter` and no violating record is lost or repeated; `staleGuards` is cut to the page and a guard
 *    is reported once across pages.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/schema-validate-reads-what-it-shows-and-answers-in-budget-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import {
  scratchEnv, response, rightsAt, routeOf, requestOf, callMcp, resetConfig,
} from './_cel-doors.mjs';

const skip = await mongoSkipReason();
const scratch = scratchEnv('ythril-validate-budget-');
const { rule, typeSchemasOf } = await import('./_cel-rules.mjs');

const SPACE = 'valbudget';
const PROPOSED = { validationMode: 'strict', typeSchemas: typeSchemasOf('entity', 'thing', { below: rule('self.properties.b < 100.0', 'b must be below one hundred') }) };
/** No declared property: a stored `b` is "Not declared", and the row carries its (bounded) stored value. */
const UNDECLARED = { validationMode: 'strict', typeSchemas: typeSchemasOf('entity', 'thing', undefined) };

let mongo, restValidate, reader;

const entities = () => mongo.col(`${SPACE}_entities`);
const edges = () => mongo.col(`${SPACE}_edges`);
const idOf = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const entity = (i, properties) => ({
  _id: idOf(i), spaceId: SPACE, name: `Seeded ${i}`, type: 'thing', description: '', tags: [], properties, seq: i,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', author: { instanceId: 'valbudget', instanceLabel: 'test' },
});
const edge = (i, extra = {}) => ({
  _id: idOf(i), spaceId: SPACE, from: idOf(900_001), to: idOf(900_002), label: `rel-${i}`, fromKind: 'entity', toKind: 'entity',
  description: '', tags: [], properties: {}, seq: i, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  author: { instanceId: 'valbudget', instanceLabel: 'test' }, ...extra,
});

const safeJson = (t) => { try { return JSON.parse(t); } catch { return undefined; } };
async function viaRest(body) {
  const res = response();
  try { await restValidate.at(-1)(requestOf({ params: { id: SPACE }, body, rights: reader }), res, () => {}); }
  catch (err) { res.status(err?.status ?? 500).json({ error: String(err?.message ?? err) }); }
  return { status: res.statusCode, refused: res.statusCode >= 400, body: res.body, text: JSON.stringify(res.body ?? '') };
}
async function viaMcp(body) {
  const o = await callMcp('schema_validate', { space: SPACE, ...body }, reader);
  return { status: o.status, refused: o.isError, body: o.structured ?? safeJson(o.text), structured: o.structured, text: o.text };
}
const DOORS = { REST: viaRest, MCP: viaMcp };

/** Page a check to its end; every page is kept. */
async function pageThrough(run, body, maxPages = 40) {
  const pages = [];
  let continuation = {};
  for (let i = 0; i < maxPages; i++) {
    const a = await run({ ...body, ...continuation });
    assert.equal(a.refused, false, `page ${i}: ${a.text.slice(0, 300)}`);
    pages.push(a.body);
    if (a.body.nextAfter === undefined) return pages;
    continuation = { after: a.body.nextAfter };
  }
  assert.fail(`the check did not end in ${maxPages} pages`);
}

describe('the stored-data schema check reads what it shows and answers within a budget', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('valbudget');
    await resetConfig(scratch.configPath, { spaces: [{ id: SPACE, label: 'Validate budget', folders: [], completeLinkage: true,
      meta: { validationMode: 'strict', suppressEmbeddings: true, typeSchemas: typeSchemasOf('entity', 'thing', undefined) } }] });
    const { spacesRouter } = await import('../../server/dist/api/spaces.js');
    restValidate = routeOf(spacesRouter, 'post', '/:id/validate-schema');
    // schema admin: a stored-data check of a PROPOSED rule needs the right to save it (b23 wave 7, S2); knowledge read: the values these cases read.
    reader = await rightsAt(SPACE, { schema: 'admin', knowledge: 'read' });
  });
  after(async () => { await closeTestMongo(); scratch.cleanup(); });

  describe('A1: a bad body is refused with the whole refusal, on both doors', () => {
    it('{ error, issues } on REST, the same issues as the tool\'s structuredContent, and the same sentence', async () => {
      const bad = { limit: 0, after: 7 };
      const rest = await viaRest(bad);
      const mcp = await viaMcp(bad);
      assert.equal(rest.status, 400, rest.text.slice(0, 300));
      assert.equal(mcp.status, 400, mcp.text.slice(0, 300));
      assert.ok(Array.isArray(rest.body.issues) && rest.body.issues.length >= 2, `REST dropped \`issues\`: ${rest.text.slice(0, 300)}`);
      const paths = rest.body.issues.map(i => i.path.join('.'));
      assert.ok(paths.includes('limit') && paths.includes('after'), `the issues do not name the failing parameters: ${paths.join(', ')}`);
      assert.ok(mcp.structured && Array.isArray(mcp.structured.issues), `the tool dropped \`issues\`: ${mcp.text.slice(0, 300)}`);
      assert.deepEqual(mcp.structured.issues, rest.body.issues, 'the two doors name different issues for one body');
      assert.equal(mcp.structured.error, rest.body.error, 'the two doors word the refusal differently');
      assert.equal(mcp.text.replace(/^Error:\s*/, ''), rest.body.error, 'the tool\'s text is not the REST error');
    });
  });

  describe('P1: a page stops reading when it is full, and `progress` sums to the space', () => {
    const TOTAL = 1250;
    for (const [door, run] of Object.entries(DOORS)) {
      it(`${door}: limit 100 over ${TOTAL} records (625 violating, more than one read page) reads up to the last returned one, and the pages sum to ${TOTAL}`, async () => {
        await edges().deleteMany({});
        await entities().deleteMany({});
        await entities().insertMany(Array.from({ length: TOTAL }, (_, k) => entity(k + 1, { b: (k + 1) % 2 === 0 ? 500 : 5 })));

        // A budget no page reaches, so it is `limit` that ends each page: the MCP default (25 000, half per carriage) holds ~70 of these rows.
        const pages = await pageThrough(run, { meta: PROPOSED, limit: 100, maxChars: 1_000_000 });
        const first = pages[0];
        const lastOfFirst = first.violations.at(-1)._id;
        const upToLast = Number(lastOfFirst.slice(-12));
        assert.equal(first.violations.length, 100, `fixture: the first page is not full: ${first.violations.length}`);
        assert.ok(first.progress.checked <= upToLast,
          `${door}: page 1 reports ${first.progress.checked} records read, more than the ${upToLast} up to its last returned record: it read on to count violations it did not show`);
        assert.equal(first.progress.total, TOTAL, `${door}: progress.total is not the space's record count`);
        assert.ok(!('totalViolations' in first), `${door}: \`totalViolations\` is still answered`);
        assert.equal(first.complete, false);

        let sum = 0;
        const seen = [];
        for (const p of pages) {
          assert.ok(!('totalViolations' in p), `${door}: \`totalViolations\` is still answered`);
          assert.ok(p.violations.length <= 100, `${door}: a page holds ${p.violations.length} records`);
          sum += p.progress.checked;
          seen.push(...p.violations.map(v => v._id));
        }
        assert.equal(sum, TOTAL, `${door}: the pages' progress.checked sums to ${sum}, not ${TOTAL}: a record was read on two pages or never`);
        assert.equal(new Set(seen).size, seen.length, `${door}: a violating record came back on two pages`);
        assert.equal(seen.length, TOTAL / 2, `${door}: ${seen.length} violating records came back of ${TOTAL / 2}`);
        assert.equal(pages.at(-1).complete, true);
        assert.equal(pages.at(-1).nextAfter, undefined);
      });
    }

    it('`total` is the count when the check started, from the collection metadata: the answer carries it on both doors alike', async () => {
      // One after the other: a space runs one stored-data check at a time, and a second at once is a 409.
      const rest = await viaRest({ meta: PROPOSED, limit: 3 });
      const mcp = await viaMcp({ meta: PROPOSED, limit: 3 });
      assert.equal(rest.status, 200, rest.text.slice(0, 200));
      assert.equal(mcp.status, 200, mcp.text.slice(0, 200));
      assert.deepEqual(mcp.body.progress, rest.body.progress, 'the two doors answer different progress for one first page');
      assert.deepEqual(Object.keys(rest.body.progress).sort(), ['checked', 'total']);
    });
  });

  describe('P2: the answer is held to a budget on both doors, and a guard is reported once', () => {
    const N = 40;
    const seedBig = async () => {
      await edges().deleteMany({});
      await entities().deleteMany({});
      await entities().insertMany(Array.from({ length: N }, (_, k) => entity(k + 1, { b: 'y'.repeat(3000) })));
    };

    for (const [door, run, budget] of [['REST', viaRest, 50_000], ['MCP', viaMcp, 25_000]]) {
      it(`${door}: the default budget (${budget}) holds the answer, discloses the number used, and paging loses and repeats nothing`, async () => {
        await seedBig();
        const first = await run({ meta: UNDECLARED });
        assert.equal(first.refused, false, first.text.slice(0, 300));
        assert.equal(first.body.budgetChars, budget, `${door}: the budget it says it used`);
        assert.equal(first.body.truncated, true, `${door}: ${N} records of 3 KB went out whole, past the budget`);
        assert.ok(first.text.length <= budget, `${door}: the answer is ${first.text.length} characters, over its ${budget} budget`);
        assert.equal(typeof first.body.nextAfter, 'string', `${door}: a page cut by the budget has no \`nextAfter\``);
        assert.equal(first.body.complete, false);
        assert.ok(first.body.violations.length >= 1 && first.body.violations.length < N);

        const pages = await pageThrough(run, { meta: UNDECLARED });
        const seen = pages.flatMap(p => p.violations.map(v => v._id));
        assert.equal(seen.length, N, `${door}: ${seen.length} of ${N} violating records came back`);
        assert.equal(new Set(seen).size, N, `${door}: a record came back on two pages`);
        assert.equal(pages.reduce((n, p) => n + p.progress.checked, 0), N, `${door}: the pages' checked does not sum to the space`);
      });
    }

    it('both doors take the same size parameters: a stated maxChars is honoured as stated, and a bad one is the same 400', async () => {
      await seedBig();
      for (const [door, run] of Object.entries(DOORS)) {
        const small = await run({ meta: UNDECLARED, maxChars: 1000 });
        assert.equal(small.refused, false, small.text.slice(0, 300));
        assert.equal(small.body.budgetChars, 1000, `${door}: the stated budget is not the one disclosed`);
        assert.equal(small.body.violations.length, 1, `${door}: a 1000-character budget holds one whole record (the first always fits)`);
        const bytes = await run({ meta: UNDECLARED, maxBytes: 20_000 });
        assert.equal(bytes.body.budgetBytes, 20_000, `${door}: maxBytes is not disclosed`);
        const tokens = await run({ meta: UNDECLARED, maxTokens: 2000 });
        assert.equal(tokens.body.budgetChars, 7000, `${door}: maxTokens is not converted`);
      }
      const [r, m] = [await viaRest({ meta: UNDECLARED, maxChars: 'many' }), await viaMcp({ meta: UNDECLARED, maxChars: 'many' })];
      assert.equal(r.status, 400, r.text.slice(0, 200));
      assert.equal(m.status, 400, m.text.slice(0, 200));
      assert.equal(m.text.replace(/^Error:\s*/, ''), r.body.error, 'the doors refuse a bad budget in different words');
    });

    for (const [door, run] of Object.entries(DOORS)) {
      it(`${door}: \`staleGuards\` is cut to the page and a guard is named once across pages`, async () => {
        await edges().deleteMany({});
        await entities().deleteMany({});
        const GUARDS = 30;
        await edges().insertMany(Array.from({ length: GUARDS }, (_, k) => edge(k + 1, { _functionalGuard: `not-this-edge-${k}` })));
        const pages = await pageThrough(run, { meta: UNDECLARED, limit: 5 });
        const named = [];
        for (const p of pages) {
          assert.ok((p.staleGuards ?? []).length <= 5, `${door}: a page of limit 5 names ${(p.staleGuards ?? []).length} guards`);
          named.push(...(p.staleGuards ?? []).map(g => g._id));
        }
        assert.equal(named.length, GUARDS, `${door}: ${named.length} guards named across the pages, ${GUARDS} are stale`);
        assert.equal(new Set(named).size, GUARDS, `${door}: a stale guard was named on two pages`);
        assert.ok(pages.length >= GUARDS / 5, `${door}: the guards did not page (${pages.length} pages)`);
      });
    }
  });
});
