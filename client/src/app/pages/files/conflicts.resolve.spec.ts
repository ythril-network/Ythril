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
import { describe, it, expect, beforeEach } from 'vitest';
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
  const confirms: { title?: string; message?: string }[] = [];
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
      { provide: ConfirmDialogService, useValue: { confirm: (o: { title?: string; message?: string }) => { confirms.push(o); return Promise.resolve(opts.confirmAnswer ?? true); } } },
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
