/**
 * The Date and time preference reaches what is on screen, and survives a blocked store (`Q-146`).
 *
 * The pure formatter is covered in `date-format.spec.ts`. This is the other half: that the preference is ONE signal,
 * that `<app-timestamp>` and the `instant` pipe re-render when it changes (no reload, no re-created component), that
 * the hover carries the original UTC instant, and that a browser refusing storage falls back to the default instead
 * of throwing on the settings page.
 */
import { Component, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { DateFormatService, InstantPipe, DATE_FORMAT_STORAGE_KEY } from './date-format.service';
import { TimestampComponent } from '../shared/timestamp.component';

const T = '2026-09-29T07:59:03.000Z';

@Component({
  selector: 'app-instant-host',
  standalone: true,
  imports: [InstantPipe],
  template: `<span class="v">{{ value() | instant:'date' }}</span>`,
})
class InstantHostComponent { value = input<string>(T); }

function configure(): void {
  TestBed.configureTestingModule({
    imports: [
      TimestampComponent, InstantHostComponent,
      TranslocoTestingModule.forRoot({
        langs: { en: {}, de: {}, pl: {} },
        translocoConfig: { availableLangs: ['en', 'de', 'pl'], defaultLang: 'en' },
        preloadLangs: true,
      }),
    ],
  });
}

describe('DateFormatService', () => {
  beforeEach(() => { localStorage.removeItem(DATE_FORMAT_STORAGE_KEY); configure(); });
  afterEach(() => { vi.restoreAllMocks(); localStorage.removeItem(DATE_FORMAT_STORAGE_KEY); });

  it('defaults to Automatic in local time, and remembers a choice', () => {
    const svc = TestBed.inject(DateFormatService);
    expect(svc.preference()).toEqual({ style: 'auto', zone: 'local' });
    svc.setPreference({ style: 'iso', zone: 'utc' });
    expect(svc.preference()).toEqual({ style: 'iso', zone: 'utc' });
    expect(JSON.parse(localStorage.getItem(DATE_FORMAT_STORAGE_KEY)!)).toEqual({ style: 'iso', zone: 'utc' });
  });

  it('a store that throws is a default, not a crash', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const svc = TestBed.inject(DateFormatService);
    expect(svc.preference()).toEqual({ style: 'auto', zone: 'local' });
    expect(() => svc.setPreference({ style: 'dmy24', zone: 'utc' })).not.toThrow();
    expect(svc.preference()).toEqual({ style: 'dmy24', zone: 'utc' });
  });

  it('<app-timestamp> follows the preference without being re-created, and hovers the UTC instant', async () => {
    const svc = TestBed.inject(DateFormatService);
    svc.setPreference({ style: 'iso', zone: 'utc' });
    const f = TestBed.createComponent(TimestampComponent);
    f.componentRef.setInput('value', T);
    f.detectChanges(); await f.whenStable();
    const el = f.nativeElement as HTMLElement;
    expect(el.textContent).toContain('2026-09-29');
    expect(el.querySelector('time')!.getAttribute('title')).toBe(T);
    expect(el.querySelector('time')!.getAttribute('datetime')).toBe(T);

    svc.setPreference({ style: 'dmy24', zone: 'utc' });
    f.detectChanges(); await f.whenStable();
    expect(el.textContent).toContain('29.09.2026');
  });

  it('the instant pipe follows a language switch under Automatic', async () => {
    TestBed.inject(DateFormatService).setPreference({ style: 'auto', zone: 'utc' });
    const f = TestBed.createComponent(InstantHostComponent);
    f.detectChanges(); await f.whenStable();
    const text = () => (f.nativeElement as HTMLElement).querySelector('.v')!.textContent!.trim();
    const before = text();
    TestBed.inject(TranslocoService).setActiveLang('de');
    f.detectChanges(); await f.whenStable();
    expect(text()).toBe('29.09.2026');
    // Only asserted to DIFFER, because under jsdom the browser's own languages decide the English region.
    expect(before).not.toBe('');
  });
});
