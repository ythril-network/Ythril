import { isDevMode } from '@angular/core';
import type {
  TranslocoMissingHandler,
  TranslocoMissingHandlerData,
} from '@jsverse/transloco';

/**
 * Missing-key handler for i18n.
 *
 * In development every missing key is surfaced loudly (console.error, once per
 * key) so untranslated strings are caught during review instead of shipping as
 * raw dotted keys or silently falling back. In production the key is returned
 * quietly — the same graceful degradation Transloco does by default.
 *
 * Keyed off Angular's `isDevMode()` rather than Transloco's `prodMode` config so
 * it behaves correctly regardless of how that flag is set.
 */
export class DevMissingTranslationHandler implements TranslocoMissingHandler {
  /** Keys already reported this session — avoids console spam on re-render. */
  private readonly reported = new Set<string>();

  handle(key: string, _data: TranslocoMissingHandlerData): string {
    if (isDevMode() && !this.reported.has(key)) {
      this.reported.add(key);
      console.error(`[i18n] Missing translation key: "${key}"`);
    }
    return key;
  }
}

/** What has already been said through `warnOnceInDev`, by key, for the session. */
const saidOnce = new Set<string>();

/**
 * One development-only console line per `key` for the session, the same discipline as the missing-key handler above: a problem in a
 * counted sentence (a count that is not a number, a base with no form) is shown ONCE, not on every render of every row, and says nothing
 * in production. The key names the problem and its subject (`plural-count:<base>`), so two problems on one base are two lines.
 */
export function warnOnceInDev(key: string, message: string): void {
  if (!isDevMode() || saidOnce.has(key)) return;
  saidOnce.add(key);
  console.error(message);
}
