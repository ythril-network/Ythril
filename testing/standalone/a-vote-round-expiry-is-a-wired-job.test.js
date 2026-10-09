/**
 * The vote-round expiry job exists, is registered the way every repeating job is, and is wired to start and to stop.
 *
 * ## What the generic gates do not say
 *
 * `every-repeating-timer-is-an-interval-job`, `every-started-job-is-stopped-at-shutdown` and `scheduler-wiring` derive "every
 * job" from the tree, so a job that is MISSING passes all three. This gate holds that the job the design adds is there:
 *
 * - registered through `intervalJob` in `networks/round-expiry.ts`, labelled `Vote round expiry` (capitalised: the label is the
 *   `job` of `ythril_interval_tick_skipped_total` and the head of its failure line), every 60 seconds;
 * - its run reaches `runRoundExpiryTick`, the synchronous tick body;
 * - started from `bootstrap.ts`'s `startConfiguredInstanceServices` (so a first-run setup starts it too) and stopped by the
 *   shutdown handler in `index.ts` before the drain;
 * - it walks the networks through `eachNetwork` in `util/housekeeping-walk.ts` — not a hand-written `for` with a `try`, which is
 *   the shape every copy of the space walk had before `eachSpace`;
 * - a conclusion it makes is audited as `network.round.expired`, through `logInternalAudit`, one entry per round (the record a
 *   flood of rounds cannot evict from a bounded outcome log).
 *
 * Run: node --test testing/standalone/a-vote-round-expiry-is-a-wired-job.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { moduleIndex, walkFrom } from './_call-graph.mjs';
import { scheduledJobs } from './_scheduled-jobs.mjs';
import { argumentsOf, balancedFrom } from './_structural-window.mjs';
import { stripComments } from './_strip-comments.mjs';

const FILE = 'server/src/networks/round-expiry.ts';
const LABEL = 'Vote round expiry';
const code = (f) => stripComments(fs.readFileSync(f, 'utf8'));

describe('the job is registered', () => {
  const index = moduleIndex('server/src');
  const { jobs } = scheduledJobs(index);
  const job = jobs.find(j => j.kind === 'interval' && j.file === FILE);

  it('through intervalJob, in networks/round-expiry.ts, under the capitalised label', () => {
    assert.ok(job, `${FILE} registers no intervalJob`);
    assert.equal(job.label.replace(/^['"`]|['"`]$/g, ''), LABEL);
  });

  it('every 60 seconds', () => {
    assert.ok(job, `${FILE} registers no intervalJob`);
    const src = index.sources.get(FILE);
    const args = argumentsOf(src, src.indexOf('(', job.at), 'the intervalJob registration');
    assert.match(args[1], /^(?:60_?000|60\s*\*\s*1_?000)$/, `the interval is ${args[1]}`);
  });

  it('and its run reaches the synchronous tick body', () => {
    assert.ok(job, `${FILE} registers no intervalJob`);
    assert.ok(job.runKey, 'the registration\'s run cannot be followed');
    const { seen } = walkFrom(index, [job.runKey]);
    assert.ok([...seen].some(k => k === `${FILE}:runRoundExpiryTick`), 'the job runs something other than runRoundExpiryTick');
  });

  it('and the tick is exported for the tests that drive it, with the start and the stop', () => {
    const src = code(FILE);
    for (const name of ['runRoundExpiryTick', 'startRoundExpiry', 'stopRoundExpiry']) {
      assert.match(src, new RegExp(String.raw`export\s+(?:async\s+)?function\s+${name}\b`), `${FILE} does not export ${name}`);
    }
    assert.doesNotMatch(src, /export\s+async\s+function\s+runRoundExpiryTick/, 'the tick is async: an await between the read and the save is the window a reload lands in');
  });
});

describe('it is started and stopped', () => {
  it('startRoundExpiry is called by startConfiguredInstanceServices', () => {
    const src = code('server/src/bootstrap.ts');
    const at = src.indexOf('export async function startConfiguredInstanceServices');
    assert.ok(at > -1, 'startConfiguredInstanceServices is gone — re-anchor this gate');
    assert.match(balancedFrom(src, src.indexOf('{', src.indexOf(')', at)), 'startConfiguredInstanceServices'), /\bstartRoundExpiry\s*\(/);
  });

  it('stopRoundExpiry is called in the shutdown handler before the drain begins', () => {
    const src = code('server/src/index.ts');
    const at = src.search(/\bconst\s+shutdown\s*=\s*async\b/);
    assert.ok(at > -1, 'the shutdown handler is gone — re-anchor this gate');
    const body = balancedFrom(src, src.indexOf('{', src.indexOf('=>', at)), 'the shutdown handler');
    const stop = body.search(/\bstopRoundExpiry\s*\(/);
    const drain = body.indexOf('server.close(');
    assert.ok(drain > -1, 'the handler no longer calls server.close( — re-anchor where the drain begins');
    assert.ok(stop > -1, 'the shutdown handler never stops the round expiry job');
    assert.ok(stop < drain, 'the job is stopped after the drain begins, so a tick can start while requests finish');
  });
});

describe('what it is built from', () => {
  it('walks through eachNetwork, which util/housekeeping-walk.ts exports', () => {
    assert.match(code('server/src/util/housekeeping-walk.ts'), /export\s+(?:const|function)\s+eachNetwork\b/, 'there is no eachNetwork beside eachSpace');
    const src = code(FILE);
    assert.match(src, /\beachNetwork\s*\(/, `${FILE} does not walk through eachNetwork`);
  });

  it('has no hand-written loop over the networks', () => {
    assert.doesNotMatch(code(FILE), /for\s*\(\s*(?:const|let)\s+\w+\s+of\s+[\w$.()?]*\bnetworks\b/, 'a hand-written `for … of networks` is the shape every copy of the space walk had');
  });

  it('applies what it concluded, and audits each round it ended', () => {
    const src = code(FILE);
    assert.match(src, /\bapplyRoundConclusion\s*\(/);
    assert.match(src, /\blogInternalAudit\s*\(/, 'a round the job ends leaves no audit entry');
    assert.match(src, /['"`]network\.round\.expired['"`]/, 'the audit operation is not network.round.expired');
  });

  it('never decides a conclusion by setting its fields: it asks concludeRoundIfReady', () => {
    const src = code(FILE);
    assert.match(src, /\bconcludeRoundIfReady\s*\(/);
    assert.doesNotMatch(src, /\.\s*concluded\s*=[^=]/, 'the job concludes a round by writing `concluded` itself, so what concluding does (revoking a failed join) would be a second copy here');
  });
});
