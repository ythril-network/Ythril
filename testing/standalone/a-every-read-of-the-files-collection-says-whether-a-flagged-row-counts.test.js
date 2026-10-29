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
 *    (`find`, `findOne`, `aggregate`, `countDocuments`, `distinct`, or a read helper: by id, `distinctStringsOf`, or the `_id` pager
 *    `idKeysetPage` / `eachIdPage`), or hands the collection out;
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
  // ── it cannot reach a flagged row from here
  'server/src/brain/write-connections.ts:connectionSubject': 'reads the stored record an entity, fact or chrono write is about; its `kind` excludes `file` by type, so the computed collection is never `files`',
  'server/src/api/sync/docs.ts:oneById': 'the narrowing is the family\'s own `pushFilter`, which for file metadata IS `LIVE_FILE_ROW` (sync/replicated-families.ts), so a read by id serves exactly what a page would; naming it here would be a second copy and the other five families must not take it',
  'server/src/sync/arrival-recording.ts:watchArrivals': 'reads the stored copy a recorded arrival replaces, only for a family with a type schema (`schemaKindOf` answers undefined for files and links before any read), so the collection it computes is never the files one',
  'server/src/brain/edge-endpoint-names.ts:resolveEndpointName':'returns the id before its one read when the kind is `file` (a file endpoint\'s display name IS its path), so the collection it computes is never the files one',
  'server/src/brain/edge-endpoint-names.ts:withEndpointNames': 'skips every `file` endpoint before it groups the ids (a file endpoint\'s display name IS its path) and reads only the entity, fact and chrono kinds its map is typed to, so the collection it computes is never the files one',
  'server/src/brain/recall.ts:introduceLexicalOnly': 'its `eligibility` argument IS the recall\'s own predicate for this type, `recallPredicate(tags, filter, type)` at its one call, carrying the any-tier clause for a file recall (brain/recall-filter.ts); a copy here would let the introduced records and the vector path disagree about what is eligible',
  'server/src/brain/lexical-search.ts:lexicalSearch': 'its `eligibility` argument IS the recall\'s own predicate for this type, built by `recallPredicate` (brain/recall-filter.ts) and carrying the any-tier clause for a file recall; a copy here would let this channel and the vector path disagree about what is eligible, which is the thing that one builder exists to stop',
  'server/src/brain/recall.ts:recallByType': 'its eligibility predicate is `recallPredicate(tags, filter, knowledgeType)`, which carries the any-tier clause for a file recall (brain/recall-filter.ts) — the one place the vector path, the predicate path, the fresh-write scan and the lexical channel all read it from',
  // ── it handles the collection, not the files in it
  'server/src/app.ts:createApp': 'the app builder: it mounts the routers and reads no row of its own — its one read of a collection is the admin export handler below',
  'server/src/files/media/job-queue.ts:fileCollection': 'hands the collection to one caller, which reads a single `sizeBytes` for a stalled-job WARN line and surfaces no row to anybody',
  'server/src/auth/find-where-token-may.ts:findWhereTokenMay': 'a by-id lookup of review-state rows across the spaces a token reaches; every caller passes a conflicts or candidates collection, never files',
  // ── it must SEE the flagged row, because the flag is what it decides on
  'server/src/brain/ttl-sweep.ts:flaggedPage': 'the page of the purge unit: it selects rows BY the flag, because the audit records of deleted files are exactly what it reaps once the space\'s file window has passed since the deletion',
  'server/src/brain/ttl-sweep.ts:stillFlagged': 'the purge unit\'s reading of "the deleter matched nothing": it asks whether the row is STILL flagged, so a re-upload that revived the path between the page and the delete is the correct outcome rather than a reported failure',
  'server/src/files/derived-fields.ts:stripFlaggedRowsOnce': 'the one-off repair of rows flagged before the flag write stripped them: it selects flagged rows that still hold what the bytes made, which is the work it exists to do',
  'server/src/files/disk-against-rows.ts:heldRowsFor': 'the pull and the restore decide ON the flag (the classifier moved out of file-sync, bundle-111): `HeldRow.deletedAt` is what makes `repairReasonOf` answer null ("a soft-deleted row is not repaired"), and a predicate would make a deleted file read as `missing_row` and take its bytes back',
  'server/src/sync/push-reads.ts:readForkContext': 'reads the fork rows and the held parents of a page of a family that FORKS (`isForkingFamily`: facts, entities, edges, chrono), by the collection of the family of the page; file metadata never forks, so the computed key never names the files collection here, and a row it did read would be a fork or a parent of one, not a result a caller sees',
  'server/src/sync/push-reads.ts:readPushStored': 'the arrival planner compares the STORED seq, for every family; a hidden row reads as "nothing stored" and lets any arriving seq win over it. The flagged-row rule belongs to the writer (`writeArrivals`, above)',
  'server/src/app.ts:GET /api/admin/spaces/:spaceId/export': 'a full snapshot carries the audit rows on purpose: a restore brings the flag back with the record (`restoredFileFlag`), and filtering here would drop deletion history out of every backup',
  // ── the audit record has to be readable somewhere, and this is the door
  'server/src/brain/query.ts:queryBrain': 'the `filter`/`query` door deliberately still reaches a flagged row: it is the one door left through which the audit record this setting exists to keep can be read, and it is neither the file list nor a total, which is all the userguide promises',
  'server/src/brain/query.ts:countBrain': 'the count behind that same door, over whichever collection it was asked about: it counts what the door returns',
  // ── the predicate reaches the read from one place, and a copy here would be the second
  'server/src/brain/queue-embed-sweep.ts:countUnswept': 'its filter is `kindFilters` -> `candidates`, which applies the any-tier predicate for files in one place (`const live`, queue-embed-sweep.ts); a predicate here would be a second copy of it',
  'server/src/brain/queue-embed-sweep.ts:queueEmbedSweep': 'the walk to that same count\'s filter: the predicate is in `candidates` for both, so neither reader can queue a job for a flagged row',
  'server/src/files/derived-rows.ts:topLevelFilesAmong': 'asks whether an id with a `#` in it is a TOP-LEVEL file of its own (a name that holds a `#`) rather than a derived row of another file; a flagged top-level row is still another file, so it counts on purpose',
  'server/src/brain/link-adjacency.ts:docsFromCollection': 'the narrowing is the link class\'s own `scope`, ANDed into the read, and for files that scope IS `LIVE_FILE_ROW` (`SCOPE`, link-adjacency.ts) — so a linked file node is never a chunk and never a flagged row',
  'server/src/files/extract-listing.ts:readExtractListing': 'its reads select CHILD rows by `parentFileId`, which a flag is never set on; whether the FILE is still here is the parent read, `getFileMeta`, which both doors that call it (`GET …/files/extract` and `read_file`) make first and which carries the predicate',
  'server/src/brain/dupe-scanner.ts:unchosenVersionsAmong': 'its collection is the one of a duplicate-scan type (fact, entity or chrono), never `files`, and it reads the `forkOf` of the ids a scan found',
  'server/src/brain/dupe-scanner.ts:recordMatchedText': 'reads `matchedText` alone, which the flag write strips, so a flagged row already answers the empty string a predicate would answer for it',
  // ── it handles the collection, not the files in it
  'server/src/spaces/lifecycle.ts:wipeSpaceUnqueued': 'the wipe body hands the collection to the runner\'s batched delete, which reads each batch\'s ids to delete EVERY row, flagged ones included, on purpose',
  'server/src/spaces/lifecycle.ts:initSpace': 'creates the space\'s collections and indexes and samples a fact for the embedding model; reads no file for any caller',
  'server/src/brain/chrono-redaction.ts:backfillTypedExpiry': 'walks the typed record collections (`KnowledgeType`: entity, fact, edge, chrono — a file is none of them) to stamp a retention window; names a suffix, never the files collection',
  // `ensure-query-indexes.ts:ensureQueryIndexes` came off with Q-445 (bundle-101): it names no collection now, the per-space
  // declaration (`spaces/space-indexes.ts`) does, by part.
  // bundle-81: `util/seq.ts:highestStoredSeq` is gone; its three questions are asked of every record collection, the files included, by part.
  'server/src/spaces/record-count.ts:spaceRecordCount': 'an ESTIMATE of how many records a re-read of the space reads, from the collections\' metadata: a flagged file row is counted in it, which overstates a duration by a row and decides nothing',
  'server/src/sync/positions-owed.ts:carryRows': 'gives EVERY row with a version its position, flagged ones included: a flagged row is local audit state that still has a version and sits in the collection the pager reads',
  'server/src/sync/positions-rollback.ts:rollBackPositions': 'removes the 6.0 fields from EVERY row of the collection, flagged ones included: it runs against the store, with no instance up, and leaves no row 5.6 would hash differently',
  // Q-624 slice I3: the fork module's computed collection is always one of FORKING_FAMILIES (facts, entities, edges, chrono), never the files.
  ...Object.fromEntries(['refuseForkRowsNamed', 'forkRowsUnder', 'remintForks', 'assertForksFitTogether', 'forksOfSpace', 'resolveFork', 'resolveOrphan'].map(f => [
    `server/src/brain/forks.ts:${f}`, 'its collection is a FORKING_FAMILIES member (facts, entities, edges, chrono) and never the files: a file does not fork',
  ])),
  'server/src/brain/fork-counts.ts:forkCountsOf': 'counts the fork rows of the forking families (facts, entities, edges, chrono), by a computed collection that is never the files: a file does not fork',
  'server/src/sync/tombstone-apply.ts:cascadeToForks': 'an applied tombstone\'s fork cascade (Q-624 §7): its collection is a FORKING_FAMILIES member, never the files',
  'server/src/sync/positions-rollback.ts:rollBackForks': 'its collections are the forking families and the edges indexes, never the files: a file does not fork',
  'server/src/brain/write-at-read-version.ts:writeAtReadVersion': 'reads the stored copy\'s `forkOf` to refuse an edit of a fork row; a flagged file row is no fork, and the edit\'s own write decides what a flagged row means',
  'server/src/util/version-stamp.ts:highestVersionBelowCap': 'the version the counter may continue from: the highest stored version at or below the cap in any row; a flagged row\'s version still counts',
  'server/src/util/version-stamp.ts:heldTermsOf': 'the version a local write must stand above: the stored row\'s own, flagged or not — a write over a flagged row is the revival of a deleted file, which sorts above it',
  'server/src/sync/record-position-stream.ts:positionFloor': 'the highest position the records stream has handed out: any row\'s, a flagged row\'s included, or the next stamp could fall below a position a peer holds a mark for',
  'server/src/util/position-keyset.ts:readAfterPosition': 'the one position reader of every record collection: the family\'s own filter (`LIVE_FILE_ROW`) is the `extra` its caller passes, so the reader itself must not narrow what it is handed',
  'server/src/sync/delivered-by-backfill.ts:stampCollection': 'the one-time stamp of who delivered rows held before `deliveredBy` existed: it must visit every row, flagged or not',
  // ── it must SEE the flagged row, because the flag is what it decides on
  'server/src/sync/arrivals.ts:writeArrivals': 'the arrival writer reads the stored copy and its `deletedAt` to refuse an arrival onto a row this instance flagged (arrivals.ts, "Except onto a row this instance FLAGGED"): a predicate would hide the very row it decides on',
  'server/src/files/tombstones.ts:shadowedAgainst': 'decides whether a held file tombstone shadows an arriving copy; it reads the stored row, flagged included, because the flag is what keeps a stale peer copy from resurrecting a deleted file',
  'server/src/files/tombstones.ts:shadowedByParent': 'the same shadow decision for a child path: reads the stored parent row, flagged included',
  'server/src/files/tombstones.ts:readFileRows': 'reads what a pending tombstone records of the version it erases (`rowSeq`, `contentHash`) at each path an act removes; a flagged row is the last version this instance held at that path, so it is what the tombstone erases, and a predicate would leave the tombstone bare, which shadows less',
  'server/src/sync/file-meta-write.ts:authoredKeysRestoreRemoves': 'counts the authored keys a restore takes off the rows it replaces; the restore replaces every stored row by id, flagged ones included (it is unguarded and brings the backup\'s flag back), so a predicate would leave a flagged row\'s removed keys uncounted while the write still removes them',
  'server/src/files/peer-tombstone-apply.ts:applyPeerFileTombstones': 'applies a peer\'s file tombstone to the rows held; a row already flagged must be seen so it is not flagged a second time (markFileMetaDeleted)',
  'server/src/sync/tombstone-apply.ts:applyPeerTombstones': 'applies a peer\'s record tombstones; reads the stored rows it is about to remove',
  'server/src/files/file-meta.ts:upsertFileMeta': 'a re-upload of a path whose row is flagged REVIVES it, so the upload door has to read the flagged row to write over it',
  // ── it removes or moves rows, which includes the flagged ones
  'server/src/files/legacy-spill-sweep.ts:sweepSpace': 'removes the legacy spill rows by path prefix',
  'server/src/files/derived-rows.ts:rowsOfFiles': 'by sidecar path: selects the rows a file leaves at its sidecars paths, flagged ones included, because the delete retires an arrived row as the files own and the move skips a flagged one by its own flag',
  'server/src/files/move-plan.ts:rowFacts': 'by id: reads the parent, the flag and the stored size of the rows a move carries, because it decides ON the flag: a flagged audit row stays where it was recorded',
  'server/src/files/move-plan.ts:anythingUnderDestination': 'a probe for ANY row under the destination, flagged or live: a flagged audit row there is removed by the move and a live one is replaced or refused',
  'server/src/files/move-plan.ts:holdsAtDestination': 'classifies what stands at the ids a move takes BY the flag: flagged rows are removed, live ones replaced or refused',
  'server/src/files/move-cascade.ts:carryBatch': 'the landed read-back of a batch: whether its first row is at the new id and no longer at the old one, whatever the row is; it surfaces nothing',
  'server/src/files/move-links.ts:convergeLinks': 'reads the author of the files whose links move, for the link rows written for them; it surfaces nothing',
  'server/src/files/derived-rows.ts:rowsDerivedFrom': 'by parent: lists the rows derived from some files, so a delete can remove them',
  'server/src/files/tombstones.ts:decideMetadataByRow': 'reads the row at the path a pending delete would shadow, flagged or live: a flagged row is the deletion itself and decides the arrival as shadowed (`metaDecidedByRow`)',
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
  // ── it must SEE the flagged row, through the `_id` pager (Q-481)
  'server/src/files/leaked-rows-repair.ts:derivedRowsPage': 'the leaked-rows repair reads every row by `_id`, any kind and flagged ones included, and decides each itself: a derived row whose parent is gone is removed, a flagged one is kept by its own `deletedAt` check; a predicate on the read would make the cursor skip the rows it decides on and could wedge a page on a run of rows it excluded',
  'server/src/spaces/schema-validate-door.ts:walkStored': 'the stored-data schema validation walks every record of each member collection by `_id`, files included, because a flagged row is stored data the schema still governs; its `progress.total` counts the whole collection, and a predicate here would make the walk answer for fewer rows than it says it checked',
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
/**
 * A read of a collection: a driver call, or a read helper (by id, the distinct values of a field, or the `_id` pager). A global regex
 * is built fresh per use. A type argument may nest one level (`.find<Record<string, X>>(`,
 * `idKeysetPage<{ _id: string } & Record<string, unknown>>(`), on every call: a matcher that took only a flat one did not see
 * seven readers of the files collection, which this table had never judged (Q-481).
 */
const TYPE_ARGS = '(?:<(?:[^<>()]|<[^<>()]*>)*>)?';
const readCalls = (body) => [...body.matchAll(new RegExp(
  `\\.\\s*(?:find|findOne|aggregate|countDocuments|distinct)\\s*${TYPE_ARGS}\\s*\\(`
  + `|\\b(?:readStoredById|readRowsById|readRecordsById|distinctStringsOf)\\s*${TYPE_ARGS}\\s*\\(`
  + `|\\b(?:idKeysetPage|eachIdPage)\\s*${TYPE_ARGS}\\s*\\(`, 'g'))]
  // `.find(` of an ARRAY takes a callback: `x => …` or `(x) => …`. A cursor's takes a filter.
  .filter(m => !(m[0].includes('find') && /^\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(body.slice(m.index + m[0].length))));
/** Hands the collection out for a caller to read. */
const HANDS_OUT = /\breturn\s+col\b|=>\s*col\b/;

/** The predicates `live-file-row.ts` exports, read from its source. */
function livePredicates() {
  const src = blankComments(readFileSync(join(REPO_ROOT, LIVE_MODULE), 'utf8'));
  const names = [...src.matchAll(/export const (\w+)\s*=\s*Object\.freeze\(/g)].map(m => m[1]);
  assert.ok(names.includes('LIVE_FILE_ROW'), `${LIVE_MODULE} no longer exports LIVE_FILE_ROW — re-anchor`);
  // A function the module exports that RETURNS one of those predicates (`notFlaggedIfFile`) is a predicate too: a read
  // that calls it carries the guard. Derived from what its body returns, so a helper that stops returning one drops out.
  const fns = [...src.matchAll(/export function (\w+)\s*\([^)]*\)[^{]*\{([^}]*)\}/g)]
    .filter(m => names.some(n => new RegExp(`\\breturn\\b[^;]*\\b${n}\\b`).test(m[2])))
    .map(m => m[1]);
  return [...names, ...fns];
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
  it('a read through the _id pager, page by page or the whole walk, with a nested type argument', () => {
    const page = run("const { rows } = await idKeysetPage<{ _id: string } & Record<string, unknown>>({ collection: spaceCollection(spaceId, 'files'), filter: {}, projection: { _id: 1 }, size: 10 }, after);");
    assert.equal(page.length, 1, 'idKeysetPage is not a read helper of the derivation: a reader that pages by _id is invisible to it');
    assert.equal(page[0].carries, false);
    const walk = run("await eachIdPage<{ _id: string }>({ collection: spaceCollection(spaceId, 'files'), filter: { ...LIVE_FILE_ROW }, projection: { _id: 1 }, size: 10 }, async rows => {});");
    assert.equal(walk.length, 1, 'eachIdPage is not a read helper of the derivation');
    assert.equal(walk[0].carries, true);
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
      'brain/traverse-bodies.ts:withTraverseBodies', 'files/dispatch.ts:readPriorProcessing', 'files/disk-against-rows.ts:heldRowsFor',
      'brain/space-shape.ts:build', 'mcp/tools/spaces.ts:space_statsTool.handle', 'brain/embed-record.ts:embedStoredRecord',
      // Read through the `_id` pager once Q-481 converts them: a reader whose read is `idKeysetPage` must still be found.
      'files/file-stamp-report.ts:readCandidates', 'brain/links-conversion.ts:convertSpaceInWalk']) {
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
