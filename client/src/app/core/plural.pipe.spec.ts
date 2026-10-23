/**
 * The `plural` pipe: `{{ count | plural:'base':params }}` re-renders when the language switches, and memoises an unchanged pass (Q-574).
 *
 * Written before the module exists (`core/plural.pipe.ts`, class `PluralPipe`, pipe name `plural`, `transform(count, base, params?)`),
 * so each case is red at the base commit because its import cannot be resolved.
 *
 * Why the first case is the one that matters: the app is zoneless and its pages are OnPush. A PURE pipe is evaluated again only when its
 * inputs change, and a language switch changes none of them (the count, the base, the params), so a pure pipe keeps showing the old
 * language until something else re-renders the view - `RelativeTimeComponent` had that defect (Q-100) and `InstantPipe` is the fix this
 * one follows: impure, and reading the language signal inside `transform` so the view is marked dirty when it moves.
 *
 * The second is the cost of being impure: an impure pipe runs on every change-detection pass, so an unchanged pass must cost one
 * comparison and not a lookup, a plural-rule selection and a number format per pipe per pass.
 */
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PluralPipe } from './plural.pipe';
import { PluralText } from './plural-text.service';
import { LanguageLoads, settle, startInEnglish, switchTo } from '../testing/language-loads';

const EN = { 'k.one': '{{count}} thing', 'k.other': '{{count}} things', 'p.other': '{{count}} things, {{shown}} shown' };
const DE = { 'k.one': '{{count}} Ding', 'k.other': '{{count}} Dinge', 'p.other': '{{count}} Dinge, {{shown}} angezeigt' };
const PL = { 'k.one': '{{count}} rzecz', 'k.few': '{{count}} rzeczy', 'k.many': '{{count}} rzeczy-many', 'k.other': '{{count}} rzeczy-other', 'p.other': '{{count}} rzeczy, {{shown}} widocznych' };

@Component({
  selector: 'app-plural-host',
  imports: [PluralPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span id="a">{{ count() | plural:'k' }}</span><span id="b">{{ count() | plural:'p':{ shown: shown() } }}</span>`,
})
class HostComponent {
  readonly count = signal(1);
  readonly shown = signal(5);
}

async function mount(loads: LanguageLoads) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [HostComponent], providers: loads.providers() });
  const transloco = await startInEnglish();
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  const text = (id: string): string => (fixture.nativeElement as HTMLElement).querySelector(`#${id}`)?.textContent ?? '';
  return { fixture, transloco, text };
}

const loaded = (): LanguageLoads => new LanguageLoads().now('en', EN).now('de', DE).now('pl', PL);

describe('the plural pipe renders a counted sentence in the page\'s language', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('picks the form for the count', async () => {
    const { fixture, text } = await mount(loaded());
    expect(text('a')).toBe('1 thing');
    fixture.componentInstance.count.set(3);
    fixture.detectChanges();
    expect(text('a')).toBe('3 things');
  });

  it('re-renders after setActiveLang under OnPush, with no input changing', async () => {
    const { fixture, transloco, text } = await mount(loaded());
    expect(text('a')).toBe('1 thing');

    switchTo(transloco, 'de');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(text('a'), 'a pure pipe keeps the old language: none of its inputs changed').toBe('1 Ding');

    switchTo(transloco, 'pl');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(text('a')).toBe('1 rzecz');
  });

  it('keeps the old language while the new words are late, and switches when they arrive', async () => {
    const loads = new LanguageLoads().now('en', EN);
    const de = loads.late('de');
    const { fixture, transloco, text } = await mount(loads);

    switchTo(transloco, 'de');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(text('a'), 'the words are not here yet - the sentence must not blank').toBe('1 thing');

    de.resolve(DE);
    await settle();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(text('a')).toBe('1 Ding');
  });

  it('shows the count when the language\'s words never come', async () => {
    const loads = new LanguageLoads().now('en', EN).never('de');
    const { fixture, transloco, text } = await mount(loads);
    switchTo(transloco, 'de');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(text('a')).toMatch(/1/);
  });

  it('passes params through, formatted, and follows a change in them', async () => {
    const { fixture, text } = await mount(loaded());
    expect(text('b')).toBe('1 things, 5 shown');
    fixture.componentInstance.shown.set(1234);
    fixture.detectChanges();
    expect(text('b')).toBe('1 things, 1,234 shown');
  });
});

describe('the plural pipe memoises an unchanged pass', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('asks the service once for passes whose count, base, params and language are the same', async () => {
    const { fixture } = await mount(loaded());
    const spy = vi.spyOn(TestBed.inject(PluralText), 'text');

    for (let i = 0; i < 5; i++) fixture.detectChanges();
    expect(spy, 'five unchanged passes of two pipes').not.toHaveBeenCalled();

    fixture.componentInstance.count.set(2);
    fixture.detectChanges();
    expect(spy, 'one changed count: each of the two pipes asks once').toHaveBeenCalledTimes(2);

    for (let i = 0; i < 5; i++) fixture.detectChanges();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('asks again after a language switch even though no input changed', async () => {
    const { fixture, transloco } = await mount(loaded());
    const spy = vi.spyOn(TestBed.inject(PluralText), 'text');

    switchTo(transloco, 'de');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(spy).toHaveBeenCalled();
    const calls = spy.mock.calls.length;

    for (let i = 0; i < 3; i++) fixture.detectChanges();
    expect(spy.mock.calls.length, 'and not again while the language stays the same').toBe(calls);
  });
});
