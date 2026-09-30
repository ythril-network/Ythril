import { Component, computed, inject, signal } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { MfaComponent } from './mfa.component';
import { SettingsCardComponent } from '../../shared/settings-card.component';
import { DateFormatService } from '../../core/date-format.service';
import { browserTimeZone, DATE_STYLES, DATE_ZONES, formatInstant, type DateStyle, type DateZone } from '../../core/date-format';

@Component({
  selector: 'app-preferences',
  standalone: true,
  imports: [TranslocoPipe, MfaComponent, SettingsCardComponent],
  styles: [`
    .prefs-page { display: flex; flex-direction: column; gap: 16px; max-width: 720px; }
    .section-label { margin: 12px 0 0; font-size: 12px; font-weight: 700; letter-spacing: .06em;
      text-transform: uppercase; color: var(--text-muted); }

    .lang-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    .lang-btn {
      padding: 7px 18px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--bg-elevated);
      color: var(--text-secondary);
      font-size: 13px;
      font-weight: 500;
      font-family: var(--font);
      cursor: pointer;
      transition: color var(--transition), background var(--transition), border-color var(--transition);
    }
    .lang-btn:hover { color: var(--text-primary); background: var(--bg-primary); }
    .lang-btn.active {
      border-color: var(--accent);
      background: var(--nav-active-dim);
      color: var(--text-primary);
    }

    /* Date and time (Q-146). Two radio groups rather than selects: each option shows what it looks like, and a
       choice between three formats is easier to make by seeing them than by reading their names. */
    .date-groups { display: flex; flex-direction: column; gap: 14px; margin-top: 10px; }
    fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
    legend { padding: 0; margin: 0 0 6px; font-size: 12px; font-weight: 600; color: var(--text-secondary); }
    .opts { display: flex; flex-direction: column; gap: 6px; }
    .opt { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 13px; cursor: pointer; }
    .opt input { margin: 0; accent-color: var(--accent); }
    .example { font-variant-numeric: tabular-nums; color: var(--text-muted); font-size: 12px; }
    .hint { margin: 2px 0 0; font-size: 12px; color: var(--text-muted); }
  `],
  template: `
    <div class="prefs-page">
      <app-settings-card icon="globe" [heading]="'prefs.language.title' | transloco" [purpose]="'prefs.language.subtitle' | transloco">
        <div class="lang-grid">
          @for (lang of languages; track lang.code) {
            <button
              class="lang-btn"
              [class.active]="activeLang() === lang.code" [attr.aria-current]="activeLang() === lang.code ? 'true' : null"
              (click)="setLang(lang.code)">
              {{ lang.label }}
            </button>
          }
        </div>
      </app-settings-card>

      <app-settings-card icon="timer" [heading]="'prefs.dates.title' | transloco" [purpose]="'prefs.dates.subtitle' | transloco">
        <div class="date-groups">
          <fieldset class="date-style">
            <legend>{{ 'prefs.dates.format' | transloco }}</legend>
            <div class="opts">
              @for (s of styles; track s) {
                <label class="opt">
                  <input type="radio" name="date-style" [value]="s" [checked]="dates.preference().style === s" (change)="setStyle(s)" />
                  <span>{{ ('prefs.dates.style.' + s) | transloco: { locale: dates.locale() } }}</span>
                  <span class="example">{{ example(s) }}</span>
                </label>
              }
            </div>
          </fieldset>
          <fieldset class="date-zone">
            <legend>{{ 'prefs.dates.zone' | transloco }}</legend>
            <div class="opts">
              @for (z of zones; track z) {
                <label class="opt">
                  <input type="radio" name="date-zone" [value]="z" [checked]="dates.preference().zone === z" (change)="setZone(z)" />
                  <span>{{ ('prefs.dates.zone.' + z) | transloco: { zone: localZone } }}</span>
                </label>
              }
            </div>
          </fieldset>
          <p class="hint">{{ 'prefs.dates.hoverHint' | transloco }}</p>
        </div>
      </app-settings-card>

      <h2 class="section-label">{{ 'prefs.security.title' | transloco }}</h2>
      <app-mfa />
    </div>
  `,
})
export class PreferencesComponent {
  private transloco = inject(TranslocoService);
  protected readonly dates = inject(DateFormatService);

  activeLang = signal(this.transloco.getActiveLang());

  readonly languages = [
    { code: 'en', label: 'English' },
    { code: 'de', label: 'Deutsch' },
    { code: 'pl', label: 'Polski' },
  ];

  readonly styles = DATE_STYLES;
  readonly zones = DATE_ZONES;
  /** What "local" means on this machine, named — "Local" alone does not say which zone that is. */
  readonly localZone = browserTimeZone();
  /** The moment the examples render, fixed when the page opens so the options do not tick. */
  private readonly now = Date.now();

  /** The same moment in each format, in the zone currently chosen — so each option shows what picking it does. */
  readonly examples = computed(() => {
    const o = this.dates.options();
    return Object.fromEntries(DATE_STYLES.map(s => [s, formatInstant(this.now, 'datetimeSeconds', { ...o, style: s })])) as Record<DateStyle, string>;
  });

  example(s: DateStyle): string { return this.examples()[s]; }

  setLang(lang: string): void {
    this.transloco.setActiveLang(lang);
    this.activeLang.set(lang);
    localStorage.setItem('lang', lang);
  }

  setStyle(style: DateStyle): void { this.dates.setPreference({ ...this.dates.preference(), style }); }
  setZone(zone: DateZone): void { this.dates.setPreference({ ...this.dates.preference(), zone }); }
}
