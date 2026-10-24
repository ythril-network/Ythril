/**
 * Which language is the page in, and are its words here (Q-574).
 *
 * `transloco.getActiveLang()` and `langChanges$` answer which language was REQUESTED. The words of a language load lazily, so for a
 * moment after a switch the request says `de` while every sentence is still `en`'s - and a counted sentence, a date or a computed read
 * from the request in that window finds no German words and renders nothing, not even its number. Eight places asked the question and
 * six of them wrapped `langChanges$` in a private `toSignal` of their own; every one of them flipped at the request, before the words.
 *
 * This is the one reader. `language` flips to the requested language only once that language's words are loaded, and until then keeps the
 * language the page was showing. When a load FAILS, transloco itself switches to the language it falls back to, and this follows it: after
 * a failed load the page shows the fallback language, and so does the preferences page that reads the same signal. `revision` moves on
 * every flip and on every load success or failure, so anything computed from the language, or from "the words have arrived", runs again.
 *
 * ## "Loaded" is two checks, and both are needed
 *
 * `events$` does NOT replay, so a component mounted after a language file already loaded would never see the event and - if the event were
 * the only check - would wait for one that already happened, and render an empty strip for ever, which is worse than the bug being fixed.
 * `getTranslation().has(lang)` is synchronous and covers that case; the event covers the first load and is what makes the signal move.
 * The question is whether the language has been LOADED, not whether it has content: an empty-but-loaded dictionary is a legitimate state
 * (the spec harness uses exactly that, and so would a minimal locale), and treating it as "not ready" would blank the page.
 *
 * It never throws: a transloco that cannot answer leaves the language as it was.
 */
import { DestroyRef, Injectable, computed, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslocoService } from '@jsverse/transloco';

@Injectable({ providedIn: 'root' })
export class ActiveLanguage {
  private readonly transloco = inject(TranslocoService);

  private readonly _language = signal<string>(this.requested());
  private readonly _revision = signal(0);

  /** The language the page is shown in: the requested one once its words are loaded, else the one it had. */
  readonly language = this._language.asReadonly();

  /** A counter that moves on every flip and every load success or failure: read it to recompute when words arrive. */
  readonly revision = this._revision.asReadonly();

  /**
   * Are the page's words available to `translate()` right now? False only before the FIRST language file has loaded, when `language` is the
   * requested language and nothing has arrived for it. A `computed()` that translates imperatively evaluates once during the first render,
   * BEFORE the file has resolved, gets the raw key back (Transloco logs "Missing translation key") and bakes it into the label for good, because
   * `translate()` is a plain method and no dependency of the computed: reading this inside it makes "the words arrived" a real dependency.
   */
  readonly wordsReady = computed<boolean>(() => {
    this.revision(); // a dependency, not a value
    return this.loaded(this.language());
  });

  constructor() {
    const destroyed = inject(DestroyRef);
    this.transloco.langChanges$.pipe(takeUntilDestroyed(destroyed)).subscribe(lang => this.follow(lang));
    this.transloco.events$.pipe(takeUntilDestroyed(destroyed)).subscribe(event => {
      if (event.type === 'translationLoadSuccess' || event.type === 'translationLoadFailure') this.follow(this.requested());
    });
  }

  /** The language transloco says is active, or '' when it cannot say. */
  private requested(): string {
    try { return this.transloco.getActiveLang() || ''; } catch { return ''; }
  }

  private loaded(lang: string): boolean {
    try { return this.transloco.getTranslation().has(lang); } catch { return false; }
  }

  /** Adopt `lang` when its words are here; either way something may have changed, so the revision moves. */
  private follow(lang: string): void {
    // `untracked`: a load event can arrive synchronously from inside a render (the transloco pipe asks for a language's words while a view
    // is being drawn, and a loader that answers at once emits the event on the spot). Writing a signal from inside a template or a
    // `computed` is refused (NG0600); this write is the consequence of the event, not of what the view reads, so it leaves that context.
    untracked(() => {
      if (lang && this.loaded(lang)) this._language.set(lang);
      this._revision.update(n => n + 1);
    });
  }
}
