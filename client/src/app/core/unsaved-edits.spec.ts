/**
 * The one registry of unsaved drafts (Q-701): what it answers, when it asks, and how the route table gets its guard.
 *
 * The page-level rule (every page route carries the guard, every component with controls holds its draft) is the gate in
 * `testing/unsaved-edits-are-held.spec.ts`; this file holds the module's own behaviour.
 */
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Route } from '@angular/router';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConfirmDialogService } from './confirm-dialog.service';
import { getTranslocoModule } from '../testing/transloco-testing';
import { UnsavedEdits, holdUnsavedEdits, unsavedEditsGuard, guardEveryPage, type HeldDraft } from './unsaved-edits';

const draft = signal('');

@Component({ selector: 'spec-holder', template: '' })
class Holder { constructor() { holdUnsavedEdits(() => draft() !== ''); } }

describe('UnsavedEdits (Q-701)', () => {
  let confirm: ReturnType<typeof vi.fn>;
  let edits: UnsavedEdits;

  beforeEach(() => {
    draft.set('');
    confirm = vi.fn().mockResolvedValue(false);
    TestBed.configureTestingModule({
      imports: [getTranslocoModule()],
      providers: [{ provide: ConfirmDialogService, useValue: { confirm } }],
    });
    edits = TestBed.inject(UnsavedEdits);
  });

  it('answers clean when nothing holds a draft', () => {
    expect(edits.any()).toBe(false);
  });

  it('answers dirty while a live component holds an edited draft, and clean once it is destroyed', () => {
    const f = TestBed.createComponent(Holder);
    expect(edits.any()).toBe(false);
    draft.set('typed');
    expect(edits.any()).toBe(true);
    f.destroy();
    expect(edits.any(), 'a destroyed component still counted: its draft would prompt on the next page').toBe(false);
  });

  it('counts a check that throws as dirty, so a broken check cannot let an edit go silently', () => {
    TestBed.runInInjectionContext(() => edits.hold(() => { throw new Error('boom'); }, inject(DestroyRef)));
    expect(edits.any()).toBe(true);
  });

  it('lets a clean page go without asking', async () => {
    expect(await edits.confirmLeave()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks once, as a danger confirm with the one key set, when leaving would lose a draft, and returns the answer', async () => {
    TestBed.createComponent(Holder);
    draft.set('typed');
    expect(await edits.confirmLeave()).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toMatchObject({ danger: true });
    confirm.mockResolvedValue(true);
    expect(await edits.confirmLeave()).toBe(true);
  });

  it('confirmDiscard asks only when the draft it is given is dirty', async () => {
    expect(await edits.confirmDiscard(false)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockResolvedValue(true);
    expect(await edits.confirmDiscard(true)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('the handle holdUnsavedEdits returns answers its own draft and closes only on a yes (Q-713)', async () => {
    let handle!: HeldDraft;
    @Component({ selector: 'spec-handle-holder', template: '' })
    class HandleHolder { constructor() { handle = holdUnsavedEdits(() => draft() !== ''); } }
    const f = TestBed.createComponent(HandleHolder);
    const close = vi.fn();

    expect(handle.dirty()).toBe(false);
    const answer = handle.closeIfConfirmed(close);
    expect(close, 'a clean draft closes in the same tick, before anything is awaited').toHaveBeenCalledTimes(1);
    expect(await answer).toBe(true);
    expect(confirm).not.toHaveBeenCalled();

    draft.set('typed');
    expect(handle.dirty()).toBe(true);
    expect(await handle.closeIfConfirmed(close), 'refused').toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(close, 'a refusal keeps the dialog open').toHaveBeenCalledTimes(1);
    confirm.mockResolvedValue(true);
    expect(await handle.closeIfConfirmed(close)).toBe(true);
    expect(close).toHaveBeenCalledTimes(2);
    f.destroy();
  });

  it('a handle whose check throws counts as dirty and asks', async () => {
    let handle!: HeldDraft;
    @Component({ selector: 'spec-throwing-holder', template: '' })
    class ThrowingHolder { constructor() { handle = holdUnsavedEdits(() => { throw new Error('boom'); }); } }
    TestBed.createComponent(ThrowingHolder);
    const close = vi.fn();
    expect(handle.dirty()).toBe(true);
    expect(await handle.closeIfConfirmed(close)).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it('the route guard is confirmLeave', async () => {
    TestBed.createComponent(Holder);
    draft.set('typed');
    const answer = await TestBed.runInInjectionContext(() => unsavedEditsGuard(null, null!, null!, null!));
    expect(answer).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('warns on reload or tab close while a draft is held, and not otherwise', () => {
    TestBed.createComponent(Holder);
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    draft.set('typed');
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented, 'a reload would drop the draft without the browser asking').toBe(true);
  });
});

describe('guardEveryPage (Q-701)', () => {
  const page = () => Promise.resolve(class {});
  const other = () => true;

  it('adds the guard to every route that loads a component, at any depth, and keeps guards already there', () => {
    const out = guardEveryPage([
      { path: 'login', loadComponent: page },
      { path: '', loadComponent: page, children: [
        { path: 'a', loadComponent: page, canDeactivate: [other] },
        { path: 'old', redirectTo: 'a', pathMatch: 'full' },
        { path: 'nest', children: [{ path: 'b', loadComponent: page }] },
      ] },
    ]);
    const flat = (rs: Route[]): Route[] => rs.flatMap(r => [r, ...flat(r.children ?? [])]);
    const loaders = flat(out).filter(r => r.loadComponent);
    expect(loaders).toHaveLength(4);
    for (const r of loaders) expect(r.canDeactivate).toContain(unsavedEditsGuard);
    expect(flat(out).find(r => r.path === 'a')!.canDeactivate).toEqual([other, unsavedEditsGuard]);
    expect(flat(out).find(r => r.path === 'old')!.canDeactivate, 'a redirect loads nothing and is left alone').toBeUndefined();
  });

  it('is idempotent: applying it twice adds the guard once', () => {
    const once = guardEveryPage([{ path: 'a', loadComponent: page }]);
    expect(guardEveryPage(once)[0]!.canDeactivate).toEqual([unsavedEditsGuard]);
  });
});
