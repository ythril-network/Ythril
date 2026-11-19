/**
 * Save on a networked space: the conversion goes into the vote, and the popup says so (bundle-285 slice S6, Q-747; plan sections 3.1 item 6, 5 rows
 * F2, F3, F5 and N1 to N6, 9; handover item 4; drawing moments 4a and 4b).
 *
 * A space in a network does not apply a schema change on the spot: the server opens a vote and answers 202 with no `space`. What the page then
 * holds true, with the real dialog and the shipped English mounted (`testing/popup-convert-fixtures.ts`):
 *
 * - **The offer is the vote's.** The dialog's title, lead and radio say the choice goes into the vote, name the network, and count "here"; the
 *   footer button says Submit for vote once the changed types hold records, and Save changes before that.
 * - **A conversion that goes with the vote is submitted view.** The 202 answer turns the dialog to "Submitted for a vote" with the steps and the
 *   way to Networks; the footer says it too and offers Done; the popup stays open; the staged edits are re-baselined.
 * - **Save only is today's networked Save**: no `convertRecords`, the plain pending notice, no submitted view. Cancel sends nothing.
 * - **`convertRecords` is still sent only for "convert after the vote"**, with the same wire shape as an applied save.
 * - **A mixed answer** (applied in one network, pending in another) keeps both halves: the footer names both, and the run the applied half
 *   started is shown.
 *
 * ## Seen red
 *
 * The networked code path shares the save with the applied one (`SpaceSettingsPopupComponent.send`), so it landed with it, and this file was
 * written after the code it pins: its first run (2bcd92f5a) was 9 green and 1 red, "AssertionError: expected 'Submitted for a vote in .' to be
 * 'Submitted for a vote in Acme team.'" - the notice was asked for with the wrong parameter name. The other nine would be red against the commit
 * before 2bcd92f5a, where the popup has no dialog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { EN, customers, mountPopup, okStatus } from '../../testing/popup-convert-fixtures';
import { runningStatus } from '../../testing/review-unconverted-fixtures';

const english = (key: string): string => { expect(EN[key], `${key} exists in en.json`).toBeTypeOf('string'); return EN[key]!; };

const ACME = { id: 'net-1', label: 'Acme team', type: 'democratic' };
const networked = () => customers({ networks: [ACME] } as never);
const PENDING = { status: 'vote_pending', rounds: [{ networkId: 'net-1', networkLabel: 'Acme team', roundId: 'r1', outcome: 'vote_pending' }] };
const AFTER_VOTE = { state: 'after_vote', types: [{ kind: 'entity', type: 'person' }] };

describe('a networked Save with a changed type that has records', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function offered(update?: (body: Record<string, unknown>) => ReturnType<typeof of>) {
    const h = mountPopup({ space: networked(), update: update ?? (() => of({ ...PENDING, convert: AFTER_VOTE }) as never) });
    h.open();
    h.renameCompany();
    h.popup.saveSettings();
    h.settle();
    return h;
  }

  it('opens the vote\'s offer: its title, its lead naming the network, Convert after the vote, and counts "here"', () => {
    const h = offered();
    expect(h.text('cv-title')).toBe(english('spaces.schema.convert.titleNet'));
    expect(h.text('cv-lead')).toContain('Acme team');
    expect(h.text('cv-outcome-now')).toContain(english('spaces.schema.convert.afterVote'));
    expect(h.text('cv-counts')).toContain('640 records of person here: 41 will only be stamped, 599 will be rewritten.');
    expect(h.text('cv-primary')).toBe(english('spaces.schema.convert.submitWith'));
    expect(h.updates).toEqual([]);
  });

  it('says Submit for vote on the footer button once the changed types hold records, and Save changes before', () => {
    const h = mountPopup({ space: networked() });
    h.open();
    expect(h.text('settings-save')).toBe(english('spaces.popup.footer.saveChanges'));
    h.renameCompany();
    expect(h.text('settings-save')).toBe(english('spaces.popup.footer.saveChanges'));
    vi.advanceTimersByTime(1_000);
    h.settle();
    expect(h.text('settings-save')).toBe(english('spaces.schema.convert.submitForVote'));
  });

  it('Submit with conversion sends the steps with the vote, in the same wire shape as an applied save', () => {
    const h = offered();
    h.click('cv-primary');
    expect(h.updates).toHaveLength(1);
    expect(Object.keys(h.updates[0]!.body).sort()).toEqual(['convertRecords', 'meta', 'typeSchemasMode']);
    expect(h.updates[0]!.body['convertRecords']).toEqual({ steps: [{ op: 'renameProperty', kind: 'entity', type: 'person', from: 'company', to: 'employer' }] });
  });

  it('turns the dialog to "Submitted for a vote" with the steps, and keeps the popup open with the notice and Done', () => {
    const h = offered();
    h.click('cv-primary');
    expect(h.text('cv-title')).toBe(english('spaces.schema.convert.submitted.title'));
    expect(h.text('cv-lead')).toContain('Acme team');
    expect(h.text('cv-sentence')).toContain('employer');
    expect(h.text('cv-primary')).toBe(english('spaces.schema.convert.submitted.openNetworks'));
    expect(h.state.settingsSpace()).not.toBeNull();
    expect(h.state.settingsNotice()).toBe(english('spaces.schema.convert.submitted.notice').replace('{{network}}', 'Acme team'));
    expect(h.state.isDirty()).toBe(false);
    expect(h.state.settingsSubmitted()).toBe(true);
    expect(h.q('settings-done')).not.toBeNull();
    expect(h.status).not.toHaveBeenCalled();
  });

  it('Open Networks goes to the vote\'s page and closes the settings', async () => {
    const h = offered();
    h.click('cv-primary');
    h.click('cv-primary');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.navigate).toHaveBeenCalledWith(['/settings/networks']);
    expect(h.state.settingsSpace()).toBeNull();
  });

  it('closing the submitted view leaves the popup open with its notice', () => {
    const h = offered();
    h.click('cv-primary');
    h.click('cv-close');
    expect(h.q('cv-title')).toBeNull();
    expect(h.state.settingsSpace()).not.toBeNull();
    expect(h.state.settingsSubmitted()).toBe(true);
  });

  it('Save only sends no `convertRecords` and says what today\'s networked Save says, with no submitted view', () => {
    const h = offered(() => of(PENDING) as never);
    h.q('cv-outcome-later')!.querySelector('input')!.click();
    h.settle();
    expect(h.text('cv-primary')).toBe(english('spaces.schema.convert.submitForVote'));
    h.click('cv-primary');
    expect('convertRecords' in h.updates[0]!.body).toBe(false);
    expect(h.q('cv-title')).toBeNull();
    expect(h.state.settingsNotice()).toBe(english('spaces.settings.votePending').replace('{{networks}}', 'Acme team'));
    expect(h.state.settingsSubmitted()).toBe(true);
  });

  it('Cancel sends nothing and leaves the edit', () => {
    const h = offered();
    h.click('cv-cancel');
    expect(h.updates).toEqual([]);
    expect(h.state.isDirty()).toBe(true);
  });

  it('a space in two networks, applied in one and pending in the other, names both and shows the run the applied half started', () => {
    const answer = {
      space: customers(), convert: { state: 'started', types: [{ kind: 'entity', type: 'person' }], toFp: 'fp' },
      layers: [{ networkId: 'a', networkLabel: 'Alpha', outcome: 'applied' }, { networkId: 'b', networkLabel: 'Beta', outcome: 'vote_pending' }],
    };
    const h = mountPopup({ space: networked(), update: () => of(answer) as never, statuses: [okStatus(runningStatus())] });
    h.open();
    h.renameCompany();
    h.popup.saveSettings();
    h.settle();
    h.click('cv-primary');
    vi.advanceTimersByTime(0);
    h.settle();
    expect(h.state.settingsNotice()).toContain('Alpha');
    expect(h.state.settingsNotice()).toContain('Beta');
    expect(h.text('cv-title')).toBe(english('spaces.schema.convert.run.titleRunning'));
    expect(h.state.settingsSpace()).not.toBeNull();
  });
});

describe('a networked Save where nothing is asked', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('says that saving opens a vote and that there are no records, then submits without a dialog', () => {
    const h = mountPopup({ space: networked(), records: { person: { total: 0, rewritten: 0 } }, update: () => of(PENDING) as never });
    h.open();
    h.renameCompany();
    vi.advanceTimersByTime(1_000);
    h.settle();
    expect(h.text('convert-none-note')).toBe(english('spaces.schema.convert.noRecordsNet').replace('{{network}}', 'Acme team').replace('{{type}}', 'person'));
    h.popup.saveSettings();
    h.settle();
    expect(h.q('cv-title')).toBeNull();
    expect(h.updates).toHaveLength(1);
    expect('convertRecords' in h.updates[0]!.body).toBe(false);
    expect(h.state.settingsNotice()).toBe(english('spaces.settings.votePending').replace('{{networks}}', 'Acme team'));
  });
});
