/**
 * The one way a spec drives a dialog's dismiss (Q-713): Escape, the backdrop, the X and Cancel, each with a clean draft, a dirty draft the
 * user keeps and a dirty draft the user gives up.
 *
 * ## What it prevents
 *
 * Thirteen dialogs held their draft with `holdUnsavedEdits` (Q-701) and still closed on Escape or X without asking, so a typed draft was lost
 * to one key. A hand-written spec per dialog would drive Escape and forget X, or forget the clean case that must stay immediate. Written once
 * here, each dialog's spec states which controls it offers, how to mount it, how to dirty it and how to see that it closed; the ways to dismiss
 * it and the three outcomes are not restated. A control the dialog is declared to offer and does not render fails, so a declaration cannot
 * go stale into a case that drives nothing.
 *
 * The discard question is observed on `ConfirmDialogService.confirm` (the one question `UnsavedEdits.confirmDiscard` asks), never on a copy.
 */
import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';
import { ConfirmDialogService } from '../core/confirm-dialog.service';

/** The controls a dialog offers besides Escape (which every `appModal` dialog has). */
export interface DismissControls {
  /** The aria-label of the X button; null when the dialog has none (default `common.close`). */
  x?: string | null;
  /** The text of the Cancel button; null when the dialog has none (default `common.cancel`). */
  cancel?: string | null;
  /** The dialog closes on a click on its backdrop (`appModalCloseOnBackdrop`; default off). */
  backdrop?: boolean;
  /** Which `[role=dialog]` panel is the subject when the component renders several (default 0). */
  panel?: number;
}

export interface DismissSubject {
  fixture: ComponentFixture<unknown>;
  /** Make the open dialog hold a draft (the draft check reads fields and signals, so no render is needed). */
  edit(): void;
  /** How many times the dialog closed (its close output emitted, its host flag cleared). */
  closes(): number;
}

type Way = { name: string; run(panel: HTMLElement): void };

function waysOf(controls: DismissControls): Way[] {
  const ways: Way[] = [{ name: 'Escape', run: panel => { panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } }];
  if (controls.backdrop) {
    ways.push({ name: 'a click on the backdrop', run: panel => { panel.parentElement!.dispatchEvent(new MouseEvent('click', { bubbles: true })); } });
  }
  const x = controls.x === undefined ? 'common.close' : controls.x;
  if (x !== null) {
    ways.push({
      name: 'the X button',
      run: panel => {
        const button = panel.querySelector<HTMLButtonElement>(`button[aria-label="${x}"]`);
        expect(button, `the dialog renders no X button labelled ${x}`).toBeTruthy();
        button!.click();
      },
    });
  }
  const cancel = controls.cancel === undefined ? 'common.cancel' : controls.cancel;
  if (cancel !== null) {
    ways.push({
      name: 'the Cancel button',
      run: panel => {
        const button = Array.from(panel.querySelectorAll('button')).find(b => b.textContent?.trim() === cancel);
        expect(button, `the dialog renders no button reading ${cancel}`).toBeTruthy();
        button!.click();
      },
    });
  }
  return ways;
}

/** Let the discard question's promise settle and the host's change detection run. */
async function settle(subject: DismissSubject): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  subject.fixture.detectChanges();
}

/**
 * Register the dismiss specs of one dialog. `mount` builds the dialog open and returns how to dirty it and how to see it close; it is
 * called afresh for every case (the TestBed is reset first).
 */
export function dialogDismissSpecs(name: string, controls: DismissControls, mount: () => DismissSubject | Promise<DismissSubject>): void {
  describe(`${name}: its dismiss asks before it discards a draft (Q-713)`, () => {
    async function open(answer: boolean) {
      TestBed.resetTestingModule();
      const subject = await mount();
      const confirm = vi.spyOn(TestBed.inject(ConfirmDialogService), 'confirm').mockResolvedValue(answer);
      const panel = subject.fixture.nativeElement.querySelectorAll('[role="dialog"]')[controls.panel ?? 0] as HTMLElement | undefined;
      expect(panel, 'the dialog is not open: mount it open').toBeTruthy();
      return { subject, confirm, panel: panel! };
    }

    for (const way of waysOf(controls)) {
      it(`${way.name} closes a clean dialog at once, without a question`, async () => {
        const { subject, confirm, panel } = await open(false);
        expect(subject.closes(), 'it closed before anything was done').toBe(0);
        way.run(panel);
        await settle(subject);
        expect(confirm, 'a clean dialog has nothing to lose').not.toHaveBeenCalled();
        expect(subject.closes()).toBe(1);
      });

      it(`${way.name} on a dirty dialog asks, and a refusal keeps it open`, async () => {
        const { subject, confirm, panel } = await open(false);
        subject.edit();
        way.run(panel);
        await settle(subject);
        expect(confirm, 'a typed draft was discarded without a question').toHaveBeenCalledTimes(1);
        expect(subject.closes(), 'the user kept the draft, so the dialog stays').toBe(0);
      });

      it(`${way.name} on a dirty dialog closes it once the user gives the draft up`, async () => {
        const { subject, confirm, panel } = await open(true);
        subject.edit();
        way.run(panel);
        await settle(subject);
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(subject.closes()).toBe(1);
      });
    }
  });
}
