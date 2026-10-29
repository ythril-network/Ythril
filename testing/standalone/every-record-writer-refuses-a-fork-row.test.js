/**
 * Every function that writes one of the four forking collections refuses a fork row, or sits in a reasoned exemption table
 * (Q-624, design rev 4 section 8, section 16 test 21).
 *
 * ## The rule
 *
 * A fork row is an unchosen version, and it changes by exactly four routes: a resolve (the keep-writer writes the PARENT), a
 * delete, an arrival, and a re-mint that inserts a new row and tombstones the old one. An ordinary edit of a fork row by an
 * update, a relabel, a `save_bulk` by id or a merge is a fifth route nobody designed, and its failure is silent: a relabelled
 * fork edge was re-keyed onto its subject's derived id (`rekeyedRow` kept `forkOf`, `guardFor` stamped `_functionalGuard`), so
 * the next create of that triplet found nothing through `forkOf: null`, collided in the store for ever, and the guard blocked the
 * subject's functional slot. `refuseForkEdit(kind, stored)` (`brain/forks.ts`) is the one refusal (`ForkRowReadOnly`, 409
 * `fork_row_read_only`), and it sits where the stored copy is read, so no door can drop it.
 *
 * ## What is derived, and what is not
 *
 * The WRITERS are derived (`_record-writes.mjs`, the derivation `every-edge-writer-says-what-it-does-with-the-functional-guard`
 * uses): every function that writes the facts, entities, edges or chrono collection of a space, or a collection whose name is
 * computed, which may be one of them. Each must REACH `refuseForkEdit` through the call graph (an update reaches it through
 * `writeAtReadVersion`), or be in the exemption table below with its reason. The table is design section 8's writer table, and a
 * stale entry fails: an exemption outlives nothing it describes.
 *
 * Three claims the table makes are held beside it, because an exemption that says "refused elsewhere" is a claim:
 *
 *  - `writeAtReadVersion` reads the stored copy with a projection that names `forkOf`, or `refuseForkEdit` is handed a row that
 *    never says it is a fork and passes everything;
 *  - `ReadSet.stored()` refuses a fork row for a forking kind, the one door every `save_*` and `save_bulk` planner reads a stored
 *    copy through (`writeStage` is exempt on that ground and carries no assertion of its own);
 *  - `executeMerge` refuses a fork on either side before it writes (`relinkAndAbsorb` is exempt on that ground), and `rekeyEdges`
 *    asserts that no row handed to it carries `forkOf` (the relink partitions forks out and re-mints them).
 *
 * ## Red on the unchanged code
 *
 * On b857da8f `refuseForkEdit` does not exist, so every non-exempt writer fails and the three claims fail. After the change,
 * seen red by hand (put back by hand): the call removed from `updateEdgeById`'s read, and `forkOf` taken out of
 * `writeAtReadVersion`'s `{ seq: 1 }` projection.
 *
 * Run: node --test testing/standalone/every-record-writer-refuses-a-fork-row.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { moduleIndex, reachableFrom } from './_call-graph.mjs';
import { recordWrites } from './_record-writes.mjs';

const { FORKING_FAMILIES } = await import('../../server/dist/sync/upsert-plan.js');
const { BRAIN_COLLECTIONS } = await import('../../server/dist/config/types.js');
/**
 * The collections this rule governs: the forking families. Until `FORKING_FAMILIES` is declared the sweep ranges over every record
 * collection that is not a file's or a link's (the two that never fork), so the file still loads and every other case still runs; the
 * first case below says the set is missing.
 */
const GOVERNED = FORKING_FAMILIES ?? BRAIN_COLLECTIONS.filter(c => c !== 'files' && c !== 'links');

const REFUSAL = 'server/src/brain/forks.ts:refuseForkEdit';

/** `file:function` -> reason, for a group of writers that share one. `file:*` excuses every function of a file (the fork module itself). */
const reasoned = (reason, keys) => Object.fromEntries(keys.map(k => [`server/src/${k}`, reason]));

/** Design section 8's writer table. A writer here is not an ordinary edit of a record's body. */
const EXEMPT = {
  ...reasoned('delete is allowed (D4): a fork alone is removed with a tombstone and nothing else', [
    'brain/tombstones.ts:removeWithTombstones',
  ]),
  ...reasoned('arrival is one of the four ways a fork changes, or a peer\'s deletion, or the local mark of a decline', [
    'sync/arrivals.ts:writeArrivals', 'sync/tombstone-apply.ts:applyPeerTombstones',
    // Q-624 slice I3: the cascade an applied tombstone runs over the subject's forks, and the one writer of the decline mark (local-only, never body).
    'sync/tombstone-apply.ts:cascadeToForks', 'sync/resolved-elsewhere.ts:writeResolvedElsewhere',
  ]),
  ...reasoned('it writes only ids the read set read, and `ReadSet.stored()` refused a fork row there; a WritePlan carries no field to assert on', [
    'brain/write-plan/commit.ts:writeStage',
  ]),
  ...reasoned('it writes or clears the write guard marker, a local-only lock in this instance\'s index, which is not the record\'s body', [
    'brain/write-plan/commit.ts:clearStaleWriteGuard',
  ]),
  ...reasoned('the merge refuses a fork as either side in `executeMerge`, before any write; the relink then partitions forks out and re-mints them (section 7)', [
    'brain/merge.ts:relinkAndAbsorb',
  ]),
  ...reasoned('the relink partitions forks out and hands them to the re-mint; `rekeyEdges` asserts that no row handed to it carries `forkOf`', [
    'brain/edge-rekey.ts:rekeyEdges', 'brain/relink-references.ts:relinkEdgesOfRecord',
  ]),
  ...reasoned('retention applies to a fork as to any record: the sweep selects fork rows by their own stamp and writes no authored field (R14)', [
    'brain/chrono-redaction.ts:redactLapsedChronoContent', 'brain/chrono-redaction.ts:backfillTypedExpiry',
  ]),
  ...reasoned('it writes derived local fields (a vector, `matchedText`, a retention stamp), never body', [
    'brain/suppression-sweep.ts:sweepSuppressedVectors', 'files/derived-fields.ts:writeDerivedFields',
  ]),
  ...reasoned('it writes landing stamps or a provenance stamp: a position, or who delivered a row, never body', [
    'sync/positions-owed.ts:carryRows', 'sync/positions-owed.ts:repairRows', 'sync/delivered-by-backfill.ts:stampCollection',
  ]),
  ...reasoned('a boot migration or a restore rewrites every row of a collection, forks with the rest, before any door opens', [
    'db/drop-link-arrays.ts:dropLinkArrays', 'db/rekey-memory-kind-to-fact.ts:rekeyMemoryKindToFact', 'db/restore.ts:backupLoader',
    'spaces/_shared.ts:repairStaleSpaceIds',
  ]),
  ...reasoned('whole-collection removal, or an offline tool that unsets 6.0 fields on every row', [
    'spaces/lifecycle.ts:wipeSpaceUnqueued', 'sync/positions-rollback.ts:rollBackPositions', 'sync/positions-rollback.ts:rollBackForks',
  ]),
  ...reasoned('its collection name is computed and is never one of the four (candidate rows, a file move)', [
    'brain/candidate-prune.ts:pruneCandidateCollection', 'files/rekey-rows.ts:rekeyRows',
  ]),
  ...reasoned('the keep-writer writes the PARENT (never a fork row) through `writeAtReadVersion`, which refuses a fork row; the call is a callback the graph does not follow', [
    'brain/fork-keep.ts:writeKeptBody',
  ]),
  // The fork module is the writer of fork rows: the keep-writer writes the PARENT, and the re-mint inserts a new row and removes the old one.
  'server/src/brain/forks.ts:*': 'the fork module itself: `writeKeptBody` and the re-mint, which change a fork only by resolve or re-mint',
};

const exempt = (key) => key in EXEMPT || `${key.slice(0, key.indexOf(':'))}:*` in EXEMPT;

const INDEX = moduleIndex('server/src');
const RECORDS = recordWrites(INDEX, { collections: new Set(GOVERNED), floors: { space: 150 }, recordFloor: 5 });
const KEYS = [...new Set(RECORDS.sites.map(s => s.key))].sort();

const bodyOfKey = (key) => {
  const entry = INDEX.bodies.get(key);
  assert.ok(entry, `${key} is not a function of the tree: a function this gate relies on is gone or renamed`);
  return entry.body;
};

describe('the derivation finds the writers, so the rule cannot pass by finding none', () => {
  it('found the writers of the forking collections (floor), the four update functions among them', () => {
    assert.ok(KEYS.length >= 25, `only ${KEYS.length} writing function(s) found: ${KEYS.join(', ')}`);
    for (const k of ['brain/fact.ts:updateFact', 'brain/entities.ts:updateEntityById', 'brain/chrono.ts:updateChrono', 'brain/edges.ts:updateEdgeById']) {
      assert.ok(KEYS.includes(`server/src/${k}`), `${k} writes a forking collection and the derivation did not find it`);
    }
    assert.ok(Array.isArray(FORKING_FAMILIES) && FORKING_FAMILIES.length >= 4, 'FORKING_FAMILIES is not exported by sync/upsert-plan.ts: the collections this rule governs are not declared');
  });

  it('refuseForkEdit exists in the fork module', () => {
    assert.ok(INDEX.bodies.has(REFUSAL), `${REFUSAL} is not written: there is no one refusal for an ordinary edit of a fork row`);
  });
});

describe('every writer of a forking collection refuses a fork row or is a named exemption', () => {
  it('each writer reaches refuseForkEdit, or is exempt', () => {
    assert.ok(INDEX.bodies.has(REFUSAL), `${REFUSAL} does not exist, so no writer can reach it`);
    const reach = new Map();
    const reaches = (k) => { if (!reach.has(k)) reach.set(k, reachableFrom(INDEX, [k]).has(REFUSAL)); return reach.get(k); };
    const open = KEYS.filter(k => !exempt(k) && !reaches(k)).map(k => k.replace('server/src/', ''));
    assert.deepEqual(open, [],
      'these write a forking collection, do not reach refuseForkEdit and carry no exemption: an update, a relabel, a save by id or a merge naming a fork row '
      + 'edits an unchosen version in place. Route the stored read through writeAtReadVersion or ReadSet.stored(), or add an exemption that says why');
  });

  it('every exemption still names a function that writes, and says why', () => {
    const stale = Object.keys(EXEMPT).filter(k => !k.endsWith(':*') && !KEYS.includes(k));
    assert.deepEqual(stale, [], 'exemptions for functions that no longer write a forking collection: delete them');
    const fileWide = Object.keys(EXEMPT).filter(k => k.endsWith(':*')).map(k => k.slice(0, -2));
    for (const f of fileWide) assert.ok(INDEX.bodies.size > 0 && [...INDEX.bodies.values()].some(e => e.file === f), `the file-wide exemption names ${f}, which holds no function`);
    for (const [k, why] of Object.entries(EXEMPT)) assert.ok(why.length > 25, `${k}: an exemption owes its reason`);
  });

  it('no exemption excuses a writer that already reaches the refusal', () => {
    assert.ok(INDEX.bodies.has(REFUSAL), `${REFUSAL} does not exist`);
    const redundant = KEYS.filter(k => k in EXEMPT && reachableFrom(INDEX, [k]).has(REFUSAL)).map(k => k.replace('server/src/', ''));
    assert.deepEqual(redundant, [], 'these reach the refusal AND are exempt: the exemption says they do not, and one of the two is wrong');
  });
});

describe('the claims the exemptions make are true', () => {
  it('writeAtReadVersion reads the stored copy with a projection that names forkOf, and refuses', () => {
    const body = bodyOfKey('server/src/brain/write-at-read-version.ts:writeAtReadVersion');
    assert.ok(/\bforkOf\b/.test(body), 'writeAtReadVersion\'s read of the stored copy does not name forkOf: refuseForkEdit is handed a row that never says it is a fork, and passes everything');
    assert.ok(/\brefuseForkEdit\b/.test(body), 'writeAtReadVersion does not refuse a fork row: every update and relabel reaches it');
  });

  it('ReadSet.stored() refuses a fork row of a forking kind', () => {
    // `stored` is a method of a class, which the call graph does not index by name: its body is read from the source, from its declaration
    // line to the closing brace at the same indent.
    const src = stripComments(readFileSync('server/src/brain/write-plan/read-set.ts', 'utf8'));
    const at = src.search(/^ {2}stored\(kind: ReadKind, id: string(?:, forkRow: ForkRows = 'refuse')?\)[^\n]*\{\s*$/m);
    assert.ok(at > -1, 'read-set.ts has no `stored(kind, id)` method: the door every planner reads a stored copy through moved or changed shape');
    const method = src.slice(at, src.indexOf('\n  }\n', at));
    assert.ok(/\brefuseForkEdit\b/.test(method), 'ReadSet.stored() does not refuse a fork row: a save_* or save_bulk by id onto a fork edits it in place');
  });

  it('executeMerge refuses a fork on either side, and rekeyEdges asserts no row it is handed carries forkOf', () => {
    assert.ok(/\brefuseForkEdit\b/.test(bodyOfKey('server/src/brain/merge.ts:executeMerge')), 'executeMerge does not refuse a fork as the survivor or the absorbed record');
    assert.ok(/\bforkOf\b/.test(bodyOfKey('server/src/brain/edge-rekey.ts:rekeyEdges')), 'rekeyEdges does not assert on forkOf: a fork edge handed to it would be re-keyed onto its subject\'s id');
  });
});
