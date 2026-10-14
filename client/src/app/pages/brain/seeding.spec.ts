/**
 * Seeding and type change in every record editor (Q-93, plan v3 section 4 "Forms", R6-14).
 *
 * ## What goes wrong today, in the order a person meets it
 *
 * An editor SEEDS a new record's property rows from the type's declared defaults (enum -> first option, number -> 0,
 * boolean -> false, text -> ''). When the type is then changed, `buildPropertiesObject` keeps every existing key and adds the
 * new type's, so the properties of the NEXT save carry the old type's seeds, which the new type does not declare. Under
 * strict that save is refused with a list of keys the person never typed. The plan's rule is exact:
 *
 * - values that were only SEEDED from the old type and never touched are dropped on a type change;
 * - a value the person edited, or a key the record STORED, stays, and is shown marked "not declared" (never silently dropped,
 *   not even at edit-open: a stored key the type does not declare is the thing a person has to be able to see and remove);
 * - the next save's `properties` then contains no seed of the old type.
 *
 * ## One scenario table, run over every editor
 *
 * The create form and the inline edit row of the entities, facts, edges and chrono tabs, and the record drawer's four kinds,
 * each have their own type control and their own handler (the facts inline row and the edge label controls have NONE today).
 * The scenarios are written once against what a person does (pick a type in the control, edit a row, save) and run over a
 * table of surfaces, so an editor cannot be left out by being written next. The set of kinds is derived from the drawer's own
 * `DrawerRecord` union and asserted to be the set covered.
 *
 * ## A memory is seeded from ITS OWN type
 *
 * `BrainStore.memorySchema()` takes the FIRST declared fact type's schema whatever the memory's type. In the fixture the
 * first declared type is deliberately NOT the one under test (`note` is declared before `decision`), so a seed from the
 * wrong type is visible. `memorySchema(typeName)` is the contract's name for the fix, by analogy with entity/edge/chrono.
 *
 * The facts inline-edit type control, and the drawer/edge label handlers, are found by the control's `name` (a select or
 * input whose name ends in `type` / `kind` / `label` inside the editor), never by a name this spec invents.
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';
import type { PropertySchema, SpaceMetaResponse } from '../../core/api.types';
import { BrainStore } from './brain-store.service';
import {
  DRAWER_EDITORS, TAB_EDITORS, derivedDrawerKinds, mountDrawer, mountTab, settle,
  type DrawerEditor, type TabEditor,
} from '../../testing/brain-editors-harness';

type Props = Record<string, string | number | boolean>;
type Kind = 'entity' | 'fact' | 'edge' | 'chrono';

/** The type the scenarios start on (its seeds are what must not survive) and the one they move to. */
const A: Record<string, PropertySchema> = { color: { enum: ['red', 'blue'] }, count: { type: 'number' }, flag: { type: 'boolean' }, memo: {} };
const B: Record<string, PropertySchema> = { size: { type: 'number' }, label: {} };
const A_KEYS = ['color', 'count', 'flag', 'memo'];
const B_KEYS = ['label', 'size'];

/** Type names per kind. For chrono they sort A first (the create form opens on the first allowed type); for facts B is declared FIRST. */
const KINDS: { kind: Kind; a: string; b: string }[] = [
  { kind: 'entity', a: 'Person', b: 'Company' },
  { kind: 'edge', a: 'knows', b: 'works_at' },
  { kind: 'chrono', a: 'deadline', b: 'event' },
  { kind: 'fact', a: 'decision', b: 'note' },
];

function metaFor(): SpaceMetaResponse {
  const typeSchemas: Record<string, Record<string, { propertySchemas: Record<string, PropertySchema> }>> = {};
  for (const { kind, a, b } of KINDS) {
    typeSchemas[kind] = kind === 'fact'
      ? { [b]: { propertySchemas: B }, [a]: { propertySchemas: A } }
      : { [a]: { propertySchemas: A }, [b]: { propertySchemas: B } };
  }
  return { typeSchemas } as unknown as SpaceMetaResponse;
}

const nonEmpty = (p: Props): Props => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== ''));

/** One opened editor, driven the way a person drives it. */
interface Opened {
  fixture: ComponentFixture<unknown>;
  host: HTMLElement;
  setType(type: string): Promise<void>;
  /** The type control's current value, read from the DOM. */
  typeValue(): string;
  keys(): string[];
  marked(): string[];
  editValue(key: string, value: string): Promise<void>;
  /** Save, and return the `properties` the write carried. */
  save(): Promise<Props>;
}

type Mode = 'create' | 'inline' | 'drawer';

const NAME_OF: Record<Kind, Record<Mode, { exact: string[]; re: RegExp }>> = {
  entity: { create: { exact: ['type'], re: /^type$/ }, inline: { exact: ['editEntType'], re: /^edit.*type$/i }, drawer: { exact: ['drwEntType'], re: /^drw.*type$/i } },
  edge: { create: { exact: ['label'], re: /^label$/ }, inline: { exact: ['editEdgeLabel'], re: /^edit.*label$/i }, drawer: { exact: ['drwEdgeLabel'], re: /^drw.*label$/i } },
  chrono: { create: { exact: ['kind'], re: /^kind$/ }, inline: { exact: ['editChronoKind'], re: /^edit.*kind$/i }, drawer: { exact: ['drwChronoKind'], re: /^drw.*kind$/i } },
  fact: { create: { exact: ['memFormType'], re: /^mem.*type$/i }, inline: { exact: [], re: /^edit.*type$/i }, drawer: { exact: ['drwMemType'], re: /^drw.*type$/i } },
};

function typeControl(host: HTMLElement, kind: Kind, mode: Mode): HTMLSelectElement | HTMLInputElement | null {
  const { exact, re } = NAME_OF[kind][mode];
  const all = [...host.querySelectorAll<HTMLSelectElement | HTMLInputElement>('select[name], input[name]')];
  for (const n of exact) {
    const hit = all.find(c => c.getAttribute('name') === n);
    if (hit) return hit;
  }
  return all.find(c => re.test(c.getAttribute('name') ?? '')) ?? null;
}

function choose(control: HTMLSelectElement | HTMLInputElement, value: string): void {
  control.value = value;
  control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

const propRows = (host: HTMLElement): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.prop-row')];
const rowKey = (row: HTMLElement): string => row.querySelector<HTMLInputElement>('.prop-key')!.value;

function view(fixture: ComponentFixture<unknown>, host: HTMLElement, kind: Kind, mode: Mode, save: () => Promise<Props>): Opened {
  return {
    fixture, host,
    async setType(type) {
      const control = typeControl(host, kind, mode);
      expect(control, `no type control for a ${kind} in the ${mode} editor`).toBeTruthy();
      choose(control!, type);
      await settle(fixture);
      await settle(fixture);
    },
    typeValue: () => typeControl(host, kind, mode)?.value ?? '',
    keys: () => propRows(host).map(rowKey).sort(),
    marked: () => propRows(host).filter(r => r.matches('[data-undeclared]') || !!r.querySelector('[data-undeclared]')).map(rowKey).sort(),
    async editValue(key, value) {
      const row = propRows(host).find(r => rowKey(r) === key);
      expect(row, `no row for ${key}`).toBeTruthy();
      const input = row!.querySelector<HTMLInputElement>('.prop-val')!;
      choose(input, value);
      await settle(fixture);
    },
    save,
  };
}

const recordFor = (kind: Kind, type: string, properties: Props): Record<string, unknown> =>
  ({ [kind === 'edge' ? 'label' : 'type']: type, properties });

const tabEditor = (kind: Kind): TabEditor => TAB_EDITORS.find(e => e.kind === kind)!;
const drawerEditor = (kind: Kind): DrawerEditor => DRAWER_EDITORS.find(e => e.kind === kind)!;

/** What the write carried: the `properties` of the last call of `fn` (the body is argument `at`). */
async function writtenProps(fn: ReturnType<typeof vi.fn>, at: number): Promise<Props> {
  await vi.waitFor(() => expect(fn, 'the save never reached the API').toHaveBeenCalled());
  const body = fn.mock.calls.at(-1)![at] as { properties?: Props };
  return body.properties ?? {};
}

/** Open the editor of `mode` for `kind`, on type `a`, holding `stored` when it is an edit. */
async function openRaw(kind: Kind, mode: Mode, stored: Props = {}): Promise<Opened> {
  const { a } = KINDS.find(k => k.kind === kind)!;
  if (mode === 'drawer') {
    const editor = drawerEditor(kind);
    const m = mountDrawer(editor);
    TestBed.inject(BrainStore).spaceMeta.set(metaFor());
    m.state.open(kind as never, editor.record(recordFor(kind, a, stored)) as never);
    await settle(m.fixture);
    await settle(m.fixture);
    return view(m.fixture, m.host, kind, mode, async () => {
      m.state.save();
      return writtenProps(m.api[editor.updateApi], 2);
    });
  }
  const editor = tabEditor(kind);
  const m = mountTab(editor);
  m.c['store'].spaceMeta.set(metaFor());
  if (mode === 'inline') {
    const record = editor.record(recordFor(kind, a, stored));
    m.c['store'][editor.storeList].set([record]);
    editor.openEdit(m.c, record);
    await settle(m.fixture);
    await settle(m.fixture);
    return view(m.fixture, m.host, kind, mode, async () => {
      editor.submitEdit(m.c, 'r1');
      return writtenProps(m.api[editor.updateApi], 2);
    });
  }
  // create: the form opens on the space's first type (a memory has none), with the least valid input filled.
  if (kind === 'entity') { m.c['openEntityForm'](); m.c['entityForm'].name = 'Ann'; }
  else if (kind === 'fact') { m.c['openMemoryForm'](); m.c['memoryForm'].fact = 'a fact'; }
  else if (kind === 'edge') { m.c['openEdgeForm'](); Object.assign(m.c['edgeForm'], { from: 'a', to: 'b' }); }
  else { m.c['openChronoForm'](); Object.assign(m.c['chronoForm'], { title: 'T', startsAt: '2026-08-01T09:00' }); }
  await settle(m.fixture);
  await settle(m.fixture);
  const opened = view(m.fixture, m.host, kind, mode, async () => {
    editor.submitCreate(m.c);
    return writtenProps(m.api[editor.createApi], 1);
  });
  if (kind === 'fact') await opened.setType(a);
  return opened;
}

/**
 * `openRaw`, then the precondition every scenario below stands on: the editor holds the record's OWN type's seeds plus what the
 * record stores. Without it a scenario passes by accident wherever the editor never reacted to the type (the fixture's first
 * declared memory type is the one the scenarios move TO, so a memory editor that ignores the type "drops the old seeds" by
 * having started on the wrong ones).
 */
async function open(kind: Kind, mode: Mode, stored: Props = {}): Promise<Opened> {
  const ed = await openRaw(kind, mode, stored);
  const expected = [...A_KEYS, ...Object.keys(stored).filter(k => !A_KEYS.includes(k))].sort();
  expect(ed.keys(), `the ${kind} ${mode} editor did not start with its own type's seeds and the record's stored keys`).toEqual(expected);
  return ed;
}

const SURFACES = KINDS.flatMap(k => (['create', 'inline', 'drawer'] as const).map(mode => ({ ...k, mode, label: `${k.kind} ${mode}` })));

describe('the scenario table covers every editor', () => {
  it('the kinds under test are exactly the kinds the drawer edits (derived from DrawerRecord)', () => {
    const derived = derivedDrawerKinds();
    expect(derived.length, 'could not read the drawer kinds').toBeGreaterThanOrEqual(4);
    expect(KINDS.map(k => k.kind).sort()).toEqual([...derived].sort());
  });

  it('every surface has a harness row (tab or drawer)', () => {
    for (const k of KINDS) {
      expect(tabEditor(k.kind), `no tab row for ${k.kind}`).toBeTruthy();
      expect(drawerEditor(k.kind), `no drawer row for ${k.kind}`).toBeTruthy();
    }
    expect(SURFACES.length).toBeGreaterThanOrEqual(12);
  });
});

describe.each(SURFACES)('type change in the $label editor', ({ kind, mode, a, b }) => {
  it('starts on the first type with that type\'s seeds', async () => {
    const ed = await open(kind, mode);
    expect(ed.keys()).toEqual(A_KEYS);
    expect(ed.marked(), 'nothing seeded from the declared type is "not declared"').toEqual([]);
  });

  it('drops the old type\'s untouched seeds and seeds the new type\'s', async () => {
    const ed = await open(kind, mode);
    await ed.setType(b);
    expect(ed.typeValue()).toBe(b);
    expect(ed.keys(), 'the editor still shows the previous type\'s seeded rows').toEqual(B_KEYS);
    expect(ed.marked()).toEqual([]);
  });

  it('the next save carries no seed of the old type', async () => {
    const ed = await open(kind, mode);
    await ed.setType(b);
    const props = nonEmpty(await ed.save());
    expect(props).toEqual({ size: 0 });
  });

  it('keeps a value the person edited, marked "not declared", and still drops the untouched seeds', async () => {
    const ed = await open(kind, mode);
    await ed.editValue('memo', 'keep me');
    await ed.setType(b);
    expect(ed.keys()).toEqual(['label', 'memo', 'size']);
    expect(ed.marked(), 'the kept key is not marked').toEqual(['memo']);
    const props = nonEmpty(await ed.save());
    expect(props).toEqual({ memo: 'keep me', size: 0 });
  });

  it('seeds the first type again when the person comes back to it', async () => {
    const ed = await open(kind, mode);
    await ed.setType(b);
    expect(ed.keys(), 'the type change did not re-seed').toEqual(B_KEYS);
    await ed.setType(a);
    expect(ed.keys()).toEqual(A_KEYS);
    expect(ed.marked()).toEqual([]);
  });
});

describe.each(SURFACES.filter(s => s.mode !== 'create'))('opening a stored record in the $label editor', ({ kind, mode, b }) => {
  it('shows a stored key the type does not declare, marked, and keeps it in what is saved', async () => {
    const ed = await open(kind, mode, { legacy: 'x' });
    expect(ed.keys()).toContain('legacy');
    expect(ed.marked(), 'the stored undeclared key is not marked').toEqual(['legacy']);
    const props = nonEmpty(await ed.save());
    expect(props['legacy'], 'the save dropped a key the record stores').toBe('x');
  });

  it('keeps stored keys through a type change (even one whose value equals the old default), drops only seeds', async () => {
    const ed = await open(kind, mode, { color: 'red', legacy: 'x' });
    expect(ed.keys()).toEqual([...A_KEYS, 'legacy'].sort());
    await ed.setType(b);
    expect(ed.keys(), 'stored keys stay, untouched seeds go, the new type\'s are seeded')
      .toEqual(['color', 'label', 'legacy', 'size']);
    expect(ed.marked()).toEqual(['color', 'legacy']);
    const props = nonEmpty(await ed.save());
    expect(props).toEqual({ color: 'red', legacy: 'x', size: 0 });
  });
});

describe('a memory is seeded from its own type, not the first declared one', () => {
  const store = () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [BrainStore] });
    const s = TestBed.inject(BrainStore);
    s.spaceMeta.set(metaFor());
    return s;
  };

  it('memorySchema(typeName) answers that type\'s property schemas', () => {
    const s = store() as unknown as { memorySchema(t?: string): Record<string, PropertySchema> | undefined };
    expect(s.memorySchema('decision')).toEqual(A);
    expect(s.memorySchema('note')).toEqual(B);
  });

  it('memorySchema answers undefined for no type and for a type the space does not declare (as entitySchema does)', () => {
    const s = store() as unknown as { memorySchema(t?: string): Record<string, PropertySchema> | undefined };
    expect(s.memorySchema(undefined)).toBeUndefined();
    expect(s.memorySchema('')).toBeUndefined();
    expect(s.memorySchema('nonexistent')).toBeUndefined();
  });

  it('buildPropertiesObject seeds a named memory type from that type', () => {
    const s = store();
    expect(Object.keys(s.buildPropertiesObject('fact', {}, 'decision')).sort()).toEqual(A_KEYS);
    expect(Object.keys(s.buildPropertiesObject('fact', {}, 'note')).sort()).toEqual(B_KEYS);
  });

  it('buildPropertiesObject seeds a typeless memory with NOTHING (it used to take the first type\'s schema)', () => {
    const s = store();
    expect(s.buildPropertiesObject('fact', {})).toEqual({});
  });

  it('facts tab, create form: picking `decision` seeds decision\'s keys, and a fresh form seeds none', async () => {
    const editor = tabEditor('fact');
    const m = mountTab(editor);
    m.c['store'].spaceMeta.set(metaFor());
    m.c['openMemoryForm']();
    await settle(m.fixture);
    expect(Object.keys(m.c['memoryForm'].properties), 'a typeless memory was seeded from the first type').toEqual([]);
    const ed = view(m.fixture, m.host, 'fact', 'create', async () => ({}));
    await ed.setType('decision');
    expect(ed.keys()).toEqual(A_KEYS);
  });

  it('facts tab, inline edit: a `decision` memory shows decision\'s rows and decision\'s declared set marks the rest', async () => {
    const ed = await open('fact', 'inline', { topic: 'stray' });
    expect(ed.keys()).toEqual([...A_KEYS, 'topic'].sort());
    expect(ed.marked(), 'a key that `decision` does not declare must be marked').toEqual(['topic']);
  });

  it('drawer: a `decision` memory shows decision\'s rows and marks a key decision does not declare', async () => {
    const ed = await open('fact', 'drawer', { topic: 'stray' });
    expect(ed.keys()).toEqual([...A_KEYS, 'topic'].sort());
    expect(ed.marked()).toEqual(['topic']);
  });
});
