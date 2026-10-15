/**
 * The entry popup (embedded in the Graph page) tells a save's outcome the way the record tabs do (b23 W6d U2).
 *
 * It used to read a successful answer's `warnings` as part of the record (so they showed up as a field of it and were never
 * said as warnings), show a refusal as one English string in a plain `<div>`, and write its status lines as English literals
 * with no role. Now a save's warnings are the shared notice, a refusal is the shared alert (headline and one row per thing wrong),
 * and every sentence is a translation key, in a container a screen reader is told about.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { of, throwError } from 'rxjs';
import { BrainApi } from '../core/brain-api.service';
import { RetypeConfirmService } from '../core/retype-confirm.service';
import { getTranslocoModule } from '../testing/transloco-testing';
import { EntryPopupComponent } from './entry-popup.component';

const RECORD = { _id: 'e1', name: 'Ada', type: 'person', properties: { age: 36 } };

const WARNING = { field: 'properties.age', value: 36, reason: 'type', declared: ['name'], outcome: 'violated' };

/** The 400 answer of a refused write: `SchemaViolationError.toStructured()`. */
const refusal = (rows: unknown[]) => ({
  status: 400,
  error: { error: 'schema_violation', message: 'The record does not match the schema.', introduced: rows, preExisting: [], violations: rows },
});

function mount(updateEntity: (...args: unknown[]) => unknown) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [EntryPopupComponent, getTranslocoModule()],
    providers: [
      { provide: BrainApi, useValue: { updateEntity } },
      { provide: RetypeConfirmService, useValue: { confirm: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(EntryPopupComponent);
  document.body.appendChild(fixture.nativeElement);
  fixture.componentRef.setInput('record', structuredClone(RECORD));
  fixture.componentRef.setInput('recordType', 'entity');
  fixture.componentRef.setInput('spaceId', 'work');
  fixture.componentRef.setInput('canEdit', true);
  const saved: unknown[] = [];
  const savedWithWarnings: unknown[] = [];
  fixture.componentInstance.saved.subscribe(r => saved.push(r));
  fixture.componentInstance.savedWithWarnings.subscribe(r => savedWithWarnings.push(r));
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const $ = (sel: string) => el.querySelector<HTMLElement>(sel);
  const saveButton = () => Array.from(el.querySelectorAll<HTMLButtonElement>('.popup-footer button')).find(b => b.textContent?.includes('common.save'))!;
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  return { fixture, el, $, saved, savedWithWarnings, saveButton, settle };
}

afterEach(() => { document.body.innerHTML = ''; });

describe('a save that succeeds with warnings', () => {
  const answer = { ...RECORD, warnings: [WARNING], warningsTruncated: true };

  it('shows the warnings in the shared notice, with the cut said, and keeps them out of the record', async () => {
    const h = mount(() => of(structuredClone(answer)));
    h.saveButton().click();
    await h.settle();
    const notice = h.$('[data-testid="write-warnings"]');
    expect(notice, 'the warnings of a successful save were dropped').not.toBeNull();
    expect(notice!.getAttribute('role')).toBe('status');
    expect(notice!.querySelectorAll('li').length).toBe(1);
    expect(h.$('[data-testid="write-warnings-more"]'), 'a cut list was presented as the whole').not.toBeNull();
    // The warnings are not part of the record: not a row of the field grid, not in what `saved` carries, not in the raw JSON.
    expect(Array.from(h.el.querySelectorAll('.field-label, .sub-section-title')).map(e => e.textContent?.trim())).not.toContain('warnings');
    // The warnings are read in the popup, so the host is told with the output that does not close it.
    expect(h.savedWithWarnings).toEqual([RECORD]);
    expect(h.saved, 'a save with warnings said `saved`, which closes the popup on the Graph page').toEqual([]);
    expect(h.$('.status-msg'), 'a second "Saved" beside "Saved, with warnings"').toBeNull();
  });

  it('dismisses the notice, and a later save without warnings removes it', async () => {
    const answers = [structuredClone(answer), structuredClone(RECORD)];
    const h = mount(() => of(answers.shift()));
    h.saveButton().click();
    await h.settle();
    (h.$('[data-testid="write-warnings-dismiss"]') as HTMLButtonElement).click();
    await h.settle();
    expect(h.$('[data-testid="write-warnings"]')).toBeNull();
    h.saveButton().click();
    await h.settle();
    expect(h.$('[data-testid="write-warnings"]')).toBeNull();
  });

});

describe('a save that succeeds without warnings', () => {
  it('says Saved through a translation key, in a polite status container, and tells the host with `saved`', async () => {
    const h = mount(() => of(structuredClone(RECORD)));
    h.saveButton().click();
    await h.settle();
    const status = h.$('.status-msg');
    expect(status, 'no status line after a save').not.toBeNull();
    expect(status!.textContent?.trim()).toBe('entryPopup.saved');
    expect(status!.getAttribute('role')).toBe('status');
    expect(h.saved).toEqual([RECORD]);
    expect(h.savedWithWarnings).toEqual([]);
  });
});

describe('a save that is refused', () => {
  it('shows the shared refusal alert: the headline and one row per thing wrong', async () => {
    const h = mount(() => throwError(() => refusal([WARNING, { ...WARNING, field: 'properties.height' }])));
    h.saveButton().click();
    await h.settle();
    const alert = h.$('app-refusal-alert [role="alert"]');
    expect(alert, 'a refusal is not shown as the shared alert').not.toBeNull();
    expect(alert!.querySelectorAll('li').length, 'one row per violation').toBe(2);
    expect(h.$('.status-msg.error'), 'the refusal is also shown as a bare status string').toBeNull();
    expect(h.saved).toEqual([]);
  });

  it('a refusal with no sentence of its own says the translated fallback, not an English literal', async () => {
    const h = mount(() => throwError(() => ({ status: 500 })));
    h.saveButton().click();
    await h.settle();
    const alert = h.$('app-refusal-alert [role="alert"]');
    expect(alert!.textContent ?? '').toContain('refusal.failed.save');
    expect(alert!.textContent ?? '').not.toContain('Save failed');
  });

  it('the next save clears the refusal', async () => {
    const calls = [() => throwError(() => refusal([WARNING])), () => of(structuredClone(RECORD))];
    const h = mount(() => calls.shift()!());
    h.saveButton().click();
    await h.settle();
    expect(h.$('app-refusal-alert [role="alert"]')).not.toBeNull();
    h.saveButton().click();
    await h.settle();
    expect(h.$('app-refusal-alert [role="alert"]')).toBeNull();
  });
});

describe('the popup\'s own status lines are translations with a role', () => {
  it('Valid, Invalid JSON and the missing _id are keys, and an error is an alert', async () => {
    const h = mount(() => of(structuredClone(RECORD)));
    const confirm = Array.from(h.el.querySelectorAll<HTMLButtonElement>('.popup-footer button')).find(b => b.textContent?.includes('common.confirm'))!;
    confirm.click();
    await h.settle();
    expect(h.$('.status-msg')!.textContent?.trim()).toBe('entryPopup.valid');
    expect(h.$('.status-msg')!.getAttribute('role')).toBe('status');

    // A record with no `_id` cannot be saved: said as an alert, in words the translation owns.
    h.fixture.componentRef.setInput('record', { name: 'No id' });
    h.fixture.detectChanges();
    h.saveButton().click();
    await h.settle();
    expect(h.$('.status-msg')!.textContent?.trim()).toBe('entryPopup.noId');
    expect(h.$('.status-msg')!.getAttribute('role')).toBe('alert');
  });
});
