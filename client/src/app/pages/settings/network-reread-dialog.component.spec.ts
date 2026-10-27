/**
 * NetworkRereadDialogComponent: the "Re-read everything from peers" dialog, layout B "Estimate first" (bundle-81, design rev 8 §7,
 * decisions 18, 19, 40, 41 and 42; mockup `b81-mock-reread/layout-b.html`, green-lit by the owner 2026-10-24).
 *
 * ## What the plan and the mockup bind
 *
 * - **A space checklist** with each space's record count, every space checked at first.
 * - **A live estimate** (`aria-live`): the duration is the SUM over the chosen spaces of `ceil(records / 10,000)` cycles, because a
 *   member reads one space per cycle (decision 40), times the schedule's interval (decision 42). The mockup's four-space case,
 *   4,210 + 18,730 + 920 + 2,150 records, is five cycles; at a five-minute schedule, 25 minutes. One client function computes it.
 * - **Typed confirmation** of the network name: the confirm button is disabled until the input equals the name exactly.
 * - **Cost text** (records that peers deleted and have since forgotten can come back) and the MFA note.
 * - **Keyboard:** the dialog is `role="dialog"` with `aria-modal`, focus lands in the confirmation input, Escape closes it, Tab stays
 *   inside it (a focus trap, as the restore dialog), and Enter in the input confirms only when the name matches.
 * - **A visible focus ring** drawn by the component itself, because the app has no global `:focus-visible` rule (decision 41).
 *
 * ## The API this spec assumes, because the component is not written yet
 *
 * `client/src/app/pages/settings/network-reread-estimate.ts` exports `rereadCycles(recordCounts: number[]): number`;
 * `network-reread-dialog.component.ts` exports `NetworkRereadDialogComponent` (standalone), taking the inputs `networkName`,
 * `spaces: { id: string; records: number }[]` and `cycleMinutes: number`, and emitting `confirmed` (`{ spaces: string[] }`) and
 * `closed`. If the build names them differently, the names in `make()` and the import are the lines to change; the rules stay.
 *
 * ## Seen red
 *
 * Red on 9a7ab3f7: neither module exists, so the spec fails to import them.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { rereadCycles } from './network-reread-estimate';
import { NetworkRereadDialogComponent } from './network-reread-dialog.component';

/** The mockup's four spaces: 1 + 2 + 1 + 1 cycles. */
const FOUR_SPACES = [
  { id: 'general', records: 4210 }, { id: 'field-notes', records: 18730 }, { id: 'contracts', records: 920 }, { id: 'media-index', records: 2150 },
];
const NAME = 'Field offices';

function make(overrides: { spaces?: { id: string; records: number }[]; cycleMinutes?: number; mfaAsked?: boolean } = {}) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [NetworkRereadDialogComponent, getTranslocoModule()] });
  const fixture = TestBed.createComponent(NetworkRereadDialogComponent);
  fixture.componentRef.setInput('networkName', NAME);
  fixture.componentRef.setInput('spaces', overrides.spaces ?? FOUR_SPACES);
  fixture.componentRef.setInput('cycleMinutes', overrides.cycleMinutes ?? 5);
  if (overrides.mfaAsked !== undefined) fixture.componentRef.setInput('mfaAsked', overrides.mfaAsked);
  fixture.detectChanges();
  return fixture;
}
const el = (f: ReturnType<typeof make>) => f.nativeElement as HTMLElement;
const typeName = (f: ReturnType<typeof make>, value: string) => {
  const input = el(f).querySelector('input[type="text"]') as HTMLInputElement;
  input.value = value; input.dispatchEvent(new Event('input')); f.detectChanges();
  return input;
};
const confirmButton = (f: ReturnType<typeof make>) => el(f).querySelector('button.btn-danger-solid, button[data-confirm]') as HTMLButtonElement;

describe('the estimate: a member reads one space per cycle, so cycles are summed per space (decisions 40 and 42)', () => {
  it('the mockup\'s four-space case is five cycles', () => {
    expect(rereadCycles(FOUR_SPACES.map(s => s.records))).toBe(5);
  });
  it('10,000 records are one cycle, 10,001 are two, and the sum is over spaces, not over the total', () => {
    expect(rereadCycles([10_000])).toBe(1);
    expect(rereadCycles([10_001])).toBe(2);
    expect(rereadCycles([6_000, 6_000, 6_000])).toBe(3); // 18,000 records in total would be 2 cycles: a member reads ONE space per cycle
    expect(rereadCycles([1, 1, 1, 1, 1])).toBe(5); // 5 records in total would be ONE cycle if cycles were summed over the total
  });
});

describe('NetworkRereadDialogComponent (layout B)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('lists every space with its record count, all checked', () => {
    const boxes = [...el(make()).querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    expect(boxes.length).toBe(FOUR_SPACES.length);
    expect(boxes.every(b => b.checked)).toBe(true);
  });

  it('shows the live estimate in an aria-live region: five cycles at a five-minute schedule', () => {
    const f = make();
    const live = el(f).querySelector('[aria-live]') as HTMLElement;
    expect(live).toBeTruthy();
    expect(live.textContent).toContain('5');
    expect(live.textContent).toContain('25');
  });

  it('unchecking a space moves the estimate by that space\'s cycles only', () => {
    const f = make();
    const boxes = [...el(f).querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    boxes[1]!.click(); // field-notes: 18,730 records, two cycles
    f.detectChanges();
    const live = el(f).querySelector('[aria-live]') as HTMLElement;
    expect(live.textContent).toContain('3');
    expect(live.textContent).not.toContain('25');
  });

  it('confirms nothing until the network name is typed exactly, and then emits the chosen spaces', () => {
    const f = make();
    const confirmed = vi.fn();
    f.componentInstance.confirmed.subscribe(confirmed);
    expect(confirmButton(f).disabled).toBe(true);
    typeName(f, NAME.slice(0, 5));
    expect(confirmButton(f).disabled).toBe(true);
    typeName(f, NAME.toLowerCase());
    expect(confirmButton(f).disabled).toBe(true);
    typeName(f, NAME);
    expect(confirmButton(f).disabled).toBe(false);
    confirmButton(f).click();
    expect(confirmed).toHaveBeenCalledWith({ spaces: FOUR_SPACES.map(s => s.id) });
  });

  it('names the cost, and the MFA step only when the confirm will ask for a code (b81 drive: no MFA prompt appeared on an instance with none enrolled)', () => {
    const asked = el(make({ mfaAsked: true })).textContent ?? '';
    expect(asked).toContain('networks.reread.cost');
    expect(asked).toContain('networks.reread.mfa');
    expect(el(make({ mfaAsked: false })).textContent, 'the sentence promised a prompt that never comes').not.toContain('networks.reread.mfa');
    expect(el(make()).textContent, 'until the host says a code is asked, none is promised').not.toContain('networks.reread.mfa');
    expect(el(make()).textContent).toContain('networks.reread.cost');
  });

  describe('keyboard', () => {
    it('is a modal dialog, and focus lands in the confirmation input', () => {
      const f = make();
      const dialog = el(f).querySelector('[role="dialog"]') as HTMLElement;
      expect(dialog?.getAttribute('aria-modal')).toBe('true');
      expect(dialog?.getAttribute('aria-labelledby')).toBeTruthy();
      expect(document.activeElement === el(f).querySelector('input[type="text"]') || el(f).contains(document.activeElement)).toBe(true);
    });

    it('Escape closes it', () => {
      const f = make();
      const closed = vi.fn();
      f.componentInstance.closed.subscribe(closed);
      (el(f).querySelector('[role="dialog"]') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(closed).toHaveBeenCalledTimes(1);
    });

    it('Tab from the last control wraps to the first (a focus trap)', () => {
      const f = make();
      const dialog = el(f).querySelector('[role="dialog"]') as HTMLElement;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('input, button, [href], [tabindex]:not([tabindex="-1"])')].filter(n => !(n as HTMLButtonElement).disabled);
      focusable.at(-1)!.focus();
      const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      dialog.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(focusable[0]);
    });

    it('Enter in the input confirms only when the name matches', () => {
      const f = make();
      const confirmed = vi.fn();
      f.componentInstance.confirmed.subscribe(confirmed);
      const input = typeName(f, 'Field');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(confirmed).not.toHaveBeenCalled();
      typeName(f, NAME).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(confirmed).toHaveBeenCalledTimes(1);
    });
  });

  it('draws its own visible focus ring (decision 41): the component styles name :focus-visible', () => {
    const source = readFileSync(resolve(__dirname, 'network-reread-dialog.component.ts'), 'utf8');
    expect(source).toMatch(/:focus-visible/);
  });

  it('has no spaces to pick: says so and offers no confirmation (the mockup\'s empty state)', () => {
    const f = make({ spaces: [] });
    expect(confirmButton(f)?.disabled ?? true).toBe(true);
    expect(el(f).textContent).toContain('networks.reread.noSpaces');
  });
});
