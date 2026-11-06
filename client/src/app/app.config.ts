import { ApplicationConfig, provideZonelessChangeDetection, APP_INITIALIZER, inject } from '@angular/core';
import { provideRouter, withComponentInputBinding, withNavigationErrorHandler, withRouterConfig, TitleStrategy } from '@angular/router';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideTransloco, provideTranslocoMissingHandler, Translation, TranslocoLoader, TranslocoService } from '@jsverse/transloco';
import { DevMissingTranslationHandler } from './core/dev-missing-translation.handler';
import { Injectable } from '@angular/core';
import { routes } from './app.routes';
import { authInterceptor } from './core/auth.interceptor';
import { mfaInterceptor } from './core/mfa.interceptor';
import { ThemeService } from './core/theme.service';
import { TranslocoTitleStrategy } from './core/title-strategy';
import { staleBuildNavigationErrorHandler, installStaleBuildGlobalHandler, markBuildLoaded } from './core/stale-build-recovery';

@Injectable({ providedIn: 'root' })
export class TranslocoHttpLoader implements TranslocoLoader {
  private http = inject(HttpClient);
  getTranslation(lang: string) {
    return this.http.get<Translation>(`/assets/i18n/${lang}.json`);
  }
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    // `canceledNavigationResolution: 'computed'`: when the unsaved-edits guard refuses a Back or Forward (core/unsaved-edits.ts), the
    // router returns the browser to the history entry it was on. With the default ('replace') the refused step is rewritten in place,
    // so the page stays but one entry of the user's history is gone.
    provideRouter(routes, withComponentInputBinding(), withNavigationErrorHandler(staleBuildNavigationErrorHandler),
      withRouterConfig({ canceledNavigationResolution: 'computed' })),
    { provide: TitleStrategy, useClass: TranslocoTitleStrategy },
    provideHttpClient(withInterceptors([authInterceptor, mfaInterceptor])),
    provideAnimationsAsync(),
    {
      // Recover from "the app was updated while this tab was open": the stale bundle asks for lazy
      // chunks that no longer exist, and without this the navigation dies silently — no message, no
      // network entry, just a dead click. Registered first so it is listening as early as possible.
      provide: APP_INITIALIZER,
      useFactory: () => () => { installStaleBuildGlobalHandler(); markBuildLoaded(); },
      multi: true,
    },
    {
      provide: APP_INITIALIZER,
      useFactory: (theme: ThemeService) => () => theme.init(),
      deps: [ThemeService],
      multi: true,
    },
    {
      provide: APP_INITIALIZER,
      useFactory: (transloco: TranslocoService) => () => {
        const saved = localStorage.getItem('lang');
        if (saved && ['en', 'de', 'pl'].includes(saved)) {
          transloco.setActiveLang(saved);
        }
        // Keep <html lang> in sync so screen-reader pronunciation and browser
        // hyphenation match the active UI language — on startup and on every
        // switch (langChanges$ fires whenever setActiveLang is called).
        document.documentElement.lang = transloco.getActiveLang();
        transloco.langChanges$.subscribe(lang => {
          document.documentElement.lang = lang;
        });
      },
      deps: [TranslocoService],
      multi: true,
    },
    provideTransloco({
      config: {
        availableLangs: ['en', 'de', 'pl'],
        defaultLang: 'en',
        fallbackLang: 'en',
        reRenderOnLangChange: true,
        prodMode: false,
      },
      loader: TranslocoHttpLoader,
    }),
    provideTranslocoMissingHandler(DevMissingTranslationHandler),
  ],
};
