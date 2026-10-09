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
  'server/src/brain/merge.ts:relinkAndAbsorb':
    { marker: 'drop', why: 'a merge relinks from/to: the re-key drops the marker and the in-place relink only $unsets it, so a merge never fails on it' },
  'server/src/sync/arrivals.ts:writeArrivals':
    { marker: 'carry-if-unchanged', why: 'a peer arrival never brings a marker; the replacement keeps this instance\'s own only while from and label are the stored ones' },

  'server/src/files/derived-fields.ts:writeDerivedFields': { marker: 'none-by-design', why: 'the embed job\'s write of derived fields onto a record already written; it refuses any hashed key, so from and label are never touched, and the marker is not derived so it is never unset' },
  'server/src/brain/suppression-sweep.ts:sweepSuppressedVectors': { marker: 'none-by-design', why: 'removes vectors only' },
  'server/src/brain/tombstones.ts:removeWithTombstones': { marker: 'none-by-design', why: 'a delete frees the marker with the row' },
  'server/src/spaces/lifecycle.ts:wipeSpace': { marker: 'none-by-design', why: 'the space wipe deletes every row, markers included' },
  'server/src/sync/tombstone-apply.ts:applyPeerTombstones': { marker: 'none-by-design', why: 'a peer\'s tombstone is a delete' },
  'server/src/sync/delivered-by-backfill.ts:stampCollection': { marker: 'none-by-design', why: 'stamps who delivered a row; from, label and the marker are untouched' },
  'server/src/brain/candidate-prune.ts:pruneCandidateCollection': { marker: 'none-by-design', why: 'prunes candidate rows; the collection name is computed and is not edges' },
  'server/src/brain/chrono-redaction.ts:backfillTypedExpiry': { marker: 'none-by-design', why: 'chrono entries; the collection name is computed' },
  'server/src/db/drop-link-arrays.ts:dropLinkArrays': { marker: 'none-by-design', why: 'boot migration of the retired link arrays' },
  'server/src/db/rekey-memory-kind-to-fact.ts:rekeyMemoryKindToFact': { marker: 'none-by-design', why: 'boot migration of the memory kind' },
  'server/src/db/restore.ts:restoreDatabase': { marker: 'none-by-design', why: 'a whole-database dump restored verbatim: every marker comes back with the from and label it was written with, and the index is rebuilt after' },
  'server/src/spaces/_shared.ts:repairStaleSpaceIds': { marker: 'none-by-design', why: 'rewrites a stale spaceId field in every collection' },
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
