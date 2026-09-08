/**
 * SpaceSettingsState — characterization tests, RELOCATED from spaces.component.spec.ts (A17.8b).
 *
 * These assertions are unchanged from the ones written against the original 1893-line
 * SpacesComponent (PR #237) and proven green there. Only the OWNER moved: `openSettings`,
 * `buildMeta`, the type-schema helpers and the duplicate-rule helpers now live on this service, so
 * the tests follow them. Nothing here was rewritten to make the refactor pass — the same inputs are
 * asserted to produce the same outputs, which is the whole point of having landed them first.
 *
 * They test a plain service now rather than a rendered component, so they run without TestBed
 * component fixtures. That is a side benefit of the extraction, not a change in what is covered.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { of, throwError } from 'rxjs';
import { SpacesApi } from '../../core/spaces-api.service';
import type { Space } from '../../core/api.types';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { SpaceSettingsState, emptyTypeSchemaState } from './space-settings-state.service';

function space(over: Partial<Space> = {}): Space {
  return { id: 'work', label: 'Work', ...over } as Space;
}

const STATS = { spaceId: 'work', memories: 1, entities: 2, edges: 3, chrono: 4, files: 5 };

function make(statsFails = false) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [getTranslocoModule()],
    providers: [
      SpaceSettingsState,
      { provide: SpacesApi, useValue: { getSpaceStats: () => statsFails ? throwError(() => new Error('boom')) : of(STATS) } },
    ],
  });
  return TestBed.inject(SpaceSettingsState);
}

describe('an edge label\'s ends and cardinality survive being opened', () => {
  /*
   * The bug this pins, and how it was found.
   *
   * `typeSchemaFromState` has written `endpoints` and `functional` since S-1, added specifically so a UI save
   * could not delete a declaration an API caller had made. It wrote `state.endpoints` — and `openSettings`
   * never filled it. So the declaration was dropped on load and written back as absent: opening Space
   * Settings and pressing Save DELETED it, silently, with nothing in the dialog that even named the field.
   *
   * The carry-through was tested at the serialiser, with a state object built by hand. Nothing asked the
   * LOADER, so both halves passed and the round trip did not. It surfaced only when the control existed and
   * the boxes came up empty against an instance where the API had declared the rule.
   *
   * These assert both directions against the same fixture, which is the only shape that could have caught it.
   */
  const declared = space({
    id: 'work',
    meta: {
      typeSchemas: {
        entity: { person: {} },
        edge: {
          reports_to: { endpoints: { from: ['person'], to: ['person', 'UNTYPED'] }, functional: true },
          mentions: { endpoints: { to: ['document'] } },
          plain: {},
        },
      },
    },
  } as Partial<Space>);

  it('loads what the API declared into the editor state', () => {
    const c = make();
    c.openSettings(declared);
    expect(c.typeState('edge', 'reports_to').endpoints).toEqual({ from: ['person'], to: ['person', 'UNTYPED'] });
    expect(c.typeState('edge', 'reports_to').functional).toBe(true);
    // One side only stays one side: an absent `from` must not become an empty array, which the API refuses.
    expect(c.typeState('edge', 'mentions').endpoints).toEqual({ to: ['document'] });
    expect(c.typeState('edge', 'plain').endpoints).toBeUndefined();
    expect(c.typeState('edge', 'plain').functional).toBeUndefined();
  });

  it('and writes it back unchanged when nothing was edited', () => {
    const c = make();
    c.openSettings(declared);
    const out = c.buildMeta().typeSchemas!.edge!;
    expect(out['reports_to']).toMatchObject({ endpoints: { from: ['person'], to: ['person', 'UNTYPED'] }, functional: true });
    expect(out['mentions']).toMatchObject({ endpoints: { to: ['document'] } });
    expect(out['plain'].endpoints).toBeUndefined();
  });

  it('copies the lists by VALUE, so editing the draft cannot reach back into the space object', () => {
    /*
     * The same rule the duplicate-rule copy above pins, and it matters more here: the arrays are mutated in
     * place by the picker, so a shared reference would edit the loaded space as the operator clicked — and a
     * Cancel would have nothing to restore.
     */
    const c = make();
    c.openSettings(declared);
    c.typeState('edge', 'reports_to').endpoints!.from!.push('team');
    expect(declared.meta!.typeSchemas!.edge!['reports_to'].endpoints!.from).toEqual(['person']);
  });
});

describe('SpaceSettingsState — openSettings populates every tab', () => {
  const rich = space({
    id: 'work', label: 'Work', maxGiB: 7, recordTtlDays: 90,
    dupeRules: [{ minScore: 0.9, action: 'flag' }],
    dupeMergeSurvivor: 'newer',
    dupeRulesOnInsert: true,
    meta: {
      purpose: 'p', usageNotes: 'u', validationMode: 'strict', strictLinkage: true,
      tagSuggestions: ['a', 'b'],
      typeSchemas: { entity: { person: { namingPattern: '^[A-Z]', tagSuggestions: ['t'], propertySchemas: { age: { type: 'number', minimum: 0 } } } } },
    },
  } as Partial<Space>);

  it('resets to the settings tab and the entity schema sub-tab', () => {
    const c = make();
    c.settingsTab.set('danger');
    c.schemaCollTab.set('edge');
    c.openSettings(rich);
    expect(c.settingsTab()).toBe('settings');
    expect(c.schemaCollTab()).toBe('entity');
  });

  it('copies the space into the settings form', () => {
    const c = make();
    c.openSettings(rich);
    expect(c.stForm).toEqual({ label: 'Work', purpose: 'p', usageNotes: 'u', maxGiB: 7, documentExtraction: '', imageAnalysis: '', audioAnalysis: '', videoAnalysis: '', textAnalysis: '' });
  });

  it('copies duplicate rules by VALUE — editing the form must not mutate the space object', () => {
    const c = make();
    c.openSettings(rich);
    expect(c.dupeRulesState).toEqual([{ minScore: 0.9, action: 'flag' }]);
    expect(c.dupeSurvivor).toBe('newer');
    expect(c.dupeOnInsert).toBe(true);

    c.dupeRulesState[0]!.minScore = 0.1;
    expect(rich.dupeRules![0]!.minScore).toBe(0.9); // original untouched
  });

  it('copies schema state, including tag suggestions by value', () => {
    const c = make();
    c.openSettings(rich);
    expect(c.schValidation).toBe('strict');
    expect(c.schStrictLinkage).toBe(true);
    // `tagSuggestions` was REMOVED in 3.0 and is no longer read into the form. The fixture still carries
    // one, on purpose: a list already in config.json must be left exactly where it is, not migrated and
    // not destroyed, and `openSettings` reading nothing is the first half of that.
    expect((c as unknown as Record<string, unknown>)['schTagSuggestions']).toBeUndefined();
  });

  it('flattens a type schema into editable state (propertySchemas becomes a keyed list)', () => {
    const c = make();
    c.openSettings(rich);
    expect(c.typeNames('entity')).toEqual(['person']);
    expect(c.typeCount('entity')).toBe(1);
    const st = c.typeState('entity', 'person');
    expect(st.namingPattern).toBe('^[A-Z]');
    expect((st as unknown as Record<string, unknown>)['tagSuggestions']).toBeUndefined();
    expect(st.propertySchemas).toEqual([{ key: 'age', s: { type: 'number', minimum: 0 }, _enumInput: '' }]);
  });

  it('copies a per-space documentExtraction override into the form, and clears to "" when absent (F11-c)', () => {
    const c = make();
    c.openSettings(space({ id: 'ov', label: 'Ov', documentExtraction: 'repair' } as Partial<Space>));
    expect(c.stForm.documentExtraction).toBe('repair');
    // A space with no override maps to '' (inherit instance default).
    c.openSettings(space({ id: 'plain', label: 'Plain' } as Partial<Space>));
    expect(c.stForm.documentExtraction).toBe('');
  });

  it('copies per-space media-analysis overrides into the form, clearing to "" when absent', () => {
    const c = make();
    c.openSettings(space({ id: 'm', label: 'M', imageAnalysis: 'recognition', audioAnalysis: 'off', videoAnalysis: 'full', textAnalysis: 'chunk' } as Partial<Space>));
    expect([c.stForm.imageAnalysis, c.stForm.audioAnalysis, c.stForm.videoAnalysis, c.stForm.textAnalysis])
      .toEqual(['recognition', 'off', 'full', 'chunk']);
    c.openSettings(space({ id: 'plain2', label: 'Plain2' } as Partial<Space>));
    expect([c.stForm.imageAnalysis, c.stForm.audioAnalysis, c.stForm.videoAnalysis, c.stForm.textAnalysis])
      .toEqual(['', '', '', '']);
  });

  it('defaults everything when the space has no meta at all', () => {
    const bare = space({ id: 'bare', label: 'Bare' });
    const c = make();
    c.openSettings(bare);
    expect(c.stForm).toEqual({ label: 'Bare', purpose: '', usageNotes: '', maxGiB: null, documentExtraction: '', imageAnalysis: '', audioAnalysis: '', videoAnalysis: '', textAnalysis: '' });
    expect(c.schValidation).toBe('off');
    expect(c.schStrictLinkage).toBe(false);
    expect(c.typeNames('entity')).toEqual([]);
    expect(c.dupeRulesState).toEqual([]);
    expect(c.dupeSurvivor).toBe('older');
    expect(c.dupeOnInsert).toBe(false);
  });

  it('loads wipe stats for the danger tab, clearing the loading flag', () => {
    const c = make();
    c.openSettings(rich);
    expect(c.dangerWipeStats()).toEqual(STATS);
    expect(c.dangerWipeLoading()).toBe(false);
    expect(c.dangerRenameId).toBe('work');
  });

  it('a failing stats call still clears the loading flag', () => {
    const c = make(true);
    c.openSettings(space());
    expect(c.dangerWipeLoading()).toBe(false);
    expect(c.dangerWipeStats()).toBeNull();
  });
});

describe('SpaceSettingsState — buildMeta (what actually gets saved)', () => {
  it('always emits validationMode, and omits blank purpose/usageNotes', () => {
    const c = make();
    c.openSettings(space());
    // `typeSchemas` is now always present (see the deletion test below), so the blank-field assertion is
    // made against the other keys rather than the whole object.
    expect(c.buildMeta()).toMatchObject({ validationMode: 'off' });
    expect(c.buildMeta().purpose).toBeUndefined();
    expect(c.buildMeta().usageNotes).toBeUndefined();
  });

  it('trims purpose and usageNotes', () => {
    const c = make();
    c.openSettings(space());
    c.stForm.purpose = '  p  ';
    c.stForm.usageNotes = '  u  ';
    expect(c.buildMeta()).toMatchObject({ purpose: 'p', usageNotes: 'u' });
  });

  it('emits strictLinkage only when true, and never emits the removed tagSuggestions', () => {
    const c = make();
    c.openSettings(space());
    expect(c.buildMeta().strictLinkage).toBeUndefined();
    c.schStrictLinkage = true;
    expect(c.buildMeta()).toMatchObject({ strictLinkage: true });
    // Removed in 3.0. `SpaceMetaBody` is `.strict()`, so a client still emitting it would 400 its own
    // save — which is why this asserts absence rather than merely stopping at "we do not set it".
    expect((c.buildMeta() as unknown as Record<string, unknown>)['tagSuggestions']).toBeUndefined();
  });

  it('a stored per-type tagSuggestions list is dropped on the next save of that type', () => {
    // This test used to assert the OPPOSITE, and it was right to. Until 3.0 the field was retired but
    // kept, and the round-trip was load-bearing: `planSpaceMetaUpdate` merges typeSchemas per-KT and then
    // per-type-NAME (`{ ...existingTs[kt], ...ktMap }`), so an incoming type REPLACES its whole schema
    // object. A client that stopped carrying the field would have destroyed an operator's list on their
    // next unrelated edit.
    //
    // 3.0 removes the field, so that destruction is now the intended outcome rather than an accident —
    // and it is asserted here rather than left to be discovered, because "stored values are preserved"
    // is true of the SPACE-level field (a scalar the merge leaves alone when absent) and NOT of this one.
    const c = make();
    c.openSettings(space({
      meta: { typeSchemas: { entity: { person: { namingPattern: '^[A-Z]', tagSuggestions: ['t'] } } } },
    } as Partial<Space>));
    const st = c.typeState('entity', 'person');
    expect((st as unknown as Record<string, unknown>)['tagSuggestions']).toBeUndefined();

    // Edit something else entirely, exactly as an operator would.
    st.namingPattern = '^[a-z]';

    const saved = c.buildMeta().typeSchemas!.entity!['person']!;
    expect((saved as unknown as Record<string, unknown>)['tagSuggestions']).toBeUndefined();
    expect(saved.namingPattern).toBe('^[a-z]');
  });

  it('namingPattern is entity-only — the same state on a memory type is dropped', () => {
    const c = make();
    c.openSettings(space());
    c.schTypeSchemas.entity = { person: emptyTypeSchemaState({ namingPattern: '^A' }) };
    c.schTypeSchemas.memory = { note: emptyTypeSchemaState({ namingPattern: '^A' }) };
    const meta = c.buildMeta();
    expect(meta.typeSchemas!.entity!['person']).toEqual({ namingPattern: '^A' });
    expect(meta.typeSchemas!.memory!['note']).toEqual({});
  });

  it('maps a property schema field-by-field, omitting empty ones', () => {
    const c = make();
    c.openSettings(space());
    c.schTypeSchemas.entity = { person: emptyTypeSchemaState({
      propertySchemas: [{ key: 'age', s: { type: 'number', minimum: 0, maximum: 5, pattern: '  ', enum: [], required: true }, _enumInput: '' }],
    }) };
    const ps = c.buildMeta().typeSchemas!.entity!['person']!.propertySchemas!['age']!;
    expect(ps).toEqual({ type: 'number', minimum: 0, maximum: 5, required: true });
    expect(ps.pattern).toBeUndefined(); // whitespace-only pattern dropped
    expect(ps.enum).toBeUndefined();    // empty enum dropped
  });

  it('emits an empty typeSchemas when no type is defined — it used to omit it, and that lost deletions', () => {
    // Changed deliberately. This assertion previously read `toBeUndefined()`, pinning the behaviour that
    // made a schema-type deletion impossible to save: an omitted key told the server nothing, so its
    // merge kept what it had, and the delete survived the save only in the UI. An absent key and an empty
    // object have to mean different things for "this space declares nothing" to be expressible at all.
    const c = make();
    c.openSettings(space());
    const ts = c.buildMeta().typeSchemas;
    expect(ts).toBeDefined();
    expect(ts!.entity).toEqual({});
  });
});

/**
 * Per-type retention (the SCHEMA tier of record > schema > space).
 *
 * The reason this needs its own block rather than one assertion: the PATCH merge REPLACES a named type's
 * definition wholesale, so a save that emits `retention` and forgets `propertySchemas` does not merely fail
 * to add a window — it deletes the type's property rules on a `validationMode: strict` space and breaks
 * every subsequent write to it. A canary operator asked about exactly that before touching their four types.
 */
describe('SpaceSettingsState — per-type retention', () => {
  const withWindows = space({
    meta: { typeSchemas: {
      chrono: { event: { retention: { days: 90, contentDays: 30 }, propertySchemas: { alertname: { type: 'string' } } } },
      entity: { person: { namingPattern: '^[A-Z]', retention: { days: 400 } } },
    } },
  } as Partial<Space>);

  it('loads both windows off the wire and writes them back unchanged', () => {
    const c = make();
    c.openSettings(withWindows);
    expect(c.typeState('chrono', 'event').retentionDays).toBe(90);
    expect(c.typeState('chrono', 'event').retentionContentDays).toBe(30);
    expect(c.buildMeta().typeSchemas!.chrono!['event']!.retention).toEqual({ days: 90, contentDays: 30 });
  });

  it('carries propertySchemas and namingPattern through with it — the merge REPLACES the type', () => {
    const c = make();
    c.openSettings(withWindows);
    c.typeState('chrono', 'event').retentionDays = 60;      // edit only the window
    const chrono = c.buildMeta().typeSchemas!.chrono!['event']!;
    expect(chrono.retention).toEqual({ days: 60, contentDays: 30 });
    expect(chrono.propertySchemas).toEqual({ alertname: { type: 'string' } });
    const person = c.buildMeta().typeSchemas!.entity!['person']!;
    expect(person.namingPattern).toBe('^[A-Z]');
    expect(person.retention).toEqual({ days: 400 });
  });

  it('an empty field means inherit — no retention key at all, never a zero', () => {
    const c = make();
    c.openSettings(space());
    c.schTypeSchemas.chrono = { event: emptyTypeSchemaState() };
    expect(c.buildMeta().typeSchemas!.chrono!['event']).toEqual({});
  });

  it('a cleared field removes the window that was loaded', () => {
    const c = make();
    c.openSettings(withWindows);
    c.typeState('chrono', 'event').retentionDays = null;
    c.typeState('chrono', 'event').retentionContentDays = null;
    expect(c.buildMeta().typeSchemas!.chrono!['event']!.retention).toBeUndefined();
  });

  it('rejects a value the API would 400 on — zero, negative, fractional, or a numeric string', () => {
    const c = make();
    c.openSettings(space());
    for (const bad of [0, -5, 1.5, '' as unknown as number]) {
      c.schTypeSchemas.chrono = { event: emptyTypeSchemaState({ retentionDays: bad }) };
      expect(c.buildMeta().typeSchemas!.chrono!['event']!.retention, `days=${bad}`).toBeUndefined();
    }
    // A number input bound with ngModel can hand back a STRING. It must be sent as a number or the
    // server rejects a field the operator filled in correctly.
    c.schTypeSchemas.chrono = { event: emptyTypeSchemaState({ retentionDays: '45' as unknown as number }) };
    expect(c.buildMeta().typeSchemas!.chrono!['event']!.retention).toEqual({ days: 45 });
  });

  it('contentDays is chrono-only — set on any other collection it is dropped, not stored dead', () => {
    const c = make();
    c.openSettings(space());
    for (const kt of ['entity', 'memory', 'edge'] as const) {
      c.schTypeSchemas[kt] = { thing: emptyTypeSchemaState({ retentionDays: 30, retentionContentDays: 10 }) };
      expect(c.buildMeta().typeSchemas![kt]!['thing']!.retention, kt).toEqual({ days: 30 });
    }
  });

  it('a $ref type never emits retention — the library entry schema has no such field', () => {
    const c = make();
    c.openSettings(space());
    c.schTypeSchemas.chrono = { event: emptyTypeSchemaState({ _libRef: 'events-v1', retentionDays: 90 }) };
    expect(c.buildMeta().typeSchemas!.chrono!['event']).toEqual({ $ref: 'library:events-v1' });
  });

  it('counts as a change, so the footer Save lights up for it', () => {
    const c = make();
    c.openSettings(withWindows);
    expect(c.isDirty()).toBe(false);
    c.typeState('chrono', 'event').retentionDays = 45;
    expect(c.isDirty()).toBe(true);
  });

  it('the settings form no longer carries the SPACE window at all', () => {
    // It moved to the Danger Zone, which saves itself. Keeping a copy here was harmless while the tier was one
    // number and is not now: the space tier is five buckets and a scalar write REPLACES the whole object, so a
    // label edit going through the footer save would have flattened every per-collection window to one figure.
    const c = make();
    c.openSettings(space({ recordTtlDays: { entity: 365, chrono: 30 } } as unknown as Partial<Space>));
    expect('recordTtlDays' in c.stForm).toBe(false);
    expect(c.snapshot()).not.toContain('recordTtlDays');
  });
});

describe('SpaceSettingsState — library $ref round-trip (openSettings -> buildMeta)', () => {
  // The one that matters most: a library-linked type schema arrives as `$ref: "library:<name>"`,
  // is held as a private `_libRef` sentinel while editing, and must be emitted as `$ref` again.
  // Lose the sentinel and saving a space silently converts a linked schema into an empty inline one.
  const linked = space({
    id: 'work', label: 'Work',
    meta: { typeSchemas: { entity: { person: { $ref: 'library:people-v1' } } } },
  } as Partial<Space>);

  it('a $ref type survives open -> save unchanged', () => {
    const c = make();
    c.openSettings(linked);
    expect(c.buildMeta().typeSchemas!.entity!['person']).toEqual({ $ref: 'library:people-v1' });
  });

  it('the $ref type is exposed to the UI as a named type carrying its library ref', () => {
    const c = make();
    c.openSettings(linked);
    expect(c.typeNames('entity')).toEqual(['person']);
    expect(c.typeLibRef('entity', 'person')).toBe('people-v1');
  });

  it('a $ref type emits ONLY $ref — never the empty inline fields it is stored with', () => {
    const c = make();
    c.openSettings(linked);
    const out = c.buildMeta().typeSchemas!.entity!['person']!;
    expect(Object.keys(out)).toEqual(['$ref']);
  });

  it('a non-library $ref is NOT treated as a library link', () => {
    const other = space({ id: 'w', label: 'W', meta: { typeSchemas: { entity: { person: { $ref: 'elsewhere:x' } } } } } as Partial<Space>);
    const c = make();
    c.openSettings(other);
    expect(c.typeLibRef('entity', 'person')).toBeNull();
  });
});

describe('SpaceSettingsState — duplicate rules', () => {
  it('addDupeRule appends and removeDupeRule deletes by index', () => {
    const c = make();
    c.openSettings(space());
    c.addDupeRule();
    c.addDupeRule();
    expect(c.dupeRulesState).toHaveLength(2);
    c.dupeRulesState[0]!.action = 'automerge';
    c.removeDupeRule(1);
    expect(c.dupeRulesState).toHaveLength(1);
    expect(c.dupeRulesState[0]!.action).toBe('automerge');
  });

  it('hasAutomergeRule reflects whether any rule is an automerge', () => {
    const c = make();
    c.openSettings(space());
    c.addDupeRule();
    expect(c.hasAutomergeRule()).toBe(false);
    c.dupeRulesState[0]!.action = 'automerge';
    expect(c.hasAutomergeRule()).toBe(true);
  });

  // NEW (not a relocation): the extraction exposed that my hand-written copy of addDupeRule had
  // drifted — wrong minScore default, and the dupeSaved reset dropped. The original characterization
  // suite did not assert either, so it stayed silent. Pinning both now so it cannot drift again.
  it('a new rule defaults to minScore 0.95 / flag, and clears the saved indicator', () => {
    const c = make();
    c.openSettings(space());
    c.dupeSaved.set(true);
    c.addDupeRule();
    expect(c.dupeRulesState[0]).toEqual({ minScore: 0.95, action: 'flag' });
    expect(c.dupeSaved()).toBe(false);
  });

  it('removing a rule also clears the saved indicator', () => {
    const c = make();
    c.openSettings(space());
    c.addDupeRule();
    c.dupeSaved.set(true);
    c.removeDupeRule(0);
    expect(c.dupeSaved()).toBe(false);
  });
});

describe('the settings save sends only what changed', () => {
  /*
   * `PATCH /api/spaces/:id` governs each field by the area that owns it since 4.4 — a media level is
   * `files` write, the quota is instance-admin. Posting every field on every save makes the HIGHEST
   * requirement in the form decide, so a token holding exactly what it needs to change one thing is
   * refused for the twenty-one it did not touch. The per-field rungs were real on the API and inert here.
   */
  it('an untouched dialog has nothing to send', () => {
    const s = make();
    s.openSettings(space());
    s.markPristine();
    expect(s.changedSettings()).toEqual({});
  });

  it('one edited field is the whole body', () => {
    const s = make();
    s.openSettings(space());
    s.markPristine();
    s.stForm.imageAnalysis = 'caption';
    expect(s.changedSettings()).toEqual({ imageAnalysis: 'caption' });
  });

  it('meta is diffed per KEY, not sent whole because one field inside it moved', () => {
    // Sending the object would put `purpose` (space administrator) and `suppressEmbeddings` (knowledge
    // admin) into a request that meant to change a validation mode.
    const s = make();
    s.openSettings(space({ meta: { purpose: 'notes' } } as Partial<Space>));
    s.markPristine();
    s.schValidation = 'strict';
    const body = s.changedSettings();
    expect(Object.keys(body)).toEqual(['meta']);
    expect(body['meta']).toEqual({ validationMode: 'strict' });
  });

  it('typeSchemasMode rides with typeSchemas, and never travels alone', () => {
    // Without it the server MERGES, so a type deleted in the editor is not mentioned and is preserved —
    // the deletion appears to work and is still there on reload. With no `typeSchemas` beside it, though,
    // `replace` is a mode for a map that is not in the body.
    const s = make();
    s.openSettings(space());
    s.markPristine();
    s.schTypeSchemas.entity = { widget: emptyTypeSchemaState() };
    const withSchemas = s.changedSettings();
    expect(withSchemas['typeSchemasMode']).toBe('replace');
    expect(Object.keys(withSchemas['meta'] as object)).toContain('typeSchemas');

    const t = make();
    t.openSettings(space());
    t.markPristine();
    t.stForm.label = 'Renamed';
    expect(t.changedSettings()).toEqual({ label: 'Renamed' });
  });

  it('recordTtlDays is not in this payload at all', () => {
    // It is edited in the Danger Zone, which saves itself, and the space tier is five buckets — a scalar
    // write REPLACES the whole object, so echoing a stored value back would flatten every per-collection
    // window to one figure.
    const s = make();
    s.openSettings(space({ recordTtlDays: 30 } as Partial<Space>));
    s.markPristine();
    s.stForm.label = 'Renamed';
    expect(s.changedSettings()).not.toHaveProperty('recordTtlDays');
    expect(s.settingsPayload()).not.toHaveProperty('recordTtlDays');
  });
});
