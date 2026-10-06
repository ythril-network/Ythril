/**
 * No catch inside a per-space housekeeping walk logs a space's failure itself: it goes through the reporter (`Q-274`, bundle-53 G25).
 *
 * ## The defect
 *
 * Before `util/space-failure.ts`, every per-space loop wrote its own failure line: a `log.warn(\`… for space '${id}': ${err}\`)` in a
 * catch, on every pass, for as long as the cause lasted. Seven sites, seven wordings, none throttled, none counted, none telling a hung
 * space from a dead store — and a hung space's line came from the catch that THEN ended the loop. The reporter says it once per window with
 * the step and the space, counts it (`ythril_housekeeping_space_failures_total{step,kind}`), and names when it is retried. A catch that
 * logs by hand brings all of it back for one site, and nothing but this makes the next site not do so.
 *
 * ## What is held
 *
 * A catch is matched only where it sits in what a walk owns: the text of a WALK CALLBACK (`eachSpace` / `walkSpaces` / `claimAcross` /
 * `eachUnit`) and the body of a space-iterating loop of a subject (`_housekeeping-walks.mjs`; the same derivation as
 * `every-housekeeping-space-walk-is-isolated`, so there is no second opinion about what a space loop is). In such a catch, a call of
 * `log.*` / `console.*` that names the space — the callback's or loop's variable, or the word `space` — is a finding. The reporter is the
 * only door: `reportSpaceFailure` / the walk's own report, never a line written in the catch.
 *
 * ## What is NOT a subject, and the three the rule was written beside
 *
 * A line about a JOB, a PATH or the PROCESS is not a space's failure, and it is not matched because it is not inside a space loop:
 *
 *  - `bootstrap.ts`: `cleanupStaleChunks().catch(err => log.error('Stale chunk cleanup failed: …'))` — the whole pass's failure, said by
 *    the caller of a function that walks the spaces;
 *  - `brain/embed-worker.ts`: `Brain embedding worker: startup sweeps failed: …` — a job's boot sweep that threw out of its own walks;
 *  - `files/at-rest-migration.ts`: the disk-full stop of a pass over directories — a process-level stop with a reason. (Its per-FILE line
 *    names the space and IS matched; it is the one row of {@link LOOP_LINE_EXEMPTIONS}, with its argument.)
 *
 * ## What this does not conclude
 *
 * It reads a catch's text. A failure said through a helper that the catch calls (`warnAbout(spaceId, err)`) is not read, and a failure that is
 * swallowed with no line at all is the isolation gate's shape rule and the reporter's counters, not this. It matches a CALL on `log` /
 * `console`, not a logger passed in as a parameter.
 *
 * ## Seen red
 *
 * By hand, put back by hand: a `log.warn(\`… '${spaceId}' …\`)` written into the catch of a walk callback; the same in a space loop.
 *
 * Run: node --test testing/standalone/no-housekeeping-catch-logs-a-space-failure-except-through-the-reporter.test.js   (after `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { moduleIndex, indexSources } from './_call-graph.mjs';
import { scheduledJobs } from './_scheduled-jobs.mjs';
import {
  walkEntryNames, walkRunnerKeys, housekeepingRoots, reachOutsideWalks, insideWalks, spaceReachers, spaceLoopsIn, catchesIn,
} from './_housekeeping-walks.mjs';
import { balancedFrom } from './_structural-window.mjs';

/** A direct line: `log.warn(`, `logger.error(`, `console.log(`. */
const DIRECT_LOG = /(?<![\w$.])(?:log|logger|console)\s*\.\s*(?:warn|error|info|debug|log)\s*\(/g;

/**
 * The lines a catch writes by hand that name a space: `{ call, text }` for each. `vars` are the names the surrounding callback or loop
 * binds; a call "names the space" when its arguments mention one of them or the word `space`.
 */
function handWrittenSpaceLines(catchBody, vars) {
  const hits = [];
  for (const m of catchBody.matchAll(DIRECT_LOG)) {
    let args;
    try { args = balancedFrom(catchBody, m.index + m[0].length - 1, 'a log call'); } catch { continue; }
    const names = /\bspace/i.test(args) || vars.some(v => new RegExp(`(?<![\\w$.])${v}(?![\\w$])`).test(args));
    if (names) hits.push({ call: m[0].replace(/\s+/g, ''), text: args.replace(/\s+/g, ' ').slice(0, 90) });
  }
  return hits;
}

/** Names a walk callback binds: its leading parameters (`(space, ctx)`, `async (spaceId)`, `space =>`). */
function callbackVars(text) {
  const head = /^(?:async\s+)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*(?::[^=]*)?=>/.exec(text.trim());
  const params = head ? (head[1] ?? head[2] ?? '') : '';
  return [...params.matchAll(/[A-Za-z_$][\w$]*/g)].map(m => m[0]).filter(v => v !== 'async');
}

/**
 * Space loops outside a walk whose catch writes its own line, each with its argument. The pass is the isolation gate's named exemption
 * (a one-shot boot migration over DIRECTORIES, isolated per file); this is the line that exemption leaves behind.
 */
const LOOP_LINE_EXEMPTIONS = [
  {
    key: 'server/src/files/at-rest-migration.ts:runAtRestMigration',
    why: 'A per-FILE failure of the one-shot at-rest encryption pass: the unit is a file, the line names `<space>/<path>` because that is the file, '
      + 'and the pass has no database operation, no retry window and no tick for the reporter\'s throttle to mean anything in. It runs once per start.',
  },
];

/** Every hand-written space line in every walk callback and every space loop outside one, as printable findings. */
function findings(index, names, subjects, callbacks) {
  const out = [];
  for (const key of callbacks) {
    const entry = index.bodies.get(key);
    const vars = callbackVars(entry.body);
    for (const c of catchesIn(entry.body)) {
      for (const hit of handWrittenSpaceLines(c.body, vars)) out.push(`${key.replace(/^server\/src\//, '')}: catch writes ${hit.call} ${hit.text}`);
    }
  }
  for (const s of subjects) {
    if (LOOP_LINE_EXEMPTIONS.some(e => e.key === s.key)) continue;
    for (const c of catchesIn(s.loop.body)) {
      for (const hit of handWrittenSpaceLines(c.body, s.loop.vars)) out.push(`${s.key.replace(/^server\/src\//, '')}: loop catch writes ${hit.call} ${hit.text}`);
    }
  }
  return out;
}

const index = moduleIndex('server/src');
const NAMES = walkEntryNames(index);
const { jobs } = scheduledJobs(index);
const roots = housekeepingRoots(index, jobs);
const { blanked, seen } = reachOutsideWalks(index, roots, NAMES);
const reachers = spaceReachers(index);
const subjects = [];
for (const key of [...seen].sort()) {
  const entry = blanked.bodies.get(key);
  if (entry) for (const s of spaceLoopsIn(index, entry, reachers)) if (s.reaches) subjects.push({ key, ...s });
}
const { callbacks } = insideWalks(index, NAMES, walkRunnerKeys(index));

describe('the scan reads what it claims to', () => {
  it('finds the walk callbacks and the subject loops (floors)', () => {
    assert.ok(callbacks.length >= 20, `only ${callbacks.length} walk callback(s)`);
    assert.ok(subjects.length >= 3, `only ${subjects.length} subject loop(s)`);
  });

  it('what it reads contains catches (floor), so a quiet tree is not an unread one', () => {
    // Few: a walk owns its callback's failure, so a callback rarely catches. The loops outside a walk are where they live.
    const inCallbacks = callbacks.reduce((n, k) => n + catchesIn(index.bodies.get(k).body).length, 0);
    const inLoops = subjects.reduce((n, s) => n + catchesIn(s.loop.body).length, 0);
    assert.ok(inCallbacks >= 2 && inCallbacks + inLoops >= 3, `only ${inCallbacks} + ${inLoops} catch block(s) read: the scan is broken`);
  });

  it('every loop exemption still names a loop that has a hand-written line', () => {
    for (const e of LOOP_LINE_EXEMPTIONS) {
      const s = subjects.find(x => x.key === e.key);
      assert.ok(s, `${e.key} is excused but is no longer a space loop outside a walk`);
      assert.ok(catchesIn(s.loop.body).some(c => handWrittenSpaceLines(c.body, s.loop.vars).length > 0), `${e.key} no longer writes a line by hand: drop the row`);
      assert.ok(e.why.length > 60, 'the reason is not an argument');
    }
  });
});

describe('no catch in a walk writes a space\'s failure by hand', () => {
  it('every callback and every space loop reports through the reporter', () => {
    const found = findings(index, NAMES, subjects, callbacks);
    assert.deepEqual(found, [],
      'a catch inside a per-space walk writes its own line for a space. Let the walk report it (the failure is returned and counted), or call '
      + '`reportSpaceFailure`: the reporter says it once per window with the step, counts it, and names when it is retried.');
  });
});

describe('the detector sees what it claims to', () => {
  const fixture = (text) => {
    const idx = indexSources(new Map([['server/src/a.ts', text.replace(/^[ \t]+/gm, '')]]), { functionFloor: 1, label: 'the fixture' });
    return idx;
  };
  const callbacksOf = (idx) => insideWalks(idx, NAMES, []).callbacks;

  it('a log.warn naming the space in a callback\'s catch is found', () => {
    const idx = fixture(`import { eachSpace } from './walk.js';
      export async function tick() {
        await eachSpace('s', ids, async (space) => { try { await work(space.id); } catch (err) { log.warn(\`failed for \${space.id}: \${err}\`); } });
      }`);
    assert.equal(findings(idx, NAMES, [], callbacksOf(idx)).length, 1);
  });

  it('the same catch that rethrows, or logs a thing that is not the space, is not', () => {
    const idx = fixture(`import { eachSpace } from './walk.js';
      export async function tick() {
        await eachSpace('s', ids, async (space) => { try { await work(space.id); } catch (err) { if (isFatal(err)) throw err; log.debug('retrying the read'); } });
      }`);
    assert.deepEqual(findings(idx, NAMES, [], callbacksOf(idx)), []);
  });

  it('a line about the job, outside any callback, is not matched', () => {
    const idx = fixture(`import { eachSpace } from './walk.js';
      export async function tick() {
        try { await eachSpace('s', ids, async (space) => { await work(space.id); }); } catch (err) { log.error('Stale chunk cleanup failed: ' + err); }
      }`);
    assert.deepEqual(findings(idx, NAMES, [], callbacksOf(idx)), []);
  });

  it('a hand-written line in a space loop that is not in a walk is found through the loop\'s variable', () => {
    const idx = fixture(`export async function tick(spaceIds) {
      for (const spaceId of spaceIds) { try { await one(spaceId); } catch (err) { console.warn('could not do ' + spaceId); } }
    }`);
    const loop = { loop: { vars: ['spaceId'], body: idx.bodies.get('server/src/a.ts:tick').body } };
    assert.equal(findings(idx, NAMES, [{ key: 'server/src/a.ts:tick', ...loop }], []).length, 1);
  });
});
