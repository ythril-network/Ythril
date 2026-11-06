/**
 * The personal-view rename holds its draft (Q-701, bundle-238).
 *
 * The inline rename on the Brain page's "My views" strip is a typed value that a Save sends. Leaving the page, reloading, or clicking a
 * tab with a changed name in the box used to lose it silently.
 *
 * ## The rules
 *
 * 1. Clean when no rename is open, and clean as opened (the box holds the view's own name).
 * 2. Dirty once the box holds another name; a trailing blank is not a change (the save trims it).
 * 3. Clean after Cancel and after a rename that succeeded: the page follows the new id next, and must not be asked about the box it just used.
 *
 * ## Seen red at a0238e3c
 *
 * `UnsavedEdits.any()` was false with a changed name in the box.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { ToastService } from '../../core/toast.service';
import { UnsavedEdits } from '../../core/unsaved-edits';
import { ViewsStore } from '../../core/views.store';
import { VIEW_LENS, VIEW_EMPTY, flushViews } from '../../testing/personal-views';
import { MyViewsComponent } from './my-views.component';

beforeEach(() => TestBed.resetTestingModule());

function mount() {
  TestBed.configureTestingModule({
    imports: [MyViewsComponent, getTranslocoModule()],
    providers: [
      provideHttpClient(), provideHttpClientTesting(),
      { provide: ConfirmDialogService, useValue: { confirm: vi.fn(() => Promise.resolve(true)) } },
      { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn(), info: vi.fn() } },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  TestBed.inject(ViewsStore).load();
  flushViews(http, [VIEW_LENS, VIEW_EMPTY]);
  const fixture = TestBed.createComponent(MyViewsComponent);
  fixture.componentRef.setInput('spaces', [{ id: 'qa', label: 'Quality' }]);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, http, c: fixture.componentInstance as any, unsaved: TestBed.inject(UnsavedEdits) };
}

describe('the personal-view rename holds its draft (Q-701)', () => {
  it('is clean with no rename open, and as opened; dirty once the name differs; blanks are not a change', async () => {
    const v = mount();
    expect(v.unsaved.any(), 'no rename open').toBe(false);
    v.el.querySelector<HTMLButtonElement>('button[aria-label="views.rename.action"]')!.click();
    v.fixture.detectChanges();
    await v.fixture.whenStable();
    expect(v.unsaved.any(), 'the box holds the view\'s own name').toBe(false);
    v.c.draft = 'lens2';
    expect(v.unsaved.any(), 'a typed new name would be lost by leaving').toBe(true);
    v.c.draft = 'lens  ';
    expect(v.unsaved.any(), 'the save trims, so this names the same view').toBe(false);
  });

  it('is clean after Cancel', async () => {
    const v = mount();
    v.el.querySelector<HTMLButtonElement>('button[aria-label="views.rename.action"]')!.click();
    v.fixture.detectChanges();
    await v.fixture.whenStable();
    v.c.draft = 'lens2';
    expect(v.unsaved.any()).toBe(true);
    v.c.renaming.set('');
    expect(v.unsaved.any(), 'Cancel closes the box').toBe(false);
  });

  it('is clean the moment a rename succeeded, before the page follows the new id', async () => {
    const v = mount();
    const asked: boolean[] = [];
    v.c.renamed.subscribe(() => asked.push(v.unsaved.any()));
    v.el.querySelector<HTMLButtonElement>('button[aria-label="views.rename.action"]')!.click();
    v.fixture.detectChanges();
    await v.fixture.whenStable();
    v.c.draft = 'lens2';
    expect(v.unsaved.any()).toBe(true);
    v.c.saveRename(VIEW_LENS);
    v.http.expectOne(r => r.method === 'PATCH' && r.url === '/api/views/%40lens').flush({ view: { ...VIEW_LENS, id: '@lens2', name: 'lens2' } });
    expect(asked, 'the page was told once, and the box held nothing by then').toEqual([false]);
    expect(v.unsaved.any()).toBe(false);
  });
});
