/**
 * The shared fixtures of every bundle-265 test that reads a schema fingerprint (Q-734): one meta, its reordered twin, the text a fingerprint is
 * taken from, and a space whose STORED meta a case can replace — so each case asks the server for the stamp of exactly the meta it built.
 *
 * ## Why a module
 *
 * The fingerprint tests (this slice's pure file, its db file, the stamp lint's planted sources, the wire and fetch tests) all need the same
 * three things: a meta with a library `$ref`, an inline twin of it, and a way to ask "what is the fingerprint of THIS stored meta". The server
 * answers that one way only — `readMetaForWrite(spaceId).stamp` — so the fixture is a config with one space whose `meta` a case swaps. A copy of
 * this in each file is the copy that goes stale when the answer's shape changes.
 *
 * ## What it does not do
 *
 * It computes no fingerprint itself except `sha256Hex`, the one function a fingerprint is named by (`sha256(utf8(text))`): the TEXT always comes from
 * the code under test (`schemaFingerprintTextOf`, `readMetaForWrite`), so a case never asserts that the code equals a copy of itself.
 */
import { createHash } from 'node:crypto';
import { bootInstance } from './_vote-round-instance.mjs';

/** `sha256` of the text as UTF-8, hex: what a fingerprint IS. */
export const sha256Hex = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

export const clone = (v) => JSON.parse(JSON.stringify(v));

/** The same value with the keys of every object written in the opposite order, at every level. Arrays keep their order. */
export const deepReverse = (v) => Array.isArray(v) ? v.map(deepReverse)
  : (v && typeof v === 'object') ? Object.fromEntries(Object.keys(v).reverse().map(k => [k, deepReverse(v[k])])) : v;

/** A library entry as `saveSchemaLibrary` holds it. */
export const PERSON_DEFINITION = Object.freeze({
  description: 'A human', namingPattern: '^[A-Z].*',
  propertySchemas: { born: { type: 'date', description: 'birth date' }, email: { type: 'string', pattern: '^.+@.+$' } },
});
export const personEntry = (schema = PERSON_DEFINITION) => ({ name: 'person', knowledgeType: 'entity', typeName: 'person', schema: clone(schema) });

/**
 * A meta that has every left-out field (`purpose`, `validationMode`, history, ...), a library `$ref`, an own type, an edge with endpoints,
 * and a space rule: the one the fingerprint cases edit one thing of at a time.
 */
export const baseMeta = () => ({
  purpose: 'fingerprint fixture', validationMode: 'strict', strictLinkage: true, version: 7, updatedAt: '2026-11-12T00:00:00Z',
  previousVersions: [{ version: 6, meta: {}, updatedAt: '2026-11-11T00:00:00Z' }], unknownWriteFields: 'warn',
  typeSchemas: {
    entity: {
      person: { $ref: 'library:person' },
      project: { description: 'A project', propertySchemas: { status: { type: 'string', enum: ['open', 'done'] } } },
    },
    edge: { owns: { description: 'owner of', endpoints: { from: ['person'], to: ['project'] }, functional: true } },
    fact: {},
  },
  rules: { r1: { rule: 'true', message: 'm', kinds: ['entity'] } },
});

/** `baseMeta()` with the library entry inlined: the same schema, written without the `$ref`. */
export const inlineTwinOfBase = () => {
  const m = baseMeta();
  m.typeSchemas.entity.person = clone(PERSON_DEFINITION);
  return m;
};

/**
 * Boot a config with one space (`spaceId`) and hand back `put(meta)`: replace that space's STORED meta (a new object each call, as a meta write
 * stores one) and answer `readMetaForWrite(spaceId)` for it. `put(undefined)` removes the meta, which is a space that never had a schema.
 * `loader.saveSchemaLibrary` is the library; the `$ref` expansion hook is installed as the server's boot installs it.
 */
export async function openStampSpace(dir, { spaceId = 'fp', spaces } = {}) {
  const loader = await bootInstance(dir, { instanceId: 'fingerprint-test', spaces: spaces ?? [{ id: spaceId, label: spaceId, folders: [] }] });
  await import('../../server/dist/spaces/library-ref-expansion.js');
  const stampMod = await import('../../server/dist/spaces/schema-stamp.js');
  const space = (id = spaceId) => loader.getConfig().spaces.find(s => s.id === id);
  const put = (meta, id = spaceId) => {
    if (meta === undefined) delete space(id).meta; else space(id).meta = clone(meta);
    return stampMod.readMetaForWrite(id);
  };
  return { loader, stampMod, put, space };
}
