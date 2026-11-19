/**
 * The Schema tab's part of the conversion (bundle-285 slice S6, Q-747; plan sections 3.1 item 7, 5 rows P3 to P5, 7; handover item 5): the type's head
 * carries the labelled Convert records button, says "was <old name>" beside a type renamed and not saved, and reads the token's admin right through
 * the one rule the conversion shares (`holdsSchemaAdmin`).
 *
 * The tab is mounted through the whole popup over the real APIs on a fake HTTP backend (`testing/schema-tab-harness.ts`). What these hold:
 *
 * - **The button is in the head's actions**, labelled, for a token that may convert; locked with its reason for one that holds the schema right but
 *   not the knowledge admin right; and waits for Save when the type was renamed (the act works on the stored schema).
 * - **The renamed type says what it was** (`[was]` on the name control), so a rename that waits for Save is visible in the pane.
 * - **One rule for "may change the schema".** The tab asks `holdsSchemaAdmin`: the HIGHER of the space's row and the floor, as the server resolves it.
 *   The tab's own inline test took a row to override the floor, so a token with `schema: admin` on its floor and a lower row was locked out of the rules
 *   the server lets it edit.
 *
 * ## Seen red
 *
 * Red at 77b45cfe9: the head has no button, no "was" note, and the inline test locks the rules for a lower row under an admin floor.
 */
import { describe, expect, it } from 'vitest';
import type { Space } from '../../core/api.types';
import { $, $$, mountSchemaTab, selectSchemaType } from '../../testing/schema-tab-harness';

const WORDS = {
  'spaces.schema.convert.button': 'Convert records',
  'spaces.schema.convert.locked': 'LOCKED REASON',
  'spaces.schema.convert.saveFirst': 'SAVE FIRST',
  'spaces.schema.was': 'was {{name}}',
};

const space = (): Space => ({
  id: 'customers', label: 'Customers', maxGiB: 10, networks: [],
  meta: { version: 3, typeSchemas: { entity: { person: { propertySchemas: { company: { type: 'string' } } }, client: { propertySchemas: { name: { type: 'string' } } } } } },
}) as unknown as Space;

const rights = (over: Record<string, unknown>) => ({ instanceAdmin: false, createSpaces: false, floor: null, perSpace: {}, ...over });
const ADMIN = rights({ instanceAdmin: true });
const SCHEMA_ADMIN_NO_KNOWLEDGE_ADMIN = rights({ floor: { schema: 'admin', knowledge: 'write' } });

const head = (pane: HTMLElement): HTMLElement => $(pane, '.sch-detail-head')!;
const button = (pane: HTMLElement): HTMLButtonElement => $(head(pane), '[data-testid="convert-records"]') as HTMLButtonElement;

describe('the type head of the Schema tab', () => {
  it('carries the labelled Convert records button among the head\'s actions, for a token that may convert', async () => {
    const h = await mountSchemaTab({ space: space(), rights: ADMIN, translation: WORDS });
    const pane = await selectSchemaType(h, 'entity', 'person');
    const b = button(pane);
    expect(b, 'the button is in the head').not.toBeNull();
    expect(b.closest('.acts')).not.toBeNull();
    expect(b.textContent!.trim()).toBe('Convert records');
    expect(b.disabled).toBe(false);
  });

  it('locks it, with the reason visible, for a token with the schema right but not the knowledge admin right', async () => {
    const h = await mountSchemaTab({ space: space(), rights: SCHEMA_ADMIN_NO_KNOWLEDGE_ADMIN, translation: WORDS });
    const pane = await selectSchemaType(h, 'entity', 'person');
    expect(button(pane).disabled).toBe(true);
    expect($(pane, '[data-testid="convert-locked"]')!.textContent!.trim()).toBe('LOCKED REASON');
  });

  it('says "was <old name>" beside a type renamed and not saved, and waits for Save before converting it', async () => {
    const h = await mountSchemaTab({ space: space(), rights: ADMIN, translation: WORDS });
    const first = await selectSchemaType(h, 'entity', 'person');
    // As a person does it: the pencil beside the name, the new name typed, Enter.
    const control = $(head(first), 'app-schema-type-name')!;
    ($(control, 'button') as HTMLButtonElement).click();
    await h.settle();
    const field = $(control, 'input') as HTMLInputElement;
    field.value = 'individual';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await h.settle();
    const pane = $(h.el, '.sch-detail')!;
    expect(head(pane).textContent).toContain('was person');
    expect(button(pane).disabled).toBe(true);
    expect($(pane, '[data-testid="convert-locked"]')!.textContent!.trim()).toBe('SAVE FIRST');
  });

  it('shows no "was" note on a type that was not renamed', async () => {
    const h = await mountSchemaTab({ space: space(), rights: ADMIN, translation: WORDS });
    const pane = await selectSchemaType(h, 'entity', 'person');
    expect(head(pane).textContent).not.toContain('was ');
  });
});

describe('the Schema tab\'s right to change rules', () => {
  it('holds for a token whose floor says schema admin and whose row for this space is lower: the higher of the two, as the server resolves it', async () => {
    const h = await mountSchemaTab({ space: space(), rights: rights({ floor: { schema: 'admin' }, perSpace: { customers: { schema: 'read' } } }), translation: WORDS });
    expect($$(h.el, '[data-testid="rules-readonly-reason"]')).toHaveLength(0);
    expect($(h.el, '[data-testid="unknown-fields-select"]')!.hasAttribute('disabled')).toBe(false);
  });

  it('is still refused to a token that holds less than admin on the schema area', async () => {
    const h = await mountSchemaTab({ space: space(), rights: rights({ floor: { schema: 'write' } }), translation: WORDS });
    expect($$(h.el, '[data-testid="rules-readonly-reason"]')).toHaveLength(1);
  });

  it('holds for a token that administers the space through the spaceAdmin grant alone', async () => {
    const h = await mountSchemaTab({ space: space(), rights: rights({ spaceAdmin: { floor: false, spaces: ['customers'] } }), translation: WORDS });
    expect($$(h.el, '[data-testid="rules-readonly-reason"]')).toHaveLength(0);
  });
});
