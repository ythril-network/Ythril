/**
 * What the Files page says when the listing's metadata could not be read (Q-341, bundle-70 S3).
 *
 * The server lists the files and names a failed metadata read in `metadataIncomplete`. Without a line the operator reads a bare row as "nothing
 * has been processed yet". The page shows ONE line, `role="status"` so a screen reader says it, only while the listing says so, in the page's
 * language: the key `files.metadataIncomplete` exists in en, de and pl. Real translation files, because the sentence the operator reads is
 * what is pinned.
 *
 * Red against 8ee92312: the service drops the field and the page renders no such line; the three files carry no such key.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { of } from 'rxjs';
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

const KEY = 'files.metadataIncomplete';
const i18n = (lang: string): Record<string, string> =>
  JSON.parse(readFileSync(resolve(__dirname, `../../../../public/assets/i18n/${lang}.json`), 'utf8'));
const en = i18n('en');

/** The page over a listing that answers `listing`; the elements with `role="status"` it rendered once it settled. */
async function statusLines(listing: { entries: unknown[]; metadataIncomplete?: string[] }): Promise<string[]> {
  const api = {
    listSpaces: () => of({ spaces: [{ id: 'work', label: 'work' }] }),
    listFiles: () => of(listing),
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
  return [...(fixture.nativeElement as HTMLElement).querySelectorAll('[role="status"]')].map(e => (e.textContent ?? '').trim());
}

const FILES = [{ name: 'a.txt', size: 3, isFile: true, isDirectory: false, modified: '2026-09-01T00:00:00.000Z' }];

beforeEach(() => TestBed.resetTestingModule());

describe('the Files tab says when file details could not be loaded', () => {
  it('shows exactly one role=status line with the key\'s sentence, however many reasons the listing names', async () => {
    const lines = await statusLines({ entries: FILES, metadataIncomplete: ['store-unavailable', 'unreadable'] });
    expect(en[KEY], `${KEY} is not in en.json`).toBeTruthy();
    expect(lines.filter(l => l.includes(en[KEY]!))).toHaveLength(1);
  });

  it('the line does not name the reasons: they are for the log, the page says one sentence', async () => {
    const lines = await statusLines({ entries: FILES, metadataIncomplete: ['store-unavailable'] });
    const line = lines.find(l => l.includes(en[KEY] ?? '\u0000'));
    expect(line, 'no role=status line carries the sentence').toBeDefined();
    expect(line).not.toContain('store-unavailable');
  });

  it('shows no such line when the listing is whole (the control)', async () => {
    const lines = await statusLines({ entries: FILES });
    expect(lines.filter(l => l.includes(en[KEY] ?? '\u0000'))).toHaveLength(0);
  });
});

describe('the sentence exists in every language the client ships', () => {
  for (const lang of ['en', 'de', 'pl']) {
    it(`${lang}.json has ${KEY}`, () => {
      const text = i18n(lang)[KEY];
      expect(typeof text).toBe('string');
      expect((text ?? '').trim().length).toBeGreaterThan(10);
    });
  }

  it('de and pl are translated, not a copy of the English sentence', () => {
    expect(i18n('de')[KEY]).not.toBe(en[KEY]);
    expect(i18n('pl')[KEY]).not.toBe(en[KEY]);
  });
});
