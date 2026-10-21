/**
 * SpaceCreateDialogComponent — the create form and its reserved-id check.
 *
 * Q-531 rewrote this file: the dialog lost its proxy-target block (a proxy is a personal view since 6.0, made in the Brain page's My
 * views), so the two member-toggle cases that were relocated here from spaces.component.spec.ts (A17.8b-2b) went with
 * `toggleProxyFor`, and the dialog's own rule took their place: an id reserved since it was a proxy is refused before the request.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';
import { of } from 'rxjs';
import { NetworksApi } from '../../core/networks-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { SpacesStore } from './spaces-store.service';
import { SpaceCreateDialogComponent } from './space-create-dialog.component';
import { isOnPush } from '../../testing/onpush';
import type { SpaceMeta } from '../../core/api.types';

/** The body `SpacesApi.createSpace` takes — named so the harness and the spy agree on one shape. */
type CreateSpaceBody = { label: string; id?: string; maxGiB?: number; meta?: Partial<SpaceMeta> };

function create(createSpaceSpy?: (body: CreateSpaceBody) => unknown, retiredSpaceIds: string[] = []) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [SpaceCreateDialogComponent, getTranslocoModule()],
    providers: [
      SpacesStore,
      { provide: SpacesApi, useValue: {
        listSpaces: () => of({ spaces: [], retiredSpaceIds }),
        createSpace: createSpaceSpy ?? (() => of({ space: {} })),
      } },
      { provide: NetworksApi, useValue: { listNetworks: () => of({ networks: [] }) } },
    ],
  });
  const fixture = TestBed.createComponent(SpaceCreateDialogComponent);
  fixture.detectChanges();
  return fixture;
}

describe('SpaceCreateDialogComponent', () => {
  it('is compiled as OnPush', () => {
    // Matches the house pattern (brain, file-manager, graph, audit-log all assert this). Every child
    // extracted in A17.8b is OnPush from birth rather than retrofitted onto the old 1600-line parent.
    expect(isOnPush(SpaceCreateDialogComponent)).toBe(true);
  });

  it('starts with an empty Purpose and a fully-strict validation default', () => {
    // The Purpose field no longer pre-fills the long MCP tool listing (owner feedback), and validation
    // defaults to strict to match the server's new-space default (#400) — the form must not understate
    // what will actually be created.
    const c = create().componentInstance;
    expect(c.form.purpose).toBe('');
    expect(c.form.validationMode).toBe('strict');
    expect(c.form.strictLinkage).toBe(true);
  });

  it('sends the validation choices explicitly, even when the user picks the lenient options', () => {
    // If the form quietly omitted an "off"/unchecked choice, the server default (strict) would create a
    // strict space while the user was shown "off" — so both flags are always sent.
    // The parameter is declared because the assertion below reads `mock.calls[0][0]`, and a `vi.fn(() => …)`
    // with none types its calls as an empty tuple. Shape from `SpacesApi.createSpace`.
    const spy = vi.fn((_body: CreateSpaceBody) => of({ space: {} }));
    const c = create(spy).componentInstance;
    c.form.label = 'My Space';
    c.form.validationMode = 'off';
    c.form.strictLinkage = false;
    c.createSpace();
    expect(spy).toHaveBeenCalledTimes(1);
    const body = spy.mock.calls[0][0];
    expect(body.meta?.validationMode).toBe('off');
    expect(body.meta?.strictLinkage).toBe(false);
    // An empty Purpose is not sent as a blank string.
    expect(body.meta?.purpose).toBeUndefined();
  });

  it('offers no proxy-target control: a proxy is a personal view, made in the Brain page', () => {
    // The block that picked member spaces (and "all, including later ones") is gone, and with it the `proxyFor` the body used to carry.
    const fixture = create();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).not.toMatch(/proxy/i);
    expect((fixture.componentInstance as any).proxyForSelected).toBeUndefined();
  });

  it('refuses an id reserved since it was a proxy, before any request, and says which', async () => {
    // The server refuses it after the work (create, rename and a join all refuse a retired id until an admin purges it); the dialog
    // knows the list (`GET /api/spaces` serves it to an admin) and says so at the field.
    const spy = vi.fn((_body: CreateSpaceBody) => of({ space: {} }));
    const fixture = create(spy, ['oldteam']);
    TestBed.inject(SpacesStore).load();
    await fixture.whenStable(); // a form control registers with its form on a microtask: a keystroke before that has no listener
    const c = fixture.componentInstance;
    c.form.label = 'Old team';
    // Typed into the field, so ngModel writes the form and marks the OnPush view dirty as a user's keystroke would.
    const field = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('input[name="id"]')!;
    field.value = 'oldteam';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(c.retiredId()).toBe('oldteam');
    expect((fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')?.textContent ?? '').toContain('spaces.create.idRetired');
    expect((fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    c.createSpace();
    expect(spy).not.toHaveBeenCalled();
  });

  it('sends a free id as before (control)', () => {
    const spy = vi.fn((_body: CreateSpaceBody) => of({ space: {} }));
    const fixture = create(spy, ['oldteam']);
    TestBed.inject(SpacesStore).load();
    const c = fixture.componentInstance;
    c.form.label = 'New team';
    c.form.id = 'newteam';
    expect(c.retiredId()).toBe('');
    c.createSpace();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].id).toBe('newteam');
  });
});
