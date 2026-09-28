/**
 * A joined network syncs on a schedule: the one the joiner stated, else the inviter's, else the default (`Q-137`).
 *
 * The join built the joiner's network with no `syncSchedule`, which `resolveSyncCron` reads as manual-only — so a
 * subscriber never pulled on its own, and the "every 15 minutes" an operator was promised never came. The rule is a
 * truth table, so it is tested as one:
 *
 * | stated                 | offered by the inviter          | the joiner syncs on          |
 * |------------------------|---------------------------------|------------------------------|
 * | a schedule             | anything                        | the stated one               |
 * | `''` (manual, chosen)  | anything                        | manual                       |
 * | absent                 | a schedule the door would accept| the inviter's                |
 * | absent                 | absent, empty, invalid, shorthand| `DEFAULT_JOIN_SYNC_SCHEDULE` |
 *
 * Run: node --test testing/standalone/a-joined-network-syncs-on-a-schedule.test.js (after `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const schedule = await import('../../server/dist/sync/schedule.js');
const pick = (stated, offered) => {
  assert.equal(typeof schedule.joinedSyncSchedule, 'function', 'joinedSyncSchedule does not exist — the rule has no home');
  return schedule.joinedSyncSchedule(stated, offered);
};

describe('the schedule a joiner syncs on', () => {
  it('the default is a schedule the door itself would accept, not manual', () => {
    const d = schedule.DEFAULT_JOIN_SYNC_SCHEDULE;
    assert.equal(typeof d, 'string');
    assert.ok(d.length > 0, 'the default is manual, which is the defect');
    assert.equal(schedule.syncScheduleRefusal(d), null, `the default "${d}" is one the door refuses`);
  });

  it('a stated schedule wins over the inviter\'s', () => {
    assert.equal(pick('*/3 * * * *', '*/7 * * * *'), '*/3 * * * *');
  });

  it('a stated empty schedule is manual on purpose, and stays manual', () => {
    assert.equal(pick('', '*/7 * * * *'), '');
  });

  it('with nothing stated, the inviter\'s schedule is adopted', () => {
    assert.equal(pick(undefined, '*/7 * * * *'), '*/7 * * * *');
  });

  it('with nothing stated, an inviter that offers nothing usable gives the default, never manual', () => {
    for (const offered of [undefined, '', '   ', 'not a cron', 'every 5m', 42, null]) {
      assert.equal(pick(undefined, offered), schedule.DEFAULT_JOIN_SYNC_SCHEDULE,
        `offered ${JSON.stringify(offered)} did not fall back to the default`);
    }
  });
});
