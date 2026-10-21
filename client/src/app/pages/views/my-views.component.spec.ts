/**
 * My personal views: list, create, rename, delete (Q-531, plan rev 3.2 "Client").
 *
 * ## The rules
 *
 * 1. Each entry says "personal view" in VISIBLE text (the brain.personal-views spec holds that on the page; here on the component alone), and
 *    an empty list says so in a sentence once the list has arrived - and not before, so a list that is still loading is not "none".
 * 2. Create opens the dialog; the view it makes is opened and announced.
 * 3. Rename is inline and tells the page the old and the new id (the id IS the name, so the page must follow it).
 * 4. Delete asks first, in words that say what goes (the view only, no data); a refusal sends nothing; an answer drops the view and tells the
 *    page, which leaves it when it was the open one.
 * 5. A refused act is said in the views family's own sentence, never a raw code.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { CLIENT_ROOT } from '../../testing/tracked-sources';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { ToastService } from '../../core/toast.service';
import { ViewsStore } from '../../core/views.store';
import { VIEW_LENS, VIEW_EMPTY, flushViews } from '../../testing/personal-views';
import { MyViewsComponent } from './my-views.component';

const SPACES = [{ id: 'qa', label: 'Quality' }, { id: 'ops', label: 'Operations' }];

const EN: Record<string, string> = JSON.parse(readFileSync(resolve(CLIENT_ROOT, 'public/assets/i18n/en.json'), 'utf8'));

/** `real` loads the shipped English: the harness's echo of a key reads as "no such key", which is what a sentence-for-a-code rule must not see. */
async function mount(answer = true, real = false) {
  const confirm = vi.fn((_: unknown) => Promise.resolve(answer));
  const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [MyViewsComponent, getTranslocoModule(real ? { translation: { en: EN } } : {})],
    providers: [provideHttpClient(), provideHttpClientTesting(), { provide: ConfirmDialogService, useValue: { confirm } }, { provide: ToastService, useValue: toast }],
  });
  const http = TestBed.inject(HttpTestingController);
  TestBed.inject(ViewsStore).load();
  flushViews(http, [VIEW_LENS, VIEW_EMPTY]);
  const fixture = TestBed.createComponent(MyViewsComponent);
  fixture.componentRef.setInput('spaces', SPACES);
  const opened: string[] = [], renamed: { from: string; to: string }[] = [], removed: string[] = [];
  fixture.componentInstance.opened.subscribe(v => opened.push(v));
  fixture.componentInstance.renamed.subscribe(v => renamed.push(v));
  fixture.componentInstance.removed.subscribe(v => removed.push(v));
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const byLabel = (key: string, name: string) => [...el.querySelectorAll<HTMLButtonElement>('button')].find(b => b.getAttribute('aria-label') === `${key}`.replace('{{name}}', name));
  return { fixture, el, http, confirm, toast, opened, renamed, removed, byLabel };
}

describe('My views (Q-531)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('lists each view with the words "personal view" as visible text, and opens one on a click', async () => {
    const { el, opened } = await mount();
    const chips = [...el.querySelectorAll<HTMLButtonElement>('button.chip')];
    expect(chips.map(c => c.textContent)).toEqual([expect.stringContaining('lens'), expect.stringContaining('empty')]);
    for (const c of chips) expect(c.textContent, 'the marker is not visible text').toContain('views.marker');
    chips[0]!.click();
    expect(opened).toEqual(['@lens']);
  });

  it('says there are none only once the list has arrived', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [MyViewsComponent, getTranslocoModule()], providers: [provideHttpClient(), provideHttpClientTesting()] });
    const store = TestBed.inject(ViewsStore);
    const fixture = TestBed.createComponent(MyViewsComponent);
    fixture.componentRef.setInput('spaces', SPACES);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('views.empty');
    store.load();
    flushViews(TestBed.inject(HttpTestingController), []);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('views.empty');
  });

  it('creating opens the dialog, and the made view is opened and announced', async () => {
    const { fixture, el, toast, opened } = await mount();
    const open = [...el.querySelectorAll<HTMLButtonElement>('.head button')].find(b => /views\.create\.open/.test(b.textContent ?? ''))!;
    open.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('app-view-create-dialog'), 'the dialog did not open').not.toBeNull();
    (fixture.componentInstance as unknown as { onCreated(v: unknown): void }).onCreated({ id: '@new', name: 'new', members: ['qa'], readable: ['qa'] });
    fixture.detectChanges();
    expect(opened).toEqual(['@new']);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(el.querySelector('app-view-create-dialog'), 'the dialog stayed open').toBeNull();
  });

  it('renames inline and tells the page the old and the new id', async () => {
    const { fixture, el, http, renamed } = await mount();
    el.querySelector<HTMLButtonElement>('button[aria-label="views.rename.action"]')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const input = el.querySelector<HTMLInputElement>('.rename input')!;
    expect(input.value).toBe('lens');
    input.value = 'lens2';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    el.querySelector<HTMLFormElement>('.rename')!.dispatchEvent(new Event('submit'));
    const req = http.expectOne(r => r.method === 'PATCH' && r.url === '/api/views/%40lens');
    expect(req.request.body).toEqual({ name: 'lens2' });
    req.flush({ view: { ...VIEW_LENS, id: '@lens2', name: 'lens2' } });
    expect(renamed).toEqual([{ from: '@lens', to: '@lens2' }]);
  });

  it('asks before deleting, in words that say only the view goes, and tells the page when it is gone', async () => {
    const { fixture, el, http, confirm, removed, toast } = await mount(true);
    el.querySelectorAll<HTMLButtonElement>('button[aria-label="views.delete.action"]')[0]!.click();
    await fixture.whenStable();
    expect(confirm).toHaveBeenCalledTimes(1);
    const asked = confirm.mock.calls[0]![0] as { message: string; danger: boolean };
    expect(asked.danger).toBe(true);
    expect(asked.message).toContain('views.delete.confirm');
    http.expectOne(r => r.method === 'DELETE' && r.url === '/api/views/%40lens').flush(null, { status: 204, statusText: 'No Content' });
    fixture.detectChanges();
    expect(removed).toEqual(['@lens']);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(el.textContent).not.toContain('@lens');
  });

  it('sends nothing when the delete is not confirmed', async () => {
    const { fixture, el, http, removed } = await mount(false);
    el.querySelectorAll<HTMLButtonElement>('button[aria-label="views.delete.action"]')[0]!.click();
    await fixture.whenStable();
    http.expectNone(r => r.method === 'DELETE');
    expect(removed).toEqual([]);
  });

  it('says a refused delete in the views family, never the raw code', async () => {
    const { fixture, el, http } = await mount(true, true);
    el.querySelectorAll<HTMLButtonElement>('button[aria-label="Delete the personal view lens"]')[0]!.click();
    await fixture.whenStable();
    http.expectOne(r => r.method === 'DELETE').flush({ error: 'x', code: 'view_not_found' }, { status: 404, statusText: 'Not Found' });
    fixture.detectChanges();
    const alert = el.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert).toBe(EN['views.refusal.view_not_found']);
    expect(alert).not.toContain('view_not_found');
  });
});
