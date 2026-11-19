/**
 * The Convert act from the type's head, inside the settings popup, and what follows a run's dialog (bundle-285 slice S10, Q-747; the browser drive's
 * D3, D5 and moment 3a).
 *
 * The act is started by the type's bar; the run it starts is shown by the SAME progress dialog a converting Save leaves open, through the same
 * path in the popup (its `progress` signal, its watch, its Open Review), so there is one way a run is shown. What these hold:
 *
 * - **The act turns to the run.** After Convert records the act's dialog goes and the progress dialog shows the run, read on the watch's bound,
 *   with a title that says records are being converted and nothing of a saved schema (the act saves none).
 * - **Closing the run's dialog keeps the keyboard's place.** Its X puts focus on the control that led there: the type's Convert records, or the
 *   footer button that took Save's place; the modal's own return goes to an element that no longer exists (the act's dialog, the Save button).
 *
 * ## Seen red
 *
 * Red at 96ba05fbc: after Convert records no dialog is open (the act's dialog closes and the popup is never told). The focus rows, red at
 * c65fa1f51: focus is on the page body after the X.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { EN, customers, mountPopup, okStatus } from '../../testing/popup-convert-fixtures';
import { runningStatus } from '../../testing/review-unconverted-fixtures';

const english = (key: string): string => { expect(EN[key], `${key} exists in en.json`).toBeTypeOf('string'); return EN[key]!; };
const ACT = [{ kind: 'act' as const, at: '2026-11-19T10:00:00.000Z' }];
const STARTED = { state: 'started', types: [{ kind: 'entity', type: 'person' }], toFp: 'fp1' };

type Harness = ReturnType<typeof mountPopup>;

/** The Schema tab sits in a deferred block with a minimum loading time (real time): wait for the type's head, never for a fixed moment. */
async function tabRendered(h: Harness): Promise<void> {
  await vi.waitFor(async () => {
    h.settle();
    await h.fixture.whenStable();
    h.settle();
    if (!h.q('convert-records')) throw new Error('the Schema tab never rendered the type head with its Convert records button');
  }, { timeout: 5_000, interval: 50 });
}

/** Open the space on the Schema tab with `person` selected, press the type's Convert records, then the act's own Convert records. */
async function actFromHead(h: Harness): Promise<void> {
  h.open();
  h.state.settingsTab.set('schema');
  h.state.schemaCollTab.set('entity');
  h.state.selectType('entity', 'person');
  await tabRendered(h);
  h.click('convert-records');
  expect(h.text('cv-title'), 'the act\'s dialog is open').toBe(english('spaces.schema.convert.act.title').replace('{{type}}', 'person'));
  h.click('cv-primary');
}

afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

describe('the Convert act from the type head, inside the popup', () => {
  it('turns to the progress dialog a converting Save leaves open: the run block, the act\'s running title, the status read', async () => {
    const h = mountPopup({ statuses: [okStatus(runningStatus({ sources: ACT, left: 500 }))] });
    await actFromHead(h);
    expect(h.start).toHaveBeenCalledWith('customers', [{ kind: 'entity', type: 'person' }], []);
    expect(h.root.querySelectorAll('app-convert-records-dialog'), 'one dialog: the act\'s went, the run\'s came').toHaveLength(1);
    expect(h.root.querySelector('app-convert-run-block'), 'the run block of the progress face').not.toBeNull();
    expect(h.text('cv-title')).toBe(english('spaces.schema.convert.run.titleRunningAct'));
    expect(h.text('cv-title')).not.toContain(english('spaces.schema.convert.note.saved'));
    await vi.waitFor(() => expect(h.status, 'the run is read on the watch').toHaveBeenCalled(), { timeout: 2_000, interval: 20 });
  });
});

describe('closing the run\'s dialog with its X (drive D5)', () => {
  it('after the act, puts focus back on the type\'s Convert records button that opened the flow', async () => {
    const h = mountPopup({ statuses: [okStatus(runningStatus({ sources: ACT, left: 500 }))] });
    document.body.appendChild(h.root);
    await actFromHead(h);
    h.click('cv-close');
    await vi.waitFor(() => expect(document.activeElement).toBe(h.q('convert-records')), { timeout: 2_000, interval: 20 });
  });

  it('scrolls the type head with its note into view, so the run\'s note is what the page shows (bundle-285 S10)', async () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    try {
      const h = mountPopup({ statuses: [okStatus(runningStatus({ sources: ACT, left: 500 }))] });
      document.body.appendChild(h.root);
      await actFromHead(h);
      scrolled.length = 0;
      h.click('cv-close');
      await vi.waitFor(() => expect(scrolled.some(e => e.classList.contains('sch-detail-head'))).toBe(true), { timeout: 2_000, interval: 20 });
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('after Save and convert, puts focus on the footer button that took Save\'s place (Done), never on the page body', async () => {
    const h = mountPopup({ update: () => of({ space: customers(), convert: STARTED }), statuses: [okStatus(runningStatus({ left: 500 }))] });
    document.body.appendChild(h.root);
    h.open();
    h.renameCompany();
    h.popup.saveSettings();
    h.settle();
    h.click('cv-primary');
    expect(h.q('cv-close'), 'the progress dialog is open').not.toBeNull();
    h.click('cv-close');
    await vi.waitFor(() => expect(document.activeElement).toBe(h.q('settings-done')), { timeout: 2_000, interval: 20 });
  });
});
