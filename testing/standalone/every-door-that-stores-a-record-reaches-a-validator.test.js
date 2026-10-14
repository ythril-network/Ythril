/**
 * Every route and every tool that can STORE a record with properties reaches a validator for that kind (Q-93, R6-16).
 *
 * ## The rule, and why the existing gates could not hold it
 *
 * Q-93 turns "the type's list of keys" into a rule enforced wherever a record is stored. A rule enforced at SOME of the
 * doors teaches the false contract (`E-3`): the one that forgets it is the one nobody sees. The gates that exist for it ask
 * the wrong direction. `every-writer-validates-internally` starts from eight writers a person listed, and its sweep over
 * the doors starts from nine files a person listed — a door that never validates is not in either list, so it cannot fail
 * either. `a-validator-caller` style gates start from the CALLERS of the validator, which a door with no validator is not.
 *
 * So this one starts from the other end, as `a-read-never-writes-a-space` does: from every WRITE to a record collection and
 * every ROUTE and TOOL registration, and asks each door what it reaches.
 *
 * ## What is derived, so nothing here is a list of doors
 *
 * - **The doors**: every route `_routes.mjs` finds mounted, and every tool object in the index (a `name:` literal and a
 *   `handle`), each rooted by `_call-graph.mjs`, plus the tool dispatch and a `callTool({ name: '...' })` edge for a REST
 *   door that is a tool.
 * - **The writes**: every storing write (`insert*`, `update*`, `replace*`, `findOneAnd{Update,Replace}`, `bulkWrite`: the
 *   methods `db/record-write-observer.ts` classifies as writes, never a list written here) on a collection whose kind has a
 *   validator, plus every write whose collection name is computed (it may be any kind). The kinds are derived from the
 *   validator module's exports (`_validation-entry-points.mjs`): `validateFact` is the validator of the `facts` collection
 *   because the collection is the one whose name starts like the kind does. Files and links carry no properties and have
 *   no validator, so they are not governed here.
 * - **The validators**: what a door REACHES. A door satisfies a write when something it reaches calls a validator or a
 *   classifier of that kind; a computed-collection write is satisfied by a validator of any kind (it cannot be told which).
 *
 * ## The exemptions are per WRITE SITE and each carries its reason
 *
 * A write that stores nobody's properties (a vector sweep, a seq stamp, a spaceId repair, a restore of a backup) is named
 * `path:function` with the reason it is not the rule's. A row that no door reaches any more, or whose function no longer
 * writes a governed collection, fails — the table cannot outlive what it excuses.
 *
 * ## What it concludes about, and what it does not
 *
 * "Reaches" is not "validates BEFORE it writes" and not "validates the record the door wrote": the writers' own gates hold
 * the order. This gate holds that a door with a write and no validator anywhere on its walk cannot exist unnamed. It does not
 * see a method on a class instance or a function looked up at runtime (`_call-graph.mjs` names each); the orphan check below
 * holds that no governed write sits where the index cannot attribute it to a function.
 *
 * ## Seen red
 *
 * On the base, by itself: every door that PULLS a peer's records (network sync, join, invite finalize) reaches
 * `writeArrivals` and no validator — the pull records nothing, which is the gap R6-9 closes with one recording site in
 * `acceptArrivingPage`. And by mutation, in memory (no source is edited): a synthetic tool and a synthetic route that store
 * an entity and call no validator are found; one that validates the WRONG kind is found; one that validates is clean
 * (`doorsWithoutAValidator` is run over an index built from the real sources plus the synthetic file).
 *
 * Run: node --test testing/standalone/every-door-that-stores-a-record-reaches-a-validator.test.js   (needs `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { indexSources, toolHandlerRoot, routeHandlerRoots, walkFrom, pathTo } from './_call-graph.mjs';
import { mountedRoutes } from './_routes.mjs';
import { recordWrites } from './_record-writes.mjs';
import { validationEntryPoints, callsOf } from './_validation-entry-points.mjs';
import { DISPATCH_SOURCES } from './_tool-dispatch.mjs';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const { BRAIN_COLLECTIONS } = await import('../../server/dist/config/types.js');
const { COLLECTION_METHOD_EFFECT } = await import('../../server/dist/db/record-write-observer.js');
const ENTRY_POINTS = await validationEntryPoints();

/** The methods that store content: the observer's writes, less the ones that only delete. */
const STORING = Object.entries(COLLECTION_METHOD_EFFECT)
  .filter(([, e]) => typeof e === 'object' && e.write && !e.initializes)
  .map(([m]) => m)
  .filter(m => !/^initialize/.test(m));

/**
 * kind word (`Entity`) -> the collection it is validated for (`entities`), derived: the validator `validate<Kind>` governs
 * the BRAIN collection whose name begins with the kind's first four letters, lowercased. Thrown on none or on two, so a
 * rename that breaks the correspondence is a failure here and not a door that silently stopped being governed.
 */
function kindCollections() {
  const out = new Map();
  for (const v of ENTRY_POINTS.validators) {
    const kind = v.replace(/^validate/, '');
    const stem = kind.slice(0, 4).toLowerCase();
    const hits = BRAIN_COLLECTIONS.filter(c => c.startsWith(stem));
    assert.equal(hits.length, 1, `validator ${v}: expected exactly one BRAIN collection starting '${stem}', found ${hits.length} (${hits})`);
    out.set(kind, hits[0]);
  }
  return out;
}
const KIND_COLLECTION = kindCollections();
const GOVERNED = new Set(KIND_COLLECTION.values());

/** The sources, as `moduleIndex` reads them (tracked and untracked), keyed by repo path — so a test can add a file in memory. */
function readSources() {
  const files = trackedSources('server/src', { untracked: true });
  return new Map(files.map(f => [f, readFileSync(join(REPO_ROOT, f), 'utf8')]));
}

/**
 * Doors that store a governed record and reach no validator of its kind — over any index, so the same function judges the
 * real tree and an in-memory one with a door added.
 *
 * @param {{ index: object, routes: object[], exempt: Record<string,string> }} o
 * @returns {{ doors: object[], offenders: string[], reached: Map<string, string[]>, usedExemptions: Set<string> }}
 */
function doorsWithoutAValidator({ index, routes, exempt }) {
  const roots = new Map(routes.map(r => [`${r.method} ${r.path}`, routeHandlerRoots(index, r)]));
  const records = recordWrites(index, { collections: BRAIN_COLLECTIONS, floors: { space: 150 }, recordFloor: 50 });
  const dispatchRoots = [...index.bodies.keys()].filter(k => DISPATCH_SOURCES.some(f => k === `${f}:callTool`));
  assert.ok(dispatchRoots.length > 0, 'the tool dispatch (callTool) is not in the index — re-anchor');
  const toolObjects = [...index.objects.values()].filter(o => o.strings.get('name') && index.bodies.has(`${o.file}:${o.name}.handle`));
  const dispatchedTools = entry => [...entry.body.matchAll(/\bcallTool\s*\(\s*\{\s*name:\s*['"]([a-z_]+)['"]/g)]
    .map(m => { try { return toolHandlerRoot(index, m[1]); } catch { return null; } }).filter(Boolean);

  const doors = [
    ...routes.map(r => ({ label: `${r.method} ${r.path}`, kind: 'route', roots: roots.get(`${r.method} ${r.path}`) })),
    ...toolObjects.map(t => ({ label: `MCP ${t.strings.get('name')}`, kind: 'tool', roots: [`${t.file}:${t.name}.handle`, ...dispatchRoots] })),
  ];

  const offenders = [];
  const reached = new Map();
  const usedExemptions = new Set();
  for (const door of doors) {
    const { seen, parent } = walkFrom(index, door.roots, { closures: true, edges: dispatchedTools });
    // The kinds of validator this door reaches, by name: `Entity` for `validateEntity(` or `classifyEntityUpsertAgainst(`.
    const validatedKinds = new Set();
    for (const key of seen) {
      for (const call of callsOf(ENTRY_POINTS.all, index.bodies.get(key).body)) {
        for (const kind of KIND_COLLECTION.keys()) if (call.includes(kind)) validatedKinds.add(kind);
      }
    }
    const writes = [];
    for (const key of seen) {
      for (const s of records.byKey.get(key) ?? []) {
        if (!STORING.includes(s.op)) continue;
        const governedCollection = s.collection != null && GOVERNED.has(s.collection);
        const computed = s.collection == null;
        if (!governedCollection && !computed) continue;
        writes.push({ site: s, path: pathTo(parent, key) });
      }
    }
    if (writes.length > 0) reached.set(door.label, writes.map(w => `${w.site.key}[${w.site.op}:${w.site.collection ?? '?'}]`));
    for (const { site, path } of writes) {
      if (site.key in exempt) { usedExemptions.add(site.key); continue; }
      const needs = site.collection == null ? null
        : [...KIND_COLLECTION].find(([, c]) => c === site.collection)[0];
      const satisfied = needs == null ? validatedKinds.size > 0 : validatedKinds.has(needs);
      if (!satisfied) {
        offenders.push(`${door.label}\n      writes ${site.key.replace('server/src/', '')}:${site.line} .${site.op}() on ${site.collection ?? `a computed collection (${site.why})`}`
          + `\n      reaches a validator of: ${[...validatedKinds].join(', ') || 'no kind'}; needs ${needs ?? 'any kind'}`
          + `\n      via ${path.map(k => k.replace(/^server\/src\//, '')).join(' > ')}`);
      }
    }
  }
  return { doors, offenders: [...new Set(offenders)], reached, usedExemptions, records };
}

/**
 * Writes to a governed (or computed) collection that store nobody's caller-chosen properties, and why. Keyed `path:function`.
 * A row no door reaches, or whose function writes no governed collection, fails (`every exemption still excuses a write`).
 */
const EXEMPT = {
  'server/src/brain/suppression-sweep.ts:sweepSuppressedVectors':
    'a network\'s meta change that turns suppression on removes the stored VECTORS of what it now suppresses: derived, local '
    + 'fields (`embedding`, `embeddingModel`) of records already held; no property is written',
  'server/src/brain/write-plan/commit.ts:clearStaleWriteGuard':
    'builds the edges\' write-guard index and `$unset`s `_functionalGuard`, a local-only field (`WRITE_GUARD_FIELDS`), on edges '
    + 'already held; no property is written',
  'server/src/spaces/_shared.ts:repairStaleSpaceIds':
    'space creation reached from membership gossip repairs a stale `spaceId` on records already stored: one field, no property',
  'server/src/sync/delivered-by-backfill.ts:stampCollection':
    'the one-time stamp of who delivered rows stored before `deliveredBy` existed: a local-only field on rows already held',
  'server/src/db/restore.ts:restoreDatabase':
    'a restore of a backup replaces the database with what the backup holds; it is not a write of a caller\'s record and the '
    + 'operator who restores it chose the whole of it (a restore, like an import, keeps what it was given)',
  'server/src/brain/chrono-redaction.ts:redactLapsedChronoContent':
    'the retention sweep REMOVES the content of a chrono entry whose window passed and stamps the redaction marks: no caller-chosen '
    + 'property is written (it is reached from the boot walk, which a setup route starts)',
  'server/src/files/rekey-rows.ts:rekeyRows':
    'moves the derived rows of a FILE to a new path (a file move): a re-key of rows no door authors, whatever collection the '
    + 'caller names; it writes no entity, edge, fact or chrono property',
};

const INDEX = indexSources(readSources(), { functionFloor: 500, label: 'server/src' });
const ROUTES = mountedRoutes();
const RESULT = doorsWithoutAValidator({ index: INDEX, routes: ROUTES, exempt: EXEMPT });

describe('the derivation works', () => {
  it('found the doors and the writes (floors)', () => {
    const routes = RESULT.doors.filter(d => d.kind === 'route').length;
    const tools = RESULT.doors.filter(d => d.kind === 'tool').length;
    assert.ok(routes >= 150, `only ${routes} route door(s) — the route derivation broke and every route would pass`);
    assert.ok(tools >= 60, `only ${tools} tool door(s) — the tool derivation broke and every tool would pass`);
    assert.ok(RESULT.reached.size >= 40, `only ${RESULT.reached.size} door(s) reach a storing write on a governed collection — the walk or the writer set broke`);
    assert.ok(STORING.length >= 6 && STORING.includes('updateOne') && STORING.includes('bulkWrite') && !STORING.includes('deleteOne'),
      `the storing methods read from the observer are wrong: ${STORING}`);
    assert.deepEqual([...GOVERNED].sort(), ['chrono', 'edges', 'entities', 'facts'], 'the governed collections are not the four kinds that carry properties');
  });

  it('the doors this rule was written about are among those that store a record', () => {
    for (const label of ['POST /api/brain/spaces/:spaceId/entities', 'PATCH /api/brain/spaces/:spaceId/facts/:id', 'POST /api/brain/spaces/:spaceId/bulk',
      'MCP save_entity', 'MCP update_chrono', 'MCP save_bulk', 'MCP graph_merge', 'POST /api/sync/batch-upsert', 'POST /api/admin/spaces/:spaceId/import']) {
      assert.ok(RESULT.reached.has(label), `${label} is not among the doors that reach a governed write — the derivation lost a whole door`);
    }
  });

  it('no governed write sits where the index cannot attribute it to a function', () => {
    const orphans = RESULT.records.orphans.filter(o => STORING.includes(o.op) && (o.collection == null || GOVERNED.has(o.collection)))
      .map(o => `${o.file}:${o.line} .${o.op}() (${o.collection ?? o.why})`);
    assert.deepEqual(orphans, [], 'a record write outside every indexed function is one no door walk can reach, so this gate would pass over it');
  });
});

describe('every door that stores a record reaches a validator of its kind', () => {
  it('on the real tree', () => {
    assert.deepEqual(RESULT.offenders, [],
      `${RESULT.offenders.length} door/write pair(s) store a record the space's schema never sees. A door that reaches a write and no validator `
      + 'is how a rule enforced at some doors teaches a false contract. Route the write through a writer that validates (or, for a '
      + 'record-not-refuse door, the recorder), or name the write in EXEMPT with the reason it stores no properties:\n\n'
      + RESULT.offenders.join('\n\n'));
  });

  it('every exemption still excuses a write a door reaches', () => {
    const stale = Object.keys(EXEMPT).filter(k => !RESULT.usedExemptions.has(k));
    assert.deepEqual(stale, [], 'exemptions for functions no door reaches, or that write no governed collection any more — delete them');
  });
});

describe('seen red: the same function over an index with a door added', () => {
  const NEW_TOOL = 'server/src/mcp/tools/zz-new-door.ts';
  const NEW_ROUTE = 'server/src/api/zz-new-door.ts';

  /** The real sources plus one synthetic file, judged as the real tree is; `routes` gains a synthetic route when asked. */
  function judge({ file, text, route }) {
    const sources = readSources();
    sources.set(file, text);
    const index = indexSources(sources, { functionFloor: 500, label: 'server/src plus a synthetic door' });
    const routes = [...ROUTES];
    if (route) {
      const at = stripComments(text).indexOf(route.registration);
      assert.ok(at > -1, 'the synthetic route registration was not found in its own source');
      routes.push({ method: route.method, path: route.path, file, at });
    }
    return doorsWithoutAValidator({ index, routes, exempt: EXEMPT });
  }

  // Flush left: the index finds a top-level `const x = {` only at the start of a line.
  const tool = (name, body, imports = '') => [
    `import { col } from '../../db/mongo.js';`,
    `import { spaceCollection } from '../../db/space-collection.js';`,
    imports,
    'export const zzTool = {',
    `  name: '${name}',`,
    '  async handle(ctx) {',
    `    ${body}`,
    '  },',
    '};',
    '',
  ].join('\n');
  const STORE_ENTITY = `await col(spaceCollection(ctx.args.space, 'entities')).updateOne({ _id: ctx.args.id }, { $set: { properties: ctx.args.properties } });`;

  it('a tool that stores an entity and calls no validator is found', () => {
    const r = judge({ file: NEW_TOOL, text: tool('zz_new_door', STORE_ENTITY) });
    assert.ok(r.offenders.some(o => o.startsWith('MCP zz_new_door')), `the new door was not found; offenders: ${r.offenders.map(o => o.split('\n')[0])}`);
  });

  it('a route that stores a fact and calls no validator is found', () => {
    const text = `
      import { Router } from 'express';
      import { col } from '../db/mongo.js';
      import { spaceCollection } from '../db/space-collection.js';
      export const zzRouter = Router();
      zzRouter.post('/api/zz-new-door', async (req, res) => {
        await col(spaceCollection(req.body.space, 'facts')).insertOne({ properties: req.body.properties });
        res.json({});
      });
    `;
    const r = judge({ file: NEW_ROUTE, text, route: { method: 'POST', path: '/api/zz-new-door', registration: 'zzRouter.post(' } });
    assert.ok(r.offenders.some(o => o.startsWith('POST /api/zz-new-door')), `the new route was not found; offenders: ${r.offenders.map(o => o.split('\n')[0])}`);
  });

  it('a door that validates the WRONG kind is found: a fact validator does not cover an entity write', () => {
    const r = judge({
      file: NEW_TOOL,
      text: tool('zz_wrong_kind', `validateFact({}, { properties: ctx.args.properties });\n${STORE_ENTITY}`,
        `import { validateFact } from '../../spaces/schema-validation.js';`),
    });
    assert.ok(r.offenders.some(o => o.startsWith('MCP zz_wrong_kind')), 'a validator of another kind satisfied the write');
  });

  it('a door that calls the classifier of its kind is clean (the control: the function does not flag everything)', () => {
    const r = judge({
      file: NEW_TOOL,
      text: tool('zz_clean_door', `classifyEntityUpsertAgainst({}, null, { name: 'n', type: 't', properties: ctx.args.properties });\n${STORE_ENTITY}`,
        `import { classifyEntityUpsertAgainst } from '../../brain/write-validation.js';`),
    });
    assert.deepEqual(r.offenders.filter(o => o.startsWith('MCP zz_clean_door')), [], 'a door that validates its kind was flagged');
  });
});
