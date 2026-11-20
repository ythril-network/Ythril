/**
 * An RDF import is a space act: it holds its space while it stands, refuses every schema write to it, and resumes after a failure in its
 * commit without writing a record twice (bundle-270 slice S6, Q-753; plan amendments A1, A3).
 *
 * ## What it holds
 *
 * - A commit that fails after its first window landed leaves the act owed; run again, it resumes from its spool and index, and every record of
 *   the file is stored exactly once, under the id minted the first time. Its folder is gone at its end.
 * - While the act stands, a schema write to its space is refused on both doors with `space_being_rdf_imported`, its sentence naming the RDF import, and so is a
 *   record write; the status door answers it as running; after it completes the same schema write passes.
 *
 * Run: node --test testing/standalone/an-rdf-import-act-resumes-and-holds-its-space-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { openRdfImportDoors, personMeta, goodTurtle } from './_rdf-import-doors.mjs';

const skip = await mongoSkipReason();
const RESUME = 'rdfimpresume';
const HELD = 'rdfimpheld';

const until = (what, fn, ms = 30_000) => waitFor(fn, ms, 50, undefined, { what });

describe('an RDF import act resumes and holds its space (real routes, real MongoDB)', { skip, timeout: 240_000 }, () => {
  let d, writer, act, runner;
  before(async () => {
    d = await openRdfImportDoors({ suite: 'rdf_import_act', spaces: [{ id: RESUME, meta: personMeta(RESUME, 'warn') }, { id: HELD, meta: personMeta(HELD) }] });
    writer = await d.mint('rdf-import-act-writer', {
      [RESUME]: d.row({ knowledge: 'write', schema: 'admin' }), [HELD]: d.row({ knowledge: 'write', schema: 'admin' }),
    });
    act = await import('../../server/dist/spaces/rdf-import-act.js').catch(() => ({}));
    runner = await import('../../server/dist/spaces/space-act-runner.js');
  });
  after(async () => { act.setRdfImportKnobsForTest?.(null); runner.setSpaceActKnobsForTest(null); await d?.close(); });

  it('a commit that fails after its first window resumes and stores every record once', async () => {
    assert.equal(typeof act.setRdfImportKnobsForTest, 'function', 'the act module exports its test knobs');
    let failures = 0;
    act.setRdfImportKnobsForTest({
      window: 1,
      hooks: { afterCommitWindow: () => { if (failures === 0) { failures += 1; throw new Error('planted: the process stops after the first window'); } } },
    });
    const r = await d.importRest(writer.key, RESUME, goodTurtle(RESUME));
    assert.ok(r.status >= 500, `the failed attempt is answered as a failure: ${r.status} ${r.text.slice(0, 300)}`);
    assert.equal(failures, 1);
    const [entry] = d.actsOf(RESUME);
    assert.ok(entry, 'the act is owed');
    assert.equal(entry.kind, 'rdf-import');
    const landed = await d.records(RESUME, 'entities');
    assert.ok(landed.length >= 1, 'the first window landed before the failure');
    const settled = await runner.runSpaceAct(entry.id);
    assert.equal(settled.ok, true, settled.error);
    const people = await d.records(RESUME, 'entities');
    assert.deepEqual(people.map(e => e.name).sort(), ['Alice', 'Bob']);
    for (const first of landed) assert.ok(people.some(p => p._id === first._id), 'a record that landed first keeps its minted id');
    assert.equal((await d.records(RESUME, 'edges')).length, 1);
    assert.deepEqual(d.actsOf(RESUME), []);
    const folder = path.join(d.loader.getDataRoot(), act.RDF_IMPORT_DIR ?? 'rdf-import', entry.spoolId);
    // Removed after the completion write, by the act's own follow-up, which the runner does not await.
    await until('its folder to be removed at its end', () => !fs.existsSync(folder), 10_000);
    act.setRdfImportKnobsForTest(null);
  });

  it('while the act stands, schema and record writes to its space are refused; after it, the schema write passes', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    act.setRdfImportKnobsForTest({ hooks: { beforeCommit: () => gate } });
    runner.setSpaceActKnobsForTest({ SPACE_ACT_ANSWER_MS: 300 });
    const r = await d.importRest(writer.key, HELD, goodTurtle(HELD));
    assert.equal(r.status, 202, r.text.slice(0, 300));
    const importId = r.body?.importId;
    assert.ok(importId);
    assert.match(r.headers.get('location') ?? '', new RegExp(`/import/rdf/${importId}$`));
    const running = await d.statusRest(writer.key, HELD, importId);
    assert.equal(running.body?.status, 'running', running.text.slice(0, 300));
    const schema = { typeSchemas: { entity: { place: { propertySchemas: {} } } } };
    const patch = await d.rest(writer.key, 'PATCH', `/api/spaces/${HELD}`, { meta: schema });
    assert.equal(patch.status, 409, patch.text?.slice(0, 300));
    assert.equal(patch.body?.code, 'space_being_rdf_imported');
    assert.match(patch.body?.error ?? '', /RDF import/i);
    const tool = await d.toolCall(writer.key, 'schema_update', { space: HELD, ...schema });
    assert.equal(tool.isError, true, tool.text.slice(0, 300));
    assert.match(tool.text, /RDF import/);
    const save = await d.rest(writer.key, 'POST', `/api/brain/spaces/${HELD}/entities`, { name: 'Interloper', type: 'person' });
    assert.equal(save.status, 409, save.text?.slice(0, 200));
    release();
    await until('the import to complete', async () => (await d.statusRest(writer.key, HELD, importId)).body?.status === 'completed');
    const after = await d.rest(writer.key, 'PATCH', `/api/spaces/${HELD}`, { meta: schema });
    assert.ok(after.status < 300, after.text?.slice(0, 300));
    assert.deepEqual((await d.records(HELD, 'entities')).map(e => e.name).sort(), ['Alice', 'Bob']);
  });
});
