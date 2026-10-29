/**
 * Whoever removes a space's file rows forgets what is keyed by their paths and retires their embed work; whoever re-keys them carries
 * the cache in the same transaction and re-queues their embed work once it has committed (bundle-111, Q-459, Q-548's derived gate).
 *
 * ## The defect
 *
 * A file row is not the only thing keyed by a file's path. The manifest's hash cache (`<space>_file_hashes`, keyed by the on-disk
 * spelling) and the embed queue (`embedJobId('file', <row id>)`, one job per top-level row, chunk and sidecar) are too. The move
 * re-keyed the rows and the media jobs and neither of those: the old path's cache entry stayed, the moved file kept the OLD path's
 * vector (its text is built from its path) and no job was queued at the new id. The delete forgot the cache and left every embed job of
 * the file and its derived rows behind, to answer `gone` — and a leftover job at a later move's destination refused that move.
 *
 * ## The two modules this gate holds every subject to (design rev 3 step 1; their names are the contract the implementation meets)
 *
 *  - **"what local cache is keyed by a file's path"** — {@link CACHE}: `forget` (by ids or a prefix, a row id mapped to the cache key
 *    the manifest would spell) and `carry` (the moves, inside the caller's transaction, every destination id treated as replaced).
 *  - **"which embed work a file row has"** — {@link EMBED}: `retire` (every removed row id's job, derived rows resolved from the rows,
 *    never by an id prefix) and `afterCommit` (the moved rows re-queued at their new ids from the rows at the destination, the old ids'
 *    jobs retired).
 *
 * ## What is derived, never listed
 *
 *  - **The removers**: `removalsOfFileRows` (`_file-row-writers.mjs`) — every call that deletes or flags rows of a space's `files`
 *    collection, found by what the code does. Floor 8.
 *  - **The relocators**: every call of `rekeyRows` (`files/rekey-rows.ts`) whose collection argument resolves — inline, or through the
 *    binding the function declares for it — to `spaceCollection(…, 'files')`. The media jobs' re-key resolves to `'mediaJobs'` and falls
 *    out by that resolution, never by its name. A collection argument that resolves to nothing is a failure, not a skip. Floor 1.
 *
 * ## What is asserted
 *
 *  (a) every remover reaches `forget` and `retire` — itself, or through every caller above it (a primitive such as `deleteFileMeta` is
 *      covered when everything that calls it is) — or carries a reasoned EXEMPT row for that step;
 *  (b) every relocator calls `carry` in the same function as the rekey, handing it the same session (one transaction), and every
 *      function that runs a relocator's batches calls the embed `afterCommit` step AFTER the call that runs them (or every caller of it
 *      does): a step taken per batch could not re-cover the batches an earlier attempt of an owed move committed.
 *
 * ## Red at base (3a117862)
 *
 * Neither module exists: no remover reaches a `forget` or a `retire` of that name and the relocator calls no `carry`. The mutations to see
 * it red after the implementation: remove the `carry` call from `carryBatch`; remove the `retire` step from `removeFileHere`; move the
 * `afterCommit` call into `carryBatch` (put each back by hand).
 *
 * Run: node --test testing/standalone/every-remover-and-relocator-of-file-rows-reaches-the-cache-and-embed-steps.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sourceTree, removalsOfFileRows, reaches } from './_file-row-writers.mjs';
import { callSitesIn, memberCallSitesIn } from './_call-graph.mjs';
import { argumentsOf } from './_structural-window.mjs';

/** The cache module: one question, "what local cache is keyed by a file's path". */
const CACHE = Object.freeze({ file: 'server/src/files/path-keyed-cache.ts', forget: 'forgetPathKeyedCache', carry: 'carryPathKeyedCache' });
/** The embed module: one question, "which embed work a file row has". */
const EMBED = Object.freeze({ file: 'server/src/files/file-embed-work.ts', retire: 'retireEmbedWorkOfRemovedRows', afterCommit: 'requeueEmbedWorkOfMovedRows' });
const FORGET = `${CACHE.file}:${CACHE.forget}`;
const CARRY = `${CACHE.file}:${CACHE.carry}`;
const RETIRE = `${EMBED.file}:${EMBED.retire}`;
const AFTER_COMMIT = `${EMBED.file}:${EMBED.afterCommit}`;
const REKEY = 'server/src/files/rekey-rows.ts:rekeyRows';

/**
 * A remover that needs a step it does not reach, by step, with the reason. Keyed `file:function`. A row whose function no longer removes
 * file rows fails below, so an exemption cannot outlive what it excuses.
 */
const EXEMPT = {
  'server/src/brain/ttl-sweep.ts:purgeFlagged': {
    forget: 'removes rows a delete ALREADY flagged (`deletedAt` exists), after their retention: the delete that flagged the row went through removeFileHere, which forgot the path\'s cache entry then',
    retire: 'removes rows a delete ALREADY flagged (`deletedAt` exists), after their retention: the delete that flagged the row went through removeFileHere, which retired its embed work then',
  },
  'server/src/files/legacy-spill-sweep.ts:sweepSpace': {
    retire: 'a legacy read spill under `_tmp/` is never queued for embedding (`embeddable` in brain/embed-queue.ts refuses a spill path), so there is no embed work to retire',
  },
  'server/src/files/derived-fields.ts:replaceDerivedFileRows': {
    forget: 'the WRITER of a derived row replaces the previous run\'s derived rows of a file that stays: the file\'s bytes and their cache entry are unchanged, and a derived row has no bytes of its own',
    retire: 'the WRITER of a derived row replaces the previous run\'s rows inside its own claim fence and queues the rows it writes (writeDerivedFields): it is the producer of the embed work, not a remover of the file',
  },
  'server/src/files/another-spelling-of-the-entry.ts:removeOnlyTheRecordNamed': {
    forget: 'removes the record of ANOTHER SPELLING of an entry whose bytes stay under the spelling kept: the cache is keyed by the on-disk spelling, which still names those bytes, so its entry is still true',
  },
};

/**
 * A relocator that re-queues the embed work ITSELF, after its own commit, by the receiver's rules instead of through the move's step, with the
 * step it calls and the reason. Honoured only while the relocator really calls that step AFTER its rekey (`afterCommitMissing`), so the row is a
 * claim the gate checks, not a pass. A row whose function no longer re-keys file rows fails below.
 */
const OWN_AFTER_COMMIT = {
  'server/src/files/legacy-file-rekey.ts:rekeyLegacy': {
    step: 'server/src/sync/embed-arrived-files.ts:embedArrivedFiles',
    why: "it re-keys one of THIS instance's own rows from another spelling of its path (Q-413) and queues the file at its key by the receiver's rules "
      + "(embedArrivedFiles: a suppressed file holds no vector, a file with bytes here is queued) once the row has committed; the old id's jobs and derived rows are removed beside it. "
      + "It is no move: the file's text does not change with a path, so the move's step (which re-queues a whole tree) has nothing to cover",
  },
};

const { INDEX, callersOf } = sourceTree();
const REMOVALS = removalsOfFileRows({ floor: 8 });
const REMOVERS = [...new Set(REMOVALS.map(r => r.key))].sort();

/** Does `key`, by its own calls, reach `target`? */
const reachesStep = (key, target) => reaches(key).has(target);

/**
 * Is `key` covered for `step` (`target`): it reaches the step, it is exempt for it, or every caller of it is covered. A function with no
 * caller that is not covered is an entry that removes without the step. Returns null when covered, else the chain that is not.
 */
function uncovered(key, step, target, trail = new Set()) {
  if (EXEMPT[key]?.[step] || reachesStep(key, target)) return null;
  if (trail.has(key)) return null;   // a cycle of callers: its other members decide it
  const callers = callersOf.get(key) ?? [];
  if (callers.length === 0) return `${key} (an entry: nothing calls it)`;
  const next = new Set(trail).add(key);
  for (const c of new Set(callers.map(x => x.from))) {
    const why = uncovered(c, step, target, next);
    if (why !== null) return `${why} → ${key}`;
  }
  return null;
}

/** The text of a collection expression, resolved through the binding the function declares for it when it is a bare identifier. */
function collectionOf(body, expr) {
  const direct = expr.match(/^spaceCollection\(\s*[^,]+,\s*'([A-Za-z_]+)'\s*\)$/);
  if (direct) return direct[1];
  if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
    const bound = body.match(new RegExp(`(?:const|let)\\s+${expr.replace(/\$/g, '\\$')}\\s*(?::[^=]+)?=\\s*([^;\\n]+)`));
    if (bound) return collectionOf(body, bound[1].trim());
  }
  return undefined;
}

/** Every call of `rekeyRows`, with the collection it re-keys resolved: `{ key, collection, session, at }`. */
function rekeyCalls() {
  const out = [];
  for (const from of new Set((callersOf.get(REKEY) ?? []).map(c => c.from))) {
    const { file, body } = INDEX.bodies.get(from);
    for (const c of callSitesIn(body, { closures: true })) {
      if (INDEX.resolve(file, c.name) !== REKEY) continue;
      const [coll, session] = argumentsOf(body, c.paren, `${from} rekeyRows`);
      out.push({ key: from, expr: coll, collection: collectionOf(body, coll), session, at: c.at });
    }
  }
  return out;
}
const REKEYS = rekeyCalls();
const RELOCATORS = REKEYS.filter(r => r.collection === 'files');

/** The calls in `key`'s body that resolve to `target` or to a function reaching it: `{ at, paren, name }`. */
function callsReaching(key, target) {
  const { file, body } = INDEX.bodies.get(key);
  const hits = [];
  for (const c of callSitesIn(body, { closures: true })) {
    const t = INDEX.resolve(file, c.name);
    if (t && (t === target || reachesStep(t, target))) hits.push({ at: c.at, paren: c.paren, name: c.name });
  }
  for (const c of memberCallSitesIn(body, { closures: true })) {
    const t = INDEX.resolveMember(file, c.obj, c.prop);
    if (t && (t === target || reachesStep(t, target))) hits.push({ at: c.at, paren: c.paren, name: `${c.obj}.${c.prop}` });
  }
  return hits;
}

/**
 * Does every chain of callers above the relocator `key` call the embed after-commit step AFTER the call that runs the relocator? Checked
 * from the relocator's callers up — the relocator runs ONE batch, and a step taken there cannot re-cover what an earlier attempt committed.
 */
function afterCommitMissing(key, trail = new Set()) {
  const own = OWN_AFTER_COMMIT[key];
  if (own) {
    const rekeyAt = REKEYS.filter(r => r.key === key).map(r => r.at);
    if (callsReaching(key, own.step).some(s => rekeyAt.every(at => s.at > at))) return null;
    return `${key} (exempt for its own ${own.step}, which it no longer calls after its rekey)`;
  }
  const callers = callersOf.get(key) ?? [];
  if (callers.length === 0) return `${key} (an entry: nothing above it re-queues the embed work after the batches)`;
  const next = new Set(trail).add(key);
  for (const c of callers) {
    if (trail.has(c.from)) continue;
    if (callsReaching(c.from, AFTER_COMMIT).some(s => s.at > c.at)) continue;
    const why = afterCommitMissing(c.from, next);
    if (why !== null) return `${why} → ${key}`;
  }
  return null;
}

describe('the subjects are found, so the rule cannot pass by finding none', () => {
  it('the removers of file rows are derived, in more than one module', () => {
    assert.ok(REMOVALS.length >= 8, `only ${REMOVALS.length} removal(s) of file rows found`);
    assert.ok(new Set(REMOVALS.map(r => r.file)).size >= 3, 'the removals belong to fewer than three modules — the derivation is thin');
  });
  it('every call of rekeyRows resolves its collection, and at least one re-keys the files collection', () => {
    const unresolved = REKEYS.filter(r => r.collection === undefined).map(r => `${r.key}: ${r.expr}`);
    assert.deepEqual(unresolved, [], 'a rekeyRows call whose collection argument resolves to no spaceCollection(…, \'<name>\') — the derivation cannot tell whether it re-keys file rows');
    assert.ok(RELOCATORS.length >= 1, `no rekeyRows call re-keys the files collection (${JSON.stringify(REKEYS.map(r => [r.key, r.collection]))}) — the derivation is broken`);
    assert.ok(REKEYS.some(r => r.collection !== 'files'), 'every rekeyRows call resolved to files: the media jobs\' re-key is no longer told apart by its collection');
  });
  it('the two modules exist, with the steps the rule holds every subject to', () => {
    const missing = [FORGET, CARRY, RETIRE, AFTER_COMMIT].filter(k => !INDEX.bodies.has(k));
    assert.deepEqual(missing, [], 'the cache module ("what local cache is keyed by a file\'s path") and the embed module ("which embed work a file row has") do not define these steps');
  });
  it('every exemption still names a function that removes file rows, and owes its reason', () => {
    // A remover, or a function that reaches one: an exemption may sit at any level of the chain above the removal.
    const live = new Set(REMOVERS);
    for (let grew = true; grew;) {
      grew = false;
      for (const k of [...live]) for (const c of callersOf.get(k) ?? []) if (!live.has(c.from)) { live.add(c.from); grew = true; }
    }
    assert.deepEqual(Object.keys(EXEMPT).filter(k => !live.has(k)), [], 'exemptions for functions that no longer remove file rows — delete them');
    for (const [k, steps] of Object.entries(EXEMPT)) for (const [s, why] of Object.entries(steps)) assert.ok(why.length > 40, `${k} ${s}: an exemption owes its reason`);
  });
});

describe('(a) every remover of file rows forgets the path-keyed cache and retires the embed work', () => {
  for (const [step, target] of [['forget', FORGET], ['retire', RETIRE]]) {
    it(`every remover reaches ${step} (${target}), itself or through every caller above it`, () => {
      const failures = REMOVERS.map(k => uncovered(k, step, target)).filter(Boolean);
      assert.deepEqual([...new Set(failures)], [],
        `these remove file rows on a chain where nothing reaches ${target}: what is keyed by the removed paths outlives the rows`);
    });
  }
});

describe('(b) every relocator of file rows carries the cache in its transaction and re-queues the embed work after the commit', () => {
  it('every relocator calls the cache carry in the same function as the rekey, with the same session', () => {
    const failures = [];
    for (const r of RELOCATORS) {
      const carries = callsReaching(r.key, CARRY);
      if (carries.length === 0) { failures.push(`${r.key}: re-keys file rows and never carries the path-keyed cache`); continue; }
      const { body } = INDEX.bodies.get(r.key);
      const sameSession = carries.some(c => argumentsOf(body, c.paren, `${r.key} ${c.name}`).includes(r.session));
      if (!sameSession) failures.push(`${r.key}: carries the cache outside the rekey's transaction (no call is handed '${r.session}')`);
    }
    assert.deepEqual(failures, [], 'a move that re-keys file rows leaves the cache entries at the old paths, or carries them in a second transaction');
  });
  it('every own-after-commit row still names a relocator of file rows, and owes its reason', () => {
    const relocators = new Set(RELOCATORS.map(r => r.key));
    assert.deepEqual(Object.keys(OWN_AFTER_COMMIT).filter(k => !relocators.has(k)), [], 'rows for functions that no longer re-key file rows — delete them');
    for (const [k, { step, why }] of Object.entries(OWN_AFTER_COMMIT)) {
      assert.ok(INDEX.bodies.has(step), `${k}: names ${step}, which does not exist`);
      assert.ok(why.length > 40, `${k}: an exemption owes its reason`);
    }
  });
  it('whatever runs a relocator\'s batches re-queues the moved rows\' embed work after them', () => {
    const failures = [...new Set(RELOCATORS.map(r => afterCommitMissing(r.key)).filter(Boolean))];
    assert.deepEqual(failures, [], `nothing calls ${AFTER_COMMIT} after the batches: a moved file keeps its old path's vector and its old id's job`);
  });
});
