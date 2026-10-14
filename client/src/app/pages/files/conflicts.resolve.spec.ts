/**
 * Resolving a conflict from the Conflicts page (`Q-466`, the client half): a refusal is SAID, a destructive choice is asked about,
 * and every label names what it does.
 *
 * The page used to swallow a refused single resolve (`error: () => this.resolving.set(null)`: the row went back to idle and nothing
 * said why), listed a bulk failure as `<uuid>: <English server text>`, asked "Resolve 3 conflict(s) with "keep-both"?" with the raw
 * action code, and offered "Save to space…" for an action that MOVES the copy. These cases use the REAL translation files in every
 * locale: the transloco test module echoes keys, and an echoed key is never a wrong sentence.
 */
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { provideRouter } from '@angular/router';
import { FilesApi } from '../../core/files-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { locale } from '../../testing/files-page-harness';
import { serverActCodes } from '../../testing/server-act-codes';
import { ConflictsComponent } from './conflicts.component';

const LANGS = ['en', 'de', 'pl'] as const;
const UUID = (n: number) => `c0ffee00-0000-4000-8000-00000000000${n}`;

interface Toast { kind: 'success' | 'error' | 'info'; message: string; duration: number | undefined }

/** The longest run of a sentence that is not a placeholder: what must survive into the rendered words. */
const fixedWords = (sentence: string): string =>
  sentence.split(/\{\{[^}]*\}\}/).map(s => s.trim()).sort((a, b) => b.length - a.length)[0] ?? '';

function refused(status: number, body: unknown): HttpErrorResponse {
  return new HttpErrorResponse({ status, error: body });
}

function conflict(n: number) {
  return {
    id: UUID(n), spaceId: 'work', originalPath: `docs/report-${n}.txt`, conflictPath: `docs/report-${n}.conflict.txt`,
    peerInstanceId: 'peer-1', peerInstanceLabel: 'Peer', detectedAt: '2026-10-01T10:00:00.000Z',
  };
}

interface Calls { resolve: unknown[][]; bulk: unknown[][] }

function mount(opts: {
  lang?: string;
  conflicts?: number;
  resolveConflict?: (...args: any[]) => unknown;
  bulkResolveConflicts?: (...args: any[]) => unknown;
  confirmAnswer?: boolean;
}) {
  const lang = opts.lang ?? 'en';
  const toasts: Toast[] = [];
  const confirms: { title?: string; message?: string; confirmLabel?: string; danger?: boolean }[] = [];
  const calls: Calls = { resolve: [], bulk: [] };
  const list = Array.from({ length: opts.conflicts ?? 2 }, (_, i) => conflict(i + 1));
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [ConflictsComponent, getTranslocoModule({
      langs: { [lang]: locale(lang) },
      translocoConfig: { availableLangs: [lang], defaultLang: lang },
    })],
    providers: [
      provideRouter([]),
      { provide: FilesApi, useValue: {
        listConflicts: () => of({ conflicts: list }),
        resolveConflict: (...args: unknown[]) => { calls.resolve.push(args); return (opts.resolveConflict ?? (() => of({ status: 'resolved' })))(...args); },
        bulkResolveConflicts: (...args: unknown[]) => { calls.bulk.push(args); return (opts.bulkResolveConflicts ?? (() => of({ resolved: list.length, failed: [] })))(...args); },
      } },
      { provide: SpacesApi, useValue: { listSpaces: () => of({ spaces: [{ id: 'work', label: 'Work' }, { id: 'archive-space', label: 'Archive' }] }) } },
      { provide: ToastService, useValue: {
        success: (message: string, duration?: number) => { toasts.push({ kind: 'success', message, duration }); return 0; },
        error: (message: string, duration?: number) => { toasts.push({ kind: 'error', message, duration }); return 0; },
        info: (message: string, duration?: number) => { toasts.push({ kind: 'info', message, duration }); return 0; },
        show: (message: string, kind: Toast['kind'] = 'info', duration?: number) => { toasts.push({ kind, message, duration }); return 0; },
      } },
      { provide: ConfirmDialogService, useValue: { confirm: (o: { title?: string; message?: string; confirmLabel?: string; danger?: boolean }) => { confirms.push(o); return Promise.resolve(opts.confirmAnswer ?? true); } } },
    ],
  });
  const fixture = TestBed.createComponent(ConflictsComponent);
  fixture.detectChanges();
  const c = fixture.componentInstance as any;
  const el = fixture.nativeElement as HTMLElement;
  const tick = () => new Promise<void>(r => setTimeout(r, 0));
  const settle = async () => { for (let i = 0; i < 3; i++) { await tick(); fixture.detectChanges(); } };
  return { fixture, c, el, toasts, confirms, calls, settle, list };
}

beforeEach(() => TestBed.resetTestingModule());

describe('a refused single resolve is said, and stays until it is dismissed', () => {
  for (const lang of LANGS) {
    it(`${lang}: destination_exists shows the localized sentence in a toast with no lifetime (0), and the row stays`, async () => {
      const words = locale(lang);
      const m = mount({
        lang, conflicts: 1,
        resolveConflict: () => throwError(() => refused(409, { error: 'English server words', code: 'destination_exists', path: 'docs/report-1.txt' })),
      });
      m.c.resolve(m.list[0]);
      await m.settle();

      const errors = m.toasts.filter(t => t.kind === 'error');
      expect(errors.length, 'one refusal, one toast').toBe(1);
      expect(errors[0]!.message).toContain(fixedWords(words['conflicts.refusal.destination_exists']!));
      expect(errors[0]!.message, 'the sentence is the operator\'s language, not the server\'s').not.toContain('English server words');
      expect(errors[0]!.duration, 'a refusal that says what to do stays until dismissed').toBe(0);
      expect(m.c.conflicts().length, 'the record is still open: nothing was resolved').toBe(1);
      expect(m.c.resolving(), 'and the row is idle again').toBeNull();
    });
  }

  it('a code this client has no words for shows the server\'s own sentence', async () => {
    const m = mount({
      conflicts: 1,
      resolveConflict: () => throwError(() => refused(409, { error: 'The server says why.', code: 'some_future_code' })),
    });
    m.c.resolve(m.list[0]);
    await m.settle();
    expect(m.toasts.filter(t => t.kind === 'error').map(t => t.message)).toEqual(['The server says why.']);
  });
});

describe('a resolve that succeeded says where the copy went', () => {
  it('save-to-space names the space the copy now lives in', async () => {
    const m = mount({ conflicts: 1 });
    m.c.conflictActions[UUID(1)] = 'save-to-space';
    m.c.conflictTargetSpace[UUID(1)] = 'archive-space';
    m.c.resolve(m.list[0]);
    await m.settle();
    const said = m.toasts.filter(t => t.kind !== 'error');
    expect(said.length).toBe(1);
    expect(said[0]!.message).toMatch(/archive-space|Archive/);
    // The page sends no rename, so the copy keeps its conflict-copy name in the target space: the toast names that path.
    expect(said[0]!.message, 'the toast names a path the copy does not have').toContain('docs/report-1.conflict.txt');
    expect(m.c.conflicts().length).toBe(0);
  });

  it('a copy that was already gone closes the record and says that, in words rather than silence', async () => {
    const m = mount({ conflicts: 1, resolveConflict: () => of({ status: 'resolved', resolved: 'nothing-to-place' }) });
    m.c.resolve(m.list[0]);
    await m.settle();
    expect(m.toasts.filter(t => t.kind !== 'error').map(t => t.message).join('|')).toMatch(/already gone/i);
    expect(m.c.conflicts().length).toBe(0);
  });
});

describe('keep-incoming replaces the local file and cannot be undone, so one resolve asks first', () => {
  it('asks before it sends, and sends nothing when the answer is no', async () => {
    const declined = mount({ conflicts: 1, confirmAnswer: false });
    declined.c.conflictActions[UUID(1)] = 'keep-incoming';
    declined.c.resolve(declined.list[0]);
    await declined.settle();
    expect(declined.confirms.length).toBe(1);
    expect(declined.calls.resolve, 'declined: nothing was sent').toEqual([]);

    const accepted = mount({ conflicts: 1, confirmAnswer: true });
    accepted.c.conflictActions[UUID(1)] = 'keep-incoming';
    accepted.c.resolve(accepted.list[0]);
    await accepted.settle();
    expect(accepted.confirms.length).toBe(1);
    expect(accepted.calls.resolve.length, 'accepted: sent once').toBe(1);
  });
});

describe('a bulk failure lists the path and the localized sentence, and stays', () => {
  for (const lang of LANGS) {
    it(`${lang}: one line per failed record with its path and its sentence, no id, no server text`, async () => {
      const words = locale(lang);
      const m = mount({
        lang,
        bulkResolveConflicts: () => of({
          resolved: 0,
          failed: [
            { id: UUID(1), error: 'English server words', code: 'destination_exists', status: 409, path: 'docs/report-1.txt' },
            { id: UUID(2), error: 'A sentence only the server has', code: 'some_future_code', path: 'docs/report-2.txt' },
          ],
        }),
      });
      m.c.selectedIds.set([UUID(1), UUID(2)]);
      await m.c.bulkResolve();
      await m.settle();

      const errors = m.toasts.filter(t => t.kind === 'error');
      expect(errors.length).toBe(1);
      const text = errors[0]!.message;
      expect(text).toContain('docs/report-1.txt');
      expect(text).toContain('docs/report-2.txt');
      expect(text, `${lang} the sentence for destination_exists`).toContain(fixedWords(words['conflicts.refusal.destination_exists']!));
      expect(text, 'a code with no words shows the server\'s sentence').toContain('A sentence only the server has');
      expect(text).not.toContain('English server words');
      expect(text, 'a record is named by its path, never by its id').not.toContain(UUID(1));
      expect(text).not.toContain(UUID(2));
      expect(errors[0]!.duration, 'the list stays until dismissed').toBe(0);
      expect(text.split('\n').filter(l => l.includes('docs/report-')).length, 'one line per record').toBe(2);
    });
  }
});

describe('the bulk confirmation names the action the operator chose', () => {
  for (const lang of LANGS) {
    it(`${lang}: the label, not the action code`, async () => {
      const words = locale(lang);
      for (const [action, key] of [['keep-local', 'keepLocal'], ['keep-incoming', 'keepIncoming'], ['keep-both', 'keepBoth']] as const) {
        const m = mount({ lang });
        m.c.selectedIds.set([UUID(1), UUID(2)]);
        m.c.bulkAction = action;
        await m.c.bulkResolve();
        expect(m.confirms.length).toBe(1);
        expect(m.confirms[0]!.message, `${lang} ${action}`).toContain(words[`conflicts.action.${key}`]!);
        expect(m.confirms[0]!.message, `${lang} ${action}: the raw code is not a word an operator reads`).not.toContain(action);
      }
    });
  }
});

describe('the Conflicts table is labelled', () => {
  it('every checkbox in a row says which conflict it selects, and no two say the same', async () => {
    const m = mount({ conflicts: 3 });
    const boxes = [...m.el.querySelectorAll('tbody input[type="checkbox"]')] as HTMLInputElement[];
    expect(boxes.length).toBe(3);
    const labels = boxes.map(b => (b.getAttribute('aria-label') ?? '').trim());
    for (const label of labels) expect(label, 'a row checkbox has an accessible name').not.toBe('');
    expect(new Set(labels).size, 'distinct per row').toBe(3);
  });

  it('no header cell is empty: each has text or a label', async () => {
    const m = mount({ conflicts: 2 });
    const headers = [...m.el.querySelectorAll('thead th')] as HTMLElement[];
    expect(headers.length).toBeGreaterThan(0);
    for (const [i, th] of headers.entries()) {
      const name = (th.textContent ?? '').trim() || (th.getAttribute('aria-label') ?? '').trim();
      expect(name, `header cell ${i}`).not.toBe('');
    }
  });

  for (const lang of LANGS) {
    it(`${lang}: the action that moves a copy to another space is called a move`, () => {
      const words = locale(lang);
      const m = mount({ lang, conflicts: 1 });
      const option = m.el.querySelector('tbody option[value="save-to-space"]') as HTMLOptionElement;
      expect(option.textContent!.trim()).toBe(words['conflicts.action.saveToSpace']);
      const move: Record<string, RegExp> = { en: /^Move to space/, de: /verschieb|übertrag/i, pl: /przenie|przesu/i };
      expect(words['conflicts.action.saveToSpace']).toMatch(move[lang]!);
      const save: Record<string, RegExp> = { en: /^Save/, de: /speicher/i, pl: /^Zapisz/ };
      expect(words['conflicts.action.saveToSpace'], `${lang} no longer says "save"`).not.toMatch(save[lang]!);
      // de follows the page: this page says Bereich for a space.
      if (lang === 'de') expect(words['conflicts.action.saveToSpace']).toContain('Bereich');
    });
  }

  it('"Back to Files" goes to the Files tab, not to a route that no longer shows it', () => {
    const m = mount({ conflicts: 1 });
    const back = m.el.querySelector('a') as HTMLAnchorElement;
    expect(back.getAttribute('href')).toMatch(/^\/brain\?.*tab=files/);
  });
});

describe('every conflicts.refusal.* sentence is one the server can answer, in every locale', () => {
  const codes = serverActCodes();
  /** The codes a locale has a conflicts sentence for. It throws on none: every loop below would pass over nothing and report clean. */
  const refusalCodes = (lang: string): string[] => {
    const found = Object.keys(locale(lang))
      .filter(k => k.startsWith('conflicts.refusal.')).map(k => k.slice('conflicts.refusal.'.length));
    if (found.length === 0) throw new Error(`${lang} has no conflicts.refusal.* sentence at all, so a check over each of them would report clean about nothing`);
    return found;
  };

  it('the family exists and holds the code the Conflicts page was reported for', () => {
    expect(refusalCodes('en')).toContain('destination_exists');
  });

  it('a conflicts sentence for a code the server does not answer is a sentence nobody can reach', () => {
    for (const lang of LANGS) {
      expect(refusalCodes(lang).filter(code => !codes.includes(code)), lang).toEqual([]);
    }
  });

  it('en, de and pl cover the same codes', () => {
    const en = refusalCodes('en').sort();
    expect(refusalCodes('de').sort()).toEqual(en);
    expect(refusalCodes('pl').sort()).toEqual(en);
  });

  for (const lang of ['de', 'pl']) {
    it(`${lang}: each is a translation rather than a copy of en, with the same placeholders`, () => {
      const words = locale(lang);
      const en = locale('en');
      const placeholders = (s: string) => (s.match(/\{\{\s*\w+\s*\}\}/g) ?? []).sort();
      for (const code of refusalCodes('en')) {
        const key = `conflicts.refusal.${code}`;
        expect(words[key], `${lang} ${key}`).toBeTruthy();
        expect(words[key], `${lang} ${key}`).not.toBe(en[key]);
        expect(placeholders(words[key]!), `${lang} ${key}`).toEqual(placeholders(en[key]!));
      }
    });
  }

  it('destination_exists says, in English, that nothing was moved (de and pl are held to the translation rule above)', () => {
    const sentence = locale('en')['conflicts.refusal.destination_exists'];
    expect(sentence, 'en has the sentence').toBeDefined();
    expect(sentence).toMatch(/nothing was moved/i);
  });
});

/** The polite status the page keeps in the DOM: what a screen reader hears of an outcome that has no element of its own. */
const statusText = (el: HTMLElement): string => (el.querySelector('[role="status"]')?.textContent ?? '').trim();
const rowsOf = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll('tbody tr')] as HTMLElement[];

describe('the bulk confirmation for keep-incoming says it cannot be undone and is a danger confirm (U1)', () => {
  const irreversible: Record<string, RegExp> = { en: /cannot be undone/i, de: /nicht rückgängig/i, pl: /nie można cofnąć/i };
  for (const lang of LANGS) {
    it(`${lang}: keep-incoming is asked as a danger confirm with irreversible wording; keep-local and keep-both are not`, async () => {
      const words = locale(lang);
      const incoming = mount({ lang });
      incoming.c.selectedIds.set([UUID(1), UUID(2)]);
      incoming.c.bulkAction = 'keep-incoming';
      await incoming.c.bulkResolve();
      expect(incoming.confirms.length).toBe(1);
      expect(incoming.confirms[0]!.danger, `${lang} a replacement nothing brings back is a danger confirm`).toBe(true);
      expect(incoming.confirms[0]!.message, lang).toMatch(irreversible[lang]!);
      expect(incoming.confirms[0]!.message, `${lang} it still names the action by its label`).toContain(words['conflicts.action.keepIncoming']!);
      expect(incoming.confirms[0]!.confirmLabel, lang).toBe(words['conflicts.action.keepIncoming']);

      for (const action of ['keep-local', 'keep-both'] as const) {
        const other = mount({ lang });
        other.c.selectedIds.set([UUID(1), UUID(2)]);
        other.c.bulkAction = action;
        await other.c.bulkResolve();
        expect(other.confirms[0]!.danger, `${lang} ${action}`).not.toBe(true);
        expect(other.confirms[0]!.message, `${lang} ${action} is not irreversible wording`).not.toMatch(irreversible[lang]!);
      }
    });
  }
});

describe('the destination hint fits keep-both as well as the move (U6)', () => {
  // The page can offer keep-both a rename-less placement and the move a target space: the hint says what to do about what stands
  // there and to resolve again, and names another space only as the move's own way out.
  const remedy: Record<string, [RegExp, RegExp]> = {
    en: [/remove what stands there/i, /resolve again/i],
    de: [/entfernen Sie, was dort liegt/i, /erneut/i],
    pl: [/usuń to, co tam jest/i, /ponownie/i],
  };
  for (const lang of LANGS) {
    it(`${lang}: destination_exists says what to remove and to resolve again`, () => {
      const sentence = locale(lang)['conflicts.refusal.destination_exists']!;
      expect(sentence).toMatch(remedy[lang]![0]);
      expect(sentence).toMatch(remedy[lang]![1]);
    });
  }
});

describe('after a resolve the focus moves on, and the outcome is announced (A3)', () => {
  it('a single resolve focuses the first control of the row that took its place', async () => {
    const m = mount({ conflicts: 3 });
    (rowsOf(m.el)[0]!.querySelector('button') as HTMLButtonElement).focus();
    await m.c.resolve(m.list[0]);
    await m.settle();
    const rows = rowsOf(m.el);
    expect(rows.length).toBe(2);
    expect(document.activeElement, 'not left on the page body').not.toBe(document.body);
    expect(document.activeElement).toBe(rows[0]!.querySelector('input[type="checkbox"]'));
    expect(rows[0]!.textContent).toContain('docs/report-2.txt');
  });

  it('resolving the last row of several focuses the row now last', async () => {
    const m = mount({ conflicts: 2 });
    await m.c.resolve(m.list[1]);
    await m.settle();
    const rows = rowsOf(m.el);
    expect(rows.length).toBe(1);
    expect(document.activeElement).toBe(rows[0]!.querySelector('input[type="checkbox"]'));
  });

  it('resolving the only conflict focuses the empty-state heading, which is on screen', async () => {
    const m = mount({ conflicts: 1 });
    await m.c.resolve(m.list[0]);
    await m.settle();
    const heading = m.el.querySelector('.empty-state h3') as HTMLElement | null;
    expect(heading, 'the empty state is shown').toBeTruthy();
    expect(document.activeElement).toBe(heading);
  });

  it('a bulk resolve focuses the first remaining row', async () => {
    const m = mount({ conflicts: 3 });
    m.c.selectedIds.set([UUID(1)]);
    await m.c.bulkResolve();
    await m.settle();
    expect(document.activeElement).toBe(rowsOf(m.el)[0]!.querySelector('input[type="checkbox"]'));
  });

  for (const lang of LANGS) {
    it(`${lang}: keep-local, keep-incoming and keep-both each say what happened, by path, in a polite status`, async () => {
      const words = locale(lang);
      for (const [action, key] of [['keep-local', 'keepLocal'], ['keep-incoming', 'keepIncoming'], ['keep-both', 'keepBoth']] as const) {
        const m = mount({ lang, conflicts: 1 });
        const region = m.el.querySelector('[role="status"][aria-live="polite"]');
        expect(region, `${lang} ${action}: a polite status is on the page before the outcome`).toBeTruthy();
        m.c.conflictActions[UUID(1)] = action;
        await m.c.resolve(m.list[0]);
        await vi.waitFor(() => {
          m.fixture.detectChanges();
          expect(statusText(m.el), `${lang} ${action}`).toContain(fixedWords(words[`conflicts.status.${key}`]!));
        }, { timeout: 1500 });
        expect(statusText(m.el)).toContain('docs/report-1.txt');
        expect(statusText(m.el), 'an operator reads the words, not the code').not.toContain(action);
      }
    });

    it(`${lang}: a bulk resolve says how many it resolved`, async () => {
      const words = locale(lang);
      const m = mount({ lang });
      m.c.selectedIds.set([UUID(1), UUID(2)]);
      await m.c.bulkResolve();
      await vi.waitFor(() => {
        m.fixture.detectChanges();
        expect(statusText(m.el), lang).toContain(fixedWords(words['conflicts.status.bulkResolved']!));
      }, { timeout: 1500 });
      expect(statusText(m.el)).toContain('2');
    });
  }
});

describe('a file-act code with no conflicts sentence never shows the server\'s English (A6)', () => {
  const english = locale('en');
  const unworded = serverActCodes().filter(code => !(`conflicts.refusal.${code}` in english));

  for (const lang of LANGS) {
    it(`${lang}: the generic sentence exists and is a translation`, () => {
      const generic = locale(lang)['conflicts.error.resolveUnfinished'];
      expect(generic, `${lang} conflicts.error.resolveUnfinished`).toBeTruthy();
      if (lang !== 'en') expect(generic).not.toBe(english['conflicts.error.resolveUnfinished']);
    });

    it(`${lang}: each such code, single and bulk, shows the generic sentence`, async () => {
      const generic = fixedWords(locale(lang)['conflicts.error.resolveUnfinished']!);
      for (const code of unworded) {
        const single = mount({
          lang, conflicts: 1,
          resolveConflict: () => throwError(() => refused(500, { error: 'English server words', code, path: 'docs/report-1.txt' })),
        });
        single.c.resolve(single.list[0]);
        await single.settle();
        const said = single.toasts.filter(t => t.kind === 'error').map(t => t.message).join('|');
        expect(said, `${lang} ${code} single`).toContain(generic);
        expect(said, `${lang} ${code} single: not the server's sentence`).not.toContain('English server words');

        const bulk = mount({
          lang,
          bulkResolveConflicts: () => of({ resolved: 0, failed: [{ id: UUID(1), error: 'English server words', code, status: 500, path: 'docs/report-1.txt' }] }),
        });
        bulk.c.selectedIds.set([UUID(1)]);
        await bulk.c.bulkResolve();
        await bulk.settle();
        const listed = bulk.toasts.filter(t => t.kind === 'error').map(t => t.message).join('|');
        expect(listed, `${lang} ${code} bulk`).toContain(generic);
        expect(listed, `${lang} ${code} bulk: not the server's sentence`).not.toContain('English server words');
      }
    });
  }
});
