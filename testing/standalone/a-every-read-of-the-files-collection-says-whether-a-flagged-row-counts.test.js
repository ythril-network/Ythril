/**
 * Every READ of a space's `files` collection carries one of the two live-row predicates of `files/live-file-row.ts`, or sits
 * in a reasoned exemption table (bundle-89, Q-418, plan item E2.4 and E2.8).
 *
 * ## The rule
 *
 * With `softDeleteFileMeta` a deleted file's row stays in the collection, flagged `deletedAt`. A flagged row is not a result,
 * not a count and not a link target: `LIVE_FILE_ROW` answers that for a question about FILES (top-level and not flagged), and
 * a second predicate answers "not flagged, any tier" for the questions that reach chunk, caption and face rows too (the embed
 * path, recall's file branch) — which `LIVE_FILE_ROW` cannot, because it would make every row carrying a `parentFileId`
 * unembeddable and invisible. A reader that applies neither answers "yes, that deleted file exists" to whoever asks.
 *
 * ## Why a gate over the READERS, not over a spelling
 *
 * The files collection is read at fifty-odd sites. The first draft of the plan named seven of them and said the generic doors
 * were "verified in the same pass"; the vet found `brain/entity-refs.ts` (strict-linkage existence, so a flagged file is a
 * valid link target), `edge-endpoint-names.ts`, `traverse-bodies.ts`, `files/dispatch.ts` and `sync/file-sync.ts` missing.
 * A gate that asks "is a `deletedAt` predicate hand-spelled outside the module" catches a SPELLING, not a reader that forgot
 * the predicate, which is the actual defect (the title of that gate would have concluded about every reader and looked at
 * the ones that already spelled it). So the readers are DERIVED:
 *
 *  - a function (or an inline route handler, `_routes.mjs`) is a reader of the files collection when it NAMES that collection
 *    — `spaceCollection(x, 'files')`, a `${id}_files` template, or a name computed at run time (`spaceCollection(x, kind)`,
 *    `${id}_${suffix}`), which MAY be the files collection and is held to the rule rather than guessed away — and READS
 *    (`find`, `findOne`, `aggregate`, `countDocuments`, `distinct`, or a by-id read helper), or hands the collection out;
 *  - it CARRIES a predicate when its body names one of the predicates `live-file-row.ts` exports (the exports are read from
 *    the module, so a predicate added there joins the rule and a renamed one cannot hide behind a stale name).
 *
 * The granularity is the function: a function that reads the files collection twice and applies a predicate once passes.
 * That is stated, not hidden — the by-id and by-filter reads are one question per function in this tree, and a finer gate
 * would be a parser for every filter expression. The exemption table is where a function that reads on purpose says so.
 *
 * ## Seen red
 *
 * On 429e6d25 `live-file-row.ts` exports ONE predicate, and the readers below the exemption table carry none.
 *
 * Run: node --test testing/standalone/a-every-read-of-the-files-collection-says-whether-a-flagged-row-counts.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { moduleIndex, routeHandlerRoots } from './_call-graph.mjs';
import { mountedRoutes } from './_routes.mjs';
import { REPO_ROOT } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

const LIVE_MODULE = 'server/src/files/live-file-row.ts';

/**
 * Functions that read the files collection and deliberately apply neither predicate, with the reason. Keyed `file:function`
 * (a route handler is `file:METHOD /path`). An entry that no longer reads the files collection fails below, so a row cannot
 * outlive what it excuses.
 *
 * A reader NOT listed here and not carrying a predicate is a finding: either it needs one, or it belongs here with a reason
 * somebody can check. Where a reason below says "by parent", it means the read selects CHILD rows (`parentFileId`), which a
 * flag is never set on — the flag sits on the parent, and a flagged file's children are removed with it.
 */
const EXEMPT = {
  // ── it handles the collection, not the files in it
  'server/src/spaces/lifecycle.ts:initSpace': 'creates the space\'s collections and indexes and samples a fact for the embedding model; reads no file for any caller',
  'server/src/brain/chrono-redaction.ts:backfillTypedExpiry': 'walks the typed record collections (`KnowledgeType`: entity, fact, edge, chrono — a file is none of them) to stamp a retention window; names a suffix, never the files collection',
  'server/src/spaces/rename.ts:moveSpaceData': 'moves a whole space\'s collections to a new id: every row, flagged included, goes',
  'server/src/spaces/ensure-query-indexes.ts:ensureQueryIndexes': 'builds indexes on the collections; hands out a handle and reads no row for a caller',
  'server/src/util/seq.ts:highestStoredSeq': 'reconciles the space counter against the highest stored seq of any row; a flagged row\'s seq still counts',
  'server/src/sync/delivered-by-backfill.ts:stampCollection': 'the one-time stamp of who delivered rows held before `deliveredBy` existed: it must visit every row, flagged or not',
  // ── it must SEE the flagged row, because the flag is what it decides on
  'server/src/sync/arrivals.ts:writeArrivals': 'the arrival writer reads the stored copy and its `deletedAt` to refuse an arrival onto a row this instance flagged (arrivals.ts, "Except onto a row this instance FLAGGED"): a predicate would hide the very row it decides on',
  'server/src/files/tombstones.ts:shadowedAgainst': 'decides whether a held file tombstone shadows an arriving copy; it reads the stored row, flagged included, because the flag is what keeps a stale peer copy from resurrecting a deleted file',
  'server/src/files/tombstones.ts:shadowedByParent': 'the same shadow decision for a child path: reads the stored parent row, flagged included',
  'server/src/files/peer-tombstone-apply.ts:applyPeerFileTombstones': 'applies a peer\'s file tombstone to the rows held; a row already flagged must be seen so it is not flagged a second time (markFileMetaDeleted)',
  'server/src/sync/tombstone-apply.ts:applyPeerTombstones': 'applies a peer\'s record tombstones; reads the stored rows it is about to remove',
  'server/src/files/file-meta.ts:upsertFileMeta': 'a re-upload of a path whose row is flagged REVIVES it, so the upload door has to read the flagged row to write over it',
  // ── it removes or moves rows, which includes the flagged ones
  'server/src/files/converters/pipeline.ts:removeWhatSidecarsLeft': 'selects the sidecar rows a file left, to remove them with it',
  'server/src/files/converters/pipeline.ts:deleteConversionArtifactsByPrefix': 'selects the converted rows under a deleted directory, to remove them',
  'server/src/files/legacy-spill-sweep.ts:sweepSpace': 'removes the legacy spill rows by path prefix',
  'server/src/files/move-cascade.ts:relocateDerivedFileMeta': 'by parent: re-keys the rows derived from a moved file',
  'server/src/files/derived-rows.ts:rowsDerivedFrom': 'by parent: lists the rows derived from some files, so a delete can remove them',
  'server/src/brain/suppression-sweep.ts:sweepFiles': 'removes the stored VECTORS of what is suppressed; taking a vector off a flagged row is the intent, and it surfaces nothing',
  'server/src/brain/suppression-sweep.ts:dropFileVectors': 'removes vectors from the rows derived from a file; it surfaces nothing',
  'server/src/brain/suppression-sweep.ts:sweepSuppressedVectors': 'the vector sweep over the record collections of a space, files included; it surfaces nothing',
  'server/src/sync/fill-file-meta.ts:fillFileMetaFromStray': 'the stray-metadata drain\'s recovery: finds the row a stray record belongs to and fills it; it returns a verdict, never a row',
  'server/src/sync/fill-file-meta.ts:fillReceiverMadeRow': 'the fill half of the drain above',
  // ── face rows: child rows selected by entity
  'server/src/brain/merge.ts:relinkTally': 'by parent: counts the face chunk rows an entity merge would re-point (`faceEntityId`); face rows are children and never carry the flag',
  'server/src/brain/merge.ts:relinkAndAbsorb': 'by parent: re-points face chunk rows from the absorbed entity to the survivor; children never carry the flag',
  'server/src/brain/entities.ts:findEntityReferences': 'by parent: finds the face chunk rows that name an entity, and its edges; children never carry the flag',
  'server/src/spaces/face-width-change.ts:storedFaceDescriptorCount': 'by parent: counts stored face descriptors (`faceEmbedding`), which only child rows hold',
};

const INDEX = moduleIndex('server/src');
for (const r of mountedRoutes()) routeHandlerRoots(INDEX, r);

/** How a body NAMES a files collection. */
const NAMES = [
  ['literal', /spaceCollection\s*\(\s*[^,()]+,\s*['"]files['"]\s*\)/],
  ['template', /`[^`]*\$\{[^}]*\}_files`/],
  ['computed key', /spaceCollection\s*\(\s*[^,()]+,\s*[^'"\s)][^)]*\)/],
  ['computed suffix', /`[^`]*\$\{[^}]*\}_\$\{[^}]*\}`/],
];
/** A read of a collection: a driver call, or a by-id read helper. A global regex is built fresh per use. */
const readCalls = (body) => [...body.matchAll(new RegExp(
  '\\.\\s*(?:find|findOne|aggregate|countDocuments|distinct)\\s*(?:<[^>(]*>)?\\s*\\('
  + '|\\b(?:readStoredById|readRowsById|readRecordsById)\\s*(?:<[^>(]*>)?\\s*\\(', 'g'))]
  // `.find(` of an ARRAY takes a callback: `x => …` or `(x) => …`. A cursor's takes a filter.
  .filter(m => !(m[0].includes('find') && /^\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(body.slice(m.index + m[0].length))));
/** Hands the collection out for a caller to read. */
const HANDS_OUT = /\breturn\s+col\b|=>\s*col\b/;

/** The predicates `live-file-row.ts` exports, read from its source. */
function livePredicates() {
  const src = blankComments(readFileSync(join(REPO_ROOT, LIVE_MODULE), 'utf8'));
  const names = [...src.matchAll(/export const (\w+)\s*=\s*Object\.freeze\(/g)].map(m => m[1]);
  assert.ok(names.includes('LIVE_FILE_ROW'), `${LIVE_MODULE} no longer exports LIVE_FILE_ROW — re-anchor`);
  return names;
}
const PREDICATES = livePredicates();

/**
 * The readers among `bodies`, and whether each carries a predicate. Takes the bodies so the classifier is exercised on
 * literal shapes below as well as on the tree.
 */
export function filesReaders(bodies, predicates) {
  const carries = new RegExp(`\\b(?:${predicates.join('|')})\\b`);
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

const READERS = filesReaders(INDEX.bodies, PREDICATES);
const label = (r) => `${r.key.replace('server/src/', '')} (${r.named.join(' + ')}${r.reads ? `, ${r.reads} read(s)` : ''}${r.hands ? ', hands the collection out' : ''})`;

describe('the derivation reads what a reader is, on literal shapes', () => {
  const P = ['LIVE_FILE_ROW', 'NOT_FLAGGED'];
  const run = (body) => filesReaders(new Map([['server/src/x.ts:f', { file: 'server/src/x.ts', body }]]), P);

  it('a find on the literal files collection, with and without a predicate', () => {
    const bare = run("const rows = await col(spaceCollection(spaceId, 'files')).find(asFilter({ tags: 'a' })).toArray();");
    assert.equal(bare.length, 1);
    assert.equal(bare[0].carries, false);
    const live = run("const n = await col(spaceCollection(spaceId, 'files')).countDocuments({ ...LIVE_FILE_ROW });");
    assert.equal(live[0].carries, true);
    const any = run("const n = await col(spaceCollection(spaceId, 'files')).find({ ...NOT_FLAGGED });");
    assert.equal(any[0].carries, true, 'the second predicate is a predicate');
  });
  it('a by-id helper over a template name, and a name computed at run time', () => {
    assert.equal(run('const found = await readStoredById(`${spaceId}_files`, ids, {});').length, 1);
    assert.equal(run('const docs = await readRowsById<IdDoc>(spaceCollection(space, collectionForRefKind(kind)), ids, \'all\');').length, 1);
    assert.equal(run('const doc = await col(`${spaceId}_${COLLECTION[recordType]}`).findOne(asFilter({ _id: id }));').length, 1);
  });
  it('a helper that hands the collection out', () => {
    assert.equal(run("return col<FileMetaDoc>(spaceCollection(spaceId, 'files'));").length, 1);
  });
  it('NOT an array `.find`, a collection that is not files, or a write that reads nothing', () => {
    assert.equal(run("const e = spaceCollection(spaceId, 'files'); const m = list.find(i => i.name === n);").length, 0);
    assert.equal(run("const rows = await col(spaceCollection(spaceId, 'facts')).find({});").length, 0);
    assert.equal(run("await col(spaceCollection(spaceId, 'files')).updateOne({ _id }, { $set: { a: 1 } });").length, 0);
  });
});

describe('the derivation finds the readers at all, so the rule cannot pass by finding none', () => {
  it('found the readers; the five the vet found missing from the plan\'s first draft among them', () => {
    assert.ok(READERS.length >= 40, `only ${READERS.length} reader(s) of the files collection found — the derivation is broken`);
    const keys = new Set(READERS.map(r => r.key.replace('server/src/', '')));
    for (const k of ['brain/entity-refs.ts:missingRefs', 'brain/edge-endpoint-names.ts:resolveEndpointName',
      'brain/traverse-bodies.ts:withTraverseBodies', 'files/dispatch.ts:readPriorProcessing', 'sync/file-sync.ts:heldRowsFor',
      'brain/space-shape.ts:build', 'mcp/tools/spaces.ts:space_statsTool.handle', 'brain/embed-record.ts:embedStoredRecord']) {
      assert.ok(keys.has(k), `${k} reads the files collection and the derivation did not find it — it is blind to that shape`);
    }
    assert.ok([...keys].some(k => k.startsWith('api/brain/search.ts:GET ')),
      'the REST stats handler is an inline route handler and was not found — the routes are not registered');
  });

  it('some reader already carries a predicate, and the exports are read from the module', () => {
    assert.ok(READERS.some(r => r.carries), 'no reader carries a predicate — the carry test is broken');
    assert.ok(PREDICATES.length >= 1);
  });
});

describe('a flagged row is not a result, a count or a link target: every reader says so', () => {
  it('live-file-row.ts exports a SECOND predicate: not flagged, at any tier', async () => {
    // A predicate that names `deletedAt` and does NOT name `parentFileId` answers "not flagged" for a chunk row too. The exports are
    // read by VALUE, not by name, so it may be called anything.
    const mod = await import('../../server/dist/files/live-file-row.js');
    const exported = Object.entries(mod).filter(([, v]) => v && typeof v === 'object');
    assert.ok(exported.some(([, v]) => Object.hasOwn(v, 'parentFileId') && Object.hasOwn(v, 'deletedAt')), 'LIVE_FILE_ROW (top-level and not flagged) is gone');
    const anyTier = exported.filter(([, v]) => Object.hasOwn(v, 'deletedAt') && !Object.hasOwn(v, 'parentFileId'));
    assert.ok(anyTier.length >= 1,
      `${LIVE_MODULE} exports only [${exported.map(([n]) => n)}]: no predicate says "not flagged" without also saying "top-level". `
      + 'Applying LIVE_FILE_ROW to the embed path or to recall\'s file branch would make every chunk and caption row (which carry '
      + '`parentFileId`) unembeddable and invisible, so those sites have no predicate they can take');
  });

  it('every reader of the files collection carries a predicate, or is a named exemption', () => {
    const bare = READERS.filter(r => !r.carries && !(r.key in EXEMPT)).map(label);
    assert.deepEqual(bare, [],
      'these read the files collection and apply neither LIVE_FILE_ROW nor the any-tier predicate, so a file deleted under '
      + '`softDeleteFileMeta` is still a result, a count or a link target for them. Each needs a predicate, or an EXEMPT entry that '
      + 'says what it reads on purpose and why a flagged row should be seen by it');
  });

  it('every exemption still names a function that reads the files collection, and says why', () => {
    const live = new Set(READERS.map(r => r.key));
    const stale = Object.keys(EXEMPT).filter(k => !live.has(k));
    assert.deepEqual(stale, [], 'exemptions for functions that no longer read the files collection — delete them');
    for (const [k, why] of Object.entries(EXEMPT)) assert.ok(why.length > 25, `${k}: an exemption owes its reason`);
  });

  it('no exemption excuses a reader that already carries a predicate', () => {
    const redundant = READERS.filter(r => r.carries && r.key in EXEMPT).map(r => r.key);
    assert.deepEqual(redundant, [], 'these carry a predicate AND are exempt: the exemption says they do not, and one of the two is wrong');
  });
});
