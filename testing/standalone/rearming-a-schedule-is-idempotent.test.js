/**
 * Re-arming a scheduler whose expression has not changed leaves it alone.
 *
 * ## Why this matters, and it is not tidiness
 *
 * The config-reload path re-arms three cron schedulers, and the backup route re-arms a fourth. Both are called
 * on ANY save — a reload triggered by an edit to an unrelated setting, a backup-config save that only changed a
 * retention count. Restarting a `node-cron` task does not just cost a stop and a start: **it resets the phase.**
 * A network on a quarter-hour cron that was ninety seconds from its next sync goes back to a full fifteen
 * minutes, and an operator adjusting three fields in a row pushes it three times.
 *
 * That is the same argument used to keep the INTERVAL-driven sweeps out of the re-arm helper entirely — a
 * six-hour timer whose phase resets on every save may never fire. Applying it only to the sweeps and not to the
 * cron schedulers would be the rule implemented once and skipped next door, which is what this repo's worst
 * defects are made of.
 *
 * ## Why the check is structural
 *
 * Exercising it needs a running instance with a config, a database and real clock time. What can be asserted
 * without one is the property that was missing: each `start*` compares the expression it is ABOUT to arm against
 * the one it has armed, and returns early when they match — and clears that memory when it stops, or a stopped
 * scheduler would look armed and never restart.
 *
 * Run: node --test testing/standalone/rearming-a-schedule-is-idempotent.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf, statementFrom } from './_structural-window.mjs';

/** Every scheduler that captures a cron expression at start time, with the symbol holding what is armed. */
const CRON_SCHEDULERS = [
  { module: 'server/src/brain/dupe-scanner.ts', start: 'startDupeScanner', stop: 'stopDupeScanner' },
  { module: 'server/src/brain/contradiction-scanner.ts', start: 'startContradictionScanner', stop: 'stopContradictionScanner' },
  { module: 'server/src/db/backup-scheduler.ts', start: 'startBackupScheduler', stop: 'stopBackupScheduler' },
  { module: 'server/src/sync/scheduler.ts', start: 'scheduleSyncForNetwork', stop: 'stopSyncScheduler' },
];

/** The shared memory every one of them holds — one rule, one implementation. See `util/armed-schedule.ts`. */
const ARMED = '_armed';

const read = m => stripComments(readFileSync(m, 'utf8'));

describe('each cron scheduler remembers what it armed', () => {
  for (const { module, start } of CRON_SCHEDULERS) {
    it(`${start} asks ${ARMED} before restarting`, () => {
      const src = read(module);
      // The memory names its scheduler (`armedSchedules('<owner>')`), so `armedCronKeys()` can say what this process has armed.
      assert.match(src, new RegExp(`${ARMED} = armedSchedules\\('[^']+'\\)`),
        `${module} does not hold the shared memory, so it has its own bookkeeping to get wrong`);
      const body = bodyOf(src, start);
      /*
       * An early RETURN GUARDED BY THE COMPARISON, and the bound is the STATEMENT that comparison sits in.
       *
       * The first version searched the whole function body for the memory's name followed by a `return` within a
       * hundred-odd characters, and it SURVIVED the mutant that deletes the guard and keeps the bookkeeping: a
       * `forget()` call a few lines above an unrelated `return` satisfied it. A capped window in a gate written
       * the same afternoon the last capped window in this suite was converted — which is the argument for that
       * rule rather than against it.
       *
       * So: find where the armed expression is COMPARED, take the statement it belongs to, and require the
       * return to be inside that statement.
       */
      const cmp = body.indexOf(`${ARMED}.isArmed(`);
      assert.ok(cmp > -1, `${start} never asks whether the expression it is about to arm is already armed`);
      assert.match(statementFrom(body, cmp, `${start}'s already-armed guard`), /return/,
        `${start} asks but does not return on a match, so it still stops and restarts the task`);
    });
  }

  for (const { module, stop } of CRON_SCHEDULERS) {
    it(`${stop} forgets what was armed, or a stopped scheduler looks armed`, () => {
      /*
       * The direction that fails CLOSED and is therefore the one to pin: leave the memory set after a stop and
       * the next `start*` sees a matching expression, returns early, and the scheduler never runs again. A gate
       * that only checked the guard would pass on that.
       */
      const body = bodyOf(read(module), stop);
      assert.ok(body.includes(`${ARMED}.forget(`),
        `${stop} leaves the memory set, so the next start returns early and nothing is ever scheduled again`);
    });
  }
});

describe('the interval-driven sweeps are still excluded', () => {
  it('none of them appears in the re-arm helper', () => {
    // Restated here rather than only in `scheduler-wiring.test.js`, because this file is where somebody
    // reading about phase resets will be — and the conclusion for an interval sweep is the opposite one:
    // it reads its config per run, so it needs no re-arm at all.
    const rearm = read('server/src/schedulers.ts');
    for (const start of ['startTtlSweep', 'startCandidatePrune', 'startChangeRetention', 'startTombstonePrune']) {
      assert.ok(!rearm.includes(`${start}(`),
        `${start} reads its config per run; re-arming it only resets the phase of its timer`);
    }
  });
});
