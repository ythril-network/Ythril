/**
 * Transloco whose language files arrive, are late, fail or never come - under the test's control.
 *
 * The page's language is not "what `getActiveLang()` says": `app.config.ts` loads a language's words lazily (no `preloadLangs`), so for
 * a while after a switch the active language is `de` and the words are still `en`'s. A spec that wants to see what the page does in that
 * window cannot use `TranslocoTestingModule` (it preloads every language), and cannot use a real HTTP loader. This is the one place a
 * spec states, per language, what the loader does:
 *
 *   `now(lang, words)`   the words arrive when asked for
 *   `late(lang)`         the words arrive when the spec calls `.resolve(words)`; `.reject()` fails the load instead
 *   `failing(lang)`      the load errors at once (a 404 or a network error)
 *   `never(lang)`        the request hangs, as one with no timeout does
 *
 * The configuration mirrors `app.config.ts` (`availableLangs` en/de/pl, `defaultLang` and `fallbackLang` en, no preload), so what
 * transloco does after a failure here is what it does in the app.
 *
 * `switchTo` does what the transloco pipe does on a switch - it sets the language and asks for its words - because setting the
 * language alone loads nothing, and a module under test must not be the thing a spec relies on to start the load.
 */
import { TestBed } from '@angular/core/testing';
import { Observable, ReplaySubject, NEVER, of, throwError } from 'rxjs';
import { take } from 'rxjs/operators';
import {
  provideTransloco, TRANSLOCO_LOADER, TranslocoService,
  type Translation, type TranslocoLoader,
} from '@jsverse/transloco';

export type Words = Record<string, string>;

export interface LateLoad {
  resolve(words: Words): void;
  reject(error?: unknown): void;
}

export class LanguageLoads implements TranslocoLoader {
  private readonly loaders = new Map<string, () => Observable<Translation>>();
  /** How many times each language's words were asked for. */
  readonly requests = new Map<string, number>();

  getTranslation(lang: string): Observable<Translation> {
    this.requests.set(lang, (this.requests.get(lang) ?? 0) + 1);
    const load = this.loaders.get(lang);
    return load ? load() : throwError(() => new Error(`no words registered for ${lang}`));
  }

  now(lang: string, words: Words): this {
    this.loaders.set(lang, () => of(words));
    return this;
  }

  late(lang: string): LateLoad {
    const subject = new ReplaySubject<Translation>(1);
    this.loaders.set(lang, () => subject.pipe(take(1)));
    return {
      resolve: words => { subject.next(words); subject.complete(); },
      reject: error => subject.error(error ?? new Error(`${lang} failed to load`)),
    };
  }

  failing(lang: string): this {
    this.loaders.set(lang, () => throwError(() => new Error(`${lang} failed to load`)));
    return this;
  }

  never(lang: string): this {
    this.loaders.set(lang, () => NEVER);
    return this;
  }

  /** Provider list for `TestBed.configureTestingModule({ providers })`. */
  providers() {
    return [
      provideTransloco({
        config: { availableLangs: ['en', 'de', 'pl'], defaultLang: 'en', fallbackLang: 'en', reRenderOnLangChange: true, prodMode: true },
      }),
      { provide: TRANSLOCO_LOADER, useValue: this },
    ];
  }
}

/** Waits for the promise queue and one macrotask, so subscriptions that resolve through either have run. */
export const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** The English words load before the page starts, as the app's first render does; returns the transloco service. */
export async function startInEnglish(): Promise<TranslocoService> {
  const transloco = TestBed.inject(TranslocoService);
  await new Promise<void>((resolve, reject) => transloco.load('en').pipe(take(1)).subscribe({ complete: resolve, error: reject }));
  return transloco;
}

/** What the transloco pipe does on a switch: set the language, then ask for its words. A failed load is the pipe's to survive, not the caller's. */
export function switchTo(transloco: TranslocoService, lang: string): void {
  transloco.setActiveLang(lang);
  transloco.load(lang).pipe(take(1)).subscribe({ error: () => { /* the loader's failure is what the spec observes through the page */ } });
}
