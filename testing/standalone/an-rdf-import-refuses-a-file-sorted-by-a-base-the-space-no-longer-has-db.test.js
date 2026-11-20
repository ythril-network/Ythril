/**
 * An RDF import is refused when the space's RDF base or vocabulary changed between the door's sort and the act's registration (bundle-270, tail
 * find T8).
 *
 * ## What it holds
 *
 * The door sorts the file into its spool by a key that depends on the space's RDF base (a chrono's `#start` and `#end` time nodes are grouped
 * with their owner by the base's addresses) and counts the records the file makes by it; the act, which holds the space, reads the meta again.
 * A base changed between the two left a file grouped by an addressing the act no longer reads by. The door asks the space's RDF settings again
 * in the step that registers the act (nothing awaited between: from the registration on, a caller's schema write is refused), and refuses the
 * file when they are not those it sorted by: 409 `rdf_import_space_changed`, nothing written, its report failed, no act standing, its folder
 * removed. With the settings unchanged the import runs as before.
 *
 * Run: node --test testing/standalone/an-rdf-import-refuses-a-file-sorted-by-a-base-the-space-no-longer-has-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfImportDoors, personMeta, goodTurtle } from './_rdf-import-doors.mjs';

const skip = await mongoSkipReason();
const CHANGED = 'rdfimpbase1';
const SAME = 'rdfimpbase2';

describe('an import is refused when the space\'s RDF base changed after the door sorted the file (real routes, real MongoDB)', { skip, timeout: 120_000 }, () => {
  let d, writer, act;
  const root = () => path.join(d.loader.getDataRoot(), act.RDF_IMPORT_DIR);

  before(async () => {
    d = await openRdfImportDoors({ suite: 'rdf_import_base', spaces: [CHANGED, SAME].map(id => ({ id, meta: personMeta(id, 'warn') })) });
    writer = await d.mint('rdf-import-base-writer', Object.fromEntries([CHANGED, SAME].map(s => [s, d.row({ knowledge: 'write', schema: 'admin' })])));
    act = await import('../../server/dist/spaces/rdf-import-act.js');
  });
  after(async () => { act?.setRdfImportKnobsForTest?.(null); await d?.close(); });

  const setBase = (space, base) => d.loader.mutateConfig(cfg => {
    const s = cfg.spaces.find(x => x.id === space);
    s.meta = { ...s.meta, rdf: { ...s.meta.rdf, base } };
  });

  it('a base changed between the sort and the registration refuses the file, writes nothing and leaves no act', async () => {
    act.setRdfImportKnobsForTest({ hooks: { beforeRegister: () => setBase(CHANGED, 'https://changed.example/rdf/') } });
    let answer;
    try { answer = await d.importRest(writer.key, CHANGED, goodTurtle(CHANGED)); } finally { act.setRdfImportKnobsForTest(null); }
    assert.equal(answer.status, 409, `${answer.status} ${answer.text.slice(0, 300)}`);
    assert.equal(answer.body?.code, 'rdf_import_space_changed');
    assert.deepEqual(await d.records(CHANGED, 'entities'), [], 'nothing was written');
    assert.deepEqual(d.actsOf(CHANGED), [], 'no act stands');
    assert.deepEqual(fs.existsSync(root()) ? fs.readdirSync(root()) : [], [], 'its folder was removed');
    const save = await d.rest(writer.key, 'POST', `/api/brain/spaces/${CHANGED}/entities`, { name: 'After', type: 'person', properties: { age: 1 } });
    assert.ok(save.status < 300, `the space takes writes: ${save.status} ${save.text?.slice(0, 200)}`);
  });

  it('with the settings as the door sorted by, the import runs', async () => {
    const answer = await d.importRest(writer.key, SAME, goodTurtle(SAME));
    assert.equal(answer.status, 200, answer.text.slice(0, 300));
    assert.deepEqual((await d.records(SAME, 'entities')).map(e => e.name).sort(), ['Alice', 'Bob']);
  });
});
