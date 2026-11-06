/**
 * The networks page asks before leaving with a typed sync schedule that Save has not sent (Q-701).
 *
 * Driven like `networks.component.spec.ts`: the component is created and its public state and methods are driven, never rendered.
 */
import type { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';
import { of, Subject } from 'rxjs';
import type { Network } from '../../core/api.types';
import { NetworksApi } from '../../core/networks-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { AdminApi } from '../../core/admin-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { NetworksComponent } from './networks.component';
import { UnsavedEdits } from '../../core/unsaved-edits';
import { NetworkAddSpaceComponent } from './network-add-space.component';
import { NetworkChangeNotesComponent } from './network-change-notes.component';
import { NetworkPendingSpacesComponent } from './network-pending-spaces.component';
import { NetworkCreateDialogComponent } from './network-create-dialog.component';
import { NetworkJoinDialogComponent } from './network-join-dialog.component';
import { NetworkEnableWizardComponent } from './network-enable-wizard.component';
import { NetworkRereadDialogComponent } from './network-reread-dialog.component';
import { NetworkSyncScheduleComponent } from './network-sync-schedule.component';

const net = (over: Partial<Network> = {}): Network =>
  ({ id: 'n1', label: 'Braintree', type: 'closed', members: [], ...over } as Network);

function open(networks: Network[]) {
  const api = {
    listNetworks: vi.fn(() => of({ networks })),
    listVotes: vi.fn(() => of({ rounds: [] })),
    listVoteOutcomes: vi.fn(() => of({ outcomes: [], total: 0 })),
    updateNetworkSchedule: vi.fn(() => of({})),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [NetworksComponent, getTranslocoModule()],
    providers: [
      { provide: NetworksApi, useValue: api },
      { provide: SpacesApi, useValue: { listSpaces: () => of({ spaces: [] }) } },
      { provide: AdminApi, useValue: { getAbout: () => of({ publicUrl: '' }) } },
      { provide: ToastService, useValue: { error: vi.fn(), success: vi.fn() } },
      { provide: ConfirmDialogService, useValue: { confirm: vi.fn(() => Promise.resolve(true)) } },
    ],
  });
  const c = TestBed.createComponent(NetworksComponent).componentInstance;
  c.load();
  return { c, edits: TestBed.inject(UnsavedEdits) };
}

/** A network card's schedule box (`network-sync-schedule.component.ts`), which owns the typed schedule until Save sends it. */
function schedule(network: Network) {
  const updateNetworkSchedule = vi.fn(() => of({}));
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [NetworkSyncScheduleComponent, getTranslocoModule()],
    providers: [
      { provide: NetworksApi, useValue: { updateNetworkSchedule } },
      { provide: ToastService, useValue: { error: vi.fn(), success: vi.fn() } },
      { provide: ConfirmDialogService, useValue: { confirm: vi.fn(() => Promise.resolve(true)) } },
    ],
  });
  const f = TestBed.createComponent(NetworkSyncScheduleComponent);
  f.componentRef.setInput('network', network);
  const saved: string[] = [];
  f.componentInstance.saved.subscribe(s => saved.push(s));
  return { c: f.componentInstance, edits: TestBed.inject(UnsavedEdits), saved, updateNetworkSchedule };
}

describe('the networks page holds its sync schedule drafts (Q-701)', () => {
  it('the page itself loads clean', () => {
    expect(open([net({ syncSchedule: '0 * * * *' })]).edits.any()).toBe(false);
  });

  it('is clean when untouched', () => {
    expect(schedule(net({ syncSchedule: '0 * * * *' })).edits.any()).toBe(false);
  });

  it('a typed schedule is held until it is saved, and the saved value goes to the page', () => {
    const { c, edits, saved, updateNetworkSchedule } = schedule(net());
    c.draft.set('*/15 * * * *');
    expect(edits.any()).toBe(true);
    c.save();
    expect(updateNetworkSchedule).toHaveBeenCalledWith('n1', '*/15 * * * *');
    expect(saved).toEqual(['*/15 * * * *']);
    expect(edits.any()).toBe(false);
  });

  it('typing the saved value back is not a draft', () => {
    const { c, edits } = schedule(net({ syncSchedule: '0 * * * *' }));
    c.draft.set('*/15 * * * *');
    c.draft.set('0 * * * *');
    expect(edits.any()).toBe(false);
  });

  it('Save is in flight while the request is pending, and done when it answers', () => {
    const { c, updateNetworkSchedule } = schedule(net());
    const answer = new Subject<object>();
    updateNetworkSchedule.mockReturnValue(answer as never);
    c.draft.set('0 * * * *');
    c.save();
    expect(c.saving()).toBe(true);
    answer.next({}); answer.complete();
    expect(c.saving()).toBe(false);
  });

  it('a cleared schedule on a network that had one is held', () => {
    const { c, edits } = schedule(net({ syncSchedule: '0 * * * *' }));
    c.draft.set('');
    expect(edits.any()).toBe(true);
  });

  it('the page keeps its list in step with a saved schedule', () => {
    const { c } = open([net({ id: 'n1' }), net({ id: 'n2' })]);
    c.scheduleSaved('n2', '0 3 * * *');
    expect(c.networks().find(n => n.id === 'n2')!.syncSchedule).toBe('0 3 * * *');
    c.scheduleSaved('n2', '');
    expect(c.networks().find(n => n.id === 'n2')!.syncSchedule, 'an empty schedule clears it').toBeUndefined();
  });
});

/** The network page's card sections and dialogs, each a child component that owns its own draft. */
describe('the networks page children hold their drafts (Q-701)', () => {
  function child<T>(component: Type<T>, inputs: Record<string, unknown>, providers: unknown[] = []) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [component, getTranslocoModule()],
      providers: [
        { provide: NetworksApi, useValue: apiStub },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
        { provide: ConfirmDialogService, useValue: { confirm: vi.fn(() => Promise.resolve(true)) } },
        ...providers,
      ] as never[],
    });
    const fixture = TestBed.createComponent(component);
    for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
    fixture.detectChanges();
    return { c: fixture.componentInstance, fixture, edits: TestBed.inject(UnsavedEdits) };
  }
  const apiStub = {
    addNetworkSpace: vi.fn(() => of({ status: 'added' })),
    syncWithNote: vi.fn(() => of({ ok: true })),
    changeNotes: vi.fn(() => of({ notes: [] })),
    resolvePendingSpace: vi.fn(() => of({})),
    createNetwork: vi.fn(() => of({ id: 'new', label: 'x' })),
    joinRemote: vi.fn(() => of({ status: 'joined', networkLabel: 'X' })),
    joinByKey: vi.fn(() => of({ status: 'joined', networkLabel: 'X' })),
    getLocalAgentStatus: vi.fn(() => of({ canExecute: false })),
    bootstrapLocalAgent: vi.fn(() => of({})),
    executeEnableNetworksViaLocalAgent: vi.fn(() => of({ message: 'done', publicUrl: 'https://x.example' })),
  };
  const publisherNet = { id: 'n1', label: 'Net', type: 'pubsub', spaces: ['alpha', 'beta'], members: [], myRole: { role: 'publisher', members: ['m1'] } };

  it('add-space: a picked space is held until it is added', () => {
    const { c, edits } = child(NetworkAddSpaceComponent, { network: publisherNet, spaces: [{ id: 'gamma', label: 'Gamma' }] });
    expect(edits.any()).toBe(false);
    c.picked = 'gamma';
    expect(edits.any()).toBe(true);
    c.add();
    expect(edits.any()).toBe(false);
  });

  it('change-notes: a typed note is held until it is sent', () => {
    const { c, edits } = child(NetworkChangeNotesComponent, { network: publisherNet });
    expect(edits.any()).toBe(false);
    c.draft.set('the schema changed');
    expect(edits.any()).toBe(true);
    c.send();
    expect(edits.any()).toBe(false);
  });

  it('change-notes: picked spaces are held with an empty note', () => {
    const { c, edits } = child(NetworkChangeNotesComponent, { network: publisherNet });
    c.togglePick('beta');
    expect(edits.any()).toBe(true);
  });

  it('pending-spaces: a typed local id is held until the space is resolved', () => {
    const { c, edits } = child(NetworkPendingSpacesComponent, { network: { ...publisherNet, pendingSpaces: [{ networkId: 'x', why: 'w' }] } });
    expect(edits.any()).toBe(false);
    c.mapTo['x'] = 'mine';
    expect(edits.any()).toBe(true);
    c.resolve('x', 'accept');
    expect(edits.any()).toBe(false);
  });

  it('create-dialog: a typed label is held until the network is created', () => {
    const { c, edits } = child(NetworkCreateDialogComponent, {});
    expect(edits.any()).toBe(false);
    c.form.label = 'Field offices';
    expect(edits.any()).toBe(true);
    c.createNetwork();
    expect(edits.any()).toBe(false);
  });

  it('create-dialog: a picked space is held', () => {
    const { c, edits } = child(NetworkCreateDialogComponent, { availableSpaces: [{ id: 'a' }] });
    c.toggleNetworkSpace('a');
    expect(edits.any()).toBe(true);
  });

  it('join-dialog: a pasted invite is held until the join is sent', () => {
    const { c, edits } = child(NetworkJoinDialogComponent, { myUrl: 'https://me.example' });
    expect(edits.any()).toBe(false);
    c.joinBundle = JSON.stringify({ handshakeId: 'h', inviteUrl: 'u', rsaPublicKeyPem: 'k', networkId: 'n1' });
    expect(edits.any()).toBe(true);
    c.joinNetwork();
    expect(edits.any()).toBe(false);
  });

  it('enable-wizard: a typed hostname is held until the setup succeeds', () => {
    const { c, edits } = child(NetworkEnableWizardComponent, {});
    expect(edits.any()).toBe(false);
    c.enableHostname = 'brain.example.com';
    expect(edits.any()).toBe(true);
    c.enableAcknowledgeCritical = true;
    c.runEnableNetworksAutomatically();
    expect(edits.any()).toBe(false);
  });

  it('reread-dialog: a typed name and an unticked space are held until the request is sent', () => {
    const { c, fixture, edits } = child(NetworkRereadDialogComponent, { networkName: 'Net', spaces: [{ id: 'a', records: 1 }, { id: 'b', records: 2 }] });
    expect(edits.any()).toBe(false);
    (c as unknown as { typedName: { set(v: string): void } }).typedName.set('Net');
    expect(edits.any()).toBe(true);
    fixture.componentRef.setInput('busy', true);
    expect(edits.any()).toBe(false);
    fixture.componentRef.setInput('busy', false);
    (c as unknown as { typedName: { set(v: string): void } }).typedName.set('');
    (c as unknown as { toggle(id: string): void }).toggle('b');
    expect(edits.any()).toBe(true);
  });

  it('a dialog that is closed takes its draft with it', () => {
    const { c, fixture, edits } = child(NetworkCreateDialogComponent, {});
    c.form.label = 'x';
    expect(edits.any()).toBe(true);
    fixture.destroy();
    expect(edits.any()).toBe(false);
  });
});
