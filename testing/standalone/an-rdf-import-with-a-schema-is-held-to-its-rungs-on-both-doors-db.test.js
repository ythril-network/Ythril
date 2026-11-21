/**
 * An RDF data import that asks for a schema is held to the schema door's rungs, parameters and bounds on both doors (bundle-270, Q-955, tests
 * 3, 4, 5, 15, 17, 18, 20 and 23 of its plan): `POST /api/brain/spaces/:spaceId/import/rdf?schema=&from=` and MCP `import_rdf`.
 *
 * ## What it holds
 *
 * - `knowledge: write` without `schema: write` is refused 403 naming `schema: write`, a dry run too (3); shapes that give a type rules need
 *   `schema: admin` (4); both on both doors (17).
 * - A networked space answers 409 `schema_rdf_networked` carrying the proposed types; its dry run answers 200 and writes nothing (5, 17).
 * - `from` without `schema` is refused 400 `rdf_import_bad_param` (15); `from: data` answers `rdf_import_schema_not_available` (23).
 * - REST without the second factor is refused when `schema` is set, and passes as today when it is not (18).
 * - More schema statements than the bound answer 413 before the mapping runs (20).
 * - Nothing a refused call names is stored.
 *
 * Run: node --test testing/standalone/an-rdf-import-with-a-schema-is-held-to-its-rungs-on-both-doors-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfImportSchemaDoors, spaceWith, baseOf, fileOf } from './_rdf-import-schema-doors.mjs';

const skip = await mongoSkipReason();
const STRICT = { validationMode: 'strict' };
const TARGET = 'rdfisrtarget';
const RULED = 'rdfisrruled';
const RULES = { rest: 'rdfisrrulesr', mcp: 'rdfisrrulesm' };
const NET = 'rdfisrnet';
const MFA = 'rdfisrmfa';
const BOUND = 'rdfisrbound';
const RULED_TYPES = { entity: { person: { propertySchemas: { age: { type: 'number' } }, rules: { described: { rule: 'size(self.description) > 0', message: 'a description is needed' } } } } };
/** The write rung of the schema area named, in either door's words. */
const WRITE_RUNG = /'write' on schema|schema: write/;
const IDS = [TARGET, ...Object.values(RULES), NET, MFA, BOUND];

describe('an RDF import with a schema is held to its rungs on both doors (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, admin, tokens = {}, act, schemaAct, totp, ruledFile;
  before(async () => {
    d = await openRdfImportSchemaDoors({
      suite: 'rdf_import_schema_rungs',
      spaces: [...IDS.map(id => spaceWith(id, undefined, STRICT)), spaceWith(RULED, RULED_TYPES)],
    });
    admin = await d.mint('rdf-import-schema-rungs-admin', {}, { admin: true });
    const on = (rungs) => Object.fromEntries(IDS.map(id => [id, d.row(rungs)]));
    tokens.reader = await d.mint('rdf-import-schema-rungs-read', on({ knowledge: 'write', schema: 'read' }));
    tokens.writer = await d.mint('rdf-import-schema-rungs-write', on({ knowledge: 'write', schema: 'write' }));
    act = await import('../../server/dist/spaces/rdf-import-act.js');
    schemaAct = await import('../../server/dist/spaces/schema-rdf-import-act.js');
    totp = await import('../../server/dist/auth/totp.js');
    ruledFile = await d.exportTurtle(admin.key, RULED);
  });
  after(async () => { act?.setRdfImportKnobsForTest?.(null); schemaAct?.setSchemaRdfImportKnobsForTest?.(null); totp?.disableMfa?.(); await d?.close(); });

  /** Both doors refused with `code` (and REST with `status`), and nothing stored in `spaces`. */
  async function refusedOnBoth({ rest, mcp }, spaces, what, { status, code, text } = {}) {
    if (status !== undefined) assert.equal(rest.status, status, `${what}, REST: ${rest.text.slice(0, 300)}`);
    assert.equal(mcp.isError, true, `${what}, MCP: ${mcp.text.slice(0, 300)}`);
    if (code !== undefined) {
      assert.equal(rest.code, code, `${what}, REST code: ${rest.text.slice(0, 300)}`);
      assert.equal(mcp.code, code, `${what}, MCP code: ${mcp.text.slice(0, 300)}`);
    }
    if (text) {
      assert.match(rest.text, text, `${what}, REST names it`);
      assert.match(mcp.text, text, `${what}, MCP names it`);
    }
    for (const id of [spaces].flat()) {
      assert.deepEqual(d.heldTypes(id), {}, `${what}: a type was stored in ${id}`);
      assert.deepEqual(await d.records(id, 'entities'), [], `${what}: a record was stored in ${id}`);
    }
  }

  it('3, 17: knowledge: write without schema: write is refused 403 naming schema: write, a dry run too, on both doors', async () => {
    const dry = await d.importBoth(tokens.reader.key, TARGET, fileOf(), { schema: 'expand', dryRun: true });
    await refusedOnBoth(dry, TARGET, 'dry run with schema: read', { status: 403, code: 'schema_rdf_rung', text: WRITE_RUNG });
    const real = await d.importBoth(tokens.reader.key, TARGET, fileOf(), { schema: 'expand' });
    await refusedOnBoth(real, TARGET, 'import with schema: read', { status: 403, code: 'schema_rdf_rung', text: WRITE_RUNG });
  });

  it('4, 17: shapes that give a type rules need schema: admin, a dry run too, on both doors; an administrator\'s import is written', async () => {
    const params = { schema: 'expand', sourceBase: baseOf(RULED) };
    await refusedOnBoth(await d.importBoth(tokens.writer.key, [RULES.rest, RULES.mcp], ruledFile, { ...params, dryRun: true }), [RULES.rest, RULES.mcp], 'ruled dry run', { status: 403, code: 'schema_rdf_rung', text: /rules/ });
    await refusedOnBoth(await d.importBoth(tokens.writer.key, [RULES.rest, RULES.mcp], ruledFile, params), [RULES.rest, RULES.mcp], 'ruled import', { status: 403, code: 'schema_rdf_rung', text: /rules/ });
    const byAdmin = await d.importRestOne(admin.key, RULES.rest, ruledFile, params);
    assert.equal(byAdmin.status, 200, byAdmin.text.slice(0, 300));
    assert.deepEqual(d.heldTypes(RULES.rest).entity.person.rules, RULED_TYPES.entity.person.rules);
  });

  it('5, 17: a networked space answers 409 carrying the proposed types; its dry run answers 200 and writes nothing, on both doors', async () => {
    await d.joinNetwork('rdfisrnetwork', NET);
    const v = d.versionOf(NET);
    const real = await d.importBoth(tokens.writer.key, NET, fileOf(), { schema: 'expand' });
    await refusedOnBoth(real, NET, 'networked import', { status: 409, code: 'schema_rdf_networked' });
    assert.ok(real.rest.body?.proposed?.typeSchemas?.entity?.Person, `REST carries the proposed types: ${real.rest.text.slice(0, 300)}`);
    assert.ok(real.mcp.body?.proposed?.typeSchemas?.entity?.Person, `MCP carries the proposed types: ${real.mcp.text.slice(0, 300)}`);
    const dry = await d.importBoth(tokens.writer.key, NET, fileOf(), { schema: 'expand', dryRun: true });
    assert.equal(dry.rest.status, 200, `REST dry run: ${dry.rest.text.slice(0, 300)}`);
    assert.equal(dry.mcp.isError, false, `MCP dry run: ${dry.mcp.text.slice(0, 300)}`);
    assert.equal(d.versionOf(NET), v, 'nothing was written');
    assert.deepEqual(d.heldTypes(NET), {});
    assert.equal(d.roundsOf('rdfisrnetwork'), 0, 'no round opened');
  });

  it('15: from without schema (or with schema none) is refused 400 rdf_import_bad_param on both doors', async () => {
    await refusedOnBoth(await d.importBoth(tokens.writer.key, TARGET, fileOf(), { from: ['shacl'], dryRun: true }), TARGET, 'from without schema', { status: 400, code: 'rdf_import_bad_param', text: /from/ });
    await refusedOnBoth(await d.importBoth(tokens.writer.key, TARGET, fileOf(), { schema: 'none', from: ['shacl'], dryRun: true }), TARGET, 'from with schema none', { status: 400, code: 'rdf_import_bad_param', text: /from/ });
  });

  it('23: from: data answers rdf_import_schema_not_available on both doors, naming from: data', async () => {
    const r = await d.importBoth(tokens.writer.key, TARGET, fileOf(), { schema: 'expand', from: ['data'] });
    await refusedOnBoth(r, TARGET, 'from data', { status: 400, code: 'rdf_import_schema_not_available', text: /from: data/ });
  });

  it('18: REST without the second factor is refused when schema is set, and passes as today when it is not', async () => {
    totp.enableMfa('Ythril', 'admin');
    try {
      const plain = await d.importRestOne(tokens.writer.key, MFA, fileOf(), { dryRun: true });
      assert.notEqual(plain.status, 403, `an import without schema asks no second factor: ${plain.text.slice(0, 300)}`);
      assert.ok(!/MFA/.test(plain.text), plain.text.slice(0, 300));
      const withSchema = await d.importRestOne(tokens.writer.key, MFA, fileOf(), { schema: 'expand', dryRun: true });
      assert.equal(withSchema.status, 403, withSchema.text.slice(0, 300));
      assert.equal(withSchema.body?.error, 'MFA_REQUIRED');
    } finally { totp.disableMfa(); }
    assert.deepEqual(d.heldTypes(MFA), {});
  });

  it('20: more schema statements than the bound answer 413 before the mapping runs', async () => {
    let mapped = 0;
    assert.equal(typeof act.setRdfImportKnobsForTest, 'function');
    act.setRdfImportKnobsForTest({ schemaMaxQuads: 3 });
    schemaAct.setSchemaRdfImportKnobsForTest({ hooks: { beforeMapping: () => { mapped += 1; } } });
    try {
      const r = await d.importRestOne(tokens.writer.key, BOUND, fileOf(), { schema: 'expand' });
      assert.equal(r.status, 413, r.text.slice(0, 300));
      assert.equal(r.code, 'rdf_bound_exceeded');
      assert.equal(r.body?.bound, 'schemaRdfMaxQuads');
      assert.equal(mapped, 0, 'the mapping ran on a file over the bound');
    } finally { act.setRdfImportKnobsForTest(null); schemaAct.setSchemaRdfImportKnobsForTest(null); }
    assert.deepEqual(d.heldTypes(BOUND), {});
    assert.deepEqual(d.actsOf(BOUND), []);
  });
});
