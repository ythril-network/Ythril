/**
 * The token table marks a peer's credential and an approved connector (bundle-231).
 *
 * A token with `peerInstanceId` is a peer's credential for syncing, not the operator's own tooling: its row carries a "Peer" badge whose title says what
 * it cannot do. A connector token with `approvedByTokenId` carries an "approved by <first eight characters of the approver's id>" badge, whose title is the
 * whole id (the id may no longer resolve to a token, so the table prints what it holds and never looks it up). A token with neither carries neither.
 *
 * Rendered through the table component itself, in each language, so the words are the ones an operator reads and a badge that lost its binding goes red.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { dictionary } from '../../testing/i18n-dictionary';
import type { TokenRecord } from '../../core/api.types';
import { TokenTableComponent } from './token-table.component';

const APPROVER = '0f3a9c2e-7b14-4d58-9a6e-5c1d2e3f4a5b';

const tok = (over: Partial<TokenRecord>): TokenRecord => ({
  id: 'id', name: 'token', createdAt: '2026-01-01T00:00:00.000Z', spaces: [], admin: false, ...over,
} as TokenRecord);

function render(language: 'en' | 'de' | 'pl', rows: TokenRecord[]) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [TokenTableComponent, getTranslocoModule({ translation: { en: dictionary(language) } })] });
  const fixture = TestBed.createComponent(TokenTableComponent);
  fixture.componentRef.setInput('rows', rows);
  fixture.componentRef.setInput('sortField', '');
  fixture.componentRef.setInput('sortDir', 'asc');
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const rowOf = (name: string) => [...el.querySelectorAll('tbody tr')].find(tr => (tr.textContent ?? '').includes(name)) as HTMLElement | undefined;
  return { dict: dictionary(language), rowOf };
}

describe('the token table badges a peer credential and an approved connector', () => {
  beforeEach(() => TestBed.resetTestingModule());

  for (const language of ['en', 'de', 'pl'] as const) {
    it(`${language}: a peer-bound token carries the Peer badge, titled with what such a token cannot do`, () => {
      const { dict, rowOf } = render(language, [tok({ id: 'p', name: 'peer-row', peerInstanceId: 'peer-1' }), tok({ id: 'o', name: 'plain-row' })]);
      const badge = [...(rowOf('peer-row')?.querySelectorAll('.badge') ?? [])].find(b => (b.textContent ?? '').trim() === dict['tokens.badge.peer']);
      expect(badge, 'the peer row has a badge reading the Peer word').toBeTruthy();
      expect(badge!.getAttribute('title')).toBe(dict['tokens.badge.peerTitle']);
      const plain = [...(rowOf('plain-row')?.querySelectorAll('.badge') ?? [])].map(b => (b.textContent ?? '').trim());
      expect(plain, 'a token with no peer binding has no Peer badge').not.toContain(dict['tokens.badge.peer']);
    });

    it(`${language}: an approved connector says who approved it by the first eight characters of the id, and its title is the whole id`, () => {
      const { dict, rowOf } = render(language, [tok({ id: 'c', name: 'connector-row', approvedByTokenId: APPROVER }), tok({ id: 'o', name: 'plain-row' })]);
      const want = dict['tokens.badge.approvedBy']!.replace('{{id}}', APPROVER.slice(0, 8));
      const badge = [...(rowOf('connector-row')?.querySelectorAll('.badge') ?? [])].find(b => (b.textContent ?? '').trim() === want);
      expect(badge, `the connector row has a badge reading "${want}"`).toBeTruthy();
      expect(badge!.getAttribute('title')).toBe(APPROVER);
      const plain = [...(rowOf('plain-row')?.querySelectorAll('.badge') ?? [])].map(b => (b.textContent ?? '').trim());
      expect(plain.some(t => t.includes(APPROVER.slice(0, 8))), 'a token nobody approved names no approver').toBe(false);
    });
  }
});
