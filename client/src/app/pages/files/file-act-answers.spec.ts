/**
 * What the Files page says for each answer a file act can give (`Q-463`).
 *
 * The server answers a refused or unfinished file act with `{ error, code, path?, retryable? }`. The page used to
 * throw that body away and say "Failed to rename file." for every one of them, including the one that is NOT a
 * failure: a move whose bytes moved and whose records the server is finishing.
 *
 * These specs use the REAL en.json, not an echo of the keys, because the thing being pinned is the sentence the
 * operator reads.
 */
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ActivatedRoute } from '@angular/router';
import { FilesApi } from '../../core/files-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { BrainApi } from '../../core/brain-api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { serverActCodes } from '../../testing/server-act-codes';
import { FileManagerComponent } from './file-manager.component';
import { FILE_REFUSALS_WITH_REMEDY } from './file-listing.store';

const I18N = resolve(__dirname, '../../../../public/assets/i18n');
const locale = (name: string): Record<string, string> =>
  JSON.parse(readFileSync(resolve(I18N, `${name}.json`), 'utf8'));
const en = locale('en');

/** What a code reads as in en with its path filled in — the sentence under test, taken from the file that ships. */
const said = (code: string, path?: string): string => en[`files.refusal.${code}`]!.replace('{{path}}', path ?? '');

/** The codes a file act answers, read out of the module that defines them. */
const serverCodes = serverActCodes;

/** A failed request as the HTTP client delivers it: the answer's body under `error`, its headers beside it. */
function answer(status: number, body: unknown, headers: Record<string, string> = {}): HttpErrorResponse {
  return new HttpErrorResponse({ status, error: body, headers: new HttpHeaders(headers) });
}

/** `errorLifetimes` holds the duration each error toast asked for, parallel to `error`: undefined is the service's default. */
interface Toasts { error: string[]; info: string[]; success: string[]; errorLifetimes: (number | undefined)[] }

function create(apiOverrides: Record<string, unknown>) {
  const listed: string[] = [];
  const api = {
    listSpaces: () => of({ spaces: [{ id: 'work', label: 'work' }] }),
    listFiles: (_s: string, path: string) => { listed.push(path); return of({ entries: [], path }); },
    getFileDownloadUrl: () => of({ url: '' }),
    getFileExtract: () => of(null),
    createDir: () => of({}),
    deleteFile: () => of({}),
    moveFile: () => of({}),
    getSpaceStats: () => of({ facts: 0, entities: 0, edges: 0, chrono: 0, files: 0 }),
    getSpaceMeta: () => of({ tagSuggestions: [], typeSchemas: {} }),
    getFileMeta: () => of(null),
    ...apiOverrides,
  } as any;
  const toasts: Toasts = { error: [], info: [], success: [], errorLifetimes: [] };
  TestBed.configureTestingModule({
    imports: [FileManagerComponent, getTranslocoModule({ translation: { en } })],
    providers: [
      { provide: FilesApi, useValue: api },
      { provide: SpacesApi, useValue: api },
      { provide: BrainApi, useValue: api },
      { provide: AuthService, useValue: { token: () => 't' } },
      { provide: ToastService, useValue: {
        error: (m: string, duration?: number) => { toasts.error.push(m); toasts.errorLifetimes.push(duration); },
        info: (m: string) => toasts.info.push(m),
        success: (m: string) => toasts.success.push(m),
        show: () => 0,
      } },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } }, queryParamMap: of() } },
    ],
  });
  const fixture = TestBed.createComponent(FileManagerComponent);
  fixture.detectChanges();
  return { c: fixture.componentInstance as any, toasts, listed };
}

/** Rename a.txt to b.txt through the page's own confirm, as the row's Save button does. */
function rename(c: any): void {
  c.renamingEntry.set('a.txt');
  c.renameValue = 'b.txt';
  c.confirmRename({ name: 'a.txt', isDirectory: false });
}

beforeEach(() => TestBed.resetTestingModule());
afterEach(() => vi.useRealTimers());

describe('the Files page — a refused file act says why', () => {
  it('path_blocked names the path and keeps the row in edit mode', () => {
    const { c, toasts } = create({
      moveFile: () => throwError(() => answer(409, { error: 'server words', code: 'path_blocked', path: 'docs/a.txt' })),
    });
    rename(c);
    expect(toasts.error).toEqual([said('path_blocked', 'docs/a.txt')]);
    expect(toasts.error[0]).toContain('docs/a.txt');
    expect(toasts.info).toEqual([]);
    expect(c.renamingEntry()).toBe('a.txt');
  });

  it('destination_exists (a move onto something that is already there) names the path, says what to do, and moves nothing', () => {
    const { c, toasts } = create({
      moveFile: () => throwError(() => answer(409, { error: 'server words', code: 'destination_exists', path: 'b.txt' })),
    });
    rename(c);
    expect(toasts.error).toEqual([said('destination_exists', 'b.txt')]);
    expect(toasts.error[0]).toContain('b.txt');
    expect(toasts.error[0]).not.toBe(en['files.error.renameFailed']);
    expect(toasts.info).toEqual([]);
    expect(c.renamingEntry()).toBe('a.txt');
  });

  it('destination_exists says that a move replaces nothing and that deleting what is there deletes it everywhere it is replicated', () => {
    const statements: Record<string, RegExp[]> = {
      en: [/never replaces/, /delete what is there first/, /every instance it is replicated to/],
      de: [/ersetzt nie/, /Löschen Sie zuerst/, /jeder Instanz/],
      pl: [/niczego nie zastępuje/, /najpierw usuń/, /każdej instancji/],
    };
    for (const [lang, patterns] of Object.entries(statements)) {
      const words = locale(lang)['files.refusal.destination_exists']!;
      for (const pattern of patterns) expect(words, `${lang} ${pattern}`).toMatch(pattern);
    }
  });

  it('destination_held_after_move says in every locale that the server keeps retrying, and that deleting the holder and repeating the move finishes it', () => {
    const statements: Record<string, RegExp[]> = {
      en: [/\{\{heldBy\}\}/, /keeps retrying the move/, /Delete that file and repeat the move/],
      de: [/\{\{heldBy\}\}/, /versucht den Vorgang weiter/, /Löschen Sie diese Datei und wiederholen Sie das Verschieben/],
      pl: [/\{\{heldBy\}\}/, /ponawia przeniesienie/, /Usuń tamten plik i powtórz przeniesienie/],
    };
    for (const [lang, patterns] of Object.entries(statements)) {
      const words = locale(lang)['files.refusal.destination_held_after_move']!;
      for (const pattern of patterns) expect(words, `${lang} ${pattern}`).toMatch(pattern);
      expect(words, lang).not.toMatch(/on its own|von selbst|samo/);
    }
  });

  it('pl says a path holds something with "Pod", not "W"', () => {
    expect(locale('pl')['files.refusal.destination_exists']).toContain("Pod '{{path}}' już coś istnieje");
  });

  const held = () => throwError(() => answer(
    409, { error: 'server words', code: 'destination_held_after_move', path: 'b.txt', heldBy: 'other/c.txt' },
  ));

  it('destination_held_after_move names the held id and the file that holds it, and says the move finishes once that file is deleted', () => {
    const { c, toasts } = create({ moveFile: held });
    rename(c);
    expect(toasts.error).toEqual([said('destination_held_after_move', 'b.txt').replace('{{heldBy}}', 'other/c.txt')]);
    expect(toasts.error[0]).toContain('b.txt');
    expect(toasts.error[0]).toContain('other/c.txt');
    expect(toasts.error[0]).toMatch(/moved/);
    expect(toasts.error[0]).toMatch(/[Dd]elete that file/);
    expect(toasts.info).toEqual([]);
  });

  it('destination_held_after_move leaves edit mode, because the bytes did move', () => {
    const { c } = create({ moveFile: held });
    rename(c);
    expect(c.renamingEntry()).toBe('');
  });

  it('destination_held_after_move reloads the listing once, after the wait, like a move the server is finishing', () => {
    vi.useFakeTimers();
    const { c, listed } = create({ moveFile: held });
    rename(c);
    listed.length = 0;
    vi.advanceTimersByTime(4_999);
    expect(listed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(listed).toEqual(['/']);
    vi.advanceTimersByTime(60_000);
    expect(listed).toEqual(['/']);
  });

  it('a refusal that is not about a finished move keeps the row in edit mode and reloads nothing', () => {
    vi.useFakeTimers();
    const { c, listed } = create({
      moveFile: () => throwError(() => answer(409, { error: 'x', code: 'destination_exists', path: 'b.txt' })),
    });
    rename(c);
    listed.length = 0;
    vi.advanceTimersByTime(120_000);
    expect(listed).toEqual([]);
    expect(c.renamingEntry()).toBe('a.txt');
  });

  it('every refusal that tells the operator what to do stays until it is dismissed, and one that does not times out as usual', () => {
    const cases: [string, number, boolean][] = [
      ['path_blocked', 409, true], ['destination_exists', 409, true], ['destination_held_after_move', 409, true],
      ['act_not_recorded', 500, true], ['file_system_fault', 500, true],
      // A delete that needs the folder confirmation says what is now true ("this is a folder; delete it again"), and that
      // instruction stays until it is dismissed (Q-470).
      ['confirm_required', 422, true], ['space_root_refused', 400, false],
    ];
    for (const [code, status, sticky] of cases) {
      TestBed.resetTestingModule();
      const { c, toasts } = create({
        moveFile: () => throwError(() => answer(status, { error: 'server words', code, path: 'b.txt', heldBy: 'o.txt' })),
      });
      rename(c);
      expect(toasts.errorLifetimes, code).toEqual([sticky ? 0 : undefined]);
    }
  });

  it('a sentence the client has no words for, and the generic failure, time out as usual', () => {
    const { c, toasts } = create({
      moveFile: () => throwError(() => answer(409, { error: 'The server says why.', code: 'some_future_code' })),
    });
    rename(c);
    expect(toasts.errorLifetimes).toEqual([undefined]);
  });

  it('a refusal that is the server\'s own fault carries the request id the server logged it under, and a refusal the caller caused does not', () => {
    const { c, toasts } = create({
      moveFile: () => throwError(() => answer(500, { error: 'x', code: 'act_not_recorded', path: 'a.txt' }, { 'X-Request-Id': 'req-77' })),
    });
    rename(c);
    expect(toasts.error).toEqual([`${said('act_not_recorded', 'a.txt')} (request req-77)`]);
    TestBed.resetTestingModule();
    const again = create({
      moveFile: () => throwError(() => answer(409, { error: 'x', code: 'destination_exists', path: 'b.txt' }, { 'X-Request-Id': 'req-78' })),
    });
    rename(again.c);
    expect(again.toasts.error).toEqual([said('destination_exists', 'b.txt')]);
  });

  it('the remedy codes are all codes the server answers', () => {
    const codes = new Set(serverCodes());
    for (const code of FILE_REFUSALS_WITH_REMEDY) expect(codes.has(code), code).toBe(true);
  });

  it('the page words a refusal under the prefix the store names, never a literal copy of it', () => {
    const source = readFileSync(resolve(__dirname, 'file-manager.component.ts'), 'utf8');
    expect(source).not.toMatch(/['"`]files\.refusal\./);
  });

  it('confirm_required and space_root_refused each answer a delete in their own words', () => {
    for (const [code, status, path] of [['confirm_required', 422, 'docs'], ['space_root_refused', 400, '.']] as const) {
      TestBed.resetTestingModule();
      const { c, toasts } = create({
        deleteFile: () => throwError(() => answer(status, { error: 'server words', code, path })),
      });
      c.listing.remove(c.activeSpaceId(), path, '/');
      expect(toasts.error, code).toEqual([said(code, path)]);
      expect(toasts.error[0], code).not.toBe(en['files.error.deleteFailed']);
    }
  });

  it('act_not_recorded and file_system_fault each say their own sentence', () => {
    for (const code of ['act_not_recorded', 'file_system_fault']) {
      TestBed.resetTestingModule();
      const { c, toasts } = create({
        moveFile: () => throwError(() => answer(500, { error: 'server words', code, path: 'a.txt' })),
      });
      rename(c);
      expect(toasts.error, code).toEqual([said(code, 'a.txt')]);
    }
  });

  it('a code this client has no words for shows the server\'s own sentence', () => {
    const { c, toasts } = create({
      moveFile: () => throwError(() => answer(409, { error: 'The server says why.', code: 'some_future_code' })),
    });
    rename(c);
    expect(toasts.error).toEqual(['The server says why.']);
  });

  it('an answer with no body keeps the generic failure text', () => {
    const { c, toasts } = create({ moveFile: () => throwError(() => answer(0, null)) });
    rename(c);
    expect(toasts.error).toEqual([en['files.error.renameFailed']]);
  });

  it('a refused new folder and a refused delete read the same answer', async () => {
    const { c, toasts } = create({
      createDir: () => throwError(() => answer(409, { error: 'x', code: 'path_blocked', path: 'a.txt/new' })),
      deleteFile: () => throwError(() => answer(500, { error: 'x', code: 'act_not_recorded', path: 'a.txt' })),
    });
    c.showNewFolder.set(true);
    c.newFolderName.set('new');
    c.createFolder();
    c.listing.remove(c.activeSpaceId(), 'a.txt', '/');
    expect(toasts.error).toEqual([said('path_blocked', 'a.txt/new'), said('act_not_recorded', 'a.txt')]);
  });
});

describe('the Files page — a move the server is finishing is not a failure', () => {
  const owed = (retryAfter?: string) => () => throwError(() => answer(
    503, { error: 'not finished yet', code: 'move_still_owed', path: 'b.txt', retryable: true },
    retryAfter === undefined ? {} : { 'Retry-After': retryAfter },
  ));

  it('says so as information, never as the failure toast, and leaves edit mode', () => {
    const { c, toasts } = create({ moveFile: owed('5') });
    rename(c);
    expect(toasts.error).toEqual([]);
    expect(toasts.info).toEqual([said('move_still_owed', 'b.txt')]);
    expect(c.renamingEntry()).toBe('');
  });

  it('promises one reload after a wait, in every locale, because the store reloads once and not "when it is done"', () => {
    const once: Record<string, RegExp> = {
      en: /reloads once, after a short wait/,
      de: /einmal nach kurzer Wartezeit/,
      pl: /raz, po krótkim oczekiwaniu/,
    };
    for (const [lang, pattern] of Object.entries(once)) {
      expect(locale(lang)['files.refusal.move_still_owed'], lang).toMatch(pattern);
    }
  });

  it('reloads the listing once, after the seconds the server asked for, and not before', () => {
    vi.useFakeTimers();
    const { c, listed } = create({ moveFile: owed('7') });
    rename(c);
    listed.length = 0;
    vi.advanceTimersByTime(6_999);
    expect(listed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(listed).toEqual(['/']);
    vi.advanceTimersByTime(60_000);
    expect(listed).toEqual(['/']);
  });

  it('waits a default few seconds when the answer names none', () => {
    vi.useFakeTimers();
    const { c, listed } = create({ moveFile: owed() });
    rename(c);
    listed.length = 0;
    vi.advanceTimersByTime(5_000);
    expect(listed).toEqual(['/']);
  });

  it('does not pull the operator back to a folder they have left', () => {
    vi.useFakeTimers();
    const { c, listed } = create({ moveFile: owed('5') });
    rename(c);
    c.navigate('/elsewhere');
    listed.length = 0;
    vi.advanceTimersByTime(10_000);
    expect(listed).toEqual([]);
  });

  it('does not reload after the page is gone', () => {
    vi.useFakeTimers();
    const { c, listed } = create({ moveFile: owed('5') });
    rename(c);
    listed.length = 0;
    TestBed.resetTestingModule();
    vi.advanceTimersByTime(10_000);
    expect(listed).toEqual([]);
    void c;
  });
});

describe('every answer a file act can give has words in every locale', () => {
  /** The codes are read out of the module that defines them, so a new code cannot ship without its sentences. */
  const codes = serverCodes();

  it('the server module names the codes this page must answer', () => {
    expect(codes).toEqual(expect.arrayContaining(['path_blocked', 'move_still_owed', 'destination_exists']));
    expect(codes.length).toBeGreaterThanOrEqual(5);
  });

  it('a code the server no longer answers has no sentence left in any locale', () => {
    for (const lang of ['en', 'de', 'pl']) {
      const stale = Object.keys(locale(lang))
        .filter(key => key.startsWith('files.refusal.'))
        .filter(key => !codes.includes(key.slice('files.refusal.'.length)));
      expect(stale, lang).toEqual([]);
    }
  });

  for (const lang of ['en', 'de', 'pl']) {
    it(`${lang} has a sentence for each, and de and pl are translations rather than copies of en`, () => {
      const words = locale(lang);
      for (const code of codes) {
        const key = `files.refusal.${code}`;
        expect(words[key], `${lang} ${key}`).toBeTruthy();
        if (lang !== 'en') expect(words[key], `${lang} ${key}`).not.toBe(en[key]);
        const placeholders = (s: string) => (s.match(/\{\{\s*\w+\s*\}\}/g) ?? []).sort();
        expect(placeholders(words[key]!), `${lang} ${key} placeholders`).toEqual(placeholders(en[key]!));
      }
    });
  }
});
