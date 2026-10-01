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

describe('a network joined before the default existed gets it at boot', () => {
  /*
   * The default only reached networks joined after it shipped. An instance that joined before carries no schedule,
   * syncs only when its peer starts a cycle, and nothing says so — found on a real instance whose two joined networks
   * had none. Manual chosen on purpose is stored as `''` and is left alone; `undefined` is "never stated".
   */
  const give = cfg => {
    assert.equal(typeof schedule.defaultUnstatedJoinedSchedules, 'function', 'the boot rule has no home');
    return schedule.defaultUnstatedJoinedSchedules(cfg);
  };
  it('a joined network with no schedule gets the default, and one of unknown origin too', () => {
    const cfg = { networks: [{ id: 'j', origin: 'joined' }, { id: 'old' }] };
    assert.deepEqual(give(cfg), ['j', 'old']);
    for (const n of cfg.networks) assert.equal(n.syncSchedule, schedule.DEFAULT_JOIN_SYNC_SCHEDULE);
  });
  it('manual chosen on purpose, a stated schedule and a network this instance created are left alone', () => {
    const cfg = { networks: [
      { id: 'manual', origin: 'joined', syncSchedule: '' },
      { id: 'stated', origin: 'joined', syncSchedule: '0 * * * *' },
      { id: 'mine', origin: 'created' },
    ] };
    assert.deepEqual(give(cfg), []);
    assert.deepEqual(cfg.networks.map(n => n.syncSchedule), ['', '0 * * * *', undefined]);
  });
  it('settles: a second boot changes nothing', () => {
    const cfg = { networks: [{ id: 'j', origin: 'joined' }] };
    give(cfg);
    assert.deepEqual(give(cfg), []);
  });
  it('turning scheduling off stores manual as a choice, not as never-stated', async () => {
    const { readFileSync } = await import('node:fs');
    const acts = readFileSync('server/src/networks/network-acts.ts', 'utf8');
    assert.doesNotMatch(acts, /net\.syncSchedule = parsed\.data\.syncSchedule \|\| undefined/,
      'clearing the schedule stores undefined, so the boot rule would switch a deliberate manual network back on');
    const join = readFileSync('server/src/networks/join-remote-act.ts', 'utf8');
    assert.doesNotMatch(join, /armSchedule = schedule \|\| undefined/,
      'a join that states manual stores undefined, which the boot rule reads as never stated');
  });
});
