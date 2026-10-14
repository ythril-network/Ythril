import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EMPTY_FOR_MS, LiveAnnouncement } from './live-announcement';

const make = (): LiveAnnouncement => TestBed.runInInjectionContext(() => new LiveAnnouncement());

beforeEach(() => { TestBed.resetTestingModule(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe('LiveAnnouncement', () => {
  it('says a sentence after the gap, and holds it', () => {
    const a = make();
    a.say('Deleted a.txt');
    expect(a.text()).toBe('');
    vi.advanceTimersByTime(EMPTY_FOR_MS);
    expect(a.text()).toBe('Deleted a.txt');
  });

  it('the SAME sentence said again empties the region first, so it changes twice', () => {
    const a = make();
    a.say('Deleted a.txt');
    vi.advanceTimersByTime(EMPTY_FOR_MS);
    a.say('Deleted a.txt');
    expect(a.text(), 'cleared the moment it is said again').toBe('');
    vi.advanceTimersByTime(EMPTY_FOR_MS);
    expect(a.text()).toBe('Deleted a.txt');
  });

  it('a call made while one is pending replaces it: the region ends on the latest', () => {
    const a = make();
    a.say('first');
    vi.advanceTimersByTime(EMPTY_FOR_MS - 1);
    a.say('second');
    vi.advanceTimersByTime(EMPTY_FOR_MS);
    expect(a.text()).toBe('second');
  });

  it('a pending sentence is dropped when the owner is destroyed', () => {
    const a = make();
    a.say('never heard');
    TestBed.resetTestingModule();
    vi.advanceTimersByTime(EMPTY_FOR_MS * 2);
    expect(a.text()).toBe('');
  });
});
