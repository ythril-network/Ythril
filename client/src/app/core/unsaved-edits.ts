/**
 * Would leaving now lose an edit? The one registry of unsaved drafts, the one question that asks before discarding them, and the
 * route guard and reload warning built on it (Q-701).
 *
 * ## What it prevents
 *
 * `docs/ui-primitives.md` asks for "an unsaved-changes guard on every editable form". At 139c6938 one page had one (the spaces
 * route, typed to that page), media processing asked on its own tab switch and nowhere else, and every other page lost a typed draft
 * to one sidebar click: the networks sync schedule, the data page's backup settings, the brain's create forms and inline edits, the
 * space Danger tab's retention and embeddings tick. Each guard that existed was written by hand, with its own copy of the question.
 *
 * ## How it is shaped
 *
 * - A component that holds a draft calls `holdUnsavedEdits(() => <the draft differs from what it was opened with>)` in its
 *   constructor. The check is removed when the component is destroyed, inside this call, so no page can leave a check behind that
 *   prompts on the next page. A child (a tab, a drawer, a dialog) holds its own draft; its page does not have to collect it.
 * - `guardEveryPage` adds `unsavedEditsGuard` to every route that loads a component, so no route can forget it. The guard asks only
 *   when a live check is dirty.
 * - One `beforeunload` listener warns on reload or tab close while a check is dirty.
 * - `confirmDiscard(dirty)` is the same question for an in-page discard of one draft (a tab switch, a dialog's own close).
 *
 * A check that throws counts as dirty: a broken check must not let an edit go silently.
 *
 * Call `holdUnsavedEdits` from a COMPONENT. A root service lives for the whole session, so a check it held would never be removed and
 * would prompt on every page after it; `testing/unsaved-edits-are-held.spec.ts` reads component files for that reason.
 */
import { DestroyRef, Injectable, inject } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import type { CanDeactivateFn, Route, Routes } from '@angular/router';
import { TranslocoService } from '@jsverse/transloco';
import { ConfirmDialogService } from './confirm-dialog.service';

/** Answers true when the draft it watches differs from what it was opened with (or last saved). */
export type UnsavedEditsCheck = () => boolean;

@Injectable({ providedIn: 'root' })
export class UnsavedEdits {
  private readonly checks = new Set<UnsavedEditsCheck>();
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly transloco = inject(TranslocoService);

  constructor() {
    // One listener for the whole app. A browser shows its own wording for this prompt; preventing the event is what asks for it.
    inject(DOCUMENT).defaultView?.addEventListener('beforeunload', e => {
      if (this.any()) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  /** Register `check` until `destroyRef` is destroyed. Prefer `holdUnsavedEdits`, which passes the caller's own `DestroyRef`. */
  hold(check: UnsavedEditsCheck, destroyRef: DestroyRef): void {
    this.checks.add(check);
    destroyRef.onDestroy(() => this.checks.delete(check));
  }

  /** True when any live draft would be lost by leaving now. */
  any(): boolean {
    for (const check of this.checks) {
      try { if (check()) return true; } catch { return true; }
    }
    return false;
  }

  /** Resolves true when it is safe to leave: at once when nothing is dirty, otherwise the user's answer to the discard question. */
  confirmLeave(): Promise<boolean> {
    return this.confirmDiscard(this.any());
  }

  /**
   * The discard question for one draft (`dirty` is that draft's own check), asked only when it is dirty. Resolves true when it is
   * safe to discard.
   */
  async confirmDiscard(dirty: boolean): Promise<boolean> {
    if (!dirty) return true;
    return this.confirmDialog.confirm({
      title: this.transloco.translate('unsavedEdits.title'),
      message: this.transloco.translate('unsavedEdits.message'),
      confirmLabel: this.transloco.translate('unsavedEdits.confirm'),
      cancelLabel: this.transloco.translate('unsavedEdits.cancel'),
      danger: true,
    });
  }
}

/**
 * Hold the calling component's draft: leaving its page, reloading or closing the tab asks first while `check` answers true. Call it
 * in a component's injection context (its constructor or a field initialiser); the check goes away with the component.
 */
export function holdUnsavedEdits(check: UnsavedEditsCheck): void {
  inject(UnsavedEdits).hold(check, inject(DestroyRef));
}

/** Leaving a page asks first while any live component holds a dirty draft. */
export const unsavedEditsGuard: CanDeactivateFn<unknown> = function unsavedEditsGuard() {
  return inject(UnsavedEdits).confirmLeave();
};

/** The route table with `unsavedEditsGuard` on every route that loads a component, at any depth; guards already there are kept. */
export function guardEveryPage(routes: Routes): Routes {
  return routes.map((r): Route => {
    const loads = !!(r.loadComponent || r.component);
    const guards = r.canDeactivate ?? [];
    return {
      ...r,
      ...(loads && !guards.includes(unsavedEditsGuard) ? { canDeactivate: [...guards, unsavedEditsGuard] } : {}),
      ...(r.children ? { children: guardEveryPage(r.children) } : {}),
    };
  });
}
