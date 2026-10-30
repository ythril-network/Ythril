/**
 * Every READ of a space's `edges` collection says whether a fork row counts: it carries the clause of
 * `brain/chosen-versions.ts` (or calls a builder that holds it), or sits in a reasoned exemption table
 * (Q-624, design rev 4 section 6, D8; a copy of `a-every-read-of-the-files-collection-says-whether-a-flagged-row-counts`).
 *
 * ## The rule
 *
 * A fork row is an unchosen version of a record. For an edge it is a row with the SAME five identity fields as its subject
 * and a `forkOf`. A reader that applies no clause answers "yes, that relationship exists twice" to whoever asks: a duplicate
 * where there is none, an endpoint-rule break, a contradiction of its own subject, a second edge under a functional label,
 * a parallel edge to the same neighbour. `CHOSEN_VERSION_ROWS` (`{ forkOf: null }`) is the one clause for "the record, not an
 * unchosen version of it", and it sits INSIDE the shared builders (`tripletClause`, `frontierEdgeQuery`,
 * `storedEdgeIdentities`, `relationshipEdgesOfRecord`), so a caller of those cannot drop it. A query uses the partial identity
 * index only when it names `forkOf: null`, so the clause is also what keeps the identity read indexed.
 *
 * ## Why a gate over the READERS, not over a spelling
 *
 * A gate that asks "is `forkOf: null` spelled outside the module" catches a spelling, not a reader that forgot the clause,
 * which is the defect. So the readers are DERIVED (`_call-graph.mjs` at function granularity, inline route handlers through
 * `_routes.mjs`): a function is a reader when it names the edges collection in any of the four forms
 *
 *  - `spaceCollection(x, 'edges')`;
 *  - a `${id}_edges` template;
 *  - a computed key (`spaceCollection(x, kind)`), which MAY be edges and is held to the rule rather than guessed away;
 *  - a computed suffix (`${id}_${suffix}`), the `REPLICATED_FAMILIES` loops
 *
 * and READS (`find`, `findOne`, `aggregate`, `countDocuments`, `distinct`, the by-id and `_id` pager helpers) or hands the
 * collection out. (A `$lookup` whose `from` is the edges collection is a fifth form; no function of the tree spells one today,
 * and the case below holds the matcher to it.)
 *
 * It CARRIES the clause when its body names an export of `chosen-versions.ts`, or calls one of the four builders. The exports
 * are read from the module, so a renamed clause cannot hide.
 *
 * The granularity is the function, as the files gate states: naming the clause inside the function counts. A finer gate would
 * be a parser for every filter expression.
 *
 * ## The exemption table
 *
 * Keyed `file:function` (an inline handler is `file:METHOD /path`), a reason each. It holds the design's "yes" rows (a fork is
 * a record, so list, count, search, export, sync paging, merkle, removal by id and wipe see it), the readers that handle the
 * collection rather than its rows, and the by-id reads. A stale entry (the function is gone or no longer reads edges) fails,
 * and an entry for a function that carries the clause fails too: one of the two is wrong.
 *
 * ## Red on the unchanged code
 *
 * `brain/chosen-versions.ts` does not exist, none of the four builders holds a clause, and `relationshipEdgesOfRecord` is not
 * written. After the change, seen red by hand twice (each put back by hand): the clause removed from `frontierEdgeQuery`, and
 * separately from `relationshipEdgesOfRecord`.
 *
 * Run: node --test testing/standalone/every-read-of-the-edges-collection-says-whether-a-fork-counts.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { moduleIndex, routeHandlerRoots } from './_call-graph.mjs';
import { mountedRoutes } from './_routes.mjs';
import { REPO_ROOT } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

const CLAUSE_MODULE = 'server/src/brain/chosen-versions.ts';

/** The shared builders that hold the clause inside them, by `file:function`. Each must name an export of the clause module. */
const BUILDERS = [
  'server/src/brain/edge-lookup.ts:tripletClause',
  'server/src/brain/frontier-query.ts:frontierEdgeQuery',
  'server/src/brain/relink-references.ts:storedEdgeIdentities',
  'server/src/brain/relink-references.ts:relationshipEdgesOfRecord',
];

/** `file:function` -> reason, for a group of functions that share one. */
const reasoned = (reason, keys) => Object.fromEntries(keys.map(k => [`server/src/${k}`, reason]));

/**
 * Functions that read the edges collection and carry no clause, with the reason. A reader NOT listed here and not carrying
 * the clause is a finding: either it needs the clause, or it belongs here with a reason somebody can check.
 */
const EXEMPT = {
  // ── a fork is a record: the readers that list, count, search, rank, hash, page, export or remove records see it, as a fact fork is seen today (design section 6, P4)
  ...reasoned('a fork row is a record of the space, as a fact fork is: this reader lists, counts, searches, ranks or reports records and shows a fork marked `forkOf`', [
    'brain/edges.ts:listEdges', 'brain/query.ts:queryBrain', 'brain/query.ts:countBrain', 'brain/lexical-search.ts:lexicalSearch',
    'brain/recall.ts:recallByType', 'brain/recall.ts:introduceLexicalOnly', 'brain/recall.ts:checkDuplicates', 'brain/recall.ts:hydrateFreshHits',
    'brain/recall.ts:getEntryEmbedding', 'spaces/completeness.ts:gatherCompletenessFacts', 'brain/space-shape.ts:build',
    'mcp/tools/spaces.ts:list_spacesTool.handle', 'mcp/tools/spaces.ts:space_statsTool.handle',
    'api/brain/search.ts:GET /api/brain/spaces/:spaceId/stats', 'api/spaces.ts:GET /api/spaces',
  ]),
  ...reasoned('a fork is an ordinary replicated row: sync paging, positions, merkle, export, import, removal and wipe carry it with the rest', [
    'api/sync/warm.ts:POST /api/sync/warm', 'app.ts:GET /api/admin/spaces/:spaceId/export', 'app.ts:createApp', 'api/sync/docs.ts:oneById',
    'sync/push-reads.ts:readPushStored', 'sync/arrivals.ts:writeArrivals', 'sync/arrival-recording.ts:watchArrivals',
    'sync/tombstone-apply.ts:applyPeerTombstones', 'sync/engine.ts:runSyncForMember', 'util/position-keyset.ts:readAfterPosition',
    'sync/record-position-stream.ts:positionFloor', 'sync/positions-owed.ts:carryRows', 'sync/positions-rollback.ts:rollBackPositions',
    'sync/delivered-by-backfill.ts:stampCollection', 'util/version-stamp.ts:heldTermsOf', 'util/version-stamp.ts:highestVersionBelowCap',
    'brain/merkle.ts:collectionLeaves', 'brain/record-removal.ts:removeChunk', 'brain/record-removal.ts:removeRecords', 'spaces/lifecycle.ts:wipeSpaceUnqueued',
    'spaces/lifecycle.ts:initSpace', 'spaces/record-count.ts:spaceRecordCount', 'spaces/schema-validate-door.ts:walkStored',
    'brain/embed-record.ts:embedStoredRecord', 'brain/suppression-sweep.ts:sweepSuppressedVectors', 'brain/ttl-sweep.ts:expiredPage',
    'brain/ttl-sweep.ts:isStored', 'brain/queue-embed-sweep.ts:countUnswept', 'brain/queue-embed-sweep.ts:queueEmbedSweep',
    'brain/candidate-prune.ts:pruneCandidateCollection', 'brain/chrono-redaction.ts:backfillTypedExpiry',
  ]),
  // Q-624 slice I3: the readers whose subject IS the fork rows, or a row's fork status.
  ...reasoned('the fork module itself: it reads fork rows on purpose (Review\'s list and resolve, the re-mint, the cascade, the cap) and names `forkOf` in every read', [
    'brain/forks.ts:refuseForkRowsNamed', 'brain/forks.ts:forkRowsUnder', 'brain/forks.ts:remintForks', 'brain/forks.ts:assertForksFitTogether',
    'brain/forks.ts:forksOfSpace', 'brain/forks.ts:resolveFork', 'brain/forks.ts:resolveOrphan', 'brain/fork-counts.ts:forkCountsOf',
  ]),
  ...reasoned('it reads one row by id to ask whether it IS a fork (the refusal of an ordinary edit), or removes fork rows a 5.6 build cannot read', [
    'brain/write-at-read-version.ts:writeAtReadVersion', 'sync/positions-rollback.ts:rollBackForks',
    // An applied tombstone's cascade asks which tombstoned subjects are still held before it removes their forks (Q-624 §7, R7).
    'sync/tombstone-apply.ts:cascadeToForks',
  ]),
  // ── the planner's own read of the unchosen versions: it exists to find the forks
  ...reasoned('it reads the FORK rows of the candidate parents on purpose (their count, their ids, the chain above them): the arrival planner needs every unchosen version, so a clause would blind the cap and the match by id', [
    'sync/push-reads.ts:readForkContext',
  ]),
  // ── a fork edge ending at a record is a reference to it, and the delete and the cascade count and remove it (design section 7)
  ...reasoned('a fork edge ending at the record is a reference to it: the delete guard and the cascade preview count it and the cascade removes it', [
    'brain/entity-delete-guard.ts:endsOfEdges', 'brain/entities.ts:findEntityReferences', 'brain/forks.ts:referencesTo',
  ]),
  // ── Q-305: the settle after an entity removal reads what still names the removed entity, a fork edge included
  ...reasoned('a fork edge written here that still names the removed entity is a reference to a gone record, taken back with the rest (delete) or found so the relink moves it (merge)', [
    'brain/gone-entity-references.ts:takeBackReferencesWrittenHere', 'brain/gone-entity-references.ts:moveReferencesToSurvivor',
  ]),
  // ── it reads by id: the id was chosen by something that already decided whether a fork counts
  ...reasoned('by id: the caller names the row, so the question whether a fork counts was answered where the id was chosen', [
    'brain/edges.ts:getEdgeById', 'brain/edges.ts:updateEdgeById', 'brain/traverse-bodies.ts:withTraverseBodies',
    'api/contradictions.ts:answerAlreadyResolved', 'brain/structured-claims.ts:readStructuredClaims',
    'brain/write-connections.ts:connectionSubject', 'brain/entity-refs.ts:missingRefs', 'sync/linkage-check.ts:missingTargets',
    'brain/links.ts:sourceDoc',
    // The read-back of a removal whose commit reply was lost: by the `_id`s the removal named, so a fork row (a different id) is never counted.
    'brain/tombstones.ts:removeWithTombstones',
  ]),
  // ── it names a computed collection that is never edges, or reads rows that no fork can be
  ...reasoned('its collection name is computed from a record kind that is not `edge` (an edge cannot be the endpoint of an edge or a link), or it reads rows no fork can be', [
    'brain/edge-endpoint-names.ts:resolveEndpointName', 'brain/edge-endpoint-names.ts:withEndpointNames', 'brain/link-adjacency.ts:docsFromCollection',
    'brain/links-conversion.ts:previewSpaceLinks', 'brain/links-conversion.ts:convertSpaceInWalk', 'auth/find-where-token-may.ts:findWhereTokenMay',
    'brain/dupe-scanner.ts:recordMatchedText', 'brain/dupe-scanner.ts:unchosenVersionsAmong',
  ]),
  // ── the functional guard: a fork row is never stamped, so a marker read finds the subject's edge alone
  ...reasoned('it reads rows by the functional-guard marker, which a fork row is never stamped with (design section 6)', [
    'brain/write-plan/heal-stale-marker.ts:healStaleMarker', 'spaces/edge-guard-index.ts:thinGuards',
  ]),
  // ── a relink moves the fork with its subject (design section 7): it counts what it will re-point and re-mints the forks
  ...reasoned('the relink reads every edge of a record, forks included, because the fork must follow its subject (re-minted, design section 7)', [
    'brain/merge.ts:relinkTally',
  ]),
};

const INDEX = moduleIndex('server/src');
for (const r of mountedRoutes()) routeHandlerRoots(INDEX, r);

/** How a body NAMES an edges collection. */
const NAMES = [
  ['literal', /spaceCollection\s*\(\s*[^,()]+,\s*['"]edges['"]\s*\)/],
  ['template', /`[^`]*\$\{[^}]*\}_edges`/],
  ['computed key', /spaceCollection\s*\(\s*[^,()]+,\s*[^'"\s)][^)]*\)/],
  ['computed suffix', /`[^`]*\$\{[^}]*\}_\$\{[^}]*\}`/],
  ['$lookup', /\$lookup\s*:\s*\{[^}]*?\bfrom\s*:\s*(?:`[^`]*edges`|['"][^'"]*edges['"]|[\w.]*edges\w*)/],
];
/** A type argument may nest one level, on every call (see the files gate: a flat-only matcher missed seven readers). */
const TYPE_ARGS = '(?:<(?:[^<>()]|<[^<>()]*>)*>)?';
const readCalls = (body) => [...body.matchAll(new RegExp(
  `\\.\\s*(?:find|findOne|aggregate|countDocuments|distinct)\\s*${TYPE_ARGS}\\s*\\(`
  + `|\\b(?:readStoredById|readRowsById|readRecordsById|distinctStringsOf)\\s*${TYPE_ARGS}\\s*\\(`
  + `|\\b(?:idKeysetPage|eachIdPage)\\s*${TYPE_ARGS}\\s*\\(`, 'g'))]
  .filter(m => !(m[0].includes('find') && /^\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(body.slice(m.index + m[0].length))));
const HANDS_OUT = /\breturn\s+col\b|=>\s*col\b/;

/** The names the clause module exports, read from its source. Throws (the gate's own red) when the module is not written. */
function clauseExports() {
  assert.ok(existsSync(join(REPO_ROOT, CLAUSE_MODULE)),
    `${CLAUSE_MODULE} does not exist: there is no one clause for "the record, not an unchosen version of it", so every edge reader answers for itself`);
  const src = blankComments(readFileSync(join(REPO_ROOT, CLAUSE_MODULE), 'utf8'));
  const names = [...src.matchAll(/export\s+(?:const|function|async function)\s+(\w+)/g)].map(m => m[1]);
  assert.ok(names.includes('CHOSEN_VERSION_ROWS'), `${CLAUSE_MODULE} does not export CHOSEN_VERSION_ROWS`);
  return names;
}

/** The names a reader may carry the clause by: the module's exports and the four builders' own names. */
const BUILDERS_NAMED = BUILDERS.map(b => b.split(':')[1]);
const carriers = (exportsOfModule) => [...exportsOfModule, ...BUILDERS_NAMED];

/** The readers among `bodies`, and whether each carries the clause. Takes the bodies so it is exercised on literal shapes below too. */
export function edgeReaders(bodies, names) {
  const carries = new RegExp(`\\b(?:${names.join('|')})\\b`);
  const out = [];
  for (const [key, e] of bodies) {
    if (e.alias) continue;
    const named = NAMES.filter(([, re]) => re.test(e.body)).map(([k]) => k);
    if (named.length === 0) continue;
    const reads = readCalls(e.body);
    const hands = HANDS_OUT.test(e.body);
    if (reads.length === 0 && !hands) continue;
    out.push({ key, file: e.file, named, reads: reads.length, hands, carries: carries.test(e.body) });
  }
  return out;
}

const label = (r) => `${r.key.replace('server/src/', '')} (${r.named.join(' + ')}${r.reads ? `, ${r.reads} read(s)` : ''}${r.hands ? ', hands the collection out' : ''})`;

describe('the derivation reads what a reader is, on literal shapes', () => {
  const N = ['CHOSEN_VERSION_ROWS', 'tripletClause'];
  const run = (body) => edgeReaders(new Map([['server/src/x.ts:f', { file: 'server/src/x.ts', body }]]), N);

  it('a find on the literal edges collection, with and without the clause', () => {
    const bare = run("const rows = await col(spaceCollection(spaceId, 'edges')).find(asFilter({ from: id })).toArray();");
    assert.equal(bare.length, 1);
    assert.equal(bare[0].carries, false);
    assert.equal(run("const n = await col(spaceCollection(spaceId, 'edges')).countDocuments({ from: id, ...CHOSEN_VERSION_ROWS });")[0].carries, true);
    assert.equal(run("const e = await col(spaceCollection(spaceId, 'edges')).findOne({ spaceId, ...tripletClause(t) });")[0].carries, true);
  });
  it('a template name, a computed key, a computed suffix and a $lookup', () => {
    assert.equal(run('const found = await readStoredById(`${spaceId}_edges`, ids, {});').length, 1);
    assert.equal(run("const docs = await readRowsById<IdDoc>(spaceCollection(space, collectionForRefKind(kind)), ids, 'all');").length, 1);
    assert.equal(run('const doc = await col(`${spaceId}_${COLLECTION[recordType]}`).findOne(asFilter({ _id: id }));').length, 1);
    const lookup = run("const rows = await col(spaceCollection(spaceId, 'entities')).aggregate([{ $lookup: { from: `${spaceId}_edges`, localField: '_id', foreignField: 'from', as: 'e' } }]).toArray();");
    assert.equal(lookup.length, 1, 'a $lookup into the edges collection reads it and is not seen');
    assert.ok(lookup[0].named.includes('$lookup'));
  });
  it('a read through the _id pager and a helper that hands the collection out', () => {
    assert.equal(run("const { rows } = await idKeysetPage<{ _id: string }>({ collection: spaceCollection(spaceId, 'edges'), filter: {}, size: 10 }, after);").length, 1);
    assert.equal(run("return col<EdgeDoc>(spaceCollection(spaceId, 'edges'));").length, 1);
  });
  it('NOT an array `.find`, another collection, or a write that reads nothing', () => {
    assert.equal(run("const e = spaceCollection(spaceId, 'edges'); const m = list.find(i => i.name === n);").length, 0);
    assert.equal(run("const rows = await col(spaceCollection(spaceId, 'facts')).find({});").length, 0);
    assert.equal(run("await col(spaceCollection(spaceId, 'edges')).updateOne({ _id }, { $set: { a: 1 } });").length, 0);
  });
});

describe('the clause exists, and the shared builders hold it inside them', () => {
  it('chosen-versions.ts exports CHOSEN_VERSION_ROWS, and it is the clause { forkOf: null }', async () => {
    clauseExports();
    const mod = await import('../../server/dist/brain/chosen-versions.js');
    assert.deepEqual({ ...mod.CHOSEN_VERSION_ROWS }, { forkOf: null });
    assert.ok(Object.isFrozen(mod.CHOSEN_VERSION_ROWS), 'the clause is shared by every reader: a caller that could edit it would edit it for all');
  });

  it('chosen-versions.ts is a leaf: it imports nothing', () => {
    clauseExports();
    const src = blankComments(readFileSync(join(REPO_ROOT, CLAUSE_MODULE), 'utf8'));
    assert.deepEqual([...src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g)].map(m => m[1]), [],
      'the clause module imports something, so a module that needs the clause pulls that in (and a cycle can follow)');
  });

  for (const builder of BUILDERS) {
    it(`${builder.replace('server/src/', '')} names an export of the clause module, so a caller of it cannot drop the clause`, () => {
      const names = clauseExports();
      const entry = INDEX.bodies.get(builder);
      assert.ok(entry, `${builder} is not a function of the tree: a builder this gate relies on is gone or renamed`);
      assert.match(entry.body, new RegExp(`\\b(?:${names.join('|')})\\b`),
        `${builder} builds an edge query without the clause: every reader that calls it sees fork rows as relationships`);
    });
  }
});

describe('a fork row is not a second relationship: every reader of the edges collection says so', () => {
  it('the derivation found the readers, so the rule cannot pass by finding none', () => {
    const readers = edgeReaders(INDEX.bodies, BUILDERS_NAMED);
    assert.ok(readers.length >= 60, `only ${readers.length} reader(s) of the edges collection found: the derivation is broken`);
    assert.ok(readers.filter(r => r.named.includes('literal')).length >= 20, 'too few readers name the edges collection by its literal');
    const keys = new Set(readers.map(r => r.key.replace('server/src/', '')));
    for (const k of ['brain/edge-lookup.ts:findEdgeByTriplet', 'brain/traverse-graph.ts:traverseGraph', 'brain/recall-seed-traversal.ts:readFrontierEdges',
      'brain/er-model.ts:readErShape', 'brain/merge.ts:detectDuplicateEdges', 'brain/merge.ts:detectEndpointRuleBreaks',
      'brain/relink-references.ts:relinkEdgesOfRecord', 'brain/edges.ts:listEdges', 'brain/entity-delete-guard.ts:endsOfEdges']) {
      assert.ok(keys.has(k), `${k} reads the edges collection and the derivation did not find it: it is blind to that shape`);
    }
    assert.ok([...keys].some(k => k.startsWith('api/brain/search.ts:GET ')), 'an inline route handler was not found: the routes are not registered');
    assert.ok(readers.some(r => r.carries), 'no reader carries the clause: the carry test is broken');
  });

  it('every reader of the edges collection carries the clause or is a named exemption', () => {
    const bare = edgeReaders(INDEX.bodies, carriers(clauseExports())).filter(r => !r.carries && !(r.key in EXEMPT)).map(label);
    assert.deepEqual(bare, [],
      'these read the edges collection and apply no clause of brain/chosen-versions.ts, so a fork row is a relationship for them: a duplicate that is '
      + 'not one, a second edge under a functional label, a parallel neighbour, an endpoint-rule break. Each needs the clause (or one of the builders '
      + 'that holds it), or an EXEMPT entry that says why a fork should be seen by it');
  });

  it('every exemption still names a function that reads the edges collection, and says why', () => {
    const live = new Set(edgeReaders(INDEX.bodies, BUILDERS_NAMED).map(r => r.key));
    const stale = Object.keys(EXEMPT).filter(k => !live.has(k));
    assert.deepEqual(stale, [], 'exemptions for functions that no longer read the edges collection: delete them');
    for (const [k, why] of Object.entries(EXEMPT)) assert.ok(why.length > 25, `${k}: an exemption owes its reason`);
  });

  it('no exemption excuses a reader that already carries the clause', () => {
    const redundant = edgeReaders(INDEX.bodies, carriers(clauseExports())).filter(r => r.carries && r.key in EXEMPT).map(r => r.key);
    assert.deepEqual(redundant, [], 'these carry the clause AND are exempt: the exemption says they do not, and one of the two is wrong');
  });
});
