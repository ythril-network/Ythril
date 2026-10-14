/**
 * The Schema tab's rules editor, the live check and the layer marker — what the operator SEES and can DO.
 *
 * ## How it is mounted
 *
 * Through the whole settings pop-up, over the REAL `SpacesApi` / `SchemaApi` / `AuthApi` on a fake HTTP backend. Three
 * things the plan puts on this tab are decided across components (a refused save in the pop-up opens a row in the tab,
 * the layers answer is read beside it, the token's rights decide what is editable), and a spec that mounted the tab
 * alone would have to guess which component fetches what. Over the wire the only thing fixed is the request and the
 * screen, which is what the plan fixes too.
 *
 * ## The test ids this spec asks for (the contract names three; the rest are chosen here and listed in the hand-off)
 *
 * Contract: `validate-schema`, `propose-to-network`, `reload-schema`.
 * Chosen: `rules-section` / `rule-row` / `rule-toggle` / `rule-text` / `rule-message` / `rule-text-counter` /
 * `rule-message-counter` / `rules-count` / `applicable-rules` / `space-rules-section` / `space-rule-row` /
 * `space-rule-kind` / `rules-readonly-reason` / `layer-marker` / `validate-mode-sample` / `validate-mode-stored` /
 * `validate-sample` / `validate-progress` / `validate-continue` / `validate-all-good`, plus the role `alert` inside the
 * row a refusal names. A counter carries its numbers as `data-used` / `data-limit`: the words around them are
 * translated (and the spec's translations echo keys), so a number inside a sentence cannot be asserted but a number
 * the element declares can.
 */
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { KNOWLEDGE_TYPES, type Space } from '../../core/api.types';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { declaredNearest } from '../../testing/declared-style';
import { SpaceSettingsPopupComponent } from './space-settings-popup.component';
import { SpaceSettingsState } from './space-settings-state.service';
import { SpacesStore } from './spaces-store.service';

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const AGE = { rule: 'self.properties.age >= 0', message: 'An age cannot be negative' };
const TITLE = { rule: 'size(self.title) > 3', message: 'A title needs more than three characters' };
const FOLLOW_A = { rule: 'self.label != ""', message: 'A label is needed' };
const FOLLOW_B = { rule: 'size(self.properties) < 5', message: 'At most four properties' };

/** Four space rules: one for two kinds, one for every kind, one for edges only, one for chrono only. */
const SPACE_RULES = {
  'no-future': { rule: 'self.properties.at <= now', message: 'Not in the future', kinds: ['chrono', 'fact'] },
  'few-tags': { rule: 'size(self.tags) <= 10', message: 'At most ten tags' },
  'edges-only': { rule: 'self.label != ""', message: 'Edges need a label', kinds: ['edge'] },
};

function ruledSpace(): Space {
  return {
    id: 'work', label: 'Work', maxGiB: 10, networks: [],
    meta: {
      version: 7,
      validationMode: 'strict',
      typeSchemas: {
        entity: {
          person: { propertySchemas: { age: { type: 'number' }, name: { type: 'string' } }, rules: { 'age-positive': AGE, 'title-long': TITLE } },
          plain: {},
          linked: { $ref: 'library:shared-person' },
        },
        fact: {},
        edge: { follows: { rules: { 'first-rule': FOLLOW_A, 'second-rule': FOLLOW_B } } },
        chrono: { event: {} },
      },
      rules: SPACE_RULES,
    },
  } as unknown as Space;
}

const LIBRARY_ENTRY = {
  name: 'shared-person', knowledgeType: 'entity', typeName: 'person',
  schema: { propertySchemas: { age: { type: 'number' } }, rules: { 'library-rule': { rule: 'self.title != ""', message: 'From the library' } } },
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
};

const rights = (schema: 'admin' | 'write') => ({
  floor: { knowledge: 'none', files: 'none', schema: 'none', dataQuality: 'none' },
  perSpace: { work: { knowledge: 'admin', files: 'admin', schema, dataQuality: 'admin' } },
});

/** An age that two networks define differently; the first-listed network (Alpha) is the one that applies. */
const LAYERS = {
  spaceId: 'work',
  own: { typeSchemas: { entity: { person: { propertySchemas: { age: { type: 'string' }, name: { type: 'string' } } } } } },
  layers: [
    { networkId: 'net-a', networkLabel: 'Alpha Federation', meta: { typeSchemas: { entity: { person: { propertySchemas: { age: { type: 'number' } } } } } } },
    { networkId: 'net-b', networkLabel: 'Beta Operations', meta: { typeSchemas: { entity: { person: { propertySchemas: { age: { type: 'string' } } } } } } },
  ],
  precedence: ['net-a', 'net-b'],
  clashes: [{ kind: 'entity', type: 'person', property: 'age', values: [{ networkId: 'net-a', value: { type: 'number' } }, { networkId: 'net-b', value: { type: 'string' } }] }],
};
const NO_LAYERS = { spaceId: 'work', own: {}, layers: [], precedence: [], clashes: [] };

// ── harness ──────────────────────────────────────────────────────────────────────────────────────────────────────────

interface MountOptions { schemaRights?: 'admin' | 'write'; layers?: unknown; library?: unknown[] }

async function mount(opts: MountOptions = {}) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [SpaceSettingsPopupComponent, getTranslocoModule()],
    providers: [
      provideHttpClient(), provideHttpClientTesting(),
      SpaceSettingsState, SpacesStore,
      { provide: ToastService, useValue: { show: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() } },
      { provide: ConfirmDialogService, useValue: { confirm: () => Promise.resolve(true) } },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(SpaceSettingsPopupComponent);
  // Attached to the document: `document.activeElement` is meaningless for a detached tree.
  document.body.appendChild(fixture.nativeElement);
  const state = fixture.componentInstance.state;

  /** Answers the reads the tab and its neighbours make; leaves every write (and any read it does not know) for the test. */
  const answers: Record<string, unknown> = {
    '/api/tokens/me': { id: 't1', name: 'token', rights: rights(opts.schemaRights ?? 'admin') },
    '/api/spaces/work/schema-layers': opts.layers ?? NO_LAYERS,
    '/api/schema-library': { entries: opts.library ?? [] },
    '/api/brain/spaces/work/stats': { spaceId: 'work', facts: 0, entities: 0, edges: 0, chrono: 0, files: 0 },
  };
  const flushReads = () => {
    for (const req of http.match(r => r.method === 'GET' && r.url.split('?')[0]! in answers)) req.flush(answers[req.request.url.split('?')[0]!] as never);
  };
  /** Let change detection, deferred blocks and the reads they issued run to rest. */
  const settle = async (until?: () => boolean): Promise<void> => {
    for (let i = 0; i < 300; i++) {
      fixture.detectChanges();
      flushReads();
      await fixture.whenStable();
      fixture.detectChanges();
      if (!until || until()) return;
      await new Promise<void>(r => setTimeout(r, 10));
    }
  };

  state.openSettings(ruledSpace());
  state.settingsTab.set('schema');
  const el = fixture.nativeElement as HTMLElement;
  // The tab sits in a deferred block with a minimum loading time, so wait for IT rather than for a fixed moment.
  await settle(() => !!el.querySelector('.sch-validation-bar'));
  // Once more, so what the reads issued by the first pass answered (the token's rights, the layers) has rendered.
  await settle();
  return { fixture, state, http, el, settle };
}

type Harness = Awaited<ReturnType<typeof mount>>;

const $ = (root: ParentNode, sel: string): HTMLElement | null => root.querySelector<HTMLElement>(sel);
const $$ = (root: ParentNode, sel: string): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>(sel));
const INTERACTIVE = 'button, input, select, textarea, a[href]';

/** The type pane (`.sch-detail`) with one type selected. */
async function selectType(h: Harness, kt: (typeof KNOWLEDGE_TYPES)[number], name: string): Promise<HTMLElement> {
  h.state.schemaCollTab.set(kt);
  await h.settle();
  // Clicked, as an operator does: the selection is a plain field of the state, and the tab is OnPush, so only an event
  // handler tells it to look again.
  const item = $$(h.el, '.sch-type-item').find(i => $(i, '.nm')?.textContent?.trim() === name);
  expect(item, `the type list has no "${name}"`).toBeDefined();
  item!.click();
  await h.settle();
  const pane = $(h.el, '.sch-detail');
  expect(pane, 'the type pane did not render').not.toBeNull();
  return pane!;
}

/** The rule row whose disclosure names `name`, in `root`. */
function ruleRow(root: ParentNode, name: string, testid = 'rule-row'): HTMLElement | null {
  return $$(root, `[data-testid="${testid}"]`).find(r => $(r, '[data-testid="rule-toggle"]')?.textContent?.includes(name)) ?? null;
}

/** Opens a disclosure if it is closed, and lets the tab render what it reveals. */
async function expand(h: Harness, row: HTMLElement | null): Promise<void> {
  expect(row, 'there is no rule row to open').not.toBeNull();
  const toggle = $(row!, '[data-testid="rule-toggle"]');
  expect(toggle, 'the rule row has no disclosure button').not.toBeNull();
  if (toggle!.getAttribute('aria-expanded') !== 'true') toggle!.click();
  await h.settle();
}

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => { document.body.innerHTML = ''; });

// ── the type pane ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('the type pane shows a type\'s rules after its property table', () => {
  it('the rules section comes after the property table, and lists each rule by name', async () => {
    const h = await mount();
    const pane = await selectType(h, 'entity', 'person');
    const table = $(pane, '.prop-table');
    const section = $(pane, '[data-testid="rules-section"]');
    expect(table, 'the property table did not render').not.toBeNull();
    expect(section, 'the type pane has no rules section').not.toBeNull();
    expect(table!.compareDocumentPosition(section!) & Node.DOCUMENT_POSITION_FOLLOWING, 'the rules come BEFORE the property table').toBeTruthy();
    expect($$(section!, '[data-testid="rule-row"]').map(r => $(r, '[data-testid="rule-toggle"]')!.textContent))
      .toEqual([expect.stringContaining('age-positive'), expect.stringContaining('title-long')]);
  });

  it('the type list carries a count badge for a type with rules, and none for a type without', async () => {
    const h = await mount();
    h.state.schemaCollTab.set('entity');
    await h.settle();
    const item = (name: string) => $$(h.el, '.sch-type-item').find(i => $(i, '.nm')?.textContent?.trim() === name)!;
    expect(item('person'), 'the type list did not render').toBeDefined();
    const badge = $(item('person'), '[data-testid="rules-count"]');
    expect(badge, 'no rules count badge on a type with two rules').not.toBeNull();
    expect(badge!.textContent).toContain('2');
    expect($(item('plain'), '[data-testid="rules-count"]')).toBeNull();
  });
});

describe('each rule is a disclosure, and its text is a monospace textarea', () => {
  it('the row\'s toggle is a button with aria-expanded that opens and closes the row, holding nothing interactive', async () => {
    const h = await mount();
    const pane = await selectType(h, 'entity', 'person');
    const row = ruleRow(pane, 'age-positive');
    expect(row, 'no row for the rule').not.toBeNull();
    const toggle = $(row!, '[data-testid="rule-toggle"]')!;
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.querySelector(INTERACTIVE), 'a control nested inside a button is not reachable by keyboard').toBeNull();
    toggle.click();
    await h.settle();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect($(row!, '[data-testid="rule-text"]')).not.toBeNull();
    toggle.click();
    await h.settle();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('the rule text is a <textarea> that edits the state, and the message is a control of its own', async () => {
    const h = await mount();
    const pane = await selectType(h, 'entity', 'person');
    const row = ruleRow(pane, 'age-positive')!;
    await expand(h, row);
    const text = $(row, '[data-testid="rule-text"]') as HTMLTextAreaElement | null;
    expect(text, 'no rule text control').not.toBeNull();
    expect(text!.tagName, 'a rule is a multi-line expression: it must not be a single-line input').toBe('TEXTAREA');
    expect(text!.value).toBe(AGE.rule);
    const message = $(row, '[data-testid="rule-message"]') as HTMLInputElement | HTMLTextAreaElement | null;
    expect(message, 'no message control').not.toBeNull();
    expect(message!.value).toBe(AGE.message);

    type(text!, 'self.properties.age >= 18');
    await h.settle();
    const rules = (h.state.typeState('entity', 'person') as unknown as { rules: { name: string; rule: string }[] }).rules;
    expect(rules.find(r => r.name === 'age-positive')?.rule).toBe('self.properties.age >= 18');
  });

  it('declares a monospace font for the rule text', async () => {
    const h = await mount();
    const pane = await selectType(h, 'entity', 'person');
    const row = ruleRow(pane, 'age-positive')!;
    await expand(h, row);
    const text = $(row, '[data-testid="rule-text"]');
    expect(text, 'no rule text control').not.toBeNull();
    // Read from the rules and the style attribute the way the other layout specs do: jsdom computes no cascade.
    expect(declaredNearest(text!, 'font-family', h.el), 'no font-family declared for the rule text').toMatch(/mono/i);
  });

  it('shows how much of each limit is used, for the rule and for the message, and keeps it current as you type', async () => {
    const h = await mount();
    const pane = await selectType(h, 'entity', 'person');
    const row = ruleRow(pane, 'age-positive')!;
    await expand(h, row);
    const ruleCounter = $(row, '[data-testid="rule-text-counter"]');
    const messageCounter = $(row, '[data-testid="rule-message-counter"]');
    expect(ruleCounter, 'no counter on the rule text').not.toBeNull();
    expect(messageCounter, 'no counter on the message').not.toBeNull();
    // 1000 and 300 are the server's MAX_RULE_LENGTH and MAX_MESSAGE_LENGTH; `client-limits-match-the-server.spec.ts` holds them.
    expect(ruleCounter!.getAttribute('data-limit')).toBe('1000');
    expect(messageCounter!.getAttribute('data-limit')).toBe('300');
    expect(ruleCounter!.getAttribute('data-used')).toBe(String(AGE.rule.length));
    expect(messageCounter!.getAttribute('data-used')).toBe(String(AGE.message.length));

    type($(row, '[data-testid="rule-text"]') as HTMLTextAreaElement, 'abc');
    type($(row, '[data-testid="rule-message"]') as HTMLInputElement, 'hello');
    await h.settle();
    expect(ruleCounter!.getAttribute('data-used')).toBe('3');
    expect(messageCounter!.getAttribute('data-used')).toBe('5');
  });
});

describe('the space rules that apply to the selected type are shown read-only in its pane', () => {
  const names = (list: HTMLElement) => ['no-future', 'few-tags', 'edges-only'].filter(n => (list.textContent ?? '').includes(n));

  it('an entity type sees the all-kinds rule and none of the rules for other kinds', async () => {
    const h = await mount();
    const pane = await selectType(h, 'entity', 'person');
    const list = $(pane, '[data-testid="applicable-rules"]');
    expect(list, 'the type pane lists no applicable space rules').not.toBeNull();
    expect(names(list!)).toEqual(['few-tags']);
  });

  it('a chrono type sees the rule for its kind and the all-kinds rule, and not the edge rule', async () => {
    const h = await mount();
    const pane = await selectType(h, 'chrono', 'event');
    const list = $(pane, '[data-testid="applicable-rules"]');
    expect(list, 'the type pane lists no applicable space rules').not.toBeNull();
    expect(names(list!)).toEqual(['no-future', 'few-tags']);
  });

  it('are read-only: no control inside the list can edit a space rule from the type pane', async () => {
    const h = await mount();
    const pane = await selectType(h, 'chrono', 'event');
    const list = $(pane, '[data-testid="applicable-rules"]');
    expect(list, 'the type pane lists no applicable space rules').not.toBeNull();
    expect(list!.querySelector('input, textarea, select')).toBeNull();
  });
});

describe('a linked ($ref) type shows the library entry\'s rules, read-only', () => {
  it('lists them by name, and offers no control that edits them', async () => {
    const h = await mount({ library: [LIBRARY_ENTRY] });
    const pane = await selectType(h, 'entity', 'linked');
    const section = $(pane, '[data-testid="rules-section"]');
    expect(section, 'a linked type shows no rules section').not.toBeNull();
    expect(section!.textContent).toContain('library-rule');
    expect(section!.querySelector('textarea, input, select')).toBeNull();
  });
});

// ── property rows ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('property rows are keyboard disclosures like the rules rows', () => {
  it('every property row has exactly one disclosure button, closed to start, that opens its detail', async () => {
    const h = await mount();
    const pane = await selectType(h, 'entity', 'person');
    const rows = $$(pane, '.prop-row');
    // Floor: the fixture declares two properties. An empty derivation would pass every loop below.
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      const toggles = $$(row, 'button[aria-expanded]');
      expect(toggles.length, `property row "${row.textContent?.trim().slice(0, 20)}" is a mouse-only <tr (click)>`).toBe(1);
      const toggle = toggles[0]!;
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.querySelector(INTERACTIVE), 'the Required checkbox and the remove button must not sit inside the disclosure').toBeNull();
      expect(toggle.tabIndex).toBeGreaterThanOrEqual(0);
    }
    const first = $(rows[0]!, 'button[aria-expanded]')!;
    first.click();
    await h.settle();
    expect(first.getAttribute('aria-expanded')).toBe('true');
    expect($(pane, '.prop-expand-row'), 'the detail did not open').not.toBeNull();
    first.click();
    await h.settle();
    expect(first.getAttribute('aria-expanded')).toBe('false');
    expect($(pane, '.prop-expand-row')).toBeNull();
  });
});

// ── space rules ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe('the space rules section sits under the validation bar', () => {
  it('follows the validation bar and lists the rules by name', async () => {
    const h = await mount();
    const bar = $(h.el, '.sch-validation-bar');
    const section = $(h.el, '[data-testid="space-rules-section"]');
    expect(bar, 'the validation bar did not render').not.toBeNull();
    expect(section, 'no space rules section on the Schema tab').not.toBeNull();
    expect(bar!.compareDocumentPosition(section!) & Node.DOCUMENT_POSITION_FOLLOWING, 'the space rules come BEFORE the validation bar').toBeTruthy();
    expect($$(section!, '[data-testid="space-rule-row"]').length).toBe(Object.keys(SPACE_RULES).length);
  });

  it('a rule\'s kinds are checkboxes, one per knowledge kind, ticked for the kinds it names and editing the state', async () => {
    const h = await mount();
    const section = $(h.el, '[data-testid="space-rules-section"]');
    expect(section, 'no space rules section on the Schema tab').not.toBeNull();
    const row = ruleRow(section!, 'no-future', 'space-rule-row');
    expect(row, 'no row for the no-future rule').not.toBeNull();
    await expand(h, row!);
    const boxes = $$(row!, '[data-testid="space-rule-kind"]') as HTMLInputElement[];
    expect(boxes.map(b => b.type)).toEqual(KNOWLEDGE_TYPES.map(() => 'checkbox'));
    expect(boxes.filter(b => b.checked).map(b => b.value).sort()).toEqual(['chrono', 'fact']);

    boxes.find(b => b.value === 'edge')!.click();
    await h.settle();
    const kinds = (h.state as unknown as { schRules: { name: string; kinds: string[] }[] }).schRules.find(r => r.name === 'no-future')?.kinds;
    expect([...(kinds ?? [])].sort()).toEqual(['chrono', 'edge', 'fact']);
  });

  it('is editable for a token with schema admin, with no reason shown', async () => {
    const h = await mount({ schemaRights: 'admin' });
    const section = $(h.el, '[data-testid="space-rules-section"]');
    expect(section, 'no space rules section on the Schema tab').not.toBeNull();
    await expand(h, ruleRow(section!, 'few-tags', 'space-rule-row')!);
    const text = $(section!, '[data-testid="rule-text"]') as HTMLTextAreaElement | null;
    expect(text, 'no rule text control').not.toBeNull();
    expect(text!.readOnly || text!.disabled).toBe(false);
    expect($(section!, '[data-testid="rules-readonly-reason"]')).toBeNull();
  });

  it('is read-only for a token without schema admin, and says why where it can be read', async () => {
    const h = await mount({ schemaRights: 'write' });
    const section = $(h.el, '[data-testid="space-rules-section"]');
    expect(section, 'no space rules section on the Schema tab').not.toBeNull();
    const reason = $(section!, '[data-testid="rules-readonly-reason"]');
    expect(reason, 'a read-only section with no visible reason is a dead form').not.toBeNull();
    expect((reason!.textContent ?? '').trim().length).toBeGreaterThan(0);
    expect(reason!.hidden).toBe(false);
    await expand(h, ruleRow(section!, 'no-future', 'space-rule-row')!);
    const controls = $$(section!, 'textarea, [data-testid="rule-message"], [data-testid="space-rule-kind"]') as HTMLInputElement[];
    expect(controls.length).toBeGreaterThan(0);
    for (const c of controls) expect(c.readOnly || c.disabled, `${c.tagName}${c.dataset['testid'] ? '[' + c.dataset['testid'] + ']' : ''} is still editable`).toBe(true);
  });
});

// ── a refused save opens the failing row and puts focus there ────────────────────────────────────────────────────────

describe('a refused schema save opens the failing rule and moves focus to it', () => {
  /** The zod-body refusal the server answers: bounded prose, and issues with their path. */
  const refusal = (path: string[]) => ({ error: 'The schema was refused', issues: [{ code: 'custom', path }] });

  async function save(h: Harness, status: number, body: unknown) {
    // A changed field of the settings form, so the footer Save has something to send whichever tab is open.
    h.state.stForm.purpose = 'changed purpose';
    h.fixture.componentInstance.saveSettings();
    h.http.expectOne(r => r.method === 'PATCH' && r.url === '/api/spaces/work').flush(body as never, { status, statusText: 'refused' });
    await h.settle();
  }

  it.each([[422], [400]])('a %i naming a type rule opens its collection, its type and its row, and focuses it', async (status) => {
    const h = await mount();
    // Start somewhere else entirely, so each step of the navigation is observable.
    await selectType(h, 'entity', 'person');
    await save(h, status, refusal(['meta', 'typeSchemas', 'edge', 'follows', 'rules', 'second-rule', 'rule']));

    const activeTab = $$(h.el, '[role="tab"][aria-selected="true"]').map(t => t.textContent ?? '').join(' ');
    expect(activeTab, 'the collection tab of the failing rule is not open').toContain('spaces.schema.tab.edges');
    expect($$(h.el, '.sch-type-item.sel').map(i => i.textContent).join(' '), 'the failing type is not selected').toContain('follows');
    const pane = $(h.el, '.sch-detail')!;
    const row = ruleRow(pane, 'second-rule');
    expect(row, 'the failing rule has no row').not.toBeNull();
    expect($(row!, '[data-testid="rule-toggle"]')!.getAttribute('aria-expanded'), 'the failing rule is not open').toBe('true');

    const alert = $(row!, '[role="alert"]');
    expect(alert, 'no inline error with role=alert on the failing row').not.toBeNull();
    expect((alert!.textContent ?? '').trim().length).toBeGreaterThan(0);
    expect($$(pane, '[data-testid="rule-row"] [role="alert"]').length, 'an error on a row the server did not name').toBe(1);

    const text = $(row!, '[data-testid="rule-text"]')!;
    expect(text.getAttribute('aria-invalid')).toBe('true');
    expect(alert!.id, 'the error has no id to point at').not.toBe('');
    expect(text.getAttribute('aria-describedby') ?? '').toContain(alert!.id);

    await h.settle(() => row!.contains(document.activeElement));
    expect(row!.contains(document.activeElement), 'focus did not move to the failing row').toBe(true);
    expect(h.state.settingsError(), 'the footer says nothing about the refusal').not.toBe('');
  });

  it('an issue on the message puts focus in the message control of that row', async () => {
    const h = await mount();
    await save(h, 422, refusal(['meta', 'typeSchemas', 'entity', 'person', 'rules', 'title-long', 'message']));
    const row = ruleRow($(h.el, '.sch-detail')!, 'title-long');
    expect(row, 'the failing rule has no row').not.toBeNull();
    const message = $(row!, '[data-testid="rule-message"]');
    expect(message, 'the failing row is not open').not.toBeNull();
    await h.settle(() => document.activeElement === message);
    expect(document.activeElement).toBe(message);
  });

  it('an issue on a space rule opens that row in the space rules section and focuses it', async () => {
    const h = await mount();
    await selectType(h, 'entity', 'person');
    await save(h, 422, refusal(['meta', 'rules', 'few-tags', 'rule']));
    const section = $(h.el, '[data-testid="space-rules-section"]');
    expect(section, 'no space rules section on the Schema tab').not.toBeNull();
    const row = ruleRow(section!, 'few-tags', 'space-rule-row');
    expect(row, 'the failing space rule has no row').not.toBeNull();
    expect($(row!, '[data-testid="rule-toggle"]')!.getAttribute('aria-expanded')).toBe('true');
    expect($(row!, '[role="alert"]'), 'no inline error on the failing space rule').not.toBeNull();
    await h.settle(() => row!.contains(document.activeElement));
    expect(row!.contains(document.activeElement), 'focus did not move to the failing space rule').toBe(true);
  });
});

// ── layer-supplied fields ────────────────────────────────────────────────────────────────────────────────────────────

describe('a field a network layer supplies is marked with that network and can be proposed', () => {
  it('marks the clashing property with the NAME of the network whose definition applies, and no other property', async () => {
    const h = await mount({ layers: LAYERS });
    const pane = await selectType(h, 'entity', 'person');
    const rows = $$(pane, '.prop-row');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const rowOf = (key: string) => rows.find(r => $(r, '.prop-name-key')?.textContent?.trim() === key)!;
    const marker = $(rowOf('age'), '[data-testid="layer-marker"]');
    expect(marker, 'the property a network supplies carries no marker').not.toBeNull();
    expect(marker!.textContent).toContain('Alpha Federation');
    expect($(rowOf('name'), '[data-testid="layer-marker"]'), 'a property no network touches must not be marked').toBeNull();
  });

  it('carries a keyboard-reachable Propose button that proposes to a network on the clash', async () => {
    const h = await mount({ layers: LAYERS });
    const pane = await selectType(h, 'entity', 'person');
    const row = $$(pane, '.prop-row').find(r => $(r, '.prop-name-key')?.textContent?.trim() === 'age')!;
    const propose = $(row, '[data-testid="propose-to-network"]') as HTMLButtonElement | null;
    expect(propose, 'no Propose control on the marked property').not.toBeNull();
    expect(propose!.tagName).toBe('BUTTON');
    expect(propose!.disabled).toBe(false);
    expect(propose!.tabIndex).toBeGreaterThanOrEqual(0);
    expect(propose!.closest('[aria-hidden="true"]')).toBeNull();

    propose!.click();
    await h.settle();
    const req = h.http.expectOne(r => r.method === 'PATCH' && r.url === '/api/spaces/work');
    expect(['net-a', 'net-b']).toContain((req.request.body as { targetNetwork?: string }).targetNetwork);
    expect((req.request.body as { meta?: unknown }).meta).toBeDefined();
    req.flush({});
  });
});

// ── the live check ───────────────────────────────────────────────────────────────────────────────────────────────────

describe('Validate runs the live check, in sample mode and in stored-data mode', () => {
  const URL = '/api/spaces/work/validate-schema';
  const post = (h: Harness) => h.http.expectOne(r => r.method === 'POST' && r.url === URL);
  const answer = (over: Record<string, unknown> = {}) => ({
    spaceId: 'work', checked: { entities: { checked: 1, total: 1 } }, complete: true, totalViolations: 0, violations: [], staleGuards: [], ...over,
  });
  const button = (h: Harness) => $(h.el, '[data-testid="validate-schema"]') as HTMLButtonElement | null;

  async function chooseMode(h: Harness, mode: 'sample' | 'stored') {
    const radio = $(h.el, `[data-testid="validate-mode-${mode}"]`);
    expect(radio, `no ${mode} mode control`).not.toBeNull();
    radio!.click();
    await h.settle();
  }

  it('the Schema tab has a Validate button', async () => {
    const h = await mount();
    expect(button(h), 'no Validate button on the Schema tab').not.toBeNull();
    expect(button(h)!.tagName).toBe('BUTTON');
  });

  it('sample mode sends the pasted record as `sample`, with no cursor, and scans nothing', async () => {
    const h = await mount();
    await chooseMode(h, 'sample');
    const record = { kind: 'entity', type: 'person', properties: { age: -1 } };
    const box = $(h.el, '[data-testid="validate-sample"]') as HTMLTextAreaElement | null;
    expect(box, 'no field to paste a sample into').not.toBeNull();
    type(box!, JSON.stringify(record));
    await h.settle();
    button(h)!.click();
    const req = post(h);
    const body = req.request.body as { sample?: unknown; cursor?: unknown };
    expect(body.sample).toEqual(record);
    expect(body.cursor).toBeUndefined();
    req.flush(answer());
  });

  it('a sample that is not JSON sends nothing and says so as an alert', async () => {
    const h = await mount();
    await chooseMode(h, 'sample');
    const box = $(h.el, '[data-testid="validate-sample"]') as HTMLTextAreaElement | null;
    expect(box, 'no field to paste a sample into').not.toBeNull();
    type(box!, '{ not json');
    await h.settle();
    button(h)!.click();
    await h.settle();
    h.http.expectNone(r => r.method === 'POST' && r.url === URL);
    // An alert that belongs to no rule row: the pasted text, not a rule, is what is wrong.
    const alerts = $$(h.el, '[role="alert"]').filter(a => !a.closest('[data-testid="rule-row"], [data-testid="space-rule-row"]'));
    expect(alerts.length, 'no alert for an unreadable sample').toBeGreaterThan(0);
  });

  it('the all-good word appears only when the check is COMPLETE and found nothing', async () => {
    const cases: [string, Record<string, unknown>, boolean][] = [
      ['complete and clean', answer(), true],
      ['clean so far but not complete', answer({ complete: false, checked: { entities: { checked: 5, total: 9 } } }), false],
      ['complete with a violation', answer({ totalViolations: 1, violations: [{ collection: 'entities', _id: 'e1', violations: [{ field: 'rules.age-positive', reason: 'x' }] }] }), false],
    ];
    for (const [label, body, allGood] of cases) {
      const h = await mount();
      await chooseMode(h, 'sample');
      type($(h.el, '[data-testid="validate-sample"]') as HTMLTextAreaElement, '{"kind":"entity","type":"person","properties":{}}');
      await h.settle();
      button(h)!.click();
      post(h).flush(body);
      await h.settle();
      expect(!!$(h.el, '[data-testid="validate-all-good"]'), label).toBe(allGood);
      document.body.innerHTML = '';
    }
  });

  it('stored-data mode pages: the second request carries the cursor the first answer gave, until it is complete', async () => {
    const h = await mount();
    await chooseMode(h, 'stored');
    button(h)!.click();

    const first = post(h);
    const firstBody = first.request.body as { sample?: unknown; cursor?: unknown };
    expect(firstBody.sample, 'stored-data mode sent a sample').toBeUndefined();
    expect(firstBody.cursor, 'the first page carries no cursor').toBeUndefined();
    // Both spellings of the answer's cursor field are given, so the spec asks for the BEHAVIOUR (carry it) not the name.
    first.flush(answer({ checked: { entities: { checked: 100, total: 250 } }, complete: false, cursor: 'cur-1', nextCursor: 'cur-1' }));
    await h.settle();

    const progress = $(h.el, '[data-testid="validate-progress"]');
    expect(progress, 'no checked/total readout').not.toBeNull();
    expect(progress!.getAttribute('data-checked')).toBe('100');
    expect(progress!.getAttribute('data-total')).toBe('250');
    expect($(h.el, '[data-testid="validate-all-good"]'), 'all-good shown for an incomplete check').toBeNull();

    // The next page is fetched either by itself or by a Continue control; both are legitimate designs for a heavy,
    // rate-limited scan, so the spec presses Continue only if there is one.
    const next = $(h.el, '[data-testid="validate-continue"]');
    if (next) { next.click(); await h.settle(); }
    const second = post(h);
    expect((second.request.body as { cursor?: unknown }).cursor).toBe('cur-1');
    second.flush(answer({ checked: { entities: { checked: 250, total: 250 } }, complete: true }));
    await h.settle();

    expect($(h.el, '[data-testid="validate-progress"]')!.getAttribute('data-checked')).toBe('250');
    expect($(h.el, '[data-testid="validate-all-good"]'), 'all-good missing after a complete check').not.toBeNull();
    // Complete means done: no third request.
    await h.settle();
    h.http.expectNone(r => r.method === 'POST' && r.url === URL);
  });
});
