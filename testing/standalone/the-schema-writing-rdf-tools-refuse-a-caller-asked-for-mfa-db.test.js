/**
 * The two schema-writing RDF tools refuse a caller who would be asked for a second factor on REST (bundle-270, Q-754 and Q-955): MCP
 * `import_schema_rdf` and MCP `import_rdf` with `schema` set, on MCP and on the generic tool door (`POST /api/<tool>`, `requireAuth` only).
 *
 * ## What it holds
 *
 * - With the instance's second factor switched on, a personal access token that inherits the switch is refused 403 by `import_schema_rdf` and by
 *   `import_rdf` with `schema` generate, expand or update (a dry run too, as REST asks it), on both doors, naming the web UI; nothing is stored.
 * - The refusal answers before the document is read: a document that is not RDF is refused for the second factor, not for its syntax.
 * - The same token's `import_rdf` without `schema` (or with `none`) imports, as REST does without the second factor.
 * - A caller not asked (a token exempt from the second factor, or the switch off) builds the schema as before, so a refused call held nothing
 *   (the one-at-a-time schema slot is free for the next).
 *
 * Why: `POST /api/spaces/:id/schema-rdf` and `POST /api/brain/spaces/:spaceId/import/rdf` with `schema` ask a second factor
 * (`requireSpaceAuthMfaScoped`); the tools and the tool door ask none, so a schema could be written past it. `network_reread` and `view_copy`
 * refuse the same way (`callerIsAskedForMfa`), as MCP has no channel for a code.
 *
 * Run: node --test testing/standalone/the-schema-writing-rdf-tools-refuse-a-caller-asked-for-mfa-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfImportSchemaDoors, spaceWith, fileOf, schemaFile, BUILT_PERSON } from './_rdf-import-schema-doors.mjs';
import { personMeta, goodTurtle } from './_rdf-import-doors.mjs';

const skip = await mongoSkipReason();
const refused = ['asked-sr-mcp', 'asked-sr-door', 'asked-junk-mcp', 'asked-junk-door', 'asked-ir-mcp', 'asked-ir-door', 'asked-dry-mcp', 'asked-dry-door'];
const imports = ['data-mcp', 'data-door', 'none-mcp', 'none-door'];
const builds = ['exempt-sr-mcp', 'exempt-sr-door', 'exempt-ir-mcp', 'exempt-ir-door', 'off-sr-mcp', 'off-sr-door', 'off-ir-mcp', 'off-ir-door'];
const id = (name) => `q955mfa${name.replace(/-/g, '')}`;
const IDS = [...refused, ...imports, ...builds].map(id);
/** The sentence the precedents (`network_reread`, `view_copy`) refuse with: the step-up the door cannot present, and the web UI. */
const REFUSAL = /needs MFA step-up, which this door cannot present; use the web UI|use the web UI.*MFA|MFA.*web UI/;

describe('the schema-writing RDF tools refuse a caller asked for a second factor (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, totp, asked, exempt;
  before(async () => {
    d = await openRdfImportSchemaDoors({ suite: 'q955_mfa_tools', spaces: IDS.map(sid => (imports.map(id).includes(sid) ? { id: sid, meta: personMeta(sid, 'warn') } : spaceWith(sid, undefined))) });
    totp = await import('../../server/dist/auth/totp.js');
    const on = (rungs) => Object.fromEntries(IDS.map(sid => [sid, d.row(rungs)]));
    asked = await d.mint('q955-mfa-inherit', on({ knowledge: 'write', schema: 'write' }));
    exempt = await d.mint('q955-mfa-exempt', on({ knowledge: 'write', schema: 'write' }), { mfa: 'exempt' });
  });
  after(async () => { totp?.disableMfa?.(); await d?.close(); });

  /** The tool through MCP and through the tool door, answered alike: `{ status, ok, text, body }`. */
  async function viaMcp(key, tool, args) {
    const a = await d.toolCall(key, tool, args);
    return { status: a.isError ? null : 200, ok: !a.isError, text: a.text, body: a.structured };
  }
  async function viaDoor(key, tool, args) {
    const r = await d.rest(key, 'POST', `/api/${tool}`, args);
    return { status: r.status, ok: r.body?.ok === true, text: r.text, body: r.body?.data ?? null };
  }
  const via = (door) => (door === 'mcp' ? viaMcp : viaDoor);

  const schemaArgs = (name, over = {}) => ({ space: id(name), document: schemaFile(), format: 'turtle', mode: 'generate', ...over });
  const importArgs = (name, over = {}) => ({ space: id(name), document: fileOf(), format: 'turtle', ...over });

  /** The refusal: not ok, 403 where the door carries a status, naming the web UI, and nothing stored in the space. */
  async function assertRefused(a, name, what) {
    assert.equal(a.ok, false, `${what}: ${a.text.slice(0, 300)}`);
    if (a.status !== null) assert.equal(a.status, 403, `${what}: ${a.text.slice(0, 300)}`);
    assert.match(a.text, REFUSAL, `${what} names the web UI`);
    assert.deepEqual(d.heldTypes(id(name)), {}, `${what}: a type was stored`);
    assert.deepEqual(await d.records(id(name), 'entities'), [], `${what}: a record was stored`);
  }

  /** The schema of `name` was built: the type the file declares is stored. */
  const assertBuilt = (a, name, what) => {
    assert.equal(a.ok, true, `${what}: ${a.text.slice(0, 300)}`);
    assert.deepEqual(d.heldTypes(id(name)).entity?.Person, BUILT_PERSON, `${what}: the built type is not stored`);
  };

  for (const door of ['mcp', 'door']) {
    describe(`on ${door === 'mcp' ? 'MCP' : 'the tool door'}`, () => {
      it('a token asked for the second factor: import_schema_rdf is refused, naming the web UI', async () => {
        totp.enableMfa('Ythril', 'admin');
        try {
          const name = `asked-sr-${door}`;
          await assertRefused(await via(door)(asked.key, 'import_schema_rdf', schemaArgs(name)), name, 'import_schema_rdf');
        } finally { totp.disableMfa(); }
      });

      it('the refusal answers before the document is read: a document that is not RDF is refused for the second factor', async () => {
        totp.enableMfa('Ythril', 'admin');
        try {
          const name = `asked-junk-${door}`;
          const a = await via(door)(asked.key, 'import_schema_rdf', schemaArgs(name, { document: '<<< this is not turtle' }));
          await assertRefused(a, name, 'a junk document');
        } finally { totp.disableMfa(); }
      });

      it('a token asked for the second factor: import_rdf with schema is refused, naming the web UI; a dry run too', async () => {
        totp.enableMfa('Ythril', 'admin');
        try {
          const name = `asked-ir-${door}`;
          await assertRefused(await via(door)(asked.key, 'import_rdf', importArgs(name, { schema: 'generate' })), name, 'import_rdf with schema generate');
          await assertRefused(await via(door)(asked.key, 'import_rdf', importArgs(name, { schema: 'expand' })), name, 'import_rdf with schema expand');
          const dry = `asked-dry-${door}`;
          await assertRefused(await via(door)(asked.key, 'import_rdf', importArgs(dry, { schema: 'update', dryRun: true })), dry, 'import_rdf dry run with schema update');
        } finally { totp.disableMfa(); }
      });

      it('the same token\'s import_rdf without schema, or with schema none, still imports', async () => {
        totp.enableMfa('Ythril', 'admin');
        try {
          for (const [name, over] of [[`data-${door}`, {}], [`none-${door}`, { schema: 'none' }]]) {
            const a = await via(door)(asked.key, 'import_rdf', importArgs(name, { document: goodTurtle(id(name)), ...over }));
            assert.equal(a.ok, true, `import_rdf ${JSON.stringify(over)}: ${a.text.slice(0, 300)}`);
            const stored = JSON.stringify(await d.records(id(name), 'entities'));
            assert.ok(stored.includes('Alice') && stored.includes('Bob'), `${name}: the data was not imported`);
            assert.deepEqual(d.heldTypes(id(name)), personMeta(id(name)).typeSchemas, `${name}: the space's schema changed without schema set`);
          }
        } finally { totp.disableMfa(); }
      });

      it('a caller not asked builds as before: a token exempt from the second factor, and any token with the switch off', async () => {
        totp.enableMfa('Ythril', 'admin');
        try {
          const sr = `exempt-sr-${door}`;
          assertBuilt(await via(door)(exempt.key, 'import_schema_rdf', schemaArgs(sr)), sr, 'exempt import_schema_rdf');
          const ir = `exempt-ir-${door}`;
          assertBuilt(await via(door)(exempt.key, 'import_rdf', importArgs(ir, { schema: 'generate' })), ir, 'exempt import_rdf with schema');
        } finally { totp.disableMfa(); }
        const sr = `off-sr-${door}`;
        assertBuilt(await via(door)(asked.key, 'import_schema_rdf', schemaArgs(sr)), sr, 'import_schema_rdf, switch off');
        const ir = `off-ir-${door}`;
        assertBuilt(await via(door)(asked.key, 'import_rdf', importArgs(ir, { schema: 'generate' })), ir, 'import_rdf with schema, switch off');
      });
    });
  }
});
