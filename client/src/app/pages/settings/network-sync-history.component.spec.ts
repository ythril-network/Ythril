/**
 * NetworkSyncHistoryComponent — the "Sync history" section of a network card.
 *
 * What a user sees, each pinned here: the section is closed until its title is clicked, opening it loads that
 * network's history once, and the three outcomes are told apart (no history yet, a load that failed with a retry, and
 * the rows). A row with errors shows them only on request, one row at a time.
 *
 * ## Bundle-39 (Q-220, Q-265, Q-331): a row says what the cycle said, in the reader's language, and counts every family
 *
 * A cycle's status is a word of the server's (`success`, `partial`, `failed`, and `refused` since a cycle that only met too-old peers is its own
 * word and no longer a failure). The row printed it raw, so a German reader saw an English word and a new word had no colour. The counts were four
 * hand-written keys (`facts + entities + edges`, and `files`): chrono, links and file metadata moved without a number, and `files` read `1 files`.
 * A row written before the families were counted lacks those keys, so a sum over them is `NaN` unless each is read `?? 0`.
 *
 * - the status badge shows the translated word (`sync.status.<status>`; en, de and pl all carry the four);
 * - `refused` has a badge style of its own (the badge is classed `status-refused` and the component defines that class);
 * - the files count is a plural (`1 file`, `2 files`), and the family counts are every count key but `files`, summed with `?? 0`.
 *
 * Red at a0efade0a: the badge shows `partial` raw, no `sync.status.*` key exists, `.status-refused` is defined by no style, `1 files` is printed, and a
 * row with chrono, links and file metadata sums three of its keys.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { of, throwError } from 'rxjs';
import { NetworksApi } from '../../core/networks-api.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { NetworkSyncHistoryComponent } from './network-sync-history.component';

const rec = (id: string, errors?: string[]) => ({
  _id: id, networkId: 'net', status: errors ? 'partial' : 'success', completedAt: '2026-10-28T00:00:00Z', startedAt: '2026-10-28T00:00:00Z',
  pulled: { facts: 1, entities: 2, edges: 0, files: 0 }, pushed: { facts: 0, entities: 0, edges: 3, files: 1 }, ...(errors ? { errors } : {}),
});

describe('NetworkSyncHistoryComponent', () => {
  let api: { getSyncHistory: ReturnType<typeof vi.fn> };

  function make(answer: unknown) {
    api = { getSyncHistory: vi.fn(() => answer) };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [NetworkSyncHistoryComponent, getTranslocoModule()],
      providers: [{ provide: NetworksApi, useValue: api }],
    });
    const fixture = TestBed.createComponent(NetworkSyncHistoryComponent);
    fixture.componentRef.setInput('networkId', 'net');
    fixture.detectChanges();
    return fixture;
  }
  const text = (f: { nativeElement: HTMLElement }) => f.nativeElement.textContent ?? '';
  const rows = (f: { nativeElement: HTMLElement }) => f.nativeElement.querySelectorAll('.history-row').length;

  beforeEach(() => TestBed.resetTestingModule());

  it('is closed until opened, and opening loads that network once', () => {
    const f = make(of({ history: [rec('r1')] }));
    expect(api.getSyncHistory).not.toHaveBeenCalled();
    expect(rows(f)).toBe(0);
    f.componentInstance.toggle();
    f.detectChanges();
    expect(api.getSyncHistory).toHaveBeenCalledTimes(1);
    expect(api.getSyncHistory).toHaveBeenCalledWith('net');
    expect(rows(f)).toBe(1);
    f.componentInstance.toggle();
    f.detectChanges();
    expect(rows(f)).toBe(0);
  });

  it('a network with no history says so', () => {
    const f = make(of({ history: [] }));
    f.componentInstance.toggle();
    f.detectChanges();
    expect(rows(f)).toBe(0);
    expect(f.componentInstance.error()).toBeNull();
    expect(f.nativeElement.querySelector('app-error-state')).toBeNull();
  });

  it('a load that failed shows the error with a retry, never "no history yet"', () => {
    const f = make(throwError(() => ({ status: 500, error: { error: 'store down' } })));
    f.componentInstance.toggle();
    f.detectChanges();
    expect(f.componentInstance.error()).not.toBeNull();
    expect(f.nativeElement.querySelector('app-error-state')).not.toBeNull();
    api.getSyncHistory.mockReturnValue(of({ history: [rec('r1')] }));
    f.componentInstance.retry();
    f.detectChanges();
    expect(f.componentInstance.error()).toBeNull();
    expect(rows(f)).toBe(1);
  });

  it('after a manual sync an open panel loads again and a closed one does not', () => {
    const f = make(of({ history: [] }));
    f.componentInstance.refreshIfOpen();
    expect(api.getSyncHistory).not.toHaveBeenCalled();
    f.componentInstance.toggle();
    f.componentInstance.refreshIfOpen();
    expect(api.getSyncHistory).toHaveBeenCalledTimes(2);
  });

  it("a row's errors show only when asked, one row at a time", () => {
    const f = make(of({ history: [rec('r1', ['peer timed out']), rec('r2', ['bad page'])] }));
    f.componentInstance.toggle();
    f.detectChanges();
    expect(text(f)).not.toContain('peer timed out');
    f.componentInstance.toggleErrors('r1');
    f.detectChanges();
    expect(text(f)).toContain('peer timed out');
    expect(text(f)).not.toContain('bad page');
    f.componentInstance.toggleErrors('r2');
    f.detectChanges();
    expect(text(f)).not.toContain('peer timed out');
    expect(text(f)).toContain('bad page');
  });
});

describe('NetworkSyncHistoryComponent: status words, counts and plurals (bundle-39)', () => {
  const dictOf = (lang: string) => JSON.parse(readFileSync(`public/assets/i18n/${lang}.json`, 'utf8')) as Record<string, string>;
  const EN = dictOf('en');
  const STATUSES = ['success', 'partial', 'failed', 'refused'] as const;

  /** A row as the server writes it now: every family a count, `files` the number of files moved. */
  const row = (id: string, status: string, pulled: Record<string, number>, pushed: Record<string, number>) => ({
    _id: id, networkId: 'net', status, completedAt: '2026-10-28T00:00:00Z', startedAt: '2026-10-28T00:00:00Z', pulled, pushed,
  });

  /** The component, opened, against the REAL English words, so a plural and a status word are read as a user reads them. */
  function open(history: unknown[]) {
    const api = { getSyncHistory: vi.fn(() => of({ history })) };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [NetworkSyncHistoryComponent, getTranslocoModule({ translation: { en: EN } })],
      providers: [{ provide: NetworksApi, useValue: api }],
    });
    const fixture = TestBed.createComponent(NetworkSyncHistoryComponent);
    fixture.componentRef.setInput('networkId', 'net');
    fixture.detectChanges();
    fixture.componentInstance.toggle();
    fixture.detectChanges();
    return fixture;
  }
  const rowsOf = (f: { nativeElement: HTMLElement }) => [...f.nativeElement.querySelectorAll<HTMLElement>('.history-row')];
  const flat = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

  beforeEach(() => TestBed.resetTestingModule());

  it('en, de and pl each carry a word for every status the server writes', () => {
    for (const lang of ['en', 'de', 'pl']) {
      const dict = dictOf(lang);
      const missing = STATUSES.filter(s => !(typeof dict[`sync.status.${s}`] === 'string' && dict[`sync.status.${s}`].length > 0));
      expect(missing, `${lang}.json has no sync.status.<status> key for: ${missing.join(', ')}`).toEqual([]);
    }
  });

  it("the badge shows the translated word of each status, never the server's raw word", () => {
    const f = open(STATUSES.map((s, i) => row(`r${i}`, s, { facts: 1 }, { facts: 1 })));
    const badges = [...f.nativeElement.querySelectorAll<HTMLElement>('.status-badge')].map(b => (b.textContent ?? '').trim());
    expect(badges).toHaveLength(STATUSES.length);
    STATUSES.forEach((s, i) => {
      const want = EN[`sync.status.${s}`] ?? `<no sync.status.${s} key in en.json>`;
      expect(badges[i], `the '${s}' badge says '${badges[i]}', expected the translated word '${want}'`).toBe(want);
    });
  });

  it("a 'refused' row has a badge style of its own, as success, partial and failed have", () => {
    const f = open([row('r1', 'refused', { facts: 1 }, { facts: 0 })]);
    const badge = f.nativeElement.querySelector<HTMLElement>('.status-badge')!;
    expect(badge.classList.contains('status-refused'), 'the badge is not classed status-refused').toBe(true);
    // The component's styles are emulated-encapsulated into <style> elements of the document head.
    const css = [...document.querySelectorAll('style')].map(el => el.textContent ?? '').join(' ');
    for (const s of STATUSES) expect(css.includes(`.status-${s}`), `no style defines .status-${s}`).toBe(true);
  });

  it('the files count is a plural: 1 file, 2 files', () => {
    const f = open([row('r1', 'success', { facts: 0, entities: 0, edges: 0, chrono: 0, links: 0, filemeta: 0, files: 1 }, { facts: 0, entities: 0, edges: 0, chrono: 0, links: 0, filemeta: 0, files: 2 })]);
    const t = flat(rowsOf(f)[0]);
    expect(t, `'${t}' prints a count of one as a plural`).not.toMatch(/\b1 files\b/);
    expect(t).toMatch(/\b1 file\b/);
    expect(t).toMatch(/\b2 files\b/);
  });

  it('every family count is summed except the files moved, which is shown apart', () => {
    // pulled: 1+2+3+4+5+6 = 21 records and 7 files; pushed: 1+1+1+1+1+8 = 13 records and 0 files.
    const f = open([row('r1', 'success',
      { facts: 1, entities: 2, edges: 3, chrono: 4, links: 5, filemeta: 6, files: 7 },
      { facts: 1, entities: 1, edges: 1, chrono: 1, links: 1, filemeta: 8, files: 0 })]);
    const t = flat(rowsOf(f)[0]);
    expect(t, `'${t}'`).toMatch(/↓\s*21\b/);
    expect(t, `'${t}'`).toMatch(/↑\s*13\b/);
    expect(t).toMatch(/\b7 files\b/);
  });

  it('a row written before chrono, links and file metadata were counted reads each as 0, never NaN', () => {
    const f = open([row('old', 'success', { facts: 1, entities: 2, edges: 0, files: 0 }, { facts: 0, entities: 0, edges: 3, files: 1 })]);
    const t = flat(rowsOf(f)[0]);
    expect(t).not.toMatch(/NaN|undefined/);
    expect(t, `'${t}'`).toMatch(/↓\s*3\b/);
    expect(t, `'${t}'`).toMatch(/↑\s*3\b/);
  });
});
