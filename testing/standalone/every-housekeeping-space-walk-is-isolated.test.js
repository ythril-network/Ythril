/**
 * Every per-space loop that runs outside a request is isolated and bounded by the walk runner — or says why it is not (`Q-274`,
 * `Q-358`, bundle-53 G25).
 *
 * ## The defect, and why a rule about the loops is the only thing that keeps it fixed
 *
 * A timer, a boot step or a job worker that walks the spaces had to answer two questions by hand: *what if one space fails?* and *what if
 * one operation hangs?* It answered the first six different ways (`catch { continue; }`, no catch at all, a catch that returned out of the
 * loop, a catch that logged on every pass) and the second not at all. `util/housekeeping-walk.ts` answers both, once: `eachSpace` /
 * `walkSpaces` / `claimAcross` isolate a space's failure, bound every database operation its callback issues, ask one verdict and report
 * once. That is true only of a loop that goes THROUGH it, and nothing made the next loop do so. This is the thing that does.
 *
 * ## What it holds, each derived from the tree
 *
 * 1. **The roots are every way work starts outside a request** (`_housekeeping-walks.mjs` `housekeepingRoots`): every `intervalJob(…)` and
 *    cron registration (`_scheduled-jobs.mjs`, the run followed by reference too — `_call-graph.mjs` `intervalJobRuns`), what boot calls,
 *    the `afterListening(…)` closures and the `runSlotPool(…)` option objects. Each form has a FLOOR, and each `intervalJob(` call site yields
 *    a root or is named in {@link UNFOLLOWABLE_RUNS}: a run passed as something this cannot follow is a job nothing reads.
 * 2. **A subject is a loop that iterates spaces and reaches a space's data** (`spaceLoopsIn`): its header names the spaces, or it hands its
 *    variable to a `space…` parameter whatever the iterable is called — and a per-space primitive (`spaceCollection`, a `${id}_…` name,
 *    `spaceRoot`, `chunksRoot`) is reached, directly or through any function that reaches one.
 * 3. **Every subject sits inside a walk**, i.e. it is NOT reachable from a root except through a walk callback. The walk is computed over the
 *    code with every walk callback blanked, so a loop that was moved into `eachSpace` leaves the set and a loop that is written beside it
 *    enters it. A subject outside a walk is a finding unless {@link SUBJECT_EXEMPTIONS} names it with a reason.
 * 4. **The shape rule.** A catch inside a subject loop neither returns from nor rethrows out of the loop — the spelling that LOOKS isolated
 *    and ends the loop at the first space that fails (`T3`).
 * 5. **No `outsideWriteBound(` inside a walk callback** unless a row says why: it steps out of the very scope the walk put the operation in.
 * 6. **Every database reacher inside a walk is bounded, or is a named exemption.** The set is read from the driver's tables
 *    (`COLLECTION_METHOD_EFFECT`, `DB_METHOD_EFFECT`, `BOUNDED_OPTIONS_ARGUMENT`, `BOUNDED_DB_OPTIONS_ARGUMENT`, `UNBOUNDED_DB_METHODS`): a
 *    driver method that nothing bounds and that a walk calls needs a row with a `why`. The index calls, `createCollection` and the
 *    arbitrary `command` are the rows; the raw client's `admin` ping carries its own `timeoutMS`.
 * 7. **A call that is not a database operation says so.** A model or network call inside a walk is not ended by the housekeeping figure;
 *    it carries an abort signal of its own, and the row says which — checked in the function's text, so a row cannot outlive the signal.
 * 8. **It really is bounded.** Behaviour on the built runner: inside an `eachSpace` callback a read carries `timeoutMS` = the housekeeping
 *    figure, a `listCollections` carries it through the one door, and inside a `claimAcross` claim a plain write carries `CLAIM_OP_MS`.
 *
 * ## What it does NOT conclude, stated so the title does not claim more than the body
 *
 * - It reads loops it can name: a `for` / `while`, `.map` / `.forEach` / `.flatMap` and `mapLimit`. A recursion, a `reduce`, an event handler
 *   that walks the spaces on each event, or a space list iterated by an index (`for (let i …)`) with no `space…` parameter in the header or
 *   the call, is not read. The fixture cases pin what is.
 * - It does not bound a wait that is not a database operation (a directory walk, a DNS lookup): item 7 asks for a signal on a network call
 *   and no more.
 * - A per-space loop in a REQUEST is not a subject: no root reaches it.
 *
 * ## Seen red
 *
 * By hand, put back by hand: a moved site unwrapped to a bare loop; a `return` in a catch of a subject loop; the scope removed from
 * `eachSpace`; removed from `claimAcross`; `listCollections` dropped from the Db table; a run passed by a member expression.
 *
 * Run: node --test testing/standalone/every-housekeeping-space-walk-is-isolated.test.js   (after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { moduleIndex, indexSources, intervalJobRuns, withoutNestedClosures } from './_call-graph.mjs';
import { scheduledJobs, JOB_FLOORS } from './_scheduled-jobs.mjs';
import {
  walkEntryNames, walkRunnerKeys, housekeepingRoots, reachOutsideWalks, insideWalks, spaceReachers, spaceLoopsIn, catchesIn,
} from './_housekeeping-walks.mjs';

const wb = await import('../../server/dist/db/write-bound.js');
const observer = await import('../../server/dist/db/record-write-observer.js');
const { createHousekeepingWalk } = await import('../../server/dist/util/housekeeping-walk.js');
const { createWorkSignal } = await import('../../server/dist/util/work-signal.js');

/** An `intervalJob(` call whose run this gate cannot follow: `file:label` -> why it is acceptable. Empty on purpose. */
const UNFOLLOWABLE_RUNS = new Map();

/**
 * Loops that iterate spaces outside a walk, each with the reason that is its whole argument. A row is by function and loop header, never
 * by line, and it must match a subject that exists (a row outliving its loop fails).
 */
const SUBJECT_EXEMPTIONS = [
  {
    key: 'server/src/spaces/lifecycle.ts:initAllSpaces', head: /spaceIds/,
    why: 'Boot initialisation. A space that cannot be initialised MUST stop the boot (nothing serves a half-built space), so the loop does not '
      + 'isolate a failure by design; it is awaited before the server listens, so no tick can stack behind it. The background confirmation it '
      + 'starts is a walk.',
  },
  {
    key: 'server/src/files/at-rest-migration.ts:runAtRestMigration', head: /spaceId of spaces/,
    why: 'A one-shot boot migration over DIRECTORIES (no collection), isolated per FILE (a failed file is counted and the pass goes on), with a '
      + 'stop of its own for a full disk. It reads the file tree, which no database bound can end, and it is not a repeating job.',
  },
  {
    key: 'server/src/sync/engine.ts:runSyncForMember', head: /net\.spaces/,
    why: 'The sync cycle of one member over the network\'s spaces: its own question (a failed space makes the member\'s cycle incomplete and is '
      + 'reported in the cycle\'s result, push and pull are bounded by the fetch options), not a housekeeping walk. The plan names the sync '
      + 'engine\'s per-member per-space loop as outside Q-274.',
  },
];

/** A `catch` body that is not a loop's own per-unit isolation is judged by the shape rule only where it sits in a subject. */
const RETURN_OR_THROW = /\b(?:return|throw)\b/;

/** `outsideWriteBound(` inside a walk callback: file -> why. */
const OUTSIDE_BOUND_EXEMPTIONS = [
  {
    file: 'server/src/db/drop-link-arrays.ts',
    why: 'A whole-collection `updateMany` that clears the retired link arrays: it scales with the collection, so the per-operation housekeeping '
      + 'figure would end a healthy run on a large space. It is a boot migration whose space is marked done only after it, and a space it did '
      + 'not finish is retried at the next boot (the walk reports it).',
  },
];

/**
 * Driver methods nothing bounds that a walk may call: `methods` (and the files, when given) -> why. A method of the driver that no table
 * bounds and that is not named here is a finding; a row whose method no walk calls any more is a finding too.
 */
const UNBOUNDED_CALL_EXEMPTIONS = [
  {
    methods: ['createIndex', 'createIndexes', 'dropIndex', 'dropIndexes', 'listIndexes', 'indexExists', 'indexInformation', 'indexes',
      'listSearchIndexes', 'createSearchIndex', 'createSearchIndexes', 'dropSearchIndex', 'updateSearchIndex'],
    why: 'An index build, a listing of a collection\'s indexes and a search-index change scale with the data in the collection, so no one figure '
      + 'is right for every collection (db/write-bound.ts states the rule); a walk that creates indexes confirms them instead of ending them.',
  },
  {
    methods: ['createCollection'], files: ['server/src/spaces/lifecycle.ts'],
    why: 'Space initialisation: a one-off metadata change when a collection is first made, not repeated work of a housekeeping unit.',
  },
  {
    methods: ['command'], files: ['server/src/db/store-answers.ts'],
    why: 'The raw client\'s `admin` ping that answers "does the store answer at all?": it is the question a bound that ended asks, so it carries '
      + 'its own `timeoutMS` (3 s) and is never inside a scope; it writes nothing.',
  },
  {
    methods: ['command'], files: ['server/src/db/write-bound.ts'],
    why: 'The bound\'s own mechanism: after the backstop it finds the database\'s operation by its comment and kills it. It is how a bound ends, so '
      + 'it cannot be inside one.',
  },
];

/** Model and network calls a walk reaches: function key -> why it is not ended by the housekeeping figure. Each must carry its own signal. */
const NETWORK_CALL_EXEMPTIONS = [
  { key: 'server/src/brain/nli-client.ts:classify', why: 'The contradiction judge: a model call, not a database operation. Its own `AbortSignal.timeout(slot)` ends it.' },
  { key: 'server/src/brain/dupe-scanner.ts:fireNotify', why: 'The duplicate notification POST: a network call, not a database operation. Its own `AbortSignal.timeout(NOTIFY_TIMEOUT_MS)` ends it.' },
  { key: 'server/src/brain/embedding.ts:embedViaHttp', why: 'The embedding provider call: a model call, not a database operation. Its own `AbortSignal.timeout(slot)` ends it.' },
  { key: 'server/src/webhooks/dispatcher.ts:attemptDelivery', why: 'A webhook delivery: a network call, not a database operation. Its own abort controller (`DELIVERY_TIMEOUT_MS`) ends it.' },
];
const OWN_SIGNAL = /AbortSignal\.timeout\(|\.abort\(\)|\bsignal\b/;

const NETWORK_CALL = /(?<![\w$.])(?:fetch|ssrfSafeFetch|modelFetch)\s*\(/;

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
//   the analysis: one function, over any index, so the fixtures below run the same code as the tree
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Subjects outside a walk: every space-iterating loop that reaches a space's data, in code a root reaches without a walk callback. */
function subjectsOutsideWalks(index, roots, names) {
  const { blanked, seen } = reachOutsideWalks(index, roots, names);
  const reachers = spaceReachers(index);
  const subjects = [];
  for (const key of [...seen].sort()) {
    const entry = blanked.bodies.get(key);
    if (!entry) continue;
    for (const s of spaceLoopsIn(index, entry, reachers)) if (s.reaches) subjects.push({ key, ...s });
  }
  return { subjects, seen, blanked };
}

const headOf = (loop) => loop.head.replace(/\s+/g, ' ').slice(0, 100);

/** Does this subject's catch end the loop it sits in? */
function catchEndsTheLoop(loop) {
  return catchesIn(loop.body).some(c => RETURN_OR_THROW.test(withoutNestedClosures(c.body)));
}

const index = moduleIndex('server/src');
const NAMES = walkEntryNames(index);
const { jobs, found } = scheduledJobs(index);
const roots = housekeepingRoots(index, jobs);
const outside = subjectsOutsideWalks(index, roots, NAMES);
const inside = insideWalks(index, NAMES, walkRunnerKeys(index));   // the runner's own work (its ping) is part of every walk

describe('the derivation reads the tree it claims to', () => {
  it('derives the walk entry names from the runner, with a floor', () => {
    for (const n of ['eachSpace', 'walkSpaces', 'eachUnit', 'claimAcross']) assert.ok(NAMES.has(n), `${n} is not derived as a walk entry: ${[...NAMES]}`);
  });

  it('finds every scheduled job and a root for each (a run it cannot follow is named, never dropped)', () => {
    for (const [kind, floor] of Object.entries(JOB_FLOORS)) assert.ok(found[kind] >= floor, `${kind}: ${found[kind]} < ${floor}`);
    const unfollowable = jobs.filter(j => j.how === 'unfollowable' && !UNFOLLOWABLE_RUNS.has(`${j.file}:${j.label}`));
    assert.deepEqual(unfollowable.map(j => `${j.file}: intervalJob(${j.label}, …, ${j.run.slice(0, 40)}) — a run that cannot be followed`), [],
      'a job whose run the call graph cannot follow is a job no gate reads: pass the run as a closure or a named function, or name it in UNFOLLOWABLE_RUNS with a reason');
    const rooted = roots.filter(r => (r.form === 'interval' || r.form === 'cron') && r.key).length;
    assert.equal(rooted, jobs.length - jobs.filter(j => UNFOLLOWABLE_RUNS.has(`${j.file}:${j.label}`)).length,
      'a scheduled job yields no root');
  });

  it('every start form is a root, each above its floor', () => {
    const forms = new Set(roots.map(r => r.form));
    for (const f of ['interval', 'cron', 'boot', 'after-listening', 'slot-pool']) assert.ok(forms.has(f), `no '${f}' roots`);
  });

  it('the reach is not thin: well over the roots, and it contains the walks\' callees', () => {
    assert.ok(outside.seen.size > roots.length * 2, `only ${outside.seen.size} function(s) reached from ${roots.length} root(s): the call graph walk is broken`);
    assert.ok(inside.callbacks.length >= 20, `only ${inside.callbacks.length} walk callback(s) found: the walk-call scan is broken`);
  });

  it('a `void worker()` started at boot is reached', () => {
    const started = [];
    for (const r of roots.filter(x => x.form === 'boot')) {
      const entry = index.bodies.get(r.key);
      for (const m of entry.body.matchAll(/\bvoid\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
        const key = index.resolve(entry.file, m[1]);
        if (key) started.push(key);
      }
    }
    assert.ok(started.length >= 2, `only ${started.length} \`void x()\` start(s) found in the boot roots`);
    for (const key of started) assert.ok(outside.seen.has(key), `${key} is started at boot with \`void\` and is reached by no root`);
  });
});

describe('every per-space loop a root reaches is inside a walk, or is named', () => {
  it('the subjects the tree really has are found (floor), so an exemption table is not the whole answer', () => {
    // Each exempt loop below is a subject: if the derivation stopped finding loops these would vanish and every gate below would pass.
    const exempt = outside.subjects.filter(s => SUBJECT_EXEMPTIONS.some(e => e.key === s.key));
    assert.ok(exempt.length >= SUBJECT_EXEMPTIONS.length, `only ${exempt.length} of ${SUBJECT_EXEMPTIONS.length} named subject loops were found`);
  });

  it('no space-iterating loop outside a walk, except the named ones', () => {
    const offenders = outside.subjects
      .filter(s => !SUBJECT_EXEMPTIONS.some(e => e.key === s.key && e.head.test(s.loop.head)))
      .map(s => `${s.key}: ${s.loop.kind} ${headOf(s.loop)}`);
    assert.deepEqual(offenders, [],
      'a loop over the spaces runs outside `eachSpace` / `walkSpaces` / `claimAcross`, so one failing space ends it and one hung operation holds it. '
      + 'Move it into the walk (`util/housekeeping-walk.ts`); the only exceptions are SUBJECT_EXEMPTIONS rows, each with its reason.');
  });

  it('every exemption still names a loop that exists', () => {
    const stale = SUBJECT_EXEMPTIONS.filter(e => !outside.subjects.some(s => s.key === e.key && e.head.test(s.loop.head))).map(e => `${e.key} ${e.head}`);
    assert.deepEqual(stale, [], 'an exemption outliving its loop is a suppression the next loop of that name inherits');
    for (const e of SUBJECT_EXEMPTIONS) assert.ok(e.why.length > 60, `${e.key}: the reason is not an argument`);
  });

  it('a catch in a space loop neither returns from nor rethrows out of it (the shape that reads as isolated and is not)', () => {
    const offenders = outside.subjects.filter(s => catchEndsTheLoop(s.loop)).map(s => `${s.key}: ${s.loop.kind} ${headOf(s.loop)}`);
    assert.deepEqual(offenders, [], 'a per-unit catch that returns or throws ends the whole loop at the first space that fails');
  });

  it('every intervalJob run that is a closure or a reference is read by the walk, whichever it is written as', () => {
    const runs = intervalJobRuns(index);
    assert.ok(runs.length >= JOB_FLOORS.interval, `only ${runs.length} intervalJob registrations`);
    assert.ok(runs.some(r => r.how === 'reference') && runs.some(r => r.how === 'closure'), 'the derivation sees only one spelling of a run');
  });
});

describe('what runs inside a walk is bounded, or says why not', () => {
  it('no `outsideWriteBound(` inside a walk callback but the named one', () => {
    const hits = inside.callbacks
      .filter(k => /\boutsideWriteBound\s*\(/.test(index.bodies.get(k).body))
      .map(k => index.bodies.get(k).file);
    assert.ok(hits.length >= 1, 'no outsideWriteBound inside a walk callback was found: the scan is broken (drop-link-arrays has one)');
    const unnamed = hits.filter(f => !OUTSIDE_BOUND_EXEMPTIONS.some(e => e.file === f));
    assert.deepEqual(unnamed, [], 'a walk callback steps out of the scope the walk bounded it in');
    const stale = OUTSIDE_BOUND_EXEMPTIONS.filter(e => !hits.includes(e.file)).map(e => e.file);
    assert.deepEqual(stale, [], 'an outsideWriteBound exemption no walk uses any more');
  });

  /** The driver methods no table bounds, read from the tables themselves. */
  function unboundedDriverMethods() {
    const builtin = new Set([Array, Map, Set, String, Object, Function, Promise, Date, Number, RegExp, Uint8Array]
      .flatMap(c => Object.getOwnPropertyNames(c.prototype)));
    for (const name of [...Object.keys(fs), ...Object.keys(fs.promises)]) builtin.add(name);
    const collection = Object.keys(observer.COLLECTION_METHOD_EFFECT).filter(m => !builtin.has(m));
    const db = Object.keys(observer.DB_METHOD_EFFECT).filter(m => !builtin.has(m));
    assert.ok(collection.length >= 25 && db.length >= 10, `the driver's method tables read as ${collection.length} / ${db.length}`);
    // A Db method the observer explains as "returns a handle and sends nothing" sends no operation, so it needs no row.
    const handleOnly = db.filter(m => /returns a handle and sends nothing/.test(observer.UNBOUNDED_DB_METHODS[m] ?? '') && !(m in observer.COLLECTION_METHOD_EFFECT));
    assert.ok(handleOnly.length >= 2, 'the handle-only Db methods were not read from the observer\'s reasons');
    const unbounded = new Set();
    for (const m of collection) {
      const dbLevelBounded = m in observer.DB_METHOD_EFFECT && wb.BOUNDED_DB_OPTIONS_ARGUMENT[m] !== undefined;
      if (wb.BOUNDED_OPTIONS_ARGUMENT[m] === undefined && !dbLevelBounded) unbounded.add(m);
    }
    for (const m of db) {
      if (handleOnly.includes(m) || wb.BOUNDED_DB_OPTIONS_ARGUMENT[m] !== undefined) continue;
      const collectionBounded = m in observer.COLLECTION_METHOD_EFFECT && wb.BOUNDED_OPTIONS_ARGUMENT[m] !== undefined;
      if (!collectionBounded) unbounded.add(m);
    }
    return unbounded;
  }

  it('every driver method nothing bounds that a walk calls is a named exemption, and every exemption is still called', () => {
    const unbounded = unboundedDriverMethods();
    assert.ok(unbounded.has('createIndex') && unbounded.has('listSearchIndexes') && unbounded.has('command'),
      'the unbounded set lost the index calls or `command`: it is read wrong');
    const pattern = new RegExp(`\\.\\s*(${[...unbounded].join('|')})\\s*(?:<[^>(]*>)?\\(`, 'g');
    const hits = [];
    for (const key of inside.seen) {
      const entry = index.bodies.get(key);
      for (const m of entry.body.matchAll(pattern)) hits.push({ key, file: entry.file, method: m[1] });
    }
    assert.ok(hits.length >= 10, `only ${hits.length} unbounded driver call(s) found in what the walks reach: the scan is broken`);
    const covered = (h, row) => row.methods.includes(h.method) && (!row.files || row.files.includes(h.file));
    const unnamed = [...new Set(hits.filter(h => !UNBOUNDED_CALL_EXEMPTIONS.some(r => covered(h, r))).map(h => `${h.file}: .${h.method}() in ${h.key.replace(/^.*:/, '')}`))];
    assert.deepEqual(unnamed, [], 'a walk calls a driver method no table bounds and no row excuses: bound it (db/write-bound.ts) or add a row with its reason');
    const stale = UNBOUNDED_CALL_EXEMPTIONS.filter(r => !hits.some(h => covered(h, r))).map(r => `${r.methods.join('/')} ${r.files ?? ''}`);
    assert.deepEqual(stale, [], 'an exemption for a call no walk makes any more');
    for (const r of UNBOUNDED_CALL_EXEMPTIONS) {
      assert.ok(r.why.length > 60, `${r.methods}: the reason is not an argument`);
      for (const m of r.methods) assert.ok(unbounded.has(m), `${m} is excused but is bounded (or not a driver method): drop it from the row`);
    }
  });

  it('a model or network call a walk reaches carries its own abort signal, and is named', () => {
    const hits = [];
    for (const key of inside.seen) {
      const entry = index.bodies.get(key);
      if (!entry.synthetic && NETWORK_CALL.test(entry.body)) hits.push(key);
    }
    assert.ok(hits.length >= 2, `only ${hits.length} network call(s) found inside the walks: the scan is broken`);
    const unnamed = hits.filter(k => !NETWORK_CALL_EXEMPTIONS.some(e => e.key === k));
    assert.deepEqual(unnamed, [], 'a walk reaches a network call that is not a database operation: the housekeeping figure does not end it, so it must carry its own signal and be named');
    const stale = NETWORK_CALL_EXEMPTIONS.filter(e => !hits.includes(e.key)).map(e => e.key);
    assert.deepEqual(stale, [], 'a network-call exemption no walk reaches any more');
    for (const e of NETWORK_CALL_EXEMPTIONS) {
      assert.match(index.bodies.get(e.key).body, OWN_SIGNAL, `${e.key} is excused as carrying its own timeout and no longer shows one`);
    }
  });
});

describe('behaviour: the runner really bounds what a callback issues', () => {
  const TARGET = { collection: 'sp_facts', inheritedTimeoutMs: undefined };
  const OP_MS = 7000;
  before(() => wb.setWriteBoundForTest({ writeTimeoutMs: 6000, holdDeadlineMs: 20_000, housekeepingOpMs: OP_MS }));
  after(() => wb.setWriteBoundForTest(null));
  const runner = () => createHousekeepingWalk({ storeAnswers: async () => true });

  /** The options a `method` call is handed to the driver with, when made inside whatever scope is ambient. */
  const optionsHanded = async (method) => {
    const at = wb.BOUNDED_OPTIONS_ARGUMENT[method];
    const args = Array.from({ length: at + 1 }, () => ({}));
    let seen;
    await wb.callBounded(method, args, (a) => { seen = a; return Promise.resolve({ ok: 1 }); }, TARGET);
    return seen[at];
  };

  it('inside an eachSpace callback a read carries timeoutMS = the housekeeping figure', async () => {
    let handed;
    const out = await runner().eachSpace('Isolation gate walk', ['sp'], async () => { handed = await optionsHanded('find'); });
    assert.deepEqual(out.failed, []);
    assert.equal(handed?.timeoutMS, OP_MS, 'a read inside a walk callback carries no housekeeping bound: the scope is not entered');
  });

  it('inside an eachSpace callback a Db-level listCollections carries the bound through the one door', async () => {
    const calls = [];
    const fakeDb = { databaseName: 'fake', collection: () => ({}), listCollections: (...args) => { calls.push(args); return { fake: 'cursor' }; } };
    const observed = observer.observeRecordWrites(fakeDb, () => false, () => {});
    await runner().eachSpace('Isolation gate walk', ['sp'], async () => { observed.listCollections({}, {}); });
    assert.equal(calls[0]?.[1]?.maxTimeMS, OP_MS, 'listCollections inside a walk callback reached the driver without the bound (is it still in BOUNDED_DB_OPTIONS_ARGUMENT?)');
    observed.listCollections({}, { marker: 1 });
    assert.deepEqual(calls[1][1], { marker: 1 }, 'outside a scope the caller\'s arguments must be untouched');
  });

  it('inside a claimAcross claim a plain write is ended by the SERVER at the claim figure, no driver clock', async () => {
    const signal = createWorkSignal({ walk: runner(), fullScanIntervalMs: 0 });
    let handed;
    const got = await signal.claimAcross(['sp'], [null], async () => { handed = await optionsHanded('findOneAndUpdate'); return null; }, { step: 'Isolation gate claim' });
    assert.equal(got, null);
    assert.equal(handed?.maxTimeMS, wb.CLAIM_OP_MS, 'a claim carries the housekeeping figure, not the claim\'s: the claim scope is not entered');
    assert.equal('timeoutMS' in handed, false, 'a driver timeoutMS on a claim would fire before the server\'s and let it land');
  });

  it('outside any walk the same read carries nothing', async () => {
    const handed = await optionsHanded('find');
    assert.equal('timeoutMS' in handed, false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
//   the detector is exercised, not assumed: the same analysis over fixtures
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('the detector sees what it claims to', () => {
  const fixture = (files) => {
    // The index reads a declaration at the start of a line, as the tree writes it: strip the fixtures' own indentation.
    const sources = new Map(Object.entries(files).map(([file, text]) => [file, text.replace(/^[ \t]+/gm, '')]));
    return indexSources(sources, { functionFloor: 1, label: 'the fixture' });
  };
  const rootsOf = (idx, keys) => keys.map(key => ({ form: 'interval', label: key, key, closures: true }));
  const subjects = (idx, keys) => subjectsOutsideWalks(idx, rootsOf(idx, keys), NAMES).subjects;

  const UNWRAPPED = `
    import { spaceCollection } from './x.js';
    async function sweepSpace(spaceId) { return spaceCollection(spaceId, 'facts').deleteMany({}); }
    export async function tick() {
      for (const id of everySpace()) { await sweepSpace(id); }
    }`;
  const WRAPPED = `
    import { eachSpace } from './walk.js';
    import { spaceCollection } from './x.js';
    async function sweepSpace(spaceId) { return spaceCollection(spaceId, 'facts').deleteMany({}); }
    export async function tick() {
      await eachSpace('step', everySpace(), async (space) => { for (const id of [space]) { await sweepSpace(id); } });
    }`;

  it('a bare loop over spaces that calls a space helper is a subject, whatever the iterable is called', () => {
    const idx = fixture({ 'server/src/a.ts': UNWRAPPED });
    const found = subjects(idx, ['server/src/a.ts:tick']);
    assert.equal(found.length, 1, JSON.stringify(found.map(s => s.loop.head)));
    assert.equal(found[0].hands && !found[0].header, true, 'found by handing its variable to a `space…` parameter, not by the header');
  });

  it('the same loop inside eachSpace is not', () => {
    const idx = fixture({ 'server/src/a.ts': WRAPPED });
    assert.deepEqual(subjects(idx, ['server/src/a.ts:tick']), []);
  });

  it('a loop whose catch returns is flagged by the shape rule; one that reports is not', () => {
    const bad = `import { spaceCollection } from './x.js';
      async function one(spaceId) { return spaceCollection(spaceId, 'facts').countDocuments({}); }
      export async function tick(spaceIds) { for (const spaceId of spaceIds) { try { await one(spaceId); } catch (err) { return; } } }`;
    const ok = bad.replace('return;', 'report(err);');
    assert.equal(subjects(fixture({ 'server/src/a.ts': bad }), ['server/src/a.ts:tick']).filter(s => catchEndsTheLoop(s.loop)).length, 1);
    assert.equal(subjects(fixture({ 'server/src/a.ts': ok }), ['server/src/a.ts:tick']).filter(s => catchEndsTheLoop(s.loop)).length, 0);
  });

  it('a loop over records inside one space, handing a record to a non-space parameter, is not a subject', () => {
    const idx = fixture({ 'server/src/a.ts': `import { spaceCollection } from './x.js';
      async function removeOne(doc) { return spaceCollection('s', 'facts').deleteOne({ _id: doc._id }); }
      export async function tick(docs) { for (const doc of docs) { await removeOne(doc); } }` });
    assert.deepEqual(subjects(idx, ['server/src/a.ts:tick']), []);
  });

  it('an intervalJob run passed by reference is followed; one passed as a member expression is reported, not dropped', () => {
    const idx = fixture({ 'server/src/a.ts': `import { intervalJob } from './interval-job.js';
      async function runIt() {}
      const handlers = { run() {} };
      export function start() { intervalJob('A', 1000, runIt); intervalJob('B', 1000, handlers.run); }` });
    const runs = intervalJobRuns(idx);
    assert.equal(runs.find(r => r.label === "'A'").how, 'reference');
    assert.equal(runs.find(r => r.label === "'B'").how, 'unfollowable');
    assert.equal(runs.find(r => r.label === "'B'").key, null);
  });
});
