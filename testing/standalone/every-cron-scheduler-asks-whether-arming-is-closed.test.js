/**
 * Every cron scheduler asks whether arming is closed before it arms (`Q-474`, `Q-570`).
 *
 * ## The defect it prevents
 *
 * A cron task armed after the shutdown (or a test's teardown) stopped the schedulers keeps the process alive: node-cron's
 * timers are ref'd. The arms that land late are not exotic - a config reload re-arms three schedulers, the network settings
 * act armed sync behind an import nobody awaited, the backup route re-arms backups - and CI's database job twice sat out its
 * 30-minute limit on one. The switch is `closeCronArming()` (`util/armed-schedule.ts`), and it only works if EVERY function
 * that registers a cron task asks it first. Refusing in one scheduler and not the next is the weaker-copy defect CLAUDE.md
 * names, so the rule is asserted over every cron registration there is, not over a list of the four written today.
 *
 * ## What it holds, derived
 *
 * The cron registrations are `_scheduled-jobs.mjs`'s (`schedule(…)` imported from node-cron, with its floor). For each, the
 * top-level function the registration sits in calls `cronArmingRefused(` BEFORE the registration, in its own body: a check
 * after the task is armed has already lost, and a check in another function proves nothing about this one.
 *
 * ## Seen red
 *
 * By hand, put back by hand: on the base (no scheduler asks); then the check removed from one scheduler at a time, and one
 * moved below its registration.
 *
 * Run: node --test testing/standalone/every-cron-scheduler-asks-whether-arming-is-closed.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { moduleIndex, topLevelFunctionSpans } from './_call-graph.mjs';
import { scheduledJobs } from './_scheduled-jobs.mjs';

const index = moduleIndex('server/src');
const crons = scheduledJobs(index).jobs.filter(j => j.kind === 'cron');

describe('every cron registration is refused once arming closes', () => {
  it('the derivation found the cron registrations (its own floor holds; this asserts it ran here)', () => {
    assert.ok(crons.length >= 4, `only ${crons.length} cron registrations found: the derivation is broken, not the code`);
  });

  for (const job of crons) {
    it(`${job.file}: the function that arms the task asks cronArmingRefused() first`, () => {
      const src = index.sources.get(job.file);
      const spans = [...topLevelFunctionSpans(src)]
        .filter(([, s]) => s.start <= job.at && job.at < s.start + s.body.length);
      assert.equal(spans.length, 1, `the cron registration at offset ${job.at} of ${job.file} sits in no single top-level function`);
      const [name, { body, start }] = spans[0];
      const ask = body.search(/\bcronArmingRefused\s*\(/);
      assert.ok(ask > -1, `${name} in ${job.file} arms a cron task without asking whether arming is closed, `
        + 'so a reload or a late arm after the shutdown leaves a task that holds the process');
      assert.ok(start + ask < job.at, `${name} in ${job.file} asks only after it has armed the task`);
    });
  }
});
