/**
 * The instance admin's panel for what the 6.0 upgrade did with the proxy spaces (Q-531, plan rev 3.2 "Client": the orphan, claim and purge doors
 * get an admin panel).
 *
 * ## The rules
 *
 * 1. **Only an admin sees it, and nobody else is asked anything.** `retired` is `GET /api/spaces`' `retiredSpaceIds`, served to an admin alone, so
 *    `null` renders nothing and sends nothing (the three doors would answer 403); an admin with none reserved gets the panel and its "nothing
 *    to report" sentence.
 * 2. **Claim** posts the definition's name and then re-reads both lists and the caller's own views.
 * 3. **Purge is irreversible**: it is the type-the-id confirm, whose words carry the OIDC consequence, and the request says the admin confirmed
 *    it (`confirmOidcClaims: true`) only after that confirm; a refusal sends nothing.
 * 4. **The orphan list is counts per kind of owner**, never a view's name.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { ToastService } from '../../core/toast.service';
import { ViewsAdminPanelComponent } from './views-admin-panel.component';

const REPORT = { migrated: ['oldteam', 'oldlab'], networksLostIds: [{ networkId: 'n1', label: 'Fleet', spaceIds: ['oldteam'] }], unclaimed: [] };
const ORPHANS = { orphans: [{ ownerKind: 'token', count: 3 }], unclaimed: [{ name: 'crafts', members: ['qa'] }] };

function mount(retired: string[] | null, answer = true) {
  const confirm = vi.fn((_: unknown) => Promise.resolve(answer));
  const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [ViewsAdminPanelComponent, getTranslocoModule()],
    providers: [provideHttpClient(), provideHttpClientTesting(), { provide: ConfirmDialogService, useValue: { confirm } }, { provide: ToastService, useValue: toast }],
  });
  const fixture = TestBed.createComponent(ViewsAdminPanelComponent);
  fixture.componentRef.setInput('retired', retired);
  const purged: string[] = [];
  fixture.componentInstance.purged.subscribe(v => purged.push(v));
  fixture.detectChanges();
  const http = TestBed.inject(HttpTestingController);
  const answerReads = () => {
    http.expectOne('/api/admin/views/migration').flush(REPORT);
    http.expectOne('/api/admin/views/orphans').flush(ORPHANS);
    fixture.detectChanges();
  };
  return { fixture, el: fixture.nativeElement as HTMLElement, http, confirm, toast, purged, answerReads };
}

describe('the views admin panel (Q-531)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders nothing and asks nothing for a caller who is not an admin', () => {
    const { el, http } = mount(null);
    expect(el.textContent?.trim()).toBe('');
    http.expectNone(() => true);
  });

  it('reads the report and the orphan list for an admin, and shows what the upgrade did', () => {
    const { el, answerReads } = mount(['oldteam']);
    answerReads();
    const text = el.textContent ?? '';
    expect(text).toContain('views.admin.migrated');
    expect(text).toContain('views.admin.networksLine');
    expect(text).toContain('oldteam');
  });

  it('says nothing is owed for an admin with nothing to report', () => {
    const { fixture, el, http } = mount([]);
    http.expectOne('/api/admin/views/migration').flush({});
    http.expectOne('/api/admin/views/orphans').flush({});
    fixture.detectChanges();
    expect(el.textContent).toContain('views.admin.none');
  });

  it('counts orphans by kind of owner and never names a view', () => {
    const { el, answerReads } = mount(['oldteam']);
    answerReads();
    expect(el.textContent).toContain('views.admin.orphanLine');
    // The unclaimed definition is NAMED (it is a definition the admin may take); an orphan row is a kind and a count.
    const orphanItems = [...el.querySelectorAll('li')].filter(li => /views\.admin\.orphanLine/.test(li.textContent ?? ''));
    expect(orphanItems).toHaveLength(1);
  });

  it('claims an unclaimed definition by name and re-reads', () => {
    const { fixture, el, http, answerReads, toast } = mount(['oldteam']);
    answerReads();
    const claim = [...el.querySelectorAll<HTMLButtonElement>('button')].find(b => /views\.admin\.claim/.test(b.textContent ?? ''))!;
    claim.click();
    const req = http.expectOne(r => r.method === 'POST' && r.url === '/api/admin/views/claim');
    expect(req.request.body).toEqual({ name: 'crafts' });
    req.flush({ view: { id: '@crafts', name: 'crafts', members: ['qa'], readable: ['qa'] } });
    expect(toast.success).toHaveBeenCalledTimes(1);
    http.expectOne('/api/views').flush({ views: [] });
    http.expectOne('/api/admin/views/migration').flush(REPORT);
    http.expectOne('/api/admin/views/orphans').flush({ orphans: [], unclaimed: [] });
    fixture.detectChanges();
    expect(el.textContent).not.toContain('views.admin.claim');
  });

  it('purges a reserved id only after the type-the-id confirm, and says the admin confirmed the OIDC consequence', async () => {
    const { fixture, el, http, confirm, answerReads, purged } = mount(['oldteam']);
    answerReads();
    [...el.querySelectorAll<HTMLButtonElement>('button')].find(b => /views\.admin\.purge/.test(b.textContent ?? ''))!.click();
    await fixture.whenStable();
    const asked = confirm.mock.calls[0]![0] as { requireText: string; danger: boolean; message: string };
    expect(asked.requireText).toBe('oldteam');
    expect(asked.danger).toBe(true);
    expect(asked.message, 'the confirm does not carry the OIDC consequence').toContain('views.admin.purgeOidc');
    const req = http.expectOne(r => r.method === 'POST' && r.url === '/api/admin/views/retired/oldteam/purge');
    expect(req.request.body).toEqual({ confirmOidcClaims: true });
    req.flush(null, { status: 204, statusText: 'No Content' });
    expect(purged).toEqual(['oldteam']);
  });

  it('sends nothing when the purge is not confirmed', async () => {
    const { fixture, el, http, answerReads, purged } = mount(['oldteam'], false);
    answerReads();
    [...el.querySelectorAll<HTMLButtonElement>('button')].find(b => /views\.admin\.purge/.test(b.textContent ?? ''))!.click();
    await fixture.whenStable();
    http.expectNone(r => /purge$/.test(r.url));
    expect(purged).toEqual([]);
  });
});
