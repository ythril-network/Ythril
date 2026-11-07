/**
 * What the Files page says when the server's storage failed while LISTING (`Q-538`).
 *
 * The server now answers a listing whose directory could not be read as `500 { error, code: 'file_system_fault', retryable: false }` instead of an
 * empty folder. The page's error state said the generic "Couldn't load files." for every failure; the sentence for THIS answer already ships
 * (`files.refusal.file_system_fault`, the one a failed rename shows) and says the thing the operator can act on: the server's storage failed, try
 * again, look at the server log. Real en.json, because the sentence the operator reads is what is pinned.
 *
 * Red against 0ac12bdd: the error state shows `files.error.loadFiles` for this answer.
 */
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { describe, it, expect, beforeEach } from 'vitest';
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

const en: Record<string, string> = JSON.parse(readFileSync(resolve(__dirname, '../../../../public/assets/i18n/en.json'), 'utf8'));

const answer = (status: number, body: unknown): HttpErrorResponse =>
  new HttpErrorResponse({ status, error: body, headers: new HttpHeaders() });

/** The page over an API whose listing fails with `failure`; returns what the page rendered once it settled. */
async function pageText(failure: HttpErrorResponse): Promise<string> {
  const api = {
    listSpaces: () => of({ spaces: [{ id: 'work', label: 'work' }] }),
    listFiles: () => throwError(() => failure),
    getFileDownloadUrl: () => of({ url: '' }),
    getFileExtract: () => of(null),
    getSpaceStats: () => of({ facts: 0, entities: 0, edges: 0, chrono: 0, files: 0 }),
    getSpaceMeta: () => of({ tagSuggestions: [], typeSchemas: {} }),
    getFileMeta: () => of(null),
  } as any;
  TestBed.configureTestingModule({
    imports: [FileManagerComponent, getTranslocoModule({ translation: { en } })],
    providers: [
      { provide: FilesApi, useValue: api },
      { provide: SpacesApi, useValue: api },
      { provide: BrainApi, useValue: api },
      { provide: AuthService, useValue: { token: () => 't' } },
      { provide: ToastService, useValue: { error: () => 0, info: () => 0, success: () => 0, show: () => 0 } },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } }, queryParamMap: of() } },
    ],
  });
  const fixture = TestBed.createComponent(FileManagerComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

beforeEach(() => TestBed.resetTestingModule());

describe('the Files page — a listing that fails says why', () => {
  it('a 500 file_system_fault shows files.refusal.file_system_fault, not the generic load error', async () => {
    const text = await pageText(answer(500, { error: 'server words', code: 'file_system_fault', retryable: false }));
    expect(text).toContain(en['files.refusal.file_system_fault']!.replace('{{path}}', ''));
    expect(text).not.toContain(en['files.error.loadFiles']!);
  });

  it('any other failure still shows the generic load error (the control)', async () => {
    const text = await pageText(answer(502, { error: 'bad gateway' }));
    expect(text).toContain(en['files.error.loadFiles']!);
  });
});
