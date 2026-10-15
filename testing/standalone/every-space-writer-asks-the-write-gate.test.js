/**
 * Every function that writes a space's records or its file tree asks the write gate before its first write (bundle-106 PR A, X2, §2.6b).
 *
 * ## What the rule prevents
 *
 * The write gate (`assertSpaceTakesWrites`) was asked by the file door alone, and the first PR-A design closed three RIGHTS doors in front of
 * it — a list of guards, not the set of writers. The admin import (`api/admin-import.ts` → `writeArrivals`), an instance-admin token's
 * sync push and a `save_bulk` stage admitted just before the registration all reached the store through no guard, and the wipe then
 * deleted what they wrote. The rule is about the WRITERS: a function that issues a store write on a space collection a wipe covers
 * (or a file-system write under the space's tree) asks the gate before its first write, or is called only from functions that do.
 *
 * ## How the set is derived, and why it carries a floor
 *
 * The writers come from `_space-writers.mjs`, which resolves every mutator's receiver to the collection it names through aliases and
 * helpers; a covered writer is one whose receiver is a space collection of a family a wipe covers (a computed part counts: the commit's
 * stage names its collection from the plan kind), or a file-system write on the file tree. The derivation's own floors are asserted by
 * `spaceWriters`; this gate adds a floor on the writers it holds to the rule. A writer the index cannot attribute to a function (a
 * mutator at module scope or in a class method) FAILS the gate — it is not skipped (TS-13).
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

const INDEX = moduleIndex('server/src');
const WRITERS = spaceWriters(INDEX, { floors: { space: 150, alias: 65, files: 40 } });

/** The families a wipe covers, and their tombstones — the collection suffixes a covered write names. */
const COVERED = new Set(['facts', 'entities', 'edges', 'chrono', 'links', 'files', 'tombstones', 'file_tombstones']);

/** Files whose writers need no ask, and why. Each must still hold a writer (else the table is stale). */
const EXEMPT = new Map([
  ['server/src/spaces/lifecycle.ts', 'the act bodies: the removal and the wipe ARE the act'],
  ['server/src/spaces/rename.ts', 'the act body: the rename moves the data'],
  ['server/src/files/stored-bytes.ts', 'a primitive beneath the file door, which asks before it reaches it'],
  ['server/src/files/remove-tree.ts', 'a primitive beneath the file door and the act bodies'],
  ['server/src/files/plaintext-file.ts', 'a primitive beneath the file door'],
  ['server/src/sync/fill-file-meta.ts', 'fills existing file rows from local stray state and creates nothing (P-41)'],
  ['server/src/brain/ttl-sweep.ts', 'the TTL sweep\'s deletes remove records and create or refill none'],
]);

const ASKS = /\bassertSpaceTakesWrites\s*\(/;

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
    for (const [key, sites] of writers) {
      const entry = INDEX.bodies.get(key);
      if (!entry || EXEMPT.has(entry.file)) continue;
      if (asksBeforeFirstWrite(entry.body, [...new Set(sites.map(s => s.op))])) continue;
      const via = callers.get(key);
      if (via && via.size > 0 && [...via].every(k => ASKS.test(INDEX.bodies.get(k)?.body ?? ''))) continue;
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

  it('every exemption still names a file that holds a covered writer', () => {
    const files = new Set([...writers.keys()].map(k => INDEX.bodies.get(k)?.file));
    for (const [file, why] of EXEMPT) assert.ok(files.has(file), `the exemption for ${file} (${why}) matches no covered writer: remove it`);
  });
});
