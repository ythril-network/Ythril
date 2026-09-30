/**
 * A shortened search answer says so on the page, and the size ceiling is reachable from the form.
 *
 * ## The defect
 *
 * The server has reported `truncated` since the result spill shipped and the client **never read it**. So a
 * hundred-match search could render a handful of records with nothing anywhere on the page explaining why —
 * under the old record cap that was three records out of a hundred. A reader who scrolls to the end of a
 * shortened answer has already concluded that is all there was.
 *
 * The five accounting fields were typed in the byte-budget commit precisely so this gap would be visible to
 * whoever picked it up; nothing read them until now.
 *
 * ## And the second half
 *
 * `Show advanced` states its own principle — *"everything the API accepts is here, so a search you can describe
 * is a search you can run without writing a request by hand"*. `maxBytes` broke that: it is the one parameter
 * that decides whether the answer is complete, and it could only be set by hand-writing a request.
 *
 * Run: npm run test:client
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { BrainStore } from './brain-store.service';
import { QueryTabComponent } from './query-tab.component';
import { ToastService } from '../../core/toast.service';
import { SPILL_REFUSAL_CODES } from '../../core/read-spill';

/**
 * Comments STRIPPED, and this file is why the rule exists.
 *
 * Two of the assertions below are "this name must not appear": `budgetBytes`/`bytesReturned` must not reach the
 * interface, and `maxTokens` must not be offered as a second control. Both names appear in the comments that
 * EXPLAIN those decisions — so on the raw source the gate fires on the reasoning for the fix, which punishes
 * writing the reasoning down.
 */
const stripComments = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

const component = stripComments(readFileSync('src/app/pages/brain/query-tab.component.ts', 'utf8'));
const api = stripComments(readFileSync('src/app/core/brain-api.service.ts', 'utf8'));
/*
 * The panel split into three files, and each check below reads the one holding its half.
 *
 * `U-1` moved the CONTROLS into `recall-form.component.ts` and the REQUEST BUILDING into
 * `recall-request.ts`, so a check anchored on the tab reported the byte ceiling unreachable while it was
 * bound and sent exactly as before. Re-pointed rather than relaxed — every assertion still demands a real
 * binding and a real conditional — and the two are kept apart on purpose: a control existing and a value
 * being sent are different claims, and merging the sources would let one answer for the other.
 */
const form = stripComments(readFileSync('src/app/pages/brain/recall-form.component.ts', 'utf8'));
const request = stripComments(readFileSync('src/app/pages/brain/recall-request.ts', 'utf8'));
const LOCALES = ['en', 'de', 'pl'] as const;
const locale = (l: string) =>
  JSON.parse(readFileSync(`public/assets/i18n/${l}.json`, 'utf8')) as Record<string, string>;

describe('the page says when an answer was shortened', () => {
  it('reads `truncated` off the response and keeps the two numbers an operator can act on', () => {
    expect(component).toContain('recallTruncated');
    expect(component).toMatch(/res\.truncated === true/);
    expect(component).toMatch(/returned: res\.returned \?\? res\.results\.length, count: res\.count/);
  });

  it('tests `=== true`, so an older server sending nothing reads as NOT truncated', () => {
    // The field is optional on the type. A truthy check would be equivalent today and would start meaning
    // "unknown" the moment anything else could land there; `undefined` must read as "the answer is whole".
    expect(component).not.toMatch(/if \(res\.truncated\)/);
    expect(component).toMatch(/res\.truncated === true/);
  });

  it('does NOT put a byte count in front of the operator', () => {
    /*
     * `budgetBytes` and `bytesReturned` are for a caller tuning a request programmatically. In an interface they
     * are numbers nobody can act on, and showing them would make the notice read as diagnostics rather than as
     * "here is what happened and here is what to do".
     */
    // Four names since 3.7, not two: the one figure that claimed to be bytes was split into the character
    // count it actually was and a real byte count. A character count is exactly as unactionable in an
    // interface as a byte one, so the new pair is refused on the same grounds rather than left unasserted.
    for (const field of ['budgetBytes', 'bytesReturned', 'budgetChars', 'charsReturned']) {
      expect(component).not.toContain(field);
    }
    // And the notice must not have grown one through a locale key either.
    for (const l of LOCALES) {
      const t = locale(l);
      for (const k of ['brain.query.truncated.title', 'brain.query.truncated.body', 'brain.query.truncated.what']) {
        expect(t[k]).not.toMatch(/\{\{(budgetBytes|bytesReturned|budgetChars|charsReturned)\}\}/);
      }
    }
  });

  it('clears the notice when a new search starts AND when results are cleared', () => {
    /*
     * A stale notice is worse than none: it would claim the CURRENT answer was shortened. Both reset paths,
     * because `clearRecall` does not go through `runRecall`.
     *
     * EACH SLICE IS BOUNDED AT THE NEXT METHOD. The first version read from `runRecall` to the end of the file,
     * which also covered `clearRecall`'s reset — so deleting the one in `runRecall` still passed. A window that
     * runs past its subject asserts about whatever follows, and mutation testing is what surfaced it.
     */
    const between = (from: string, to: string) => {
      const a = component.indexOf(from);
      const b = component.indexOf(to, a + from.length);
      expect(a, `${from} not found`).toBeGreaterThan(-1);
      expect(b, `${to} not found after ${from}`).toBeGreaterThan(a);
      return component.slice(a, b);
    };
    expect(between('runRecall(): void', 'clearRecall(): void'))
      .toMatch(/this\.recallTruncated\.set\(null\);/);
    // Bounded by the NEXT member rather than by a name that happened to follow it: this read
    // `formatQueryDoc(`, which was deleted when every record moved onto the JSON tree, and the case then
    // failed on a method that is gone rather than on the reset it is about.
    expect(between('clearRecall(): void', 'graphTargetOf('))
      .toMatch(/this\.recallTruncated\.set\(null\);/);
  });

  it('renders the notice ABOVE the results, not below them', () => {
    /*
     * Ordering is the point rather than a detail. Below the list, the notice is found only by someone who has
     * already read to the end and drawn the wrong conclusion — which is the failure this fixes.
     */
    /*
     * ANCHORED ON THE BLOCK THAT RENDERS RESULTS, not on a class name. It was `query-results-header`, and
     * that class was renamed when the answer became a card — so this went red on a layout change that
     * obeyed the rule perfectly. A gate pinned to a spelling fails on the wrong day and passes on the day
     * somebody moves the notice.
     */
    const notice = component.indexOf('recallTruncated(); as t');
    // The LOOP that draws them. `@if (recallResults().length)` also guards the Clear button on the panel
    // bar, which sits above the notice quite correctly — anchoring there compared the notice to the wrong
    // thing and failed on a passing layout.
    const results = component.indexOf('@for (g of recallGroups()');
    expect(notice, 'the truncation notice is gone').toBeGreaterThan(-1);
    expect(results, 'the results block is gone — re-anchor this case').toBeGreaterThan(-1);
    expect(notice, 'the notice renders after the results, where only a reader who already drew the wrong '
      + 'conclusion would find it').toBeLessThan(results);
  });

  it('states BOTH guarantees, or "shortened" reads as "unreliable"', () => {
    // Every record whole, and the top of the ranking with no gap in the middle — the same two the userguide
    // states. Without them an operator cannot tell a shortened answer from a broken one.
    for (const l of LOCALES) {
      const t = locale(l);
      expect(t['brain.query.truncated.title']).toBeTruthy();
      expect(t['brain.query.truncated.body']).toBeTruthy();
      expect(t['brain.query.truncated.what']).toBeTruthy();
      expect(t['brain.query.truncated.title']).toContain('{{returned}}');
      expect(t['brain.query.truncated.title']).toContain('{{count}}');
    }
  });
});

describe('the size ceiling is reachable from the form', () => {
  it('the API method declares maxBytes', () => {
    expect(api).toMatch(/maxBytes\?: number;/);
  });

  it('and the other three units as well — the ceiling is one number in four currencies', () => {
    /*
     * **This assertion was the opposite, and the edit is deliberate.** It required `maxTokens` to be ABSENT,
     * because offering two overlapping numbers would make an operator work out which one won.
     *
     * That was right about two numbers with no stated rule and wrong as a conclusion. The server applies
     * whichever ceiling is SMALLEST, so the honest answer is to say that once and offer all four rather than
     * to hide three quarters of the parameter — which is what the owner's `U-1` instruction asks for in as
     * many words: *"one input field for EACH AND EVERY available option a recall has."*
     *
     * And bytes and characters are not interchangeable: treating them as one number ran a German or Polish
     * space about a quarter over its limit, which was a real bug (B-1). A UI that offers only bytes cannot
     * express the ceiling those operators actually want.
     */
    for (const unit of ['maxBytes', 'maxChars', 'maxTokens']) {
      expect(api).toMatch(new RegExp(`${unit}\\?: number;`));
      expect(form).toMatch(new RegExp(`form\\(\\)\\.${unit}`));
      expect(request).toMatch(new RegExp(`form\\.${unit}`));
    }
    /*
     * `charsPerToken` was the fourth unit and is gone at 5.0. It did nothing unless `maxTokens` was also
     * set — a knob for a knob — and an operator who needs the ceiling exact states `maxChars`, which is
     * the unit the server applies. The dependency this line used to assert (sent only alongside a token
     * ceiling) went with the parameter rather than being weakened into something vaguer.
     *
     * The ratio is fixed at 3.5 in `result-budget.ts` and is not a client concern any more, so there is
     * nothing here to assert about it — which is the point of removing it rather than defaulting it.
     */
  });

  it('the form has the control, bound and defaulted to "unset"', () => {
    // The DEFAULT is the host's — it owns the state object — and the BINDING is the form component's.
    expect(component).toMatch(/maxBytes: 0,/);
    expect(form).toContain('form().maxBytes');
  });

  it('zero is NOT sent — it would be a ceiling nobody chose', () => {
    // The server floor is 1000, so a literal 0 could not be honoured anyway; it is clamped. Sending it would put
    // a parameter in every request that means the opposite of what the operator left blank.
    expect(request).toMatch(/form\.maxBytes > 0 \? \{ maxBytes: form\.maxBytes \} : \{\}/);
  });

  it('every new key exists in all three locales', () => {
    // The reason this was not folded into the byte-budget PR: a key added to `en` alone fails the coverage spec
    // on the missing `de`/`pl` pair, and that is not a thing to discover inside a PR that is already red.
    const keys = [
      'brain.query.recallMaxBytes', 'brain.query.recallMaxBytes.tooltip', 'brain.query.recallMaxBytes.default',
      'brain.query.truncated.title', 'brain.query.truncated.body', 'brain.query.truncated.what',
    ];
    for (const l of LOCALES) {
      const t = locale(l);
      for (const k of keys) {
        expect(t[k], `${k} missing from ${l}.json`).toBeTruthy();
      }
    }
  });

  it('and no locale left a placeholder untranslated by copying the English', () => {
    // A copied string passes the coverage check and ships English to a German reader. Compared on the two
    // sentences long enough for a match to be meaningful rather than on a one-word label like "default".
    for (const k of ['brain.query.truncated.body', 'brain.query.recallMaxBytes.tooltip']) {
      expect(locale('de')[k]).not.toBe(locale('en')[k]);
      expect(locale('pl')[k]).not.toBe(locale('en')[k]);
    }
  });
});

/*
 * ─── Q-92: a search never writes, and what did not fit is fetched by the caller's own token ─────────────────
 *
 * A spill is no longer a file in the space. It lives in an instance store, is read back page by page through
 * `GET /api/brain/spills/:id?skip=&maxBytes=` (items + `nextSkip`), and only the token that caused it may read
 * it. Three consequences for this page, each a case below:
 *
 * - **The download is a BUTTON that fetches through HttpClient**, never an `<a [href]>` at the download URL.
 *   A link cannot send the bearer, and the route pages — one GET is one window, not the file.
 * - **It follows `nextSkip` until the spill is exhausted** and saves the whole thing, so "Download the whole
 *   graph" stays true. Asked at the widest window the server allows (`maxBytes` = `MAX_MAX_BYTES`), so the
 *   number of round trips is as small as it can be.
 * - **Both kinds of spill get it** — the graph (`graphComplete`) and the results remainder (`remainder`) —
 *   because two surfaces implementing one rule is where one of them ends up weaker. And a refused spill
 *   (`spillRefused`) and a spill that is gone (404 unknown/expired, 410 evicted) each SAY so, distinctly.
 *
 * Driven through the real `BrainApi` over `HttpTestingController`: a request the controller never sees did
 * not go through HttpClient, which is exactly the `fetch`-with-a-hand-built-header copy this replaces.
 */

/** What `MAX_MAX_BYTES` is on the server (`brain/result-budget.ts`): the widest window a caller may ask for. */
const MAX_MAX_BYTES = 5_000_000;

/** Rendered text for the keys these cases look for, so a match is on a sentence rather than an echoed key. */
const T: Record<string, string> = {
  'brain.query.leftOut.title': 'LEFTOUT-TITLE',
  'brain.query.leftOut.more': 'LEFTOUT-MORE',
  'brain.query.leftOut.reason.walk_ceiling': 'REASON-CEILING',
  'brain.query.leftOut.reason.link_scan': 'REASON-SCAN',
  'brain.query.truncated.by.walk_budget': 'BY-WALK',
  'brain.query.truncated.by.deadline': 'BY-DEADLINE',
  'brain.query.truncated.title': 'TRUNCATED-TITLE',
  'brain.query.truncated.what': 'WHAT-ADVICE RAISE[{{fields}}]',
  'brain.query.truncated.whatNarrow': 'NARROW-ADVICE',
  'brain.query.maxChars': 'F-CHARS',
  'brain.query.maxTokens': 'F-TOKENS',
  'brain.query.recallMaxBytes': 'F-BYTES',
  'brain.query.remainder.download': 'REMAINDER-DOWNLOAD',
  'brain.query.remainder.expires': 'EXPIRES {{date}}',
  'brain.query.spillRefused': 'SPILL-REFUSED {{reason}} RAISE[{{fields}}]',
  ...Object.fromEntries(SPILL_REFUSAL_CODES.map(c => [`brain.query.spillRefused.reason.${c}`, `R-${c.toUpperCase()}-WORDS`])),
  'brain.query.spill.notFound': 'SPILL-NOT-FOUND',
  'brain.query.spill.gone': 'SPILL-GONE',
};

const EXPIRES = '2026-09-29T12:00:00.000Z';

interface Mounted { fixture: ComponentFixture<QueryTabComponent>; http: HttpTestingController; c: QueryTabComponent }

function mount(): Mounted {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [QueryTabComponent, getTranslocoModule({ translation: { en: T } })],
    providers: [BrainStore, provideHttpClient(), provideHttpClientTesting()],
  });
  const fixture = TestBed.createComponent(QueryTabComponent);
  fixture.componentRef.setInput('spaceId', 'work');
  fixture.detectChanges();
  return { fixture, http: TestBed.inject(HttpTestingController), c: fixture.componentInstance };
}

/** Run a search and answer it with `response`, through the real recall request. */
function answer(m: Mounted, response: Record<string, unknown>): void {
  m.c.recallForm.query = 'vault';
  m.c.runRecall();
  const req = m.http.match(r => r.method === 'POST' && r.url === '/api/brain/recall');
  expect(req, 'the search did not reach /api/brain/recall').toHaveLength(1);
  req[0]!.flush({ results: [], count: 0, ...response });
  m.fixture.detectChanges();
}

async function until(what: string, cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

/** A query parameter, whether the caller put it in the URL string or in HttpParams. */
const paramOf = (r: TestRequest, k: string) =>
  new URL(r.request.urlWithParams, 'http://x').searchParams.get(k) ?? r.request.params.get(k);

/** Pending GETs for one spill. `match` removes what it returns, so each call sees only requests made since. */
function spillRequests(m: Mounted, id: string): TestRequest[] {
  return m.http.match(r => r.method === 'GET'
    && new URL(r.urlWithParams, 'http://x').pathname === `/api/brain/spills/${id}`);
}

function buttonWith(root: HTMLElement, text: string): HTMLButtonElement | null {
  return [...root.querySelectorAll('button')].find(b => (b.textContent ?? '').includes(text)) ?? null;
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((ok, fail) => {
    const fr = new FileReader();
    fr.onload = () => ok(String(fr.result));
    fr.onerror = () => fail(fr.error);
    fr.readAsText(blob);
  });
}

/** Everything the user could read: the page, plus any toast. */
function visibleText(m: Mounted): string {
  m.fixture.detectChanges();
  const toasts = TestBed.inject(ToastService).toasts().map(t => t.message).join('\n');
  return `${(m.fixture.nativeElement as HTMLElement).textContent ?? ''}\n${toasts}`;
}

/**
 * The kinds of spill an answer can offer, each with the response that offers it and the control that fetches it.
 * One since Q-126: a graph is never spilled, because a match comes with its whole graph or not at all.
 */
const KINDS = [
  {
    kind: 'results',
    control: 'REMAINDER-DOWNLOAD',
    response: (id: string) => ({
      truncated: true, returned: 1, count: 4, nextSkip: 1,
      remainder: { matches: 3, records: 3, spillId: id, path: `_tmp/results-${id}.json`, download: `/api/brain/spills/${id}`, expiresAt: EXPIRES },
    }),
    item: (n: number) => ({ _id: `r${n}`, type: 'fact', spaceId: 'work', fact: `item-marker-${n}` }),
  },
] as const;

describe('Q-92: the spill download is a button that pages the whole spill through HttpClient', () => {
  let saved: Blob[];
  const realCreate = (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
  const realRevoke = (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;

  beforeEach(() => {
    saved = [];
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true, writable: true, value: vi.fn((b: Blob) => { saved.push(b); return 'blob:spill'; }),
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });
  afterEach(() => {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: realCreate });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: realRevoke });
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('the template binds no anchor to a download URL — a link cannot send the bearer', () => {
    // Source-level half of the rule, so it holds for states the behavioural cases below do not render.
    // Both files that render the notices: the tab, and the ending component the download moved into.
    const ending = stripComments(readFileSync('src/app/pages/brain/spill-ending.component.ts', 'utf8'));
    expect(ending, 'the spill ending no longer renders the download button — this check reads the wrong file').toMatch(/\(click\)="download\(/);
    for (const src of [component, ending]) {
      expect(src, 'an `<a [href]>` bound to a spill `download` is back').not.toMatch(/\[href\]\s*=\s*"[^"]*\.download\b/);
    }
  });

  for (const k of KINDS) {
    it(`${k.kind}: offers a button, not a link, and saves every item of every page, once each`, async () => {
      const m = mount();
      answer(m, k.response('sp-1'));
      const root = m.fixture.nativeElement as HTMLElement;

      const anchors = [...root.querySelectorAll('a')].filter(a => (a.getAttribute('href') ?? '').includes('/api/brain/spills/'));
      expect(anchors, 'the spill is offered as a link, which cannot send the bearer and fetches one page').toHaveLength(0);
      const button = buttonWith(root, k.control);
      expect(button, `no <button> carrying ${k.control} — the ${k.kind} spill is not downloadable`).toBeTruthy();

      button!.click();
      // Page one, at the widest window, from the start.
      let first: TestRequest[] = [];
      await until('the first spill page request', () => (first = spillRequests(m, 'sp-1')).length > 0);
      expect(first).toHaveLength(1);
      expect(paramOf(first[0]!, 'skip') ?? '0', 'the first page starts at 0').toBe('0');
      expect(paramOf(first[0]!, 'maxBytes'), 'asked at the widest window the server allows').toBe(String(MAX_MAX_BYTES));
      first[0]!.flush({ kind: k.kind, items: [k.item(1), k.item(2)], skip: 0, nextSkip: 2, truncated: true, expiresAt: EXPIRES });

      // Page two follows `nextSkip` — and it is the last, so nothing follows it.
      let second: TestRequest[] = [];
      await until('the request for the page at nextSkip', () => (second = spillRequests(m, 'sp-1')).length > 0);
      expect(second).toHaveLength(1);
      expect(paramOf(second[0]!, 'skip'), 'the second page must start where nextSkip said').toBe('2');
      second[0]!.flush({ kind: k.kind, items: [k.item(3)], skip: 2, truncated: false, expiresAt: EXPIRES });

      await until('the assembled spill to be saved', () => saved.length > 0);
      expect(spillRequests(m, 'sp-1'), 'a page past the end was requested').toHaveLength(0);
      expect(saved, 'saved more than one file for one spill').toHaveLength(1);
      const text = await readBlob(saved[0]!);
      expect(() => JSON.parse(text), 'the saved file is not JSON').not.toThrow();
      for (const n of [1, 2, 3]) {
        const hits = text.match(new RegExp(`item-marker-${n}\\b`, 'g')) ?? [];
        expect(hits.length, `item ${n} appears ${hits.length} times in the saved file — every item exactly once`).toBe(1);
      }
    });

    it(`${k.kind}: 404 and 410 say different things, both translated`, async () => {
      const said: Record<number, string> = {};
      for (const status of [404, 410]) {
        const m = mount();
        answer(m, k.response('sp-gone'));
        const button = buttonWith(m.fixture.nativeElement as HTMLElement, k.control);
        expect(button, `no <button> carrying ${k.control}`).toBeTruthy();
        button!.click();
        let reqs: TestRequest[] = [];
        await until(`the spill request answered ${status}`, () => (reqs = spillRequests(m, 'sp-gone')).length > 0);
        reqs[0]!.flush({ error: status === 404 ? 'not found' : 'evicted' }, { status, statusText: String(status) });
        const want = status === 404 ? 'SPILL-NOT-FOUND' : 'SPILL-GONE';
        await until(`the ${status} message`, () => visibleText(m).includes(want)).catch(() => undefined);
        said[status] = visibleText(m);
        expect(saved, `a ${status} saved a file`).toHaveLength(0);
        TestBed.resetTestingModule();
      }
      expect(said[404], '404 (unknown or expired) must say the spill is not there').toContain('SPILL-NOT-FOUND');
      expect(said[404], '404 must not claim eviction').not.toContain('SPILL-GONE');
      expect(said[410], '410 (evicted) must say the spill was removed early').toContain('SPILL-GONE');
      expect(said[410], '410 must not read as "unknown"').not.toContain('SPILL-NOT-FOUND');
    });
  }
});

describe('Q-92: the page renders `remainder` and `spillRefused`', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('a remainder shows its expiry in the viewer\'s date format, not the browser\'s or the wire\'s', () => {
    // Pin the viewer's choice (Q-146) to day.month.year; the page must render THAT, whatever the machine says.
    localStorage.setItem('dateFormat', JSON.stringify({ style: 'dmy24', zone: 'local' }));
    try {
      const m = mount();
      answer(m, KINDS[0].response('sp-r'));
      const text = visibleText(m);
      expect(text, 'the remainder is not rendered at all').toContain('REMAINDER-DOWNLOAD');
      // A FORMAT, not a rendering: CI runs in UTC and a laptop does not, so the day and hour differ by zone.
      expect(text).toMatch(/EXPIRES \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}/);
      expect(text, 'the expiry is printed as the raw wire value').not.toContain(EXPIRES);
    } finally { localStorage.removeItem('dateFormat'); }
  });

  it('a refused spill says so and why, in words', () => {
    for (const response of [
      { truncated: true, returned: 1, count: 4, nextSkip: 1, spillRefused: 'instance-ceiling' },
      { truncated: true, returned: 1, count: 4, nextSkip: 1, spillRefused: 'over-share' },
    ]) {
      const m = mount();
      answer(m, response);
      const text = visibleText(m);
      const words = T[`brain.query.spillRefused.reason.${response.spillRefused}`];
      expect(text, `spillRefused "${response.spillRefused}" is not rendered in words`).toContain(`SPILL-REFUSED ${words}`);
      expect(text, `the raw code "${response.spillRefused}" reaches the reader`).not.toContain(response.spillRefused);
      const root = m.fixture.nativeElement as HTMLElement;
      expect(buttonWith(root, 'REMAINDER-DOWNLOAD'), 'a refused spill still offers a download').toBeNull();
      TestBed.resetTestingModule();
    }
  });

  /*
   * ONE NOTICE PER SHORT ANSWER, AND IT NEVER CONTRADICTS ITSELF. Found driving the page (Q-92 verify, 2026-09-28):
   * with "Keep what did not fit" ticked and the keep refused, the shortened-answer notice still advised ticking it,
   * and the refusal sat in a second box below. So each notice ends with exactly one of: the download (kept), the
   * refusal (asked, not kept), or the advice (not asked) — the refusal lives in the notice whose copy is missing.
   */
  const alerts = (m: Mounted) => [...(m.fixture.nativeElement as HTMLElement).querySelectorAll('.alert')]
    .map(a => a.textContent ?? '');

  it('results: a refused keep replaces the advice inside the shortened-answer notice, and is said once', () => {
    const m = mount();
    answer(m, { truncated: true, returned: 1, count: 4, nextSkip: 1, spillRefused: 'over-share' });
    const refusal = `SPILL-REFUSED ${T['brain.query.spillRefused.reason.over-share']}`;
    const holding = alerts(m).filter(a => a.includes(refusal));
    expect(holding, 'the refusal is not said exactly once').toHaveLength(1);
    expect(holding[0], 'the refusal is not inside the shortened-answer notice').toContain('TRUNCATED-TITLE');
    expect(visibleText(m), 'the notice still advises ticking a box that was ticked').not.toContain('WHAT-ADVICE');
  });

  it('results: a kept remainder offers the download instead of the advice', () => {
    const m = mount();
    answer(m, KINDS[0].response('sp-kept'));
    expect(visibleText(m)).toContain('REMAINDER-DOWNLOAD');
    expect(visibleText(m), 'the advice to tick "keep" is shown although the rest was kept').not.toContain('WHAT-ADVICE');
  });

  it('results: nothing asked, nothing refused — the advice is shown', () => {
    const m = mount();
    answer(m, { truncated: true, returned: 1, count: 4, nextSkip: 1 });
    expect(visibleText(m)).toContain('WHAT-ADVICE');
  });

  /*
   * Q-116: the form has THREE fields called "Max response size" — characters, tokens, bytes — and the advice said
   * "raise Max response size". The server now names the parameter the meter stopped at (`budgetBoundBy`), and the
   * advice names that field by its label; a walk that ran out is not a size ceiling and gets no size advice at all.
   */
  const notice = (m: Mounted) => alerts(m).find(a => a.includes('TRUNCATED-TITLE')) ?? '';

  it('Q-116: the advice names the field that cut the answer — bytes', () => {
    const m = mount();
    answer(m, { truncated: true, returned: 1, count: 4, nextSkip: 1, truncatedBy: 'budget', budgetBoundBy: ['maxBytes'] });
    expect(notice(m)).toContain('WHAT-ADVICE RAISE[F-BYTES]');
  });

  it('Q-116: … tokens, when the token ceiling was the lower', () => {
    const m = mount();
    answer(m, { truncated: true, returned: 1, count: 4, nextSkip: 1, truncatedBy: 'budget', budgetBoundBy: ['maxTokens'] });
    expect(notice(m)).toContain('WHAT-ADVICE RAISE[F-TOKENS]');
  });

  it('Q-116: … both, when the next match would pass both ceilings', () => {
    const m = mount();
    answer(m, { truncated: true, returned: 1, count: 4, nextSkip: 1, truncatedBy: 'budget', budgetBoundBy: ['maxChars', 'maxBytes'] });
    const n = notice(m);
    expect(n).toMatch(/WHAT-ADVICE RAISE\[F-CHARS.+F-BYTES\]/);
  });

  it('Q-116: a refused keep names the field too', () => {
    const m = mount();
    answer(m, { truncated: true, returned: 1, count: 4, nextSkip: 1, truncatedBy: 'budget', budgetBoundBy: ['maxBytes'], spillRefused: 'over-share' });
    expect(notice(m)).toContain('RAISE[F-BYTES]');
  });

  it('Q-116: a walk that ran out gets no size advice — raising a size ceiling would not help', () => {
    for (const by of ['walk_budget', 'deadline']) {
      const m = mount();
      answer(m, { truncated: true, returned: 1, count: 4, nextSkip: 1, truncatedBy: by });
      const n = notice(m);
      expect(n, `${by}: size advice shown`).not.toContain('WHAT-ADVICE');
      expect(n, `${by}: no ending at all`).toContain('NARROW-ADVICE');
      TestBed.resetTestingModule();
    }
  });

  /*
   * Q-126: a match comes with its WHOLE graph or is left out and NAMED. The page has to say which matches were
   * left out and why, or a reader concludes they do not exist — and it must never offer a graph download,
   * because there is none.
   */
  it('left out: every named match is shown with its reason, in words, and the rest are counted', () => {
    const m = mount();
    answer(m, {
      graphTruncated: true, graphNodes: 0, incompleteCount: 3,
      incompleteRows: [
        { _id: 'h1', spaceId: 'work', type: 'entity', name: 'hub-marker-1', reason: 'walk_ceiling' },
        { _id: 'h2', spaceId: 'work', type: 'entity', name: 'hub-marker-2', reason: 'link_scan' },
      ],
    });
    const holding = alerts(m).filter(a => a.includes('LEFTOUT-TITLE'));
    expect(holding, 'the left-out notice is not shown exactly once').toHaveLength(1);
    expect(holding[0]).toContain('hub-marker-1');
    expect(holding[0]).toContain('REASON-CEILING');
    expect(holding[0]).toContain('hub-marker-2');
    expect(holding[0]).toContain('REASON-SCAN');
    expect(holding[0], 'a raw reason code reaches the reader').not.toContain('walk_ceiling');
    expect(holding[0], 'the unnamed third match is not counted').toContain('LEFTOUT-MORE');
    const anchors = [...(m.fixture.nativeElement as HTMLElement).querySelectorAll('a')]
      .filter(a => (a.getAttribute('href') ?? '').includes('/api/brain/spills/'));
    expect(anchors, 'a graph download is offered, and there is no graph spill').toHaveLength(0);
  });

  it('left out: every match left out means the page does not claim there were no matches', () => {
    const m = mount();
    answer(m, { results: [], count: 1, graphTruncated: true, incompleteCount: 1,
      incompleteRows: [{ _id: 'h1', spaceId: 'work', type: 'entity', name: 'hub-marker-1', reason: 'walk_ceiling' }] });
    const root = m.fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.query-empty'), '"no matches" is shown beside a match that was left out').toBeNull();
    expect(root.querySelector('.alert[role="status"]'), 'the left-out notice is not announced').toBeTruthy();
  });

  it('left out: nothing is said when no match was left out', () => {
    const m = mount();
    answer(m, { graphNodes: 4 });
    expect(visibleText(m)).not.toContain('LEFTOUT-TITLE');
  });

  it('a truncation the graph walk caused says which bound stopped it; the byte budget adds nothing', () => {
    for (const [by, want] of [['walk_budget', 'BY-WALK'], ['deadline', 'BY-DEADLINE']] as const) {
      const m = mount();
      answer(m, { truncated: true, returned: 1, count: 4, nextSkip: 1, truncatedBy: by });
      const holding = alerts(m).filter(a => a.includes('TRUNCATED-TITLE'));
      expect(holding[0], `${by} is not named inside the shortened-answer notice`).toContain(want);
      TestBed.resetTestingModule();
    }
    const m = mount();
    answer(m, { truncated: true, returned: 1, count: 4, nextSkip: 1, truncatedBy: 'budget' });
    expect(visibleText(m)).not.toContain('BY-WALK');
    expect(visibleText(m)).not.toContain('BY-DEADLINE');
  });

  it('Q-116: the advice takes the field from the answer, in every locale — no sentence names "the size" itself', () => {
    for (const l of LOCALES) {
      const t = locale(l);
      for (const k of ['brain.query.truncated.what', 'brain.query.spillRefused']) {
        expect(t[k], `${l} ${k} does not name the field it is given`).toContain('{{fields}}');
      }
      expect(t['brain.query.truncated.whatNarrow'], `${l} has no ending for a walk that ran out`).toBeTruthy();
    }
    expect(locale('de')['brain.query.truncated.whatNarrow']).not.toBe(locale('en')['brain.query.truncated.whatNarrow']);
    expect(locale('pl')['brain.query.truncated.whatNarrow']).not.toBe(locale('en')['brain.query.truncated.whatNarrow']);
  });

  it('every new left-out and walk-bound key exists in en, de and pl, and de/pl are not English', () => {
    const keys = ['brain.query.leftOut.title', 'brain.query.leftOut.body', 'brain.query.leftOut.more',
      ...['walk_ceiling', 'link_scan', 'paths', 'deadline'].map(r => `brain.query.leftOut.reason.${r}`),
      'brain.query.truncated.by.walk_budget', 'brain.query.truncated.by.deadline'];
    for (const k of keys) {
      for (const l of LOCALES) expect(locale(l)[k], `${k} missing from ${l}.json`).toBeTruthy();
      expect(locale('de')[k], `de ${k} is the English text`).not.toBe(locale('en')[k]);
      expect(locale('pl')[k], `pl ${k} is the English text`).not.toBe(locale('en')[k]);
    }
    for (const l of LOCALES) {
      expect(Object.keys(locale(l)).filter(k => k.startsWith('brain.query.graphShort.')), `${l} keeps graphShort keys`).toEqual([]);
    }
  });

  it('a refusal reason this client does not know is shown as it arrived, not dropped', () => {
    const m = mount();
    answer(m, { truncated: true, returned: 1, count: 4, nextSkip: 1, spillRefused: 'a-newer-reason' });
    expect(visibleText(m)).toContain('SPILL-REFUSED a-newer-reason');
  });

  it('an answer with no refusal shows no refusal', () => {
    const m = mount();
    answer(m, KINDS[0].response('sp-r'));
    expect(visibleText(m)).not.toContain('SPILL-REFUSED');
  });
});

describe('Q-92: the strings no longer say a search writes into the space', () => {
  const NEW_KEYS = [
    'brain.query.remainder.download', 'brain.query.remainder.expires', 'brain.query.spillRefused',
    'brain.query.spill.notFound', 'brain.query.spill.gone',
  ];

  it('every new key exists in en, de and pl, with the placeholders the page fills', () => {
    for (const l of LOCALES) {
      const t = locale(l);
      for (const k of NEW_KEYS) expect(t[k], `${k} missing from ${l}.json`).toBeTruthy();
      expect(t['brain.query.remainder.expires'], `${l}: the expiry sentence has no {{date}}`).toContain('{{date}}');
      expect(t['brain.query.spillRefused'], `${l}: the refusal sentence has no {{reason}}`).toContain('{{reason}}');
    }
  });

  it('the client knows every refusal code the SERVER can send — read from the server, not from this list', () => {
    // Derived from where the codes are produced: each `refused: '<code>: …'` in the store, plus the `failed` a
    // throwing store degrades to. Checked against the client's own list would be the list agreeing with itself,
    // and a code the server gained would reach the reader raw.
    const store = readFileSync('../server/src/brain/read-spill-store.ts', 'utf8');
    const spill = readFileSync('../server/src/brain/graph-spill.ts', 'utf8');
    const server = new Set([
      ...[...store.matchAll(/refused:\s*['`]([a-z][a-z-]*):/g)].map(m => m[1]!),
      ...[...spill.matchAll(/spillRefused:\s*'([a-z][a-z-]*)'/g)].map(m => m[1]!),
    ]);
    expect(server.size, 'found no refusal codes in the server — the producing code moved').toBeGreaterThanOrEqual(2);
    const known: readonly string[] = SPILL_REFUSAL_CODES;
    expect([...server].filter(c => !known.includes(c)), 'server codes the client has no words for').toEqual([]);
  });

  it('every refusal code has its words in en, de and pl, and de/pl are not English', () => {
    expect(SPILL_REFUSAL_CODES.length, 'no refusal codes found — the list moved or emptied').toBeGreaterThan(0);
    for (const c of SPILL_REFUSAL_CODES) {
      const k = `brain.query.spillRefused.reason.${c}`;
      for (const l of LOCALES) expect(locale(l)[k], `${k} missing from ${l}.json`).toBeTruthy();
      expect(locale('de')[k], `de ${k} is the English text`).not.toBe(locale('en')[k]);
      expect(locale('pl')[k], `pl ${k} is the English text`).not.toBe(locale('en')[k]);
    }
  });

  it('404 and 410 are different sentences in every locale, and de/pl are not copied English', () => {
    for (const l of LOCALES) {
      const t = locale(l);
      expect(t['brain.query.spill.notFound'], `${l}: brain.query.spill.notFound missing`).toBeTruthy();
      expect(t['brain.query.spill.notFound'], `${l}: 404 and 410 read the same`).not.toBe(t['brain.query.spill.gone']);
    }
    for (const k of ['brain.query.spill.notFound', 'brain.query.spill.gone', 'brain.query.spillRefused']) {
      expect(locale('de')[k], `de ${k} is the English text`).not.toBe(locale('en')[k]);
      expect(locale('pl')[k], `pl ${k} is the English text`).not.toBe(locale('en')[k]);
    }
  });

  it('the "this WRITES into the space" warning is gone, key and reference both', () => {
    for (const l of LOCALES) {
      expect(Object.keys(locale(l)), `${l}.json still carries the writes warning`).not.toContain('brain.query.remainderDump.writes');
    }
    expect(form, 'the recall form still renders the writes warning').not.toContain('brain.query.remainderDump.writes');
  });

  it('no brain.query string, in any locale, says the result is written into the space', () => {
    /*
     * Derived over every `brain.query.*` key rather than the handful Q-92 rewrote (`remainderDump`, its tooltip,
     * `graphShort.download`/`.ceilingHit`, `truncated.what`): a sentence claiming a search writes somewhere is
     * wrong wherever it sits, and the next one would be written under a key nobody thought to list.
     *
     * One pattern per language, each the verb "write / save as a file" next to "this space" — the claim itself,
     * not every mention of a space.
     */
    const CLAIM: Record<(typeof LOCALES)[number], RegExp> = {
      en: /\b(writes?|written|saved?)\b[^.]*\b(in|into|to)\s+(this|the)\s+space\b|\bfile\b[^.]*\b(in|into)\s+(this|the)\s+space\b/i,
      de: /\b(schreibt|geschrieben|gespeichert|speichert)\b[^.]*\bin\s+(diesen|diesem|den|dem)\s+Space\b|\bDatei\b[^.]*\bin\s+(diesen|diesem)\s+Space\b/i,
      pl: /\b(zapisuje|zapisany|zapisane|zapisywany)\b[^.]*\bw\s+tej\s+przestrzeni\b|\bplik\w*\b[^.]*\bw\s+tej\s+przestrzeni\b/i,
    };
    for (const l of LOCALES) {
      const t = locale(l);
      const keys = Object.keys(t).filter(k => k.startsWith('brain.query.'));
      expect(keys.length, `${l}: no brain.query keys found — the derivation read nothing`).toBeGreaterThan(20);
      const offenders = keys.filter(k => CLAIM[l].test(t[k]!)).map(k => `${k}: ${t[k]}`);
      expect(offenders, `${l}: these still say a search writes into the space`).toEqual([]);
    }
  });
});
