/**
 * Every record a peer or an import delivers is stored by ONE writer, `writeArrivals` in `sync/arrivals.ts`
 * (`Q-107` part 1, design v3 item 1).
 *
 * ## The rule
 *
 * A document produced elsewhere arrives through six doors: the batch push, the four single push routes, the pull
 * page, and admin import. Each used to store it its own way — `ingestBrainDoc` one document at a time, the pull's
 * `batchUpsertBySeq`, a `$setOnInsert` upsert inline in `POST /entities` — and each held a different subset of the
 * preconditions: a seq that is a non-negative integer, a string `_id`, the retag to the local space, the write
 * guard against a newer stored copy, the receiver's local-only fields carried across the replace, the counter
 * bump, the embed enqueue. Six copies of one rule is how the push came to keep the sender's space id while the pull
 * retagged it, and how a pulled record was never queued for embedding at all.
 *
 * So the writer owns every precondition and no door can skip one, which is only true while nothing reachable from
 * a door writes a record collection anywhere else.
 *
 * ## What is derived
 *
 *  - **The doors**: every route mounted from `server/src/api/sync/*.ts`, every route whose handler reaches
 *    `api/admin-import.ts`, and every function of the pull engine `sync/engine.ts`. Rooted through the call graph
 *    with `closures: true`, because a page is written inside a `.map(async …)` as often as not.
 *  - **The sites**: every write a door reaches, through `_record-writes.mjs` — aliases and helpers resolved back to
 *    the collection they open, a computed collection name held to the rule, the sequence counter excluded by what
 *    it is. The record collections are `BRAIN_COLLECTIONS`, all six: file metadata is a record family that
 *    arrives, and where it keeps its own path that path is a NAMED exemption below rather than an absence.
 *  - **The writer's own sites**: those in `sync/arrivals.ts` that `writeArrivals` itself reaches. A second writer
 *    written into the same file is not the writer.
 *  - **The byte doors are doors too (bundle-48, D9).** A file's BYTES arrive by two roads that are not a record page: the
 *    upload door (`POST /api/files/:spaceId`, single and chunked, where a peer's push is an arrival and a person's upload
 *    is not) and the manifest pull (already in the pull engine above). Both record the arrival through ONE function,
 *    `recordArrivedBytes` (`files/bytes-arrived.ts`), which stands for the rule where `writeArrivals` cannot: it records the
 *    row naming the bytes (`recordArrivedFile`) and the status mark of the processing it queues
 *    (`setFileProcessingState`). So a record write is the byte writer's when a door reaches it ONLY through that function:
 *    the walk is run again with the function cut out, and what no longer appears is its own. A door that reached
 *    `recordArrivedFile` another way — a second byte writer — would still appear, and fail. Before bundle-48 the
 *    upload door was not a door here at all, and `recordArrivedFile` was a named exemption standing for both roads.
 *
 * ## Scope, stated rather than implied
 *
 * "Every record-collection write a door reaches" — not "every write". A tombstone row, a link violation, the
 * sequence counter, the file-hash cache are not records and are not governed here. And the exemptions are the
 * places the design keeps a separate path ON PURPOSE (tombstone apply and file-meta page batching are `Q-107`
 * part 2; file BYTES are file sync), each with its reason, each failing when it no longer excuses anything.
 *
 * ## Seen red
 *
 * Red on 797dbb2e: `sync/arrivals.ts` does not exist; `ingestBrainDoc`, `batchUpsertBySeq` and the inline
 * `$setOnInsert` in `POST /entities` write record collections directly.
 *
 * Run: node --test testing/standalone/an-arrival-is-written-by-one-writer.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { moduleIndex, routeHandlerRoots, walkFrom, pathTo } from './_call-graph.mjs';
import { mountedRoutes } from './_routes.mjs';
import { recordWrites } from './_record-writes.mjs';

const { BRAIN_COLLECTIONS } = await import('../../server/dist/config/types.js');

const ARRIVALS = 'server/src/sync/arrivals.ts';
const WRITER = `${ARRIVALS}:writeArrivals`;
const ENGINE = 'server/src/sync/engine.ts';
const IMPORTER = 'server/src/api/admin-import.ts';
const SYNC_ROUTES_DIR = 'server/src/api/sync/';

/**
 * Functions a door may reach that write a record collection OUTSIDE the writer, and why.
 *
 * Keyed `path:function`. An entry that no door reaches any more, or whose function no longer writes a record
 * collection, fails — so this cannot outlive what it excuses.
 */
const EXEMPT = {
  'server/src/sync/tombstone-apply.ts:applyPeerTombstones':
    'a peer\'s tombstones delete their records — POST /api/sync/tombstones and the pull\'s tombstone transfer, one '
    + 'apply for both doors (bundle-46). A delete, not an arrival',
  // `api/sync/_shared.ts:ingestFileMeta` was exempt here until `Q-107` part 2: file metadata is now merged by the
  // writer itself (`fileMetaUpdate`, under its write guard), so its exemption went with it.
  'server/src/brain/suppression-sweep.ts:dropFileVectors':
    'a file this instance suppresses on arrival (Q-230): the vectors of the rows DERIVED from it are removed — local '
    + 'derived fields of rows no peer sends; the arriving record itself is written by writeArrivals',
  'server/src/brain/suppression-sweep.ts:sweepSuppressedVectors':
    'a network\'s meta change (a concluded round, a pulled layer) that turns suppression on removes the stored vectors '
    + 'of what it now suppresses (bundle-30 R5) — local derived fields of records already held; no arriving record',
  'server/src/brain/suppression-sweep.ts:sweepFiles':
    'the files half of sweepSuppressedVectors, above',
  'server/src/sync/fill-file-meta.ts:fillFileMetaFromStray':
    'the stray-filemeta drain\'s recovery (Q-219), reached through writeArrivals only with `fillOnly`, which no door '
    + 'sets: it fills a row this instance made, or applies the seq accept at the write, and never creates a row',
  'server/src/sync/fill-file-meta.ts:fillReceiverMadeRow':
    'the fill half of fillFileMetaFromStray, above',
  // `files/file-meta.ts:recordArrivedFile` was exempt here ("the BYTES of a file arrived") until bundle-48: it is the byte
  // writer's own write now (`BYTE_WRITER`, below), reached only through `recordArrivedBytes`, and a door reaching it any
  // other way fails instead of being excused.
  'server/src/files/file-meta.ts:upsertFileMeta':
    'the upload door\'s LOCAL branch: a person\'s upload is an authored write and is stamped as one. A peer\'s push never reaches '
    + 'it — `recordStoredFile` takes the arrival branch first and returns (asserted below)',
  'server/src/files/derived-fields.ts:setFileProcessingState':
    'a status mark on a row some writer already recorded — the byte writer\'s arrival, a person\'s upload through the same door, the '
    + 'media worker: it sets only local processing fields (`embeddingStatus`...), which no peer sends and the hash does not see, and '
    + 'stamps neither `updatedAt` nor `seq` by construction (`a-file-row-processing-write-goes-through-one-function`). Not an arrival write at any door',
  'server/src/files/file-meta.ts:deleteFileMeta':
    'file sync: a file tombstone removes the file and its metadata',
  'server/src/files/file-meta.ts:markFileMetaDeleted':
    'file sync: a peer\'s file tombstone, on an instance that keeps deleted rows for audit (`softDeleteFileMeta`), flags the row '
    + 'deleted instead of removing it (`removeFileHere`, the steps of a local delete) — a delete, not an arrival',
  'server/src/files/converters/pipeline.ts:removeWhatSidecarsLeft':
    'file sync: a peer\'s file tombstone removes the chunk and sidecar rows DERIVED from the file here, at every level (`removeFileHere`, '
    + 'through `deleteConversionArtifacts`, the step a directory\'s delete shares), as a local delete does — rows no peer sends '
    + '(`derived` in the writer), removed with the file they came from',
  'server/src/sync/file-sync.ts:recordSyncBase':
    'file sync: the last-agreed hash a conflict is judged against, local bookkeeping on the file row',
  'server/src/spaces/_shared.ts:repairStaleSpaceIds':
    'space creation reached from membership gossip repairs a stale spaceId on records already stored; it stores '
    + 'no arriving document',
  'server/src/sync/delivered-by-backfill.ts:stampCollection':
    'the one-time stamp of who delivered the rows stored before `deliveredBy` existed (bundle-51), run by the sync cycle: it '
    + 'writes a local-only field on rows already held and stores no arriving document',
  'server/src/brain/entities.ts:unlabelFacesWhere':
    'the face-label cascade of a deleted entity (`unlabelFacesForEntities`, which a peer-applied entity tombstone now runs, '
    + 'Q-395): it clears the entity\'s claim on face rows already held and stores no arriving document',
};

/**
 * The one function a file's BYTES arrive through: the row, the processing queue by this instance's rules, the count.
 *
 * Exempt VIA the function rather than per write: the writes it makes are other modules' functions (`recordArrivedFile`,
 * `setFileProcessingState`), and the thing that must not be bypassed is the function. A record write a door reaches ONLY
 * through it is excused by the reason here; the same write reached any other way is not (`reachedRecordWrites`). Each row
 * fails when it no longer excuses a write.
 */
const BYTE_WRITER = 'server/src/files/bytes-arrived.ts:recordArrivedBytes';
const EXEMPT_VIA = {
  [BYTE_WRITER]:
    'file BYTES arrived (a peer\'s push to the upload door, or the manifest pull): it records the row that names them '
    + '(`recordArrivedFile`: size, hash, the peer as deliverer, no seq stamp) and the processing state of what it queued '
    + '(`setFileProcessingState`: a status mark that stamps no `updatedAt` and no `seq`), once, for both roads',
};
/** The upload door: a peer's push to it is an arrival, so it is a door of this rule though it is not under api/sync. */
const BYTE_DOOR_FILE = 'server/src/api/files-upload.ts';
const STORE_FILE_RECORD = 'server/src/files/store-file.ts:recordStoredFile';

const INDEX = moduleIndex('server/src');
const ROUTES = mountedRoutes();
// Registered BEFORE the writers are derived, so a write inside an inline handler belongs to its route.
const ROUTE_ROOTS = new Map(ROUTES.map(r => [`${r.method} ${r.path}`, routeHandlerRoots(INDEX, r)]));

const RECORDS = recordWrites(INDEX, { collections: BRAIN_COLLECTIONS, floors: { space: 150 }, recordFloor: 50 });

const reaches = (roots, opts = { closures: true }) => walkFrom(INDEX, roots, opts);

/** The doors, derived. */
const SYNC_DOORS = ROUTES.filter(r => r.file.startsWith(SYNC_ROUTES_DIR));
const IMPORT_DOORS = ROUTES.filter(r => {
  // `closures: true`: a route's inline handler IS a closure, and without it the walk sees an empty body.
  const { seen } = reaches(ROUTE_ROOTS.get(`${r.method} ${r.path}`));
  return [...seen].some(k => k.startsWith(`${IMPORTER}:`));
});
const ENGINE_ROOTS = [...INDEX.bodies.keys()].filter(k => k.startsWith(`${ENGINE}:`));
/** The routes a single record or a batch of them is PUSHED to: every POST of the document router. */
const PUSH_DOORS = SYNC_DOORS.filter(r => r.method === 'POST' && r.file === `${SYNC_ROUTES_DIR}docs.ts`);

/** The upload door, single and chunked: where a peer's byte push arrives. A route of its file is a door of this rule. */
const BYTE_DOORS = ROUTES.filter(r => r.file === BYTE_DOOR_FILE);

const DOORS = [
  ...[...SYNC_DOORS, ...IMPORT_DOORS, ...BYTE_DOORS].map(r => ({ name: `${r.method} ${r.path}`, roots: ROUTE_ROOTS.get(`${r.method} ${r.path}`) })),
  { name: 'the pull engine', roots: ENGINE_ROOTS },
];

/**
 * The index with `fnKey`'s body emptied: a walk over it still REACHES the function and goes no further, which is how "reached
 * only through it" is asked. (Removing the key would make the walk read an entry that is not there.)
 */
function indexCutAt(fnKey) {
  assert.ok(INDEX.bodies.has(fnKey), `${fnKey} is not in the call-graph index — an EXEMPT_VIA row names a function that does not exist`);
  const bodies = new Map(INDEX.bodies);
  bodies.set(fnKey, { ...INDEX.bodies.get(fnKey), body: '' });
  return { ...INDEX, bodies };
}

/**
 * Every record-collection write site some door reaches, with the door and the path that reaches it. `exemptVia` names the
 * EXEMPT_VIA function the site is reached ONLY through from that door (the writes the byte writer makes), else undefined.
 */
function reachedRecordWrites() {
  const out = [];
  const cuts = Object.keys(EXEMPT_VIA).map(fn => [fn, indexCutAt(fn)]);
  for (const door of DOORS) {
    const { seen, parent } = reaches(door.roots);
    const around = cuts.map(([fn, cut]) => [fn, walkFrom(cut, door.roots, { closures: true }).seen]);
    for (const key of seen) {
      for (const s of RECORDS.byKey.get(key) ?? []) {
        const exemptVia = around.find(([fn, reached]) => seen.has(fn) && !reached.has(key))?.[0];
        out.push({ ...s, door: door.name, via: pathTo(parent, key).map(k => k.split(':').slice(1).join(':')).join(' > '), exemptVia });
      }
    }
  }
  return out;
}

const writerOwns = (() => {
  if (!INDEX.bodies.has(WRITER)) return () => false;
  const { seen } = reaches([WRITER]);
  return (s) => s.file === ARRIVALS && seen.has(s.key);
})();

describe('the derivation works', () => {
  it('found the doors (floors)', () => {
    assert.ok(SYNC_DOORS.length >= 30, `only ${SYNC_DOORS.length} route(s) mounted from ${SYNC_ROUTES_DIR} — re-anchor`);
    assert.ok(PUSH_DOORS.length >= 5, `only ${PUSH_DOORS.length} POST route(s) on the document router — re-anchor`);
    assert.ok(PUSH_DOORS.some(r => r.path === '/api/sync/batch-upsert'), 'the batch push route was not found — re-anchor');
    assert.ok(IMPORT_DOORS.length >= 1, `no route reaches ${IMPORTER} — the import door moved; re-anchor`);
    assert.ok(BYTE_DOORS.length >= 1, `no route is mounted from ${BYTE_DOOR_FILE} — the upload door moved; re-anchor`);
    // 14 on 797dbb2e, and batchUpsertBySeq is the one that leaves.
    assert.ok(ENGINE_ROOTS.length >= 10,`only ${ENGINE_ROOTS.length} function(s) in ${ENGINE} — re-anchor`);
  });

  it('the doors reach record-collection writes at all, so the rule below cannot pass by finding none', () => {
    const reached = reachedRecordWrites();
    assert.ok(reached.length >= 5, `the doors reach only ${reached.length} record-collection write(s) — the walk is broken`);
  });
});

describe('an arriving record is written by one writer', () => {
  it('the writer exists, in sync/arrivals.ts, and writes a record collection', () => {
    assert.ok(INDEX.files.includes(ARRIVALS), `${ARRIVALS} does not exist — every door still writes its own way`);
    assert.ok(INDEX.bodies.has(WRITER), `${ARRIVALS} declares no top-level writeArrivals`);
    assert.ok(RECORDS.sites.some(writerOwns), 'writeArrivals reaches no record-collection write of its own');
  });

  it('every push route, the import and the pull reach it', () => {
    const missing = [];
    const doors = [
      ...PUSH_DOORS.map(r => ({ name: `${r.method} ${r.path}`, roots: ROUTE_ROOTS.get(`${r.method} ${r.path}`) })),
      ...IMPORT_DOORS.map(r => ({ name: `${r.method} ${r.path}`, roots: ROUTE_ROOTS.get(`${r.method} ${r.path}`) })),
      { name: 'the pull engine', roots: ENGINE_ROOTS },
    ];
    for (const door of doors) if (!reaches(door.roots).seen.has(WRITER)) missing.push(door.name);
    assert.deepEqual(missing, [], 'these doors store arriving records without the arrival writer');
  });

  it('every byte door reaches the byte writer: the upload door and the manifest pull record an arrival ONE way', () => {
    assert.ok(INDEX.bodies.has(BYTE_WRITER), `${BYTE_WRITER} does not exist — bytes are recorded where they land again`);
    const doors = [
      ...BYTE_DOORS.map(r => ({ name: `${r.method} ${r.path}`, roots: ROUTE_ROOTS.get(`${r.method} ${r.path}`) })),
      { name: 'the pull engine', roots: ENGINE_ROOTS },
    ];
    const missing = doors.filter(door => !reaches(door.roots).seen.has(BYTE_WRITER)).map(d => d.name);
    assert.deepEqual(missing, [], 'these record arriving bytes without the byte writer: no prior read, no dispatch, no count');
  });

  it('a peer\'s push never reaches the authored writer: the arrival branch of recordStoredFile returns before it', () => {
    // The upload door's LOCAL branch writes the row through `upsertFileMeta`, an authored write that stamps a seq. That is
    // right for a person and wrong for a peer, so the one thing that keeps the exemption above honest is the order inside
    // the function both come through: the arrival branch, ending in a return, ahead of the first authored write.
    const body = INDEX.bodies.get(STORE_FILE_RECORD)?.body;
    assert.ok(body, `${STORE_FILE_RECORD} is not in the index — re-anchor`);
    const authored = body.indexOf('upsertFileMeta(');
    assert.ok(authored > -1, 'recordStoredFile no longer calls upsertFileMeta — the exemption names a write that is not here; remove it');
    const arrival = body.slice(0, authored);
    assert.ok(/if \(opts\.arrivedFrom\)/.test(arrival) && arrival.includes('recordArrivedBytes(') && /\breturn\b/.test(arrival),
      'the arrival branch (opts.arrivedFrom -> recordArrivedBytes -> return) does not precede the authored write: a peer\'s bytes '
      + 'would be recorded as an upload and stamped with this instance\'s seq');
  });

  it('every record-collection write a door reaches is the writer\'s, the byte writer\'s, or a named exemption', () => {
    const unclaimed = reachedRecordWrites()
      .filter(s => !writerOwns(s) && !s.exemptVia && !(s.key in EXEMPT))
      .map(s => `${s.key}:${s.line} ${s.op} (${s.collection ?? s.why}) — from ${s.door} via ${s.via}`);
    assert.deepEqual([...new Set(unclaimed)], [],
      'these store a record a door delivered outside writeArrivals, so they hold none of its preconditions (seq and '
      + 'id shape, retag, write guard, carried local fields, bump, enqueue). Route the write through the writer, or '
      + 'add an EXEMPT entry saying why this is not an arrival');
  });

  it('no record-collection write in a door file is left unowned by any function', () => {
    const doorFiles = new Set([...SYNC_DOORS.map(r => r.file), ENGINE, IMPORTER]);
    const orphans = RECORDS.orphans.filter(o => doorFiles.has(o.file))
      .map(o => `${o.file}:${o.line} ${o.op} (${o.collection ?? o.why})`);
    assert.deepEqual(orphans, [], 'record writes in a door file that no walk can reach, so the rule above never saw them');
  });

  it('every exemption still excuses a write a door reaches', () => {
    // A write reached only through an EXEMPT_VIA function is excused by that row, so a per-function row beside it excuses nothing.
    const live = new Set(reachedRecordWrites().filter(s => !s.exemptVia).map(s => s.key));
    const stale = Object.keys(EXEMPT).filter(k => !live.has(k));
    assert.deepEqual(stale, [], 'exemptions for functions no door reaches, or that no longer write a record — delete them');
  });

  it('every function exempt via still stands for a write some door reaches only through it', () => {
    const owned = new Set(reachedRecordWrites().filter(s => s.exemptVia).map(s => s.exemptVia));
    const stale = Object.keys(EXEMPT_VIA).filter(k => !owned.has(k));
    assert.deepEqual(stale, [], 'functions listed as an arrival\'s one writer that no door reaches a record write only through — delete the row, or the writer is bypassed');
    // The write it must stand for: the row that names the arriving bytes. Reached by both byte doors only through the writer.
    const mine = new Set(reachedRecordWrites().filter(s => s.exemptVia === BYTE_WRITER).map(s => s.key));
    const row = 'server/src/files/file-meta.ts:recordArrivedFile';
    assert.ok(mine.has(row), `${row} is not reached only through the byte writer by any door — it is written another way, or the writer stopped writing it`);
    for (const door of [...BYTE_DOORS.map(r => `${r.method} ${r.path}`), 'the pull engine']) {
      const doorSites = reachedRecordWrites().filter(s => s.door === door && s.key === row);
      assert.ok(doorSites.length >= 1 && doorSites.every(s => s.exemptVia === BYTE_WRITER),
        `${door} reaches ${row} ${doorSites.length ? 'around' : 'not at all, not even through'} the byte writer`);
    }
  });
});
