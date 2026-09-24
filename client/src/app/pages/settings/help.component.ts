/**
 * Settings → Help. The shipped guides, rendered inside the instance.
 *
 * **Why the docs are bundled rather than linked.** The gap this closes is "an operator has to leave the
 * UI to answer *what does this setting do?*", and a link to github.com does not close it — it restates
 * it, and fails hardest exactly where it matters most: an air-gapped or internal-network install has no
 * route out. So `angular.json` copies `docs/*.md` into the client's assets and this page fetches them
 * from the instance itself. No server route, no path parameter, no traversal surface: the document set
 * is a fixed list compiled into the page, and anything not in it is not fetchable.
 *
 * The markdown goes through `MarkdownRenderService` — the same sanitizing pipeline as the Files preview,
 * because the sanitization rules are a security boundary and a second copy is a second place to drift.
 */
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { from, firstValueFrom } from 'rxjs';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { ErrorStateComponent } from '../../shared/error-state.component';
import { MdScrollersDirective } from '../../shared/md-scrollers.directive';
import { MarkdownRenderService } from '../../shared/markdown-render.service';
import { httpErrorReason } from '../../core/http-error';

/**
 * The guides this page offers, in reading order.
 *
 * A fixed list, not a directory listing: it is what makes the document id un-abusable (nothing here is
 * concatenated from user input), and it lets the order be *pedagogical* rather than alphabetical — a new
 * operator should meet the user guide before the sync protocol. A doc added to `docs/` and not added
 * here simply is not offered, which the coverage test below turns into a failure rather than a silence.
 */
export const HELP_DOCS = [
  // Split into chapters on disk, rendered here as one document — the same shape as the integration guide
  // below. `file` stays the id-bearing name so every `?doc=userguide#anchor` link, and every per-page help
  // control in `help-anchors.ts`, still resolves to this entry.
  {
    id: 'userguide', file: 'userguide.md',
    parts: [
      'userguide/01-getting-started.md', 'userguide/02-brain.md',
      'userguide/03-files-and-schemas.md', 'userguide/04-settings.md', 'userguide/04a-media-and-embedding.md',
      'userguide/05-storage-data-and-audit.md', 'userguide/06-connecting-an-ai-assistant.md',
    ],
  },
  // Split by topic on disk, rendered here as one document — see `joinParts`. The `file` is kept as the
  // id-bearing name so cross-doc links written as `integration-guide.md#x` still resolve to this entry.
  {
    id: 'integration-guide', file: 'integration-guide.md',
    parts: [
      'integration-guide/01-getting-ythril.md', 'integration-guide/02-hosting.md',
      'integration-guide/03-auth-and-limits.md', 'integration-guide/04-brain-api.md',
      // The Brain API is SIX files: the base part carries the memory endpoints, the four `04a`-`04e` parts are
      // the resource families and the search comparison, and `04f` holds the write-and-read semantics that
      // apply to EVERY record type — expiry, stamp integrity, PATCH semantics, concurrency, `deleteFields`.
      // Those were on the base page until A-5, filed there because facts were documented first rather than
      // because they belong to facts. Reading order, so `joinParts` renders them as one chapter.
      'integration-guide/04a-recall-api.md', 'integration-guide/04b-graph-api.md',
      'integration-guide/04c-chrono-api.md', 'integration-guide/04d-brain-ops-api.md',
      'integration-guide/04e-choosing-a-search.md',
      'integration-guide/04f-write-semantics.md',
      // `04g` came out of `04b` when that page hit the 900-line cap (Q-25). It sits in NUMBERED order
      // here and in the index, because `the-integration-guide-index` gates on that and a second opinion
      // about where a part belongs is how the two lists start disagreeing.
      'integration-guide/04g-links-api.md',
      // `04h` came out of `04a` the same way (Q-26), and the numbered order is why it reads oddly far from
      // the recall page it belongs to. Graph-augmented recall is the part of that page that kept growing:
      // it is the bridge between semantic search and the knowledge graph, so every `traverse`-on-recall
      // change lands here rather than on a page already at its ceiling.
      'integration-guide/04h-graph-augmented-recall.md',
      'integration-guide/04i-ingest-api.md',
      'integration-guide/05-files-api.md',
      // The three pipelines a file can go through are their own parts. They are read by different people
      // for different reasons — an operator sizing a document converter, an integrator wiring vision/STT
      // providers, and whoever is deciding whether face recognition may be switched on at all.
      'integration-guide/05a-conversion-pipeline.md', 'integration-guide/05b-media-embedding.md',
      'integration-guide/05c-face-recognition.md',
      'integration-guide/06-spaces-api.md',
      // The space schema and the instance-wide schema library are their own parts: the schema spec is what
      // an integrator reads while writing a `typeSchemas` block, and the library is a different feature that
      // happens to reuse the same shape.
      'integration-guide/06a-schema-api.md', 'integration-guide/06b-schema-library-api.md',
      'integration-guide/07-tokens-api.md', 'integration-guide/08-networks-api.md',
      'integration-guide/09-sync-api.md', 'integration-guide/10-mfa-and-conflicts.md',
      'integration-guide/11-setup-api.md', 'integration-guide/12-admin-api.md',
      'integration-guide/13-audit-log-api.md', 'integration-guide/14-duplicates-and-webhooks.md',
      'integration-guide/15-about-and-embedding.md', 'integration-guide/16-mcp.md',
      'integration-guide/17-quotas-pagination-oidc.md',
    ],
  },
  // A catalogue rather than a narrative, so it splits by contiguous range: the numbers are the reader's
  // handle on an example, and regrouping thematically would renumber all 27 to gain nothing the contents
  // page cannot give.
  {
    id: 'usecase-examples', file: 'usecase-examples.md',
    parts: [
      'usecase-examples/01-sharing-and-distribution.md',
      'usecase-examples/02-operations-research-and-agents.md',
      'usecase-examples/03-proxy-multi-space-and-personal.md',
    ],
  },
  // The decision records, as ONE entry with the records as parts — the same shape as the integration guide above.
  // Four separate entries would crowd an operator's nav with contributor material; one entry keeps every record
  // reachable (the coverage gate requires that) while costing a single line in the list. The contribution guide is
  // already offered here, so contributor docs belonging in Help is the existing convention, not a new one.
  {
    id: 'decisions', file: 'decisions.md',
    parts: [
      'decisions/01-pdfium-not-pymupdf.md',
      'decisions/02-two-layer-ssrf-defence.md',
      'decisions/03-no-runtime-model-downloads.md',
    ],
  },
  { id: 'workstation-mode-guide', file: 'workstation-mode-guide.md' },
  { id: 'network-types', file: 'network-types.md' },
  { id: 'sync-protocol', file: 'sync-protocol.md' },
  { id: 'ui-primitives', file: 'ui-primitives.md' },
  { id: 'dependencies', file: 'dependencies.md' },
  { id: 'contribution-guide', file: 'contribution-guide.md' },
] as const satisfies ReadonlyArray<{ id: string; file: string; parts?: readonly string[] }>;

export type HelpDocId = typeof HELP_DOCS[number]['id'];

@Component({
  selector: 'app-help',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, PhIconComponent, ErrorStateComponent, MdScrollersDirective],
  styles: [`
    :host { display: block; }
    .help { display: grid; grid-template-columns: 1fr; gap: 16px; }
    /* The index becomes a sidebar only when there is room for one; below that it is a scrollable
       chip row above the document, which keeps every guide one tap away on a phone. */
    @media (min-width: 900px) { .help { grid-template-columns: 232px minmax(0, 1fr); align-items: start; } }

    /* NO BACKTICKS in this block — one ends the styles template string, and the error points at @Component.
       Wraps rather than scrolls below 900px. It used to be a single overflow-x:auto row of nowrap buttons,
       which measured 976px of hidden content past a 388px box with no visible affordance — on this platform
       an overlay scrollbar paints nothing, so ten of the sixteen guides were simply not there. A table of
       contents is a list, and a list may take two lines; scrolling it was the wrong shape for the content.
       Above 900px it is still the sticky vertical column. */
    .index { display: flex; flex-wrap: wrap; gap: 6px; padding-bottom: 4px; }
    @media (min-width: 900px) {
      .index { flex-direction: column; overflow-x: visible; position: sticky; top: 12px; }
    }
    .index button { font: inherit; font-size: 13px; text-align: left; cursor: pointer; white-space: nowrap;
      padding: 7px 11px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg-surface);
      color: var(--text-secondary); transition: border-color var(--transition), color var(--transition); }
    @media (min-width: 900px) { .index button { white-space: normal; } }
    .index button:hover { border-color: var(--accent); color: var(--text-primary); }
    .index button.active { border-color: var(--accent); color: var(--accent); background: var(--bg-elevated); }
    .index button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    .doc { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px;
      padding: 20px 24px; min-width: 0; }

    /*
     * A reading measure on the PROSE only.
     *
     * The guides are long-form — the integration guide is ~7,800 lines — and the pane is as wide as the
     * window. Without a limit a paragraph ran 200+ characters on a desktop, which is roughly twice the
     * span an eye tracks back from reliably, so the reader loses their line on every wrap. This is the
     * single biggest readability problem the page had.
     *
     * Applied to text elements individually rather than to the container, because tables and code blocks need
     * the full width — capping the container would have made every wide table scroll that did not have to.
     */
    .doc ::ng-deep :is(p, li, blockquote) { max-width: 78ch; }

    /* Long tables and code blocks scroll inside the document rather than widening the page.

       NO BACKTICKS in this block.

       KNOWN GAP, measured rather than assumed: on this platform that scroll is INVISIBLE. Overlay
       scrollbars paint only while scrolling and take no layout space, so a table or code block wider than
       the pane looks like a complete one that was cut. Two attempts are recorded so nobody repeats them:

         - scrollbar-width:thin + scrollbar-color yields a 2px bar (offsetHeight - clientHeight === 2) AND
           makes Chromium 121+ ignore ::-webkit-scrollbar entirely.
         - ::-webkit-scrollbar with an explicit height did not apply here at all, with or without :is(),
           measured at 0px on table and 2px on pre.

       The mechanism that does work in this app is the DRAWN control (hscrollTop, see its own file), and it
       needs a host element in the template. This content arrives as sanitized innerHTML, so there is none.
       Closing this means wrapping pre/table during render so a host exists — tracked, not bodged here. */
    .doc ::ng-deep :is(pre, table) { max-width: 100%; overflow-x: auto; }
    .doc ::ng-deep table { display: block; border-collapse: collapse; font-variant-numeric: tabular-nums; }
    .doc ::ng-deep :is(th, td) { border: 1px solid var(--border-muted); padding: 6px 10px; font-size: 13px; text-align: left;
      vertical-align: top; }
    /* Headers and zebra rows. The guides' tables carry PROSE — 25 cells exceed 320 characters — so
       without a row boundary the eye loses which description belongs to which key. */
    .doc ::ng-deep th { background: var(--bg-elevated); font-weight: 600; color: var(--text-primary);
      position: sticky; top: 0; }
    .doc ::ng-deep tbody tr:nth-child(even) { background: color-mix(in srgb, var(--bg-elevated) 45%, transparent); }
    .doc ::ng-deep img { max-width: 100%; height: auto; }
    .doc ::ng-deep h1 { font-size: 22px; margin-top: 0; }
    .doc ::ng-deep h2 { font-size: 18px; margin-top: 28px; }
    .doc ::ng-deep h3 { font-size: 15px; margin-top: 22px; }
    /* 14px over 13.5, and 1.65 over 1.6 — these are read for minutes at a time, not glanced at. */
    .doc ::ng-deep :is(p, li) { font-size: 14px; line-height: 1.65; }
    .doc ::ng-deep li + li { margin-top: 3px; }
    .doc ::ng-deep code { font-family: var(--font-mono, monospace); font-size: 0.9em; }
    .doc ::ng-deep :not(pre) > code { background: var(--bg-elevated); padding: 1px 5px; border-radius: 4px; }
    .doc ::ng-deep pre { background: var(--bg-elevated); border: 1px solid var(--border-muted); border-radius: 8px; padding: 12px 14px; }
    .doc ::ng-deep blockquote { margin: 14px 0; padding: 2px 14px; border-left: 3px solid var(--accent); color: var(--text-secondary); }
    .doc ::ng-deep hr { border: 0; border-top: 1px solid var(--border-muted); margin: 26px 0; }

    .loading { display: flex; align-items: center; gap: 9px; color: var(--text-secondary); font-size: 13px; }
  `],
  template: `
    <div class="help">
      <nav class="index" [attr.aria-label]="'help.indexAria' | transloco">
        @for (d of docs; track d.id) {
          <button type="button" [class.active]="active() === d.id" (click)="open(d.id)"
                  [attr.aria-current]="active() === d.id ? 'page' : null">
            {{ 'help.doc.' + d.id | transloco }}
          </button>
        }
      </nav>

      <section class="doc">
        @if (loading()) {
          <div class="loading"><span class="spinner"></span>{{ 'common.loading' | transloco }}</div>
        } @else if (error(); as e) {
          <!-- A guide that failed to load is not a guide with no content. Say which, and offer a retry. -->
          <app-error-state [message]="'help.loadError' | transloco" [reason]="e" (retry)="reload()" />
        } @else {
          <!-- Links inside a rendered guide are handled in onDocClick rather than by the browser: a
               bare hash link would otherwise navigate the router, and a cross-doc link like
               integration-guide.md would leave the app for a URL that does not exist. -->
          <article #doc [innerHTML]="html()" [mdScrollers]="html()" (click)="onDocClick($event)"></article>
          <p class="loading" style="margin-top:22px;">
            <ph-icon name="info" [size]="14"/>{{ 'help.shippedNote' | transloco }}
          </p>
        }
      </section>
    </div>
  `,
})
export class HelpComponent implements OnInit {
  readonly docs = HELP_DOCS;

  /** The rendered article, for resolving a fragment to its heading element. */
  private readonly docRef = viewChild<ElementRef<HTMLElement>>('doc');

  private http = inject(HttpClient);
  private cdr = inject(ChangeDetectorRef);
  private sanitizer = inject(DomSanitizer);
  private markdown = inject(MarkdownRenderService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  readonly active = signal<HelpDocId>(HELP_DOCS[0].id);
  readonly loading = signal(true);
  readonly error = signal('');
  private readonly rendered = signal<SafeHtml>('');

  readonly html = computed(() => this.rendered());

  ngOnInit(): void {
    // `?doc=` makes a guide linkable, which is what lets a settings screen point at the paragraph that
    // explains it. An unknown id falls back to the first guide rather than erroring: a stale bookmark
    // should land somewhere useful, not on a failure. The fragment addresses a heading within it, so a
    // help control can open the *section* that explains its screen rather than the top of a long guide.
    const requested = this.route.snapshot.queryParamMap.get('doc');
    const known = HELP_DOCS.find(d => d.id === requested);
    this.load(known?.id ?? HELP_DOCS[0].id, this.route.snapshot.fragment ?? undefined);
  }

  open(id: HelpDocId, fragment?: string): void {
    if (id === this.active() && !this.error()) {
      if (fragment) this.scrollTo(fragment);
      return;
    }
    // Reflected in the URL so the guide can be linked to and survives a reload.
    void this.router.navigate([], {
      relativeTo: this.route, queryParams: { doc: id }, fragment: fragment || undefined, replaceUrl: true,
    });
    this.load(id, fragment);
  }

  /**
   * Links inside a rendered guide, which the browser would get wrong in two different ways.
   *
   * A bare `#anchor` — and `userguide.md` alone has 31 of them, its whole table of contents — resolves
   * against the current route, so the browser hands it to the router and nothing happens. A cross-doc
   * link like `integration-guide.md` resolves to `/settings/integration-guide.md`, which leaves the app
   * for a URL that does not exist. Both were dead when the Help page first shipped.
   *
   * External links are left entirely alone: the point is to keep in-product navigation working, not to
   * capture every anchor on the page.
   */
  onDocClick(ev: MouseEvent): void {
    // Never swallow a modified click — ctrl/cmd/middle-click means "open in a new tab", and that is
    // still a reasonable thing to want from a documentation link.
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const anchor = (ev.target as HTMLElement | null)?.closest('a');
    const href = anchor?.getAttribute('href');
    if (!href) return;

    if (href.startsWith('#')) {
      ev.preventDefault();
      const fragment = decodeURIComponent(href.slice(1));
      this.scrollTo(fragment);
      void this.router.navigate([], {
        relativeTo: this.route, queryParams: { doc: this.active() }, fragment, replaceUrl: true,
      });
      return;
    }

    // A relative markdown link, at any depth: `userguide.md`, `./userguide.md`, `../integration-guide.md`,
    // `integration-guide/04-brain-api.md#schema-validation`.
    //
    // The depth matters now that a guide is split across a subdirectory. The old pattern only accepted a
    // bare filename, so every link into `integration-guide/` fell through — and "falling through" is not
    // the harmless default it reads as: the browser resolves the relative href against `/settings/help`,
    // the router finds no route, and the wildcard lands the reader on **Brain**. A documentation link
    // that dumps you on a different page is worse than one that does nothing.
    const crossDoc = /^(?:\.{0,2}\/)*([a-z0-9-]+(?:\/[a-z0-9-]+)*\.md)(?:#(.*))?$/i.exec(href);
    if (crossDoc) {
      ev.preventDefault();
      const path = crossDoc[1]!;
      const target = HELP_DOCS.find(d =>
        d.file === path || ('parts' in d && (d.parts as readonly string[]).includes(path)));
      if (target) { this.open(target.id, crossDoc[2]); return; }
      // A markdown file this page does not offer. `help-docs-coverage` should make that impossible, but
      // if it happens the reader gets the raw document in a new tab rather than being silently moved.
      this.openExternally(`assets/docs/${path}${crossDoc[2] ? `#${crossDoc[2]}` : ''}`);
      return;
    }

    // Anything else — an absolute URL, a mailto:, a link to a repo file. A same-tab navigation would
    // unload the app and lose whatever the reader was doing; the guide is a reference they are reading
    // *while* working.
    ev.preventDefault();
    this.openExternally(href);
  }

  /** Open in a new tab, without handing the opener over. */
  private openExternally(url: string): void {
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  /** Bring a heading into view by its slug id. Missing ids are a no-op — a stale anchor in a document
   *  should leave the reader at the top of the guide, not throw. */
  private scrollTo(fragment: string): void {
    if (!fragment) return;
    // Compared rather than selected: a slug from a document heading is arbitrary text, and building a
    // `#...` selector out of it needs escaping that is easy to get wrong (and `CSS.escape` is not
    // universally present). Matching the property sidesteps the question entirely.
    const root = this.docRef()?.nativeElement;
    const el = root && Array.from(root.querySelectorAll<HTMLElement>('[id]')).find(n => n.id === fragment);
    // Scrolling is a nicety layered on top of rendering the guide; it must never be able to break it.
    // This runs inside the async render handler, where a throw would leave the page mid-update.
    if (typeof el?.scrollIntoView === 'function') el.scrollIntoView({ block: 'start' });
  }

  reload(): void { this.load(this.active()); }

  /**
   * Join a split guide's parts into one document.
   *
   * Two fixups, both because the files on disk are written for GitHub and this view is not GitHub:
   *
   *  - **Part headers are dropped.** Each file opens with `# Title` and a "Part of the …" backlink so it
   *    stands alone in a repo browser. Concatenated, seventeen H1s and seventeen backlinks would be
   *    noise, and the backlink would point at an index this page does not render.
   *  - **Cross-part links become plain anchors.** On disk a link reads `04-brain-api.md#schema-validation`
   *    because that is what resolves on GitHub. Here every part is in one document, so the file prefix
   *    has to come off or the link leaves the page.
   */
  private joinParts(chunks: string[], files: readonly string[]): string {
    if (chunks.length === 1) return chunks[0]!;
    const names = files.map(f => f.split('/').pop()!);
    const stripPrefix = new RegExp(`\\]\\((?:${names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(#[^)]+)\\)`, 'g');
    return chunks
      .map(c => c
        .replace(/^#\s.*(\r?\n)+/, '')                                  // the part's own H1
        .replace(/^>\s*Part of the \[[^\]]*\]\([^)]*\)\.\s*(\r?\n)+/m, '')) // and its backlink
      .join('\n\n')
      .replace(stripPrefix, ']($1)');
  }

  private load(id: HelpDocId, fragment?: string): void {
    this.active.set(id);
    this.loading.set(true);
    this.error.set('');
    const entry = HELP_DOCS.find(d => d.id === id)!;
    // A guide split across files is fetched whole and joined, so it renders as ONE document.
    //
    // That is what keeps every existing `#anchor` working — the guide's own cross-references, the user
    // guide's deep links, the README's. Offering seventeen nav entries instead would have broken all of
    // them and turned a nine-item sidebar into a wall.
    // `in` rather than `?.` because the array is `as const`: the union member for a single-file guide has
    // no `parts` property at all, so a direct access does not type-check.
    const files: readonly string[] = 'parts' in entry ? entry.parts : [entry.file];
    const fetches = files.map(f =>
      firstValueFrom(this.http.get(`assets/docs/${f}`, { responseType: 'text' })));

    from(Promise.all(fetches).then(chunks => this.joinParts(chunks, files))).subscribe({
      next: async text => {
        if (this.active() !== id) return;              // a faster click won the race
        const html = await this.markdown.render(text);
        if (this.active() !== id) return;
        this.rendered.set(this.sanitizer.bypassSecurityTrustHtml(html));
        this.loading.set(false);
        // The heading only exists once the view has rendered the new HTML, so the scroll waits a turn.
        if (fragment) {
          this.cdr.detectChanges();
          this.scrollTo(fragment);
        }
      },
      // Bundled assets do not normally 404 — if one does, the build dropped it, and saying so beats
      // rendering an empty page that looks like a guide with nothing in it.
      error: e => {
        if (this.active() !== id) return;
        this.error.set(httpErrorReason(e));
        this.loading.set(false);
      },
    });
  }
}
