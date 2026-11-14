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

async function open(inputs: { kind?: string; type?: string; chosen?: string } = {}): Promise<Open> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [SchemaTypeHistoryComponent, getTranslocoModule({ translation: { en: EN } })],
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
