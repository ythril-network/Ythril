/**
 * NetworkMemberRowComponent — a member of a network as a row: what it says about the member's SYNC HEALTH (bundle-39, Q-220).
 *
 * ## What was wrong
 *
 * One badge, `Failing (N)`, answered two questions: the peer did not answer, and this instance's own database failed while it landed what the
 * peer sent. A lasting local fault therefore showed as a failing peer (and, once the engine stopped counting it against the peer, as a healthy
 * one with no badge at all, because the member's failure count no longer moves). The server now keeps a per-member streak of cycles in which
 * this instance's store failed (`consecutiveLocalFaults`, runtime only, beside `consecutiveFailures`), the member view carries it, and the row
 * says so apart from the peer: `Local store failing (N)`.
 *
 * ## The rules, each as the reader sees it (the real English words)
 *
 * - a member with a local-fault streak shows `Local store failing (N)`; one without shows no such badge;
 * - the peer badge (`Failing (N)`) is about the peer alone: a member whose peer failed shows it and no local-store badge, a member whose
 *   store failed shows the local-store badge and not the peer one;
 * - the failing badge's title states the rule the server counts by now: consecutive cycles in which the PEER DID NOT ANSWER.
 *
 * Red at a0efade0a: no key, no field and no badge exist for a local-store streak, and the failing title still says "failed sync attempts".
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { NetworkMemberRowComponent } from './network-member-row.component';

const dictOf = (lang: string) => JSON.parse(readFileSync(`public/assets/i18n/${lang}.json`, 'utf8')) as Record<string, string>;
const EN = dictOf('en');

/** A member as `GET /api/networks/:id` shows it to an administrator, with the optional health fields a case names. */
const member = (health: Record<string, unknown> = {}) => ({
  instanceId: 'peer-aaaa-bbbb', label: 'Peer', url: 'http://192.0.2.7:3200', direction: 'both', ...health,
});

function make(m: Record<string, unknown>) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [NetworkMemberRowComponent, getTranslocoModule({ translation: { en: EN } })] });
  const fixture = TestBed.createComponent(NetworkMemberRowComponent);
  fixture.componentRef.setInput('member', m);
  fixture.detectChanges();
  return fixture;
}
const text = (f: { nativeElement: HTMLElement }) => (f.nativeElement.textContent ?? '').replace(/\s+/g, ' ');
const failingBadge = (f: { nativeElement: HTMLElement }) => f.nativeElement.querySelector<HTMLElement>('.member-failing');

describe('NetworkMemberRowComponent: sync health (bundle-39)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('a member whose peer is healthy and whose store is fine shows neither badge', () => {
    const f = make(member({ consecutiveFailures: 0 }));
    expect(text(f)).not.toContain('Local store failing');
    expect(text(f)).not.toMatch(/Failing \(/);
    expect(failingBadge(f)).toBeNull();
  });

  it("a local-fault streak shows 'Local store failing (N)'", () => {
    const f = make(member({ consecutiveFailures: 0, consecutiveLocalFaults: 4 }));
    expect(text(f), `the row says: ${text(f)}`).toContain('Local store failing (4)');
  });

  it("the badge is about THIS instance's store: it is not the peer's failing badge", () => {
    const f = make(member({ consecutiveLocalFaults: 4 }));
    expect(text(f), `the row says: ${text(f)}`).toContain('Local store failing (4)');
    expect(text(f)).not.toMatch(/\bFailing \(/);
  });

  it("a failing peer shows the peer badge and no local-store badge", () => {
    const f = make(member({ consecutiveFailures: 3 }));
    expect(text(f)).toMatch(/Failing \(3\)/);
    expect(text(f)).not.toContain('Local store failing');
  });

  it('a member with both streaks shows both, each with its own count', () => {
    const f = make(member({ consecutiveFailures: 2, consecutiveLocalFaults: 5 }));
    expect(text(f)).toMatch(/Failing \(2\)/);
    expect(text(f), `the row says: ${text(f)}`).toContain('Local store failing (5)');
  });

  it('the failing badge title states what the server counts: cycles in which the peer did not answer', () => {
    const f = make(member({ consecutiveFailures: 3 }));
    const title = failingBadge(f)?.getAttribute('title') ?? '';
    expect(title, `the title says: ${title}`).toContain('did not answer');
    expect(title).not.toContain('failed sync attempt');
  });

  it('en, de and pl each reword the failing title (it no longer calls the count "failed sync attempts")', () => {
    for (const [lang, stale] of [['en', 'failed sync attempt'], ['de', 'fehlgeschlagener Sync-Versuch'], ['pl', 'nieudan']] as const) {
      const d = dictOf(lang);
      const forms = ['one', 'few', 'many', 'other'].map(k => d[`networks.member.failingTitle.${k}`] ?? '');
      expect(forms.every(v => v.length > 0), `${lang}.json lost a networks.member.failingTitle form`).toBe(true);
      expect(forms.some(v => v.toLowerCase().includes(stale.toLowerCase())),
        `${lang}.json still words the peer failure count as "${stale}": ${forms[3]}`).toBe(false);
    }
  });
});
