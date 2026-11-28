/**
 * The schema-from-RDF door is held to its rungs on both doors (bundle-270, Q-754, design revision 3 "Rights"): `POST
 * /api/spaces/:id/schema-rdf` and MCP `import_schema_rdf`.
 *
 * ## What it holds
 *
 * - A dry run and a build need `schema: write` (amendment A10, as the data import's dry run): below it the rights guard refuses, naming the
 *   rung. A file whose shapes give a type rules needs `schema: admin` (the settings write's field rungs, `schema_rdf_rung`), naming the rules.
 * - A dry run is refused what its build is refused (Q-754 R1): a file whose shapes give a type rules is `schema_rdf_rung` by a `schema: write`
 *   token for a dry run as for a build, so a dry run never promises a build the write then refuses.
 * - A read-only token is turned away on a dry run too (both doors are writes); a token of another space reaches nothing.
 * - A peer-bound token, whatever its rungs (here `schema: admin`), is refused `403 peer_door` on both doors, for a dry run and a build (bundle-47,
 *   Q-244: a peer token is confined to the sync doors, so it never reaches these routes or their rungs; on `/mcp` the refusal is the HTTP answer, not a
 *   tool result). An administrator's dry run of the same file is answered, so the refusal is about the token kind.
 * - Nothing a refused call names is stored.
 *
 * Run: node --test testing/standalone/a-schema-rdf-import-is-held-to-its-rungs-on-both-doors-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSchemaRdfImportDoors, spaceWith, baseOf } from './_schema-rdf-import-doors.mjs';

const skip = await mongoSkipReason();
const SRC = 'srdfrungsrc';
const RULED = 'srdfrungruled';
const TARGET = 'srdfrungtarget';
const OTHER = 'srdfrungother';
const WRITE = { rest: 'srdfrungwr', mcp: 'srdfrungwm' };
const RULES = { rest: 'srdfrungrr', mcp: 'srdfrungrm' };
const SOURCE_TYPES = { entity: { person: { propertySchemas: { age: { type: 'number' } } } } };
const RULED_TYPES = { entity: { person: { propertySchemas: { age: { type: 'number' } }, rules: { described: { rule: 'size(self.description) > 0', message: 'a description is needed' } } } } };
/** The write rung of the schema area named, in either door's words. */
const WRITE_RUNG = /'write' on schema|schema: write/;
const DRY = { rest: 'srdfrungdr', mcp: 'srdfrungdm' };
const TARGETS = [TARGET, ...Object.values(WRITE), ...Object.values(RULES), ...Object.values(DRY)];

describe('the schema-from-RDF door is held to its rungs on both doors (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, admin, file, ruledFile;
  const tokens = {};
  before(async () => {
    d = await openSchemaRdfImportDoors({
      suite: 'schema_rdf_rungs',
      spaces: [spaceWith(SRC, SOURCE_TYPES), spaceWith(RULED, RULED_TYPES), spaceWith(OTHER, undefined), ...TARGETS.map(id => spaceWith(id, undefined))],
    });
    admin = await d.mint('schema-rdf-rungs-admin', {}, { admin: true });
    const on = (rungs) => Object.fromEntries(TARGETS.map(id => [id, d.row(rungs)]));
    // `files: write`, not `knowledge: write`: the latter implies `schema: read` (`RUNG_IMPLICATIONS`), and the token must write somewhere to
    // pass the read-only refusal and meet the rung.
    tokens.noSchema = await d.mint('schema-rdf-rungs-none', on({ files: 'write' }));
    tokens.reader = await d.mint('schema-rdf-rungs-read', on({ knowledge: 'write', schema: 'read' }));
    tokens.writer = await d.mint('schema-rdf-rungs-write', on({ knowledge: 'write', schema: 'write' }));
    tokens.readOnly = await d.mint('schema-rdf-rungs-readonly', Object.fromEntries(TARGETS.map(id => [id, d.row({}, 'read')])));
    tokens.peer = await d.mint('schema-rdf-rungs-peer', on({ knowledge: 'write', schema: 'admin' }), { peerInstanceId: 'schema-rdf-rungs-a-peer' });
    tokens.other = await d.mint('schema-rdf-rungs-other', { [OTHER]: d.row({ knowledge: 'write', schema: 'admin' }) });
    file = await d.exportTurtle(admin.key, SRC);
    ruledFile = await d.exportTurtle(admin.key, RULED);
  });
  after(async () => { await d?.close(); });

  const params = (over = {}) => ({ mode: 'generate', sourceBase: baseOf(SRC), ...over });
  /** Both doors refused, and nothing stored in `space`. */
  function refusedOnBoth({ rest, mcp }, space, what, { status = 403, text } = {}) {
    assert.equal(rest.status, status, `${what}, REST: ${rest.text.slice(0, 300)}`);
    assert.equal(mcp.isError, true, `${what}, MCP: ${mcp.text.slice(0, 300)}`);
    if (text) {
      assert.match(rest.text, text, `${what}, REST names it`);
      assert.match(mcp.text, text, `${what}, MCP names it`);
    }
    assert.deepEqual(d.heldTypes(space), {}, `${what}: something was stored`);
  }

  it('without schema: read, a dry run and a build are refused on both doors, naming the write rung', async () => {
    refusedOnBoth(await d.both(tokens.noSchema.key, TARGET, file, params({ dryRun: true })), TARGET, 'dry run without schema: read', { text: /write/ });
    refusedOnBoth(await d.both(tokens.noSchema.key, TARGET, file, params()), TARGET, 'build without schema: read', { text: /schema/ });
  });

  it('with schema: read, a dry run and a build are both refused, naming schema: write (amendment A10: a dry run needs the write rung)', async () => {
    const dry = await d.both(tokens.reader.key, TARGET, file, params({ dryRun: true }));
    // REST's guard says "needs 'write' on schema", the tool dispatcher "needs schema: write": both name the rung.
    refusedOnBoth(dry, TARGET, 'dry run with schema: read', { text: WRITE_RUNG });
    const build = await d.both(tokens.reader.key, TARGET, file, params());
    refusedOnBoth(build, TARGET, 'build with schema: read', { text: WRITE_RUNG });
  });

  it('with schema: write, a dry run is answered and writes nothing', async () => {
    const dry = await d.both(tokens.writer.key, TARGET, file, params({ dryRun: true }));
    assert.equal(dry.rest.status, 200, `REST dry run: ${dry.rest.text.slice(0, 300)}`);
    assert.equal(dry.mcp.isError, false, `MCP dry run: ${dry.mcp.text.slice(0, 300)}`);
    assert.equal(dry.rest.body.dryRun, true);
    assert.equal(dry.rest.body.written, false);
    assert.deepEqual(d.heldTypes(TARGET), {});
  });

  it('with schema: write, a build is written; a file whose shapes give rules is refused naming them (schema: admin)', async () => {
    const built = await d.both(tokens.writer.key, [WRITE.rest, WRITE.mcp], file, params());
    assert.equal(built.rest.status, 200, `REST: ${built.rest.text.slice(0, 300)}`);
    assert.equal(built.mcp.isError, false, `MCP: ${built.mcp.text.slice(0, 300)}`);
    for (const id of Object.values(WRITE)) assert.deepEqual(d.heldTypes(id).entity.person, SOURCE_TYPES.entity.person, `${id}: the build was not written`);
    const ruled = await d.both(tokens.writer.key, [RULES.rest, RULES.mcp], ruledFile, params({ sourceBase: baseOf(RULED) }));
    refusedOnBoth({ rest: ruled.rest, mcp: ruled.mcp }, RULES.rest, 'rules with schema: write', { text: /rules/ });
    assert.deepEqual(d.heldTypes(RULES.mcp), {}, 'MCP: the ruled build was stored');
    assert.equal(ruled.rest.code, 'schema_rdf_rung');
    const byAdmin = await d.buildRest(admin.key, RULES.rest, ruledFile, { params: params({ sourceBase: baseOf(RULED) }) });
    assert.equal(byAdmin.status, 200, `the same file by an administrator: ${byAdmin.text.slice(0, 300)}`);
  });

  it('with schema: write, a dry run of a file whose shapes give rules is refused as its build is (schema_rdf_rung); an administrator\'s is answered', async () => {
    const dry = await d.both(tokens.writer.key, [DRY.rest, DRY.mcp], ruledFile, params({ sourceBase: baseOf(RULED), dryRun: true }));
    refusedOnBoth(dry, DRY.rest, 'ruled dry run with schema: write', { text: /rules/ });
    assert.equal(dry.rest.code, 'schema_rdf_rung', `REST: ${dry.rest.text.slice(0, 300)}`);
    assert.equal(dry.mcp.code, 'schema_rdf_rung', `MCP: ${dry.mcp.text.slice(0, 300)}`);
    const byAdmin = await d.buildRest(admin.key, DRY.rest, ruledFile, { params: params({ sourceBase: baseOf(RULED), dryRun: true }) });
    assert.equal(byAdmin.status, 200, `the same dry run by an administrator: ${byAdmin.text.slice(0, 300)}`);
  });

  it('a read-only token is refused on a dry run, on both doors', async () => {
    refusedOnBoth(await d.both(tokens.readOnly.key, TARGET, file, params({ dryRun: true })), TARGET, 'read-only dry run');
  });

  /** The peer-bound token's answer at both doors: REST's `403 peer_door` and `/mcp`'s HTTP `403 peer_door` (not a tool result); nothing stored. */
  async function peerRefusedOnBoth(what, over) {
    const rest = await d.buildRest(tokens.peer.key, TARGET, file, { params: params(over) });
    const mcp = await d.rpc(tokens.peer.key, 'tools/call', { name: 'import_schema_rdf', arguments: { space: TARGET, document: file, format: 'turtle', ...params(over) } });
    assert.ok(rest.status === 403 && rest.code === 'peer_door', `${what}, REST: ${rest.status} ${rest.text.slice(0, 300)}`);
    assert.ok(mcp.status === 403 && mcp.messages[0]?.code === 'peer_door', `${what}, MCP: ${mcp.status} ${JSON.stringify(mcp.messages[0] ?? {}).slice(0, 300)}`);
    assert.deepEqual(d.heldTypes(TARGET), {}, `${what}: something was stored`);
  }

  it('a peer-bound token is refused 403 peer_door on both doors, for a dry run and a build; an administrator\'s dry run of the same file is answered', async () => {
    await peerRefusedOnBoth('peer-bound dry run', { dryRun: true });
    await peerRefusedOnBoth('peer-bound build', {});
    const byAdmin = await d.buildRest(admin.key, TARGET, file, { params: params({ dryRun: true }) });
    assert.equal(byAdmin.status, 200, `the same dry run by an administrator: ${byAdmin.text.slice(0, 300)}`);
  });

  it('a token of another space reaches nothing here', async () => {
    // The door is there: the same request by an administrator's dry run is answered (else a 404 of no route would pass for a refusal).
    const owner = await d.buildRest(admin.key, TARGET, file, { params: params({ dryRun: true }) });
    assert.equal(owner.status, 200, `the door answers an administrator: ${owner.text.slice(0, 200)}`);
    const { rest, mcp } = await d.both(tokens.other.key, TARGET, file, params());
    assert.ok(rest.status === 403 || rest.status === 404, `REST: ${rest.status} ${rest.text.slice(0, 200)}`);
    assert.equal(mcp.isError, true, mcp.text.slice(0, 200));
    assert.deepEqual(d.heldTypes(TARGET), {});
  });
});
