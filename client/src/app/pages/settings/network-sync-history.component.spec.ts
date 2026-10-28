/**
 * NetworkSyncHistoryComponent — the "Sync history" section of a network card.
 *
 * What a user sees, each pinned here: the section is closed until its title is clicked, opening it loads that
 * network's history once, and the three outcomes are told apart (no history yet, a load that failed with a retry, and
 * the rows). A row with errors shows them only on request, one row at a time.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
