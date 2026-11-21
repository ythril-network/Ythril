/**
 * A dry run of the schema-from-RDF door answers what its write answers (bundle-270, Q-754, design revisions 2 and 3, the challenge's F2 and F3
 * and the lens sweep's reliability gaps), on both doors: `POST /api/spaces/:id/schema-rdf` and MCP `import_schema_rdf`.
 *
 * ## What it holds
 *
 * - A dry run runs the settings write's planner: a file whose type takes another term's address, and a file whose type names a library entry
 *   that does not exist, are refused by the dry run exactly as by the build (same status, same code), and nothing is stored. A file the
 *   build takes is answered by the dry run with the same changes.
 * - While an RDF import holds the space, a build and a dry run are both refused 409 `space_being_rdf_imported`.
 * - A space whose schema changed between the door's reading of it and its write is refused 412 `schema_rdf_changed` (the door writes with
 *   the version it read as `ifMatch`), and the change made meanwhile stands.
 *
 * Run: node --test testing/standalone/a-schema-rdf-dry-run-answers-what-the-write-answers-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { seedActEntry, clearActEntries } from './_space-act-harness.mjs';
import { openSchemaRdfImportDoors, spaceWith, baseOf, knobs, actModule } from './_schema-rdf-import-doors.mjs';

const skip = await mongoSkipReason();
const YTHRIL = 'https://w3id.org/ythril/ns#';
const SRC = 'srdfdrysrc';
const CLASH = { rest: 'srdfdryclr', mcp: 'srdfdryclm' };
const DANGLING = { rest: 'srdfdrydgr', mcp: 'srdfdrydgm' };
const SAME = { rest: 'srdfdrysamer', mcp: 'srdfdrysamem' };
const HOLD = 'srdfdryhold';
const CHANGED = { rest: 'srdfdrychr', mcp: 'srdfdrychm' };
const CLASH_SRC = 'srdfdryclsrc';
const SOURCE_TYPES = { entity: { Mine: { propertySchemas: { size: { type: 'number' } } } } };
/** An outside address two spaces give two types: the file's `Mine` and the target's stored `Theirs`. */
const TAKEN = 'https://e.example/terms/Thing';
const theirsAt = () => ({ entity: { Theirs: { iri: TAKEN } } });

describe('a dry run of the schema-from-RDF door answers what its write answers (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, admin, file;
  before(async () => {
    d = await openSchemaRdfImportDoors({
      suite: 'schema_rdf_dry_run',
      spaces: [
        spaceWith(SRC, SOURCE_TYPES),
        spaceWith(CLASH_SRC, { entity: { Mine: { iri: TAKEN } } }),
        ...Object.values(CLASH).map(id => spaceWith(id, theirsAt())),
        ...[...Object.values(DANGLING), ...Object.values(SAME), HOLD, ...Object.values(CHANGED)].map(id => spaceWith(id, undefined)),
      ],
    });
    admin = await d.mint('schema-rdf-dry-admin', {}, { admin: true });
    file = await d.exportTurtle(admin.key, SRC);
  });
  after(async () => { actModule.setSchemaRdfImportKnobsForTest?.(null); if (d) clearActEntries(d.loader); await d?.close(); });

  const params = (over = {}) => ({ mode: 'expand', sourceBase: baseOf(SRC), ...over });

  /** The dry run and the build of `text` on each door's space refuse alike, and nothing is stored. */
  async function refusedAlike(spaces, text, mode, what, over = {}) {
    const before = Object.fromEntries(Object.values(spaces).map(id => [id, structuredClone(d.heldMeta(id))]));
    const dry = await d.both(admin.key, [spaces.rest, spaces.mcp], text, params({ mode, dryRun: true, ...over }));
    const build = await d.both(admin.key, [spaces.rest, spaces.mcp], text, params({ mode, ...over }));
    assert.equal(build.rest.status, 422, `${what}, REST build: ${build.rest.text.slice(0, 300)}`);
    assert.equal(dry.rest.status, build.rest.status, `${what}: the REST dry run answered ${dry.rest.status}, the build ${build.rest.status}: ${dry.rest.text.slice(0, 300)}`);
    assert.equal(dry.rest.code, build.rest.code, `${what}: REST codes differ`);
    assert.ok(build.rest.code === 'rdf_term_clash' || build.rest.code === 'schema_rdf_refused', `${what}: ${build.rest.code}`);
    assert.equal(dry.mcp.isError, true, `${what}, MCP dry run: ${dry.mcp.text.slice(0, 300)}`);
    assert.equal(build.mcp.isError, true, `${what}, MCP build: ${build.mcp.text.slice(0, 300)}`);
    assert.equal(dry.mcp.code, build.mcp.code, `${what}: MCP codes differ`);
    assert.equal(build.mcp.code, build.rest.code, `${what}: the doors answer different codes`);
    for (const id of Object.values(spaces)) assert.deepEqual(d.heldMeta(id), before[id], `${what}: ${id} was written`);
  }

  it('a type taking another term\'s address is refused by the dry run as by the build', async () => {
    const clashing = await d.exportTurtle(admin.key, CLASH_SRC);
    await refusedAlike(CLASH, clashing, 'expand', 'a term clash', { sourceBase: baseOf(CLASH_SRC) });
  });

  it('a type naming a library entry that does not exist is refused by the dry run as by the build', async () => {
    const dangling = `${file}\n<${baseOf(SRC)}schema/shape/entity/Mine> <${YTHRIL}unresolvedRef> "library:no-such-entry" .\n`;
    await refusedAlike(DANGLING, dangling, 'generate', 'a dangling library reference');
  });

  it('a file the build takes is answered by the dry run with the same changes', async () => {
    const dry = await d.both(admin.key, [SAME.rest, SAME.mcp], file, params({ mode: 'generate', dryRun: true }));
    for (const id of Object.values(SAME)) assert.deepEqual(d.heldTypes(id), {}, `${id}: a dry run wrote`);
    const build = await d.both(admin.key, [SAME.rest, SAME.mcp], file, params({ mode: 'generate' }));
    for (const door of ['rest', 'mcp']) {
      assert.ok(dry[door].body && build[door].body, `${door}: ${dry[door].text.slice(0, 200)} / ${build[door].text.slice(0, 200)}`);
      assert.deepEqual(dry[door].body.changes, build[door].body.changes, `${door}: the dry run and the build answer different changes`);
      assert.deepEqual(dry[door].body.typeSchemas, build[door].body.typeSchemas, `${door}: the dry run and the build answer different types`);
      assert.ok(build[door].body.changes.length > 0, `${door}: the build changed nothing`);
    }
  });

  it('while an RDF import holds the space, a build and a dry run are both 409 space_being_rdf_imported', async () => {
    await seedActEntry(d.loader, { kind: 'rdf-import', localId: HOLD, state: 'owed', retryAt: '2999-01-01T00:00:00.000Z', spoolId: 'planted' });
    try {
      for (const dryRun of [true, false]) {
        const { rest, mcp } = await d.both(admin.key, HOLD, file, params({ mode: 'generate', dryRun }));
        assert.equal(rest.status, 409, `dryRun ${dryRun}, REST: ${rest.text.slice(0, 300)}`);
        assert.equal(rest.code, 'space_being_rdf_imported', `dryRun ${dryRun}, REST`);
        assert.equal(mcp.code, 'space_being_rdf_imported', `dryRun ${dryRun}, MCP: ${mcp.text.slice(0, 300)}`);
      }
      assert.deepEqual(d.heldTypes(HOLD), {});
    } finally {
      clearActEntries(d.loader);
    }
  });

  it('a schema changed between the door\'s read and its write is refused 412 schema_rdf_changed, and the change stands', async () => {
    for (const [door, id] of Object.entries(CHANGED)) {
      knobs({ hooks: { beforeWrite: () => d.loader.mutateConfig(cfg => {
        const space = cfg.spaces.find(s => s.id === id);
        space.meta = { ...space.meta, version: (space.meta.version ?? 0) + 1, purpose: 'changed meanwhile' };
      }) } });
      const answer = door === 'rest'
        ? await d.buildRest(admin.key, id, file, { params: params({ mode: 'generate' }) })
        : await d.buildMcp(admin.key, { space: id, document: file, format: 'turtle', ...params({ mode: 'generate' }) });
      knobs(null);
      if (door === 'rest') assert.equal(answer.status, 412, answer.text.slice(0, 300));
      else assert.equal(answer.isError, true, answer.text.slice(0, 300));
      assert.equal(answer.code, 'schema_rdf_changed', `${door}: ${answer.text.slice(0, 300)}`);
      // Q-754 R4: the tool carries the code as structured content, as it does for every other code it answers (REST has it in the body).
      assert.equal(answer.body?.code, 'schema_rdf_changed', `${door}: the answer's body names no code: ${JSON.stringify(answer.body)}`);
      assert.deepEqual(d.heldTypes(id), {}, `${door}: the stale build was written`);
      assert.equal(d.heldMeta(id).purpose, 'changed meanwhile', `${door}: the change made meanwhile was lost`);
    }
  });
});
