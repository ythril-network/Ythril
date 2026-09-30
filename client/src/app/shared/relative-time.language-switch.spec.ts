/**
 * A relative time re-renders when the viewer switches language — without a reload (`Q-100`).
 *
 * `RelativeTimeComponent` read the language with `transloco.getActiveLang()` inside a `computed`. That is a plain
 * method call, not a signal, so the computed never learned the language had changed: under OnPush and zoneless
 * change detection "2 hours ago" stayed English after the switch to Deutsch until something else re-created it.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { RelativeTimeComponent } from './relative-time.component';

describe('RelativeTimeComponent follows a language switch', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [
        RelativeTimeComponent,
        TranslocoTestingModule.forRoot({
          langs: { en: {}, de: {}, pl: {} },
          translocoConfig: { availableLangs: ['en', 'de', 'pl'], defaultLang: 'en' },
          preloadLangs: true,
        }),
      ],
    });
  });

  it('renders "vor 2 Stunden" after the switch, having rendered "2 hours ago" before it', async () => {
    const fixture = TestBed.createComponent(RelativeTimeComponent);
    fixture.componentRef.setInput('value', new Date(Date.now() - 2 * 3600_000).toISOString());
    fixture.detectChanges();
    await fixture.whenStable();
    const text = () => (fixture.nativeElement as HTMLElement).textContent?.trim() ?? '';
    expect(text()).toMatch(/2 hours ago/);

    TestBed.inject(TranslocoService).setActiveLang('de');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(text()).toMatch(/vor 2 Stunden/);
  });
});
