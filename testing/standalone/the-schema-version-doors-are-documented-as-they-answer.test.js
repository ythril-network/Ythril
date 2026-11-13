/**
 * What the schema-version doors take and answer is what the integration guide says (bundle-267 design r3 §6 "Gates added"; vet docs
 * 5/6/9, I2/I3).
 *
 * ## What is held
 *
 * 1. **The validate request table is the body.** The parameters in the "Validate Schema (Dry Run)" request table of `06a-schema-api.md`
 *    are exactly the keys of `SchemaValidateBody`, and `against` is among them (Q-743). The table was ungated: a key added to the body
 *    and not to the table is a parameter only the source knows.
 * 2. **Every refusal code is answered and documented.** Each code the design gives these doors (`bad_fingerprint`,
 *    `unknown_fingerprint`, `against_needs_fp`, `against_needs_stored`, `schema_index_building`) is a string the server answers (in
 *    `server/src` code, comments stripped) and appears in the schema API page. One condition, one spelling: a version not held is
 *    `unknown_fingerprint` on the user door as on the sync door.
 * 3. **The filter's new arguments are in its three declarations.** `schemaVersion` and `schemaChanged` are in the filter tool's input
 *    schema, in `QUERY_BODY_FIELDS`, and in the 04d "Structured query" section (`client-bodies-match-server` then holds them equal).
 *
 * The response keys of the filter echo, the versions answers and the validate answer are compared with their documented sections in
 * the -db tests that produce them (`a-filter-finds-...`, `a-space-lists-...`, `a-stored-record-is-validated-...`): a key list is only
 * real where a live answer gave it.
 *
 * ## Proven on a plant
 *
 * The table comparison is run on the page with one row removed and must fail; the code search on a planted module that names a code
 * only in a comment must not count it.
 *
 * ## Seen red at b299cde3
 *
 * 1 `against` is in neither the body nor the table; 2 only `bad_fingerprint` and `unknown_fingerprint` exist (on the sync door) and the
 * schema page names none; 3 neither argument exists.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDoc } from './_docs.mjs';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const SCHEMA_PAGE = 'integration-guide/06a-schema-api.md';

/** The parameter names of the request table in the "Validate Schema" section: each first-column cell's backticked names. */
function validateTableKeys(page) {
  const lines = page.split('\n');
  const at = lines.findIndex(l => /^#{2,4}\s.*Validate Schema/.test(l));
  assert.ok(at >= 0, 'the schema page has no "Validate Schema" heading');
  const head = lines.findIndex((l, i) => i > at && /^\|\s*Parameter\s*\|/.test(l));
  assert.ok(head > at, 'the Validate Schema section has no Parameter table');
  const keys = [];
  for (let i = head + 2; i < lines.length && lines[i].startsWith('|'); i++) {
    const first = lines[i].split('|')[1] ?? '';
    for (const m of first.matchAll(/`([A-Za-z_]+)`/g)) keys.push(m[1]);
  }
  return keys.sort();
}

/** Whether `code` is a string literal in this module's code, comments stripped. */
const answersIn = (src, code) => new RegExp(`['"\`]${code}['"\`]`).test(stripComments(src));

describe('the validate request table is SchemaValidateBody', () => {
  it('a table missing a body key fails the comparison (plant)', async () => {
    const { SchemaValidateBody } = await import('../../server/dist/spaces/schema-validate-door.js');
    const page = readDoc(SCHEMA_PAGE);
    const planted = page.split('\n').filter(l => !/^\|\s*`limit`\s*\|/.test(l)).join('\n');
    assert.notDeepEqual(validateTableKeys(planted), Object.keys(SchemaValidateBody.shape).sort(), 'the comparison passes a table with a row taken out');
    // And it passes the page it should become: a table with one row per body key (the budget keys share a row, as on the page).
    const want = [...Object.keys(SchemaValidateBody.shape), 'against'];
    const rows = want.map(k => `| \`${k}\` | meaning |`).join('\n');
    const built = `### Validate Schema (Dry Run)\n\n| Parameter | Meaning |\n|---|---|\n${rows}\n`;
    assert.deepEqual(validateTableKeys(built), [...new Set(want)].sort());
  });

  it('the table names exactly the keys the body takes, and against is one of them', async () => {
    const { SchemaValidateBody } = await import('../../server/dist/spaces/schema-validate-door.js');
    const body = Object.keys(SchemaValidateBody.shape).sort();
    assert.ok(body.includes('against'), 'SchemaValidateBody takes no `against`: Q-743 is not on the REST door');
    assert.deepEqual(validateTableKeys(readDoc(SCHEMA_PAGE)), body);
  });
});

describe('every refusal code of the schema-version doors is answered and documented', () => {
  const CODES = ['bad_fingerprint', 'unknown_fingerprint', 'against_needs_fp', 'against_needs_stored', 'schema_index_building'];
  const sources = trackedSources(['server/src']).filter(p => p.endsWith('.ts')).map(p => readFileSync(join(REPO_ROOT, p), 'utf8'));

  it('a code named only in a comment does not count (plant)', () => {
    assert.equal(answersIn("// answers 'against_needs_fp'\nconst x = 1;\n", 'against_needs_fp'), false);
    assert.equal(answersIn("res.status(400).json({ code: 'against_needs_fp' });\n", 'against_needs_fp'), true);
  });

  for (const code of CODES) {
    it(`${code} is answered by the server and named on the schema page`, () => {
      assert.ok(sources.length > 200, `the walk found ${sources.length} sources`);
      assert.ok(sources.some(s => answersIn(s, code)), `no server module answers ${code}`);
      assert.ok(readDoc(SCHEMA_PAGE).includes(`\`${code}\``), `docs/${SCHEMA_PAGE} does not name ${code}`);
    });
  }
});

describe('the filter\'s schema-version arguments are declared where the filter is', () => {
  for (const arg of ['schemaVersion', 'schemaChanged']) {
    it(`${arg} is in the tool schema, QUERY_BODY_FIELDS and the 04d Structured query section`, async () => {
      const { QUERY_BODY_FIELDS } = await import('../../server/dist/brain/query.js');
      const { queryTool } = await import('../../server/dist/mcp/tools/filter.js');
      assert.equal(queryTool?.name, 'filter', 'mcp/tools/filter.js no longer exports the filter tool as queryTool: re-anchor this test');
      const props = queryTool.inputSchema({ requiredSpace: {}, optionalSpace: {} })?.properties;
      assert.ok(props, 'the filter tool schema has no properties');
      assert.ok(Object.hasOwn(props, arg), `the filter tool schema does not declare ${arg}`);
      assert.ok(QUERY_BODY_FIELDS.has(arg), `QUERY_BODY_FIELDS does not name ${arg}`);
      const page = readDoc('integration-guide/04d-brain-ops-api.md');
      const at = page.indexOf('### Structured query');
      const end = page.indexOf('\n### ', at + 5);
      assert.ok(at >= 0, '04d has no Structured query section');
      assert.ok(page.slice(at, end < 0 ? undefined : end).includes(`\`${arg}\``), `04d Structured query does not document ${arg}`);
    });
  }
});
