/**
 * SchemaLibraryComponent — characterization for Q-92 point 11: exporting one library entry to a file.
 *
 * Pinned before the hand-written blob saves across the client are replaced by one shared download helper.
 * The export is LOCAL: the entry already on screen is serialised in the browser and no request is made. What
 * is pinned is what the user gets from the row's export button: the file's name, its type, its JSON, that
 * the blob URL is released, and that nothing is fetched or toasted along the way.
 *
 * The only other spec for this file (`schema-library.transform.spec.ts`) covers its pure import helpers, not
 * the component, which is why this one is new rather than an extension.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import { type SchemaLibraryEntry } from '../../core/api.types';
import { AuthApi } from '../../core/auth-api.service';
import { SchemaApi } from '../../core/schema-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { ToastService } from '../../core/toast.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { SchemaLibraryComponent } from './schema-library.component';

const ENTRY: SchemaLibraryEntry = {
  name: 'crm person',
  knowledgeType: 'entity',
  typeName: 'person',
  schema: { propertySchemas: { role: { type: 'string' } } } as SchemaLibraryEntry['schema'],
  description: 'A person in the CRM',
  schemaGroup: 'crm',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};

function stubSave() {
  const created: Blob[] = [];
  const revoked: string[] = [];
  const clicked: { href: string; download: string; revokedBeforeClick: boolean }[] = [];
  const had = { create: 'createObjectURL' in URL, revoke: 'revokeObjectURL' in URL };
  const prev = { create: (URL as any).createObjectURL, revoke: (URL as any).revokeObjectURL };
  (URL as any).createObjectURL = (b: Blob) => { created.push(b); return 'blob:lib-' + created.length; };
  (URL as any).revokeObjectURL = (u: string) => { revoked.push(u); };
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    const href = this.getAttribute('href') ?? '';
    clicked.push({ href, download: this.download, revokedBeforeClick: revoked.includes(href) });
  });
  const restore = () => {
    click.mockRestore();
    if (had.create) (URL as any).createObjectURL = prev.create; else delete (URL as any).createObjectURL;
    if (had.revoke) (URL as any).revokeObjectURL = prev.revoke; else delete (URL as any).revokeObjectURL;
  };
  return { created, revoked, clicked, restore };
}

const blobText = (b: Blob) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result));
  r.onerror = () => rej(r.error);
  r.readAsText(b);
});

function create() {
  const toasts: string[] = [];
  const schemaApi = {
    listSchemaLibrary: vi.fn(() => of({ entries: [ENTRY] })),
    getSchemaLibraryUsages: vi.fn(() => of({ usages: [] })),
  };
  TestBed.configureTestingModule({
    imports: [SchemaLibraryComponent, getTranslocoModule()],
    providers: [
      { provide: SchemaApi, useValue: schemaApi },
      { provide: SpacesApi, useValue: { listSpaces: () => of({ spaces: [] }) } },
      { provide: AuthApi, useValue: {} },
      { provide: ToastService, useValue: {
        show: (m: string) => toasts.push(m), error: (m: string) => toasts.push(m),
        success: (m: string) => toasts.push(m), info: (m: string) => toasts.push(m),
      } },
    ],
  });
  const fixture = TestBed.createComponent(SchemaLibraryComponent);
  fixture.detectChanges();
  return { fixture, toasts, schemaApi };
}

describe('SchemaLibraryComponent — usage counts arrive with the list (Q-112)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('makes no per-entry request, and shows the count the list carried', () => {
    const { fixture, schemaApi } = create();
    schemaApi.listSchemaLibrary.mockReturnValue(of({ entries: [ENTRY], usageCounts: { [ENTRY.name]: 3 } }) as never);
    (fixture.componentInstance as any).load();
    fixture.detectChanges();
    // The page opened once on construction and once here: neither may fan out one /usages request per entry.
    expect(schemaApi.getSchemaLibraryUsages, 'a /usages request per entry').not.toHaveBeenCalled();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('3');
    expect((fixture.componentInstance as any).usageCounts()[ENTRY.name]).toBe(3);
  });
});

describe('SchemaLibraryComponent — exporting an entry (characterization for Q-92)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('the row export button saves application/json named schema-library_<name>.json holding the entry', async () => {
    const s = stubSave();
    try {
      const { fixture, toasts, schemaApi } = create();
      const btn = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('button[title="schemaLib.export.title"]');
      expect(btn, 'the row export button renders').toBeTruthy();
      const requestsBefore = schemaApi.listSchemaLibrary.mock.calls.length + schemaApi.getSchemaLibraryUsages.mock.calls.length;
      btn!.click();

      expect(s.created).toHaveLength(1);
      expect(s.created[0].type).toBe('application/json');
      expect(await blobText(s.created[0])).toBe(JSON.stringify(ENTRY, null, 2));
      // The name is used verbatim, spaces and all.
      expect(s.clicked).toEqual([{ href: 'blob:lib-1', download: 'schema-library_crm person.json', revokedBeforeClick: false }]);
      // AS-IS: revoked synchronously straight after the click.
      expect(s.revoked).toEqual(['blob:lib-1']);
      // Local: exporting makes no request and says nothing.
      expect(schemaApi.listSchemaLibrary.mock.calls.length + schemaApi.getSchemaLibraryUsages.mock.calls.length).toBe(requestsBefore);
      expect(toasts).toEqual([]);
    } finally {
      s.restore();
    }
  });
});
