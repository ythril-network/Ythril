/**
 * The Convert act from the type's head, inside the settings popup, and what follows a run's dialog (bundle-285 slice S10, Q-747; the browser drive's
 * D3, D5 and moment 3a).
 *
 * The act is started by the type's bar; the run it starts is shown by the SAME progress dialog a converting Save leaves open, through the same
 * path in the popup (its `progress` signal, its watch, its Open Review), so there is one way a run is shown. What these hold:
 *
 * - **The act turns to the run.** After Convert records the act's dialog goes and the progress dialog shows the run, read on the watch's bound,
 *   with a title that says records are being converted and nothing of a saved schema (the act saves none).
 *
 * ## Seen red
 *
 * Red at 96ba05fbc: after Convert records no dialog is open (the act's dialog closes and the popup is never told).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EN, mountPopup, okStatus } from '../../testing/popup-convert-fixtures';
import { runningStatus } from '../../testing/review-unconverted-fixtures';

const english = (key: string): string => { expect(EN[key], `${key} exists in en.json`).toBeTypeOf('string'); return EN[key]!; };
const ACT = [{ kind: 'act' as const, at: '2026-11-19T10:00:00.000Z' }];

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

afterEach(() => vi.useRealTimers());

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
