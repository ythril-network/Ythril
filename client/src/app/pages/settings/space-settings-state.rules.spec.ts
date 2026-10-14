/**
 * F-46 rules through the settings dialog's STATE — every hop on its own, so each can be seen red by removing one line.
 *
 * ## The shape this guards
 *
 * `typeSchemaFromState` REBUILDS the wire type object from scratch, so a field the editor state does not hold is
 * DELETED the next time anybody saves any type in the dialog. `endpoints` was lost exactly that way (see
 * `space-settings-state.service.spec.ts`): the serialiser carried it, the loader never filled it, the carry-through was
 * tested at the serialiser with a hand-built state, and the round trip did not work. Rules are the next field of that
 * kind, and worse: a rule is an enforced constraint, so losing one on an unrelated save widens what a space accepts
 * with no message anywhere.
 *
 * So there is one test per HOP, and each builds its input without the hop before it:
 *
 *   loadKt (openSettings)  ->  state  ->  typeSchemaFromState / buildMeta  ->  wire
 *   mapImportedTypeSchema (a file)  ->  state
 *   unlinkType (a library entry)  ->  state
 *   snapshot / isDirty / changedSettings (the save's diff)
 *
 * Remove the `rules` line from any one and exactly its tests go red.
 *
 * ## Names this spec fixes (the contract), and the ones it had to choose
 *
 * Contract: `TypeSchemaState.rules` (a keyed LIST of `{ name, rule, message }`), `SpaceSettingsState.schRules` (the same
 * plus `kinds`), wire `TypeSchema.rules` / `SpaceMeta.rules` as maps keyed by name, an empty `kinds` omitted on the
 * wire, the space map sent WHOLE (a removed last rule is `rules: {}`), `[data-testid="reload-schema"]`, and the
 * component method `linkedRules(kt, name)`. Chosen here and nowhere in the contract: the list item of `linkedRules` is
 * `{ name, rule, message }` (the state's own item, by analogy with `linkedProps` returning `{ key, s }`).
 */
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import { SpacesApi } from '../../core/spaces-api.service';
import { SchemaApi } from '../../core/schema-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { KNOWLEDGE_TYPES, type KnowledgeType, type Space } from '../../core/api.types';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { SpaceSchemaTabComponent } from './space-schema-tab.component';
import { SpaceSettingsPopupComponent } from './space-settings-popup.component';
import { SpacesStore } from './spaces-store.service';
import { SpaceSettingsState, emptyTypeSchemaState, typeSchemaFromState, type TypeSchemaState } from './space-settings-state.service';

// ── what a rule looks like, written once ─────────────────────────────────────────────────────────────────────────────

interface RuleRow { name: string; rule: string; message: string }
interface SpaceRuleRow extends RuleRow { kinds: KnowledgeType[] }
type WireRule = { rule: string; message: string; kinds?: KnowledgeType[] };

const AGE = { rule: 'self.properties.age >= 0', message: 'An age cannot be negative' };
const TITLE = { rule: 'size(self.title) > 3', message: 'A title needs more than three characters' };
const FUTURE = { rule: 'self.properties.at <= now', message: 'Not in the future', kinds: ['chrono', 'fact'] as KnowledgeType[] };
const EVERYWHERE = { rule: 'size(self.tags) <= 10', message: 'At most ten tags' };

function space(over: Partial<Space> = {}): Space {
  return { id: 'work', label: 'Work', maxGiB: 10, networks: [], ...over } as Space;
}

/** A space whose stored meta carries rules at BOTH levels. */
function ruled(over: Record<string, unknown> = {}): Space {
  return space({
    meta: {
      version: 7,
      typeSchemas: {
        entity: { person: { rules: { 'age-positive': AGE, 'title-long': TITLE }, propertySchemas: { age: { type: 'number' } } }, plain: {} },
        fact: {}, edge: {}, chrono: {},
      },
      rules: { 'no-future': FUTURE, 'few-tags': EVERYWHERE },
      ...over,
    },
  } as unknown as Partial<Space>);
}

/** Reads and writes the rule fields without needing the types the implementation will add. */
const typeRules = (s: SpaceSettingsState, kt: KnowledgeType, name: string): RuleRow[] | undefined =>
  (s.typeState(kt, name) as unknown as { rules?: RuleRow[] }).rules;
const setTypeRules = (s: SpaceSettingsState, kt: KnowledgeType, name: string, rules: RuleRow[]): void => {
  (s.typeState(kt, name) as unknown as { rules?: RuleRow[] }).rules = rules;
};
const spaceRules = (s: SpaceSettingsState): SpaceRuleRow[] | undefined => (s as unknown as { schRules?: SpaceRuleRow[] }).schRules;
const setSpaceRules = (s: SpaceSettingsState, rules: SpaceRuleRow[]): void => { (s as unknown as { schRules?: SpaceRuleRow[] }).schRules = rules; };
const wireRules = (x: unknown): Record<string, WireRule> | undefined => (x as { rules?: Record<string, WireRule> }).rules;

const STATS = { spaceId: 'work', facts: 0, entities: 0, edges: 0, chrono: 0, files: 0 };

function makeState(): SpaceSettingsState {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [getTranslocoModule()],
    providers: [SpaceSettingsState, { provide: SpacesApi, useValue: { getSpaceStats: () => of(STATS) } }],
  });
  return TestBed.inject(SpaceSettingsState);
}

/** A state opened on an EMPTY space and then given rules by assignment — so a test of one hop does not rely on the loader. */
function stateWithRules(): SpaceSettingsState {
  const s = makeState();
  s.openSettings(space({ meta: { typeSchemas: { entity: { person: {} }, fact: {}, edge: {}, chrono: {} } } as never }));
  setTypeRules(s, 'entity', 'person', [{ name: 'age-positive', ...AGE }, { name: 'title-long', ...TITLE }]);
  setSpaceRules(s, [{ name: 'no-future', ...FUTURE }, { name: 'few-tags', ...EVERYWHERE, kinds: [] }]);
  s.markPristine();
  return s;
}

// ── hop 1: the loader ────────────────────────────────────────────────────────────────────────────────────────────────

describe('hop: openSettings reads rules into the editor state (loadKt)', () => {
  it('a type\'s rules arrive as a keyed list, in the order the map holds them', () => {
    const s = makeState();
    s.openSettings(ruled());
    expect(typeRules(s, 'entity', 'person')).toEqual([{ name: 'age-positive', ...AGE }, { name: 'title-long', ...TITLE }]);
  });

  it('a type with no rules, and a linked type, start with an empty list — never undefined', () => {
    const s = makeState();
    s.openSettings(ruled({ typeSchemas: { entity: { plain: {}, linked: { $ref: 'library:shared' } }, fact: {}, edge: {}, chrono: {} } }));
    expect(typeRules(s, 'entity', 'plain')).toEqual([]);
    expect(typeRules(s, 'entity', 'linked')).toEqual([]);
  });

  it('every knowledge type loads its rules, not only entities', () => {
    // Derived from the client's own list of kinds, so a fifth kind is covered without this spec being edited.
    expect(KNOWLEDGE_TYPES.length).toBeGreaterThanOrEqual(4);
    const s = makeState();
    const typeSchemas = Object.fromEntries(KNOWLEDGE_TYPES.map(kt => [kt, { probe: { rules: { 'r-1': AGE } } }]));
    s.openSettings(space({ meta: { typeSchemas } as never }));
    for (const kt of KNOWLEDGE_TYPES) expect(typeRules(s, kt, 'probe'), kt).toEqual([{ name: 'r-1', ...AGE }]);
  });

  it('the space\'s rules arrive with their kinds; an absent kinds list is an empty one (all kinds)', () => {
    const s = makeState();
    s.openSettings(ruled());
    expect(spaceRules(s)).toEqual([
      { name: 'no-future', ...FUTURE },
      { name: 'few-tags', ...EVERYWHERE, kinds: [] },
    ]);
  });

  it('a space with no rules loads an empty list', () => {
    const s = makeState();
    s.openSettings(space());
    expect(spaceRules(s)).toEqual([]);
  });

  it('copies by VALUE: editing the draft cannot reach back into the space object the list renders from', () => {
    const s = makeState();
    const sp = ruled();
    s.openSettings(sp);
    const first = typeRules(s, 'entity', 'person')?.[0];
    expect(first, 'the loader produced no rule row to edit').toBeDefined();
    first!.rule = 'EDITED';
    const kinds = spaceRules(s)?.[0]?.kinds;
    expect(kinds, 'the loader produced no space rule row to edit').toBeDefined();
    kinds!.push('edge');
    const meta = sp.meta as unknown as { typeSchemas: { entity: { person: { rules: Record<string, WireRule> } } }; rules: Record<string, WireRule> };
    expect(meta.typeSchemas.entity.person.rules['age-positive']!.rule).toBe(AGE.rule);
    expect(meta.rules['no-future']!.kinds).toEqual(['chrono', 'fact']);
  });
});

// ── hop 2: the serialisers ───────────────────────────────────────────────────────────────────────────────────────────

describe('hop: typeSchemaFromState writes rules out (the export, the library save and the PATCH all use it)', () => {
  const stateOf = (rules: RuleRow[]): TypeSchemaState => emptyTypeSchemaState({ rules } as Partial<TypeSchemaState>);

  it('a fresh state holds an empty list, which is what makes "omitted when empty" a rule and not an accident', () => {
    expect((emptyTypeSchemaState() as unknown as { rules?: RuleRow[] }).rules).toEqual([]);
  });

  it('writes the wire map keyed by name with rule and message only', () => {
    const noisy = [{ name: 'age-positive', ...AGE, _open: true } as RuleRow];
    const ts = typeSchemaFromState('entity', stateOf(noisy));
    expect(wireRules(ts)).toEqual({ 'age-positive': { rule: AGE.rule, message: AGE.message } });
  });

  it('omits `rules` entirely when the list is empty, so a type with none carries no empty map', () => {
    const empty = typeSchemaFromState('entity', stateOf([]));
    expect('rules' in empty).toBe(false);
    // ...and the same state with one rule DOES carry it, so the omission above is the guard and not an absent feature.
    expect(wireRules(typeSchemaFromState('entity', stateOf([{ name: 'a', ...AGE }])))).toBeDefined();
  });

  it.each(KNOWLEDGE_TYPES.map(kt => [kt]))('carries rules for a %s type', (kt) => {
    expect(wireRules(typeSchemaFromState(kt, stateOf([{ name: 'a', ...AGE }])))).toEqual({ a: { rule: AGE.rule, message: AGE.message } });
  });

  it('keeps rules on the library path, which drops only the retention window', () => {
    const ts = typeSchemaFromState('entity', stateOf([{ name: 'a', ...AGE }]), { withRetention: false });
    expect(wireRules(ts)).toEqual({ a: { rule: AGE.rule, message: AGE.message } });
    expect(ts.retention).toBeUndefined();
  });
});

describe('hop: buildMeta puts both levels of rules on the wire', () => {
  it('a type\'s rules ride inside its typeSchemas entry; a linked type stays a bare $ref', () => {
    const s = stateWithRules();
    s.schTypeSchemas = { ...s.schTypeSchemas, entity: { ...s.schTypeSchemas.entity, linked: emptyTypeSchemaState({ _libRef: 'shared' }) } };
    const out = s.buildMeta().typeSchemas!.entity!;
    expect(wireRules(out['person'])).toEqual({ 'age-positive': AGE, 'title-long': TITLE });
    expect(out['linked']).toEqual({ $ref: 'library:shared' });
  });

  it('the space\'s rules go out as a map; an empty kinds list is omitted, a stated one kept', () => {
    const s = stateWithRules();
    expect(wireRules(s.buildMeta())).toEqual({
      'no-future': { rule: FUTURE.rule, message: FUTURE.message, kinds: ['chrono', 'fact'] },
      'few-tags': { rule: EVERYWHERE.rule, message: EVERYWHERE.message },
    });
    expect('kinds' in wireRules(s.buildMeta())!['few-tags']!).toBe(false);
  });

  it('opening a space and writing it back changes no rule at either level', () => {
    const s = makeState();
    s.openSettings(ruled());
    const meta = s.buildMeta();
    expect(wireRules(meta)).toEqual({ 'no-future': FUTURE, 'few-tags': EVERYWHERE });
    expect(wireRules(meta.typeSchemas!.entity!['person'])).toEqual({ 'age-positive': AGE, 'title-long': TITLE });
  });
});

// ── hop 3: a file, and the library ───────────────────────────────────────────────────────────────────────────────────

function mountTab(schemaApi: Partial<SchemaApi> = {}, toasts: string[] = []) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [SpaceSchemaTabComponent, getTranslocoModule()],
    providers: [
      provideHttpClient(), provideHttpClientTesting(),
      SpaceSettingsState,
      { provide: SpacesApi, useValue: {} },
      { provide: ToastService, useValue: { show: () => {}, error: (m: string) => toasts.push(m), success: () => {}, info: () => {} } },
      { provide: SchemaApi, useValue: {
        listSchemaLibrary: () => of({ entries: [] }), upsertSchemaLibraryEntry: () => of({ entry: {} }),
        getSchemaLayers: () => of({ spaceId: 'work', own: {}, layers: [], precedence: [], clashes: [] }),
        ...schemaApi,
      } },
    ],
  });
  const fixture = TestBed.createComponent(SpaceSchemaTabComponent);
  return { c: fixture.componentInstance, state: TestBed.inject(SpaceSettingsState) };
}

describe('hop: an imported file brings its rules with it (mapImportedTypeSchema)', () => {
  const importer = (c: SpaceSchemaTabComponent) =>
    (c as unknown as { mapImportedTypeSchema(o: Record<string, unknown>): TypeSchemaState }).mapImportedTypeSchema.bind(c);
  const rulesOf = (ts: TypeSchemaState) => (ts as unknown as { rules?: RuleRow[] }).rules;

  it('reads a type\'s rules from the file as the editor\'s keyed list', () => {
    const { c } = mountTab();
    expect(rulesOf(importer(c)({ rules: { 'age-positive': AGE, 'title-long': TITLE } })))
      .toEqual([{ name: 'age-positive', ...AGE }, { name: 'title-long', ...TITLE }]);
  });

  it('a file with no rules stages an empty list', () => {
    const { c } = mountTab();
    expect(rulesOf(importer(c)({ namingPattern: '^P' }))).toEqual([]);
  });

  it('a junk `rules` value in a file becomes none rather than a save the API rejects', () => {
    // The file is arbitrary JSON; this is the same defensive reading the retention window gets, for the same reason.
    const { c } = mountTab();
    const map = importer(c);
    expect(rulesOf(map({ rules: 'soon' }))).toEqual([]);
    expect(rulesOf(map({ rules: [AGE] }))).toEqual([]);
    expect(rulesOf(map({ rules: { bad: 'not an object', worse: { rule: 5, message: 'x' }, good: AGE } })))
      .toEqual([{ name: 'good', ...AGE }]);
  });
});

describe('hop: unlinking a library type keeps its rules, now editable (unlinkType)', () => {
  const entry = {
    name: 'shared-person', knowledgeType: 'entity', typeName: 'person',
    schema: { namingPattern: '^P', propertySchemas: {}, rules: { 'age-positive': AGE } },
  };

  it('the library entry\'s rules become inline rows on the type', () => {
    const { c, state } = mountTab({ listSchemaLibrary: () => of({ entries: [entry] }) as never });
    c.ngOnInit();
    state.schTypeSchemas = { ...state.schTypeSchemas, entity: { person: emptyTypeSchemaState({ _libRef: 'shared-person' }) } };
    c.unlinkType('entity', 'person');
    expect(state.typeLibRef('entity', 'person')).toBeNull();
    expect(typeRules(state, 'entity', 'person')).toEqual([{ name: 'age-positive', ...AGE }]);
  });

  it('the inline copy is independent of the library entry it came from', () => {
    const { c, state } = mountTab({ listSchemaLibrary: () => of({ entries: [entry] }) as never });
    c.ngOnInit();
    state.schTypeSchemas = { ...state.schTypeSchemas, entity: { person: emptyTypeSchemaState({ _libRef: 'shared-person' }) } };
    c.unlinkType('entity', 'person');
    const row = typeRules(state, 'entity', 'person')?.[0];
    expect(row, 'unlinking produced no rule row').toBeDefined();
    row!.rule = 'EDITED';
    expect(entry.schema.rules['age-positive'].rule).toBe(AGE.rule);
  });

  it('saving a type to the library sends its rules', () => {
    const upsert = vi.fn().mockReturnValue(of({ entry: { name: 'person' } }));
    const { c, state } = mountTab({ upsertSchemaLibraryEntry: upsert as never });
    state.schTypeSchemas = { ...state.schTypeSchemas, entity: { person: emptyTypeSchemaState() } };
    setTypeRules(state, 'entity', 'person', [{ name: 'age-positive', ...AGE }]);
    c.saveTypeToLibrary('entity', 'person');
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(wireRules(upsert.mock.calls[0]![1].schema)).toEqual({ 'age-positive': { rule: AGE.rule, message: AGE.message } });
  });
});

describe('a linked ($ref) type shows its rules read-only, from the library (linkedRules)', () => {
  const entry = {
    name: 'shared-person', knowledgeType: 'entity', typeName: 'person',
    schema: { propertySchemas: {}, rules: { 'age-positive': AGE, 'title-long': TITLE } },
  };

  it('resolves the linked entry\'s rules as `{ name, rule, message }` rows, as linkedProps does for properties', () => {
    const { c, state } = mountTab({ listSchemaLibrary: () => of({ entries: [entry] }) as never });
    c.ngOnInit();
    state.schTypeSchemas = { ...state.schTypeSchemas, entity: { person: emptyTypeSchemaState({ _libRef: 'shared-person' }) } };
    const linkedRules = (c as unknown as { linkedRules?(kt: KnowledgeType, name: string): RuleRow[] }).linkedRules?.bind(c);
    expect(linkedRules, 'the component has no linkedRules(kt, name)').toBeTypeOf('function');
    expect(linkedRules!('entity', 'person')).toEqual([{ name: 'age-positive', ...AGE }, { name: 'title-long', ...TITLE }]);
  });

  it('is empty for a type that is not linked, and for a link whose entry has not loaded', () => {
    const { c, state } = mountTab({ listSchemaLibrary: () => of({ entries: [entry] }) as never });
    c.ngOnInit();
    state.schTypeSchemas = { ...state.schTypeSchemas, entity: { inline: emptyTypeSchemaState(), ghost: emptyTypeSchemaState({ _libRef: 'not-in-the-library' }) } };
    const linkedRules = (c as unknown as { linkedRules?(kt: KnowledgeType, name: string): RuleRow[] }).linkedRules?.bind(c);
    expect(linkedRules, 'the component has no linkedRules(kt, name)').toBeTypeOf('function');
    expect(linkedRules!('entity', 'inline')).toEqual([]);
    expect(linkedRules!('entity', 'ghost')).toEqual([]);
  });
});

// ── hop 4: the dirty snapshot and the save's diff ────────────────────────────────────────────────────────────────────

describe('snapshot and isDirty see rules at both levels', () => {
  /** Each edit starts from the same pristine state and must flip the dirty flag by itself. */
  const typeEdits: [string, (s: SpaceSettingsState) => void][] = [
    ['changing a type rule\'s text', s => { typeRules(s, 'entity', 'person')![0]!.rule = 'self.properties.age >= 18'; }],
    ['changing a type rule\'s message', s => { typeRules(s, 'entity', 'person')![0]!.message = 'Another sentence'; }],
    ['renaming a type rule', s => { typeRules(s, 'entity', 'person')![0]!.name = 'renamed'; }],
    ['adding a type rule', s => { setTypeRules(s, 'entity', 'person', [...typeRules(s, 'entity', 'person')!, { name: 'third', ...AGE }]); }],
    ['removing a type rule', s => { setTypeRules(s, 'entity', 'person', typeRules(s, 'entity', 'person')!.slice(1)); }],
  ];
  const spaceEdits: [string, (s: SpaceSettingsState) => void][] = [
    ['changing a space rule\'s text', s => { spaceRules(s)![0]!.rule = 'self.properties.at <= now + 1'; }],
    ['changing a space rule\'s message', s => { spaceRules(s)![0]!.message = 'Another sentence'; }],
    ['adding a kind to a space rule', s => { spaceRules(s)![0]!.kinds = [...spaceRules(s)![0]!.kinds, 'edge']; }],
    ['removing a kind from a space rule', s => { spaceRules(s)![0]!.kinds = spaceRules(s)![0]!.kinds.slice(1); }],
    ['clearing a space rule\'s kinds (a rule for one kind becomes a rule for all)', s => { spaceRules(s)![0]!.kinds = []; }],
    ['ticking a kind on an all-kinds space rule', s => { spaceRules(s)![1]!.kinds = ['entity']; }],
    ['adding a space rule', s => { setSpaceRules(s, [...spaceRules(s)!, { name: 'third', ...AGE, kinds: [] }]); }],
    ['removing a space rule', s => { setSpaceRules(s, spaceRules(s)!.slice(1)); }],
    ['removing the last space rule', s => { setSpaceRules(s, []); }],
  ];

  it('opening a ruled space and touching nothing is clean', () => {
    const s = makeState();
    s.openSettings(ruled());
    expect(s.isDirty()).toBe(false);
  });

  it.each(typeEdits)('%s makes the dialog dirty', (_label, edit) => {
    const s = stateWithRules();
    expect(s.isDirty()).toBe(false);
    edit(s);
    expect(s.isDirty()).toBe(true);
    s.markPristine();
    expect(s.isDirty()).toBe(false);
  });

  it.each(spaceEdits)('%s makes the dialog dirty', (_label, edit) => {
    const s = stateWithRules();
    // Removing the last rule needs one to remove.
    if (_label.includes('last')) {
      setSpaceRules(s, [{ name: 'only', ...AGE, kinds: [] }]);
      s.markPristine();
    }
    expect(s.isDirty()).toBe(false);
    edit(s);
    expect(s.isDirty()).toBe(true);
  });

  it('is part of the footer Save\'s payload, so the snapshot and the diff compare the same thing', () => {
    const s = stateWithRules();
    expect(JSON.stringify(s.settingsPayload())).toContain(AGE.rule);
    expect(JSON.stringify(s.settingsPayload())).toContain(FUTURE.rule);
  });
});

describe('changedSettings sends rules the way the server merges them', () => {
  it('opening a ruled space and saving nothing sends nothing', () => {
    const s = makeState();
    s.openSettings(ruled());
    expect(s.changedSettings()).toEqual({});
  });

  it('a changed space rule sends the WHOLE rules map, and nothing else of the meta', () => {
    const s = stateWithRules();
    spaceRules(s)![1]!.message = 'Another sentence';
    const out = s.changedSettings();
    expect(out['meta']).toEqual({
      rules: {
        'no-future': { rule: FUTURE.rule, message: FUTURE.message, kinds: ['chrono', 'fact'] },
        'few-tags': { rule: EVERYWHERE.rule, message: 'Another sentence' },
      },
    });
    // The rules map is per-name merged by the server, but a UI save sends it whole: the type-schema replace mode is
    // for `typeSchemas` alone and must not ride along with a rules-only change.
    expect(out['typeSchemasMode']).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('deleteFields');
  });

  it('removing one space rule sends the remaining ones whole', () => {
    const s = stateWithRules();
    setSpaceRules(s, spaceRules(s)!.slice(1));
    expect((out => out['meta'])(s.changedSettings())).toEqual({ rules: { 'few-tags': { rule: EVERYWHERE.rule, message: EVERYWHERE.message } } });
  });

  it('removing the LAST space rule sends an explicit empty map, not an omitted key', () => {
    const s = makeState();
    s.openSettings(space({ meta: { rules: { only: AGE } } as never }));
    setSpaceRules(s, []);
    expect(s.changedSettings()['meta']).toEqual({ rules: {} });
  });

  it('adding the first space rule to a space that had none sends it', () => {
    const s = makeState();
    s.openSettings(space());
    setSpaceRules(s, [{ name: 'first', ...AGE, kinds: ['entity'] }]);
    expect(s.changedSettings()['meta']).toEqual({ rules: { first: { rule: AGE.rule, message: AGE.message, kinds: ['entity'] } } });
  });

  it('a changed TYPE rule rides with typeSchemas, in replace mode, carrying every other type and its rules', () => {
    const s = stateWithRules();
    typeRules(s, 'entity', 'person')![0]!.message = 'Another sentence';
    const out = s.changedSettings();
    const meta = out['meta'] as { typeSchemas?: { entity: Record<string, unknown> }; rules?: unknown };
    expect(out['typeSchemasMode']).toBe('replace');
    expect(meta.rules, 'a type-rule edit must not resend the space rules').toBeUndefined();
    expect(wireRules(meta.typeSchemas!.entity['person'])).toEqual({
      'age-positive': { rule: AGE.rule, message: 'Another sentence' },
      'title-long': TITLE,
    });
  });
});

// ── hop 5: the save request ──────────────────────────────────────────────────────────────────────────────────────────

describe('a schema save is conditional on the version the dialog read (If-Match), and a 412 offers a reload', () => {
  let http: HttpTestingController;

  function mountPopup() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [SpaceSettingsPopupComponent, getTranslocoModule()],
      providers: [
        provideHttpClient(), provideHttpClientTesting(),
        // The REAL store and APIs over the fake HTTP backend: what a spec asserts is the request on the wire, not a
        // method signature, and the store's own reads simply stay pending.
        SpaceSettingsState, SpacesStore,
        { provide: SchemaApi, useValue: {
          listSchemaLibrary: () => of({ entries: [] }),
          getSchemaLayers: () => of({ spaceId: 'work', own: {}, layers: [], precedence: [], clashes: [] }),
        } },
        { provide: ToastService, useValue: { show: () => {}, error: () => {}, success: () => {}, info: () => {} } },
        { provide: ConfirmDialogService, useValue: { confirm: () => Promise.resolve(true) } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(SpaceSettingsPopupComponent);
    fixture.detectChanges();
    return fixture;
  }

  /** Stage a schema edit that is not a rule edit, so a rule-less implementation still sends the request. */
  function stageSchemaEdit(fixture: ReturnType<typeof mountPopup>, version: number | undefined) {
    const state = fixture.componentInstance.state;
    state.openSettings(space({ meta: { ...(version === undefined ? {} : { version }), typeSchemas: { entity: {}, fact: {}, edge: {}, chrono: {} } } as never }));
    state.schNewTypeInputs = { ...state.schNewTypeInputs, entity: 'widget' };
    state.addType('entity');
    fixture.detectChanges();
    return state;
  }

  const patch = () => http.expectOne(r => r.method === 'PATCH' && r.url === '/api/spaces/work');

  beforeEach(() => TestBed.resetTestingModule());

  it('the PATCH that saves a schema edit carries the meta version the dialog opened with as If-Match', () => {
    const fixture = mountPopup();
    stageSchemaEdit(fixture, 7);
    fixture.componentInstance.saveSettings();
    const req = patch();
    expect(req.request.headers.get('If-Match'), 'no If-Match on a schema save').not.toBeNull();
    // The server accepts a bare integer, the quoted entity-tag spelling and the weak form; all three name version 7.
    expect(req.request.headers.get('If-Match')).toMatch(/^(W\/)?"?7"?$/);
    req.flush({ space: space() });
  });

  it('a 412 answer is a settings error that offers a reload, and a 422 refusal does not', () => {
    const fixture = mountPopup();
    const state = stageSchemaEdit(fixture, 7);

    // A refusal of the CONTENT is not a conflict: no reload offer, the operator edits and saves again.
    fixture.componentInstance.saveSettings();
    patch().flush({ error: 'Invalid schema', issues: [] }, { status: 422, statusText: 'Unprocessable Entity' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="reload-schema"]')).toBeNull();

    // Somebody else saved first: the precondition failed.
    fixture.componentInstance.saveSettings();
    patch().flush({ error: 'precondition_failed', message: 'The space meta is at version 8, not 7' }, { status: 412, statusText: 'Precondition Failed' });
    fixture.detectChanges();
    expect(state.settingsError(), 'a 412 left no settings error').not.toBe('');
    const reload = fixture.nativeElement.querySelector('.sp-footer [data-testid="reload-schema"]') as HTMLElement | null;
    expect(reload, 'the footer offers no reload after a 412').not.toBeNull();
    expect(reload!.tagName).toBe('BUTTON');
  });
});
