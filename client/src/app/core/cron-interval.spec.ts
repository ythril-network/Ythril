/**
 * `cronIntervalMinutes` answers for the schedules a person writes and says nothing for the ones it does not read (bundle-81, decision 42).
 *
 * The re-read dialog multiplies sync cycles by this number, so a wrong number is a wrong promise about how long the wait is; a `null` makes
 * the dialog say the cycles and no time. Each case names what it holds.
 */
import { describe, it, expect } from 'vitest';
import { cronIntervalMinutes } from './cron-interval';

describe('cronIntervalMinutes', () => {
  it('reads the steps and the hourly and daily forms people write', () => {
    expect(cronIntervalMinutes('*/5 * * * *')).toBe(5);
    expect(cronIntervalMinutes('*/15 * * * *')).toBe(15);
    expect(cronIntervalMinutes('0 * * * *')).toBe(60);
    expect(cronIntervalMinutes('0 */6 * * *')).toBe(360);
    expect(cronIntervalMinutes('30 2 * * *')).toBe(1440);
  });

  it('reads lists and ranges: two runs an hour is thirty minutes, an hourly window is the day over its hours', () => {
    expect(cronIntervalMinutes('0,30 * * * *')).toBe(30);
    expect(cronIntervalMinutes('0 9-17 * * *')).toBe(Math.round(1440 / 9));
  });

  it('reads a leading fixed second, and refuses several runs a minute', () => {
    expect(cronIntervalMinutes('0 */10 * * * *')).toBe(10);
    expect(cronIntervalMinutes('*/10 * * * * *')).toBeNull();
  });

  it('says nothing for manual sync, a restricted day, a name it does not read, or a string that is no schedule', () => {
    expect(cronIntervalMinutes('')).toBeNull();
    expect(cronIntervalMinutes(undefined)).toBeNull();
    expect(cronIntervalMinutes('0 9 * * 1')).toBeNull();
    expect(cronIntervalMinutes('0 9 1 * *')).toBeNull();
    expect(cronIntervalMinutes('0 9 * * mon')).toBeNull();
    expect(cronIntervalMinutes('every 5 minutes')).toBeNull();
    expect(cronIntervalMinutes('*/0 * * * *')).toBeNull();
    expect(cronIntervalMinutes('70 * * * *')).toBeNull();
  });
});
