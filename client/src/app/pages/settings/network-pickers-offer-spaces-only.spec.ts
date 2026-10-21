/**
 * Network pickers offer concrete spaces only, the join dialog still sees retired proxy ids, and the rights matrix has no view rows
 * (Q-531, bundle-100, plan rev 3.2 "Client" and ux S5).
 *
 * ## The rules
 *
 * 1. **Concrete spaces only.** The space list the Networks page hands to its pickers (create, add-space, join's map-to-existing) is
 *    the spaces `GET /api/spaces` answers - never a personal view, even while the ViewsStore holds some, and never a retired id.
 * 2. **Retired ids are still collisions.** `GET /api/spaces` answers `retiredSpaceIds` (to an admin); the page hands them to the join
 *    dialog (`retiredSpaceIds` input), whose collision check (`existsLocally`) counts a retired id as taken and whose alias check
 *    refuses one, naming it, before the join is sent - the server would refuse it after the handshake (createSpace, rename and join
 *    refuse a retired id until it is purged).
 * 3. **No view rows in the rights matrix.** Every host of `<app-rights-matrix>` feeds its `spaces` from the space list, never from
 *    the views (a view is not a space and holds no rights).
 *
 * ## Seen red at 18e8d598, and what is not red
 *
 * 2 is red: the join dialog has no `retiredSpaceIds` input (NG0303 on `setInput`) and the page drops the field. 1 and 3 hold at the
 * base (views do not exist yet); they are kept so that wiring a view into a picker or the matrix fails here.
 */
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { NetworksApi } from '../../core/networks-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { AdminApi } from '../../core/admin-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { CLIENT_ROOT, trackedAppSources } from '../../testing/tracked-sources';
import { VIEW_LENS, flushViews } from '../../testing/personal-views';
import { NetworksComponent } from './networks.component';
import { NetworkJoinDialogComponent } from './network-join-dialog.component';

const SPACES = [{ id: 'qa', label: 'qa' }, { id: 'ops', label: 'ops' }];
const RETIRED = 'oldteam';

function host() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [NetworksComponent, getTranslocoModule()],
    providers: [
      provideHttpClient(), provideHttpClientTesting(),
      { provide: NetworksApi, useValue: { listNetworks: vi.fn(() => of({ networks: [] })), listVotes: vi.fn(() => of({ rounds: [] })) } },
      { provide: SpacesApi, useValue: { listSpaces: () => of({ spaces: SPACES, retiredSpaceIds: [RETIRED] }) } },
      { provide: AdminApi, useValue: { getAbout: () => of({ publicUrl: '' }) } },
      { provide: ToastService, useValue: { error: vi.fn(), success: vi.fn() } },
      { provide: ConfirmDialogService, useValue: { confirm: vi.fn(() => Promise.resolve(true)) } },
    ],
  });
  const fixture = TestBed.createComponent(NetworksComponent);
  fixture.detectChanges();
  flushViews(TestBed.inject(HttpTestingController), [VIEW_LENS]);
  fixture.detectChanges();
  return fixture;
}

function joinDialog() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [NetworkJoinDialogComponent, getTranslocoModule()],
    providers: [{ provide: NetworksApi, useValue: { joinRemote: vi.fn(() => of({ status: 'joined' })), joinByKey: vi.fn() } }],
  });
  const f = TestBed.createComponent(NetworkJoinDialogComponent);
  f.componentRef.setInput('myUrl', 'https://me.example');
  f.componentRef.setInput('availableSpaces', SPACES as never);
  return f;
}

describe('network pickers and personal views (Q-531)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('the pickers are handed the concrete spaces: no view, no retired id', () => {
    const c = host().componentInstance as any;
    expect(c.availableSpaces().map((s: { id: string }) => s.id)).toEqual(['qa', 'ops']);
  });

  it('the join dialog counts a retired id as taken and refuses it as an alias, naming it', () => {
    const f = joinDialog();
    f.componentRef.setInput('retiredSpaceIds', [RETIRED]);
    const c = f.componentInstance as any;
    expect(c.existsLocally(RETIRED), 'a retired id is offered as free').toBe(true);
    c.joinBundle = JSON.stringify({ handshakeId: 'h', inviteUrl: 'u', rsaPublicKeyPem: 'k', networkId: 'n1', spaces: ['remote'] });
    c.joinNetwork();
    c.onCollisionActionChange('remote', 'alias');
    c.joinSpaceAliases['remote'] = RETIRED;
    c.confirmJoin();
    expect(c.joinError(), 'an alias naming a retired id was accepted').toBeTruthy();
    expect(String(c.joinError())).toContain(RETIRED);
  });

  it('the Networks page hands the retired ids it was served to the join dialog', () => {
    const f = host();
    (f.componentInstance as any).showJoinDialog.set(true);
    f.detectChanges();
    const dialog = f.debugElement.query(By.directive(NetworkJoinDialogComponent))?.componentInstance as any;
    expect(dialog, 'the join dialog did not render').toBeTruthy();
    expect(typeof dialog.retiredSpaceIds, 'the join dialog has no retiredSpaceIds input').toBe('function');
    expect(dialog.retiredSpaceIds()).toEqual([RETIRED]);
  });

  it('every host of the rights matrix feeds it spaces, never views', () => {
    const hosts = trackedAppSources()
      .map(file => ({ file, src: readFileSync(resolve(CLIENT_ROOT, file), 'utf8') }))
      .filter(({ src }) => src.includes('<app-rights-matrix'));
    expect(hosts.length, 'no host of <app-rights-matrix> found: the derivation is broken').toBeGreaterThanOrEqual(3);
    const fedViews = hosts.filter(({ src }) => /\bViewsStore\b|\bviews\(\)/.test(src)).map(h => h.file);
    expect(fedViews, 'rights-matrix hosts that read the personal views').toEqual([]);
  });
});
