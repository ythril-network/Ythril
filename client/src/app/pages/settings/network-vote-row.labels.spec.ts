/**
 * Every button of a vote row has an accessible name that holds the words printed on it, in every language the client ships (WCAG 2.5.3,
 * label in name; bundle-269 browser check, note 2).
 *
 * ## The defect it prevents
 *
 * The Polish veto button read "Weto" and was named "Zawetuj: ...". A person who steers by voice says what they see ("kliknij Weto") and the
 * control answers to a name that does not hold that word; a screen reader reads a different word than the sighted reader sees. English and
 * German held their label by luck of the wording, and nothing asked.
 *
 * ## What it holds
 *
 * The REAL dictionaries (en, de, pl) are loaded, the row is drawn once per language with the real translations, and every `button` it renders
 * is asked: its `aria-label`, lower-cased and with everything that is not a letter or digit dropped (the check marks and crosses drawn before
 * a label), holds its visible text the same way. It walks every button of the row and every language, so a button or a locale added later is
 * asked as well, and a fourth mismatch goes red without anyone editing this file.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, afterEach } from 'vitest';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { dictionary, LOCALES } from '../../testing/i18n-dictionary';
import type { VoteRound } from '../../core/api.types';
import { NetworkVoteRowComponent } from './network-vote-row.component';

const ROUND: VoteRound = {
  id: 'r1', networkId: 'n1', type: 'space_addition', subject: 'notes (member-b)',
  openedAt: '2026-10-08T10:00:00.000Z', deadline: '2026-10-09T10:00:00.000Z', status: 'open', votes: [],
};

/** Letters and digits of any script, lower-cased: what a person says when they name a control. */
const spoken = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function buttonsIn(locale: string): { label: string; name: string }[] {
  TestBed.resetTestingModule();
  const translation = Object.fromEntries(LOCALES.map(l => [l, dictionary(l)]));
  TestBed.configureTestingModule({
    imports: [NetworkVoteRowComponent, getTranslocoModule({
      langs: translation,
      translocoConfig: { availableLangs: [...LOCALES], defaultLang: locale },
    })],
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });
  const fixture = TestBed.createComponent(NetworkVoteRowComponent);
  fixture.componentRef.setInput('round', ROUND);
  fixture.detectChanges();
  const buttons = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'));
  return buttons.map(b => ({ label: (b.textContent ?? '').trim(), name: b.getAttribute('aria-label') ?? '' }));
}

describe('a vote row\'s buttons are named by the words printed on them', () => {
  afterEach(() => TestBed.resetTestingModule());

  for (const locale of LOCALES) {
    it(`${locale}: every button's accessible name holds its visible label`, () => {
      const buttons = buttonsIn(locale);
      // Yes and Veto at least: a row that drew no button would otherwise pass over nothing.
      expect(buttons.length).toBeGreaterThanOrEqual(2);
      for (const { label, name } of buttons) {
        expect(spoken(label), `a button of the ${locale} row has no visible words`).not.toBe('');
        expect(spoken(name), `${locale}: the button "${label}" is named "${name}", which does not hold "${label}"`).toContain(spoken(label));
      }
    });
  }
});
