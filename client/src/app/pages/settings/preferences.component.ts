import { Component, inject, signal } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { MfaComponent } from './mfa.component';

@Component({
  selector: 'app-preferences',
  standalone: true,
  imports: [TranslocoPipe, MfaComponent],
  styles: [`
    .pref-section { margin-bottom: 32px; }

    .lang-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 12px;
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
  `],
  template: `
    <div class="pref-section">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">{{ 'prefs.language.title' | transloco }}</div>
            <div class="card-subtitle">{{ 'prefs.language.subtitle' | transloco }}</div>
          </div>
        </div>
        <div class="lang-grid">
          @for (lang of languages; track lang.code) {
            <button
              class="lang-btn"
              [class.active]="activeLang() === lang.code"
              (click)="setLang(lang.code)">
              {{ lang.label }}
            </button>
          }
        </div>
      </div>
    </div>

    <div class="pref-section">
      <app-mfa />
    </div>
  `,
})
export class PreferencesComponent {
  private transloco = inject(TranslocoService);

  activeLang = signal(this.transloco.getActiveLang());

  readonly languages = [
    { code: 'en', label: 'English' },
    { code: 'de', label: 'Deutsch' },
    { code: 'pl', label: 'Polski' },
  ];

  setLang(lang: string): void {
    this.transloco.setActiveLang(lang);
    this.activeLang.set(lang);
    localStorage.setItem('lang', lang);
  }
}
