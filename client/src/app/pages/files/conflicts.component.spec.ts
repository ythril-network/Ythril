/**
 * ConflictsComponent — the cross-space conflict list.
 *
 * The server caps this list (per-space + a total bound) and returns a `truncated` flag so the client can
 * say the operator is NOT seeing every conflict. This pins that the flag surfaces a visible note — a
 * silently-capped list with no signal is exactly the "no silent caps" defect the server change fixes.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { of } from 'rxjs';
import { provideRouter } from '@angular/router';
import { FilesApi } from '../../core/files-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { ConflictsComponent } from './conflicts.component';

function conflict(id: string) {
  return { id, spaceId: 's', originalPath: `a/${id}.txt`, conflictPath: `a/${id}.conflict.txt`, peerInstanceId: 'p', peerInstanceLabel: 'Peer', detectedAt: '2026-07-27T00:00:00.000Z' };
}

describe('ConflictsComponent', () => {
  /** The confirmations the page asked, each as the options it was asked with. */
  let confirms: Array<{ danger?: boolean; message?: string }> = [];
  function create(resp: { conflicts: ReturnType<typeof conflict>[]; truncated?: boolean }) {
    confirms = [];
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      // The note is a plural base said through `pluralText`, which says nothing for a key the harness only echoes.
      imports: [ConflictsComponent, getTranslocoModule({ translation: { en: {
        'conflicts.truncated.one': 'conflicts.truncated', 'conflicts.truncated.other': 'conflicts.truncated',
      } } })],
      providers: [
        provideRouter([]),
        { provide: FilesApi, useValue: { listConflicts: () => of(resp), bulkResolveConflicts: () => of({ resolved: resp.conflicts.length, failed: [] }) } },
        { provide: SpacesApi, useValue: { listSpaces: () => of({ spaces: [] }) } },
        { provide: ToastService, useValue: { success: () => {}, error: () => {} } },
        { provide: ConfirmDialogService, useValue: { confirm: (o: { danger?: boolean; message?: string }) => { confirms.push(o); return Promise.resolve(true); } } },
      ],
    });
    const fixture = TestBed.createComponent(ConflictsComponent);
    fixture.detectChanges(); // ngOnInit → load() resolves synchronously via of()
    return fixture;
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('shows the truncation note when the server reports truncated:true', () => {
    const fixture = create({ conflicts: [conflict('a'), conflict('b')], truncated: true });
    expect(fixture.componentInstance.truncated()).toBe(true);
    const note = fixture.nativeElement.querySelector('.alert-info');
    expect(note).toBeTruthy();
    // Test transloco renders raw keys, so assert the note binds the truncation message key.
    expect((note as HTMLElement).textContent).toContain('conflicts.truncated');
  });

  describe('a metadata conflict (Q-426)', () => {
    const metadata = () => ({
      id: 'm', spaceId: 's', kind: 'metadata' as const, originalPath: 'a/notes.md', peerInstanceId: 'p', peerInstanceLabel: 'Peer', detectedAt: '2026-10-30T00:00:00.000Z',
      seq: 5, losing: { description: 'what I wrote', tags: ['t'] }, current: { description: 'what the peer wrote', tags: ['t'] },
    });

    it('lists the fields that differ between the displaced and the standing metadata, and no others', () => {
      const fixture = create({ conflicts: [metadata() as never] });
      const rows = (fixture.componentInstance as unknown as { diffRows(c: unknown): unknown[] }).diffRows(metadata());
      expect(rows).toEqual([{ field: 'description', mine: 'what I wrote', theirs: 'what the peer wrote' }]);
      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('what I wrote');
      expect(text).toContain('what the peer wrote');
    });

    it('offers keep-local and keep-incoming only, under the metadata words, and never the two a copy needs', () => {
      const fixture = create({ conflicts: [metadata() as never, conflict('c') as never] });
      // The conflict rows only: the metadata conflict's own diff is a table inside its row.
      const rows = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('table:not(.meta-diff) > tbody > tr'));
      expect(rows.length).toBe(2);
      const rowSelects = rows.map(tr => Array.from(tr.querySelectorAll('select option')).map(o => (o as HTMLOptionElement).value));
      expect(rowSelects[0]).toEqual(['keep-local', 'keep-incoming']);
      expect(rowSelects[1]).toEqual(['keep-local', 'keep-incoming', 'keep-both', 'save-to-space']);
      const labels = Array.from(rows[0]!.querySelectorAll('select option')).map(o => o.textContent?.trim());
      expect(labels).toEqual(['conflicts.metadata.keepMine', 'conflicts.metadata.keepTheirs']);
    });

    // The review of bundle-45, #3: the bulk bar offers what every selected row accepts, so "keep both" is never offered over a metadata row (each would be refused).
    describe('in the bulk bar', () => {
      const select = (fixture: ReturnType<typeof create>, ids: string[]) => {
        fixture.componentInstance.selectedIds.set(ids);
        fixture.detectChanges();
        const el = (fixture.nativeElement as HTMLElement).querySelector('select[aria-label="conflicts.bulkActionAriaLabel"]') as HTMLSelectElement;
        return Array.from(el.querySelectorAll('option')).map(o => [o.value, o.textContent?.trim()]);
      };

      it('offers only keep-local and keep-incoming, under the metadata words, when every selected row is a metadata conflict', () => {
        const fixture = create({ conflicts: [metadata() as never, { ...metadata(), id: 'm2' } as never] });
        expect(select(fixture, ['m', 'm2'])).toEqual([['keep-local', 'conflicts.metadata.keepMine'], ['keep-incoming', 'conflicts.metadata.keepTheirs']]);
      });

      it('offers only keep-local and keep-incoming, under the copy words, when a metadata conflict is selected beside a file copy', () => {
        const fixture = create({ conflicts: [metadata() as never, conflict('c') as never] });
        expect(select(fixture, ['m', 'c']).map(o => o[0])).toEqual(['keep-local', 'keep-incoming']);
      });

      it('asks the file-replacement confirm for keep-incoming only over file copies: a metadata conflict replaces no file', async () => {
        const only = create({ conflicts: [metadata() as never, { ...metadata(), id: 'm2' } as never] });
        only.componentInstance.selectedIds.set(['m', 'm2']);
        only.componentInstance.bulkAction = 'keep-incoming';
        await only.componentInstance.bulkResolve();
        expect(confirms.map(c => c.danger === true), 'a metadata-only selection was asked as a replacement of files').toEqual([false]);

        const mixed = create({ conflicts: [metadata() as never, conflict('c') as never] });
        mixed.componentInstance.selectedIds.set(['m', 'c']);
        mixed.componentInstance.bulkAction = 'keep-incoming';
        await mixed.componentInstance.bulkResolve();
        expect(confirms.map(c => c.danger === true), 'a selection holding a file copy was not asked as a replacement').toEqual([true]);
      });

      it('falls back to keep-local when the chosen action is not one every selected row accepts', async () => {
        const fixture = create({ conflicts: [metadata() as never, conflict('c') as never] });
        fixture.componentInstance.selectedIds.set(['m', 'c']);
        fixture.componentInstance.bulkAction = 'keep-both';
        fixture.detectChanges();
        const el = (fixture.nativeElement as HTMLElement).querySelector('select[aria-label="conflicts.bulkActionAriaLabel"]') as HTMLSelectElement;
        await fixture.whenStable();
        expect(el.value).toBe('keep-local');
      });

      it('still offers keep-both when only file copies are selected', () => {
        const fixture = create({ conflicts: [conflict('c') as never, conflict('d') as never] });
        expect(select(fixture, ['c', 'd']).map(o => o[0])).toEqual(['keep-local', 'keep-incoming', 'keep-both']);
      });
    });

    it('shows no copy path for it', () => {
      const fixture = create({ conflicts: [metadata() as never] });
      expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('conflict.txt');
    });
  });

  it('shows NO truncation note when the list is complete (truncated falsy)', () => {
    const fixture = create({ conflicts: [conflict('a')] });
    expect(fixture.componentInstance.truncated()).toBe(false);
    expect(fixture.nativeElement.querySelector('.alert-info')).toBeNull();
  });
});
