/**
 * A base the network changed after the act registered ends the import, before its first window only (bundle-270, fix round 4, finding R4;
 * second review F2 and F4, tail find T8).
 *
 * ## The gap
 *
 * The door sorts the file by the addressing the space has (a chrono entry's time nodes belong to it) and counts its records by it. The door
 * refuses when the space's RDF base or vocabulary changed between its sort and the act's registration (`rdf_import_space_changed`). A schema
 * the network decides (a passed round, an arriving layer) is applied while an import stands, so the base can change AFTER the registration,
 * and the act then translated a file sorted by the old base with the new one.
 *
 * ## The rule
 *
 * The act reads the base and the vocabulary once under its hold, with the schema it plans by, and compares them with what the door sorted by
 * (kept in its state): a difference before the first window ends the act as an input failure with `rdf_import_space_changed` (409), nothing
 * written, the space released. After the first window landed nothing ends the act: it finishes by the base it began with.
 *
 * ## What this spec holds
 *
 * - The base changed (live config, as a network layer's apply does) between the registration and the act's first read: 409
 *   `rdf_import_space_changed` on the door and on the status door, no record written, no act owed, the space takes writes again.
 * - The base changed after the first window landed: the import completes, every record of the file landed.
 *
 * Run: node --test testing/standalone/an-rdf-import-refuses-a-base-the-network-changed-after-registration-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfImportDoors, personMeta, goodTurtle, baseOf } from './_rdf-import-doors.mjs';

const skip = await mongoSkipReason();
const EARLY = 'rdfbaseearly';
const LATE = 'rdfbaselate';

describe('a base the network changed after the act registered (real routes, real MongoDB)', { skip, timeout: 240_000 }, () => {
  let d, writer, act;
  /** The base and vocabulary change as the apply of a network layer changes them: in the live config of the space. */
  const rebase = (space) => {
    const base = `${baseOf(space)}moved/`;
    // Saved, not only held in memory: the act's own config writes reload the file.
    d.loader.mutateConfig((cfg) => {
      const s = cfg.spaces.find(x => x.id === space);
      s.meta.rdf = { ...s.meta.rdf, base, vocab: `${base}vocab/` };
    });
  };

  before(async () => {
    d = await openRdfImportDoors({ suite: 'rdf_import_base_moved', spaces: [EARLY, LATE].map(id => ({ id, meta: personMeta(id) })) });
    writer = await d.mint('rdf-import-base-writer', Object.fromEntries([EARLY, LATE].map(s => [s, d.row({ knowledge: 'write', schema: 'admin' })])));
    act = await import('../../server/dist/spaces/rdf-import-act.js');
  });
  after(async () => { act?.setRdfImportKnobsForTest?.(null); await d?.close(); });

  it('before the first window: the import ends 409 rdf_import_space_changed, writes nothing and releases the space', async () => {
    let changed = 0;
    act.setRdfImportKnobsForTest({ hooks: { afterRegister: () => { changed += 1; rebase(EARLY); } } });
    let r;
    try { r = await d.importRest(writer.key, EARLY, goodTurtle(EARLY)); } finally { act.setRdfImportKnobsForTest(null); }
    assert.equal(changed, 1, 'the base changed after the act was registered');
    assert.equal(r.status, 409, r.text.slice(0, 500));
    assert.equal(r.body?.code, 'rdf_import_space_changed', r.text.slice(0, 500));
    assert.deepEqual(await d.records(EARLY, 'entities'), [], 'nothing was written');
    assert.deepEqual(d.actsOf(EARLY), [], 'the act is not owed: it ended, and the space is released');
    const save = await d.rest(writer.key, 'POST', `/api/brain/spaces/${EARLY}/entities`, { name: 'After', type: 'person' });
    assert.ok(save.status < 300, `the space takes writes again: ${save.status} ${save.text?.slice(0, 200)}`);
  });

  it('after the first window landed: nothing ends the import, it finishes by the base it began with', async () => {
    let changed = 0;
    act.setRdfImportKnobsForTest({ window: 1, hooks: { afterCommitWindow: (committed) => { if (committed === 1 && changed === 0) { changed += 1; rebase(LATE); } } } });
    let r;
    try { r = await d.importRest(writer.key, LATE, goodTurtle(LATE)); } finally { act.setRdfImportKnobsForTest(null); }
    assert.equal(changed, 1, 'the base changed after the first window');
    assert.equal(r.status, 200, r.text.slice(0, 500));
    assert.equal(r.body.status, 'completed');
    assert.deepEqual((await d.records(LATE, 'entities')).map(e => e.name).sort(), ['Alice', 'Bob']);
    assert.equal((await d.records(LATE, 'edges')).length, 1);
    assert.deepEqual(d.actsOf(LATE), []);
  });
});
