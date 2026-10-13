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
import { FileManagerComponent } from './file-manager.component';

const I18N = resolve(__dirname, '../../../../public/assets/i18n');
const locale = (name: string): Record<string, string> =>
  JSON.parse(readFileSync(resolve(I18N, `${name}.json`), 'utf8'));
const en = locale('en');

/** What a code reads as in en with its path filled in — the sentence under test, taken from the file that ships. */
const said = (code: string, path?: string): string => en[`files.refusal.${code}`]!.replace('{{path}}', path ?? '');

/** A failed request as the HTTP client delivers it: the answer's body under `error`, its headers beside it. */
function answer(status: number, body: unknown, headers: Record<string, string> = {}): HttpErrorResponse {
  return new HttpErrorResponse({ status, error: body, headers: new HttpHeaders(headers) });
}

interface Toasts { error: string[]; info: string[]; success: string[] }

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
  const toasts: Toasts = { error: [], info: [], success: [] };
  TestBed.configureTestingModule({
    imports: [FileManagerComponent, getTranslocoModule({ translation: { en } })],
    providers: [
      { provide: FilesApi, useValue: api },
      { provide: SpacesApi, useValue: api },
      { provide: BrainApi, useValue: api },
      { provide: AuthService, useValue: { token: () => 't' } },
      { provide: ToastService, useValue: {
        error: (m: string) => toasts.error.push(m),
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

  it('destination_taken_by_other names the path and is not the generic failure', () => {
    const { c, toasts } = create({
      moveFile: () => throwError(() => answer(409, { error: 'server words', code: 'destination_taken_by_other', path: 'b.txt' })),
    });
    rename(c);
    expect(toasts.error).toEqual([said('destination_taken_by_other', 'b.txt')]);
    expect(toasts.error[0]).toContain('b.txt');
    expect(toasts.error[0]).not.toBe(en['files.error.renameFailed']);
  });

  it('destination_exists (a move onto something that is already there) names the path and moves nothing', () => {
    const { c, toasts } = create({
      moveFile: () => throwError(() => answer(409, { error: 'server words', code: 'destination_exists', path: 'b.txt' })),
    });
    rename(c);
    expect(toasts.error).toEqual([said('destination_exists', 'b.txt')]);
    expect(toasts.error[0]).toContain('b.txt');
    expect(toasts.info).toEqual([]);
    expect(c.renamingEntry()).toBe('a.txt');
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
  /**
   * The codes are read out of the module that defines them, so a new code cannot ship without its sentences.
   * `destination_exists` is named here as well because the server slice that introduces it lands apart from this
   * one; once that module names it the entry is a duplicate, which the filter absorbs.
   */
  const codes = [...readFileSync(
    resolve(__dirname, '../../../../../server/src/files/act-answers.ts'), 'utf8',
  ).matchAll(/code: '([a-z_]+)'/g)].map(m => m[1]!).concat('destination_exists').filter((v, i, all) => all.indexOf(v) === i);

  it('the server module names the codes this page must answer', () => {
    expect(codes).toEqual(expect.arrayContaining(['path_blocked', 'move_still_owed']));
    expect(codes.length).toBeGreaterThanOrEqual(5);
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
