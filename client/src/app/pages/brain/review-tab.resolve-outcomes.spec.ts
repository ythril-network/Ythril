/**
 * What a reviewer is told after a contradiction resolve — `Q-442`.
 *
 * ## The defect it prevents
 *
 * The resolve answer carries `notes`, one per outcome a reviewer must not be left to assume (the `supersedes` link refused by the
 * space's rules, a record of the pair that is gone). The card used to toast the server's English sentence (`note`) whatever the
 * reviewer's language, and every failure of a resolve said `duplicates.dismissError` — "Could not dismiss this candidate." — for a
 * request that was not a dismiss, whichever reason the server gave.
 *
 * ## What is held
 *
 *  - each note code is rendered from a translation KEY, the same key in en, de and pl, with the note's placeholders filled in —
 *    never the server's detail sentence, never a raw `{{placeholder}}`; two codes are two keys;
 *  - the outcomes of one resolve are ONE toast listing them all, not one toast each;
 *  - a failed resolve is said through a resolve-specific key picked by the answer's `code`, not the dismiss key.
 *
 * Keys are found by the TEXT they render rather than named here: which key a code uses is the component's choice, and a
 * spec that named it would pass for a component that rendered the right key in English only.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { of, throwError, type Observable } from 'rxjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpErrorResponse } from '@angular/common/http';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { CLIENT_ROOT } from '../../testing/tracked-sources';
import { ReviewTabComponent } from './review-tab.component';
import { DuplicatesApi } from '../../core/duplicates-api.service';
import { ContradictionsApi } from '../../core/contradictions-api.service';
import { ForksApi } from '../../core/forks-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { BrainApi } from '../../core/brain-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';

const LANGS = ['en', 'de', 'pl'] as const;
type Lang = typeof LANGS[number];
const DICT: Record<Lang, Record<string, string>> = Object.fromEntries(LANGS.map(l =>
  [l, JSON.parse(readFileSync(resolve(CLIENT_ROOT, `public/assets/i18n/${l}.json`), 'utf8'))])) as Record<Lang, Record<string, string>>;

/** The server's detail sentence: a toast that shows it is showing the server's English, not a key. */
const DETAIL = 'SERVER-DETAIL-SENTENCE-NOT-FOR-THE-TOAST';

/**
 * The notes a resolve can carry, with distinctive placeholder values. A refused link's note names the label and the rule it broke
 * (`{{label}}`, `{{rule}}`); a gone record's names nothing.
 */
type Note = Record<string, string> & { code: string; detail: string };
const NOTES: Note[] = [
  { code: 'linkRefused', detail: DETAIL, label: 'supersedes-label-x', rule: 'functional-rule-x' },
  { code: 'winnerGone', detail: DETAIL },
  { code: 'loserGone', detail: DETAIL },
  // A pair of edges (a scanner configured to cover them): no edge can join two edges, and the judgement is kept.
  { code: 'edgePairUnlinkable', detail: DETAIL },
  // An unfinished resolve of the pair had something it wrote taken back: its edge, its mark, or both (`detail` says which).
  { code: 'oppositeChoiceUndone', detail: DETAIL },
  // A mark the unfinished resolve set was kept, because another resolved pair relies on it.
  { code: 'markKept', detail: DETAIL },
];
const placeholdersOf = (note: Record<string, string>) => Object.keys(note).filter(k => k !== 'code' && k !== 'detail');

const fill = (template: string, params: Record<string, string>) =>
  template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, k: string) => params[k] ?? whole);

/** The keys of `lang` whose text, filled with `params`, appears in `toast` — the ones that could have rendered it. */
function keysRenderedIn(lang: Lang, toast: string, params: Record<string, string>, needs: string[] = []): string[] {
  return Object.entries(DICT[lang])
    .filter(([, v]) => typeof v === 'string' && v.replace(/\{\{[^}]*\}\}/g, '').trim().length >= 8)
    .filter(([, v]) => needs.every(p => new RegExp(`\\{\\{\\s*${p}\\s*\\}\\}`).test(v)))
    .filter(([, v]) => toast.includes(fill(v, params)))
    .map(([k]) => k);
}

const con = (over: Record<string, unknown> = {}) => ({
  id: 'c1', spaceId: 'work', type: 'entity', aId: 'a', aSummary: 'A says 8080',
  bId: 'b', bSummary: 'B says 9090', basis: 'structured-field', confidence: 1,
  status: 'open', detectedAt: '2026-01-01', updatedAt: '2026-01-01', ...over,
});

/** The text of the last `setup`'s view, after a change detection. */
let rendered: () => string = () => '';
/** The labels of the last `setup`'s buttons, after a change detection. */
let buttons: () => string[] = () => [];

function setup(lang: Lang, conApi: Record<string, unknown>) {
  const toasts: string[] = [];
  const push = (m: string) => { toasts.push(m); return 0; };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [ReviewTabComponent, getTranslocoModule({ translation: { en: DICT[lang] } })],
    providers: [
      { provide: SpacesApi, useValue: { getCompleteness: () => of({ spaceId: 'work', score: null, checks: [], truncated: false }) } },
      { provide: BrainApi, useValue: { getEntitiesByIds: () => of({ entities: [] }), getRecord: () => of({ _id: 'x' }) } },
      { provide: DuplicatesApi, useValue: { listDuplicates: () => of({ duplicates: [] }), scanDuplicates: () => of({}) } },
      { provide: ContradictionsApi, useValue: {
        listContradictions: () => of({ contradictions: [con()], nliConfigured: true }),
        ...conApi,
      } },
      { provide: ForksApi, useValue: { listForks: () => of({ forks: [], skip: 0, limit: 25 }) } },
      { provide: ToastService, useValue: { error: push, success: push, info: push, show: push } },
      { provide: ConfirmDialogService, useValue: { confirm: () => Promise.resolve(true) } },
    ],
  });
  const f = TestBed.createComponent(ReviewTabComponent);
  f.componentInstance.spaceId = 'work';
  f.detectChanges();
  const c = f.componentInstance;
  c.sub.set('contradictions');
  c.loadContradictions();
  toasts.length = 0;
  rendered = () => { f.detectChanges(); return (f.nativeElement as HTMLElement).textContent ?? ''; };
  buttons = () => { f.detectChanges(); return [...(f.nativeElement as HTMLElement).querySelectorAll('button')].map(b => b.textContent?.trim() ?? ''); };
  return { c, toasts };
}

/** Keep A on a card whose resolve answers `answer`; what was toasted. */
function keepA(lang: Lang, answer: () => Observable<unknown>): string[] {
  const { c, toasts } = setup(lang, { keepSide: answer });
  c.keepSide(c.conRows()[0], 'a');
  return [...toasts];
}

const resolvedWith = (notes: Note[]) => () => of({
  status: 'resolved', resolution: 'superseded', supersededId: 'b', markedRecord: true,
  notes: notes.map(({ code, detail }) => ({ code, detail, ...notes.find(n => n.code === code) })),
  note: notes.map(n => n.detail).join(' '),
});

describe('ReviewTabComponent: what a resolve tells the reviewer', () => {
  beforeEach(() => TestBed.resetTestingModule());

  for (const note of NOTES) {
    it(`${note.code} is rendered from one key, the same in en, de and pl, with its placeholders filled`, () => {
      const params = Object.fromEntries(placeholdersOf(note).map(p => [p, note[p as keyof typeof note]!]));
      const rendered: Record<Lang, string> = {} as Record<Lang, string>;
      for (const lang of LANGS) {
        const toasts = keepA(lang, resolvedWith([note]));
        expect(toasts.length, `${lang}: ${JSON.stringify(toasts)}`).toBe(1);
        rendered[lang] = toasts[0]!;
        expect(rendered[lang], `${lang}: the server's detail sentence was toasted`).not.toContain(DETAIL);
        expect(rendered[lang], `${lang}: a placeholder was left unfilled`).not.toMatch(/\{\{/);
      }
      const keys = keysRenderedIn('en', rendered.en, params, placeholdersOf(note))
        .filter(k => keysRenderedIn('de', rendered.de, params, placeholdersOf(note)).includes(k))
        .filter(k => keysRenderedIn('pl', rendered.pl, params, placeholdersOf(note)).includes(k));
      expect(keys.length, `no key renders ${note.code} in all of en/de/pl with ${placeholdersOf(note).join(', ') || 'no placeholders'}: ${JSON.stringify(rendered)}`).toBeGreaterThan(0);
    });
  }

  it('each code has a key of its own', () => {
    const toastOf = (note: Note) => keepA('en', resolvedWith([note]))[0] ?? '';
    const texts = NOTES.map(toastOf);
    expect(new Set(texts).size, JSON.stringify(texts)).toBe(NOTES.length);
  });

  it('the outcomes of one resolve are ONE toast that lists every one', () => {
    const both = [NOTES[1]!, NOTES[2]!];
    const toasts = keepA('en', resolvedWith(both));
    expect(toasts.length, JSON.stringify(toasts)).toBe(1);
    expect(toasts[0], 'the server\'s detail sentences were toasted').not.toContain(DETAIL);
    // Each outcome as the toast would say it alone: two different texts, both in the one toast.
    const alone = both.map(note => keepA('en', resolvedWith([note]))[0] ?? '');
    expect(new Set(alone).size, `the two outcomes read alike: ${JSON.stringify(alone)}`).toBe(2);
    for (const [i, note] of both.entries()) {
      expect(alone[i]!.length).toBeGreaterThan(0);
      expect(toasts[0], `the toast does not list ${note.code}`).toContain(alone[i]);
    }
  });

  describe('a failed resolve says so through a resolve-specific key picked by its code', () => {
    const DISMISS = DICT.en['duplicates.dismissError']!;
    const failing = (status: number, error: Record<string, unknown>) => () => throwError(() => new HttpErrorResponse({ status, error }));
    const failedToast = (via: 'keepSide' | 'resolveContradiction', answer: () => Observable<unknown>) => {
      const { c, toasts } = setup('en', { [via]: answer });
      if (via === 'keepSide') c.keepSide(c.conRows()[0], 'a'); else c.resolveContradiction(c.conRows()[0], 'edited');
      expect(toasts.length, JSON.stringify(toasts)).toBe(1);
      return toasts[0]!;
    };

    for (const via of ['keepSide', 'resolveContradiction'] as const) {
      it(`${via}: a 409 resolvedOtherwise is not the dismiss error, and says something other than an internal failure`, () => {
        const otherwise = failedToast(via, failing(409, { code: 'resolvedOtherwise', error: 'resolved otherwise' }));
        const internal = failedToast(via, failing(500, { code: 'internal', error: 'Internal server error' }));
        expect(otherwise).not.toBe(DISMISS);
        expect(internal).not.toBe(DISMISS);
        expect(keysRenderedIn('en', otherwise, {}).length, `the 409 toast is not the text of any key: ${otherwise}`).toBeGreaterThan(0);
        expect(otherwise, 'the code did not pick the key').not.toBe(internal);
      });
    }
  });

  /*
   * L3 (pre-ship lens): a claim nobody finished made the card look open while every other choice was refused `409`. The card
   * says the pair is being resolved, and which side the claim keeps, from one key in every language.
   */
  it('a card whose pair is being resolved says so, from one key in en, de and pl, naming the side kept', () => {
    const claimed = () => of({ contradictions: [con({ resolving: { resolution: 'superseded', winner: 'a', at: '2026-10-23T10:00:00.000Z' } })], nliConfigured: true });
    const text: Record<Lang, string> = {} as Record<Lang, string>;
    for (const lang of LANGS) {
      setup(lang, { listContradictions: claimed });
      text[lang] = rendered();
    }
    const plain = (() => { setup('en', {}); return rendered(); })();
    const keysOf = (lang: Lang) => Object.entries(DICT[lang])
      .filter(([, v]) => typeof v === 'string' && v.replace(/\{\{[^}]*\}\}/g, '').trim().length >= 8)
      .filter(([, v]) => text[lang].includes(v.split('{{')[0]!.trim()) && !plain.includes(v.split('{{')[0]!.trim()))
      .map(([k]) => k);
    const shared = keysOf('en').filter(k => keysOf('de').includes(k) && keysOf('pl').includes(k));
    expect(shared.length, `no key says the pair is being resolved in all of en/de/pl: ${JSON.stringify(text.en)}`).toBeGreaterThan(0);
    expect(text.en, 'a placeholder was left unfilled').not.toMatch(/\{\{/);
  });

  /*
   * Round 5: the resolved card said "the superseded record is kept and marked" when the loser was gone and nothing was marked
   * (`loserGone`), and a resolved card must not offer Dismiss (the server refuses it, `409 alreadyResolved`).
   */
  const resolvedCard = (notes: Note[]) => () => of({ contradictions: [con({
    status: 'resolved', resolution: 'superseded', supersededId: 'b', resolvedBy: 'reviewer-x', notes,
  })], nliConfigured: true });

  it('a resolved card whose loser was gone does not say the superseded record is marked, in en, de or pl', () => {
    for (const lang of LANGS) {
      setup(lang, { listContradictions: resolvedCard([{ code: 'loserGone', detail: DETAIL }]) });
      const text = rendered();
      const marked = DICT[lang]['review.contradictions.decidedBy']!.split('{{who}}')[1]!.trim();
      expect(text, `${lang}: the card claims a mark that was never set`).not.toContain(marked);
      expect(text, `${lang}: the card no longer names who decided`).toContain('reviewer-x');
    }
  });

  it('a resolved card whose loser was marked still says so', () => {
    setup('en', { listContradictions: resolvedCard([]) });
    expect(rendered()).toContain(DICT.en['review.contradictions.decidedBy']!.split('{{who}}')[1]!.trim());
  });

  it('a dismiss refused 409 alreadyResolved (a race with a resolve) is said from a key, in en, de and pl', () => {
    for (const lang of LANGS) {
      const { c, toasts } = setup(lang, { dismissContradiction: () => throwError(() => new HttpErrorResponse({ status: 409, error: { code: 'alreadyResolved', error: 'SERVER-SENTENCE' } })) });
      c.dismissContradiction(c.conRows()[0]);
      expect(toasts.length, JSON.stringify(toasts)).toBe(1);
      expect(toasts[0], `${lang}: the server's sentence was toasted`).not.toContain('SERVER-SENTENCE');
      expect(keysRenderedIn(lang, toasts[0]!, {}).length, `${lang}: the toast is not the text of any key: ${toasts[0]}`).toBeGreaterThan(0);
      expect(toasts[0], `${lang}: still the generic dismiss error`).not.toBe(DICT[lang]['duplicates.dismissError']);
    }
  });

  it('a resolved card does not offer Dismiss', () => {
    setup('en', { listContradictions: resolvedCard([]) });
    const labels = buttons();
    expect(labels.length, 'the card rendered no buttons at all: the check would pass vacuously').toBeGreaterThan(0);
    expect(labels, JSON.stringify(labels)).not.toContain(DICT.en['duplicates.dismiss']);
  });
});
