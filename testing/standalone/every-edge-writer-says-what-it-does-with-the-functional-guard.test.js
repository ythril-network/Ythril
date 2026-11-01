/**
 * Every function that writes a space's edges collection says what it does with the functional guard marker (`Q-439`).
 *
 * ## The rule
 *
 * `_functionalGuard` is a pure function of `(from, label, functional-strict at write)`. A write that changes `from` or
 * `label` — or replaces the whole document — and says nothing about the marker leaves a PHANTOM: a marker that no longer
 * names its edge, which holds the subject's unique slot for ever and refuses every legitimate write under it. The writer
 * that forgets is invisible from where the marker is stamped, so each writer states its handling here, in one of four words:
 *
 *  - `stamp` — it sets the marker for the (from, label) it writes (the planner's insert lives in the commit; a relabel
 *    restamps for its new label);
 *  - `drop` — it removes the marker and leaves the edge unmarked, which is safe because the planner's count still refuses;
 *  - `carry-if-unchanged` — it keeps the stored marker only while `from` and `label` are the stored ones;
 *  - `none-by-design` — it writes nothing that touches `from`, `label` or the marker (a vector, a delete that frees the
 *    marker, a collection that is not edges), with the reason.
 *
 * ## What is derived, and what is not
 *
 * The SITES are derived, by `_record-writes.mjs` (the derivation `a-create-converge-write-lives-in-the-commit` uses): every
 * write on the edges collection of a space, and every write whose collection name is computed — which may be edges, so it
 * is held to the rule rather than guessed away. The commit (`brain/write-plan/commit.ts`) is the one writer that needs no
 * entry: it writes the planner's documents, stamp included. The MAP is the one hand-written thing, and a stale entry fails.
 *
 * For `stamp`, `drop` and `carry-if-unchanged` the function's own body must name the marker (`_functionalGuard`) or its
 * class (`WRITE_GUARD_FIELDS`): a writer that claims to handle it and does not is the failure, and deleting merge's `$unset`
 * is the mutation that shows it.
 *
 * ## Seen red
 *
 * Red on 9a4b41c6: no writer names the marker, so every `stamp`, `drop` and `carry-if-unchanged` entry fails its body
 * check. Mutations, each put back by hand: delete merge's `$unset` of the marker (red: relinkAndAbsorb); add a writer of
 * the edges collection with no entry (red: unclaimed); add an entry for a function that writes nothing (red: stale).
 *
 * Run: node --test testing/standalone/every-edge-writer-says-what-it-does-with-the-functional-guard.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { moduleIndex } from './_call-graph.mjs';
import { recordWrites } from './_record-writes.mjs';

const COMMIT = 'server/src/brain/write-plan/commit.ts';
const HANDLED = new Set(['stamp', 'drop', 'carry-if-unchanged']);
const WORDS = new Set([...HANDLED, 'none-by-design']);
/** What a handling body names: the marker itself, or the class that carries it. */
const NAMES_THE_MARKER = /\b_?functionalGuard\b|\bWRITE_GUARD_FIELDS\b|\bFUNCTIONAL_GUARD\b|\bUNSET_GUARD\b/;

/**
 * Keyed `path:function`. A stale entry fails, so this cannot outlive what it describes.
 */
const WRITERS = {
  'server/src/brain/edge-rekey.ts:rekeyEdges':
    { marker: 'stamp', why: 'a relabel moves the edge to a new identity: the row is stamped for its NEW label, after the re-key helper drops the old marker' },
  'server/src/brain/edges.ts:updateEdgeById':
    { marker: 'stamp', why: 'both relabel branches (the re-key and the in-place peer-authored one) set or unset the marker in the same write as the label' },
  // Moved from `merge.ts:relinkAndAbsorb` (bundle-81 slice I4): the relink is shared with Review's fork resolve.
  'server/src/brain/relink-references.ts:relinkEdgesOfRecord':
    { marker: 'drop', why: 'a relink moves from/to: the re-key drops the marker and the in-place relink only $unsets it, so a merge or a fork resolve never fails on it' },
  'server/src/sync/arrivals.ts:writeArrivals':
    { marker: 'carry-if-unchanged', why: 'a peer arrival never brings a marker; the replacement keeps this instance\'s own only while from and label are the stored ones' },

  'server/src/files/derived-fields.ts:writeDerivedFields': { marker: 'none-by-design', why: 'the embed job\'s write of derived fields onto a record already written; it refuses any hashed key, so from and label are never touched, and the marker is not derived so it is never unset' },
  'server/src/brain/suppression-sweep.ts:sweepSuppressedVectors': { marker: 'none-by-design', why: 'removes vectors only' },
  'server/src/files/rekey-rows.ts:rekeyRows': { marker: 'none-by-design', why: 'the rows of a file move and the jobs that follow it: the collection name is a parameter and is never edges (an edge re-key keeps its own writer and shares only the destination guard)' },
  'server/src/brain/tombstones.ts:removeWithTombstones': { marker: 'none-by-design', why: 'a delete frees the marker with the row' },
  'server/src/spaces/lifecycle.ts:wipeSpaceUnqueued': { marker: 'none-by-design', why: 'the space wipe (its body, run by the space-act runner) deletes every row, markers included' },
  'server/src/sync/tombstone-apply.ts:applyPeerTombstones': { marker: 'none-by-design', why: 'a peer\'s tombstone is a delete' },
  'server/src/sync/positions-owed.ts:carryRows': { marker: 'none-by-design', why: 'sets position fields on rows held; from, label and the marker are untouched' },
  'server/src/sync/positions-owed.ts:repairRows': { marker: 'none-by-design', why: 'sets position fields on rows held; from, label and the marker are untouched' },
  'server/src/sync/positions-rollback.ts:rollBackPositions': { marker: 'none-by-design', why: 'unsets the 6.0 local fields (never the write guard) on rows held' },
  'server/src/sync/delivered-by-backfill.ts:stampCollection': { marker: 'none-by-design', why: 'stamps who delivered a row; from, label and the marker are untouched' },
  'server/src/brain/candidate-prune.ts:pruneCandidateCollection': { marker: 'none-by-design', why: 'prunes candidate rows; the collection name is computed and is not edges' },
  'server/src/brain/chrono-redaction.ts:backfillTypedExpiry': { marker: 'none-by-design', why: 'chrono entries; the collection name is computed' },
  'server/src/brain/retention-stamp-heal.ts:healStoredStamps': { marker: 'none-by-design', why: 'the sweep\'s heal sets or unsets a retention stamp on a row that exists; it writes neither from nor label, so the marker is neither stamped nor unset' },
  'server/src/db/drop-link-arrays.ts:dropLinkArrays': { marker: 'none-by-design', why: 'boot migration of the retired link arrays' },
  'server/src/db/rekey-memory-kind-to-fact.ts:rekeyMemoryKindToFact': { marker: 'none-by-design', why: 'boot migration of the memory kind' },
  'server/src/db/restore.ts:backupLoader': { marker: 'none-by-design', why: 'a dump restored verbatim into a collection emptied for it: every marker comes back with the from and label it was written with, and a restore act builds the guard index before it loads, so a duplicate marker in the backup fails the act' },
  'server/src/spaces/_shared.ts:repairStaleSpaceIds': { marker: 'none-by-design', why: 'rewrites a stale spaceId field in every collection' },
  // Q-624 (slice I3): the fork module's writers of fork rows (section 7 and the orphan resolve of section 9), each a new row with no marker.
  'server/src/brain/forks.ts:remintForks':
    { marker: 'drop', why: 'a re-minted fork row is built by rekeyedRow and the guard removed by name: a fork is never stamped, its old subject\'s marker would hold that slot for ever' },
  'server/src/brain/forks.ts:resolveOrphan':
    { marker: 'drop', why: 'an orphan edge kept is re-keyed onto its identity\'s own id as a new row without forkOf and without any marker' },
  // The keep-writer writes the PARENT (a record, never a fork row), and never its from or label, so the parent's own marker still names it.
  'server/src/brain/fork-keep.ts:writeKeptBody':
    { marker: 'carry-if-unchanged', why: 'the keep writes the parent\'s body and never an edge\'s identity, so the parent\'s marker is carried; it is skipped by name and never set or unset' },
  'server/src/sync/tombstone-apply.ts:cascadeToForks': { marker: 'none-by-design', why: 'an applied tombstone\'s cascade deletes the subject\'s fork rows, markers (there are none on a fork) with them' },
  'server/src/sync/resolved-elsewhere.ts:writeResolvedElsewhere': { marker: 'none-by-design', why: 'sets the local decision mark on a fork row; from, label and the marker are untouched' },
  'server/src/sync/positions-rollback.ts:rollBackForks': { marker: 'none-by-design', why: 'the offline rollback deletes unresolved fork rows and unsets their decision marks; the write guard is never touched' },
};

const INDEX = moduleIndex('server/src');
const RECORDS = recordWrites(INDEX, { collections: new Set(['edges']), floors: { space: 150 }, recordFloor: 5 });
// `recordWrites` keeps a space site whose collection is edges or computed, and every unknown receiver: the sites this rule governs.
const SITES = RECORDS.sites.filter(s => s.file !== COMMIT);
const KEYS = [...new Set(SITES.map(s => s.key))];

describe('the derivation works', () => {
  it('found the edge-collection write sites (floor), the commit among them', () => {
    assert.ok(RECORDS.sites.some(s => s.file === COMMIT), `${COMMIT} writes no edges site: the derivation lost the commit`);
    assert.ok(KEYS.length >= 8, `only ${KEYS.length} writing functions found: ${KEYS.join(', ')}`);
    assert.ok(RECORDS.sites.some(s => s.collection === 'edges'), 'no site names the edges collection itself');
  });

  it('the map says one of the four words, with a reason, for each entry', () => {
    const bad = Object.entries(WRITERS).filter(([, v]) => !WORDS.has(v.marker) || !v.why).map(([k]) => k);
    assert.deepEqual(bad, []);
  });
});

describe('every edge writer says what it does with the functional guard', () => {
  it('every function writing the edges collection is the commit or has an entry', () => {
    const unclaimed = KEYS.filter(k => !(k in WRITERS));
    assert.deepEqual(unclaimed, [],
      'these write the edges collection (or a computed one) outside the commit with no stated handling of `_functionalGuard`: '
      + 'stamp it, drop it, carry it only while from/label are unchanged, or say none-by-design and why');
  });

  it('every entry still names a function that writes', () => {
    assert.deepEqual(Object.keys(WRITERS).filter(k => !KEYS.includes(k)), [],
      'entries for functions that no longer write the edges collection — delete them');
  });

  it('a writer that claims to stamp, drop or carry the marker names it', () => {
    const silent = Object.entries(WRITERS)
      .filter(([, v]) => HANDLED.has(v.marker))
      .filter(([key]) => {
        const entry = INDEX.bodies.get(key);
        return !entry || !NAMES_THE_MARKER.test(entry.body);
      })
      .map(([key, v]) => `${key} (${v.marker})`);
    assert.deepEqual(silent, [],
      'these claim to handle `_functionalGuard` and their body never names it (nor WRITE_GUARD_FIELDS): a re-keyed or relinked '
      + 'edge keeps a marker that no longer names it, and holds the subject\'s unique slot for ever');
  });

  it('at least one writer of each handled kind exists (the claim is not vacuous)', () => {
    for (const word of HANDLED) {
      assert.ok(Object.values(WRITERS).some(v => v.marker === word), `no writer is mapped as '${word}'`);
    }
  });
});

/*
 * Q-624 (design rev 4 sections 6 and 7, re-anchor table): the fork module is a NEW writer of the edges collection. A fork edge row is inserted under its own
 * derived id, never stamped (`_functionalGuard` locks a subject's slot, and a fork is not the subject), and the re-mint that re-points it onto a re-keyed
 * subject builds its row through the fork module and never through `rekeyedRow`, whose copy of `forkOf` and guard is the trap (reliability lens 3). So the
 * fork module's edge writers say `drop`: they remove the marker and write none. The rule is stated for the MODULE, not for one function name, because
 * the design names the re-mint and the keep-writer by what they do and not by an identifier.
 */
describe('the fork module writes edge rows and says it drops the functional guard', () => {
  const FORKS = 'server/src/brain/forks.ts';

  it('brain/forks.ts has at least one writer of the edges collection (the re-mint of a fork edge)', () => {
    const own = KEYS.filter(k => k.startsWith(`${FORKS}:`));
    assert.ok(own.length >= 1, `${FORKS} writes no edge row: there is no re-mint that inserts a fork edge under a derived id and removes the old one`);
  });

  it('every edge writer of the fork module is mapped as drop, and its body names the marker', () => {
    const own = KEYS.filter(k => k.startsWith(`${FORKS}:`));
    assert.ok(own.length >= 1, `${FORKS} writes no edge row`);
    const wrong = own.filter(k => WRITERS[k]?.marker !== 'drop').map(k => `${k} (${WRITERS[k]?.marker ?? 'no entry'})`);
    assert.deepEqual(wrong, [], 'a fork module writer of the edges collection must say `drop`: a fork row is never stamped, and one that carried its subject\'s marker would hold the subject\'s slot for ever');
    const silent = own.filter(k => !NAMES_THE_MARKER.test(INDEX.bodies.get(k)?.body ?? ''));
    assert.deepEqual(silent, [], 'these claim to drop the marker and never name it');
  });
});
