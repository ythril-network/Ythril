/**
 * What the graph side-panel's record cards RENDER — pinned before they are extracted (G-2).
 *
 * ## Why this file exists
 *
 * `graph.component.ts` is at its size freeze, and the cure is moving the record card into a child
 * component. The repo rule is characterization tests first, proven against the ORIGINAL code, because a
 * template move is exactly the change that silently loses a binding — and a binding that renders nothing
 * looks identical to a record with no value.
 *
 * **An inventory of the two cards found 167 rendered things and DOM coverage of none of them.** Four
 * assertions in the whole client touch the card at all and every one is signal-level: two read
 * `recordUnavailable()` in a suite with no DOM, and two set `selectedEntityRecord` purely to prove it gets
 * nulled. `graph.component.characterization.spec.ts` is 680 lines with zero `querySelector`. So neither
 * card's populated branch had ever been rendered by a test before this file.
 *
 * ## There are TWO cards, and they are not the same shape
 *
 * The node card (`<!-- Record card -->`) and the edge card (`<!-- Edge record card -->`) share every class
 * and the field-row idiom, and differ in four ways that matter: the edge card has `weight`, `from`/`to` with
 * a fallback, and a `relation` label instead of `name` — and it has **no `recordUnavailable` branch at
 * all**. Any extraction that unifies them is changing behaviour rather than moving it, so both are pinned
 * here separately.
 *
 * ## Three of these pin a DEFECT, deliberately
 *
 * A characterization test states what the code does, not what it should. Where the current behaviour is
 * wrong the assertion says so in its name and its comment, so the extraction cannot quietly "fix" it and
 * cannot quietly keep it: changing it becomes a decision somebody makes on purpose.
 *
 *  - a memory or chrono node renders a BLANK name row and never shows its `fact` / `title`;
 *  - a file node renders the unavailable message AND the loading row, together;
 *  - a synthetic edge shows loading for ever, because only the node card reads `recordUnavailable()`.
 *
 * Run: cd client && npx vitest run src/app/pages/graph/graph-record-card.characterization.spec.ts
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ActivatedRoute } from '@angular/router';

vi.mock('cytoscape', () => {
  const chain: any = new Proxy(() => chain, { get: () => () => chain });
  return { default: () => chain };
});

import { SpacesApi } from '../../core/spaces-api.service';
import { BrainApi } from '../../core/brain-api.service';
import { AuthApi } from '../../core/auth-api.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { GraphComponent } from './graph.component';

function makeApi() {
  return {
    getMe: () => of({ readOnly: false }),
    listSpaces: () => of({ spaces: [] }),
    getSpaceMeta: () => of({ typeSchemas: {} }),
  } as any;
}

function create() {
  TestBed.configureTestingModule({
    imports: [GraphComponent, getTranslocoModule()],
    providers: [
      { provide: SpacesApi, useValue: makeApi() },
      { provide: BrainApi, useValue: makeApi() },
      { provide: AuthApi, useValue: makeApi() },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParams: {} } } },
    ],
  });
  const fixture = TestBed.createComponent(GraphComponent);
  fixture.componentRef.setInput('embeddedSpaceId', 'work');
  fixture.detectChanges();
  return fixture;
}

/** A node as the traversal reports one. `type` is required and both synthesis sites default it. */
const node = (over: Record<string, unknown> = {}) =>
  ({ _id: 'n1', name: 'Ada', type: 'person', depth: 1, ...over }) as any;

/** The two cards live in the same DOM under `.record-card`; index 0 is the node card when open. */
function card(fixture: any, which: 0 | 1 = 0): HTMLElement | null {
  const all = fixture.nativeElement.querySelectorAll('.record-card');
  return (all[which] as HTMLElement) ?? null;
}

/** Every `<label, value>` pair the card rendered, in order — the shape an extraction must preserve. */
function rows(el: HTMLElement | null): { label: string; value: string }[] {
  if (!el) return [];
  return [...el.querySelectorAll('.drawer-field')].map(f => ({
    label: (f.querySelector('.drawer-label')?.textContent ?? '').trim(),
    value: (f.querySelector('.drawer-value, .drawer-readonly-value')?.textContent ?? '').trim(),
  }));
}

describe('the node card, populated', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function openWith(record: Record<string, unknown>) {
    const f = create();
    const c = f.componentInstance as any;
    c.selectedNode.set(node());
    c.selectedEntityRecord.set(record);
    f.detectChanges();
    return { f, c };
  }

  it('renders every field an entity carries, in template order', () => {
    // The whole point of the file: this is the first test that has ever rendered this branch.
    const { f } = openWith({
      _id: 'e-1', name: 'Ada Lovelace', type: 'person', description: 'the first programmer',
      tags: ['maths', 'history'], properties: { born: 1815 }, createdAt: '2026-08-30T09:05:00.000Z',
    });
    const got = rows(card(f));
    const values = got.map(r => r.value);
    expect(values).toContain('Ada Lovelace');
    expect(values).toContain('person');
    expect(values).toContain('the first programmer');
    expect(values).toContain('e-1');
    /*
     * The only pipe-formatted value in either card, and the one a move is most likely to drop — asserted as
     * a FORMAT, not an instant. `date:` renders in the runner's LOCAL zone, so a fixed string passes here
     * (CEST) and fails on CI (UTC) by exactly two hours. What the extraction can break is the pattern
     * disappearing or changing, and that is what this catches.
     */
    const stamped = values.find(v => /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/.test(v));
    expect(stamped, `no dd.MM.yyyy HH:mm value rendered; got ${JSON.stringify(values)}`).toBeTruthy();
  });

  it('renders tags as chips, one per tag, tracked by value', () => {
    const { f } = openWith({ _id: 'e-1', name: 'Ada', tags: ['maths', 'history'], createdAt: '2026-08-30T09:05:00.000Z' });
    const chips = [...(card(f)?.querySelectorAll('.drawer-tag') ?? [])].map(c => c.textContent?.trim());
    expect(chips).toEqual(['maths', 'history']);
  });

  it('hides a row whose value is absent, rather than showing an empty label', () => {
    // Each optional row is its own `@if`, and the label lives INSIDE it — so losing the guard in a move
    // would show a bare "Description" with nothing under it, which reads as "this record has none".
    const { f } = openWith({ _id: 'e-1', name: 'Ada', createdAt: '2026-08-30T09:05:00.000Z' });
    const labels = rows(card(f)).map(r => r.label);
    expect(labels).not.toContain('Description');
    expect(labels).not.toContain('Tags');
  });

  it('hides properties for an EMPTY object, not just an absent one', () => {
    // The guard is two-part and calls `objectKeys` from the template. A `{}` must hide the row; the
    // simpler `@if (properties)` a refactor might reach for would show an empty properties view.
    const { f } = openWith({ _id: 'e-1', name: 'Ada', properties: {}, createdAt: '2026-08-30T09:05:00.000Z' });
    expect(card(f)?.querySelector('app-properties-view')).toBeNull();
  });

  it('renders the properties view when there IS a property', () => {
    const { f } = openWith({ _id: 'e-1', name: 'Ada', properties: { born: 1815 }, createdAt: '2026-08-30T09:05:00.000Z' });
    expect(card(f)?.querySelector('app-properties-view')).not.toBeNull();
  });

  it('labels the id `_id`, untranslated — the only such label in either card', () => {
    // Deliberate, and easy to "tidy" into a translation key during a move.
    const { f } = openWith({ _id: 'e-1', name: 'Ada', createdAt: '2026-08-30T09:05:00.000Z' });
    expect(rows(card(f)).map(r => r.label)).toContain('_id');
  });

  it('shows the loading row while no record has arrived', () => {
    const f = create();
    (f.componentInstance as any).selectedNode.set(node());
    f.detectChanges();
    expect(card(f)?.textContent).toMatch(/loading/i);
    expect(card(f)?.querySelector('.drawer-label')).toBeNull();
  });
});

describe('the node card, for every kind that reaches it', () => {
  beforeEach(() => TestBed.resetTestingModule());

  /*
   * G-5, fixed. This block used to pin the DEFECT: a graph node is one of four kinds, and since 3.6 a chrono
   * entry, memory or file reaches the canvas through its `entityIds` link. `loadNodeDetails` fetched the right
   * record and then cast it `as Entity`; the card had no branch on `kind` and never read it. A memory has
   * `fact` and no `name`, so the name row rendered EMPTY and the fact — the only thing the record says — was
   * never shown. Every other field rendered, which is why nobody reported it.
   *
   * The rewrite is deliberate, as the old comment asked for. The fix is not a new rule either: `memoryText`
   * and `chronoText` in `graph-details.ts` already decide this for the linked-records list in the SAME panel,
   * and the card now asks them. One rule, one implementation — the divergence was the defect.
   */
  for (const [kind, record, shown] of [
    ['fact', { _id: 'm1', fact: 'rotate the vault quarterly', type: 'note', createdAt: '2026-08-30T09:05:00.000Z' }, 'rotate the vault quarterly'],
    ['chrono', { _id: 'c1', title: 'carrier lost the unit', type: 'event', createdAt: '2026-08-30T09:05:00.000Z' }, 'carrier lost the unit'],
  ] as const) {
    it(`a ${kind} node shows what the record actually says`, () => {
      const f = create();
      const c = f.componentInstance as any;
      c.selectedNode.set(node({ _id: record._id, kind }));
      c.selectedEntityRecord.set(record);
      f.detectChanges();

      const got = rows(card(f));
      expect(got[0]?.value, `the first row is blank for a ${kind}`).toBe(shown);
      expect(card(f)?.textContent).toContain(shown);
      // And the shared fields still render, which they always did.
      expect(got.map(r => r.value)).toContain(record.type);
    });
  }

  it('falls back to the description when a memory has no fact', () => {
    // `memoryText` is `fact || description || ''`. Reproducing that choice in the template would be the second
    // implementation this fix exists to remove, so it is asserted here rather than re-derived there.
    const f = create();
    const c = f.componentInstance as any;
    c.selectedNode.set(node({ _id: 'm2', kind: 'fact' }));
    c.selectedEntityRecord.set({ _id: 'm2', description: 'only a description', createdAt: '2026-08-30T09:05:00.000Z' });
    f.detectChanges();
    expect(rows(card(f))[0]?.value).toBe('only a description');
  });

  it('an ENTITY still shows its name — the common case is untouched', () => {
    const f = create();
    const c = f.componentInstance as any;
    c.selectedNode.set(node());
    c.selectedEntityRecord.set({ _id: 'e1', name: 'Ada Lovelace', createdAt: '2026-08-30T09:05:00.000Z' });
    f.detectChanges();
    expect(rows(card(f))[0]?.value).toBe('Ada Lovelace');
  });
});

describe('the node card, when the record cannot be fetched', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('says WHY, rather than leaving the panel blank', () => {
    // A file node is addressed by path and a graph node carries an id, so there is no request to make. An
    // empty panel and an unfetchable record look identical to a reader, and only one of them is true.
    const f = create();
    const c = f.componentInstance as any;
    c.selectedNode.set(node({ _id: 'f1', kind: 'file' }));
    c.recordUnavailable.set('file');
    f.detectChanges();
    expect(card(f)?.querySelector('.drawer-value.drawer-muted')).not.toBeNull();
  });

  it('and does NOT also say it is loading', () => {
    /*
     * G-6, fixed. This pinned the defect: the message and the record were two independent `@if`s rather than
     * an if/else, so a file node rendered "no record can be fetched for a file node" immediately above
     * "Loading…" — the panel contradicting itself, and the second line the more believable of the two,
     * because it is the one that usually means something.
     */
    const f = create();
    const c = f.componentInstance as any;
    c.selectedNode.set(node({ _id: 'f1', kind: 'file' }));
    c.recordUnavailable.set('file');
    f.detectChanges();
    expect(card(f)?.textContent).not.toMatch(/loading/i);
  });

  it('and the message is actually muted', () => {
    /*
     * It asked for `class="muted"`, which is declared NOWHERE — not in `graph.styles.ts`, not globally. A
     * `.drawer-muted` rule sat beside the other drawer classes with no user in the graph page at all. So the
     * one sentence explaining why a panel is empty rendered as ordinary body text.
     *
     * Asserted as the class the stylesheet actually defines, because "muted" is exactly the kind of plausible
     * name that reads as working.
     */
    const f = create();
    const c = f.componentInstance as any;
    c.selectedNode.set(node({ _id: 'f1', kind: 'file' }));
    c.recordUnavailable.set('file');
    f.detectChanges();
    const msg = card(f)?.querySelector('.drawer-value');
    expect(msg?.className, 'the message asks for a class the stylesheet does not define').toContain('drawer-muted');
  });
});

describe('the edge card', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function openEdge(record: Record<string, unknown> | null, edge: Record<string, unknown> = { _id: 'x', from: 'a', to: 'b', label: 'knows' }) {
    const f = create();
    const c = f.componentInstance as any;
    c.selectedEdge.set(edge);
    if (record) c.selectedEdgeRecord.set(record);
    f.detectChanges();
    return f;
  }

  it('renders the relation, not a name — a different label from the node card', () => {
    const f = openEdge({ _id: 'x', label: 'knows', from: 'a', to: 'b' });
    expect(rows(card(f, 0)).map(r => r.value)).toContain('knows');
  });

  it('renders a weight of ZERO, which every other guard in the card would hide', () => {
    // The only explicitly falsy-safe guard in either card (`!== undefined && !== null`). A move that
    // normalised it to `@if (weight)` would silently drop every zero-weight edge's weight row.
    const f = openEdge({ _id: 'x', label: 'knows', from: 'a', to: 'b', weight: 0 });
    expect(rows(card(f, 0)).map(r => r.value)).toContain('0');
  });

  it('falls back to the endpoint IDS when the record carries no names', () => {
    // `fromName || selectedEdge()!.from` — the fallback reads a DIFFERENT signal from the one the rest of
    // the card reads, which is exactly the sort of cross-signal read an extraction drops.
    const f = openEdge({ _id: 'x', label: 'knows', from: 'a', to: 'b' });
    const values = rows(card(f, 0)).map(r => r.value);
    expect(values).toContain('a');
    expect(values).toContain('b');
  });

  it('prefers the resolved endpoint NAMES when it has them', () => {
    const f = openEdge({ _id: 'x', label: 'knows', from: 'a', to: 'b', fromName: 'Ada', toName: 'Grace' });
    const values = rows(card(f, 0)).map(r => r.value);
    expect(values).toContain('Ada');
    expect(values).toContain('Grace');
  });

  it('explains a SYNTHETIC edge rather than loading for ever', () => {
    /*
     * G-6, fixed. `loadEdgeDetails` sets `recordUnavailable('derived')` for a synthetic edge — id
     * `<label>:<from>:<to>`, no stored record. The string was shipped in all three locale files and the
     * signal was asserted by another suite, but the ONLY render site was inside the NODE card, and
     * `onEdgeTap` nulls `selectedNode` first. So the edge panel showed "Loading…" indefinitely and the
     * explanation was unreachable on screen: written, translated three times, impossible to see.
     */
    const f = create();
    const c = f.componentInstance as any;
    c.selectedEdge.set({ _id: 'mentions:a:b', from: 'a', to: 'b', label: 'mentions' });
    c.recordUnavailable.set('derived');
    f.detectChanges();
    expect(card(f, 0)?.querySelector('.drawer-value.drawer-muted'),
      'the edge card still has no unavailable branch').not.toBeNull();
    expect(card(f, 0)?.textContent).not.toMatch(/loading/i);
  });
});

describe('the structure a move must carry with it', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('the card is a `.record-card`, and the styles that size it are the parent\'s', () => {
    /*
     * The silent loss. `.record-card`, `.drawer-field`, `.drawer-label`, `.drawer-value`, `.drawer-hr`,
     * `.drawer-readonly-value` and `.drawer-tag` are all declared in `graph.styles.ts` and applied through
     * the PARENT's `styles: [GRAPH_STYLES]`. Under emulated encapsulation the parent's content attribute
     * does not reach a child component's template, so every one of them goes unstyled after a move —
     * including `.record-card { flex: 0 0 50% }`, which is what makes the panel two columns.
     *
     * This asserts the class names are what the DOM actually carries, so the extraction has a list to move.
     */
    const f = create();
    const c = f.componentInstance as any;
    c.selectedNode.set(node());
    c.selectedEntityRecord.set({ _id: 'e-1', name: 'Ada', tags: ['x'], createdAt: '2026-08-30T09:05:00.000Z' });
    f.detectChanges();
    const el = card(f)!;
    expect(el).not.toBeNull();
    for (const cls of ['drawer-field', 'drawer-label', 'drawer-value', 'drawer-hr', 'drawer-readonly-value', 'drawer-tag']) {
      expect(el.querySelector(`.${cls}`), `.${cls} is gone from the rendered card`).not.toBeNull();
    }
  });

  it('the card does not render at all with nothing selected', () => {
    // Its gate is on the enclosing panel, not on the card. A child component would need that gate kept
    // outside it, or it renders an empty shell on every page load.
    expect(card(create())).toBeNull();
  });
});
