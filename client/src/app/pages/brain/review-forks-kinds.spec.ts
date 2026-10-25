/**
 * Review's Forks section shows every kind of fork, behind a segmented kind switch (Q-624, design rev 4 sections 11 and 9a; layout B of the
 * kind-switch mockup, chosen by the owner 2026-10-25; screenshots `variant-b-*` of the mockup).
 *
 * ## What the design and the green-lit mockup bind
 *
 * - **A segmented control above the list** (`role="radiogroup"`, one `role="radio"` per kind: Facts, Entities, Chrono, Edges: the names of the Brain tabs, `brain.tab.*`), each
 *   showing its count. It is a ROVING group: the checked radio is the one tab stop, the arrow keys (and Home and End) move AND select, and focus
 *   follows the selection.
 * - **The diff runs on the kind's main field** and every other differing field gets its own line of marks; both are read from the answer's
 *   `kinds` (`{ [kind]: { fields, mainField } }`), so the client holds no field list of its own.
 * - **Below 40% shared words the main text is not interleaved**: the other text is struck and this text underlined, each WHOLE (the mockup's
 *   `diffHtml`: `common / max(words of a, words of b) < 0.4`). At 40% or above the shared words stay in place.
 * - **An empty kind** says so and offers the first other kind that has forks ("Show Facts (2)"); choosing it selects that kind and moves focus to
 *   its radio. When no kind has forks there is nothing to offer.
 * - **An orphaned row** (its parent was deleted) shows the fork alone, marked "Original deleted", with the actions "Keep this version" and
 *   "Let the deletion stand".
 * - **A row resolved elsewhere** (section 9a) carries one line per entry under the pair: "Resolved on A, kept the original" / "kept this version" /
 *   "waiting for A's version", or "reported by B as resolved on A" for an unproven entry; and the confirm of "Keep this version" says it overrides
 *   A's choice on every instance.
 *
 * ## The API this spec assumes, because the design names no input
 *
 * `ReviewForksComponent` takes `rows` (the list answer's rows: `{ kind, forkId, parentId, fork, parent | null, orphaned, edgeCount, linkCount,
 * siblings, resolvedElsewhere }`), `counts` (the answer's `{ fact, entity, chrono, edge }`) and `kinds` (the answer's per-kind `fields` and
 * `mainField`), and it holds the selected kind itself, showing the rows of that kind. It emits `resolve` with at least `{ forkId, keep }`. A row's
 * version carries its `seq`. If the build names an input differently, `make()` is the line to change; the rules stay. The marks of one row sit in
 * `[data-forks-text]` (the main field) and its other fields in `dl` lines, as the layout-3 spec already assumed.
 *
 * ## Seen red
 *
 * Red on b857da8f: the component has no `counts` or `kinds` input and no kind switch; see the report for the failing lines.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { dictionary } from '../../testing/i18n-dictionary';
import { ReviewForksComponent } from './review-forks.component';

type Row = Record<string, any>;
const KIND_ORDER = ['fact', 'entity', 'chrono', 'edge'] as const;
type Kind = (typeof KIND_ORDER)[number];

/** The answer's `kinds`: BODY_FIELDS_OF (the main field among them) and the main field, per kind. Shaped as the design's section 10 says. */
const KINDS: Record<Kind, { fields: string[]; mainField: string }> = {
  fact: { fields: ['fact', 'type', 'description', 'tags', 'linkEntities'], mainField: 'fact' },
  entity: { fields: ['name', 'type', 'description', 'tags'], mainField: 'name' },
  chrono: { fields: ['title', 'type', 'start', 'end', 'description', 'tags'], mainField: 'title' },
  edge: { fields: ['description', 'weight'], mainField: 'description' },
};

const author = (label: string) => ({ instanceId: label.toLowerCase(), instanceLabel: label });
const stamp = (who: string) => ({ author: author(who), updatedAt: '2026-10-20T10:00:00.000Z' });

/** A row of `kind` whose main field differs; `fork` and `parent` override the versions' own fields. */
function row(kind: Kind, id: string, fork: Row = {}, parent: Row = {}, over: Row = {}): Row {
  const main = KINDS[kind].mainField;
  const base = (who: string, text: string, seq: number): Row => ({ _id: '', tags: [] as string[], properties: {}, seq, [main]: text, ...stamp(who) });
  return {
    kind, forkId: `fork-${id}`, parentId: `parent-${id}`,
    fork: { ...base('Berlin', 'closes at 17:30 on weekdays', 7), _id: `fork-${id}`, ...fork },
    parent: { ...base('Gdansk', 'closes at 18:00 on weekdays', 9), _id: `parent-${id}`, ...parent },
    orphaned: false, edgeCount: 0, linkCount: 0, siblings: 1, resolvedElsewhere: [],
    ...over,
  };
}

const tree = (locale: string): Record<string, any> => {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(dictionary(locale))) {
    if (!key.startsWith('brain.review.forks.') && !key.startsWith('brain.tab.')) continue;
    let node = out;
    const parts = key.split('.');
    parts.slice(0, -1).forEach(p => { node = node[p] ??= {}; });
    node[parts.at(-1)!] = value;
  }
  return out;
};

/** Counts of the rows given, per kind, unless `counts` says otherwise. */
function make(rows: Row[], counts?: Partial<Record<Kind, number>>) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [ReviewForksComponent, getTranslocoModule({ translation: { en: tree('en') } })] });
  const fixture = TestBed.createComponent(ReviewForksComponent);
  const derived = Object.fromEntries(KIND_ORDER.map(k => [k, rows.filter(r => r['kind'] === k).length])) as Record<Kind, number>;
  fixture.componentRef.setInput('rows', rows);
  fixture.componentRef.setInput('counts', { ...derived, ...counts });
  fixture.componentRef.setInput('kinds', KINDS);
  document.body.appendChild(fixture.nativeElement); // focus only means something on an attached element
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const radios = () => [...el.querySelectorAll<HTMLElement>('[role="radiogroup"] [role="radio"]')];
  const radio = (kind: Kind) => radios()[KIND_ORDER.indexOf(kind)]!;
  const items = () => [...el.querySelectorAll('li')].filter(li => li.querySelector('article'));
  const key = (target: HTMLElement, name: string) => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    fixture.detectChanges();
  };
  const click = (target: Element | undefined) => { (target as HTMLElement).click(); fixture.detectChanges(); };
  const button = (re: RegExp, within: ParentNode = el) => [...within.querySelectorAll('button')].find(b => re.test(b.textContent ?? ''));
  return { fixture, el, radios, radio, items, key, click, button };
}

describe('the kind switch of the Forks section (layout B)', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => document.body.replaceChildren());

  it('is a radio group of the four kinds in the design\'s order, each with its count', () => {
    const { el, radios } = make([row('fact', '1'), row('fact', '2'), row('fact', '3'), row('edge', '4')]);
    expect(el.querySelectorAll('[role="radiogroup"]').length).toBe(1);
    const group = radios();
    expect(group.length).toBe(KIND_ORDER.length);
    expect(group.map(r => r.textContent!.trim())).toEqual([expect.stringMatching(/Facts\s*3/), expect.stringMatching(/Entities\s*0/),
      expect.stringMatching(/Chrono\s*0/), expect.stringMatching(/Edges\s*1/)]);
    // The accessible name says the number in words ("Facts, 3 forks"), as the mockup's `kindCount` does.
    expect(group[0]!.getAttribute('aria-label')).toMatch(/Facts, 3 forks/);
    expect(group[3]!.getAttribute('aria-label')).toMatch(/Edges, 1 fork\b/);
    expect(el.querySelector('[role="radiogroup"]')!.getAttribute('aria-label')).toBeTruthy();
  });

  it('starts on the first kind that has forks, and shows only that kind\'s rows', () => {
    const { radios, items } = make([row('entity', 'e1'), row('entity', 'e2'), row('edge', 'g1')]);
    expect(radios().map(r => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', 'false']);
    expect(items().length).toBe(2);
    expect(items().every(li => /fork-e[12]/.test(li.querySelector('.fk-id')?.getAttribute('title') ?? ''))).toBe(true);
  });

  it('choosing a kind shows that kind\'s rows and no other', () => {
    const { radio, radios, items, click } = make([row('fact', 'f1'), row('edge', 'g1'), row('edge', 'g2')]);
    expect(items().length).toBe(1);
    click(radio('edge'));
    expect(radios().map(r => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false', 'true']);
    expect(items().length).toBe(2);
  });

  it('is a roving group: the checked radio is the one tab stop', () => {
    const { radio, radios, click } = make([row('fact', 'f1'), row('chrono', 'c1')]);
    expect(radios().map(r => r.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1']);
    click(radio('chrono'));
    expect(radios().map(r => r.getAttribute('tabindex'))).toEqual(['-1', '-1', '0', '-1']);
  });

  it('the arrow keys move AND select, wrap at both ends, and focus follows the selection', () => {
    const { radio, radios, key, fixture } = make([row('fact', 'f1'), row('edge', 'g1')]);
    radio('fact').focus();
    key(radio('fact'), 'ArrowRight');
    expect(radios().map(r => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', 'false']);
    expect(document.activeElement).toBe(radio('entity'));
    key(radio('entity'), 'ArrowLeft');
    key(radio('fact'), 'ArrowLeft'); // wraps to the last
    expect(radio('edge').getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(radio('edge'));
    key(radio('edge'), 'ArrowDown'); // down is right, and wraps to the first
    expect(radio('fact').getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(radio('fact'));
    key(radio('fact'), 'End');
    expect(document.activeElement).toBe(radio('edge'));
    key(radio('edge'), 'Home');
    expect(document.activeElement).toBe(radio('fact'));
    fixture.detectChanges();
    expect(radios().filter(r => r.getAttribute('aria-checked') === 'true').length).toBe(1);
  });

  it('a key that is not an arrow changes nothing', () => {
    const { radio, radios, key } = make([row('fact', 'f1')]);
    radio('fact').focus();
    key(radio('fact'), 'a');
    expect(radios().map(r => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false']);
  });
});

describe('an empty kind', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => document.body.replaceChildren());

  it('says nothing is to be reviewed there, and offers the first other kind that has forks', () => {
    const { el, radio, click, button, items } = make([row('fact', 'f1'), row('fact', 'f2'), row('edge', 'g1')]);
    click(radio('chrono'));
    expect(items().length).toBe(0);
    expect(el.textContent).toMatch(/Nothing to review in Chrono/i);
    expect(button(/Show Facts \(2\)/i), 'the offer names the next non-empty kind and its count').toBeTruthy();
    expect(button(/Show Edges/i)).toBeUndefined();
  });

  it('skips itself: with forks only in Edges, an empty Entities offers Edges', () => {
    const { radio, click, button } = make([row('edge', 'g1')]);
    click(radio('entity'));
    expect(button(/Show Edges \(1\)/i)).toBeTruthy();
  });

  it('choosing the offer selects that kind, shows its rows and puts focus on its radio', () => {
    const { radio, radios, click, button, items } = make([row('fact', 'f1'), row('fact', 'f2')]);
    click(radio('entity'));
    click(button(/Show Facts \(2\)/i));
    expect(radios().map(r => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false']);
    expect(items().length).toBe(2);
    expect(document.activeElement).toBe(radio('fact'));
  });

  it('an empty kind stays selectable, and offers nothing when no kind has forks', () => {
    const { el, radio, click, button } = make([], { fact: 0, entity: 0, chrono: 0, edge: 0 });
    expect(radio('entity').hasAttribute('disabled')).toBe(false);
    click(radio('entity'));
    expect(button(/^\s*Show /i)).toBeUndefined();
    expect(el.querySelectorAll('li').length).toBe(0);
  });
});

describe('the diff reads the kind\'s own fields', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => document.body.replaceChildren());

  const rowText = (el: HTMLElement) => (el.querySelector('article') as HTMLElement).textContent ?? '';

  it('an entity is marked on its name, and a property that differs has its own line', () => {
    const { el } = make([row('entity', 'e1',
      { name: 'Hamburg Logistik GmbH', properties: { country: 'DE', tier: 'preferred' } },
      { name: 'Hamburg Logistics GmbH', properties: { country: 'DE', tier: 'standard' } })]);
    const main = el.querySelector('.l3-text, [data-forks-text]') as HTMLElement;
    expect(main.querySelector('ins')!.textContent).toContain('Logistik');
    expect(main.querySelector('del')!.textContent).toContain('Logistics');
    const keys = [...el.querySelectorAll('dt')].map(dt => dt.textContent!.trim());
    expect(keys).toContain('properties.tier');
    expect(keys, 'a field that is the same is not a line of marks').not.toContain('properties.country');
    expect(keys, 'an entity has no fact field').not.toContain('fact');
    const line = [...el.querySelectorAll('dl > div')].find(d => d.querySelector('dt')?.textContent?.trim() === 'properties.tier')!;
    expect(line.querySelector('ins')!.textContent).toContain('preferred');
    expect(line.querySelector('del')!.textContent).toContain('standard');
  });

  it('a chrono entry is marked on its title, and its dates are lines of their own', () => {
    const { el } = make([row('chrono', 'c1', { title: 'Quarterly data protection review', start: '2026-11-19' },
      { title: 'Quarterly privacy review', start: '2026-11-12' })]);
    const main = el.querySelector('.l3-text, [data-forks-text]') as HTMLElement;
    expect(main.querySelector('ins')!.textContent).toContain('data protection');
    expect(main.querySelector('del')!.textContent).toContain('privacy');
    const keys = [...el.querySelectorAll('dt')].map(dt => dt.textContent!.trim());
    expect(keys).toContain('start');
    expect(keys).not.toContain('end');
  });

  it('an edge is marked on its description, and its weight has a line of its own', () => {
    const { el } = make([row('edge', 'g1', { description: 'Twice-weekly deliveries on Tuesdays and Fridays.', weight: 0.9, from: 'Hamburg', label: 'supplies', to: 'Berlin' },
      { description: 'Weekly deliveries on Tuesdays.', weight: 1, from: 'Hamburg', label: 'supplies', to: 'Berlin' })]);
    const main = el.querySelector('.l3-text, [data-forks-text]') as HTMLElement;
    expect(main.querySelector('ins')).toBeTruthy();
    expect(main.querySelector('del')).toBeTruthy();
    const keys = [...el.querySelectorAll('dt')].map(dt => dt.textContent!.trim());
    expect(keys).toContain('weight');
    expect(rowText(el)).toContain('0.9');
  });

  it('takes the fields from the answer: a kind whose answer lists no `tags` shows no tags line, whatever the versions hold', () => {
    const { el } = make([row('edge', 'g1', { description: 'one two', weight: 1, tags: ['x'] }, { description: 'one three', weight: 1, tags: ['y'] })]);
    expect([...el.querySelectorAll('dt')].map(dt => dt.textContent!.trim())).not.toContain('tags');
  });
});

describe('below 40% shared words the main text is struck and underlined whole', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => document.body.replaceChildren());

  const marks = (a: string, b: string) => {
    const { el } = make([row('fact', 'f1', { fact: a }, { fact: b })]);
    const main = el.querySelector('.l3-text, [data-forks-text]') as HTMLElement;
    return { main, ins: [...main.querySelectorAll('ins')], del: [...main.querySelectorAll('del')] };
  };

  it('keeps the shared words in place when 40% or more are shared (2 of 5)', () => {
    const { main, del, ins } = marks('alpha beta gamma delta epsilon', 'alpha beta zeta eta theta');
    expect(del.map(d => d.textContent).join('')).not.toContain('alpha');
    expect(ins.map(i => i.textContent).join('')).not.toContain('alpha');
    expect(main.textContent).toContain('alpha beta');
  });

  it('writes the whole other text struck, then the whole of this one underlined, when fewer than 40% are shared (2 of 6)', () => {
    const { main, del, ins } = marks('alpha beta c1 c2 c3 c4', 'alpha beta d1 d2 d3 d4');
    expect(del.length).toBe(1);
    expect(ins.length).toBe(1);
    expect(del[0]!.textContent).toContain('alpha beta d1 d2 d3 d4');
    expect(ins[0]!.textContent).toContain('alpha beta c1 c2 c3 c4');
    expect(main.innerHTML.indexOf('<del'), 'the struck text reads first').toBeLessThan(main.innerHTML.indexOf('<ins'));
    expect(main.textContent!.replace(/Only in (this|the other) version:\s*/gi, '').replace(/\s+/g, ' ').trim())
      .toBe('alpha beta d1 d2 d3 d4 alpha beta c1 c2 c3 c4');
  });

  it('the whole-text marks still carry the screen-reader prefix of every mark', () => {
    const { del, ins } = marks('alpha beta c1 c2 c3 c4', 'alpha beta d1 d2 d3 d4');
    expect(del[0]!.textContent, 'the marks are the whole-text ones, not interleaved ones').toContain('alpha beta d1');
    expect(del[0]!.querySelector('.sr-only, .visually-hidden')!.textContent).toMatch(/Only in the other version/i);
    expect(ins[0]!.querySelector('.sr-only, .visually-hidden')!.textContent).toMatch(/Only in this version/i);
  });

  it('two equal main texts are not marked at all', () => {
    const { del, ins } = marks('same words here', 'same words here');
    expect(del.length + ins.length).toBe(0);
  });
});

describe('an orphaned row (its parent was deleted)', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => document.body.replaceChildren());

  const orphan = () => row('entity', 'o1', { name: 'Kestrel Analytics Ltd', properties: { tier: 'trial' } }, {}, { parent: null, orphaned: true });

  it('shows the fork alone with the parent marked deleted, and no comparison to make', () => {
    const { el } = make([orphan()]);
    expect(el.textContent).toMatch(/Original deleted/i);
    expect(el.textContent).toContain('Kestrel Analytics Ltd');
    expect(el.querySelector('ins, del'), 'there is nothing to compare with').toBeNull();
    expect(el.querySelector('details'), 'there is no second version to show in full').toBeNull();
  });

  it('offers "Keep this version" and "Let the deletion stand", and no other action', () => {
    const { el, button } = make([orphan()]);
    expect(button(/keep this version/i)).toBeTruthy();
    expect(button(/let the deletion stand/i)).toBeTruthy();
    expect(button(/keep the other version/i)).toBeUndefined();
    expect([...el.querySelectorAll('article button')].length).toBe(2);
  });

  it('resolves the fork with `fork` for the first and `parent` for the deletion standing, after a confirmation each', () => {
    const { fixture, el, click, button } = make([orphan()]);
    const resolved = vi.fn();
    fixture.componentInstance.resolve.subscribe(resolved);
    const confirmWith = (re: RegExp) => {
      const dialog = el.querySelector('[role="alertdialog"], [role="dialog"]') as HTMLElement;
      expect(dialog, 'no confirmation').toBeTruthy();
      click(button(re, dialog));
    };
    click(button(/let the deletion stand/i));
    expect(resolved).not.toHaveBeenCalled();
    confirmWith(/let the deletion stand|confirm/i);
    expect(resolved).toHaveBeenLastCalledWith(expect.objectContaining({ forkId: 'fork-o1', keep: 'parent' }));
    click(button(/keep this version/i));
    confirmWith(/keep this version|confirm/i);
    expect(resolved).toHaveBeenLastCalledWith(expect.objectContaining({ forkId: 'fork-o1', keep: 'fork' }));
  });
});

describe('a row resolved on another instance (section 9a)', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => document.body.replaceChildren());

  const at = '2026-10-21T09:00:00.000Z';
  const marked = (entries: Row[]) => row('fact', 'm1', {}, {}, { resolvedElsewhere: entries });

  it('says who resolved it and which side they kept, one line per entry', () => {
    const { el } = make([marked([
      { by: 'Berlin', at, proven: true, kept: 'original' },
      { by: 'Gdansk', at, proven: true, kept: 'this version' },
    ])]);
    const text = el.querySelector('article')!.textContent ?? '';
    expect(text).toMatch(/Resolved on Berlin, kept the original/i);
    expect(text).toMatch(/Resolved on Gdansk, kept this version/i);
    const lines = [...el.querySelectorAll('article li, article p, article div, article span')];
    expect(lines.some(l => /Resolved on Gdansk/.test(l.textContent ?? '') && !/Resolved on Berlin/.test(l.textContent ?? '')),
      'each entry is a line of its own').toBe(true);
  });

  it('says it is waiting for the other instance\'s version when that has not landed here', () => {
    const { el } = make([marked([{ by: 'Berlin', at, proven: true, kept: 'not yet known' }])]);
    expect(el.querySelector('article')!.textContent).toMatch(/waiting for Berlin.s version/i);
  });

  it('words an unproven entry as reported by the peer that delivered it', () => {
    const { el } = make([marked([{ by: 'Gdansk', via: 'Berlin', at, proven: false, kept: 'original' }])]);
    expect(el.querySelector('article')!.textContent).toMatch(/reported by Berlin as resolved on Gdansk/i);
    expect(el.querySelector('article')!.textContent, 'an unproven entry is not worded as fact').not.toMatch(/Resolved on Gdansk/);
  });

  it('a row nobody resolved elsewhere has no such line', () => {
    const { el } = make([row('fact', 'm2')]);
    expect(el.textContent).not.toMatch(/resolved on|reported by|waiting for/i);
  });

  it('keeps the two actions, and the confirm of "Keep this version" says it overrides that choice on every instance', () => {
    const { el, click, button } = make([marked([{ by: 'Berlin', at, proven: true, kept: 'original' }])]);
    expect([...el.querySelectorAll('article button')].filter(b => /keep (this|the other) version/i.test(b.textContent ?? '')).length).toBe(2);
    click(button(/keep this version/i));
    const dialog = (el.querySelector('[role="alertdialog"], [role="dialog"]') as HTMLElement).textContent ?? '';
    expect(dialog).toMatch(/overrid/i);
    expect(dialog).toContain('Berlin');
    expect(dialog).toMatch(/every instance/i);
  });

  it('the confirm of an unmarked row does not say it', () => {
    const { el, click, button } = make([row('fact', 'm3')]);
    click(button(/keep this version/i));
    expect((el.querySelector('[role="alertdialog"], [role="dialog"]') as HTMLElement).textContent).not.toMatch(/every instance/i);
  });
});
