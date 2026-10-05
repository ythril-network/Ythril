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
 * The unset-only block (what the two `suppression-sweep.ts` exemptions claim they write) is red by hand, restored by hand:
 * a content `$set` added to the `updateMany` of `dropFileVectors`, of `sweepPaged`, and a `deleteMany` added to
 * `forEachPage`, which `sweepPaged` reaches.
 *
 * Run: node --test testing/standalone/an-arrival-is-written-by-one-writer.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { moduleIndex, routeHandlerRoots, walkFrom, pathTo } from './_call-graph.mjs';
import { mountedRoutes } from './_routes.mjs';
import { recordWrites, WRITE_METHODS } from './_record-writes.mjs';
import { argumentsOf } from './_structural-window.mjs';
import { stripComments } from './_strip-comments.mjs';

const { BRAIN_COLLECTIONS } = await import('../../server/dist/config/types.js');
const { UNSET_VECTOR, DERIVED_LOCAL_FIELDS } = await import('../../server/dist/sync/local-only-fields.js');

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
  'server/src/api/sync/_shared.ts:ingestFileMeta':
    'file metadata is merged with $set of the authored keys and never replaced (CLAUDE.md, "What a receiver does '
    + 'after the write"); its page batching is Q-107 part 2',
  'server/src/sync/fill-file-meta.ts:fillFileMetaFromStray':
    'the stray-filemeta drain\'s recovery (Q-219), reached through writeArrivals only with `fillOnly`, which no door '
    + 'sets: it fills a row this instance made, or applies the seq accept at the write, and never creates a row',
  'server/src/sync/fill-file-meta.ts:fillReceiverMadeRow':
    'the fill half of fillFileMetaFromStray, above',
  'server/src/files/file-meta.ts:recordArrivedFile':
    'file sync: the BYTES of a file arrived, and the receiver records what it derived from them',
  'server/src/files/file-meta.ts:deleteFileMeta':
    'file sync: a file tombstone removes the file and its metadata',
  'server/src/sync/file-sync.ts:recordSyncBase':
    'file sync: the last-agreed hash a conflict is judged against, local bookkeeping on the file row',
  'server/src/spaces/_shared.ts:repairStaleSpaceIds':
    'space creation reached from membership gossip repairs a stale spaceId on records already stored; it stores '
    + 'no arriving document',
  'server/src/brain/suppression-sweep.ts:dropFileVectors':
    'removes the RECEIVER\'s own vector fields (derived, never replicated) from the file ids it is handed and every row '
    + 'derived from them. On an arrival (ingestFileMeta, Q-230) the ids are the arriving file\'s: the STORED copy of the '
    + 'arriving parent row and its chunk and passage rows lose their vectors here, before ingestFileMeta writes the '
    + 'arrival\'s own row. The suppression sweep\'s record tier calls it too. It writes only an $unset of those fields '
    + '(asserted below) and stores nothing the arriving document carries',
  'server/src/brain/suppression-sweep.ts:sweepPaged':
    'the suppression sweep\'s one updater: it removes the receiver\'s own vector fields where its meta now suppresses '
    + 'them. A door reaches it only through updateSpace, which asks for the sweep after EVERY write of the effective '
    + 'meta — an operator\'s edit, a schema route\'s, a concluded vote\'s (the vote route, and the pull\'s vote '
    + 'propagation), a network layer arriving or recomputed — so the vote is one path of several, not the reason. It '
    + 'writes only an $unset of those fields (asserted below) and stores no arriving document',
};

/**
 * The exempt functions whose reason is "removes the receiver's own derived vector fields and nothing else". Each must be
 * an EXEMPT key; the last describe block holds them to it, so a content `$set` added to one fails there, not in review.
 */
const UNSET_ONLY = [
  'server/src/brain/suppression-sweep.ts:dropFileVectors',
  'server/src/brain/suppression-sweep.ts:sweepPaged',
];

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

const DOORS = [
  ...[...SYNC_DOORS, ...IMPORT_DOORS].map(r => ({ name: `${r.method} ${r.path}`, roots: ROUTE_ROOTS.get(`${r.method} ${r.path}`) })),
  { name: 'the pull engine', roots: ENGINE_ROOTS },
];

/** Every record-collection write site some door reaches, with the door and the path that reaches it. */
function reachedRecordWrites() {
  const out = [];
  for (const door of DOORS) {
    const { seen, parent } = reaches(door.roots);
    for (const key of seen) {
      for (const s of RECORDS.byKey.get(key) ?? []) {
        out.push({ ...s, door: door.name, via: pathTo(parent, key).map(k => k.split(':').slice(1).join(':')).join(' > ') });
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
    // 14 on 797dbb2e, and batchUpsertBySeq is the one that leaves.
    assert.ok(ENGINE_ROOTS.length >= 10,`only ${ENGINE_ROOTS.length} function(s) in ${ENGINE} — re-anchor`);
  });

  it('the doors reach record-collection writes at all, so the rule below cannot pass by finding none', () => {
    const reached = reachedRecordWrites();
    assert.ok(reached.length >= 5, `the doors reach only ${reached.length} record-collection write(s) — the walk is broken`);
  });
});

/**
 * What an exemption's reason SAYS the function writes is held to what it writes. "Removes the receiver's own vector
 * fields and nothing else" is the claim that makes `dropFileVectors` and `sweepPaged` not arrivals; it was a sentence,
 * and a content `$set` added to either would have passed the gate above, which only asks whether a write is excused.
 *
 * Every record-collection write reachable FROM the exempt function counts, not only its own body: a helper it calls
 * that gains a write is the same defect one call away. Each such write must be `updateOne`/`updateMany` of exactly two
 * arguments (a third is the options object, where `upsert: true` would create a row) whose update is
 * `{ $unset: UNSET_VECTOR }`, and `UNSET_VECTOR` must be the local-only module's own, naming only derived local fields.
 */
describe('an exemption that only removes derived vector fields writes nothing else', () => {
  const UPDATES = new Set(['updateOne', 'updateMany']);
  const WRITE_CALL = new RegExp(`\\.\\s*(${WRITE_METHODS.join('|')})\\s*(?:<[^>(]*>)?\\s*\\(`, 'g');
  const LOCAL_ONLY = 'server/src/sync/local-only-fields.ts';
  const SWEEP = 'server/src/brain/suppression-sweep.ts';

  /** Every write call in the functions `key` reaches that write a record collection: `{ at, op, args }`. */
  function writeCallsFrom(key) {
    const calls = [];
    for (const reached of reaches([key]).seen) {
      if (!RECORDS.byKey.has(reached)) continue;
      const body = stripComments(INDEX.bodies.get(reached).body);
      for (const m of body.matchAll(WRITE_CALL)) {
        calls.push({ at: reached, op: m[1], args: argumentsOf(body, m.index + m[0].length - 1, `${reached} ${m[1]}`) });
      }
    }
    return calls;
  }

  it('the claim is made only of exemptions that exist, and the vector fields are the receiver\'s own', () => {
    assert.ok(UNSET_ONLY.length >= 1, 'no exemption is held to the unset-only rule');
    assert.deepEqual(UNSET_ONLY.filter(k => !(k in EXEMPT)), [], 'named as unset-only but not exempt — delete or add the exemption');
    const fields = Object.keys(UNSET_VECTOR);
    assert.ok(fields.length >= 1, 'UNSET_VECTOR names no field — the $unset below would remove nothing');
    assert.deepEqual(fields.filter(f => !DERIVED_LOCAL_FIELDS.has(f)), [],
      'UNSET_VECTOR removes a field that is not a derived local one — that is content, which a peer\'s copy would carry');
    assert.match(stripComments(INDEX.sources.get(SWEEP)),
      new RegExp(`import\\s*\\{[^}]*\\bUNSET_VECTOR\\b[^}]*\\}\\s*from\\s*'\\.\\./sync/local-only-fields\\.js'`),
      `${SWEEP} must import UNSET_VECTOR from ${LOCAL_ONLY}, not spell the field set itself`);
  });

  for (const key of UNSET_ONLY) {
    it(`${key.split(':')[1]} stores nothing but an $unset of UNSET_VECTOR`, () => {
      assert.ok(INDEX.bodies.has(key), `${key} no longer exists — re-anchor, or delete its exemption`);
      const calls = writeCallsFrom(key);
      assert.ok(calls.length >= 1, `${key} (with what it reaches) makes no record write the gate can see — it would pass by finding none`);
      const wrong = calls.filter(c => !UPDATES.has(c.op) || c.args.length !== 2 || c.args[1].replace(/\s+/g, ' ') !== '{ $unset: UNSET_VECTOR }')
        .map(c => `${c.at} .${c.op}(${c.args.map(a => a.replace(/\s+/g, ' ')).join(', ')})`);
      assert.deepEqual(wrong, [],
        'its exemption says it only removes the receiver\'s own derived vector fields; this writes something else, which '
        + 'is an arrival or an edit and belongs in the writer — or the reason is wrong and must be rewritten');
    });
  }
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

  it('every record-collection write a door reaches is the writer\'s, or a named exemption', () => {
    const unclaimed = reachedRecordWrites()
      .filter(s => !writerOwns(s) && !(s.key in EXEMPT))
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
    const live = new Set(reachedRecordWrites().map(s => s.key));
    const stale = Object.keys(EXEMPT).filter(k => !live.has(k));
    assert.deepEqual(stale, [], 'exemptions for functions no door reaches, or that no longer write a record — delete them');
  });
});
