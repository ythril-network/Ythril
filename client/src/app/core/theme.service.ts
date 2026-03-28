import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DOCUMENT } from '@angular/common';

/**
 * ThemeService — handles external theming for Ythril.
 *
 * Two mechanisms are supported (both opt-in):
 *
 * 1. **Static cssUrl** — fetched from `/api/theme` on startup.
 *    When set, a `<link>` element is injected after Ythril's own styles,
 *    so the external stylesheet can override any CSS custom property.
 *
 * 2. **Runtime postMessage** — the host page (portal / iframe parent) can
 *    send `{ type: 'ythril:theme', tokens: { '--color-primary': '#f00', … } }`
 *    and Ythril applies the tokens immediately via `setProperty()`.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private http = inject(HttpClient);
  private doc = inject(DOCUMENT);

  /** Call once at app startup (via APP_INITIALIZER). */
  init(): Promise<void> {
    return new Promise<void>((resolve) => {
      // 1. Load static CSS override from server config
      this.http.get<{ cssUrl: string | null }>('/api/theme').subscribe({
        next: ({ cssUrl }) => {
          if (cssUrl) {
            this.injectExternalStylesheet(cssUrl);
          }
          resolve();
        },
        error: () => resolve(), // non-fatal — theme is optional
      });

      // 2. Listen for runtime postMessage theme tokens
      this.doc.defaultView?.addEventListener('message', (event: MessageEvent) => {
        this.handleThemeMessage(event);
      });
    });
  }

  private injectExternalStylesheet(cssUrl: string): void {
    const existing = this.doc.getElementById('ythril-theme-override');
    if (existing) {
      (existing as HTMLLinkElement).href = cssUrl;
      return;
    }
    const link = this.doc.createElement('link');
    link.id = 'ythril-theme-override';
    link.rel = 'stylesheet';
    link.href = cssUrl;
    this.doc.head.appendChild(link);
  }

  private handleThemeMessage(event: MessageEvent): void {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data['type'] !== 'ythril:theme') return;
    const tokens = data['tokens'];
    if (!tokens || typeof tokens !== 'object') return;

    // Security note: only CSS custom properties (prefixed `--`) are accepted.
    // Standard CSS properties are intentionally ignored to prevent attackers
    // from hiding UI elements via `display:none` etc.
    // CSS custom property values set via setProperty() are inert strings;
    // the browser will not execute scripts through them.
    const root = this.doc.documentElement;
    for (const [prop, value] of Object.entries(tokens)) {
      // Accept only CSS custom properties (must start with `--`)
      if (typeof prop === 'string' && prop.startsWith('--') && typeof value === 'string') {
        root.style.setProperty(prop, value);
      }
    }
  }
}
