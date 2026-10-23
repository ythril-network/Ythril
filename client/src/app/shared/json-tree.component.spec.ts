/**
 * The JSON tree renders what you can SEE, and a collapsed container costs one row.
 *
 * ## What these pin
 *
 * The point of the component is that a recall answer of tens of thousands of characters stays usable. That
 * is a performance property expressed as a rendering rule — walk only into what is open — and it is
 * invisible in a screenshot: a version that builds every row and hides the closed ones looks identical and
 * falls over on the answer this panel exists to inspect.
 *
 * So the assertions are on the ROW LIST rather than on the DOM. A row is what costs something.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect } from 'vitest';
import { TranslocoService } from '@jsverse/transloco';
import { JsonTreeComponent } from './json-tree.component';
import { dictionary } from '../testing/i18n-dictionary';
import { getTranslocoModule } from '../testing/transloco-testing';

/** Real dictionaries: what a closed container says beside its size is a VALUE of the dictionary, and echoed keys cannot show it. */
function mount(value: unknown, openTo = 1, language: 'en' | 'pl' = 'en') {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [
      JsonTreeComponent,
      getTranslocoModule({
        langs: { en: dictionary('en'), pl: dictionary('pl') },
        translocoConfig: { availableLangs: ['en', 'pl'], defaultLang: 'en' },
      }),
    ],
  });
  TestBed.inject(TranslocoService).setActiveLang(language);
  const fixture = TestBed.createComponent(JsonTreeComponent);
  fixture.componentRef.setInput('value', value);
  fixture.componentRef.setInput('openTo', openTo);
  fixture.detectChanges();
  return fixture;
}

const paths = (fixture: { componentInstance: JsonTreeComponent }) =>
  fixture.componentInstance.rows().map(r => r.path);

describe('a collapsed container costs one row', () => {
  it('does not walk into what is closed, however big it is', () => {
    // A hundred elements behind a closed caret must not be a hundred rows. This is the whole reason the
    // rows are computed from the open set rather than filtered after the fact.
    const big = { items: Array.from({ length: 100 }, (_, i) => ({ id: i, nested: { deep: true } })) };
    const fixture = mount(big, 1);

    const rows = fixture.componentInstance.rows();
    const items = rows.find(r => r.key === 'items');
    expect(items, 'the array row is missing').toBeTruthy();
    expect(items!.open, 'depth 1 is past openTo 1, so the array starts closed').toBe(false);
    expect(items!.size, 'a closed container still reports what is inside it').toBe(100);
    expect(rows.length, `100 elements behind a closed caret produced ${rows.length} rows`).toBeLessThan(6);
  });

  it('and opening one level adds that level only', () => {
    const fixture = mount({ a: { b: { c: { d: 1 } } } }, 1);
    const before = paths(fixture).length;

    const a = fixture.componentInstance.rows().find(r => r.key === 'a')!;
    fixture.componentInstance.toggle(a);
    fixture.detectChanges();

    const after = fixture.componentInstance.rows();
    expect(after.some(r => r.key === 'b'), 'opening `a` did not reveal `b`').toBe(true);
    expect(after.some(r => r.key === 'c'), 'opening `a` revealed `c` two levels down').toBe(false);
    expect(after.length).toBeGreaterThan(before);
  });
});

describe('what a row says about itself', () => {
  // The size is a counted phrase ("3 items"), so it goes through the plural mechanism and is read where the reader reads it: the
  // rendered row. It used to be `{{ r.size }} {{ label(r) }}` with English 'item'/'items'/'key'/'keys' hard-coded in the component, so
  // a Polish reader saw English nouns on a Polish page, and Polish's three plural forms were out of reach.
  const sizes = (fixture: { nativeElement: unknown }): string[] =>
    [...(fixture.nativeElement as HTMLElement).querySelectorAll('.jt-size')].map(el => (el.textContent ?? '').replace(/\s+/g, ' ').trim());

  it('en: names the size in the unit of the container, and one element is not "1 items"', () => {
    const fixture = mount({ list: [1, 2, 3], one: [1], bag: { x: 1, y: 2 }, single: { x: 1 } }, 1);
    expect(sizes(fixture)).toEqual(['3 items', '1 item', '2 keys', '1 key']);
  });

  const rendered = (value: unknown) => sizes(mount({ c: value }, 1, 'pl'))[0]!;
  const noun = (text: string) => text.replace(/^\d+\s+/, '');
  for (const [label, make] of [
    ['array (item)', (n: number) => Array.from({ length: n }, (_, i) => i)],
    ['object (key)', (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]))],
  ] as const) {
    it(`pl: the size of an ${label} renders through the Polish plural forms`, () => {
      const one = rendered(make(1));
      const few = rendered(make(2));
      const many = rendered(make(5));
      expect(one, `${label}: the count leads the phrase`).toMatch(/^1\s+\S/);
      expect(few).toMatch(/^2\s+\S/);
      expect(many).toMatch(/^5\s+\S/);
      // One word per category, not one word for every count: Polish has one, few and many.
      expect(new Set([noun(one), noun(few), noun(many)]).size, `${label}: pl one/few/many read ${JSON.stringify([one, few, many])}`).toBe(3);
      // And not the English noun the component used to hard-code.
      for (const text of [one, few, many]) expect(text, `${label}: English noun on a Polish page`).not.toMatch(/\b(items?|keys?)\b/);
    });
  }

  it('quotes a string and leaves everything else bare, so the types are readable', () => {
    const fixture = mount({ s: 'x', n: 4, b: false, z: null }, 2);
    const text = (key: string) => fixture.componentInstance.rows().find(r => r.key === key)!.text;
    expect(text('s')).toBe('"x"');
    expect(text('n')).toBe('4');
    expect(text('b')).toBe('false');
    expect(text('z')).toBe('null');
  });

  it('an empty object still draws itself; an absent value does not', () => {
    // The distinction a reader needs: `{}` came back and is empty, versus nothing came back at all.
    expect(mount({}, 1).componentInstance.rows().length).toBe(1);
    expect(mount(null, 1).componentInstance.rows().length).toBe(0);
    expect(mount(undefined, 1).componentInstance.rows().length).toBe(0);
  });
});

describe('expand and collapse all', () => {
  it('collapseAll closes what openTo had opened', () => {
    const fixture = mount({ a: { b: 1 } }, 5);
    expect(fixture.componentInstance.rows().some(r => r.key === 'b')).toBe(true);

    fixture.componentInstance.collapseAll();
    fixture.detectChanges();
    expect(fixture.componentInstance.rows().some(r => r.key === 'b'),
      'collapseAll left a nested key visible').toBe(false);
  });

  it('expandAll reaches a subtree nobody has opened by hand', () => {
    /*
     * The case a set-of-open-paths implementation gets wrong: the deep node has never been rendered, so
     * there is no path to add to the set. Applying a floor instead means it opens on the way down.
     */
    const fixture = mount({ a: { b: { c: { d: 'found' } } } }, 1);
    fixture.componentInstance.expandAll();
    fixture.detectChanges();
    expect(fixture.componentInstance.rows().some(r => r.text === '"found"'),
      'expandAll did not reach a node that had never been built').toBe(true);
  });

  it('a reader decision after expandAll still wins', () => {
    const fixture = mount({ a: { b: 1 } }, 1);
    fixture.componentInstance.expandAll();
    fixture.detectChanges();

    const a = fixture.componentInstance.rows().find(r => r.key === 'a')!;
    fixture.componentInstance.toggle(a);
    fixture.detectChanges();
    expect(fixture.componentInstance.rows().some(r => r.key === 'b'),
      'closing a node after expandAll did nothing — the floor is overriding the reader').toBe(false);
  });
});
