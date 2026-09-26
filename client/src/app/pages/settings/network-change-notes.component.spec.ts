/**
 * NetworkChangeNotesComponent — the "Change notes" section of a network card (F-42).
 *
 * Three things a user sees, each pinned here: the composer shows only for a role with somebody below it (a
 * subscriber has nothing to send to), a sent note goes to the sync door with its spaces, and a note's markdown is
 * rendered through the app's one sanitising pipeline rather than shown as raw asterisks.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import { NetworksApi } from '../../core/networks-api.service';
import { ToastService } from '../../core/toast.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { NetworkChangeNotesComponent } from './network-change-notes.component';

const note = { _id: 'n-1', networkId: 'net', direction: 'in', note: 'The **Task** type gained a due date.', spaces: [], author: 'op', generated: false, createdAt: '2026-09-26T00:00:00Z', receivedAt: '2026-09-26T00:00:01Z' };
const network = (role: string, members: string[] = ['m1']) =>
  ({ id: 'net', label: 'Net', type: 'pubsub', spaces: ['alpha', 'beta'], members: [], myRole: { role, members } }) as never;

describe('NetworkChangeNotesComponent', () => {
  let api: { changeNotes: ReturnType<typeof vi.fn>; syncWithNote: ReturnType<typeof vi.fn> };

  function make(net: unknown) {
    api = { changeNotes: vi.fn(() => of({ notes: [note] })), syncWithNote: vi.fn(() => of({ ok: true, noteId: 'x' })) };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [NetworkChangeNotesComponent, getTranslocoModule()],
      providers: [
        { provide: NetworksApi, useValue: api },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(NetworkChangeNotesComponent);
    fixture.componentRef.setInput('network', net);
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('a publisher with subscribers can send; a subscriber cannot', () => {
    expect(make(network('publisher')).componentInstance.canSend()).toBe(true);
    expect(make(network('subscriber', ['pub'])).componentInstance.canSend()).toBe(false);
    expect(make(network('publisher', [])).componentInstance.canSend()).toBe(false);
  });

  it('opening loads what arrived, and what was sent where this instance sends', () => {
    const f = make(network('publisher'));
    f.componentInstance.toggle();
    expect(api.changeNotes).toHaveBeenCalledWith('net', 'in');
    expect(api.changeNotes).toHaveBeenCalledWith('net', 'out');
    const sub = make(network('subscriber', ['pub']));
    sub.componentInstance.toggle();
    expect(api.changeNotes).toHaveBeenCalledTimes(1);
  });

  it('send() posts the note and the picked spaces to the sync door', () => {
    const c = make(network('publisher')).componentInstance;
    c.draft.set('  schema changed  ');
    c.togglePick('beta');
    c.send();
    expect(api.syncWithNote).toHaveBeenCalledWith('net', 'schema changed', ['beta']);
    expect(c.draft()).toBe('');
  });

  it('a note body is rendered as markdown, not shown as raw asterisks', async () => {
    const f = make(network('subscriber', ['pub']));
    f.componentInstance.toggle();
    await vi.waitFor(() => { f.detectChanges(); expect(f.nativeElement.querySelector('.note-body.md strong')?.textContent).toBe('Task'); });
    expect(f.nativeElement.textContent).not.toContain('**Task**');
  });
});
