/**
 * Every function that writes a space's records or its file tree asks the write gate before its first write (bundle-106 PR A, X2, §2.6b).
 *
 * ## What the rule prevents
 *
 * The write gate (`assertSpaceTakesWrites`) was asked by the file door alone, and the first PR-A design closed three RIGHTS doors in front of
 * it — a list of guards, not the set of writers. The admin import (`sync/space-import.ts` → `writeArrivals`), an instance-admin token's
 * sync push and a `save_bulk` stage admitted just before the registration all reached the store through no guard, and the wipe then
 * deleted what they wrote. The rule is about the WRITERS: a function that issues a store write on a space collection a wipe covers
 * (or a file-system write under the space's tree) asks the gate before its first write, or is called only from functions that do.
 *
 * ## How the set is derived, and why it carries a floor
 *
 * The writers come from `_space-writers.mjs`, which resolves every mutator's receiver to the collection it names through aliases and
 * helpers; a covered writer is one whose receiver is a space collection in `COVERED` (a computed part counts: the commit's stage names its
 * collection from the plan kind), or a file-system write on the file tree. The derivation's own floors are asserted by `spaceWriters`; this
 * gate adds a floor on the writers it holds to the rule. A writer the index cannot attribute to a function (a mutator at module scope or in
 * a class method) FAILS the gate — it is not skipped (TS-13).
 *
 * ## Every per-space collection is covered or exempted by name (bundle-266, G1)
 *
 * `COVERED` was a name list, and a name list cannot see a collection nobody added to it: `schema_snapshots` (Q-735) was written by the
 * snapshot store, removed by the sweep (Q-739) and landed by the import (Q-740) without this gate ever looking at a writer of it. So the
 * per-space collections are DERIVED from the registry `SPACE_COLLECTIONS` (`db/space-collection.ts`), and each one is either `COVERED` or
 * a row of `EXEMPT_COLLECTIONS` with its reason; one in neither fails, and so does a row naming no collection the registry has. The
 * exemption table carries a floor, so emptying it into `COVERED` by hand is a visible change.
 *
 * Seen red (bundle-266, on 82208a6b, log b266-tests-g1-derivation.log): a scratch `server/src/spaces/zz-scratch-snapshot-writer.ts` whose one
 * function deletes from `snapshots(spaceId)` without asking is named by the case "every covered writer asks the gate". The first plant run
 * passed it: the derivation (`_space-writers.mjs`) resolved a concise-arrow helper only in the calling file, so a writer in its own module
 * opening the store's `snapshots(spaceId)` was `unknown` and checked by nothing - the snapshot sweep is such a writer. The derivation now
 * follows the helper's relative import. With `schema_snapshots` out of `COVERED` the same plant passes the writer case, and with it and
 * `file_hashes` out of the lists the derivation case names both.
 *
 * ## The exemptions, each with its reason, each failing when its file stops matching
 *
 * - the act bodies (`spaces/lifecycle.ts`, `spaces/rename.ts`): they ARE the act;
 * - the primitives under the file door (`files/stored-bytes.ts`, `files/remove-tree.ts`, `files/plaintext-file.ts`): `writeFile` and
 *   `writeFileBytes` ask before they reach them;
 * - housekeeping that cannot create or refill a record: the stray file-meta fill (`sync/fill-file-meta.ts`) and the TTL sweep's deletes
 *   (`brain/ttl-sweep.ts`).
 *
 * Anything else the derivation finds asks, or is reached only through a function that does, or the implementation adds a reasoned row here.
 *
 * ## Seen red
 *
 * On the base nothing but the file door asks, so every derived writer fails. After the implementation: remove the check from `writeArrivals`
 * (design §6.3 step 35), or add a scratch writer with no check — the writer list this gate prints names it.
 *
 * Run: `node --test testing/standalone/every-space-writer-asks-the-write-gate.test.js`
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { moduleIndex, callSitesIn } from './_call-graph.mjs';
import { spaceWriters } from './_space-writers.mjs';
import { ASKING_WRAPPERS } from './_space-write-askers.mjs';

const INDEX = moduleIndex('server/src');
// `files` was 40 until the space rename's two bare `fs.rename` calls became the one inside `moveTree` (`files/remove-tree.ts`, Q-171): two sites merged into one.
const WRITERS = spaceWriters(INDEX, { floors: { space: 150, alias: 65, files: 39 } });

/**
 * The per-space collections whose every writer asks the gate: the record families and their tombstones (an act lands, restores or empties
 * them), and the schema snapshots (an import lands them and the sweep removes them, Q-739/Q-740, so neither may run beside an act).
 */
const COVERED = new Set(['facts', 'entities', 'edges', 'chrono', 'links', 'files', 'tombstones', 'file_tombstones', 'schema_snapshots']);

/** The per-space collections a writer of which need not ask, each with its reason. Every other one of `SPACE_COLLECTIONS` is `COVERED`. */
const EXEMPT_COLLECTIONS = new Map([
  ['conflicts', 'a note that two copies of a record disagreed: written beside the arrival that raised it, it holds no record an act lands or restores'],
  ['dupe_candidates', 'a review finding derived from the records by the duplicate scanner: never landed or restored by an act, re-derived after one'],
  ['contradiction_candidates', 'a review finding derived from the records by the contradiction scanner: never landed or restored by an act, re-derived after one'],
  ['embed_jobs', 'the embedding work queue: what it names is re-derived from the records, and a job for a record an act removed finds nothing'],
  ['reindex_run', 'the reindex run\'s own progress row: bookkeeping of a derivation, no record'],
  ['media_jobs', 'the media derivation\'s work queue: re-derived from the file rows, and a job for a file an act removed finds nothing'],
  ['link_violations', 'the link checker\'s findings, derived from the records and re-derived after an act'],
  ['file_hashes', 'the content-hash index of the file rows, derived from the bytes; the files family it describes is COVERED'],
]);
/** The fewest exemption rows: the eight derived or bookkeeping collections of bundle-266. Fewer means a row was dropped, not that a collection became covered. */
const EXEMPT_COLLECTIONS_FLOOR = 8;

/** The per-space collection suffixes, read from the registry the server builds every space collection name from. */
const { SPACE_COLLECTIONS } = await import('../../server/dist/db/space-collection.js');

/** Files whose writers need no ask, and why. Each must still hold a writer (else the table is stale). */
const EXEMPT = new Map([
  ['server/src/spaces/lifecycle.ts', 'the act bodies: the removal and the wipe ARE the act'],
  ['server/src/files/stored-bytes.ts', 'a primitive beneath the file door, which asks before it reaches it'],
  ['server/src/files/remove-tree.ts', 'a primitive beneath the file door and the act bodies'],
  ['server/src/files/plaintext-file.ts', 'a primitive beneath the file door'],
  ['server/src/sync/fill-file-meta.ts', 'fills existing file rows from local stray state and creates nothing (P-41)'],
  ['server/src/brain/ttl-sweep.ts', 'the TTL sweep\'s deletes remove records and create or refill none'],
  ['server/src/files/feed-marker.ts', 'the feed-window purge the TTL sweep runs (bundle-255): it removes expired feed markers and creates or refills none'],
  // Housekeeping that only prunes, or updates rows that already exist (design v5 §2.6b, ruling R-P8): a row an act is removing
  // matches nothing once it is gone, so none of these can refill a space an act empties.
  ['server/src/brain/candidate-prune.ts', 'prunes review findings: deletes only'],
  ['server/src/brain/tombstone-prune.ts', 'prunes tombstones past their retention: deletes only'],
  ['server/src/brain/chrono-redaction.ts', 'redacts and stamps the expiry of chrono entries that exist: updates existing rows only'],
  ['server/src/brain/suppression-sweep.ts', 'removes vectors from records that exist: updates existing rows only'],
  ['server/src/sync/positions-owed.ts', 'gives rows that exist their position fields, once: updates existing rows only, and a restore calls it inside its own hold'],
  ['server/src/sync/positions-rollback.ts', 'the rollback tool: runs with no instance up, so there is no gate to ask; updates existing rows only'],
  ['server/src/sync/delivered-by-backfill.ts', 'stamps deliveredBy on records that exist, once: updates existing rows only'],
  ['server/src/files/leaked-rows-repair.ts', 'removes derived rows and links a deleted file left behind: deletes only'],
  ['server/src/files/retired-local-path-sweep.ts', 'removes what a retired writer left at a local-only path (legacy read spills, retired per-type schema files): deletes only'],
  ['server/src/files/move-markers.ts', 'updates and removes the move markers on file tombstones that exist: creates no row'],
  // Boot conversions, run before listen: an act standing then is resumed only AFTER listen and acts on what they wrote.
  ['server/src/brain/links-conversion.ts', 'the boot conversion of link arrays, run before listen; a standing act resumes after it'],
  ['server/src/db/drop-link-arrays.ts', 'the boot step that clears retired link arrays, run before listen: updates existing rows only'],
]);

/** The call that IS the check. */
const ASKS_DIRECTLY = /\bassertSpaceTakesWrites\s*\(/;
/** `ASKING_WRAPPERS` (`_space-write-askers.mjs`, shared with the fence gate): each must itself ask directly, before it runs the caller's body (held below). */
const ASKS = new RegExp(`${ASKS_DIRECTLY.source}|\\b(?:${ASKING_WRAPPERS.join('|')})\\s*\\(`);

/** Is this write a write of a family a wipe covers, or of the file tree? A computed collection part counts (the commit names its own). */
const isCovered = (s) => s.kind === 'files'
  || (s.kind === 'space' && !/ythril_counters/.test(s.why ?? '') && (!s.collection || COVERED.has(s.collection)));

/** The covered writer sites, grouped by the function that owns them. */
function coveredWriters() {
  const byKey = new Map();
  for (const s of WRITERS.sites) {
    if (!isCovered(s)) continue;
    if (!byKey.has(s.key)) byKey.set(s.key, []);
    byKey.get(s.key).push(s);
  }
  return byKey;
}

/** `key -> keys of the functions that call it`, over every body in the index. */
function callersOf() {
  const callers = new Map();
  for (const [key, entry] of INDEX.bodies) {
    if (entry.alias) continue;
    for (const call of new Set(callSitesIn(entry.body, { closures: true }).map(c => c.name))) {
      const target = INDEX.resolve(entry.file, call);
      if (!target || target === key) continue;
      if (!callers.has(target)) callers.set(target, new Set());
      callers.get(target).add(key);
    }
  }
  return callers;
}

/** Does `body` ask the gate before the first of `ops` (the writes the derivation attributed to it)? */
function asksBeforeFirstWrite(body, ops) {
  const ask = body.search(ASKS);
  if (ask < 0) return false;
  const firstWrite = Math.min(...ops.map(op => { const i = body.search(new RegExp(`(?:\\.|\\b)${op}\\s*[<(]`)); return i < 0 ? Infinity : i; }));
  return ask < firstWrite;
}

describe('every function that writes a space asks the write gate before its first write', () => {
  const writers = coveredWriters();
  const callers = callersOf();

  it('the derivation finds the writers (a floor) and none of them is a mutator no function owns', () => {
    assert.ok(writers.size >= 60, `only ${writers.size} covered writer function(s) found: the derivation is broken`);
    for (const key of ['server/src/sync/arrivals.ts:writeArrivals', 'server/src/brain/write-plan/commit.ts:writeStage',
      'server/src/brain/fact.ts:updateFact', 'server/src/brain/tombstones.ts:writeTombstones', 'server/src/files/file-meta.ts:upsertFileMeta']) {
      assert.ok(writers.has(key), `the derivation no longer finds ${key} among the writers`);
    }
    const orphans = WRITERS.orphans.filter(isCovered);
    assert.deepEqual(orphans.map(o => `${o.file}:${o.line} ${o.op}`), [], 'a space write that no function owns (module scope, a class method) is not skipped');
  });

  it('every covered writer asks the gate before its first write, or is called only from functions that do, or is a reasoned exemption', () => {
    const unguarded = [];
    /**
     * Is every road into `key` through a function that asks the gate — directly, or itself reached only through ones that do? The body of an
     * admitted writer is a private function its asking caller hands to the gate, so the road into a helper that body calls has two links.
     */
    const reachedOnlyThroughAskers = (key, seen = new Set()) => {
      if (seen.has(key)) return true;   // a cycle adds no road that did not already ask
      seen.add(key);
      const via = callers.get(key);
      return !!via && via.size > 0 && [...via].every(k => ASKS.test(INDEX.bodies.get(k)?.body ?? '') || reachedOnlyThroughAskers(k, seen));
    };
    for (const [key, sites] of writers) {
      const entry = INDEX.bodies.get(key);
      if (!entry || EXEMPT.has(entry.file)) continue;
      if (asksBeforeFirstWrite(entry.body, [...new Set(sites.map(s => s.op))])) continue;
      if (reachedOnlyThroughAskers(key)) continue;
      unguarded.push(key.replace('server/src/', ''));
    }
    assert.deepEqual(unguarded.sort(), [], `${unguarded.length} writer(s) of a space write without asking assertSpaceTakesWrites( first, or being reached only through one that does. `
      + 'Ask the gate in the writer (with its family), or add a reasoned exemption row to EXEMPT.');
  });

  it('the commit asks per STAGE and the arrival writer per CHUNK: the check is inside a loop in each, so a long write stops at its next unit', () => {
    for (const [key, loop] of [['server/src/brain/write-plan/commit.ts:commitPlans', /for\s*\(/], ['server/src/sync/arrivals.ts:writeArrivals', /for\s*\(/]]) {
      const body = INDEX.bodies.get(key)?.body;
      assert.ok(body, `${key} is gone`);
      const stage = INDEX.bodies.get('server/src/brain/write-plan/commit.ts:writeStage')?.body ?? '';
      const asksIn = ASKS.test(body) || (key.endsWith('commitPlans') && ASKS.test(stage));
      assert.ok(asksIn, `${key} (or its stage) does not ask the gate`);
      const at = (ASKS.test(body) ? body : stage).search(ASKS);
      const before = (ASKS.test(body) ? body : stage).slice(0, at);
      assert.match(before, loop, `${key} asks the gate outside any loop: it would not stop at its next unit`);
    }
  });

  it('every asking wrapper asks the gate (itself or through another wrapper) before it runs the body it was handed', () => {
    for (const name of ASKING_WRAPPERS) {
      const key = [...INDEX.bodies.keys()].find(k => k.endsWith(`:${name}`));
      assert.ok(key, `the wrapper ${name} is gone: a writer that goes through it asks nothing`);
      const body = INDEX.bodies.get(key).body;
      const ask = body.search(ASKS);
      assert.ok(ask >= 0, `${name} never asks the gate, directly or through another wrapper: every writer that goes through it is unguarded`);
      assert.ok(body.slice(0, ask).search(/\bbody\s*\(/) < 0, `${name} runs the caller's body before it asks the gate`);
    }
  });

  it('every per-space collection of the registry is COVERED or exempted with a reason, and no row names a collection the registry lacks', () => {
    const suffixes = Object.values(SPACE_COLLECTIONS);
    assert.ok(suffixes.length >= 17, `only ${suffixes.length} per-space collections in SPACE_COLLECTIONS: the registry moved`);
    const neither = suffixes.filter(s => !COVERED.has(s) && !EXEMPT_COLLECTIONS.has(s));
    assert.deepEqual(neither, [], 'a per-space collection is neither COVERED nor exempted: its writers are checked by nothing. Add it to COVERED, or a reasoned row to EXEMPT_COLLECTIONS');
    const both = suffixes.filter(s => COVERED.has(s) && EXEMPT_COLLECTIONS.has(s));
    assert.deepEqual(both, [], 'a collection is both COVERED and exempted');
    const known = new Set(suffixes);
    const stale = [...COVERED, ...EXEMPT_COLLECTIONS.keys()].filter(s => !known.has(s));
    assert.deepEqual(stale, [], 'a row names a collection SPACE_COLLECTIONS does not have');
    assert.ok(EXEMPT_COLLECTIONS.size >= EXEMPT_COLLECTIONS_FLOOR, `only ${EXEMPT_COLLECTIONS.size} exemption rows: one was dropped`);
    for (const [s, why] of EXEMPT_COLLECTIONS) assert.ok(why.length > 20, `the exemption of '${s}' gives no reason`);
  });

  it('the writers of schema snapshots are found, so the rule is asked of them', () => {
    // The store's writer (`ensureSnapshot`) names its collection through the `snapshots(spaceId)` helper: a derivation that resolved none of them
    // would hold the sweep and the import to nothing.
    const snapshotWriters = WRITERS.sites.filter(s => s.kind === 'space' && s.collection === 'schema_snapshots').map(s => s.key);
    assert.ok(snapshotWriters.includes('server/src/spaces/schema-snapshot-store.ts:ensureSnapshot'),
      `the derivation does not see ensureSnapshot write schema_snapshots: ${JSON.stringify([...new Set(snapshotWriters)])}`);
  });

  it('every exemption still names a file that holds a covered writer', () => {
    const files = new Set([...writers.keys()].map(k => INDEX.bodies.get(k)?.file));
    for (const [file, why] of EXEMPT) assert.ok(files.has(file), `the exemption for ${file} (${why}) matches no covered writer: remove it`);
  });
});
