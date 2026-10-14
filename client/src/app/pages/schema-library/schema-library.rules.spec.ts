/**
 * The schema LIBRARY editor and F-46 rules.
 *
 * ## Why this editor needs its own spec
 *
 * It does not use the settings dialog's model. `schema-library.component.ts` forks it: its own `TypeSchemaState`
 * (`namingPattern` and `propertySchemas` only) and its own serialiser `formStateToSchema`. A field that fork does not
 * hold is not shown and, worse, is DELETED the next time anybody saves an entry in this editor — the library save is a
 * PUT of the whole schema, so "I only changed the naming pattern" rewrites the entry without its rules. A rule is an
 * enforced constraint on every space that links the entry (`$ref: "library:<name>"`), so that save widens what those
 * spaces accept, silently, and nothing on this page ever mentioned a rule.
 *
 * Every test builds its entry in the form the SERVER returns (rules as a map keyed by name) and asserts what the editor
 * SENDS, which is what an upsert test must be asserting to catch the fork.
 *
 * ## Names
 *
 * The contract's only: `rules` on the entry's schema (a map of `{ rule, message }`). The test ids below are the same
 * ones the Schema tab's rules editor uses (`rule-row`, `rule-toggle`, `rule-text`, `rule-message`), so both editors
 * can share one rule-row component; they are listed in the hand-off.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import type { SchemaLibraryEntry } from '../../core/api.types';
import { AuthApi } from '../../core/auth-api.service';
import { SchemaApi } from '../../core/schema-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { ToastService } from '../../core/toast.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { SchemaLibraryComponent, entriesFromTypeSchemas } from './schema-library.component';

const AGE = { rule: 'self.properties.age >= 0', message: 'An age cannot be negative' };
const TITLE = { rule: 'size(self.title) > 3', message: 'A title needs more than three characters' };

const WITH_RULES = {
  name: 'crm-person', knowledgeType: 'entity', typeName: 'person', schemaGroup: 'crm', description: 'A person in the CRM',
  schema: {
    namingPattern: '^[A-Z]',
    propertySchemas: { age: { type: 'number' } },
    rules: { 'age-positive': AGE, 'title-long': TITLE },
  },
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
} as unknown as SchemaLibraryEntry;

const WITHOUT_RULES = {
  name: 'crm-org', knowledgeType: 'entity', typeName: 'org',
  schema: { namingPattern: '^[A-Z]', propertySchemas: { size: { type: 'number' } } },
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
} as unknown as SchemaLibraryEntry;

type Saved = { schema: Record<string, unknown> } & Record<string, unknown>;

function create(entries: SchemaLibraryEntry[]) {
  TestBed.resetTestingModule();
  const upsert = vi.fn((name: string, body: Saved) => of({ entry: { ...body, name, createdAt: '', updatedAt: '' } }));
  const createEntry = vi.fn((body: Saved) => of({ entry: { ...body, createdAt: '', updatedAt: '' } }));
  const schemaApi = {
    listSchemaLibrary: vi.fn(() => of({ entries })),
    getSchemaLibraryUsages: vi.fn(() => of({ usages: [] })),
    upsertSchemaLibraryEntry: upsert,
    createSchemaLibraryEntry: createEntry,
    deleteSchemaLibraryEntry: vi.fn(() => of(undefined)),
  };
  const upsertTypeSchema = vi.fn(() => of({}));
  TestBed.configureTestingModule({
    imports: [SchemaLibraryComponent, getTranslocoModule()],
    providers: [
      { provide: SchemaApi, useValue: schemaApi },
      { provide: SpacesApi, useValue: { listSpaces: () => of({ spaces: [] }), upsertTypeSchema } },
      { provide: AuthApi, useValue: {} },
      { provide: ToastService, useValue: { show: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(SchemaLibraryComponent);
  fixture.detectChanges();
  const c = fixture.componentInstance as unknown as {
    openEdit(e: SchemaLibraryEntry): void; openCreate(): void; saveEntry(): void; confirmDelete(): void;
    form: { name: string; typeName: string; schemaState: { namingPattern: string } };
    deleteDialog: { set(v: unknown): void };
  };
  return { fixture, c, el: fixture.nativeElement as HTMLElement, upsert, createEntry, upsertTypeSchema };
}

const sent = (upsert: ReturnType<typeof create>['upsert']): Saved => upsert.mock.calls[0]![1];
const rulesOf = (s: Saved): unknown => (s.schema as { rules?: unknown }).rules;
const $$ = (root: ParentNode, sel: string): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>(sel));

describe('the library editor carries rules through its own serialiser', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('editing ANOTHER field of an entry that has rules and saving sends the rules unchanged', () => {
    const { c, upsert } = create([WITH_RULES]);
    c.openEdit(WITH_RULES);
    c.form.schemaState.namingPattern = '^[A-Z][a-z]+$';
    c.saveEntry();

    expect(upsert).toHaveBeenCalledTimes(1);
    const body = sent(upsert);
    // The edit itself went through, so this is a real save of a changed entry...
    expect((body.schema as { namingPattern?: string }).namingPattern).toBe('^[A-Z][a-z]+$');
    expect((body.schema as { propertySchemas?: unknown }).propertySchemas).toEqual({ age: { type: 'number' } });
    // ...and the rules the editor has no field for came with it, key for key.
    expect(rulesOf(body), 'the save dropped the entry\'s rules').toEqual({ 'age-positive': AGE, 'title-long': TITLE });
  });

  it('saving an entry with no rules does not invent an empty `rules` map', () => {
    const { c, upsert } = create([WITHOUT_RULES]);
    c.openEdit(WITHOUT_RULES);
    c.form.schemaState.namingPattern = '^[A-Z]{2}';
    c.saveEntry();
    expect('rules' in sent(upsert).schema).toBe(false);
  });

  it('a new entry carries no rules, and a save of it creates rather than upserts', () => {
    const { c, createEntry, upsert } = create([]);
    c.openCreate();
    c.form.name = 'fresh';
    c.form.typeName = 'fresh';
    c.saveEntry();
    expect(upsert).not.toHaveBeenCalled();
    expect(createEntry).toHaveBeenCalledTimes(1);
    expect('rules' in (createEntry.mock.calls[0]![0].schema)).toBe(false);
  });
});

describe('the library editor shows an entry\'s rules', () => {
  beforeEach(() => TestBed.resetTestingModule());

  async function open(entry: SchemaLibraryEntry) {
    const h = create([entry]);
    h.c.openEdit(entry);
    h.fixture.detectChanges();
    await h.fixture.whenStable();
    h.fixture.detectChanges();
    return h;
  }

  it('lists each rule of the entry by name in the edit dialog', async () => {
    const { el } = await open(WITH_RULES);
    const rows = $$(el, '[data-testid="rule-row"]');
    expect(rows.length, 'the edit dialog shows no rules for an entry that has two').toBe(2);
    expect(rows.map(r => r.querySelector('[data-testid="rule-toggle"]')?.textContent ?? '')).toEqual([
      expect.stringContaining('age-positive'), expect.stringContaining('title-long'),
    ]);
  });

  it('shows no rule rows for an entry without rules', async () => {
    const { el } = await open(WITHOUT_RULES);
    // The dialog itself rendered (the naming pattern is there), so an empty result is "no rules", not "no dialog".
    expect(el.querySelector('input[placeholder="spaces.schema.namingPatternPlaceholder"]')).not.toBeNull();
    expect($$(el, '[data-testid="rule-row"]')).toEqual([]);
  });

  it('a rule edited in the dialog is the rule that is saved, and the other rule is untouched', async () => {
    const { el, fixture, c, upsert } = await open(WITH_RULES);
    const row = $$(el, '[data-testid="rule-row"]').find(r => r.textContent?.includes('age-positive'));
    expect(row, 'no row for the rule').toBeDefined();
    const toggle = row!.querySelector<HTMLElement>('[data-testid="rule-toggle"]');
    expect(toggle, 'the row has no disclosure button').not.toBeNull();
    if (toggle!.getAttribute('aria-expanded') !== 'true') toggle!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const text = row!.querySelector<HTMLTextAreaElement>('[data-testid="rule-text"]');
    expect(text, 'the row has no rule text control').not.toBeNull();
    text!.value = 'self.properties.age >= 18';
    text!.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();

    c.saveEntry();
    expect(rulesOf(sent(upsert))).toEqual({
      'age-positive': { rule: 'self.properties.age >= 18', message: AGE.message },
      'title-long': TITLE,
    });
  });
});

describe('unlinking and applying keep an entry\'s rules', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('deleting an entry that spaces link to first inlines its whole schema, rules included, into each of them', () => {
    const { c, upsertTypeSchema } = create([WITH_RULES]);
    c.deleteDialog.set({
      entryName: 'crm-person', loading: false, unlinking: false, error: '',
      usages: [{ spaceId: 'work', spaceLabel: 'Work', knowledgeType: 'entity', typeName: 'person' }],
    });
    c.confirmDelete();
    expect(upsertTypeSchema).toHaveBeenCalledTimes(1);
    const [spaceId, kt, typeName, schema] = upsertTypeSchema.mock.calls[0] as unknown as [string, string, string, { rules?: unknown }];
    expect([spaceId, kt, typeName]).toEqual(['work', 'entity', 'person']);
    expect(schema.rules, 'the inlined type lost the library entry\'s rules').toEqual({ 'age-positive': AGE, 'title-long': TITLE });
  });

  it('turning a space\'s types into library entries keeps each type\'s rules, key for key', () => {
    const typeSchemas = { entity: { person: { propertySchemas: {}, rules: { 'age-positive': AGE } } }, chrono: { event: { rules: { 'title-long': TITLE } } } };
    const { entries } = entriesFromTypeSchemas(typeSchemas as never, 'crm');
    expect(entries.length).toBe(2);
    expect(entries.find(e => e.typeName === 'person')!.schema).toEqual(typeSchemas.entity.person);
    expect(entries.find(e => e.typeName === 'event')!.schema).toEqual(typeSchemas.chrono.event);
  });
});
