import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { TranslocoTestingModule } from '@jsverse/transloco';
import { TimestampComponent } from './timestamp.component';
import { DateFormatService } from '../core/date-format.service';
import { instantParts } from '../core/date-format';

/**
 * The absolute-time treatment for data tables. The formatting rules are asserted in `core/date-format.spec.ts`;
 * these are the ones that belong to the two-line cell, each pinned to the ISO format in UTC so no assertion depends
 * on the machine's zone or language.
 */
describe('instantParts, the two lines of a cell', () => {
  const UTC_NOON = '2026-08-10T12:00:03.000Z';

  it('renders the date and the time SEPARATELY, the time with SECONDS', () => {
    // `HH:mm` was the majority format before. An audit log where two entries share a minute is unreadable without these.
    const p = instantParts(UTC_NOON, { style: 'dmy24', zone: 'local', locale: 'de', timeZone: 'UTC' })!;
    expect(p.date).toBe('10.08.2026');
    expect(p.time).toBe('12:00:03');
  });

  it('a named format uses a 24-hour clock whatever the locale', () => {
    expect(instantParts('2026-08-10T23:59:03.000Z', { style: 'iso', zone: 'local', locale: 'en-US', timeZone: 'UTC' })!.time)
      .toBe('23:59:03');
  });

  it('accepts an ISO string, epoch-ms and a Date alike', () => {
    const ms = Date.parse(UTC_NOON);
    for (const v of [UTC_NOON, ms, new Date(ms)]) {
      expect(instantParts(v, { style: 'iso', zone: 'utc', locale: 'en' })!.time).toBe('12:00:03 UTC');
    }
  });
});

describe('TimestampComponent', () => {
  const render = (value: unknown) => {
    const f = TestBed.createComponent(TimestampComponent);
    f.componentRef.setInput('value', value);
    f.detectChanges();
    return f;
  };

  beforeEach(async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [TimestampComponent, TranslocoTestingModule.forRoot({ langs: { en: {} }, translocoConfig: { availableLangs: ['en'], defaultLang: 'en' } })],
    }).compileComponents();
    TestBed.inject(DateFormatService).setPreference({ style: 'iso', zone: 'utc' });
  });

  it('renders two lines inside a machine-readable <time>', () => {
    const el = render('2026-08-10T12:00:03.000Z').nativeElement as HTMLElement;
    expect(el.querySelector('.d')!.textContent).toBe('2026-08-10');
    expect(el.querySelector('.t')!.textContent).toBe('12:00:03 UTC');
    expect(el.querySelector('time')!.getAttribute('datetime')).toBe('2026-08-10T12:00:03.000Z');
  });

  it('shows a dash for an absent value, not an empty cell', () => {
    // An empty cell reads as a layout bug and invites someone to "fix" the component.
    const el = render(null).nativeElement as HTMLElement;
    expect(el.textContent!.trim()).toBe('—');
    expect(el.querySelector('time')).toBe(null);
  });

  it('exposes epoch-ms as a sort key', () => {
    const f = render('2026-08-10T12:00:03.000Z');
    expect(f.componentInstance.sortKey()).toBe(Date.parse('2026-08-10T12:00:03.000Z'));
  });

  it('sortKey is null when the value is unusable, rather than 0', () => {
    // Zero would sort a broken row to 1970 and look like real data.
    expect(render('nonsense').componentInstance.sortKey()).toBe(null);
  });
});
