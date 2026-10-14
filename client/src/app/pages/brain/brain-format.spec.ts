/**
 * Characterization tests for the pure brain formatters, pinned as they moved off BrainComponent
 * (A17.9b-4) into a shared module every drawer/tab owner can import.
 */
import { describe, it, expect } from 'vitest';
import { toLocalDatetime } from './brain-format';

describe('toLocalDatetime', () => {
  it('renders a valid ISO string as local YYYY-MM-DDTHH:mm (zero-padded)', () => {
    // Construct from local parts so the assertion is timezone-independent: 2026-03-04 09:07 local.
    const iso = new Date(2026, 2, 4, 9, 7).toISOString();
    expect(toLocalDatetime(iso)).toBe('2026-03-04T09:07');
  });

  it('returns "" for an unparseable date', () => {
    expect(toLocalDatetime('not-a-date')).toBe('');
  });
});
