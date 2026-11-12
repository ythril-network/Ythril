/**
 * A strict space behind the REST app and the MCP dispatch, and the fingerprint its records must carry — what the Q-736 database tests
 * of the schema stamp (bundle-265) each need.
 *
 * ## Why a module
 *
 * Three test files ask the same two things: a door onto a space whose schema refuses (`openB81cDoor` with the app, the space's meta set
 * through `updateSpace`, the one funnel of meta writes), and "which fingerprint is current". The second is the guard a copy drops: the
 * expected value is read from the server's own `readMetaForWrite(spaceId).stamp.fp` (`spaces/schema-stamp.ts`), never hashed here, so
 * a test cannot pass on a fingerprint the server would not stamp, and it ASSERTS the module exists with a sentence naming it rather
 * than failing on an import error.
 */
import assert from 'node:assert/strict';
import { openB81cDoor, moduleOrNull } from './_b81c-door.mjs';

/** The schema every stamp test writes against: one type per kind, each with a property a write can break. */
export const STRICT_META = Object.freeze({
  suppressEmbeddings: true,
  validationMode: 'strict',
  typeSchemas: {
    entity: { person: { propertySchemas: { age: { type: 'number' } } } },
    fact: { claim: { propertySchemas: { confidence: { type: 'number' } } } },
    chrono: { event: { propertySchemas: { priority: { type: 'string', enum: ['low', 'high'] } } } },
    edge: { knows: { propertySchemas: { since: { type: 'number' } } }, likes: {} },
  },
});

/** The four record collections a stamp is written on. */
export const STAMPED_PARTS = Object.freeze(['entities', 'facts', 'chrono', 'edges']);

/**
 * Open the door with `spaces` and give each the meta `metaOf(space)` returns (default {@link STRICT_META}).
 *
 * @returns the b81c door plus `setMeta(space, meta)`, `fp(space)`, `fpOrNull(space)`, `assertStamped(space, row, what)`,
 *   `stored(space, part, id)` and `unstamp(space, part, id)`.
 */
export async function openSchemaStampDoor({ name, spaces, metaOf = () => STRICT_META }) {
  const door = await openB81cDoor({ name, spaces, app: true });
  const { updateSpace } = await import('../../server/dist/spaces/spaces.js');
  const { getConfig } = await import('../../server/dist/config/loader.js');

  /** Replace the space's meta through the one funnel of meta writes, keeping what the door set (`suppressEmbeddings`). */
  function setMeta(space, meta) {
    const now = getConfig().spaces.find(s => s.id === space)?.meta ?? {};
    const done = updateSpace(space, { meta: { ...now, ...structuredClone(meta) } });
    assert.ok(done, `updateSpace did not find the space ${space}`);
  }
  for (const s of spaces) setMeta(s, metaOf(s));

  /** The fingerprint a write to `space` must stamp now, as the server computes it. */
  async function fp(space) {
    const m = await moduleOrNull('spaces/schema-stamp.js');
    assert.ok(m && typeof m.readMetaForWrite === 'function',
      'server/src/spaces/schema-stamp.ts (readMetaForWrite) is not built: no write can know the fingerprint of the schema it validated with');
    const value = m.readMetaForWrite(space)?.stamp?.fp;
    assert.match(String(value), /^[0-9a-f]{64}$/, `readMetaForWrite(${space}).stamp.fp is not a sha-256: ${value}`);
    return value;
  }

  /** The same, or null when the stamp module is not built: for a case that collects every door's failure before it judges. */
  async function fpOrNull(space) {
    const m = await moduleOrNull('spaces/schema-stamp.js');
    return m && typeof m.readMetaForWrite === 'function' ? m.readMetaForWrite(space)?.stamp?.fp ?? null : null;
  }

  /**
   * `row` carries the space's current fingerprint. The absence of a stamp is said first, as what the write did; only then is the
   * value compared with the server's own fingerprint.
   */
  async function assertStamped(space, row, what) {
    assert.ok(row, `${what}: no stored row`);
    assert.equal(typeof row.schemaFingerprint, 'string', `${what}: the stored row carries no stamp, though it conforms`);
    assert.equal(row.schemaFingerprint, await fp(space), `${what}: the stored stamp is not the fingerprint of the schema the write was checked against`);
  }

  /** The stored row, whole. */
  const stored = (space, part, id) => door.coll(space, part).findOne({ _id: id });
  /** Make a row look written before this release: no stamp. */
  const unstamp = (space, part, id) => door.coll(space, part).updateOne({ _id: id }, { $unset: { schemaFingerprint: '' } });

  return { ...door, setMeta, fp, fpOrNull, assertStamped, stored, unstamp };
}
