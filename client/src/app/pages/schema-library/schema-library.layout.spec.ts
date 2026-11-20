/**
 * An entry card of the Schema Library page stays within the page at a phone's width, whatever its entry is called (bundle-269 browser
 * check, note 3).
 *
 * ## The defect it prevents
 *
 * At 390 px the page's main area scrolled sideways (scroll width 452): the card of an entry named `conversation.*` was 436 px wide. Three
 * rules of the page let one unbroken name push the card out. The entries sit in a grid whose one column is `auto`, and an `auto` track grows
 * to the widest content of its items, never below it; the title row is a flex row that does not wrap; and the name, one unbreakable word
 * in a monospace face, has nothing that lets it break.
 *
 * ## What it holds
 *
 * jsdom lays nothing out, so the rule is read from the CSS the component declares (`testing/declared-style.ts`): the grid's column may
 * shrink below its content (`minmax(0, ...)`), the title row wraps, and the name breaks inside a word (`overflow-wrap: anywhere`, the one
 * value that also lowers the box's minimum width) with no ellipsis, clamp or `nowrap` around it, so its whole text stays readable. The
 * width the page really has at 390 px is read in a browser, in the next drive.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { of } from 'rxjs';
import { type SchemaLibraryEntry } from '../../core/api.types';
import { AuthApi } from '../../core/auth-api.service';
import { SchemaApi } from '../../core/schema-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { ToastService } from '../../core/toast.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { declaredValue, truncationAround } from '../../testing/declared-style';
import { SchemaLibraryComponent } from './schema-library.component';

const LONG_NAME = 'conversation.' + 'participants-and-their-roles.'.repeat(3) + '*';
const ENTRY: SchemaLibraryEntry = {
  name: LONG_NAME,
  knowledgeType: 'entity',
  typeName: 'conversation',
  schema: { propertySchemas: { role: { type: 'string' } } } as SchemaLibraryEntry['schema'],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};

function mount(): HTMLElement {
  TestBed.configureTestingModule({
    imports: [SchemaLibraryComponent, getTranslocoModule()],
    providers: [
      { provide: SchemaApi, useValue: { listSchemaLibrary: () => of({ entries: [ENTRY] }), getSchemaLibraryUsages: () => of({ usages: [] }), getSchemaLibraryGroups: () => of({ groups: [] }) } },
      { provide: SpacesApi, useValue: { listSpaces: () => of({ spaces: [] }) } },
      { provide: AuthApi, useValue: {} },
      { provide: ToastService, useValue: { show: () => undefined, error: () => undefined, success: () => undefined, info: () => undefined } },
    ],
  });
  const fixture = TestBed.createComponent(SchemaLibraryComponent);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('an entry card of the schema library stays within the page whatever its entry is called', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('lets the grid column, the title row and the name give way to a long unbroken name', () => {
    const el = mount();
    const grid = el.querySelector('.entry-grid') as HTMLElement;
    const card = el.querySelector('.entry-card') as HTMLElement;
    const row = el.querySelector('.entry-title-row') as HTMLElement;
    const name = Array.from(el.querySelectorAll('.entry-name')).find(n => (n.textContent ?? '').includes(LONG_NAME)) as HTMLElement | undefined;
    expect(grid, 'the entry grid is not drawn').not.toBeNull();
    expect(card, 'the entry card is not drawn').not.toBeNull();
    expect(name, 'the long entry name is not on the page in full').toBeTruthy();

    expect(declaredValue(grid, 'grid-template-columns') ?? '', 'the grid column is `auto`: it grows to the widest card and the page scrolls sideways').toMatch(/minmax\(\s*0/);
    expect(declaredValue(row, 'flex-wrap') ?? '', 'the title row cannot wrap the name below its badge').toMatch(/^wrap/);
    expect(declaredValue(name!, 'overflow-wrap') ?? '', 'an unbroken name cannot break, so it sets the card\'s minimum width').toBe('anywhere');
    expect(truncationAround(name!, card), 'the name is cut off, so its full text is not reachable').toEqual([]);
  });
});
