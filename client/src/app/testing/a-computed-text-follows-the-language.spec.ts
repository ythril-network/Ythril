/**
 * A `computed()` never reads the active language through `getActiveLang()` (bundle-162's pre-ship sweep).
 *
 * `getActiveLang()` is a plain read, not a signal, so a `computed()` that calls it does not re-run when the viewer switches
 * language: its sentence stays in the old language until some other signal it reads changes. The stored-data check's "Checked N
 * of M records" did, found by review, and this gate found the same in three more components; each rendered correctly in every
 * spec, because a spec sets the language once. Read the language as a signal (`toSignal(transloco.langChanges$, ...)`) inside a `computed()`, or render the
 * sentence from a method, which change detection re-runs.
 *
 * The files are every tracked client source (`git ls-files`), so a component written next year is inside the net.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLIENT_ROOT, trackedAppSources } from './tracked-sources';
import { stripComments } from './strip-comments';
import { callArguments } from './call-arguments';

describe('a computed() text follows the language', () => {
  const computedBodies: { where: string; body: string; name?: string }[] = [];
  for (const file of trackedAppSources()) {
    const src = stripComments(readFileSync(resolve(CLIENT_ROOT, file), 'utf8'));
    for (const m of src.matchAll(/\bcomputed(?:<[^>()]*>)?\(/g)) {
      const open = m.index! + m[0].length - 1;
      // The member the computed is assigned to (`summaryItems = computed(`, `lines = computed<T>(`): the identity a baseline entry keys on, which survives a line moving.
      const member = /(\w+)\s*(?::[^=;]*)?=\s*$/.exec(src.slice(Math.max(0, m.index! - 120), m.index!))?.[1];
      computedBodies.push({ where: `${file}:${src.slice(0, m.index!).split('\n').length}`, body: callArguments(src, open)[0] ?? '', name: member && `${file}#${member}` });
    }
  }

  it('finds the computed() calls (a floor, so a changed call shape cannot pass by finding none)', () => {
    expect(computedBodies.length).toBeGreaterThanOrEqual(100);
  });

  it('no computed() calls getActiveLang(), which is not a signal and so never re-runs it on a language switch', () => {
    const stale = computedBodies.filter(c => /\bgetActiveLang\s*\(/.test(c.body)).map(c => c.where);
    expect(stale, `computed() texts that keep the old language after a switch:\n  ${stale.join('\n  ')}`).toEqual([]);
  });

  /**
   * A `computed()` that calls `translate(` reads a signal that moves when the words arrive (Q-185).
   *
   * `transloco.translate()` is a plain method, no dependency of the `computed()` around it. A computed that translates evaluates once during the
   * first render, BEFORE the language file has resolved, gets the raw key back and keeps it: the Overview's Indexing card said
   * `brain.overview.retentionNone` where "No expiry" belongs until something else it read changed, and a later switch to German left the English
   * sentence in place. Both `retentionSummary` and `retentionTypes` handed the component's `transloco.translate` to a pure function, and every
   * spec rendered them fine: a spec loads its dictionary before the first render.
   *
   * The rule: the body of a `computed()` that spells `translate` (called, or handed on as a callback) also reads one of the signals that move with
   * the words: `ActiveLanguage`'s `revision()`, `wordsReady()` or `language()`, or a `toSignal(langChanges$)`. A computed whose translating lives in
   * another module's factory (the ones `overview-retention.ts` gets, which inject `ActiveLanguage` themselves) never spells `translate` and is not asked.
   */
  const READS_THE_WORDS = /\b(?:revision|wordsReady|language|lang|activeLang|currentLang)\s*\(\s*\)|\btoSignal\s*\(\s*[\w.]*langChanges\$/;
  const TRANSLATES = /\btranslate\b/;

  /**
   * There is no baseline: the computeds this gate found on its first run (nine summary strips, banners and tooltips besides the Overview's two)
   * were fixed in the same bundle, through `pageTranslator()` in `core/page-translator.ts`, which reads `ActiveLanguage.revision()` itself. A new
   * computed that translates without reading the words fails here, and the way out is that factory, not a list.
   */

  /** The computeds whose body translates and does not read the words signal. */
  const unwatched = (list: { where: string; body: string; name?: string }[]): { where: string; name?: string }[] =>
    list.filter(c => TRANSLATES.test(c.body) && !READS_THE_WORDS.test(c.body)).map(c => ({ where: c.where, name: c.name }));

  it('finds computeds that translate (a floor: a changed call shape cannot pass by finding none)', () => {
    // Most computeds now translate through `pageTranslator()` and never spell `translate`; the ones that still do are a floor of one, and the planted
    // shapes below hold the detector's other side.
    expect(computedBodies.filter(c => TRANSLATES.test(c.body)).length).toBeGreaterThanOrEqual(1);
  });

  it('reads a planted computed that translates without the words as stale, and one that reads them as fine', () => {
    const bad = { where: 'x:1', body: `() => this.transloco.translate('a.b')` };
    const handedOn = { where: 'x:2', body: `() => summarise(this.space(), (k, p) => this.transloco.translate(k, p))` };
    const good = { where: 'x:3', body: `() => { this.activeLanguage.revision(); return this.transloco.translate('a.b'); }` };
    const ready = { where: 'x:4', body: `() => this.language.wordsReady() ? this.transloco.translate('a.b') : ''` };
    const none = { where: 'x:5', body: `() => this.count() + 1` };
    expect(unwatched([bad, handedOn, good, ready, none]).map(u => u.where)).toEqual(['x:1', 'x:2']);
  });

  it('no computed() translates without reading revision(), wordsReady() or language(): it would keep the raw key of words not yet loaded', () => {
    const stale = unwatched(computedBodies).map(u => `${u.where}  ${u.name ?? '(unnamed)'}`);
    expect(stale, `computed() texts that translate with no dependency on the words arriving:\n  ${stale.join('\n  ')}`).toEqual([]);
  });
});
