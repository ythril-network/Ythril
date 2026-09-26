/**
 * `?embedded=1` survives a sign-in round trip in the same tab, and nothing else.
 *
 * A sign-in inside the frame is a NEW document whose query is `code` and `state`; the flag was read from the URL
 * only, so the topbar and Sign out came back after the first sign-in (reported by the portal team, 2026-09-26).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { EmbedService } from './embed.service';

function boot(search: string): boolean {
  window.history.replaceState(null, '', `/brain${search}`);
  TestBed.resetTestingModule();
  return TestBed.inject(EmbedService).embedded();
}

describe('EmbedService', () => {
  beforeEach(() => sessionStorage.clear());

  it('reads the flag from the URL', () => {
    expect(boot('?embedded=1')).toBe(true);
    expect(boot('?embedded=0')).toBe(false);
  });

  it('keeps it across a new document in the same tab — the sign-in callback carries only code and state', () => {
    expect(boot('?embedded=1')).toBe(true);
    expect(boot('?code=abc&state=xyz')).toBe(true);
  });

  it('a tab that never carried the flag stays the full shell', () => {
    expect(boot('?code=abc&state=xyz')).toBe(false);
  });

  it('an explicit ?embedded=0 clears what the tab remembered', () => {
    boot('?embedded=1');
    expect(boot('?embedded=0')).toBe(false);
    expect(boot('')).toBe(false);
  });
});
