/**
 * The history dialog of one type (design r4 §7.6, test C1), mounted alone over the REAL `SchemaApi` on a fake HTTP backend, so what
 * is fixed is the request it makes and the screen it draws, never a method name.
 *
 * ## The contract this spec fixes for the build (chosen here and listed in the hand-off)
 *
 * - `SchemaTypeHistoryComponent` in `schema-type-history.component.ts`, selector `app-schema-type-history`, inputs `spaceId`, `kind`,
 *   `type`, optional `chosen` (a stamp to choose first: the drawer's Compare), output `closed`.
 * - It is a `role="dialog"` named by its heading. Test ids: `history-help-toggle`, `history-close`, `history-one`,
 *   `history-failed`, `history-read-again`, `history-open-records` (the quiet per-definition link) and `history-open-older`
 *   (the foot's primary link). The two Open links are `<a href>` into the Brain (`/brain?space=…&tab=…&type=…&definition=…`).
 * - Definitions are `role="option"` in one `role="listbox"`.
 *
 * Dates go through `DateFormatService`, stubbed here to spell every digit as a letter: a date the dialog formats itself shows a
 * digit, and so does any fingerprint it leaks, which is how "no server-sourced digit outside dates" is asserted.
 *
 * ## Seen red
 *
 * Red on 327b105e: `./schema-type-history.component` does not exist.
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { DateFormatService } from '../../core/date-format.service';
import { stripComments } from '../../testing/strip-comments';
import { SchemaTypeHistoryComponent } from './schema-type-history.component';

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Spells 0-9 as a-j, so a formatted date carries no digit and is still told apart from every other date. */
const spell = (v: unknown): string => `«${String(v instanceof Date ? v.toISOString() : v).slice(0, 10).replace(/\d/g, d => 'abcdefghij'[+d]!)}»`;
const dates = {
  format: vi.fn((v: unknown) => spell(v)),
  transform: vi.fn((v: unknown) => spell(v)),
  parts: vi.fn((v: unknown) => ({ date: spell(v), time: '', iso: '' })),
  calendarDate: vi.fn((v: unknown) => spell(v)),
  relative: vi.fn((v: unknown) => spell(v)),
  iso: vi.fn((v: unknown) => spell(v)),
  options: () => ({ style: 'auto', zone: 'local', locale: 'en' }),
};

/** Translations only where a parameter must show; every other key echoes, and no key holds a digit. */
const EN = {
  'spaces.schema.history.title': 'History of {{type}}',
  'spaces.schema.history.span': '{{since}} to {{until}}',
  'spaces.schema.history.spanFrom': 'From {{since}}',
  'spaces.schema.history.currentSince': 'Current, since {{since}}',
  'spaces.schema.history.oneDefinition': 'One definition so far, {{since}}. Nothing has changed yet.',
  'spaces.schema.history.failed': 'Could not read the history: {{reason}}',
  'spaces.schema.history.origin.layer': 'Network layer: {{name}}',
  'spaces.schema.history.wholeDefinition': 'The whole definition',
  'spaces.schema.history.facet.required': 'required',
  'spaces.schema.history.facet.pattern': 'pattern {{value}}',
  'spaces.schema.history.facet.not': 'not {{facet}}',
  'propertiesEditor.notDeclared': 'not declared',
  'common.yes': 'Yes',
  'common.no': 'No',
};

const ORIGIN_EDITED = { edited: true, networks: [], fetched: false };
const CURRENT = 'ff99aa00ff99aa00';
const OLDER = 'cc33dd44cc33dd44';
const OLDEST = 'aa11bb22aa11bb22';

const page = (definitions: unknown[], extra: Record<string, unknown> = {}) => ({
  kind: 'entity', type: 'person', current: CURRENT, declared: 'own', definitions,
  count: definitions.length, total: definitions.length, limit: 20, skip: 0, truncated: false, ...extra,
});
const ONE = page([{ rep: CURRENT, current: true, since: '2026-10-21T08:00:00.000Z', origin: ORIGIN_EDITED }]);
const SEVERAL = page([
  { rep: CURRENT, current: true, since: '2026-11-03T08:00:00.000Z', origin: ORIGIN_EDITED },
  { rep: OLDER, current: false, since: '2026-10-21T08:00:00.000Z', until: '2026-11-03T08:00:00.000Z', origin: { edited: false, networks: ['net-a'], fetched: false } },
  { rep: OLDEST, current: false, since: '2026-09-01T08:00:00.000Z', until: '2026-10-21T08:00:00.000Z', origin: { edited: false, networks: [], fetched: true } },
]);

// ── harness ──────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Open { fixture: ComponentFixture<SchemaTypeHistoryComponent>; http: HttpTestingController; el: HTMLElement; closed: number[] }

async function open(inputs: { kind?: string; type?: string; chosen?: string; title?: string } = {}): Promise<Open> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [SchemaTypeHistoryComponent, getTranslocoModule({ translation: { en: inputs.title ? { ...EN, 'spaces.schema.history.title': inputs.title } : EN } })],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), { provide: DateFormatService, useValue: dates }],
  });
  const http = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(SchemaTypeHistoryComponent);
  document.body.appendChild(fixture.nativeElement);
  fixture.componentRef.setInput('spaceId', 'work');
  fixture.componentRef.setInput('kind', inputs.kind ?? 'entity');
  fixture.componentRef.setInput('type', inputs.type ?? 'person');
  if (inputs.chosen) fixture.componentRef.setInput('chosen', inputs.chosen);
  const closed: number[] = [];
  (fixture.componentInstance as unknown as { closed: { subscribe(f: () => void): void } }).closed.subscribe(() => closed.push(1));
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, http, el: fixture.nativeElement as HTMLElement, closed };
}

const settle = async (h: Open) => { h.fixture.detectChanges(); await h.fixture.whenStable(); h.fixture.detectChanges(); };
const $ = (root: ParentNode, sel: string) => root.querySelector<HTMLElement>(sel);
const $$ = (root: ParentNode, sel: string) => Array.from(root.querySelectorAll<HTMLElement>(sel));

/** The pending GETs of the versions door, with their parameters. */
function versionReads(h: Open): { req: TestRequest; p: Record<string, string> }[] {
  return h.http.match(r => r.method === 'GET' && r.url.split('?')[0] === '/api/spaces/work/schema-versions').map(req => {
    const p: Record<string, string> = {};
    for (const k of req.request.params.keys()) p[k] = req.request.params.get(k)!;
    const q = req.request.urlWithParams.split('?')[1];
    if (q) for (const [k, v] of new URLSearchParams(q)) p[k] = v;
    return { req, p };
  });
}

/** Answers the history read (kind + type) with `body`; leaves any other read pending. */
async function answerHistory(h: Open, body: unknown, status = 200): Promise<void> {
  const reads = versionReads(h).filter(r => r.p['kind'] && r.p['type'] && !r.p['fp'] && !r.p['fps']);
  expect(reads.length, 'the dialog did not read the history (kind + type)').toBe(1);
  expect(reads[0]!.p).toMatchObject({ kind: 'entity', type: 'person' });
  if (status === 200) reads[0]!.req.flush(body as never);
  else reads[0]!.req.flush(body as never, { status, statusText: 'x' });
  await settle(h);
}

afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers(); dates.format.mockClear(); });

// ── the cases ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('the history dialog: head and help (C1)', () => {
  it('is a dialog named by its heading, and its help is closed until "?" opens it through aria-expanded', async () => {
    const h = await open();
    await answerHistory(h, SEVERAL);
    const dialog = $(h.el, '[role="dialog"]');
    expect(dialog, 'no role="dialog"').not.toBeNull();
    const labelId = dialog!.getAttribute('aria-labelledby');
    expect(labelId, 'the dialog is not named by its heading').toBeTruthy();
    expect(document.getElementById(labelId!)?.textContent).toContain('History of person');

    const toggle = $(h.el, '[data-testid="history-help-toggle"]');
    expect(toggle?.tagName).toBe('BUTTON');
    expect(toggle!.getAttribute('aria-expanded')).toBe('false');
    const box = document.getElementById(toggle!.getAttribute('aria-controls') ?? '');
    expect(box, 'the toggle controls no box').not.toBeNull();
    expect(box!.hidden, 'the help is open by default').toBe(true);
    toggle!.click();
    await settle(h);
    expect(toggle!.getAttribute('aria-expanded')).toBe('true');
    expect(box!.hidden).toBe(false);
    expect(box!.textContent).toContain('spaces.schema.history.help.keeps');
    expect(box!.textContent).toContain('spaces.schema.history.help.mark');
  });
});

describe('the history dialog: what it lists (C1)', () => {
  it('one definition is one line in one column: no listbox and no comparison', async () => {
    const h = await open();
    await answerHistory(h, ONE);
    const line = $(h.el, '[data-testid="history-one"]');
    expect(line, 'no one-definition line').not.toBeNull();
    expect(line!.textContent).toContain('One definition so far, «cacg-ba-cb»');
    expect($(h.el, '[role="listbox"]')).toBeNull();
    expect(h.el.textContent).not.toContain('spaces.schema.history.whatChanged');
  });

  it('several definitions are options of one listbox, each with its span and origin; the current one says so', async () => {
    const h = await open();
    await answerHistory(h, SEVERAL);
    const box = $(h.el, '[role="listbox"]');
    expect(box, 'no listbox').not.toBeNull();
    const options = $$(box!, '[role="option"]');
    expect(options.length).toBe(3);
    expect(options[0]!.textContent).toContain('Current, since «cacg-bb-ad»');
    expect(options[1]!.textContent).toContain('«cacg-ba-cb» to «cacg-bb-ad»');
    expect(options[1]!.textContent).toContain('Network layer: net-a');
    expect(options[2]!.textContent).toContain('«cacg-aj-ab» to «cacg-ba-cb»');
    expect(options[2]!.textContent).toContain('spaces.schema.history.origin.fetched');
    expect(options[0]!.textContent).toContain('spaces.schema.history.origin.edited');
    expect(dates.format).toHaveBeenCalled();
  });

  it('no digit from the server reaches the dialog outside a date: fingerprints are never shown', async () => {
    const h = await open();
    await answerHistory(h, SEVERAL);
    expect($$(h.el, '[role="option"]').length).toBe(3);
    expect(h.el.textContent).not.toMatch(/\d/);
  });

  it('an undeclared type says it is not in the current schema, and has no foot button', async () => {
    const h = await open();
    await answerHistory(h, page([{ rep: OLDER, current: false, since: '2026-10-21T08:00:00.000Z', until: '2026-11-03T08:00:00.000Z', origin: ORIGIN_EDITED }], { declared: 'none' }));
    expect(h.el.textContent).toContain('spaces.schema.history.notInSchema');
    expect($(h.el, '[data-testid="history-open-older"]')).toBeNull();
  });

  it('cut: true adds the line that earlier definitions are not listed; without it there is no such line', async () => {
    const cut = await open();
    await answerHistory(cut, { ...SEVERAL, cut: true });
    expect(cut.el.textContent).toContain('spaces.schema.history.cut');
    const whole = await open();
    await answerHistory(whole, SEVERAL);
    expect(whole.el.textContent).not.toContain('spaces.schema.history.cut');
  });
});

describe('the history dialog: the Open links (C1, r4 §5.4, §6)', () => {
  const hrefOf = (el: HTMLElement | null) => decodeURIComponent(el?.getAttribute('href') ?? '');

  it('the foot opens the type\'s Brain tab with definition=older, and a definition\'s quiet link with definition=sameAs:<rep>', async () => {
    const h = await open();
    await answerHistory(h, SEVERAL);
    const older = $(h.el, '[data-testid="history-open-older"]');
    expect(older?.tagName, 'the foot action is not a link').toBe('A');
    const foot = hrefOf(older);
    expect(foot).toMatch(/^\/brain\?/);
    expect(foot).toContain('space=work');
    expect(foot).toContain('tab=entities');
    expect(foot).toContain('type=person');
    expect(foot).toContain('definition=older');

    $$(h.el, '[role="option"]')[1]!.click();
    await settle(h);
    const one = $(h.el, '[data-testid="history-open-records"]');
    expect(one?.tagName).toBe('A');
    expect(hrefOf(one)).toContain(`definition=sameAs:${OLDER}`);
    expect(one!.getAttribute('aria-label') ?? '').toContain('spaces.schema.history.openRecordsAria');
  });

  it('withheld record facts hide both Open links, and the definitions still show', async () => {
    const h = await open();
    await answerHistory(h, { ...SEVERAL, recordFacts: 'withheld' });
    expect($$(h.el, '[role="option"]').length).toBe(3);
    $$(h.el, '[role="option"]')[1]!.click();
    await settle(h);
    expect($(h.el, '[data-testid="history-open-older"]')).toBeNull();
    expect($(h.el, '[data-testid="history-open-records"]')).toBeNull();
  });

  it('choosing a definition reads what changed: the comparison narrowed to the type, against current', async () => {
    const h = await open();
    await answerHistory(h, SEVERAL);
    versionReads(h).forEach(r => r.req.flush({}));
    $$(h.el, '[role="option"]')[2]!.click();
    await settle(h);
    const asks = versionReads(h).map(r => r.p);
    expect(asks).toContainEqual({ fp: OLDEST, against: CURRENT, kind: 'entity', type: 'person' });
  });

  it('chosen opens the dialog on that definition', async () => {
    const h = await open({ chosen: OLDER });
    await answerHistory(h, SEVERAL);
    const options = $$(h.el, '[role="option"]');
    expect(options.map(o => o.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
  });
});

describe('the history dialog: keyboard and focus (C1, r3 §9.3)', () => {
  const key = (el: HTMLElement, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

  it('arrows, Home and End move the choice, and exactly one option is in the tab order (roving tabindex)', async () => {
    const h = await open();
    await answerHistory(h, SEVERAL);
    const opts = () => $$(h.el, '[role="option"]');
    const selected = () => opts().findIndex(o => o.getAttribute('aria-selected') === 'true');
    const tabbable = () => opts().map(o => o.getAttribute('tabindex'));
    opts()[0]!.click();
    await settle(h);
    expect(selected()).toBe(0);
    expect(tabbable()).toEqual(['0', '-1', '-1']);
    key(opts()[0]!, 'ArrowDown'); await settle(h);
    expect(selected()).toBe(1);
    expect(document.activeElement).toBe(opts()[1]);
    expect(tabbable()).toEqual(['-1', '0', '-1']);
    key(opts()[1]!, 'End'); await settle(h);
    expect(selected()).toBe(2);
    key(opts()[2]!, 'ArrowDown'); await settle(h);
    expect(selected(), 'ArrowDown past the last option moved').toBe(2);
    key(opts()[2]!, 'Home'); await settle(h);
    expect(selected()).toBe(0);
    key(opts()[0]!, 'ArrowUp'); await settle(h);
    expect(selected()).toBe(0);
    expect(document.activeElement).toBe(opts()[0]);
  });

  it('Close emits closed and gives the focus back to what had it when the dialog opened', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'opener';
    document.body.appendChild(opener);
    opener.focus();
    const h = await open();
    await answerHistory(h, SEVERAL);
    const close = $(h.el, '[data-testid="history-close"]');
    expect(close?.getAttribute('aria-label')).toBe('spaces.schema.history.closeAria');
    close!.click();
    await settle(h);
    expect(h.closed.length).toBe(1);
    expect(document.activeElement).toBe(opener);
  });
});

describe('the history dialog: loading and failing quietly (C1, r4 §7.6)', () => {
  it('while the read is out it says it is reading, with aria-busy', async () => {
    const h = await open();
    const busy = $(h.el, '[aria-busy="true"]');
    expect(busy, 'nothing is aria-busy while the history loads').not.toBeNull();
    expect(busy!.textContent).toContain('spaces.schema.history.loading');
    await answerHistory(h, SEVERAL);
    expect($(h.el, '[aria-busy="true"]')).toBeNull();
  });

  it('a server that did not answer shows one block naming that cause, and Read again asks again', async () => {
    const h = await open();
    await answerHistory(h, { error: 'boom' }, 500);
    const block = $(h.el, '[data-testid="history-failed"]');
    expect(block, 'no failure block').not.toBeNull();
    expect(block!.textContent).toContain('Could not read the history: common.reason.noAnswer');
    expect($$(h.el, '[data-testid="history-failed"]').length).toBe(1);
    expect($(h.el, '[role="listbox"]')).toBeNull();
    $(block!, '[data-testid="history-read-again"]')!.click();
    await settle(h);
    await answerHistory(h, SEVERAL);
    expect($(h.el, '[data-testid="history-failed"]')).toBeNull();
    expect($$(h.el, '[role="option"]').length).toBe(3);
  });

  it('an index still being built names that cause', async () => {
    const h = await open();
    await answerHistory(h, { error: 'x', code: 'schema_index_building' }, 503);
    expect($(h.el, '[data-testid="history-failed"]')!.textContent).toContain('common.reason.indexBuilding');
  });

  it('busy is shown only after three more asks, and then names that cause', async () => {
    vi.useFakeTimers();
    const h = await open();
    const busy = { error: 'x', code: 'schema_versions_busy' };
    await answerHistory(h, busy, 503);
    expect($(h.el, '[data-testid="history-failed"]'), 'failed at the first busy').toBeNull();
    for (const wait of [1000, 2000, 4000]) {
      await vi.advanceTimersByTimeAsync(wait);
      await answerHistory(h, busy, 503);
    }
    await vi.advanceTimersByTimeAsync(10);
    await settle(h);
    expect($(h.el, '[data-testid="history-failed"]')!.textContent).toContain('common.reason.busy');
  });
});

// ── what changed, and how the dialog looks (Q-744 verify fixes F2, F3, F5) ───────────────────────────────────────────

/** The stylesheet text the component carries (its own rules and the shared dialog shell), comments removed. */
function componentCss(): string {
  const styles = (SchemaTypeHistoryComponent as unknown as { ɵcmp: { styles: string[] } }).ɵcmp.styles;
  expect(styles.length, 'the component carries no styles').toBeGreaterThan(0);
  // The compiler may already have scoped the selectors (`.cmp[_ngcontent-%COMP%]`); the rules are read as written.
  return stripComments(styles.join('\n')).replace(/\[_ng(?:content|host)-[^\]]*\]/g, '');
}

interface CssRule { media: string; selectors: string[]; body: string }

/** The rules of a stylesheet, each with the `@media` it sits in ('' for none); one level of nesting, which is all the dialog uses. */
function cssRules(css: string): CssRule[] {
  const out: CssRule[] = [];
  const walk = (text: string, media: string): void => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const head = text.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (j < text.length && depth > 0) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
      const inner = text.slice(open + 1, j - 1);
      if (head.startsWith('@media')) walk(inner, head.replace(/\s+/g, ' '));
      else out.push({ media, selectors: head.split(',').map(s => s.trim().replace(/\s+/g, ' ')), body: inner });
      i = j;
    }
  };
  walk(css, '');
  return out;
}

/** The declarations of every rule naming exactly `selector`, inside `media` ('' for outside any). */
function decls(selector: string, media = ''): string {
  const css = componentCss();
  const hit = cssRules(css).filter(r => r.media === media && r.selectors.includes(selector));
  if (!hit.length) throw new Error(`no rule for "${selector}" in "${media}"; the stylesheet reads: ${css.replace(/\s+/g, ' ').slice(css.indexOf('.hist-head'), css.indexOf('.hist-head') + 700)}`);
  return hit.map(r => r.body).join(' ').replace(/\s+/g, ' ');
}

const PHONE = '@media (max-width: 760px)';

const COMPARE = (changes: unknown[], unread: string[] = []) => ({ kind: 'entity', type: 'person', types: [{ kind: 'entity', type: 'person', changes }], unread });

/** Opens the dialog on the older definition and answers its comparison with `changes`. */
async function openCompared(changes: unknown[], inputs: Parameters<typeof open>[0] = {}): Promise<Open> {
  const h = await open({ chosen: OLDER, ...inputs });
  await answerHistory(h, SEVERAL);
  const ask = versionReads(h).find(r => r.p['fp'] === OLDER);
  expect(ask, 'no comparison was asked').toBeTruthy();
  ask!.req.flush(COMPARE(changes) as never);
  await settle(h);
  return h;
}

const cells = (h: Open, cls: string) => $$(h.el, `.cmp ${cls}`).map(c => c.textContent!.trim());
const valuesOf = (h: Open, cls: string) => $$(h.el, `.cmp ${cls} .val`).map(c => c.textContent!.trim());

describe('the history dialog: What changed in words (F3)', () => {
  it('a place shows as the property, a value as words, an absent side as "not declared"', async () => {
    const h = await openCompared([
      { place: 'propertySchemas.size', to: { type: 'number' }, class: 'structural' },
      { place: 'propertySchemas.email.required', from: false, to: true, class: 'structural' },
      { place: 'propertySchemas.orcid', to: { type: 'string', pattern: '0000-0000-0000-000X' }, class: 'structural' },
      { place: 'propertySchemas.email.description', from: 'Work address', to: 'Work address, used for sign-in', class: 'wording' },
      { place: 'retention.days', from: 30, to: ['a', 'b'], class: 'lifecycle' },
      { place: '', from: { a: 1 }, to: { b: 2 }, class: 'structural' },
    ]);
    expect(cells(h, '.pl')).toEqual(['size', 'email: required', 'orcid', 'email: description', 'retention.days', 'The whole definition']);
    expect(valuesOf(h, '.was')).toEqual(['not declared', 'no', 'not declared', 'Work address', '30', '{"a":1}']);
    expect(valuesOf(h, '.now')).toEqual(['number', 'yes', 'string, pattern 0000-0000-0000-000X', 'Work address, used for sign-in', 'a, b', '{"b":2}']);
    expect(h.el.textContent).not.toContain('propertySchemas');
    expect(h.el.textContent).not.toContain('{"type"');
  });

  it('a value is bound as text: markup in a member\'s schema stays text', async () => {
    const h = await openCompared([{ place: 'propertySchemas.note', from: '<img src=x onerror=alert(1)>', to: { type: 'string', pattern: '<b>x</b>' }, class: 'structural' }]);
    expect($$(h.el, '.cmp img, .cmp b').length).toBe(0);
    expect(valuesOf(h, '.was')).toEqual(['<img src=x onerror=alert(1)>']);
    expect(valuesOf(h, '.now')).toEqual(['string, pattern <b>x</b>']);
  });
});

describe('the history dialog: the compare layout (F2)', () => {
  it('names each side with the column words in the cell, shown only where the head row is hidden', async () => {
    const h = await openCompared([{ place: 'propertySchemas.size', to: { type: 'number' }, class: 'structural' }]);
    expect($$(h.el, '.cmp .was .lbl').map(e => e.textContent!.trim())).toEqual(['spaces.schema.history.thisDefinition:']);
    expect($$(h.el, '.cmp .now .lbl').map(e => e.textContent!.trim())).toEqual(['spaces.schema.history.currentColumn:']);
    expect(decls('.cmp .lbl')).toContain('display: none');
    expect(decls('.cmp .lbl', PHONE)).toContain('display: inline');
    expect(decls('.cmp .h', PHONE)).toContain('display: none');
  });

  it('at phone width each change is one block: one column, the place, then the two values', () => {
    // jsdom lays nothing out, so the rule that stacks the grid is read from the stylesheet.
    expect(decls('.cmp', PHONE)).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(decls('.hcols', PHONE)).toContain('grid-template-columns: minmax(0, 1fr)');
    for (const cls of ['.cmp .pl', '.cmp .was', '.cmp .now']) expect(decls(cls, PHONE), cls).toContain('grid-column: 1');
  });

  it('no grid track can outgrow the dialog: every column is minmax(0, …), and the long strings wrap', () => {
    const tracks = [...componentCss().matchAll(/grid-template-columns:\s*([^;}]+)/g)].map(m => m[1]!);
    expect(tracks.length).toBeGreaterThan(2);
    // minmax(0, …) tracks, or a fixed one (the chevron's 12px): a bare 1fr or auto track grows to its widest word.
    for (const t of tracks) expect(t.replace(/minmax\(0,\s*[^)]+\)|\b\d+px\b/g, '').trim(), `a track of "${t}" is not minmax(0, …)`).toBe('');
    for (const sel of ['.hist-title', '.cmp .pl', '.cmp .val', '.di .l2']) expect(decls(sel), sel).toContain('overflow-wrap: anywhere');
    expect(decls('.hist-title')).toContain('min-width: 0');
  });
});

describe('the history dialog: the look the mockup draws (F5)', () => {
  it('the type in the title is monospace in the accent colour, the title still reads whole', async () => {
    const h = await open({ type: 'person' });
    await answerHistory(h, SEVERAL);
    const title = $(h.el, '.hist-title')!;
    expect($(title, '.tn')!.textContent).toBe('person');
    expect(title.textContent!.trim()).toBe('History of person');
    expect($(h.el, '[role="dialog"]')!.getAttribute('aria-label')).toBe('History of person');
    expect(decls('.hist-title .tn')).toContain('font-family: var(--font-mono');
    expect(decls('.hist-title .tn')).toContain('color: var(--accent)');
  });

  it('the type goes where the language puts it: before, between and after the words', async () => {
    for (const [sentence, text] of [['Verlauf von {{type}}', 'Verlauf von person'], ['{{type}}: Verlauf', 'person: Verlauf'], ['Historia typu {{type}} w tej przestrzeni', 'Historia typu person w tej przestrzeni']] as const) {
      const h = await open({ type: 'person', title: sentence });
      await answerHistory(h, SEVERAL);
      const title = $(h.el, '.hist-title')!;
      expect(title.textContent!.trim(), sentence).toBe(text);
      expect($(title, '.tn')!.textContent, sentence).toBe('person');
      expect($(h.el, '[role="dialog"]')!.getAttribute('aria-label'), sentence).toBe(text);
    }
  });

  it('Open records is a muted underlined link at the right end of its row, not accent-coloured', () => {
    const quiet = decls('.quiet');
    expect(quiet).toContain('color: var(--text-secondary)');
    expect(quiet).toContain('text-decoration: underline');
    expect(quiet).not.toContain('--accent');
    expect(decls('.sel-head')).toContain('justify-content: space-between');
  });

  it('the selected definition has a 2px accent bar at its left and an accent chevron', () => {
    expect(decls('.di[aria-selected="true"]')).toContain('box-shadow: inset 2px 0 0 var(--accent)');
    expect(decls('.di[aria-selected="true"] .chev')).toContain('color: var(--accent)');
  });

  it('the current column is bold and the place is monospace', () => {
    expect(decls('.cmp .now')).toMatch(/font-weight: (600|700)/);
    expect(decls('.cmp .pl')).toContain('font-family: var(--font-mono');
  });
});
