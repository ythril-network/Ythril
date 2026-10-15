/**
 * SpaceSchemaTabComponent + SpaceSettingsState (schema slice) characterization tests.
 *
 * Written BEFORE the PR-U4 master/detail redesign and proven green against the ORIGINAL code, so the
 * redesign has a safety net. Two groups:
 *
 *  (A) Accordion state on SpaceSettingsState — the CURRENT single-expand behaviour the redesign will
 *      deliberately change (to "more than one type open at once"). Pinning it makes that behaviour
 *      change explicit and reviewable rather than accidental.
 *  (B) The component's import-conflict + schema-library logic, which must survive the redesign
 *      UNCHANGED (only the conflict dialog's hardcoded English strings get translated).
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { of } from 'rxjs';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { SpaceSchemaTabComponent } from './space-schema-tab.component';
import { SpaceSettingsState, emptyTypeSchemaState, type TypeSchemaState } from './space-settings-state.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { SchemaApi } from '../../core/schema-api.service';
import { ToastService } from '../../core/toast.service';
import { AuthApi } from '../../core/auth-api.service';
import type { Space } from '../../core/api.types';

const mkType = (over: Partial<TypeSchemaState> = {}): TypeSchemaState => emptyTypeSchemaState(over);

/** Captures what the component told the user, so a warning can be asserted rather than assumed. */
const toasts: { kind: string; msg: string }[] = [];

function setup(schemaApi: Partial<SchemaApi> = {}) {
  toasts.length = 0;
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [SpaceSchemaTabComponent, getTranslocoModule()],
    providers: [
      SpaceSettingsState,
      { provide: SpacesApi, useValue: {} },
      { provide: ToastService, useValue: {
        show: () => {},
        error:   (msg: string) => toasts.push({ kind: 'error', msg }),
        success: (msg: string) => toasts.push({ kind: 'success', msg }),
        info:    (msg: string) => toasts.push({ kind: 'info', msg }),
      } },
      { provide: SchemaApi, useValue: { listSchemaLibrary: () => of({ entries: [] }), upsertSchemaLibraryEntry: () => of({ entry: {} }), ...schemaApi } },
    ],
  });
  const fixture = TestBed.createComponent(SpaceSchemaTabComponent);
  const c = fixture.componentInstance;
  const state = TestBed.inject(SpaceSettingsState);
  return { c, state };
}

describe('SpaceSettingsState — schema master/detail selection + multi-open properties (U4)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('addType inserts the type and auto-selects it (shown in the detail pane)', () => {
    const { state } = setup();
    state.schNewTypeInputs = { ...state.schNewTypeInputs, entity: 'Service' };
    state.addType('entity');
    expect(state.typeNames('entity')).toContain('Service');
    expect(state.isTypeSelected('entity', 'Service')).toBe(true);
  });

  it('selectType is single-select: selecting a second type deselects the first (one detail pane)', () => {
    const { state } = setup();
    state.schTypeSchemas = { ...state.schTypeSchemas, entity: { A: mkType(), B: mkType() } };
    state.selectType('entity', 'A');
    expect(state.isTypeSelected('entity', 'A')).toBe(true);
    state.selectType('entity', 'B');
    expect(state.isTypeSelected('entity', 'B')).toBe(true);
    expect(state.isTypeSelected('entity', 'A')).toBe(false); // master/detail shows one type at a time
  });

  it('removeType clears the selection when the removed type was selected', () => {
    const { state } = setup();
    state.schTypeSchemas = { ...state.schTypeSchemas, entity: { A: mkType() } };
    state.selectType('entity', 'A');
    state.removeType('entity', 'A');
    expect(state.typeNames('entity')).not.toContain('A');
    expect(state.isTypeSelected('entity', 'A')).toBe(false);
  });

  it('addProp auto-expands the new property; removeProp clears it', () => {
    const { state } = setup();
    state.schTypeSchemas = { ...state.schTypeSchemas, entity: { A: mkType({ _newPropInput: 'cost' }) } };
    state.addProp('entity', 'A');
    expect(state.typeState('entity', 'A').propertySchemas.map(p => p.key)).toContain('cost');
    expect(state.isPropExpanded('entity', 'A', 'cost')).toBe(true);
    state.removeProp('entity', 'A', 'cost');
    expect(state.isPropExpanded('entity', 'A', 'cost')).toBe(false);
  });

  it('property editors are multi-open: expanding a second property keeps the first open', () => {
    const { state } = setup();
    state.schTypeSchemas = {
      ...state.schTypeSchemas,
      entity: { A: mkType({ propertySchemas: [{ key: 'a', s: {}, _enumInput: '' }, { key: 'b', s: {}, _enumInput: '' }] }) },
    };
    state.togglePropExpand('entity', 'A', 'a');
    state.togglePropExpand('entity', 'A', 'b');
    expect(state.isPropExpanded('entity', 'A', 'a')).toBe(true); // ← stays open (was single-expand before U4)
    expect(state.isPropExpanded('entity', 'A', 'b')).toBe(true);
    state.togglePropExpand('entity', 'A', 'a'); // toggle closes just this one
    expect(state.isPropExpanded('entity', 'A', 'a')).toBe(false);
    expect(state.isPropExpanded('entity', 'A', 'b')).toBe(true);
  });
});

describe('SpaceSchemaTabComponent — import-conflict resolution (must survive the redesign)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('resolveImportConflictOverride replaces the existing type and dismisses the dialog', () => {
    const { c, state } = setup();
    state.schTypeSchemas = { ...state.schTypeSchemas, entity: { Svc: mkType({ namingPattern: 'old' }) } };
    const incoming = mkType({ namingPattern: 'new' });
    c.importConflict.set({ kt: 'entity', name: 'Svc', state: incoming, allowAddAs: true });
    c.resolveImportConflictOverride();
    expect(state.typeState('entity', 'Svc').namingPattern).toBe('new');
    expect(c.importConflict()).toBeNull();
  });

  it('resolveImportConflictAddAs stores under the new name', () => {
    const { c, state } = setup();
    state.schTypeSchemas = { ...state.schTypeSchemas, entity: { Svc: mkType() } };
    c.importConflict.set({ kt: 'entity', name: 'Svc', state: mkType({ namingPattern: 'copy' }), allowAddAs: true });
    c.importConflictAddAsName.set('Svc-2');
    c.resolveImportConflictAddAs();
    expect(state.typeNames('entity')).toEqual(expect.arrayContaining(['Svc', 'Svc-2']));
    expect(state.typeState('entity', 'Svc-2').namingPattern).toBe('copy');
    expect(c.importConflict()).toBeNull();
  });

  it('resolveImportConflictAddAs refuses a name that also collides (keeps the dialog open)', () => {
    const { c, state } = setup();
    state.schTypeSchemas = { ...state.schTypeSchemas, entity: { Svc: mkType(), Other: mkType() } };
    c.importConflict.set({ kt: 'entity', name: 'Svc', state: mkType(), allowAddAs: true });
    c.importConflictAddAsName.set('Other'); // already exists
    c.resolveImportConflictAddAs();
    expect(c.importConflict()).not.toBeNull(); // still open, nothing added under a 3rd name
    expect(state.typeCount('entity')).toBe(2);
  });

  it('dismissImportConflict clears the conflict and the add-as name', () => {
    const { c } = setup();
    c.importConflict.set({ kt: 'entity', name: 'Svc', state: mkType(), allowAddAs: true });
    c.importConflictAddAsName.set('Svc-2');
    c.dismissImportConflict();
    expect(c.importConflict()).toBeNull();
    expect(c.importConflictAddAsName()).toBe('');
  });
});

describe('SpaceSchemaTabComponent — schema-library link (must survive the redesign)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('saveTypeToLibrary posts the derived slug + schema, then converts the type to a $ref', () => {
    const upsert = vi.fn().mockReturnValue(of({ entry: { name: 'service' } }));
    const { c, state } = setup({ upsertSchemaLibraryEntry: upsert as never });
    state.schTypeSchemas = {
      ...state.schTypeSchemas,
      entity: { Service: mkType({ namingPattern: '^S', propertySchemas: [{ key: 'cost', s: { type: 'number', required: true }, _enumInput: '' }] }) },
    };
    c.saveTypeToLibrary('entity', 'Service');
    expect(upsert).toHaveBeenCalledTimes(1);
    const [entryName, body] = upsert.mock.calls[0];
    expect(entryName).toBe('service'); // lower-cased slug
    expect(body).toMatchObject({ knowledgeType: 'entity', typeName: 'Service' });
    expect(body.schema.propertySchemas.cost).toMatchObject({ type: 'number', required: true });
    // type is now a library reference
    expect(state.typeLibRef('entity', 'Service')).toBe('service');
  });

  it('importFromLibraryRef links an existing type as a $ref', () => {
    const { c, state } = setup();
    state.schTypeSchemas = { ...state.schTypeSchemas, entity: { Svc: mkType() } };
    (c as unknown as { _libPickerTarget: unknown })._libPickerTarget = { kt: 'entity', name: 'Svc' };
    c.importFromLibraryRef({ name: 'shared-svc', knowledgeType: 'entity', typeName: 'Svc' } as never);
    expect(state.typeLibRef('entity', 'Svc')).toBe('shared-svc');
  });

  it('importFromLibraryRef as a NEW type whose name collides opens the conflict dialog (no add-as)', () => {
    const { c, state } = setup();
    state.schTypeSchemas = { ...state.schTypeSchemas, entity: { Svc: mkType() } };
    (c as unknown as { _libPickerTarget: unknown })._libPickerTarget = { kt: 'entity', name: '' }; // new-type flow
    c.importFromLibraryRef({ name: 'shared', knowledgeType: 'entity', typeName: 'Svc' } as never);
    expect(c.importConflict()).toMatchObject({ kt: 'entity', name: 'Svc', allowAddAs: false });
  });

  it('linkedProps resolves the linked library entry properties for the read-only view', () => {
    const entry = { name: 'shared-svc', knowledgeType: 'entity', typeName: 'Svc',
      schema: { propertySchemas: { cost: { type: 'number', required: true } } } };
    const { c, state } = setup({ listSchemaLibrary: () => of({ entries: [entry] }) as never });
    c.ngOnInit(); // loads libEntriesByName from the (mocked) library
    state.schTypeSchemas = { ...state.schTypeSchemas, entity: { Svc: { ...mkType(), _libRef: 'shared-svc' } } };
    expect(c.linkedProps('entity', 'Svc')).toEqual([{ key: 'cost', s: { type: 'number', required: true } }]);
  });

  it('unlinkType inlines the library schema and drops the $ref (type becomes editable)', () => {
    const entry = { name: 'shared-svc', knowledgeType: 'entity', typeName: 'Svc',
      schema: { namingPattern: '^S', propertySchemas: { cost: { type: 'number', required: true } } } };
    const { c, state } = setup({ listSchemaLibrary: () => of({ entries: [entry] }) as never });
    c.ngOnInit();
    state.schTypeSchemas = { ...state.schTypeSchemas, entity: { Svc: { ...mkType(), _libRef: 'shared-svc' } } };
    expect(state.typeLibRef('entity', 'Svc')).toBe('shared-svc');

    c.unlinkType('entity', 'Svc');

    expect(state.typeLibRef('entity', 'Svc')).toBeNull();  // no longer a $ref
    const ts = state.typeState('entity', 'Svc');
    expect(ts.namingPattern).toBe('^S');
    expect(ts.propertySchemas).toEqual([{ key: 'cost', s: { type: 'number', required: true }, _enumInput: '' }]);
  });
});

describe('SpaceSchemaTabComponent — per-type retention', () => {
  beforeEach(() => TestBed.resetTestingModule());

  /** The private mapper, reached the same way this file already reaches `_libPickerTarget`. */
  const importer = (c: SpaceSchemaTabComponent) =>
    (c as unknown as { mapImportedTypeSchema(o: Record<string, unknown>): TypeSchemaState })
      .mapImportedTypeSchema.bind(c);

  it('an imported file brings its retention window with it', () => {
    const { c } = setup();
    const ts = importer(c)({ retention: { days: 90, contentDays: 30 } });
    expect(ts.retentionDays).toBe(90);
    expect(ts.retentionContentDays).toBe(30);
  });

  it('a junk retention value in a file becomes inherit, not a save the API rejects', () => {
    const { c } = setup();
    const map = importer(c);
    expect(map({ retention: { days: '90' } }).retentionDays).toBeNull();
    expect(map({ retention: { days: -1 } }).retentionDays).toBeNull();
    expect(map({ retention: { days: 1.5 } }).retentionDays).toBeNull();
    expect(map({ retention: 'soon' }).retentionDays).toBeNull();
    expect(map({}).retentionDays).toBeNull();
  });

  it('saving a type to the library strips the window and SAYS SO', () => {
    const upsert = vi.fn().mockReturnValue(of({ entry: { name: 'event' } }));
    const { c, state } = setup({ upsertSchemaLibraryEntry: upsert as never });
    state.schTypeSchemas = { ...state.schTypeSchemas, chrono: { event: mkType({ retentionDays: 90, retentionContentDays: 30 }) } };
    c.saveTypeToLibrary('chrono', 'event');
    // A library entry's schema is strict and has no `retention` — sending one would 400 the request.
    expect(upsert.mock.calls[0][1].schema.retention).toBeUndefined();
    // ...and the window is now gone from the space too, since the type became a $ref. Silence here would
    // mean an operator's delete policy vanished on an action that looks like "share this schema".
    expect(toasts.filter(t => t.kind === 'info')).toHaveLength(1);
  });

  it('says nothing about retention when there was none to lose', () => {
    const upsert = vi.fn().mockReturnValue(of({ entry: { name: 'event' } }));
    const { c, state } = setup({ upsertSchemaLibraryEntry: upsert as never });
    state.schTypeSchemas = { ...state.schTypeSchemas, chrono: { event: mkType() } };
    c.saveTypeToLibrary('chrono', 'event');
    expect(toasts.filter(t => t.kind === 'info')).toEqual([]);
  });

  it('unlinking a library type starts on the space default rather than inventing a window', () => {
    const entry = { name: 'ev', knowledgeType: 'chrono', typeName: 'event', schema: { propertySchemas: {} } };
    const { c, state } = setup({ listSchemaLibrary: () => of({ entries: [entry] }) as never });
    c.ngOnInit();
    state.schTypeSchemas = { ...state.schTypeSchemas, chrono: { event: mkType({ _libRef: 'ev' }) } };
    c.unlinkType('chrono', 'event');
    expect(state.typeState('chrono', 'event').retentionDays).toBeNull();
    expect(state.typeState('chrono', 'event').retentionContentDays).toBeNull();
  });

  describe('contentWindowNeverFires — mirrors the server clamp', () => {
    /** A component with one chrono type and, optionally, a space-wide default. */
    function withWindows(days: number | null, contentDays: number | null, spaceTtl?: number) {
      const { c, state } = setup();
      state.schTypeSchemas = { ...state.schTypeSchemas, chrono: { event: mkType({ retentionDays: days, retentionContentDays: contentDays }) } };
      state.settingsSpace.set({ id: 'work', label: 'Work', ...(spaceTtl ? { recordTtlDays: spaceTtl } : {}) } as never);
      return c;
    }

    it('flags a content window at or beyond the type window', () => {
      expect(withWindows(30, 30).contentWindowNeverFires('chrono', 'event')).toBe(30);
      expect(withWindows(30, 45).contentWindowNeverFires('chrono', 'event')).toBe(30);
    });

    it('accepts one strictly inside it', () => {
      expect(withWindows(90, 30).contentWindowNeverFires('chrono', 'event')).toBeNull();
    });

    it('falls through to the SPACE default when the type sets no delete window', () => {
      // The reason this case exists: the two fields in front of the operator look fine — one is empty. The
      // record is still deleted at the space default, so a content window at or past it never fires.
      expect(withWindows(null, 30, 30).contentWindowNeverFires('chrono', 'event')).toBe(30);
      expect(withWindows(null, 20, 30).contentWindowNeverFires('chrono', 'event')).toBeNull();
      expect(withWindows(null, 30).contentWindowNeverFires('chrono', 'event')).toBeNull(); // no window anywhere
    });

    it('falls through to THIS collection\'s bucket, not to some other one', () => {
      // The space tier is five per-collection windows. Reading the wrong bucket would warn against a number
      // that does not apply to the type in front of the operator — or stay silent when it should warn.
      const { c, state } = setup();
      state.schTypeSchemas = { ...state.schTypeSchemas, chrono: { event: mkType({ retentionDays: null, retentionContentDays: 30 }) } };
      state.settingsSpace.set({ id: 'work', label: 'Work', recordTtlDays: { entity: 365, chrono: 30 } } as never);
      expect(c.contentWindowNeverFires('chrono', 'event')).toBe(30);   // chrono's 30, not entity's 365
      expect(c.spaceWindow('chrono')).toBe(30);
      expect(c.spaceWindow('entity')).toBe(365);
      expect(c.spaceWindow('fact')).toBeNull();
    });

    it('reads a legacy scalar as every bucket', () => {
      // A space that set one number before the split still means all five, so the hint keeps naming it.
      const { c, state } = setup();
      state.settingsSpace.set({ id: 'work', label: 'Work', recordTtlDays: 90 } as never);
      for (const kt of ['entity', 'fact', 'edge', 'chrono'] as const) {
        expect(c.spaceWindow(kt), kt).toBe(90);
      }
    });

    it('says nothing for a collection that has no content tier', () => {
      const { c, state } = setup();
      state.schTypeSchemas = { ...state.schTypeSchemas, fact: { note: mkType({ retentionDays: 30, retentionContentDays: 30 }) } };
      expect(c.contentWindowNeverFires('fact', 'note')).toBeNull();
    });
  });
});

describe('SpaceSchemaTabComponent — validation controls (moved here in U9 pt3)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  /** Render the tab with the validation state populated; flush ngModel's microtask write. */
  async function render(validationMode: 'off' | 'warn' | 'strict' = 'off', strictLinkage = false) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [SpaceSchemaTabComponent, getTranslocoModule()],
      providers: [
        SpaceSettingsState,
        { provide: SpacesApi, useValue: {} },
        { provide: ToastService, useValue: { show: () => {}, error: () => {}, success: () => {}, info: () => {} } },
        { provide: SchemaApi, useValue: { listSchemaLibrary: () => of({ entries: [] }), upsertSchemaLibraryEntry: () => of({ entry: {} }) } },
      ],
    });
    const fixture = TestBed.createComponent(SpaceSchemaTabComponent);
    const state = TestBed.inject(SpaceSettingsState);
    state.schValidation = validationMode;
    state.schStrictLinkage = strictLinkage;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, state, el: fixture.nativeElement as HTMLElement };
  }

  it('renders an editable 3-option validationMode select reflecting state.schValidation', async () => {
    const { el } = await render('strict');
    const select = el.querySelector('.val-select') as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(Array.from(select!.options).map(o => o.value)).toEqual(['off', 'warn', 'strict']);
    expect(select!.value).toBe('strict');
  });

  it('changing the validationMode select writes state.schValidation (view → state)', async () => {
    const { fixture, state, el } = await render('off');
    const select = el.querySelector('.val-select') as HTMLSelectElement;
    select.value = 'warn';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(state.schValidation).toBe('warn');
  });

  it('renders a strictLinkage checkbox two-way bound to state.schStrictLinkage', async () => {
    const { fixture, state, el } = await render('off', true);
    const box = el.querySelector('.val-check input[type="checkbox"]') as HTMLInputElement;
    expect(box).not.toBeNull();
    expect(box.checked).toBe(true);            // state → view
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(state.schStrictLinkage).toBe(false); // view → state
  });
});

/**
 * Two defects reported together by an integrator whose space had accumulated 21 foreign entity types
 * after a schema file was imported against the wrong space, and which no UI action could remove.
 *
 * Both are client-side halves of "Save persists the state the editor is showing".
 */
describe('SpaceSchemaTabComponent — a file import must not silently empty a $ref type', () => {
  it('reads a type-level $ref and keeps it as a library reference', () => {
    const { c } = setup();
    // `{ "$ref": "library:x" }` carries no namingPattern, no propertySchemas and no retention, so the
    // importer used to read every field as absent and stage an EMPTY type — which then saved as `{}`:
    // no naming rule, nothing required, every new record accepted. Same file, and the per-type
    // "import as $ref" button handled it correctly, which is why it looked non-deterministic.
    const staged = (c as unknown as {
      mapImportedTypeSchema(raw: Record<string, unknown>): TypeSchemaState;
    }).mapImportedTypeSchema({ $ref: 'library:cross-space-reference' });

    expect(staged._libRef).toBe('cross-space-reference');
  });

  it('still maps an inline schema normally', () => {
    // The guard must not swallow ordinary types: it fires only on a `library:` ref.
    const { c } = setup();
    const staged = (c as unknown as {
      mapImportedTypeSchema(raw: Record<string, unknown>): TypeSchemaState;
    }).mapImportedTypeSchema({ namingPattern: '^f-', propertySchemas: { order: { type: 'number' } } });

    expect(staged._libRef).toBeUndefined();
    expect(staged.namingPattern).toBe('^f-');
    expect(staged.propertySchemas.map(p => p.key)).toEqual(['order']);
  });
});

describe('SpaceSettingsState.buildMeta — an emptied knowledge type must still be sent', () => {
  it('emits every knowledge type, including the empty ones', () => {
    const { state } = setup();
    state.schTypeSchemas = { entity: {}, edge: { follows: mkType() } };
    const meta = state.buildMeta();

    // The bug: `if (names.length)` omitted a knowledge type holding zero types, so deleting the last
    // entity type meant the `entity` key never left the browser — and the server, merging, kept all of
    // them. An absent key and an empty object have to mean different things.
    expect(meta.typeSchemas).toBeDefined();
    expect(meta.typeSchemas!.entity).toEqual({});
    expect(Object.keys(meta.typeSchemas!.edge!)).toEqual(['follows']);
  });

  it('emits typeSchemas even when the space declares nothing at all', () => {
    const { state } = setup();
    state.schTypeSchemas = {};
    const meta = state.buildMeta();
    expect(meta.typeSchemas).toBeDefined();
    expect(meta.typeSchemas!.entity).toEqual({});
  });

  it('round-trips a $ref type back out as a $ref', () => {
    const { state } = setup();
    state.schTypeSchemas = { entity: { ref: mkType({ _libRef: 'cross-space-reference' }) } };
    const meta = state.buildMeta();
    expect(meta.typeSchemas!.entity!['ref']).toEqual({ $ref: 'library:cross-space-reference' });
  });
});

/**
 * Characterization for Q-92 point 11: the two schema exports, pinned before the hand-written blob saves are
 * replaced by one shared helper. Both are LOCAL (the payload is built in the browser; no request is made),
 * so what is pinned is the file the user gets: its name, its type, its JSON, that the blob URL is released,
 * and that nothing is saved with no space open.
 */
describe('SpaceSchemaTabComponent — schema exports (characterization for Q-92)', () => {
  function stubSave() {
    const created: Blob[] = [];
    const revoked: string[] = [];
    const clicked: { href: string; download: string; revokedBeforeClick: boolean }[] = [];
    const had = { create: 'createObjectURL' in URL, revoke: 'revokeObjectURL' in URL };
    const prev = { create: (URL as any).createObjectURL, revoke: (URL as any).revokeObjectURL };
    (URL as any).createObjectURL = (b: Blob) => { created.push(b); return 'blob:schema-' + created.length; };
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

  const blobJson = (b: Blob) => new Promise<any>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(JSON.parse(String(r.result)));
    r.onerror = () => rej(r.error);
    r.readAsText(b);
  });

  it('Export schemas saves application/json named <spaceId>_schemas.json with the space and its type schemas', async () => {
    const s = stubSave();
    try {
      const { c, state } = setup();
      state.settingsSpace.set({ id: 'work', label: 'Work' } as never);
      state.schTypeSchemas = { ...state.schTypeSchemas, entity: { Service: mkType() } };
      const expectedSchemas = state.buildMeta().typeSchemas ?? {};
      c.exportSchema();

      expect(s.created).toHaveLength(1);
      expect(s.created[0].type).toBe('application/json');
      const body = await blobJson(s.created[0]);
      expect(Object.keys(body)).toEqual(['spaceId', 'spaceLabel', 'exportedAt', 'typeSchemas']);
      expect(body.spaceId).toBe('work');
      expect(body.spaceLabel).toBe('Work');
      expect(body.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(body.typeSchemas).toEqual(JSON.parse(JSON.stringify(expectedSchemas)));
      expect(body.typeSchemas.entity).toHaveProperty('Service');

      expect(s.clicked).toEqual([{ href: 'blob:schema-1', download: 'work_schemas.json', revokedBeforeClick: false }]);
      expect(s.revoked).toEqual(['blob:schema-1']);   // AS-IS: revoked synchronously after the click
    } finally {
      s.restore();
    }
  });

  it('Export one type saves application/json named <spaceId>_<kt>_<name>.json with the type schema', async () => {
    const s = stubSave();
    try {
      const { c, state } = setup();
      state.settingsSpace.set({ id: 'work', label: 'Work' } as never);
      state.schTypeSchemas = { ...state.schTypeSchemas, entity: { Service: mkType() } };
      c.exportTypeSchema('entity', 'Service');

      expect(s.created[0].type).toBe('application/json');
      const body = await blobJson(s.created[0]);
      expect(Object.keys(body)).toEqual(['knowledgeType', 'typeName', 'schema']);
      expect(body.knowledgeType).toBe('entity');
      expect(body.typeName).toBe('Service');
      expect(typeof body.schema).toBe('object');
      expect(s.clicked).toEqual([{ href: 'blob:schema-1', download: 'work_entity_Service.json', revokedBeforeClick: false }]);
      expect(s.revoked).toEqual(['blob:schema-1']);
    } finally {
      s.restore();
    }
  });

  it('with no space open neither export saves anything or toasts', () => {
    const s = stubSave();
    try {
      const { c, state } = setup();
      state.settingsSpace.set(null);
      c.exportSchema();
      c.exportTypeSchema('entity', 'Service');
      expect(s.created).toEqual([]);
      expect(s.clicked).toEqual([]);
      expect(toasts).toEqual([]);
    } finally {
      s.restore();
    }
  });
});

/**
 * bundle-128 (design-v3 §1.5): the Schema tab's "This instance" row, and its one control, "Unknown top-level fields".
 *
 * The setting is this instance's answer to a write that names a field its operation does not take: `warn` (stored without
 * it, the answer names it) or `refuse` (a 400, nothing stored). It is NOT a validation mode and it is not shared with a
 * network, which is why it sits in its own row BELOW the Schema-validation bar (whose hint promises shared, space-wide
 * behaviour) rather than inside it.
 *
 * Real English / German / Polish are loaded so the visible wording can be asserted; a key that does not exist yet renders
 * as the raw key, which has none of the words the plan fixes - the right red for copy that was never written.
 *
 * Test ids this spec asks for (chosen here, the plan does not name them): `this-instance-row`, `unknown-fields-select`,
 * `unknown-fields-hint`, `unknown-fields-consequence`, `unknown-fields-readonly-reason`, `unknown-fields-proxy-note`.
 * The state field is `schUnknownWriteFields` ('warn' | 'refuse'); it is reached through a cast so a missing field fails the
 * ASSERTION that names it instead of failing the whole file at compile time.
 *
 * Not asserted here, because jsdom cannot: the 24 px target size and contrast in both themes (design §1.5 "Verify": axe on
 * the Schema tab, light and dark, at runtime).
 */
describe('SpaceSchemaTabComponent - the "This instance" row: Unknown top-level fields (bundle-128, §1.5)', () => {
  const i18n = (lang: string): Record<string, string> =>
    JSON.parse(readFileSync(resolve(__dirname, `../../../../public/assets/i18n/${lang}.json`), 'utf8'));
  const EN = i18n('en');

  const ROW = '[data-testid="this-instance-row"]';
  const SELECT = '[data-testid="unknown-fields-select"]';
  const HINT = '[data-testid="unknown-fields-hint"]';
  const CONSEQUENCE = '[data-testid="unknown-fields-consequence"]';
  const READONLY_REASON = '[data-testid="unknown-fields-readonly-reason"]';
  const PROXY_NOTE = '[data-testid="unknown-fields-proxy-note"]';
  const RAW_KEY = /^[a-z]+(\.[A-Za-z]+)+$/;

  const work = (over: Record<string, unknown> = {}): Space => ({ id: 'work', label: 'Work', maxGiB: 10, networks: [], ...over }) as unknown as Space;
  const fieldOf = (state: SpaceSettingsState) => (state as unknown as Record<string, unknown>)['schUnknownWriteFields'];

  const adminRights = { instanceAdmin: false, perSpace: { work: { schema: 'admin' } }, floor: { schema: 'none' } };
  const writeOnlyRights = { instanceAdmin: false, perSpace: { work: { schema: 'write' } }, floor: { schema: 'none' } };

  async function mountRow(opts: { space?: Space; rights?: unknown; translation?: Record<string, string> } = {}) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [SpaceSchemaTabComponent, getTranslocoModule({ translation: { en: opts.translation ?? EN } })],
      providers: [
        SpaceSettingsState,
        { provide: SpacesApi, useValue: { getSpaceStats: () => of({ spaceId: 'work', facts: 0, entities: 0, edges: 0, chrono: 0, files: 0 }) } },
        { provide: ToastService, useValue: { show: () => {}, error: () => {}, success: () => {}, info: () => {} } },
        { provide: SchemaApi, useValue: { listSchemaLibrary: () => of({ entries: [] }), upsertSchemaLibraryEntry: () => of({ entry: {} }) } },
        ...(opts.rights ? [{ provide: AuthApi, useValue: { verifyToken: () => of({ id: 't', name: 't', rights: opts.rights }) } }] : []),
      ],
    });
    const fixture = TestBed.createComponent(SpaceSchemaTabComponent);
    const state = TestBed.inject(SpaceSettingsState);
    state.openSettings(opts.space ?? work());
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    return { fixture, state, el, select: () => el.querySelector<HTMLSelectElement>(SELECT) };
  }

  it('a space that does not carry the key opens on Warn; one that carries refuse opens on Refuse', async () => {
    const absent = await mountRow();
    expect(fieldOf(absent.state), 'the state does not map an absent key to warn').toBe('warn');
    expect(absent.select(), 'the control did not render').not.toBeNull();
    expect(absent.select()!.value).toBe('warn');

    const refusing = await mountRow({ space: work({ unknownWriteFields: 'refuse' }) });
    expect(fieldOf(refusing.state)).toBe('refuse');
    expect(refusing.select()!.value).toBe('refuse');
  });

  it('offers exactly warn and refuse, labelled "Unknown top-level fields", with the em-dash wording of the validation options', async () => {
    const { select } = await mountRow();
    const sel = select();
    expect(sel, 'the control did not render').not.toBeNull();
    expect(Array.from(sel!.options).map(o => o.value)).toEqual(['warn', 'refuse']);
    const texts = Array.from(sel!.options).map(o => (o.textContent ?? '').trim());
    // the pattern of `spaces.settings.validation.*`: "<Word> — <what happens>"
    expect(texts[0]).toMatch(/^Warn — \S/);
    expect(texts[1]).toMatch(/^Refuse — \S/);
    // Each option says what happens to the write, short enough not to clip in the closed select at phone width
    // (the first wording clipped at 375px, found by the pre-ship measurement).
    expect(texts[0]).toMatch(/\bstore the write\b/);
    expect(texts[1]).toMatch(/\bstore nothing\b/);
    for (const t of texts) expect(t.length, `"${t}" is too long for the closed select at phone width`).toBeLessThanOrEqual(44);
    const label = sel!.closest('label') ?? sel!.ownerDocument.querySelector(`label[for="${sel!.id}"]`);
    expect(label, 'the select has no label').not.toBeNull();
    expect(label!.textContent).toContain('Unknown top-level fields');
  });

  it('its row is called "This instance" and sits BELOW the Schema validation bar, not inside it', async () => {
    const { el } = await mountRow();
    const row = el.querySelector<HTMLElement>(ROW);
    const bar = el.querySelector<HTMLElement>('.sch-validation-bar');
    expect(row, 'there is no "This instance" row').not.toBeNull();
    expect(bar).not.toBeNull();
    expect(bar!.contains(row!), 'a local setting inside the shared bar inherits its promise').toBe(false);
    expect(bar!.compareDocumentPosition(row!) & Node.DOCUMENT_POSITION_FOLLOWING, 'the row comes before the bar').toBeTruthy();
    expect(row!.textContent).toContain('This instance');
    expect(row!.querySelector(SELECT), 'the select is not in the row').not.toBeNull();
  });

  it('the hint is visible text on its own line, linked to the select by aria-describedby, and says what it must', async () => {
    const { select, el } = await mountRow();
    const sel = select();
    expect(sel, 'the control did not render').not.toBeNull();
    const ids = (sel!.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    expect(ids.length, 'the select is not linked to a hint').toBeGreaterThan(0);
    const hint = el.querySelector<HTMLElement>(HINT);
    expect(hint, 'there is no hint element').not.toBeNull();
    expect(hint!.id, 'the hint has no id for aria-describedby to name').not.toBe('');
    expect(ids).toContain(hint!.id);
    expect(hint!.hasAttribute('hidden')).toBe(false);
    const hintText = (hint!.textContent ?? '').trim();
    expect(hintText.length, 'the hint is empty (a title tooltip is not a hint)').toBeGreaterThan(20);
    expect(hintText).not.toMatch(RAW_KEY);
    expect(hintText).toMatch(/this instance/i);
    expect(hintText).toMatch(/not shared|isn.t shared|is not shared/i);
    expect(hintText).toMatch(/network/i);
    // it separates a top-level field the write does not take from Validation mode's undeclared property of a type
    expect(hintText).toMatch(/top-level/i);
    expect(hintText).toMatch(/undeclared property/i);
    expect(sel!.getAttribute('title'), 'the hint lives in a title tooltip').toBeNull();
  });

  it('choosing a value in the select writes state.schUnknownWriteFields (view to state)', async () => {
    const { fixture, state, select } = await mountRow();
    const sel = select();
    expect(sel, 'the control did not render').not.toBeNull();
    sel!.value = 'refuse';
    sel!.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(fieldOf(state)).toBe('refuse');
    sel!.value = 'warn';
    sel!.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(fieldOf(state)).toBe('warn');
  });

  it('the consequence text appears for Refuse and not for Warn', async () => {
    const { fixture, el, select } = await mountRow();
    const sel = select();
    expect(sel, 'the control did not render').not.toBeNull();
    expect(el.querySelector(CONSEQUENCE), 'the consequence is shown while Warn is chosen').toBeNull();
    sel!.value = 'refuse';
    sel!.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    const consequence = el.querySelector<HTMLElement>(CONSEQUENCE);
    expect(consequence, 'no consequence text for Refuse').not.toBeNull();
    expect(consequence!.textContent).toMatch(/\b400\b/);
    expect(consequence!.textContent).toMatch(/integration/i);
  });

  it('a token with schema admin gets an enabled select and no read-only reason (control)', async () => {
    const { el, select } = await mountRow({ rights: adminRights });
    expect(select(), 'the control did not render').not.toBeNull();
    expect(select()!.disabled).toBe(false);
    expect(el.querySelector(READONLY_REASON)).toBeNull();
  });

  it('a token without schema admin sees the select disabled, with the reason as visible text', async () => {
    const { el, select } = await mountRow({ rights: writeOnlyRights });
    const sel = select();
    expect(sel, 'a read-only token loses the control altogether instead of seeing it disabled').not.toBeNull();
    expect(sel!.disabled).toBe(true);
    const reason = el.querySelector<HTMLElement>(READONLY_REASON);
    expect(reason, 'disabled with no reason').not.toBeNull();
    expect((reason!.textContent ?? '').trim().length).toBeGreaterThan(10);
    expect(reason!.textContent).not.toMatch(RAW_KEY);
  });

  it.each([
    ['a member list', ['a', 'b']],
    ['the wildcard', ['*']],
  ])('on a proxy space (%s) the control is hidden and a one-line note says each member governs', async (_name, proxyFor) => {
    const { el, select } = await mountRow({ space: work({ proxyFor }) });
    expect(select(), 'the select shows on a proxy space, where the member\'s own setting governs a write').toBeNull();
    const note = el.querySelector<HTMLElement>(PROXY_NOTE);
    expect(note, 'hidden with no note').not.toBeNull();
    const text = (note!.textContent ?? '').trim();
    expect(text.length).toBeGreaterThan(10);
    expect(text).toMatch(/member/i);
    expect(text).toMatch(/govern|own|decide/i);
    expect(text, 'the note is more than one line').not.toContain('\n');
  });

  it('a space that is not a proxy shows no proxy note (control)', async () => {
    const { el, select } = await mountRow();
    expect(select(), 'the control did not render').not.toBeNull();
    expect(el.querySelector(PROXY_NOTE)).toBeNull();
  });

  it.each(['de', 'pl'])('is translated into %s: options, hint and consequence are words, not keys, and not the English', async (lang) => {
    const en = await mountRow();
    const enSel = en.select();
    expect(enSel, 'the control did not render').not.toBeNull();
    const enTexts = Array.from(enSel!.options).map(o => (o.textContent ?? '').trim());
    const enHint = (en.el.querySelector<HTMLElement>(HINT)?.textContent ?? '').trim();

    // Refuse is chosen in this mount, so the consequence line is showing too.
    const other = await mountRow({ translation: i18n(lang), space: work({ unknownWriteFields: 'refuse' }) });
    const sel = other.select();
    expect(sel, `${lang}: the control did not render`).not.toBeNull();
    for (const t of Array.from(sel!.options).map(o => (o.textContent ?? '').trim())) {
      expect(t, `${lang}: an option renders as a key`).not.toMatch(RAW_KEY);
      expect(enTexts, `${lang}: an option is the English text`).not.toContain(t);
    }
    const hint = (other.el.querySelector<HTMLElement>(HINT)?.textContent ?? '').trim();
    expect(hint.length).toBeGreaterThan(20);
    expect(hint).not.toBe(enHint);
    expect(hint).not.toMatch(RAW_KEY);
    const consequence = (other.el.querySelector<HTMLElement>(CONSEQUENCE)?.textContent ?? '').trim();
    expect(consequence.length, `${lang}: no consequence text`).toBeGreaterThan(10);
    expect(consequence).not.toMatch(RAW_KEY);
  });
});
