/**
 * HelpComponent — the in-product guides.
 *
 * The behaviours worth pinning are the ones that would otherwise fail quietly:
 *
 *  1. **The fetched path is built from the fixed list, never from the URL.** `?doc=` is user input; if it
 *     ever reached the request path this page would be a traversal hole in a product that has no other
 *     one. An unknown id must fall back, not fetch.
 *  2. **A failed load is not an empty guide.** Bundled assets should not 404 — if one does, the build
 *     dropped it, and rendering nothing would look like a guide with no content.
 *  3. **A slow response cannot overwrite a newer selection.** Clicking through the index faster than the
 *     network answers must not leave the wrong document under the highlighted entry.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of, throwError, Subject } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { HelpComponent, HELP_DOCS } from './help.component';
import { partAnchorId } from './help-links';
import { MarkdownRenderService } from '../../shared/markdown-render.service';

function setup(opts: { doc?: string | null; fragment?: string | null; get?: unknown; render?: (t: string) => Promise<string> } = {}) {
  const get = opts.get ?? vi.fn(() => of('# Title\n\nbody'));
  const navigate = vi.fn(() => Promise.resolve(true));
  const render = opts.render ?? ((t: string) => Promise.resolve(`<p>${t}</p>`));
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [HelpComponent, getTranslocoModule()],
    providers: [
      { provide: HttpClient, useValue: { get } },
      { provide: MarkdownRenderService, useValue: { render } },
      { provide: ActivatedRoute, useValue: {
        snapshot: { queryParamMap: { get: () => opts.doc ?? null }, fragment: opts.fragment ?? null },
      } },
      { provide: Router, useValue: { navigate } },
    ],
  });
  const f = TestBed.createComponent(HelpComponent);
  f.detectChanges();  // ngOnInit
  return { f, c: f.componentInstance, get: get as ReturnType<typeof vi.fn>, navigate };
}

/** Click the first anchor in the rendered article and return the event, so callers can check preventDefault. */
function clickLink(f: { nativeElement: unknown }, selector = 'a'): MouseEvent {
  const a = (f.nativeElement as HTMLElement).querySelector(`.doc article ${selector}`)!;
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  a.dispatchEvent(ev);
  return ev;
}

/**
 * Let the load settle.
 *
 * A guide can be split across files, so loading is `Promise.all(...).then(join)` rather than a
 * single `http.get`. One `await Promise.resolve()` used to be enough and now lands mid-chain, which
 * showed up as every render assertion failing at once rather than as anything about splitting.
 */
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

/**
 * The files an entry actually fetches: its parts if it is a split guide, otherwise the file itself.
 *
 * Both split guides are ordinary entries, so a test that hardcodes "one fetch, `assets/docs/<file>`" is
 * asserting a storage detail rather than the behaviour. Four of the tests below did, and all four broke the
 * day the user guide became six chapters — none of them because anything was wrong.
 *
 * The parameter is typed as the whole union deliberately: with `as const`, `HELP_DOCS[0]` has a literal type
 * that already carries `parts`, so an inline `'parts' in d ? … : d.file` narrows the false branch to `never`
 * and stops compiling. Widening here keeps both branches real.
 */
const filesOf = (d: typeof HELP_DOCS[number]): readonly string[] => ('parts' in d ? d.parts : [d.file]);
const assetsOf = (d: typeof HELP_DOCS[number]) => filesOf(d).map(f => `assets/docs/${f}`);

describe('HelpComponent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lands on the first guide and fetches it from the bundled assets', () => {
    const { c, get } = setup();
    expect(c.active()).toBe(HELP_DOCS[0].id);
    for (const url of assetsOf(HELP_DOCS[0])) {
      expect(get).toHaveBeenCalledWith(url, { responseType: 'text' });
    }
  });

  it('opens the guide named by ?doc=', () => {
    const target = HELP_DOCS[2];
    const { c, get } = setup({ doc: target.id });
    expect(c.active()).toBe(target.id);
    for (const url of assetsOf(target)) {
      expect(get).toHaveBeenCalledWith(url, { responseType: 'text' });
    }
  });

  it('an unknown ?doc= falls back to the first guide instead of fetching it', () => {
    // The path must never be built from the query param — this is what keeps `?doc=../../etc/passwd`
    // a no-op rather than a request. The fetch count is the fallback guide's own file count, so the
    // assertion that matters is that the requested URLs are EXACTLY that guide's and nothing else.
    const { c, get } = setup({ doc: '../../../etc/passwd' });
    expect(c.active()).toBe(HELP_DOCS[0].id);
    expect(get.mock.calls.map(call => call[0])).toEqual(assetsOf(HELP_DOCS[0]));
    for (const call of get.mock.calls) expect(call[0]).not.toContain('..');
  });

  it('every offered guide resolves to a path inside assets/docs', () => {
    for (const d of HELP_DOCS) {
      expect(d.file).toMatch(/^[a-z0-9-]+\.md$/);
      // A split guide's parts are built into the same path, so they need the same guarantee: no `..`,
      // no absolute path, nothing that could escape `assets/docs`.
      //
      // `\d\d[a-z]?` because a part may itself be split: the Brain API is `04-brain-api.md` plus
      // `04a`…`04d`, a suffix rather than a renumbering so that every published link to parts 05-17 keeps
      // working. The shape is still pinned — a letter, not `[a-z0-9-]*`, which would re-admit a traversal
      // segment the digits are here to exclude.
      for (const part of ('parts' in d ? d.parts : [])) {
        expect(part).toMatch(/^[a-z0-9-]+\/\d\d[a-z]?-[a-z0-9-]+\.md$/);
      }
    }
  });

  it('renders the fetched markdown through the shared renderer', async () => {
    const { f, c } = setup();
    await flush();
    f.detectChanges();
    expect(c.loading()).toBe(false);
    // `body`, not the fixture's `# Title`: the first guide is split, and `joinParts` strips each part's own
    // H1 by design. The point here is that the RAW markdown reaches the renderer — the render mock wraps
    // whatever it is given in a `<p>` — so any surviving line of the fixture proves it.
    expect((f.nativeElement as HTMLElement).querySelector('.doc article')?.innerHTML).toContain('body');
  });

  it('a failed load surfaces the reason rather than rendering an empty guide', async () => {
    const { f, c } = setup({ get: vi.fn(() => throwError(() => new Error('gone'))) });
    await flush();
    f.detectChanges();
    expect(c.error()).toBeTruthy();
    expect(c.loading()).toBe(false);
    expect((f.nativeElement as HTMLElement).querySelector('.doc article')).toBeNull();
  });

  describe('links inside a rendered guide', () => {
    /** Render real-ish HTML so the click handler has anchors to find. */
    const withHtml = (html: string, opts: Record<string, unknown> = {}) =>
      setup({ render: () => Promise.resolve(html), ...opts });

    it('an intra-document anchor scrolls instead of navigating away', async () => {
      const s = withHtml('<a href="#settings--tokens">go</a><h2 id="settings--tokens">Tokens</h2>');
      await flush();
      s.f.detectChanges();
      const heading = (s.f.nativeElement as HTMLElement).querySelector('#settings--tokens')!;
      const scroll = vi.fn();
      (heading as HTMLElement).scrollIntoView = scroll;

      const ev = clickLink(s.f);
      expect(ev.defaultPrevented).toBe(true);   // the browser must not resolve it against the route
      expect(scroll).toHaveBeenCalled();
    });

    it('a cross-document link opens that guide instead of leaving the app', async () => {
      const s = withHtml('<a href="integration-guide.md#recall">see</a>');
      await flush();
      s.f.detectChanges();
      const ev = clickLink(s.f);
      expect(ev.defaultPrevented).toBe(true);
      expect(s.c.active()).toBe('integration-guide');
      // That guide is split across files, so it fetches its PARTS rather than the index — the index is a
      // link list and rendering it here would show a contents page where the guide should be.
      const fetched = s.get.mock.calls.map(c => c[0] as string);
      expect(fetched.some(u => u.startsWith('assets/docs/integration-guide/'))).toBe(true);
      expect(fetched).not.toContain('assets/docs/integration-guide.md');
    });

    it('a link into a SPLIT guide opens that guide', async () => {
      // The old pattern accepted a bare filename only, so every link into `integration-guide/` fell
      // through to the browser — which resolves it against /settings/help, finds no route, and lands the
      // reader on Brain. A documentation link that moves you to a different page is worse than a dead one.
      const s = withHtml('<a href="integration-guide/04-brain-api.md#schema-validation">see</a>');
      await flush();
      s.f.detectChanges();
      const ev = clickLink(s.f);
      expect(ev.defaultPrevented).toBe(true);
      expect(s.c.active()).toBe('integration-guide');
    });

    describe('a relative link is resolved against the guide it is read in (round V, S4)', () => {
      // A part of a split guide links to its sibling as `](02-hosting.md)`: that is what resolves on GitHub, where the page
      // sits beside it. The view joins the parts into one document, so the link has to be resolved against the guide's own
      // directory before it is looked up — read as `02-hosting.md` it matched nothing and opened a dead tab, 42 times over.
      const clickIn = async (doc: string, href: string) => {
        const open = vi.spyOn(window, 'open').mockImplementation(() => null);
        const s = withHtml(`<a href="${href}">go</a>`, { doc });
        await flush();
        s.f.detectChanges();
        const ev = clickLink(s.f);
        const opened = open.mock.calls.map(c => c[0]);
        open.mockRestore();
        return { s, ev, opened };
      };

      it('a sibling part, no fragment, opens in the view and not in a tab', async () => {
        const { s, ev, opened } = await clickIn('integration-guide', '02-hosting.md');
        expect(ev.defaultPrevented).toBe(true);
        expect(opened).toEqual([]);
        expect(s.c.active()).toBe('integration-guide');
      });

      describe('inside one guide, a link to a page of it TAKES the reader there (round W, V2)', () => {
        // The parts are one joined document, so the page a link names is already on screen — far away. A click that kept
        // the reader where they were was a silent no-op: not a dead tab any more, and not a link either.
        const guideHtml = '<a href="LINK">go</a>'
          + `<div id="${partAnchorId('integration-guide/02-hosting.md')}"></div><h2 id="hosting">Hosting</h2><p>x</p>`
          + `<div id="${partAnchorId('integration-guide/04-brain-api.md')}"></div><h2 id="brain">Brain</h2>`;

        const clickWith = async (href: string, doc = 'integration-guide') => {
          const s = setup({ render: () => Promise.resolve(guideHtml.replace('LINK', href)), doc });
          await flush();
          s.f.detectChanges();
          const root = s.f.nativeElement as HTMLElement;
          const scrolled: string[] = [];
          for (const el of Array.from(root.querySelectorAll<HTMLElement>('.doc article, .doc article [id]'))) {
            el.scrollIntoView = vi.fn(() => { scrolled.push(el.id || '(article)'); });
          }
          const open = vi.spyOn(window, 'open').mockImplementation(() => null);
          const ev = clickLink(s.f);
          const opened = open.mock.calls.map(c => c[0]);
          open.mockRestore();
          return { s, ev, scrolled, opened, root };
        };

        it('a sibling part with no fragment scrolls to the start of that part and moves focus to its heading', async () => {
          const { ev, scrolled, opened, root } = await clickWith('02-hosting.md');
          expect(ev.defaultPrevented).toBe(true);
          expect(opened).toEqual([]);
          expect(scrolled).toEqual([partAnchorId('integration-guide/02-hosting.md')]);
          const heading = root.querySelector<HTMLElement>('#hosting')!;
          expect(document.activeElement).toBe(heading);
          expect(heading.getAttribute('tabindex')).toBe('-1');
        });

        it('another sibling part is another place', async () => {
          const { scrolled, root } = await clickWith('04-brain-api.md');
          expect(scrolled).toEqual([partAnchorId('integration-guide/04-brain-api.md')]);
          expect(document.activeElement).toBe(root.querySelector('#brain'));
        });

        it('the guide itself (`../integration-guide.md`) scrolls to the top of the document and focuses its first heading', async () => {
          const { scrolled, opened, root } = await clickWith('../integration-guide.md');
          expect(opened).toEqual([]);
          expect(scrolled).toEqual(['(article)']);
          expect(document.activeElement).toBe(root.querySelector('#hosting'));
        });

        it('a fragment moves focus to the heading it scrolls to, for the keyboard and the screen reader', async () => {
          const { scrolled, root } = await clickWith('#brain');
          expect(scrolled).toEqual(['brain']);
          expect(document.activeElement).toBe(root.querySelector('#brain'));
        });

        it('a link to a heading whose id the sanitizer namespaced (`#links`) finds it', async () => {
          const s = setup({ render: () => Promise.resolve('<a href="#links">go</a><h2 id="user-content-links">Links</h2>') });
          await flush();
          s.f.detectChanges();
          const heading = (s.f.nativeElement as HTMLElement).querySelector<HTMLElement>('#user-content-links')!;
          heading.scrollIntoView = vi.fn();
          clickLink(s.f);
          expect(heading.scrollIntoView).toHaveBeenCalled();
          expect(document.activeElement).toBe(heading);
        });

        it('a link whose target is not in the document moves nothing and throws nothing', async () => {
          const { scrolled } = await clickWith('#nowhere');
          expect(scrolled).toEqual([]);
        });
      });

      it('a sibling part with a fragment stays in the guide and scrolls', async () => {
        const { s, opened } = await clickIn('integration-guide', '04a-recall-api.md#recall');
        expect(opened).toEqual([]);
        expect(s.c.active()).toBe('integration-guide');
      });

      it('a link up and over into another guide\'s directory opens that guide', async () => {
        const { s, opened } = await clickIn('integration-guide', '../userguide/02-brain.md#facts');
        expect(opened).toEqual([]);
        expect(s.c.active()).toBe('userguide');
      });

      it('a link from a single-file guide to a guide beside it opens that guide', async () => {
        const { s, opened } = await clickIn('dependencies', 'userguide.md');
        expect(opened).toEqual([]);
        expect(s.c.active()).toBe('userguide');
      });

      it('a sibling of a part that is not a page of the guide is still a tab on the raw document, never the router', async () => {
        const { ev, opened } = await clickIn('integration-guide', '99-nothing-here.md');
        expect(ev.defaultPrevented).toBe(true);
        expect(opened).toEqual(['assets/docs/99-nothing-here.md']);
      });
    });

    it('a link to a document the page does not offer opens in a new tab, never in the router', async () => {
      // Previously this "kept its default behaviour", which sounds harmless and is not: the router
      // swallows the relative href and redirects to Brain.
      const open = vi.spyOn(window, 'open').mockImplementation(() => null);
      const s = withHtml('<a href="secret-notes.md">see</a>');
      await flush();
      s.f.detectChanges();
      expect(clickLink(s.f).defaultPrevented).toBe(true);
      expect(open).toHaveBeenCalledWith('assets/docs/secret-notes.md', '_blank', 'noopener,noreferrer');
      open.mockRestore();
    });

    it('an external link opens in a new tab rather than unloading the app', async () => {
      // The guide is a reference someone reads WHILE working. A same-tab navigation throws away whatever
      // they had open, and `noopener,noreferrer` keeps the new page from reaching back through it.
      const open = vi.spyOn(window, 'open').mockImplementation(() => null);
      const s = withHtml('<a href="https://example.com/x">out</a>');
      await flush();
      s.f.detectChanges();
      expect(clickLink(s.f).defaultPrevented).toBe(true);
      expect(open).toHaveBeenCalledWith('https://example.com/x', '_blank', 'noopener,noreferrer');
      open.mockRestore();
    });

    it('a modified click is left for the browser to handle', async () => {
      // Ctrl/cmd-click already means "new tab". Intercepting it would replace the reader's intent with
      // ours, and they may have meant a background tab.
      const open = vi.spyOn(window, 'open').mockImplementation(() => null);
      const s = withHtml('<a href="https://example.com/x">out</a>');
      await flush();
      s.f.detectChanges();
      const a2 = (s.f.nativeElement as HTMLElement).querySelector('.doc article a')!;
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
      a2.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
      expect(open).not.toHaveBeenCalled();
      open.mockRestore();
    });

    it('a ctrl/cmd-click is never swallowed — open-in-new-tab still works', async () => {
      const s = withHtml('<a href="#top">go</a><h2 id="top">Top</h2>');
      await flush();
      s.f.detectChanges();
      const a = (s.f.nativeElement as HTMLElement).querySelector('.doc article a')!;
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
      a.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    });

    it('scrolls to the fragment the URL asked for once the guide has rendered', async () => {
      // This is what a per-page help control relies on: it links to ?doc=userguide#settings--tokens.
      const s = withHtml('<h2 id="settings--tokens">Tokens</h2>', { fragment: 'settings--tokens' });
      const heading = () => (s.f.nativeElement as HTMLElement).querySelector('#settings--tokens');
      // The element only exists after the render resolves; assert we got there and it is addressable.
      await flush();
      s.f.detectChanges();
      expect(heading()).toBeTruthy();
    });

    it('a fragment matching no heading leaves the reader at the top rather than throwing', async () => {
      const s = withHtml('<h2 id="real">Real</h2>', { fragment: 'not-a-heading' });
      await flush();
      s.f.detectChanges();
      expect(s.c.error()).toBe('');
    });
  });

  it('a slow response cannot overwrite a newer selection', async () => {
    const slow = new Subject<string>();
    const calls: string[] = [];
    const get = vi.fn((url: string) => {
      calls.push(url);
      return calls.length === 1 ? slow.asObservable() : of('# Second');
    });
    const { c } = setup({ get });

    // A SINGLE-FILE guide for the SECOND selection, so its fetch is one identifiable call. The FIRST
    // selection is whatever HELP_DOCS opens with — six chapters today — so the second guide's call is
    // indexed past however many the first issued, not at a hardcoded `calls[1]`.
    const second = HELP_DOCS.slice(1).find(d => !('parts' in d))!;
    const firstLoadCalls = calls.length;
    c.open(second.id);                 // switch while the first is still in flight
    slow.next('# First');              // …and let the stale one answer
    slow.complete();
    await flush();

    expect(c.active()).toBe(second.id);
    expect(calls[firstLoadCalls]).toBe(`assets/docs/${second.file}`);
    // The stale answer must not have rendered: only the first part of the first guide was made slow, so
    // without the guard the joined first guide would resolve last and win.
    expect(calls.slice(firstLoadCalls)).toEqual([`assets/docs/${second.file}`]);
  });
});
