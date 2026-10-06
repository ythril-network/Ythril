/**
 * Every create/converge write to a brain record collection happens in `brain/write-plan/commit.ts` (Q-99 part 3).
 *
 * ## The rule
 *
 * The create/converge writers (`saveFact`, `upsertEntity`, `createChrono`, `upsertEdge`, and the connections
 * they apply) are split into a PLAN — every rule, decided against a read set — and one COMMIT that writes the
 * plans. A single-record write is a commit of one plan and a bulk is a commit of many, so the rules exist once
 * and the round trips are paid per batch, not per item.
 *
 * The split is only real while nothing on that path writes a record collection anywhere else. A writer that
 * keeps one direct `insertOne` has a second write path the batch does not see: its seq, its links and its
 * embed job land outside the commit's ordering, and the bulk and single doors stop meaning the same thing.
 *
 * ## Scope, stated rather than implied
 *
 * This is about the CREATE/CONVERGE writers only. `update*`, `delete*`, merge, re-key, redaction, sync ingest,
 * migrations and file metadata keep their own paths by design (Design v3 item 1), and each is a NAMED
 * exemption below with its reason. The title says "create/converge" for that reason and nothing here says
 * "every write".
 *
 * ## What is derived
 *
 *  - **The write methods** are every method `db/record-write-observer.ts` classifies as a write or a delete,
 *    and each must be one the site scanner can see — a method it cannot see is a door this gate is blind to.
 *  - **The record collections** are `BRAIN_COLLECTIONS` minus `files`: the knowledge collections and `links`.
 *    `files` is file metadata, which has its own writer (`files/file-meta.ts`) and is not a create/converge
 *    record. A site whose collection name is COMPUTED (a parameter, a `${id}_${suffix}` with a variable
 *    suffix) may be a record collection, so it is held to the same rule rather than guessed away.
 *  - **The sites** come from `_space-writers.mjs`, which resolves aliases and helpers back to the collection
 *    they open, and its ORPHANS (writes inside an inline route handler no function owns) are held too.
 *  - **Reach**: from the create/converge writers, every record-collection write the call graph reaches. This
 *    is the part an exemption cannot hide: `reconcileLinks` stays a legitimate writer for the update path, and
 *    the reach case is what says the create path no longer goes through it.
 *
 * ## Seen red
 *
 * Red on 1d88828e: the commit does not exist, and `saveFact`/`upsertEntity`/`createChrono`/`upsertEdge` and
 * `reconcileLinks` write directly. Mutations, each restored by hand: an exemption entry deleted (red: an
 * unclaimed site); a dummy exemption for a function that writes nothing (red: stale).
 *
 * Re-anchored for `Q-107` part 1 and red on 797dbb2e for it: the sync-ingest rows collapse to the arrival writer
 * `sync/arrivals.ts:writeArrivals`, which does not exist yet (stale), while `ingestBrainDoc`, `batchUpsertBySeq`
 * and the `$setOnInsert` inline in `POST /api/sync/entities` (an orphan) still write directly.
 *
 * Run: node --test testing/standalone/a-create-converge-write-lives-in-the-commit.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { moduleIndex, walkFrom, pathTo } from './_call-graph.mjs';
import { MUTATORS } from './_space-writers.mjs';
import { recordWrites, WRITE_METHODS } from './_record-writes.mjs';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const { BRAIN_COLLECTIONS } = await import('../../server/dist/config/types.js');

const COMMIT = 'server/src/brain/write-plan/commit.ts';

/** The create/converge writers — the scope Design v3 item 1 sets, and the roots of the reach walk. */
const CREATE_CONVERGE_WRITERS = [
  'server/src/brain/fact.ts:saveFact',
  'server/src/brain/entities.ts:upsertEntity',
  'server/src/brain/chrono.ts:createChrono',
  'server/src/brain/edges.ts:upsertEdge',
  'server/src/brain/bulk.ts:bulkWrite',
];

/**
 * Every function that may write a record collection OUTSIDE the commit, and why it may.
 *
 * Keyed `path:function`. A stale entry (a function that no longer writes a record collection) fails, so this
 * list cannot quietly outlive what it excuses.
 */
const EXEMPT = {
  // update / delete paths keep their own write (Design v3 item 1)
  'server/src/brain/fact.ts:updateFact': 'update path: a partial edit of one existing fact, not a create/converge',
  'server/src/brain/fact.ts:deleteFact': 'delete path',
  'server/src/brain/entities.ts:updateEntityById': 'update path',
  'server/src/brain/entities.ts:deleteEntity': 'delete path',
  'server/src/brain/chrono.ts:updateChrono': 'update path',
  'server/src/brain/chrono.ts:deleteChrono': 'delete path',
  'server/src/brain/edges.ts:updateEdgeById': 'update path',
  // `deleteEdge` and the entity cascade both remove edges through the one remover (bundle-30, Q-107 part 3b).
  // Re-anchored (bundle-30 I6, C11): the delete moved into the one remover, which the edge removal's chunk, the merge's
  // duplicate edges and moved links, and the re-key's old rows all call.
  'server/src/brain/tombstones.ts:removeWithTombstones': 'delete path: rows deleted by id, each with its tombstone',
  // whole-record operations that are not a create
  // Re-keyed (bundle-30, Q-107 part 3a): the merge's writes moved into its transaction's callback, and the re-key's
  // into the one batched implementation `rekeyEdge` now calls.
  'server/src/brain/merge.ts:relinkAndAbsorb': 'merge: rewrites a survivor and retires the merged records',
  'server/src/brain/edge-rekey.ts:rekeyEdges': 're-key: moves an edge to a new identity, delete + insert',
  'server/src/brain/chrono-redaction.ts:redactLapsedChronoContent': 'redaction: a retention schedule clears content',
  'server/src/brain/chrono-redaction.ts:backfillTypedExpiry': 'retention: stamps a computed expiry on stored entries',
  'server/src/brain/embed-record.ts:embedStoredRecord': 'the embed worker stores a vector on a record already written',
  'server/src/brain/suppression-sweep.ts:sweepSuppressedVectors': 'suppression: removes vectors from stored records',
  'server/src/sync/tombstone-apply.ts:applyPeerTombstones': 'sync: a peer\'s tombstones delete their records',
  'server/src/brain/candidate-prune.ts:pruneCandidateCollection': 'prunes candidate rows; the collection name is computed',
  'server/src/spaces/lifecycle.ts:wipeSpace': 'the space wipe',
  'server/src/spaces/_shared.ts:repairStaleSpaceIds': 'repair: rewrites a stale spaceId field in every collection',
  // sync ingest and import: the receiver stores what a peer or a restore sent, through ONE writer (`Q-107` part 1;
  // CLAUDE.md, "What a receiver does after the write"). It replaced `ingestBrainDoc` (push, import) and the pull's
  // `batchUpsertBySeq`, and the routes' inline `$setOnInsert`, which is why the docs.ts orphan exemption is gone.
  'server/src/sync/arrivals.ts:writeArrivals': 'sync push, pull and admin import: the arrival writer',
  // migrations and restore
  'server/src/db/rekey-memory-kind-to-fact.ts:rekeyMemoryKindToFact': 'boot migration over local state',
  'server/src/db/drop-link-arrays.ts:dropLinkArrays': 'boot migration: drops the 4.x link arrays',
  'server/src/db/restore.ts:restoreDatabase': 'backup restore writes every collection',
  // The sequence counter is not here: `_record-writes.mjs` excludes it by what it is, so the three rows that
  // excused it one caller at a time (`withAllocatedSeqs`, `bumpSeq`, `moveSpaceData`) went with the extraction.
};

/** Orphan sites (no function owns them) are exempted by FILE, with the same obligation to be real. */
const EXEMPT_ORPHAN_FILES = {};

const RECORD_COLLECTIONS = new Set(BRAIN_COLLECTIONS.filter(c => c !== 'files'));

const INDEX = moduleIndex('server/src');
// Lowered from 170 when the plan/commit split folded the create/converge writers' direct writes into one
// commit (`Q-99` part 3): the sites went because the copies did, not because the scan broke.
// The record floor is 40, from 50: the counter sites (five on 797dbb2e) stopped counting as records when the
// predicate moved into `_record-writes.mjs`, which excludes the counter by what it is.
const RECORDS = recordWrites(INDEX, { collections: RECORD_COLLECTIONS, floors: { space: 150 }, recordFloor: 40 });
const WRITERS = RECORDS.writers;
const writesRecord = RECORDS.isRecordWrite;

const SITES = RECORDS.sites;
const ORPHANS = RECORDS.orphans;

describe('the derivation works', () => {
  it('found the write methods, the record collections and the sites (floors)', () => {
    assert.ok(WRITE_METHODS.length >= 10, `only ${WRITE_METHODS.length} write methods derived from COLLECTION_METHOD_EFFECT`);
    assert.ok(RECORD_COLLECTIONS.size >= 5 && RECORD_COLLECTIONS.has('facts') && RECORD_COLLECTIONS.has('links'),
      `the record collections derived as ${[...RECORD_COLLECTIONS].join(', ')}`);
    assert.ok(SITES.length >= 40, `only ${SITES.length} record-collection write sites found — the scan is broken`);
  });

  it('every write method the observer knows is one the site scanner can see, or is never called', () => {
    // The scanner has its own method list. A write method it does not list is a site this gate never sees, so
    // either it lists it or nothing under server/src calls it.
    const unseen = WRITE_METHODS.filter(m => !MUTATORS.includes(m));
    const sources = readTrackedSources('server/src', { untracked: true });
    const called = unseen.filter(m => sources.some(({ text }) => new RegExp(`\\.\\s*${m}\\s*\\(`).test(stripComments(text))));
    assert.deepEqual(called, [], `server/src calls write method(s) the site scanner cannot see: ${called.join(', ')}`);
  });
});

describe('a create/converge write to a record collection lives in the commit', () => {
  it('the commit exists and writes', () => {
    assert.ok(INDEX.files.includes(COMMIT), `${COMMIT} does not exist — the create/converge writers still write themselves`);
    const own = [...SITES, ...ORPHANS].filter(s => s.file === COMMIT);
    assert.ok(own.length >= 1, `${COMMIT} holds no record-collection write`);
  });

  it('every record-collection write site is in the commit or a named exemption', () => {
    const unclaimed = SITES
      .filter(s => s.file !== COMMIT && !(s.key in EXEMPT))
      .map(s => `${s.key}:${s.line} ${s.op} (${s.collection ?? s.why})`);
    assert.deepEqual([...new Set(unclaimed)], [],
      'these write a record collection outside the commit. A create/converge write belongs in the commit; any '
      + 'other path needs an EXEMPT entry saying why it is not a create/converge write');
  });

  it('every orphan record-collection write is in the commit or an exempted file', () => {
    const unclaimed = ORPHANS
      .filter(o => o.file !== COMMIT && !(o.file in EXEMPT_ORPHAN_FILES))
      .map(o => `${o.file}:${o.line} ${o.op} (${o.collection ?? o.why})`);
    assert.deepEqual(unclaimed, [], 'record-collection writes no function owns, outside the commit');
  });

  it('every exemption still excuses something', () => {
    const live = new Set(SITES.map(s => s.key));
    const liveOrphanFiles = new Set(ORPHANS.map(o => o.file));
    const stale = [
      ...Object.keys(EXEMPT).filter(k => !live.has(k)),
      ...Object.keys(EXEMPT_ORPHAN_FILES).filter(f => !liveOrphanFiles.has(f)),
    ];
    assert.deepEqual(stale, [], 'exemptions for code that no longer writes a record collection — delete them');
  });

  it('nothing reached from a create/converge writer writes a record collection outside the commit', () => {
    // The exemption list says which functions MAY write; this says the create path does not reach them. It is
    // what keeps `reconcileLinks` (exempt for the update path) from being the create path's link writer too.
    // The sequence counter is excluded by what it is (`_record-writes.mjs`): allocating a seq is not a record write.
    const { seen, parent } = walkFrom(INDEX, CREATE_CONVERGE_WRITERS);
    for (const root of CREATE_CONVERGE_WRITERS) assert.ok(seen.has(root), `${root} is gone — re-anchor the scope`);
    const reached = [];
    for (const key of seen) {
      for (const s of WRITERS.byKey.get(key) ?? []) {
        if (!writesRecord(s) || s.file === COMMIT) continue;
        reached.push(`${s.key}:${s.line} ${s.op} (${s.collection ?? s.why}) via ${pathTo(parent, key).map(k => k.split(':')[1]).join(' > ')}`);
      }
    }
    assert.deepEqual([...new Set(reached)], [],
      'the create/converge path writes a record collection outside the commit');
  });
});
