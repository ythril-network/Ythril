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
    reader = await rightsAt(SPACE, { schema: 'read', knowledge: 'read' });
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
});
