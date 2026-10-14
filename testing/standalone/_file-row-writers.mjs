/**
 * Which functions write a space's file rows or its media jobs, and who calls whom — the question the three claim-fence gates ask
 * (bundle-44 D-29, Q-436), answered once.
 *
 * ## Why a module
 *
 * `every-creator-of-a-derived-row-holds-the-claim`, `every-write-a-media-job-makes-about-its-file-is-under-its-claim` and
 * `every-remover-of-file-rows-revokes-claims-first` each need the call graph of `server/src`, the sites that write the `files` and
 * `media_jobs` collections, and the calls (with their positions) that reach a function. A gate that derived them for itself would
 * derive them differently from the next, and the difference is where a subject goes unread.
 *
 * ## The guards a hand-written copy drops
 *
 * **The subjects are found by what code DOES, never by a property the fix introduces.** A writer of file rows is a function with a
 * `deleteMany`/`replaceOne`/... on the space's `files` collection (`_space-writers.mjs`, which resolves aliases), not a function
 * that takes a `claim`: derived from the claim, the set at the unchanged code would be empty and every gate would pass about code
 * it never read. **The floors**: an index that parses nothing, or a writer set that finds nothing, passes every loop written over
 * it, so each derivation throws below the count it had when it was written.
 *
 * It does not decide any rule: what a gate asserts about the sites is the gate's.
 */
import assert from 'node:assert/strict';
import { moduleIndex, callSitesIn, memberCallSitesIn, reachableFrom } from './_call-graph.mjs';
import { spaceWriters } from './_space-writers.mjs';
import { MUTATORS } from './_document-mutators.mjs';
import { argumentsOf } from './_structural-window.mjs';
import { recordWrites } from './_record-writes.mjs';
import { fileRowWrites } from './_processing-state-writes.mjs';

const { BRAIN_COLLECTIONS } = await import('../../server/dist/config/types.js');

/** The one module that creates a derived row. */
export const DERIVED_FIELDS = 'server/src/files/derived-fields.ts';
/** The module that revokes and fences a media job's claim. */
export const LEASE = 'server/src/files/media/lease.ts';

let built;

/** The call graph of `server/src` and every space write site in it, built once per process. */
export function sourceTree() {
  if (built) return built;
  const INDEX = moduleIndex('server/src');
  const WRITERS = spaceWriters(INDEX, { floors: { space: 150 } });

  /** `callersOf.get(key)`: every call of `key`, as `{ from, name, at }` — `at` an offset into `from`'s body. */
  const callersOf = new Map();
  const add = (target, from, name, at) => {
    if (!target || target === from) return;
    if (!callersOf.has(target)) callersOf.set(target, []);
    callersOf.get(target).push({ from, name, at });
  };
  for (const [key, entry] of INDEX.bodies) {
    if (entry.alias) continue;
    for (const c of callSitesIn(entry.body, { closures: true })) add(INDEX.resolve(entry.file, c.name), key, c.name, c.at);
    for (const c of memberCallSitesIn(entry.body, { closures: true })) add(INDEX.resolveMember(entry.file, c.obj, c.prop), key, `${c.obj}.${c.prop}`, c.at);
  }
  assert.ok(callersOf.size >= 300, `only ${callersOf.size} function(s) are called by another — the call graph is broken, not the code`);
  built = { INDEX, WRITERS, callersOf };
  return built;
}

/**
 * The write sites on the space collection `suffix` (`files`, `media_jobs`), each `{ key, file, op, ... }`.
 *
 * A write whose collection is computed (`${spaceId}_${COLLECTION[recordType]}`) is included only with `includeComputed`: it may be any
 * record kind, so a gate that asks "does this reach the store" holds it to the rule rather than guessing it away (the one computed-name
 * writer of a files collection is `writeDerivedFields` in `derived-fields.ts`).
 */
export function writesTo(suffix, { floor = 1, includeComputed = false } = {}) {
  const { WRITERS } = sourceTree();
  const sites = WRITERS.sites.filter(s => s.kind === 'space' && (s.collection === suffix || (includeComputed && s.collection == null)));
  assert.ok(sites.length >= floor, `only ${sites.length} write site(s) on the space's ${suffix} collection found, below the floor of ${floor}: the derivation is broken, not the code`);
  return sites;
}

/**
 * Every write to a files collection with the text of its arguments (`_processing-state-writes.mjs`), including the one whose
 * collection name is computed: it may be the files collection, so a gate holds it to the rule rather than guessing it away.
 */
export function fileRowWritesOfTree() {
  const { INDEX } = sourceTree();
  const records = recordWrites(INDEX, { collections: BRAIN_COLLECTIONS, floors: { space: 150 }, recordFloor: 50 });
  return fileRowWrites(INDEX, records, { includeComputed: true });
}

/** Every key `from` reaches by calls, itself included. */
export function reaches(from) {
  return reachableFrom(sourceTree().INDEX, [from]);
}

/** The positioned calls in `body` of any of `names`, as `{ name, at }`, in source order. */
export function callsOfAny(body, names) {
  const wanted = new Set(names);
  return callSitesIn(body, { closures: true }).filter(c => wanted.has(c.name)).map(c => ({ name: c.name, at: c.at }));
}

const MUTATOR_CALL = new RegExp(`\\.\\s*(${MUTATORS.join('|')})\\s*(?:<[^>(]*>)?\\s*\\(`, 'g');

/**
 * Every call that REMOVES or FLAGS the rows of a space's `files` collection — a `deleteOne`/`deleteMany`/`findOneAndDelete`, or an
 * update that sets `deletedAt` — with its offset into the function's body: `{ key, file, fn, op, at }`.
 *
 * Found where the receiver resolves to the literal `files` collection (`_space-writers.mjs`), never by the function's name: the
 * removers are whatever deletes or flags file rows, including the ones nobody thought of as "the delete".
 */
export function removalsOfFileRows({ floor = 8 } = {}) {
  const { INDEX, WRITERS } = sourceTree();
  const out = [];
  for (const [key, entry] of INDEX.bodies) {
    if (entry.alias) continue;
    const sites = (WRITERS.byKey.get(key) ?? []).filter(s => MUTATORS.includes(s.op));
    if (!sites.some(s => s.kind === 'space' && s.collection === 'files')) continue;
    const matches = [...entry.body.matchAll(MUTATOR_CALL)];
    assert.ok(matches.length >= sites.length, `${key}: the index holds ${sites.length} mutator site(s) and the body only ${matches.length} call(s) — the pairing is broken`);
    matches.forEach((m, i) => {
      const site = sites[i];
      if (!site || site.kind !== 'space' || site.collection !== 'files') return;
      assert.equal(site.op, m[1], `${key}: mutator #${i + 1} of the body is '${m[1]}' and the index says '${site.op}' — the pairing is broken`);
      const args = argumentsOf(entry.body, m.index + m[0].length - 1, `${key} ${m[1]}`).join(', ');
      const removes = /^(?:deleteOne|deleteMany|findOneAndDelete)$/.test(m[1])
        || (/^(?:updateOne|updateMany|findOneAndUpdate)$/.test(m[1]) && /\$set\s*:\s*\{[^}]*\bdeletedAt\b|\bflagAndStrip\b/.test(args));
      if (removes) out.push({ key, file: entry.file, fn: entry.name, op: m[1], at: m.index });
    });
  }
  assert.ok(out.length >= floor, `only ${out.length} removal(s) of file rows found, below the floor of ${floor}: the derivation is broken, not the code`);
  return out;
}
