/**
 * The import-conflict dialog shows a type's name as TEXT, never as markup.
 *
 * `spaces.schema.conflict.body` carries `<strong>` tags, so the dialog binds it with `[innerHTML]` - and Angular's sanitizer only strips
 * what is dangerous, it keeps `<b>`, `<i>`, `<a>` and the rest. The two values interpolated into it, the conflicting type's name and its
 * knowledge type, come from an IMPORTED schema file. A file naming a type `<b>x</b>` therefore rendered a bold "x" in the dialog (and a
 * name carrying an anchor or an image rendered that): markup from a file the operator was only asked to confirm. The name is HTML-escaped
 * before it enters the value, so what the operator sees is the characters the file contains.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { of } from 'rxjs';
import { TranslocoService } from '@jsverse/transloco';
import { dictionary } from '../../testing/i18n-dictionary';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { SpaceSchemaTabComponent } from './space-schema-tab.component';
import { SpaceSettingsState, emptyTypeSchemaState } from './space-settings-state.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { SchemaApi } from '../../core/schema-api.service';
import { ToastService } from '../../core/toast.service';

async function openConflict(name: string, kt: string): Promise<HTMLElement> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [SpaceSchemaTabComponent, getTranslocoModule({ translation: { en: dictionary('en') } })],
    providers: [
      SpaceSettingsState,
      { provide: SpacesApi, useValue: {} },
      { provide: ToastService, useValue: { show: () => {}, error: () => {}, success: () => {}, info: () => {} } },
      { provide: SchemaApi, useValue: { listSchemaLibrary: () => of({ entries: [] }), upsertSchemaLibraryEntry: () => of({ entry: {} }) } },
    ],
  });
  TestBed.inject(TranslocoService).setActiveLang('en');
  const fixture = TestBed.createComponent(SpaceSchemaTabComponent);
  fixture.componentInstance.importConflict.set({ kt: kt as never, name, state: emptyTypeSchemaState({}), allowAddAs: false });
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('the import-conflict dialog escapes what the imported file named (security lens S3)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('a type named "<b>x</b>" shows those characters and renders no <b> element', async () => {
    const root = await openConflict('<b>x</b>', 'entity');
    const body = [...root.querySelectorAll('p')].find(p => /already exists/.test(p.textContent ?? ''));
    expect(body, 'the conflict body is not rendered').toBeTruthy();
    expect(body!.querySelector('b'), 'markup in a type name was rendered as an element').toBeNull();
    expect(body!.textContent).toContain('<b>x</b>');
    // The translation's own emphasis is still markup: the escape applies to the parameters, not to the sentence.
    expect(body!.querySelectorAll('strong').length).toBeGreaterThanOrEqual(2);
  });

  it('a knowledge type carrying markup is shown as text too', async () => {
    const root = await openConflict('Service', '<i>kt</i>');
    const body = [...root.querySelectorAll('p')].find(p => /already exists/.test(p.textContent ?? ''));
    expect(body, 'the conflict body is not rendered').toBeTruthy();
    expect(body!.querySelector('i'), 'markup in a knowledge type was rendered as an element').toBeNull();
    expect(body!.textContent).toContain('<i>kt</i>');
  });

  it('an ordinary name is unchanged', async () => {
    const root = await openConflict('Service', 'entity');
    const body = [...root.querySelectorAll('p')].find(p => /already exists/.test(p.textContent ?? ''));
    // The knowledge type is named as its tab names it, not by its English id (bundle-164 verify drive).
    expect(body!.textContent).toContain('A type named Service already exists under Entities.');
  });
});
