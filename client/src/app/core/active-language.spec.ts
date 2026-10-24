/**
 * ActiveLanguage answers "which language is the page in, and are its words here" (Q-574).
 *
 * Written before the module exists (`core/active-language.ts`, class `ActiveLanguage`: `language` and `revision` are signals), so every
 * case here is red at the base commit for the one reason that its import cannot be resolved. They pin what the module is for, each case a
 * way the page's language can disagree with its words:
 *
 *  - a switch to a language whose words are already loaded flips at once;
 *  - a switch whose words are late keeps the PREVIOUS language until they arrive - `getActiveLang()` and `langChanges$` say `de` the
 *    moment `setActiveLang('de')` is called, and a counted sentence read from them in that window finds no German words and renders
 *    nothing;
 *  - a load that fails with a working fallback ends on the fallback (transloco itself switches to `en`), and the revision moves so
 *    anything computed from the language runs again;
 *  - a load that never resolves, or fails with no fallback left, leaves the page on the language it had.
 *
 * What it must not do is throw: every case ends in a language, never an error.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { ActiveLanguage } from './active-language';
import { LanguageLoads, settle, startInEnglish, switchTo } from '../testing/language-loads';

const EN = { 'k.other': '{{count}} things' };
const DE = { 'k.other': '{{count}} Dinge' };

function setup(loads: LanguageLoads) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: loads.providers() });
}

describe('ActiveLanguage', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('starts on the language the words are loaded for', async () => {
    setup(new LanguageLoads().now('en', EN));
    await startInEnglish();
    const active = TestBed.inject(ActiveLanguage);
    expect(active.language()).toBe('en');
  });

  it('a switch to a language whose words are already loaded flips at once and bumps the revision', async () => {
    setup(new LanguageLoads().now('en', EN).now('de', DE));
    const transloco = await startInEnglish();
    await new Promise<void>(resolve => transloco.load('de').subscribe({ complete: resolve }));
    const active = TestBed.inject(ActiveLanguage);
    const before = active.revision();

    transloco.setActiveLang('de');
    await settle();

    expect(active.language()).toBe('de');
    expect(active.revision()).toBeGreaterThan(before);
  });

  it('a delayed load keeps the old language until the words arrive, then flips and bumps the revision', async () => {
    const loads = new LanguageLoads().now('en', EN);
    const de = loads.late('de');
    setup(loads);
    const transloco = await startInEnglish();
    const active = TestBed.inject(ActiveLanguage);

    switchTo(transloco, 'de');
    await settle();
    expect(transloco.getActiveLang(), 'transloco itself already says de - that is the window this module closes').toBe('de');
    expect(active.language(), 'the words are not here, so the page is still in en').toBe('en');
    const waiting = active.revision();

    de.resolve(DE);
    await settle();
    expect(active.language()).toBe('de');
    expect(active.revision()).toBeGreaterThan(waiting);
  });

  it('a failed load with a working fallback ends on en and bumps the revision', async () => {
    const loads = new LanguageLoads().now('en', EN).failing('de');
    setup(loads);
    const transloco = await startInEnglish();
    const active = TestBed.inject(ActiveLanguage);
    const before = active.revision();

    switchTo(transloco, 'de');
    await settle();

    expect(transloco.getActiveLang(), 'transloco falls back to en after the failure').toBe('en');
    expect(active.language()).toBe('en');
    expect(active.revision(), 'a failure is a change anything computed from the language must see').toBeGreaterThan(before);
  });

  it('switchingTo names the language a switch waits for, and is null once it lands', async () => {
    const loads = new LanguageLoads().now('en', EN);
    const de = loads.late('de');
    setup(loads);
    const transloco = await startInEnglish();
    const active = TestBed.inject(ActiveLanguage);
    expect(active.switchingTo(), 'no switch asked for').toBeNull();

    switchTo(transloco, 'de');
    await settle();
    expect(active.switchingTo(), 'de was asked for and its words are not here').toBe('de');

    de.resolve(DE);
    await settle();
    expect(active.switchingTo(), 'the page is in de now').toBeNull();
  });

  it('switchingTo is null after a failed load falls back, so a control never waits on a switch that ended', async () => {
    setup(new LanguageLoads().now('en', EN).failing('de'));
    const transloco = await startInEnglish();
    const active = TestBed.inject(ActiveLanguage);

    switchTo(transloco, 'de');
    await settle();

    expect(active.language()).toBe('en');
    expect(active.switchingTo()).toBeNull();
  });

  it('a load that never resolves keeps the previous language and does not throw', async () => {
    setup(new LanguageLoads().now('en', EN).never('de'));
    const transloco = await startInEnglish();
    const active = TestBed.inject(ActiveLanguage);

    switchTo(transloco, 'de');
    await settle();
    await settle();

    expect(active.language()).toBe('en');
  });

  it('a late load that then fails, with the fallback already loaded, ends on en rather than staying on a language with no words', async () => {
    const loads = new LanguageLoads().now('en', EN);
    const de = loads.late('de');
    setup(loads);
    const transloco = await startInEnglish();
    const active = TestBed.inject(ActiveLanguage);

    switchTo(transloco, 'de');
    await settle();
    expect(active.language()).toBe('en');

    de.reject();
    await settle();
    expect(active.language()).toBe('en');
    expect(transloco.getActiveLang()).toBe('en');
  });
});
