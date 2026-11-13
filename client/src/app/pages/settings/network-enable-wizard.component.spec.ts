/**
 * NetworkEnableWizardComponent — characterization tests, relocated from networks.component.spec.ts when
 * the enable-networks wizard was extracted into its own child component (PR-U3). Pins the hostname
 * validation, the generated Cloudflare commands, the local-agent probe→bootstrap path, and the two
 * completion paths. The only shape change from the inline version: success now EMITS `enabled(url)` (and
 * `close` for the confirm-and-adopt finish) instead of mutating the host's URL/needsNetworkEnable.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import { NetworksApi } from '../../core/networks-api.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { NetworkEnableWizardComponent } from './network-enable-wizard.component';

describe('NetworkEnableWizardComponent (characterization)', () => {
  let api: any;
  let confirmResult: boolean;
  let confirm: ReturnType<typeof vi.fn>;

  function make() {
    api = {
      getLocalAgentStatus: vi.fn(() => of({ canExecute: false })),
      bootstrapLocalAgent: vi.fn(() => of({})),
      executeEnableNetworksViaLocalAgent: vi.fn(() => of({ message: 'done', publicUrl: 'https://x.example' })),
    };
    confirmResult = true;
    confirm = vi.fn(() => Promise.resolve(confirmResult));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [NetworkEnableWizardComponent, getTranslocoModule()],
      providers: [
        { provide: NetworksApi, useValue: api },
        { provide: ConfirmDialogService, useValue: { confirm } },
      ],
    });
    return TestBed.createComponent(NetworkEnableWizardComponent).componentInstance;
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('initialises at step 1 with clean state and a detected OS', () => {
    const c = make();
    c.ngOnInit();
    expect(c.enableWizardStep()).toBe(1);
    expect(c.enableWizardError()).toBe('');
    expect(c.localAgentCanExecute()).toBe(false);
    expect(['windows', 'linux']).toContain(c.enableOs);
  });

  it('prepareEnableWizardCommands() rejects an invalid hostname and stays put', () => {
    const c = make();
    c.enableWizardStep.set(2);
    c.enableHostname = 'not a hostname';
    c.prepareEnableWizardCommands();
    expect(c.enableWizardError()).toBeTruthy();
    expect(c.enableWizardStep()).toBe(2);
    expect(api.getLocalAgentStatus).not.toHaveBeenCalled();
  });

  it('prepareEnableWizardCommands() builds OS commands (reflecting flags), advances to step 3, probes connector', () => {
    const c = make();
    c.enableHostname = 'brain.example.com';
    c.enableOverwriteDns = true;
    c.prepareEnableWizardCommands();
    expect(c.enableWindowsCommand()).toContain('brain.example.com');
    expect(c.enableWindowsCommand()).toContain('--overwrite-dns');
    expect(c.enableLinuxCommand()).toContain('brain.example.com');
    expect(c.enableWizardStep()).toBe(3);
    expect(api.getLocalAgentStatus).toHaveBeenCalled();
  });

  it('connector already running → no bootstrap needed', () => {
    const c = make();
    api.getLocalAgentStatus.mockReturnValue(of({ canExecute: true, message: 'ready' }));
    c.enableHostname = 'brain.example.com';
    c.prepareEnableWizardCommands();
    expect(c.localAgentCanExecute()).toBe(true);
    expect(api.bootstrapLocalAgent).not.toHaveBeenCalled();
  });

  it('connector not running → bootstrap attempted', () => {
    const c = make();
    api.getLocalAgentStatus.mockReturnValue(of({ canExecute: false }));
    c.enableHostname = 'brain.example.com';
    c.prepareEnableWizardCommands();
    expect(api.bootstrapLocalAgent).toHaveBeenCalled();
  });

  it('completeEnableWizard() confirms, then emits "enabled" with the URL and "close"', async () => {
    const c = make();
    const enabled = vi.fn(), closed = vi.fn();
    c.enabled.subscribe(enabled); c.close.subscribe(closed);
    c.enableHostname = 'brain.example.com';
    confirmResult = true;
    await c.completeEnableWizard();
    expect(enabled).toHaveBeenCalledWith('https://brain.example.com');
    expect(closed).toHaveBeenCalled();
  });

  it('completeEnableWizard() declined → no emit', async () => {
    const c = make();
    const enabled = vi.fn();
    c.enabled.subscribe(enabled);
    c.enableHostname = 'brain.example.com';
    confirmResult = false;
    await c.completeEnableWizard();
    expect(enabled).not.toHaveBeenCalled();
  });

  it('runEnableNetworksAutomatically() guards on hostname and the critical acknowledgement', () => {
    const c = make();
    c.enableHostname = '';
    c.runEnableNetworksAutomatically();
    expect(c.enableWizardError()).toBeTruthy();
    expect(api.executeEnableNetworksViaLocalAgent).not.toHaveBeenCalled();

    c.enableHostname = 'brain.example.com';
    c.enableAcknowledgeCritical = false;
    c.runEnableNetworksAutomatically();
    expect(c.enableWizardError()).toBeTruthy();
    expect(api.executeEnableNetworksViaLocalAgent).not.toHaveBeenCalled();
  });

  it('runEnableNetworksAutomatically(): connector down → bootstrap then execute, emits "enabled" on success', () => {
    const c = make();
    const enabled = vi.fn();
    c.enabled.subscribe(enabled);
    c.enableHostname = 'brain.example.com';
    c.enableAcknowledgeCritical = true;
    c.localAgentCanExecute.set(false);
    c.runEnableNetworksAutomatically();
    expect(api.bootstrapLocalAgent).toHaveBeenCalled();
    expect(api.executeEnableNetworksViaLocalAgent).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'brain.example.com' }));
    expect(enabled).toHaveBeenCalledWith('https://x.example');
  });

  it('runEnableNetworksAutomatically(): connector ready → execute directly, no bootstrap', () => {
    const c = make();
    c.enableHostname = 'brain.example.com';
    c.enableAcknowledgeCritical = true;
    c.localAgentCanExecute.set(true);
    c.runEnableNetworksAutomatically();
    expect(api.bootstrapLocalAgent).not.toHaveBeenCalled();
    expect(api.executeEnableNetworksViaLocalAgent).toHaveBeenCalled();
  });
});
