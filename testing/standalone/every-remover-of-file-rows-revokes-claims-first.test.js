/**
 * Whoever removes or flags a space's file rows takes the media jobs' claims first (bundle-44 D-29, Q-436, ruling 23).
 *
 * ## The rule
 *
 * A media job writes the rows it derives from a file under its claim (`writeUnderClaim`). That is only a fence if everything that
 * removes the file's rows takes the claim away BEFORE it removes them: the revocation either lands first and the run's write then
 * matches nothing, or it lands after and waits for the write to commit, so the removal then finds the row in place and takes it too.
 * A remover that removes first and revokes after (or never) leaves the window open: a run that read its parent live writes after the
 * children went and before the flag. A SPACE WIPE is a remover like any other, and was the one with no revocation at all.
 *
 * ## What is derived, never listed
 *
 *  - **The removers**: every call, in `server/src`, that deletes or flags rows of a space's `files` collection (a `delete*` or an update
 *    that sets `deletedAt`), found where the receiver resolves to that collection (`_file-row-writers.mjs`) — whatever the function
 *    is called. A floor on what was found.
 *  - **What reaches them**: the call graph, to exhaustion. A function is a remover when it removes, or calls one.
 *
 * ## What is asserted
 *
 * For every remover, in the order its body reads: **the first thing it does that revokes or removes is a revocation**, where a call of
 * another remover counts as a revocation when THAT one is itself safe in this sense, and as a removal when it is not. A function that
 * fails this is a step of a larger cascade, and every caller of it (found by the call graph) must have revoked by the time it
 * calls. A step with no caller in the tree is an ENTRY and must be safe by itself.
 *
 * The revokers are the guard this rule is about, so they are named: `cancelMediaJob`, `cancelJobsOwnedBy`, `cancelEveryJobOfSpace`
 * and `holdJobsForMove` (`files/media/job-queue.ts`). A call of any function whose calls reach one counts, followed to exhaustion.
 *
 * ## Seen red
 *
 * On e82caa5e `wipeSpace` removes the space's file rows with no revocation at all. Mutations (put back by hand): swap the job cancel and
 * the artefacts' removal in `removeFileHere`; remove the `cancelEveryJobOfSpace` call from `wipeSpace`.
 *
 * Run: node --test testing/standalone/every-remover-of-file-rows-revokes-claims-first.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sourceTree, removalsOfFileRows, reaches } from './_file-row-writers.mjs';
import { callSitesIn, memberCallSitesIn } from './_call-graph.mjs';

const JOB_QUEUE = 'server/src/files/media/job-queue.ts';
/** The functions that take a media job's claim away, by name: the guard the rule is about. */
const REVOKER_NAMES = ['cancelMediaJob', 'cancelJobsOwnedBy', 'cancelEveryJobOfSpace', 'holdJobsForMove'];

/**
 * Removers that need no revocation, with the reason. Keyed `file:function`. A row whose function no longer removes file rows fails
 * below, so an exemption cannot outlive what it excuses.
 */
const EXEMPT = {
  'server/src/brain/ttl-sweep.ts:purgeFlagged':
    'removes rows a delete ALREADY flagged (`deletedAt` exists), after their retention: the delete that flagged a row revoked its claims first, and a flagged row has no live job to write for it',
  'server/src/files/legacy-spill-sweep.ts:sweepSpace':
    'empties the instance\'s own legacy read-spill cache under `_tmp/` by path (a retired mechanism, which sync never carries) and is not a file delete a person or a peer asked for: it is named here, not hidden, so a media job queued for one of those paths is a question for the spill\'s own retirement',
  'server/src/files/derived-fields.ts:replaceDerivedFileRows':
    'the WRITER of a derived row removes the previous run\'s rows by id and inserts the new ones inside its own claim fence (`writeUnderClaim`): it is the holder, not a remover of the file',
};

const { INDEX, callersOf } = sourceTree();
const REVOKERS = new Set(REVOKER_NAMES.map(n => `${JOB_QUEUE}:${n}`));
const REMOVALS = removalsOfFileRows();

const revokes = (key) => [...reaches(key)].some(k => REVOKERS.has(k));
const reachesRevoker = new Map();
const callReachesRevoker = (key) => { if (!reachesRevoker.has(key)) reachesRevoker.set(key, REVOKERS.has(key) || revokes(key)); return reachesRevoker.get(key); };

/** The functions that remove, or call one that does — to exhaustion. */
const REMOVERS = (() => {
  const set = new Set(REMOVALS.map(r => r.key));
  for (let grew = true; grew;) {
    grew = false;
    for (const key of [...set]) for (const c of callersOf.get(key) ?? []) if (!set.has(c.from)) { set.add(c.from); grew = true; }
  }
  return set;
})();

/** The body's events in reading order: `revoke` (a revoker, or a call that reaches one), a `call` of a remover, or its own `remove`. */
function eventsOf(key) {
  const entry = INDEX.bodies.get(key);
  const events = REMOVALS.filter(r => r.key === key && !(`${r.file}:${r.fn}` in EXEMPT)).map(r => ({ at: r.at, kind: 'remove', name: r.op }));
  const consider = (target, name, at) => {
    if (!target || target === key) return;
    if (REVOKERS.has(target)) events.push({ at, kind: 'revoke', name });
    else if (REMOVERS.has(target) && !(target in EXEMPT)) events.push({ at, kind: 'call', name, target });
    else if (callReachesRevoker(target)) events.push({ at, kind: 'revoke', name });
  };
  for (const c of callSitesIn(entry.body, { closures: true })) consider(INDEX.resolve(entry.file, c.name), c.name, c.at);
  for (const c of memberCallSitesIn(entry.body, { closures: true })) consider(INDEX.resolveMember(entry.file, c.obj, c.prop), `${c.obj}.${c.prop}`, c.at);
  return events.sort((a, b) => a.at - b.at);
}

const memo = new Map();
/**
 * Is the first thing `key` does that revokes or removes a revocation? A call of a remover is one when that remover is itself safe, and
 * a removal when it is not. A function that does neither is safe (it removes nothing the rule is about).
 */
function safe(key, trail = new Set()) {
  if (memo.has(key)) return memo.get(key);
  // A cycle of callers is read as safe: the first event of the cycle's other members decides it.
  if (trail.has(key)) return true;
  const first = eventsOf(key)[0];
  let ok = true;
  if (first?.kind === 'remove') ok = false;
  else if (first?.kind === 'call') ok = safe(first.target, new Set(trail).add(key));
  if (trail.size === 0) memo.set(key, ok);
  return ok;
}

/** Has `key` revoked by the time it reaches offset `at`: a revocation, or a call of a remover that is safe, before it. */
function revokedBefore(key, at) {
  return eventsOf(key).some(e => e.at < at && (e.kind === 'revoke' || (e.kind === 'call' && safe(e.target))));
}

/** Why `key` is not covered, or null: it is safe itself, or every caller has revoked before it calls. A step with no caller is an entry. */
function uncovered(key, trail = new Set()) {
  if (safe(key) || trail.has(key)) return null;
  const callers = callersOf.get(key) ?? [];
  if (callers.length === 0) return `${key} removes file rows before it revokes, and nothing in the tree calls it that could have revoked first (an entry)`;
  const next = new Set(trail).add(key);
  for (const c of callers) {
    if (revokedBefore(c.from, c.at)) continue;
    const why = uncovered(c.from, next);
    if (why === null) continue;
    return `${c.from} calls ${key}, which removes file rows before it revokes, with no revocation before the call; ${why}`;
  }
  return null;
}

describe('the removers of file rows are found, so the rule cannot pass by finding none', () => {
  it('the derivation finds the removals, in more than one module, and the wipe among them', () => {
    assert.ok(REMOVALS.length >= 8, `only ${REMOVALS.length} removal(s) found`);
    assert.ok(new Set(REMOVALS.map(r => r.file)).size >= 3, 'the removals belong to fewer than three modules — the derivation is thin');
    assert.ok(REMOVALS.some(r => /spaces\/lifecycle\.ts$/.test(r.file) && r.fn === 'wipeSpace'), 'wipeSpace is not found to remove file rows — the derivation is broken');
    assert.ok(REMOVALS.some(r => /file-meta\.ts$/.test(r.file)), 'the retire primitives are not found to remove file rows');
  });
  it('the revokers exist where the rule says they do', () => {
    const missing = REVOKER_NAMES.filter(n => !INDEX.bodies.has(`${JOB_QUEUE}:${n}`));
    assert.deepEqual(missing, [], `these revokers are not defined in ${JOB_QUEUE}: ${missing} (cancelEveryJobOfSpace is the wipe's)`);
  });
  it('every exemption still names a function that removes file rows', () => {
    const live = new Set(REMOVALS.map(r => `${r.file}:${r.fn}`));
    assert.deepEqual(Object.keys(EXEMPT).filter(k => !live.has(k)), [], 'exemptions for functions that no longer remove file rows — delete them');
    for (const [k, why] of Object.entries(EXEMPT)) assert.ok(why.length > 40, `${k}: an exemption owes its reason`);
  });
});

describe('whoever removes or flags file rows revokes the claims first', () => {
  it('every remover, and every entry that reaches one, revokes before it removes', () => {
    const entries = [...new Set([...REMOVERS].filter(k => !(k in EXEMPT)))].sort();
    assert.ok(entries.length >= 10, `only ${entries.length} remover(s) found, counting the functions that reach one`);
    const failures = entries.map(k => uncovered(k)).filter(Boolean);
    assert.deepEqual([...new Set(failures)], [],
      'these remove or flag the rows of a space\'s files with no revocation of the media jobs\' claims before them: a run that read its parent live can write a derived row between the removal of the children and the flag, and nothing removes it');
  });
});
