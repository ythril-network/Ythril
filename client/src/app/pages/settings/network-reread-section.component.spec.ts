/**
 * The "Re-read" section of a network card (bundle-81, layout B): what a member still owes, and the control that starts a re-read.
 *
 * The dialog itself is `network-reread-dialog.component.spec.ts`. This is what the section does around it: it is an administrator's (the owed
 * marker is served to administrators only), it lists who owes which space in words a screen reader gets as well, it opens the dialog with the
 * spaces and their counts, and it makes the request: no `spaces` when every space is chosen, the chosen ones when fewer, the route's refusal in
 * the dialog when it is refused.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { NetworkRereadSectionComponent } from './network-reread-section.component';
import { NetworksApi } from '../../core/networks-api.service';
import { ToastService } from '../../core/toast.service';
import type { Network } from '../../core/api.types';

const net = (over: Partial<Network> = {}): Network => ({
  id: 'n1', label: 'Field offices', type: 'closed', spaces: ['general', 'notes'], syncSchedule: '*/5 * * * *',
  members: [{ instanceId: 'berlin-1111', label: 'Berlin', url: 'https://b.example' }, { instanceId: 'gdansk-2222', label: 'Gdansk', url: 'https://g.example' }],
  rereadOwed: [], spaceRecordCounts: { general: 4210, notes: 18730 },
  ...over,
});

function make(network: Network, rereadNetwork: (...a: unknown[]) => unknown = () => of({})) {
  TestBed.resetTestingModule();
  const success = vi.fn();
  TestBed.configureTestingModule({
    imports: [NetworkRereadSectionComponent, getTranslocoModule()],
    providers: [{ provide: NetworksApi, useValue: { rereadNetwork } }, { provide: ToastService, useValue: { success, error: vi.fn() } }],
  });
  const f = TestBed.createComponent(NetworkRereadSectionComponent);
  f.componentRef.setInput('network', network);
  const started = vi.fn();
  f.componentInstance.started.subscribe(started);
  f.detectChanges();
  const el = f.nativeElement as HTMLElement;
  const open = () => { (el.querySelector('button.btn-danger') as HTMLButtonElement).click(); f.detectChanges(); };
  const typeNameAndConfirm = () => {
    const input = el.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = 'Field offices'; input.dispatchEvent(new Event('input')); f.detectChanges();
    (el.querySelector('button[data-confirm]') as HTMLButtonElement).click(); f.detectChanges();
  };
  return { f, el, open, typeNameAndConfirm, started, success };
}

describe('NetworkRereadSectionComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('is an administrator\'s: a view that carries none of the administrator\'s fields shows no section', () => {
    expect(make(net({ rereadOwed: undefined, spaceRecordCounts: undefined })).el.textContent?.trim()).toBe('');
  });

  it('says nothing is owed when the list is empty, and lists each member with its spaces, a dot and words for each', () => {
    expect(make(net()).el.textContent).toContain('networks.reread.none');
    const owed = make(net({ rereadOwed: [
      { instanceId: 'berlin-1111', space: 'general', state: 'catching' }, { instanceId: 'berlin-1111', space: 'notes', state: 'owed' },
    ] }));
    expect(owed.el.textContent).toContain('Berlin');
    const chips = [...owed.el.querySelectorAll('.badge')];
    expect(chips.map(c => c.textContent)).toEqual([expect.stringContaining('general'), expect.stringContaining('notes')]);
    expect(chips[0]!.querySelector('.sr-only')!.textContent).toContain('networks.reread.member.catchingUp');
    expect(chips[1]!.querySelector('.sr-only')!.textContent).toContain('networks.reread.member.owed');
  });

  it('shows four spaces of a member and counts the rest', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map(space => ({ instanceId: 'berlin-1111', space, state: 'owed' as const }));
    const { el } = make(net({ rereadOwed: many }));
    expect(el.querySelectorAll('.badge').length).toBe(4);
    expect(el.textContent).toContain('networks.reread.more');
  });

  it('offers no control for a network with no space, and says why', () => {
    const { el } = make(net({ spaces: [] }));
    expect((el.querySelector('button.btn-danger') as HTMLButtonElement).disabled).toBe(true);
    expect(el.textContent).toContain('networks.reread.noSpaces');
  });

  it('every space chosen is sent as no `spaces` at all, and the card is told to reload', () => {
    const rereadNetwork = vi.fn(() => of({}));
    const { open, typeNameAndConfirm, started, success } = make(net(), rereadNetwork);
    open();
    typeNameAndConfirm();
    expect(rereadNetwork).toHaveBeenCalledWith('n1', undefined);
    expect(started).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalled();
  });

  it('fewer spaces chosen are sent by name', () => {
    const rereadNetwork = vi.fn(() => of({}));
    const { el, f, open, typeNameAndConfirm } = make(net(), rereadNetwork);
    open();
    (el.querySelectorAll('input[type="checkbox"]')[1] as HTMLInputElement).click();
    f.detectChanges();
    typeNameAndConfirm();
    expect(rereadNetwork).toHaveBeenCalledWith('n1', ['general']);
  });

  it('a refused request keeps the dialog open and says why inside it', () => {
    const { el, open, typeNameAndConfirm, started } = make(net(), () => throwError(() => ({ status: 403, statusText: 'Forbidden', error: { error: 'Admin only' } })));
    open();
    typeNameAndConfirm();
    expect(el.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain('Admin only');
    expect(started).not.toHaveBeenCalled();
  });
});
