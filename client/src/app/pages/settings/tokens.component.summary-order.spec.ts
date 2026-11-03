/**
 * The tokens page leads with the list, and the summary strip sits after it under its own heading (Q-124).
 *
 * The owner's ask (2026-09-28): "the panel 'active tokens' on top is eating space and has no relevant info - move to the far bottom." The strip of counts
 * (Active / Expiring / Expired) rendered above the list card. The order is the DOM order, not a CSS `order`: a screen reader and the tab key follow the DOM,
 * so a strip that only LOOKS last still reads first. And the strip no longer borrows the list card's title ("Tokens", twice on one page): it has a heading
 * of its own, `tokens.summary.title`, in en, de and pl.
 *
 * Red until the strip moves after the list card in the template and `tokens.summary.title` exists.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import { TokensComponent } from './tokens.component';
import { AuthApi } from '../../core/auth-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { dictionary } from '../../testing/i18n-dictionary';

function page(language: 'en' | 'de' | 'pl' = 'en') {
  TestBed.resetTestingModule();
  const tokens = [{ spaces: [], id: 't1', name: 'one' }];
  TestBed.configureTestingModule({
    imports: [TokensComponent, getTranslocoModule({ translation: { en: dictionary(language) } })],
    providers: [
      { provide: AuthApi, useValue: {
        getMe: () => of({ admin: true }), verifyToken: () => of({ id: 'self', name: 'self' }),
        listTokens: () => of({ tokens }), createToken: vi.fn().mockReturnValue(of({ token: 'tok_x' })),
      } },
      { provide: SpacesApi, useValue: { listSpaces: () => of({ spaces: [] }) } },
      { provide: ToastService, useValue: { show: () => {}, error: () => {}, success: () => {} } },
      { provide: ConfirmDialogService, useValue: { confirm: () => Promise.resolve(true) } },
    ],
  });
  const fixture = TestBed.createComponent(TokensComponent);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { el, strip: el.querySelector('app-summary-strip'), listCard: el.querySelector('.card') };
}

describe('the tokens page order (Q-124)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('the summary strip FOLLOWS the list card in the document (not by CSS order)', () => {
    const { strip, listCard, el } = page();
    expect(listCard, 'the list card').toBeTruthy();
    expect(strip, 'the strip is rendered when there are tokens').toBeTruthy();
    expect(listCard!.compareDocumentPosition(strip!) & Node.DOCUMENT_POSITION_FOLLOWING, 'the strip comes after the list card').toBeTruthy();
    // And no stylesheet reorders it: the template does the moving.
    expect(strip!.getAttribute('style') ?? '').not.toMatch(/\border\s*:/);
    expect(el.querySelector('app-own-token-rights')!.compareDocumentPosition(strip!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the strip is the last block of the page, so it reads last', () => {
    const { strip, el } = page();
    const blocks = [...el.querySelectorAll('app-summary-strip, .card')];
    expect(blocks[blocks.length - 1]).toBe(strip);
  });

  for (const language of ['en', 'de', 'pl'] as const) {
    it(`${language}: the strip has its own heading, from tokens.summary.title, which is not the list card's title`, () => {
      const dict = dictionary(language);
      expect(dict['tokens.summary.title'], `${language}.json has tokens.summary.title`).toBeTruthy();
      const { strip } = page(language);
      expect(strip!.querySelector('.summary-h')?.textContent?.trim()).toBe(dict['tokens.summary.title']);
      expect(dict['tokens.summary.title']).not.toBe(dict['tokens.list.title']);
    });
  }

  it('de and pl word the heading themselves', () => {
    const en = dictionary('en')['tokens.summary.title'];
    expect(en).toBeTruthy();
    for (const language of ['de', 'pl'] as const) expect(dictionary(language)['tokens.summary.title']).not.toBe(en);
  });
});
