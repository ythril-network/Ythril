/**
 * The Review tab's contradiction scan says so when the scan was HELD, in every language the client ships (Q-697, b235 design v3 item 13;
 * integration S3).
 *
 * ## The defect
 *
 * `review-contradictions-state.ts` toasts on `nliStalled` (the judge was unreachable) and on `failedSpaces` (a space could not be
 * scanned) and on nothing else, so a scan that HELD - a type whose neighbour search ran over an index that was not ready, its position
 * kept for the next run - toasted nothing and reloaded the list: "0 found" over a scan that had looked at part of the records, which
 * `contradictions.ts` forbids in so many words. The server now answers `indexHeld: [{ spaceId, type, pass? }]`
 * (`a-scan-response-says-which-types-an-index-held-db.test.js`), and this is the client's half of the same rule.
 *
 * ## What is held
 *
 *  - an answer whose `indexHeld` names a type toasts ONE message of its own (not the judge's `scanStalled`, not the generic scan error:
 *    each names a different cause and sends the operator to a different place), and not as a success;
 *  - the message has a translation in EVERY language file under `public/assets/i18n`, the files read from the directory and never listed:
 *    a language added later is a row added here by construction. A language that only echoes the key, or repeats the English sentence,
 *    is a language the toast is not translated in;
 *  - an answer whose `indexHeld` is empty (the field the server always sends) toasts nothing for it, and the judge's stall is still its
 *    own toast beside it.
 *
 * "Seen red" on the base: the answer's `indexHeld` is read nowhere, so the held scan toasts nothing.
 *
 * Run: npm run test:client -- src/app/pages/brain/review-contradictions.scan-held.spec.ts
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { of } from 'rxjs';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { ReviewTabComponent } from './review-tab.component';
import { DuplicatesApi } from '../../core/duplicates-api.service';
import { ContradictionsApi } from '../../core/contradictions-api.service';
import { ForksApi } from '../../core/forks-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { BrainApi } from '../../core/brain-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';

const I18N = resolve(__dirname, '../../../../public/assets/i18n');
/** Every language file the client ships, read from the directory. */
const LANGS = readdirSync(I18N).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')).sort();
const dict = (lang: string) => JSON.parse(readFileSync(resolve(I18N, `${lang}.json`), 'utf8')) as Record<string, string>;

/** Toasts of any kind but success, as the keys the (echoing) translation returned. */
interface Seen { kind: string; message: string }

function setup(scan: () => unknown) {
  const toasts: Seen[] = [];
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [ReviewTabComponent, getTranslocoModule()],
    providers: [
      { provide: SpacesApi, useValue: { getCompleteness: () => of({ spaceId: 'work', score: null, checks: [], truncated: false }) } },
      { provide: BrainApi, useValue: { getEntitiesByIds: () => of({ entities: [] }), getRecord: () => of({ _id: 'x', name: 'full record' }) } },
      { provide: DuplicatesApi, useValue: { listDuplicates: () => of({ duplicates: [] }), scanDuplicates: () => of({}) } },
      { provide: ContradictionsApi, useValue: { listContradictions: () => of({ contradictions: [], nliConfigured: true }), scanContradictions: scan } },
      { provide: ForksApi, useValue: { listForks: () => of({ forks: [], skip: 0, limit: 25 }), resolveFork: () => of({}) } },
      { provide: ToastService, useValue: {
        error: (m: string) => toasts.push({ kind: 'error', message: m }),
        success: (m: string) => toasts.push({ kind: 'success', message: m }),
        info: (m: string) => toasts.push({ kind: 'info', message: m }),
        show: (m: string, kind = 'info') => toasts.push({ kind, message: m }),
      } },
      { provide: ConfirmDialogService, useValue: { confirm: () => Promise.resolve(true) } },
    ],
  });
  const f = TestBed.createComponent(ReviewTabComponent);
  f.componentInstance.spaceId = 'work';
  f.detectChanges();
  const c = f.componentInstance;
  c.sub.set('contradictions');
  f.detectChanges();
  toasts.length = 0;   // what loading the tab said is not what the scan says
  return { c, toasts };
}

const answer = (over: Record<string, unknown>) => () => of({ scannedSpaces: 1, scanned: 3, found: 0, nliStalled: false, failedSpaces: [], ...over });
const HELD = [{ spaceId: 'work', type: 'fact', pass: 'structured' }];
/** The keys that already mean something else: a held scan must not borrow either. */
const OTHER_CAUSES = ['review.contradictions.scanStalled', 'duplicates.scanError', 'duplicates.scanForbidden'];

describe('the Review tab says a contradiction scan was held', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('reads the language files it asserts over (the scan itself still works)', () => {
    expect(LANGS.length, `languages found in ${I18N}`).toBeGreaterThanOrEqual(3);
    expect(LANGS).toContain('en');
  });

  it('a scan whose answer names a held type toasts one message of its own, not as a success', () => {
    const { c, toasts } = setup(answer({ indexHeld: HELD }));
    c.conState.scan('work');
    const own = toasts.filter(t => !OTHER_CAUSES.includes(t.message));
    expect(own, `a held scan toasted nothing of its own (${JSON.stringify(toasts)}): "0 found" reads as "nothing disagrees"`).toHaveLength(1);
    expect(own[0]!.kind).not.toBe('success');
  });

  it('the held message has a translated sentence in every language file', () => {
    const { c, toasts } = setup(answer({ indexHeld: HELD }));
    c.conState.scan('work');
    const key = toasts.map(t => t.message).find(m => !OTHER_CAUSES.includes(m));
    expect(key, 'a held scan raised no message of its own, so there is no key to look up').toBeTruthy();
    const en = dict('en')[key!];
    expect(typeof en, `en.json has no sentence for ${key}`).toBe('string');
    expect(en!.trim().length).toBeGreaterThan(20);
    // It says what held and why, in English: an index that is not ready, so what the scan settled is partial.
    expect(en!, 'the English sentence does not name the index').toMatch(/index/i);
    for (const lang of LANGS) {
      const text = dict(lang)[key!];
      expect(typeof text, `${lang}.json has no sentence for ${key}: a ${lang} reader gets the raw key`).toBe('string');
      expect(text!.trim().length, `${lang}: the sentence is empty`).toBeGreaterThan(20);
      expect(text, `${lang}: the sentence is the key`).not.toBe(key);
      if (lang !== 'en') expect(text, `${lang}: the sentence is the English one, untranslated`).not.toBe(en);
      for (const other of OTHER_CAUSES) {
        if (dict(lang)[other] !== undefined) expect(text, `${lang}: the held sentence repeats ${other}`).not.toBe(dict(lang)[other]);
      }
    }
  });

  it('an answer whose indexHeld is empty raises no held message, and a stalled judge is still its own toast beside a held one', () => {
    const clean = setup(answer({ indexHeld: [] }));
    clean.c.conState.scan('work');
    expect(clean.toasts, 'a scan that held nothing toasted').toEqual([]);

    const both = setup(answer({ indexHeld: HELD, nliStalled: true }));
    both.c.conState.scan('work');
    const messages = both.toasts.map(t => t.message);
    expect(messages).toContain('review.contradictions.scanStalled');
    expect(messages.filter(m => !OTHER_CAUSES.includes(m)), 'the held toast is gone when the judge also stalled').toHaveLength(1);
  });
});
