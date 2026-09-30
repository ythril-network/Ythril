/**
 * The viewer's Date and time preference, as ONE signal every date view reads (`Q-146`), and the pipe for inline text.
 *
 * The formatting itself is `date-format.ts` and pure. This file is the reactive half, and it exists because the
 * reactive half is what the shared components got wrong: `RelativeTimeComponent` read the language with a plain
 * `getActiveLang()` inside a `computed`, so a switch to Deutsch never reached it (`Q-100`). Here the language is a
 * signal (from `langChanges$`), the preference is a signal, and anything that formats through `format()` inside a
 * template or a `computed` re-renders when either changes — no reload, no re-created component.
 *
 * Kept per BROWSER, in localStorage, beside the language (`'lang'`): this app has tokens, not user accounts, so there
 * is nowhere per-user on the server to keep it, and a display preference belongs with the display. Every storage
 * access is guarded — a private window or blocked site data answers the default, never an exception on the page.
 */
import { Injectable, Pipe, PipeTransform, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslocoService } from '@jsverse/transloco';
import {
  DEFAULT_DATE_PREFERENCE, formatCalendarDate, formatInstant, formatRelativeTime, instantParts, isoOf, parsePreference,
  resolveAutoLocale, type DateFormatOptions, type DatePreference, type InstantValue, type InstantVariant,
} from './date-format';

export const DATE_FORMAT_STORAGE_KEY = 'dateFormat';

function readStored(): DatePreference {
  try { return parsePreference(localStorage.getItem(DATE_FORMAT_STORAGE_KEY)); } catch { return { ...DEFAULT_DATE_PREFERENCE }; }
}

@Injectable({ providedIn: 'root' })
export class DateFormatService {
  private readonly transloco = inject(TranslocoService);

  private readonly _preference = signal<DatePreference>(readStored());
  /** What the viewer chose: the format and whether times are local or UTC. */
  readonly preference = this._preference.asReadonly();

  private readonly language = toSignal(this.transloco.langChanges$, { initialValue: this.transloco.getActiveLang() });

  /** The locale `auto` renders in — the browser's when it speaks the UI language, else the UI language (D-7). */
  readonly locale = computed(() => resolveAutoLocale(this.language() || 'en', browserLanguages()));

  /** Everything the pure formatter needs, as one signal. */
  readonly options = computed<DateFormatOptions>(() => ({ ...this._preference(), locale: this.locale() }));

  setPreference(p: DatePreference): void {
    this._preference.set({ style: p.style, zone: p.zone });
    try { localStorage.setItem(DATE_FORMAT_STORAGE_KEY, JSON.stringify(this._preference())); } catch { /* not kept: still applied */ }
  }

  format(value: InstantValue, variant: InstantVariant = 'datetime'): string {
    return formatInstant(value, variant, this.options());
  }

  parts(value: InstantValue): { date: string; time: string; iso: string } | null {
    return instantParts(value, this.options());
  }

  calendarDate(value: Date): string {
    return formatCalendarDate(value, this.options());
  }

  relative(value: InstantValue, nowMs = Date.now()): string {
    return formatRelativeTime(value, nowMs, this.language() || 'en');
  }

  /** The original instant, UTC ISO 8601 — what the hover shows. */
  iso(value: InstantValue): string {
    return isoOf(value);
  }
}

function browserLanguages(): readonly string[] {
  try {
    const nav = globalThis.navigator;
    return nav?.languages?.length ? nav.languages : nav?.language ? [nav.language] : [];
  } catch { return []; }
}

/**
 * `{{ value | instant:'date' }}` — one instant as inline text, in the viewer's format.
 *
 * IMPURE on purpose. A pure pipe re-runs only when its argument changes, so a preference or language switch would
 * not reach a date whose value stayed the same — the exact defect this replaces. The cost is one cached-formatter
 * call per render, which is what the `Intl` cache in `date-format.ts` is for.
 */
@Pipe({ name: 'instant', standalone: true, pure: false })
export class InstantPipe implements PipeTransform {
  private readonly dates = inject(DateFormatService);
  transform(value: InstantValue, variant: InstantVariant = 'datetime'): string {
    return this.dates.format(value, variant);
  }
}
