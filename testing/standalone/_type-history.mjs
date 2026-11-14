/**
 * What the Q-744 tests of a type's history (bundle-268, design r4 §1 to §6, §10 T2 to T13) share: the schema-versions door asked on both
 * doors in the new forms, the guarded load of the modules the design names, and the brute-force oracle a glyph, a standing and a
 * definition are checked against.
 *
 * ## The question each answers
 *
 * - {@link typeDoors} - *"what does each door answer for these parameters?"* `fps` travels as one comma-separated query value on REST and
 *   as an array of strings on MCP (r4 §5), so a test states the parameters once and both doors receive them in their own spelling.
 * - {@link need} - *"does the built server export what the design names?"* A missing module or export is one assertion that names it,
 *   so before the build every case is red for that one reason, never for a TypeError three lines later.
 * - {@link olderOracle} - *"would `older` (any) open a record of T?"*, decided from the records and the version texts alone: every stored
 *   record read directly (no index, no server pass), every text read from the snapshot rows, and sameness from the diff's own primitive
 *   (`typesDifferingUnder`), the one thing r4 §0 says decides it. It shares no line with the pass it checks.
 *
 * ## What a hand-written copy drops
 *
 * - **The string-typed rule.** A record whose type field is an array holding T matches `{type: T}` in Mongo; it is not a record of T
 *   (r3 §7.1, amend V7). The oracle keeps only `typeof field === 'string'`.
 * - **The unnamed rule.** A stamp carried by any record whose type is neither a string nor absent is unclassified for every type
 *   (schema-version-filter.ts `unnamed`); the oracle finds those stamps by reading every record, not through R2.
 * - **The current version is the config's.** `variationOf`, never a row.
 */
import assert from 'node:assert/strict';

const DIST = '../../server/dist/';

/** The field a kind's records name their type in, and the collection that holds them. */
export const KIND_PARTS = Object.freeze({ entity: 'entities', fact: 'facts', edge: 'edges', chrono: 'chrono' });
export const typeFieldOfKind = (kind) => (kind === 'edge' ? 'label' : 'type');

/** `rel` under server/dist, with every name in `names` exported; fails as one assertion naming what is missing. */
export async function need(rel, names) {
  const mod = await import(`${DIST}${rel}`).catch(err => ({ __missing: err }));
  assert.ok(!mod.__missing, `server/dist/${rel} does not load (${mod.__missing?.code ?? mod.__missing?.message})`);
  const absent = names.filter(n => mod[n] === undefined);
  assert.deepEqual(absent, [], `server/dist/${rel} does not export ${absent.join(', ')}`);
  return mod;
}

/** The query string of `params` as REST takes it: `fps` joined by commas, every other value as it is. */
export function queryOf(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, Array.isArray(v) ? v.join(',') : String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * Both doors of `GET /api/spaces/:id/schema-versions` / MCP `space_schema_versions`, over a door from `_view-doors.mjs`.
 * Each answers `{ door, status, refused, body, text }`; `body` is the REST body or the tool's structured content.
 */
export function typeDoors(d) {
  return {
    REST: async (key, space, params = {}) => {
      const r = await d.rest(key, 'GET', `/api/spaces/${encodeURIComponent(space)}/schema-versions${queryOf(params)}`);
      return { door: 'REST', status: r.status, refused: r.status >= 400, body: r.body ?? {}, text: r.text };
    },
    MCP: async (key, space, params = {}) => {
      const r = await d.mcp(key, 'space_schema_versions', { space, ...params });
      return { door: 'MCP', status: r.status, refused: r.isError, body: r.structured ?? {}, text: r.text };
    },
  };
}

/** Every page of a `kind` or `kind`+`type` read, following `nextSkip`, joined on `listKey` (`types` or `definitions`). */
export async function allPages(call, key, space, params, listKey) {
  const out = [];
  let skip = 0;
  for (let page = 0; page < 200; page++) {
    const r = await call(key, space, { ...params, ...(skip ? { skip } : {}) });
    assert.ok(!r.refused, `${r.door} ${JSON.stringify(params)} skip ${skip} was refused: ${r.text.slice(0, 300)}`);
    assert.ok(Array.isArray(r.body[listKey]), `${r.door} ${JSON.stringify(params)} answered no ${listKey} array: ${r.text.slice(0, 300)}`);
    out.push(...r.body[listKey]);
    if (typeof r.body.nextSkip !== 'number') return { rows: out, last: r };
    skip = r.body.nextSkip;
  }
  assert.fail('more than 200 pages');
}

/** The rows of a `kind` read, keyed by type name in a Map (a type named `__proto__` reaches no prototype). */
export const rowsByType = (rows) => new Map(rows.map(r => [r.type, r]));

/**
 * The brute-force standing of every stamp a string-typed record of (kind, T) carries, against the space's current version.
 * @returns `{ stamps: Map<fp, 'current' | 'older' | 'notHeld' | 'unclassified'>, older: boolean }` where `older` is whether some
 *   string-typed record of T is on a stamp that is not `current` (the glyph rule, r4 §3.3 and §4).
 */
export async function olderOracle(mongo, spaceId, kind, T) {
  const { typesDifferingUnder } = await import(`${DIST}spaces/schema-diff.js`);
  const { variationOf } = await import(`${DIST}spaces/schema-stamp.js`);
  const { text: currentText, fp: current } = variationOf(spaceId).stamp;
  const tf = typeFieldOfKind(kind);
  const records = await mongo.col(`${spaceId}_${KIND_PARTS[kind]}`).find({}, { projection: { [tf]: 1, schemaFingerprint: 1 } }).toArray();
  const unnamed = new Set(records.filter(r => typeof r.schemaFingerprint === 'string' && r[tf] !== undefined && r[tf] !== null && typeof r[tf] !== 'string')
    .map(r => r.schemaFingerprint));
  const texts = new Map((await mongo.col(`${spaceId}_schema_snapshots`).find({}).toArray()).map(r => [r._id, r.text]));
  texts.set(current, currentText);
  const standingOf = (fp) => {
    if (fp === current) return 'current';
    const from = texts.get(fp);
    if (typeof from !== 'string') return 'notHeld';
    if (unnamed.has(fp)) return 'unclassified';
    const td = typesDifferingUnder(from, currentText, 'any');
    if (td.unclassified) return 'unclassified';
    const k = td.kinds.get(kind);
    return k === 'all' || (k instanceof Set && k.has(T)) ? 'older' : 'current';
  };
  const stamps = new Map();
  for (const r of records) {
    if (typeof r[tf] !== 'string' || r[tf] !== T || typeof r.schemaFingerprint !== 'string') continue;
    if (!stamps.has(r.schemaFingerprint)) stamps.set(r.schemaFingerprint, standingOf(r.schemaFingerprint));
  }
  return { stamps, older: [...stamps.values()].some(s => s !== 'current') };
}

/** The type names a version text declares for `kind`, read through the server's own tolerant parse. */
export async function declaredIn(text, kind) {
  const { versionMetaOf } = await import(`${DIST}spaces/schema-version-text.js`);
  return Object.keys(versionMetaOf(text)?.meta?.typeSchemas?.[kind] ?? {});
}
