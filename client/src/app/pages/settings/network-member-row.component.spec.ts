/**
 * NetworkMemberRowComponent — a member of a network as a row: what it says about the member's SYNC HEALTH (bundle-39, Q-220).
 *
 * ## What was wrong
 *
 * One badge, `Failing (N)`, answered two questions: the peer did not answer, and this instance's own database failed while it landed what the
 * peer sent. A lasting local fault therefore showed as a failing peer (and, once the engine stopped counting it against the peer, as a healthy
 * one with no badge at all, because the member's failure count no longer moves). The server now keeps a per-member streak of cycles in which
 * this instance's store failed (`consecutiveLocalFaults`, stored with the member, beside `consecutiveFailures`), the member view carries it, and the row
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

describe('NetworkMemberRowComponent: the local-store badge is readable without a pointer (Q-680)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  /** The badge for THIS instance's store: queried by its own class, because `.member-failing` is on both badges and the peer's comes first. */
  const localBadge = (f: { nativeElement: HTMLElement }) => f.nativeElement.querySelector<HTMLElement>('.member-local-failing');

  /** What the badge's `aria-describedby` points at, as assistive technology reads it. */
  const described = (f: { nativeElement: HTMLElement }, badge: HTMLElement): string =>
    (badge.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
      .map(id => f.nativeElement.querySelector(`#${CSS.escape(id)}`)?.textContent?.trim() ?? '').join(' ').trim();

  it('is the title of the local-store badge stated by the dictionary, not by a literal (the one form for a count of 1, the other for 4)', () => {
    for (const [count, form] of [[1, 'one'], [4, 'other']] as const) {
      const f = make(member({ consecutiveLocalFaults: count }));
      expect(localBadge(f)?.getAttribute('title'), `count ${count}`).toBe(EN[`networks.member.localFailingTitle.${form}`]!.replace('{{count}}', String(count)));
    }
  });

  it('the badge can take the keyboard focus: tabindex 0', () => {
    const badge = localBadge(make(member({ consecutiveLocalFaults: 4 })));
    expect(badge, 'the local-store badge is rendered').toBeTruthy();
    expect(badge!.getAttribute('tabindex')).toBe('0');
  });

  it('its accessible DESCRIPTION is the title sentence: aria-describedby names an element carrying the same words', () => {
    const f = make(member({ consecutiveLocalFaults: 4 }));
    const badge = localBadge(f)!;
    expect(badge.getAttribute('aria-describedby'), 'the badge is described by something').toBeTruthy();
    expect(described(f, badge)).toBe(EN['networks.member.localFailingTitle.other']!.replace('{{count}}', '4'));
  });

  it('en, de and pl: the description is the language\'s own sentence', () => {
    for (const lang of ['en', 'de', 'pl'] as const) {
      const d = dictOf(lang);
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ imports: [NetworkMemberRowComponent, getTranslocoModule({ translation: { en: d } })] });
      const f = TestBed.createComponent(NetworkMemberRowComponent);
      f.componentRef.setInput('member', member({ consecutiveLocalFaults: 1 }));
      f.detectChanges();
      const sentence = described(f, localBadge(f)!);
      expect(sentence, lang).toBe(d['networks.member.localFailingTitle.one']!.replace('{{count}}', '1'));
    }
  });

  it('a member whose peer failed, with no local fault, has no local badge to describe', () => {
    expect(localBadge(make(member({ consecutiveFailures: 3 })))).toBeNull();
  });

  it('two members on one page do not share a description id', () => {
    const a = make(member({ instanceId: 'peer-aaaa', consecutiveLocalFaults: 2 }));
    const ida = localBadge(a)!.getAttribute('aria-describedby');
    const b = make(member({ instanceId: 'peer-bbbb', consecutiveLocalFaults: 2 }));
    const idb = localBadge(b)!.getAttribute('aria-describedby');
    expect(ida).toBeTruthy();
    expect(idb).toBeTruthy();
    expect(ida, 'ids are per member, or two rows in one list would point at each other').not.toBe(idb);
  });
});
