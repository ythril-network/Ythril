/**
 * A space whose records a schema conversion run reads (bundle-284 slice 2, Q-746): the run module, the converter and the items module of
 * the server's build, a schema set through the one funnel of meta writes, and records seeded as a peer or this instance would store them.
 *
 * ## Why a module
 *
 * Every database test of the conversion run asks the same four things: a space with a schema, records of known version, position and
 * stamp, the fingerprint the run converts toward, and the run document and items it leaves. Written per file, the seeded rows would drift
 * apart (a row with no `seq` is a different record to the version filter than one with), and a test would pass on a fixture another test
 * could not reproduce.
 *
 * ## The guards a copy drops
 *
 * - **A module that is not built fails with a sentence naming it** (`need`), never with an import error naming a path.
 * - **The fingerprint is the server's own** (`readMetaForWrite(space).stamp.fp`), never hashed here, so a test cannot pass on a value the
 *   server would not stamp.
 * - **A seeded row carries a version, a position and an update time**, and the counter is raised above them, so a quiet stamp that moved any
 *   of them is seen, and a rewrite takes a version above every seeded one.
 */
import assert from 'node:assert/strict';
import { openB81cDoor, moduleOrNull } from './_b81c-door.mjs';

/** The schema the conversion tests start from: one type per kind, each with a property a step can rename. */
export const CONVERT_META = Object.freeze({
  validationMode: 'strict',
  typeSchemas: {
    entity: { person: { propertySchemas: { age: { type: 'number' }, nick: { type: 'string' } } } },
    fact: { claim: { propertySchemas: { confidence: { type: 'number' } } } },
    chrono: { event: { propertySchemas: { priority: { type: 'string', enum: ['low', 'high'] } } } },
    edge: { knows: { propertySchemas: { since: { type: 'number' } } }, likes: {} },
  },
});

/** When a seeded row was last written: a time no write of the test can produce. */
export const SEEDED_AT = '2026-01-01T00:00:00.000Z';

/**
 * Open a conversion test's space(s): the b81c door (database `b81tC_<name>`), each space given `metaOf(space)` (default
 * {@link CONVERT_META}), and the helpers below.
 */
export async function openConvertDoor({ name, spaces, metaOf = () => CONVERT_META, networks = [], instanceId }) {
  const door = await openB81cDoor({ name, spaces, networks, ...(instanceId ? { instanceId } : {}) });
  const { updateSpace } = await import('../../server/dist/spaces/spaces.js');
  const stampMod = await import('../../server/dist/spaces/schema-stamp.js');
  const { spaceCollection } = await import('../../server/dist/db/space-collection.js');

  /** Replace the space's meta through the one funnel of meta writes; embeddings stay suppressed so no model is asked. */
  function setMeta(space, meta) {
    const done = updateSpace(space, { meta: { suppressEmbeddings: true, ...structuredClone(meta) } });
    assert.ok(done, `updateSpace did not find the space ${space}`);
  }
  for (const s of spaces) setMeta(s, metaOf(s));

  /** The fingerprint a write to `space` stamps now, as the server computes it. */
  const fp = (space) => {
    const value = stampMod.readMetaForWrite(space).stamp.fp;
    assert.match(String(value), /^[0-9a-f]{64}$/, `readMetaForWrite(${space}).stamp.fp is not a sha-256: ${value}`);
    return value;
  };

  /** A built module of the slice, or a failure naming the file the slice creates. */
  async function need(rel, exportName) {
    const m = await moduleOrNull(rel);
    assert.ok(m && typeof m[exportName] === 'function',
      `server/src/${rel.replace(/\.js$/, '.ts')} (${exportName}) is not built: no schema conversion run exists to convert the records`);
    return m;
  }
  const runModule = () => need('spaces/schema-convert-run.js', 'startSchemaConvertRun');
  const recordModule = () => need('brain/schema-convert-record.js', 'convertOneRecord');
  const itemsModule = () => need('brain/schema-convert-items.js', 'listUnconvertedItems');

  let nextSeq = 100;
  /**
   * Insert `rows` into `part` of `space` as stored records: each gets the space id, empty tags and properties, `SEEDED_AT` as its times,
   * and a version and position of its own (unless the row names them), and the space's counter is raised above every one.
   */
  async function seed(space, part, rows) {
    const docs = rows.map(r => {
      nextSeq += 1;
      return { spaceId: space, tags: [], properties: {}, createdAt: SEEDED_AT, updatedAt: SEEDED_AT, seq: nextSeq, pos: nextSeq, posAtSeq: nextSeq, ...r };
    });
    await door.coll(space, part).insertMany(docs);
    await door.setCounter(space, nextSeq + 1_000);
    return docs;
  }

  /** The run document of `space`, or null. Through the registry, so a build without the kind fails here with its sentence. */
  const runDoc = (space) => door.mongo.col(spaceCollection(space, 'schemaConvertRun')).findOne({ _id: 'run' });
  /** Every item row of `space`. */
  const itemRows = (space) => door.mongo.col(spaceCollection(space, 'schemaConvertItems')).find({}).toArray();

  /**
   * Drive the run of `space` one pass at a time until it is complete (or `passes` are spent): the passes the watcher would make, without
   * its timer. Answers the run document as the last pass left it.
   */
  async function driveToEnd(space, deps = {}, passes = 20) {
    const run = await runModule();
    let doc = null;
    for (let i = 0; i < passes; i++) {
      await run.driveSchemaConvertRun(space, deps);
      doc = await runDoc(space);
      if (!doc || doc.state !== 'running') return doc;
    }
    return doc;
  }

  return { ...door, setMeta, fp, runModule, recordModule, itemsModule, seed, runDoc, itemRows, driveToEnd, spaceCollection };
}
