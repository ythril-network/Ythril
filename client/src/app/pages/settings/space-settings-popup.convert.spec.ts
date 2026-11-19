/**
 * Save on the Schema tab offers the conversion, sends it only when asked, and keeps the popup open on the run (bundle-285 slice S6, Q-747;
 * plan sections 3.1 item 6, 5 rows F and D15, 6, 7, 9 "space-settings-popup.convert.spec.ts"; handover item 3; S5's host rules).
 *
 * The real dialog, the real settings state and the shipped English are mounted; the save, the counts, the run's status, the token and the router
 * are spies (`testing/popup-convert-fixtures.ts`). What these hold, in the pieces a later change could drop without any other test noticing:
 *
 * - **Today's Save is unchanged.** With no changed type (a purpose edited, a media level) nothing new happens: no dialog, no `convertRecords`,
 *   the popup closes on an applied answer. A changed type with no records and no step saves the same way, with the footer saying why.
 * - **The dialog opens exactly when it has something to ask.** A changed type whose records are counted, or not countable yet, or that fails to
 *   count: the dialog. Only counts that SAY zero, for every changed type, with no step, skip it.
 * - **`convertRecords` is sent for "Convert the records now" and for nothing else.** Save only and Cancel send none; Cancel sends nothing at all
 *   and leaves every edit (and the rename ledger) where it was. The wire shape is pinned: an extra top-level key fails.
 * - **A converting Save leaves the popup open**, on the Schema tab with the first converted type selected, with Done in the footer, the staged
 *   edits re-baselined and the ledger cleared exactly as after any save; the dialog turns to the run's progress.
 * - **The run is read on a bound**: at once, then every three seconds while it runs; it ends when it finishes, when the dialog is closed and when the
 *   popup is destroyed; a failed read says so in the footer and is tried again, and is given up after a bound.
 * - **A refusal stays where it can be fixed**: a bad step on its row, the rate limit, the lock, a conversion already running, each in words, with the
 *   dialog still open and Save still possible; a stale schema or a refused rule closes the dialog, because the answer is in the popup.
 * - **A new type made for a split is saved and kept**: it is in the body AND in the staged schema, so a later Save never deletes it.
 * - **A Save that found nothing to convert leaves its note in the pane** (bundle-285 slice S9, drawing 3a "none"): the popup hands the answer to the
 *   Schema tab and the type's bar by input, so the note is there after the dialog is closed and no second request is made for it.
 *
 * ## Seen red
 *
 * Red at 64037445f: the popup has no dialog; Save sends the body at once (the first assertion that the dialog opened fails).
 */
import { By } from '@angular/platform-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import type { Space } from '../../core/api.types';
import { CONVERT_POLL_FAILURES_MAX, CONVERT_POLL_MS } from './convert-status-watch';
import { ConvertRecordsDialogComponent, type ConvertDialogChoice } from './convert-records-dialog.component';
import {
  EN, customers, doneStatus, mountPopup, okStatus, refusedSave, type HarnessOptions, type RecordsByType,
} from '../../testing/popup-convert-fixtures';
import { runningStatus } from '../../testing/review-unconverted-fixtures';

const RENAME_STEP = { op: 'renameProperty', kind: 'entity', type: 'person', from: 'company', to: 'employer' };
const STARTED = { state: 'started', types: [{ kind: 'entity', type: 'person' }], toFp: 'fp1' };
const NONE_YET: RecordsByType = { person: { total: 0, rewritten: 0 }, contact: { total: 0, rewritten: 0 } };
/** More than the footer's wait before it counts: every count is answered at once by the spies. */
const FOOTER_WAIT = 1_000;

const english = (key: string): string => { expect(EN[key], `${key} exists in en.json`).toBeTypeOf('string'); return EN[key]!; };

describe('the popup\'s Save, with a changed type that has records', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens the dialog and sends nothing yet: one block for the type, with the step the rename proposes', () => {
    const h = mountPopup();
    h.open();
    h.renameCompany();
    h.popup.saveSettings();
    h.settle();
    expect(h.updates).toEqual([]);
    expect(h.text('cv-title')).toBe(english('spaces.schema.convert.title'));
    expect(h.root.querySelectorAll('[data-testid="cv-block"]')).toHaveLength(1);
    expect(h.text('cv-sentence')).toContain('employer');
    expect(h.state.settingsSaving()).toBe(false);
  });

  it('Cancel sends nothing, closes the dialog, and leaves every edit and the rename in place', () => {
    const h = mountPopup();
    h.open();
    h.renameCompany();
    h.popup.saveSettings();
    h.settle();
    h.click('cv-cancel');
    expect(h.updates).toEqual([]);
    expect(h.q('cv-title')).toBeNull();
    expect(h.state.isDirty()).toBe(true);
    expect(h.state.renameLedger().props).toHaveLength(1);
    expect(h.state.settingsSaving()).toBe(false);
    expect(h.state.settingsSpace()).not.toBeNull();
  });

  it('Convert the records now sends the steps as `convertRecords`, with the If-Match of the meta, and nothing else new', () => {
    const h = mountPopup();
    h.open();
    h.renameCompany();
    h.popup.saveSettings();
    h.settle();
    h.click('cv-primary');
    expect(h.updates).toHaveLength(1);
    const { body, options } = h.updates[0]!;
    expect(Object.keys(body).sort()).toEqual(['convertRecords', 'meta', 'typeSchemasMode']);
    expect(body['convertRecords']).toEqual({ steps: [RENAME_STEP] });
    expect(body['typeSchemasMode']).toBe('replace');
    const person = (body['meta'] as { typeSchemas: { entity: Record<string, { propertySchemas: Record<string, unknown> }> } }).typeSchemas.entity['person']!;
    expect(Object.keys(person.propertySchemas)).toEqual(['employer', 'email', 'status']);
    expect(options).toEqual({ ifMatch: 3 });
  });

  it('Save only sends today\'s body exactly: no `convertRecords`', () => {
    const h = mountPopup();
    h.open();
    h.renameCompany();
    const today = JSON.parse(JSON.stringify(h.todaysBody())) as Record<string, unknown>;
    h.popup.saveSettings();
    h.settle();
    const later = h.q<HTMLInputElement>('cv-outcome-later')!.querySelector('input')!;
    later.click();
    h.settle();
    h.click('cv-primary');
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]!.body).toEqual(today);
    expect('convertRecords' in h.updates[0]!.body).toBe(false);
  });

  it('an applied Save-only answer closes the popup, as today', () => {
    const h = mountPopup();
    h.open();
    h.renameCompany();
    h.popup.saveSettings();
    h.settle();
    h.q('cv-outcome-later')!.querySelector('input')!.click();
    h.settle();
    h.click('cv-primary');
    expect(h.state.settingsSpace()).toBeNull();
    expect(h.q('cv-title')).toBeNull();
  });

  it('a counted type with records opens the dialog even when counting failed: both outcomes stay offered', () => {
    const h = mountPopup({ records: 'fail' });
    h.open();
    h.renameCompany();
    vi.advanceTimersByTime(FOOTER_WAIT);
    h.popup.saveSettings();
    h.settle();
    expect(h.text('cv-title')).toBe(english('spaces.schema.convert.title'));
  });

  it('a type changed without a rename still opens the dialog: its records are stamped, and the dialog counts them', () => {
    const h = mountPopup();
    h.open();
    h.state.typeState('entity', 'person').suppressEmbeddings = true;
    h.popup.saveSettings();
    h.settle();
    expect(h.text('cv-title')).toBe(english('spaces.schema.convert.title'));
    expect(h.text('cv-stepcount')).toBe(english('spaces.schema.convert.noSteps'));
  });
});

describe('the popup\'s Save, where nothing is asked', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('with no changed type it is today\'s Save: no dialog, no `convertRecords`, the popup closes on an applied answer', () => {
    const h = mountPopup();
    h.open();
    h.state.stForm.purpose = 'a changed purpose';
    h.settle();
    h.popup.saveSettings();
    h.settle();
    expect(h.q('cv-title')).toBeNull();
    expect(h.updates).toHaveLength(1);
    expect('convertRecords' in h.updates[0]!.body).toBe(false);
    expect(Object.keys(h.updates[0]!.body)).toEqual(['meta']);
    expect(h.state.settingsSpace()).toBeNull();
  });

  it('a changed type whose records are counted as none, with no step, saves at once and the footer said why before the press', () => {
    const h = mountPopup({ records: NONE_YET });
    h.open();
    h.renameCompany();
    vi.advanceTimersByTime(FOOTER_WAIT);
    h.settle();
    expect(h.text('convert-none-note')).toBe(english('spaces.schema.convert.noRecords').replace('{{type}}', 'person'));
    h.popup.saveSettings();
    h.settle();
    expect(h.q('cv-title')).toBeNull();
    expect(h.updates).toHaveLength(1);
    expect('convertRecords' in h.updates[0]!.body).toBe(false);
    expect(h.state.settingsSpace()).toBeNull();
  });

  it('the footer says nothing about records while a type that has them is changed, and not before the edit', () => {
    const h = mountPopup();
    h.open();
    expect(h.q('convert-none-note')).toBeNull();
    h.renameCompany();
    vi.advanceTimersByTime(FOOTER_WAIT);
    h.settle();
    expect(h.q('convert-none-note')).toBeNull();
  });

  it('presses before the counts are in: the dialog opens (it counts for itself), nothing is saved behind its back', () => {
    const h = mountPopup({ records: NONE_YET });
    h.open();
    h.renameCompany();
    h.popup.saveSettings();
    h.settle();
    expect(h.updates).toEqual([]);
    expect(h.text('cv-title')).toBe(english('spaces.schema.convert.title'));
  });

  it('says two edited types in one line when neither has records', () => {
    const h = mountPopup({ records: NONE_YET });
    h.open();
    h.renameCompany();
    expect(h.state.renameProp('entity', 'contact', 'name', 'label')).toBeNull();
    h.settle();
    vi.advanceTimersByTime(FOOTER_WAIT);
    h.settle();
    expect(h.text('convert-none-note')).toBe(english('spaces.schema.convert.noRecordsTwo'));
  });
});

describe('what a converting Save leaves behind', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const started = () => mountPopup({
    update: () => of({ space: customers(), convert: STARTED }),
    statuses: [okStatus(runningStatus({ left: 500 })), okStatus(runningStatus({ left: 200 })), okStatus(doneStatus())],
  });

  function convertNow(h: ReturnType<typeof started>): void {
    h.open();
    h.renameCompany();
    h.popup.saveSettings();
    h.settle();
    h.click('cv-primary');
    vi.advanceTimersByTime(0);
    h.settle();
  }

  it('keeps the popup open on the Schema tab with the first converted type selected, Done in the footer, and the staged edits saved', () => {
    const h = started();
    const saved: Space[] = [];
    h.popup.saved.subscribe(s => saved.push(s));
    convertNow(h);
    expect(h.state.settingsSpace()).not.toBeNull();
    expect(h.state.settingsTab()).toBe('schema');
    expect(h.state.schemaCollTab()).toBe('entity');
    expect(h.state.isTypeSelected('entity', 'person')).toBe(true);
    expect(h.state.isDirty()).toBe(false);
    expect(h.state.settingsSubmitted()).toBe(true);
    expect(h.q('settings-done')).not.toBeNull();
    expect(h.q('settings-save')).toBeNull();
    expect(saved).toHaveLength(1);
  });

  it('clears the rename ledger and the "was" notes exactly as after any save', () => {
    const h = started();
    convertNow(h);
    expect(h.state.renameLedger()).toEqual({ types: [], props: [] });
    expect(h.state.typeWas('entity', 'person')).toBeNull();
  });

  it('turns the dialog to the run: the progress title while it runs, the finished title once it has finished', () => {
    const h = started();
    convertNow(h);
    expect(h.text('cv-title')).toBe(english('spaces.schema.convert.run.titleRunning'));
    vi.advanceTimersByTime(CONVERT_POLL_MS * 2);
    h.settle();
    expect(h.text('cv-title')).toBe(english('spaces.schema.convert.run.titleDone'));
  });

  it('reads the status at once, then every three seconds, and stops when the run has finished', () => {
    const h = started();
    convertNow(h);
    expect(h.status).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CONVERT_POLL_MS);
    expect(h.status).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(CONVERT_POLL_MS);
    expect(h.status).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(CONVERT_POLL_MS * 20);
    expect(h.status).toHaveBeenCalledTimes(3);
  });

  it('stops reading when the dialog is closed (the conversion goes on without it)', () => {
    const h = mountPopup({ update: () => of({ space: customers(), convert: STARTED }), statuses: [okStatus(runningStatus())] });
    convertNow(h);
    h.click('cv-close');
    const reads = h.status.mock.calls.length;
    expect(h.q('cv-title')).toBeNull();
    vi.advanceTimersByTime(CONVERT_POLL_MS * 20);
    expect(h.status).toHaveBeenCalledTimes(reads);
    expect(h.state.settingsSpace()).not.toBeNull();
  });

  it('stops reading when the popup is destroyed', () => {
    const h = mountPopup({ update: () => of({ space: customers(), convert: STARTED }), statuses: [okStatus(runningStatus())] });
    convertNow(h);
    const reads = h.status.mock.calls.length;
    h.fixture.destroy();
    vi.advanceTimersByTime(CONVERT_POLL_MS * 20);
    expect(h.status).toHaveBeenCalledTimes(reads);
  });

  it('a read that failed says so in the footer, is tried again, and the sentence goes with the next good answer', () => {
    const failed = { ok: false as const, refusal: { kind: 'other' as const, status: 503, error: 'down' } };
    const h = mountPopup({ update: () => of({ space: customers(), convert: STARTED }), statuses: [failed, failed, okStatus(runningStatus())] });
    convertNow(h);
    expect(h.state.settingsError()).toBe(english('spaces.schema.convert.run.pollFailed'));
    vi.advanceTimersByTime(CONVERT_POLL_MS * 2);
    h.settle();
    expect(h.status).toHaveBeenCalledTimes(3);
    expect(h.state.settingsError()).toBe('');
  });

  it('gives up reading after a bound of failures in a row, and says so', () => {
    const failed = { ok: false as const, refusal: { kind: 'other' as const, status: 503, error: 'down' } };
    const h = mountPopup({ update: () => of({ space: customers(), convert: STARTED }), statuses: [failed] });
    convertNow(h);
    vi.advanceTimersByTime(CONVERT_POLL_MS * (CONVERT_POLL_FAILURES_MAX + 20));
    expect(h.status).toHaveBeenCalledTimes(CONVERT_POLL_FAILURES_MAX);
    expect(h.state.settingsError()).toBe(english('spaces.schema.convert.run.pollFailed'));
  });

  it('a save that found nothing to convert says so in the progress dialog and reads no status', () => {
    const h = mountPopup({ update: () => of({ space: customers(), convert: { state: 'nothing', types: [{ kind: 'entity', type: 'person' }] } }) });
    convertNow(h);
    expect(h.text('cv-title')).toBe(english('spaces.schema.convert.run.titleDone'));
    expect(h.root.textContent).toContain(english('spaces.schema.convert.run.noneHere'));
    expect(h.status).not.toHaveBeenCalled();
    expect(h.state.settingsSpace()).not.toBeNull();
  });

  it('a conversion that did not start says why, keeps the schema saved, and reads no status', () => {
    const h = mountPopup({ update: () => of({ space: customers(), convert: { state: 'not_started', types: [{ kind: 'entity', type: 'person' }], error: 'the store is busy' } }) });
    convertNow(h);
    expect(h.root.textContent).toContain('the store is busy');
    expect(h.status).not.toHaveBeenCalled();
    expect(h.state.isDirty()).toBe(false);
  });

  it('an answer that carries no `convert` (an older server) is a saved schema with nothing to convert, never a closed popup that hid it', () => {
    const h = mountPopup({ update: () => of({ space: customers() }) });
    convertNow(h);
    expect(h.state.settingsSpace()).not.toBeNull();
    expect(h.root.textContent).toContain(english('spaces.schema.convert.run.noneHere'));
  });

  it('Open Review leaves for the Review tab on Unconverted, asking nothing of a popup with no unsaved edit', async () => {
    const h = started();
    convertNow(h);
    h.click('cv-open-review');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.navigate).toHaveBeenCalledWith(['/brain'], { queryParams: { space: 'customers', tab: 'review', section: 'unconverted' } });
    expect(h.state.settingsSpace()).toBeNull();
  });
});

describe('the pane of the type a converting Save found no records for', () => {
  const nothing = (types: unknown[] = [{ kind: 'entity', type: 'person' }]) =>
    mountPopup({ update: () => of({ space: customers(), convert: { state: 'nothing', types } }), statuses: [okStatus({ state: 'none' })] });

  /** Save and convert, close the progress dialog, and let the deferred Schema tab render: the pane is what is left on the page. */
  async function savedAndClosed(h: ReturnType<typeof nothing>): Promise<HTMLElement | null> {
    h.open();
    h.renameCompany();
    h.popup.saveSettings();
    h.settle();
    h.click('cv-primary');
    h.click('cv-close');
    await tabRendered(h);
    return h.q('convert-note');
  }

  /** The Schema tab sits in a deferred block with a minimum loading time (real time): wait for the type's head, never for a fixed moment. */
  async function tabRendered(h: ReturnType<typeof nothing>): Promise<void> {
    await vi.waitFor(async () => {
      h.settle();
      await h.fixture.whenStable();
      h.settle();
      if (!h.root.querySelector('.sch-detail-head')) throw new Error('the Schema tab never rendered the type head');
    }, { timeout: 5_000, interval: 50 });
  }

  it('says "Schema saved." in strong text and that there were no records to convert, after the dialog is closed', async () => {
    const note = await savedAndClosed(nothing());
    expect(note, 'the pane holds the note').not.toBeNull();
    expect(note!.querySelector('strong')!.textContent!.trim()).toBe(english('spaces.schema.convert.note.saved'));
    expect(note!.textContent!.replace(/\s+/g, ' ').trim()).toBe(`${english('spaces.schema.convert.note.saved')} ${english('spaces.schema.convert.note.none')}`);
  });

  it('says it with the converted type\'s name even when the answer lists no types, and for an older server\'s answer with no `convert` at all', async () => {
    expect(await savedAndClosed(nothing([]))).not.toBeNull();
    expect(await savedAndClosed(mountPopup({ update: () => of({ space: customers() }), statuses: [okStatus({ state: 'none' })] }))).not.toBeNull();
  });

  it('starts no conversion for it and sends no second save: the save answered it, and the pane is told by input', async () => {
    const h = nothing();
    expect(await savedAndClosed(h), 'the note is there').not.toBeNull();
    expect(h.start).not.toHaveBeenCalled();
    expect(h.updates).toHaveLength(1);
  });

  it('goes with the space: opening the settings again shows no such note', async () => {
    const h = nothing();
    expect(await savedAndClosed(h), 'the note is there before').not.toBeNull();
    h.state.closeSettings();
    h.settle();
    h.open();
    h.state.settingsTab.set('schema');
    h.state.selectType('entity', 'person');
    await tabRendered(h);
    expect(h.q('convert-note')).toBeNull();
  });
});

describe('a refused converting Save', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function offered(update: NonNullable<HarnessOptions['update']>) {
    const h = mountPopup({ update });
    h.open();
    h.renameCompany();
    h.popup.saveSettings();
    h.settle();
    h.click('cv-primary');
    return h;
  }

  it('a bad step is shown on its row, the dialog stays open, and Save can be tried again', () => {
    const h = offered(() => refusedSave(400, { code: 'bad_conversion_step', step: 0, error: 'Step 1: the name is taken' }));
    expect(h.text('cv-title')).toBe(english('spaces.schema.convert.title'));
    expect(h.root.textContent).toContain('Step 1: the name is taken');
    expect(h.state.settingsSaving()).toBe(false);
    h.click('cv-primary');
    expect(h.updates).toHaveLength(2);
  });

  it('the rate limit says to wait, with the seconds the server named', () => {
    const h = offered(() => refusedSave(429, { code: 'schema_convert_rate_limited', error: 'slow down' }, { 'Retry-After': '5' }));
    expect(h.text('cv-refusal')).toContain(english('spaces.schema.convert.rateLimited'));
    expect(h.text('cv-refusal')).toContain(english('spaces.schema.convert.retryIn').replace('{{seconds}}', '5'));
    expect(h.q('cv-title')).not.toBeNull();
  });

  it('a missing right locks the choice with its reason, and Save only is still possible', () => {
    const h = offered(() => refusedSave(403, { code: 'knowledge_rung', error: 'needs admin' }));
    expect(h.q('cv-locked')).not.toBeNull();
    expect(h.q('cv-outcome-now')!.querySelector('input')!.disabled).toBe(true);
    expect(h.state.settingsSaving()).toBe(false);
  });

  it('a conversion already running says so', () => {
    const h = offered(() => refusedSave(409, { code: 'schema_convert_running', error: 'running' }));
    expect(h.text('cv-refusal')).toBe(english('spaces.schema.convert.running409'));
  });

  it('any other refusal shows what the server said, in the dialog', () => {
    const h = offered(() => refusedSave(500, { error: 'the store is down' }));
    expect(h.text('cv-refusal')).toContain('the store is down');
    expect(h.q('cv-title')).not.toBeNull();
  });

  it('a stale schema (412) closes the dialog: the answer is the popup\'s Reload button', () => {
    const h = offered(() => refusedSave(412, { error: 'changed' }));
    expect(h.q('cv-title')).toBeNull();
    expect(h.state.settingsConflict()).toBe(true);
    expect(h.q('reload-schema')).not.toBeNull();
  });

  it('a refused rule closes the dialog and opens the rule: the answer is in the Schema tab', () => {
    const space = customers();
    (space.meta!.typeSchemas as Record<string, Record<string, Record<string, unknown>>>)['entity']!['person']!['rules'] = { 'has-company': { rule: 'self.properties.employer != ""', message: 'm' } };
    const h = mountPopup({ space, update: () => refusedSave(400, { error: 'rule broke', issues: [{ path: ['meta', 'typeSchemas', 'entity', 'person', 'rules', 'has-company'], message: 'bad' }] }) });
    h.open();
    h.renameCompany();
    h.popup.saveSettings();
    h.settle();
    h.click('cv-primary');
    expect(h.q('cv-title')).toBeNull();
    expect(h.state.ruleRefusal()).not.toBeNull();
    expect(h.state.settingsTab()).toBe('schema');
  });
});

describe('a type "Add a new type" made for a split', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const SPLIT = { op: 'splitType', kind: 'entity', from: 'person', cases: [{ when: 'self.properties.status == "lead"', to: 'organization' }] };

  function choose(h: ReturnType<typeof mountPopup>, choice: ConvertDialogChoice): void {
    const dialog = h.fixture.debugElement.query(By.directive(ConvertRecordsDialogComponent)).componentInstance as ConvertRecordsDialogComponent;
    dialog.choice.emit(choice);
    h.settle();
  }

  it('is in the body as a copy of its source and in the staged schema, so a later Save cannot delete it', () => {
    const h = mountPopup();
    h.open();
    h.renameCompany();
    h.popup.saveSettings();
    h.settle();
    choose(h, {
      outcome: 'convert', steps: [RENAME_STEP, SPLIT] as never,
      blocks: [{ kind: 'entity', type: 'person', steps: [RENAME_STEP, SPLIT] as never }], types: [{ kind: 'entity', type: 'person' }],
      addedTypes: [{ kind: 'entity', name: 'organization', copyOf: 'person' }],
    });
    const sent = (h.updates[0]!.body['meta'] as { typeSchemas: { entity: Record<string, unknown> } }).typeSchemas.entity;
    expect(Object.keys(sent).sort()).toEqual(['contact', 'organization', 'person']);
    expect(sent['organization']).toEqual(sent['person']);
    expect(h.state.typeNames('entity')).toContain('organization');
    expect((h.updates[0]!.body['convertRecords'] as { steps: unknown[] }).steps).toHaveLength(2);
    // the dialog's answer is taken once: the state is saved with the new type in it
    expect(h.state.isDirty()).toBe(false);
  });
});

describe('the Save button\'s own words', () => {
  it('says Save changes while nothing makes the save a vote', () => {
    const h = mountPopup();
    h.open();
    expect(h.text('settings-save')).toBe(english('spaces.popup.footer.saveChanges'));
  });
});
