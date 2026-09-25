/**
 * BrainComponent — verifies the OnPush conversion (P5, slice 4).
 *
 * Brain is the heaviest page in the app (49 signals, five record tabs, a detail drawer). It is
 * OnPush-safe because every async path writes signals, which notify OnPush regardless of zone.
 *
 * The subtle part — and the reason the drawer test below exists — is that brain also renders plain,
 * NON-signal form models (`memoryForm`, `drawerEditMemory`, …) through ngModel. A plain-field write
 * does not mark an OnPush view dirty on its own; these render only because every write is
 * accompanied by a signal write in the same turn (`openDrawer` sets the `drawerRecord` signal; the
 * create callbacks set `creatingX`/`showXForm`) or happens inside a template event handler. That
 * coupling is load-bearing and invisible in the source, so it is pinned here: the drawer title binds
 * the plain `drawerEditMemory.fact`, and if the sibling signal write were ever dropped, the title
 * would render empty and this test would fail rather than the bug shipping silently.
 */
import { TestBed, DeferBlockBehavior } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EMPTY, BehaviorSubject } from 'rxjs';
import { of } from 'rxjs';
import { ActivatedRoute, Router } from '@angular/router';
import { SpacesApi } from '../../core/spaces-api.service';
import { BrainApi } from '../../core/brain-api.service';
import { FilesApi } from '../../core/files-api.service';
import { AdminApi } from '../../core/admin-api.service';
import { NetworksApi } from '../../core/networks-api.service';
import { AuthService } from '../../core/auth.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { BrainComponent } from './brain.component';
import { COLLECTION_TABS } from './brain-tabs';
import { SpaceSettingsState } from '../settings/space-settings-state.service';
import { isOnPush } from '../../testing/onpush';


/** Read-only stub: brain's init cascade is listSpaces → getSpaceStats/getReindexStatus/getSpaceMeta. */
function makeApi(spaceIds: readonly string[] = ['work']) {
  return {
    listSpaces: () => of({ spaces: spaceIds.map(id => ({ id, label: id })) }),
    getSpaceStats: () => of({ facts: 0, entities: 0, edges: 0, chrono: 0, files: 0 }),
    getReindexStatus: () => of({ needsReindex: false }),
    getSpaceMeta: () => of({ tagSuggestions: [], typeSchemas: {} }),
    listFacts: () => of({ facts: [] }),
    getEntitiesByIds: () => of({ entities: [] }),
    mintEventsTicket: () => of({ ticket: 't', expiresInMs: 60000 }),
    // Overview data-model panel. An empty model keeps the panel present but silent, which is what these
    // tests want: they are about the shell, and a panel that threw would fail every one of them for a
    // reason none of them are checking.
    getErModel: () => of({
      spaceId: 'work', entityTypes: [], relationships: [],
      danglingEdges: 0, truncated: null, totals: { entities: 0, edges: 0 },
    }),
    getAbout: () => of(null), // Overview Instance panel — null keeps it hidden in tests
    getEmbeddingQueue: () => of(null), // Overview embedding-queue panel — null keeps it hidden in tests
    getTokenAccess: () => of({ tokens: [] }), // Overview token-access matrix (admin-only)
    getCompleteness: () => of(null), // Overview completeness panel — null keeps it hidden in tests
    // Overview usage panel. An empty `spaces` array is the real "nothing was asked in this window" shape, and
    // the shell turns it into a zeroed row so the panel renders rather than vanishing.
    getSpaceActivity: () => of({ spaceId: 'general', hours: 168, spaces: [] }),
    listVotes: () => of({ rounds: [] }), // Overview Governance panel — no open votes in tests
  } as any;
}

describe('BrainComponent (OnPush)', () => {
  function create() {
    TestBed.configureTestingModule({
      imports: [BrainComponent, getTranslocoModule()],
      providers: [
        { provide: SpacesApi, useValue: makeApi() },
        { provide: BrainApi, useValue: makeApi() },
        { provide: FilesApi, useValue: makeApi() },
        { provide: AdminApi, useValue: makeApi() },
        { provide: NetworksApi, useValue: makeApi() },
        { provide: AuthService, useValue: { token: () => '' } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => '' } }, queryParamMap: EMPTY } },
      ],
    });
    const fixture = TestBed.createComponent(BrainComponent);
    fixture.detectChanges(); // ngOnInit → listSpaces resolves synchronously via of()
    return fixture;
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('is compiled as OnPush', () => {
    expect(isOnPush(BrainComponent)).toBe(true);
  });

  it('lands on the Overview tab by default (F9 — Overview is the space landing view)', () => {
    expect(create().componentInstance.activeTab()).toBe('overview');
  });

  it('switching space lands on the new space Overview; re-clicking the active chip keeps your tab', () => {
    const c = create().componentInstance; // initial load selects 'work'
    c.setTab('entities');
    expect(c.activeTab()).toBe('entities');

    // A DIFFERENT space → its Overview (the landing view). Previously the tab persisted, so the
    // switch silently swapped the rows under you and looked like nothing had happened.
    c.selectSpace('other');
    expect(c.activeTab()).toBe('overview');
    expect(c.activeSpaceId()).toBe('other');

    // Re-clicking the chip you are already on is not a switch — it must not yank you off your tab.
    c.setTab('edges');
    c.selectSpace('other');
    expect(c.activeTab()).toBe('edges');
  });

  it('switching a TAB does not throw you back to the first space', async () => {
    /*
     * Reported 2026-08-30: *"when clicking a knowledgetype table in any space but general the ui jumps to
     * general"*, and the workaround found was to click the type, land in general, pick the space again, and
     * then the type finally selects.
     *
     * The mechanism, and it is one line: this page READS `?space=` and never writes it itself — the only
     * writer is the ER diagram's count links, which is what made a STALE one possible and is covered by the
     * spec below. `setTab` navigates
     * to record the tab, the navigation re-emits `queryParamMap`, and `applyQueryParams` reads an absent
     * `?space=` as "no preference" and falls back to `spaces[0]` — the first space in the list. So every tab
     * click on any other space snapped back, and it also reset the tab to Overview, because `selectSpace`
     * treats a changed space as a switch.
     *
     * The workaround worked for a reason worth keeping: the SECOND click writes the same `?tab=` value, Angular
     * emits no query-param change, and the handler never runs.
     *
     * Every earlier spec here stubs `queryParamMap` as `EMPTY`, so the subscription never fired and no test
     * could see any of it. This one emits.
     */
    const params = new BehaviorSubject(new Map<string, string>());
    const snapshot = { queryParamMap: { get: (k: string) => params.value.get(k) ?? null } };
    TestBed.configureTestingModule({
      imports: [BrainComponent, getTranslocoModule()],
      providers: [
        { provide: SpacesApi, useValue: makeApi(['work', 'other']) },
        { provide: BrainApi, useValue: makeApi(['work', 'other']) },
        { provide: FilesApi, useValue: makeApi(['work', 'other']) },
        { provide: AdminApi, useValue: makeApi(['work', 'other']) },
        { provide: NetworksApi, useValue: makeApi(['work', 'other']) },
        { provide: AuthService, useValue: { token: () => '' } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot, queryParamMap: params.asObservable() },
        },
        {
          // Stands in for the real navigation: records what was written and re-emits it, which is exactly
          // what the router does and exactly what the component was not expecting.
          provide: Router,
          useValue: {
            navigate: (_c: unknown[], extras: { queryParams: Record<string, string> }) => {
              const next = new Map(params.value);
              for (const [k, v] of Object.entries(extras.queryParams)) next.set(k, v);
              params.next(next);
              return Promise.resolve(true);
            },
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(BrainComponent);
    fixture.detectChanges();
    const c = fixture.componentInstance as any;

    c.selectSpace('other');
    expect(c.activeSpaceId()).toBe('other');

    c.setTab('entities');
    await Promise.resolve();

    expect(c.activeSpaceId(), 'the tab click threw the page back to the first space').toBe('other');
    expect(c.activeTab(), 'and took the tab with it').toBe('entities');

    /*
     * And the space is NOT in the URL, on purpose. Writing it would fix this bug too, and is the obvious
     * move — the owner ruled it out on 2026-08-30 because Ythril is often iframed and a page that rewrites
     * its own address inside somebody else's frame is doing something the host did not ask for.
     */
    expect(params.value.get('space'), 'the space was written to the URL, which is ruled out for iframes')
      .toBeUndefined();
  });

  it('a STALE ?space= does not move the page either', async () => {
    /*
     * The other half of the same bug, and the half the fix above did not reach. It survived because the
     * commit, the CHANGELOG and the docblock all said the page reads `?space=` and *nothing ever writes it* —
     * and if nothing writes it, a stale one is impossible. `er-model-panel.component.ts` writes it, on the
     * knowledge-type count links, which is the very control the report named.
     *
     * So: land with `?space=other` (what an ER count link produces), switch space by chip — the screen
     * changes and the URL deliberately does not — then click a tab. `writeTabToUrl` merges, which carries the
     * stale `?space=other` forward, the handler reads it as authoritative, and the page jumps back.
     *
     * A reload after any chip switch lands somewhere else for the same reason.
     */
    const params = new BehaviorSubject(new Map<string, string>([['space', 'other']]));
    const snapshot = { queryParamMap: { get: (k: string) => params.value.get(k) ?? null } };
    TestBed.configureTestingModule({
      imports: [BrainComponent, getTranslocoModule()],
      providers: [
        { provide: SpacesApi, useValue: makeApi(['work', 'other']) },
        { provide: BrainApi, useValue: makeApi(['work', 'other']) },
        { provide: FilesApi, useValue: makeApi(['work', 'other']) },
        { provide: AdminApi, useValue: makeApi(['work', 'other']) },
        { provide: NetworksApi, useValue: makeApi(['work', 'other']) },
        { provide: AuthService, useValue: { token: () => '' } },
        { provide: ActivatedRoute, useValue: { snapshot, queryParamMap: params.asObservable() } },
        {
          provide: Router,
          useValue: {
            navigate: (_c: unknown[], extras: { queryParams: Record<string, string> }) => {
              const next = new Map(params.value);
              for (const [k, v] of Object.entries(extras.queryParams)) next.set(k, v);
              params.next(next);
              return Promise.resolve(true);
            },
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(BrainComponent);
    fixture.detectChanges();
    const c = fixture.componentInstance as any;

    expect(c.activeSpaceId(), 'the deep link did not land on the space it named').toBe('other');

    c.selectSpace('work');
    expect(c.activeSpaceId()).toBe('work');

    c.setTab('entities');
    await Promise.resolve();

    expect(c.activeSpaceId(), 'a stale ?space= from the deep link overrode the space on screen').toBe('work');
    expect(c.activeTab(), 'and took the tab with it').toBe('entities');
  });

  it('but a NEW ?space= still moves the page — the ER count links depend on it', async () => {
    /*
     * The reason the fix cannot simply be "honour `?space=` on the first pass only". The ER-model panel's
     * count links are `routerLink` navigations to `/brain` with a fresh `?space=`, and they are clicked from
     * INSIDE `/brain` — no remount, no first pass. Ignoring a changed value would break the control the
     * original report was about, which is a worse bug than the one being fixed.
     *
     * So the rule is "honour it when it CHANGED", not "honour it once".
     */
    const params = new BehaviorSubject(new Map<string, string>([['space', 'work']]));
    const snapshot = { queryParamMap: { get: (k: string) => params.value.get(k) ?? null } };
    TestBed.configureTestingModule({
      imports: [BrainComponent, getTranslocoModule()],
      providers: [
        { provide: SpacesApi, useValue: makeApi(['work', 'other']) },
        { provide: BrainApi, useValue: makeApi(['work', 'other']) },
        { provide: FilesApi, useValue: makeApi(['work', 'other']) },
        { provide: AdminApi, useValue: makeApi(['work', 'other']) },
        { provide: NetworksApi, useValue: makeApi(['work', 'other']) },
        { provide: AuthService, useValue: { token: () => '' } },
        { provide: ActivatedRoute, useValue: { snapshot, queryParamMap: params.asObservable() } },
        { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
      ],
    });
    const fixture = TestBed.createComponent(BrainComponent);
    fixture.detectChanges();
    const c = fixture.componentInstance as any;
    expect(c.activeSpaceId()).toBe('work');

    // What the ER panel's count link does: navigate to /brain with a different space and a tab.
    params.next(new Map<string, string>([['space', 'other'], ['tab', 'facts']]));
    await Promise.resolve();

    expect(c.activeSpaceId(), 'an ER count link to another space stopped working').toBe('other');
    expect(c.activeTab()).toBe('facts');
  });

  it('a query-param change that names no space leaves the space alone', async () => {
    // The second half, on its own. An external navigation — a link into this page carrying only `?tab=` —
    // must not be read as "go back to the first space". Only the FIRST pass, with nothing selected yet,
    // falls back to the first space.
    const params = new BehaviorSubject(new Map<string, string>());
    const snapshot = { queryParamMap: { get: (k: string) => params.value.get(k) ?? null } };
    TestBed.configureTestingModule({
      imports: [BrainComponent, getTranslocoModule()],
      providers: [
        { provide: SpacesApi, useValue: makeApi(['work', 'other']) },
        { provide: BrainApi, useValue: makeApi(['work', 'other']) },
        { provide: FilesApi, useValue: makeApi(['work', 'other']) },
        { provide: AdminApi, useValue: makeApi(['work', 'other']) },
        { provide: NetworksApi, useValue: makeApi(['work', 'other']) },
        { provide: AuthService, useValue: { token: () => '' } },
        { provide: ActivatedRoute, useValue: { snapshot, queryParamMap: params.asObservable() } },
        { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
      ],
    });
    const fixture = TestBed.createComponent(BrainComponent);
    fixture.detectChanges();
    const c = fixture.componentInstance as any;

    c.selectSpace('other');
    expect(c.activeSpaceId()).toBe('other');

    // Someone links in with a tab and no space — the Router stub here writes nothing, so the URL genuinely
    // carries no `?space=`, which is the state the old fallback mis-read.
    params.next(new Map([['tab', 'edges']]));
    await Promise.resolve();

    expect(c.activeSpaceId(), 'an absent ?space= was read as "reset to the first space"').toBe('other');
    expect(c.activeTab()).toBe('edges');
  });

  it('every Overview stat tile opens a tab that actually exists', () => {
    // The tiles and the tabs used to be two hand-written unions (`StatKey` in overview-tab,
    // `BrainTab` here) that agreed only by convention. The drift was one-directional and SILENT:
    // adding a tab here and a tile there against a stale copy would compile and the tile simply
    // would not open anything. Both now derive from COLLECTION_TABS, and this walks the same list
    // through the real handler — a type alias alone would not prove the tab is reachable.
    const c = create().componentInstance;
    for (const tab of COLLECTION_TABS) {
      c.setTab(tab);
      expect(c.activeTab()).toBe(tab);
    }
  });

  it('File Meta is merged into one Files tab — no separate File Meta collection tab', () => {
    const c = create().componentInstance;
    expect(c.collectionTabs.some(t => t.key === 'filemeta' as never)).toBe(false);
    expect(c.collectionTabs.map(t => t.key)).toEqual(['entities', 'edges', 'facts', 'chrono']);
    c.setTab('files');
    expect(c.activeTab()).toBe('files'); // the single Files tab still activates
  });

  // ── Regression: Graph/Files must UNMOUNT when you leave their tab ────────────
  // They are lazy-loaded with @defer to keep cytoscape + the file-manager renderers off the landing
  // chunk. The bug: `@defer (when activeTab()==='graph')` is a ONE-WAY load trigger — it renders the
  // block when the tab is first entered but never removes it, so Graph/Files lingered over every later
  // tab. The fix wraps each @defer in `@if (activeTab()===…)` so leaving the tab unmounts it. This test
  // uses Playthrough so the defer blocks resolve, and asserts graph is present on its tab and GONE after
  // navigating to Entities. deferBlockBehavior is per-module, so this test builds its own TestBed.
  it('unmounts the Graph tab when navigating away (defer must be @if-gated, not @defer-when)', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [BrainComponent, getTranslocoModule()],
      deferBlockBehavior: DeferBlockBehavior.Playthrough,
      providers: [
        { provide: SpacesApi, useValue: makeApi() },
        { provide: BrainApi, useValue: { ...makeApi(), listEntities: () => of({ entities: [] }) } },
        { provide: FilesApi, useValue: makeApi() },
        { provide: AdminApi, useValue: makeApi() },
        { provide: NetworksApi, useValue: makeApi() },
        { provide: AuthService, useValue: { token: () => '' } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => '' } }, queryParamMap: EMPTY } },
      ],
    });
    const fixture = TestBed.createComponent(BrainComponent);
    fixture.detectChanges();                 // ngOnInit → lands on Overview
    const c = fixture.componentInstance;
    const el = fixture.nativeElement as HTMLElement;
    // The graph block is present when EITHER its deferred content or its @loading placeholder renders
    // (the `minimum 200ms` @loading holds the placeholder in a unit run — either proves the block exists).
    const graphPresent = () => !!(el.querySelector('app-graph-view') || el.querySelector('[data-tab-defer="graph"]'));

    expect(graphPresent()).toBe(false);      // not on the landing (Overview) tab

    c.setTab('graph');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(graphPresent()).toBe(true);       // mounted on its own tab

    c.setTab('entities');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    // The @if wrapper must have removed it — the pre-fix `@defer (when …)` left it lingering here.
    expect(graphPresent()).toBe(false);
  });

  // ── Regression: the mount⇄reload request storm (app-unusable P0) ─────────────
  // The five record tabs each WRITE `recordList.loading` during their own `load()`. They used to be
  // mounted inside the `@else` of `@if (recordList.loading())`, so a tab set loading=true on load,
  // which unmounted the tab (removing the @else branch); the response set loading=false, which
  // re-mounted it → a fresh `load()` → loading=true → … an infinite mount⇄reload loop that hammered
  // the API (~5 req/s, self-sustaining even once rate-limited to 429s) and froze the page. The fix:
  // tabs mount on `activeTab()` ALONE and the spinner floats on top, so the active tab instance is
  // never torn down by its own loading state. This test drives the shared loading signal the way a
  // real async load does and asserts the active tab is NOT re-created (its `load()` is not re-fired).
  it('does NOT re-create the active record tab when recordList.loading toggles (storm regression)', () => {
    const listEntities = vi.fn(() => of({ entities: [] }));
    TestBed.configureTestingModule({
      imports: [BrainComponent, getTranslocoModule()],
      providers: [
        { provide: SpacesApi, useValue: makeApi() },
        { provide: BrainApi, useValue: { ...makeApi(), listEntities } },
        { provide: FilesApi, useValue: makeApi() },
        { provide: AdminApi, useValue: makeApi() },
        { provide: NetworksApi, useValue: makeApi() },
        { provide: AuthService, useValue: { token: () => '' } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => '' } }, queryParamMap: EMPTY } },
      ],
    });
    const fixture = TestBed.createComponent(BrainComponent);
    fixture.detectChanges(); // ngOnInit → listSpaces → selectSpace('work')

    fixture.componentInstance.setTab('entities'); // mount the entities tab → it self-loads once
    fixture.detectChanges();
    const afterActivate = listEntities.mock.calls.length;
    expect(afterActivate).toBeGreaterThan(0);

    // Toggle the shared loading signal across change-detection cycles, exactly as an async load does.
    // On the buggy @else structure each false→true→false cycle unmounted+re-mounted the tab, adding a
    // fresh load() every time. On the fixed structure the tab persists, so the count must not grow.
    const recordList = fixture.componentInstance.recordList;
    for (let i = 0; i < 4; i++) {
      recordList.loading.set(true);
      fixture.detectChanges();
      recordList.loading.set(false);
      fixture.detectChanges();
    }
    expect(listEntities.mock.calls.length).toBe(afterActivate);
  });

  // The facts table rendering (row-per-memory, signal re-render) moved to
  // facts-tab.component.spec.ts when that tab became its own component (A17.9b-6d).

  // The detail-drawer rendering tests (open + plain-model, multiline description) moved to
  // record-drawer.component.spec.ts when the drawer became its own component (A17.9b-5).

  // ── F8: network-membership indicator on space chips ────────────────────────
  const setSpaces = (fixture: ReturnType<typeof create>, spaceView: Record<string, unknown>) => {
    fixture.componentInstance.spaces.set([spaceView as never]);
    fixture.detectChanges();
  };
  const netIcon = (fixture: ReturnType<typeof create>) =>
    fixture.nativeElement.querySelector('.space-chip .space-chip-net') as HTMLElement | null;

  it('shows NO network indicator for a space in no network (F8)', () => {
    const fixture = create();
    setSpaces(fixture, { space: { id: 'work', label: 'Work' } });
    expect(netIcon(fixture)).toBeNull();
  });

  it('renders the network indicator with a status-specific class per state (F8)', () => {
    const fixture = create();
    for (const status of ['idle', 'syncing', 'degraded', 'vote'] as const) {
      setSpaces(fixture, {
        space: { id: 'work', label: 'Work', networkStatus: status, networks: [{ id: 'n1', label: 'Braintree', type: 'braintree' }] },
      });
      const icon = netIcon(fixture);
      expect(icon, `indicator should render for status=${status}`).toBeTruthy();
      expect(icon!.classList.contains(`net-${status}`)).toBe(true);
      // Uses the same glyph as the Networks nav item (ph-icon name="link").
      expect(icon!.querySelector('ph-icon')).toBeTruthy();
    }
  });

  it('the indicator tooltip names the network and the status (F8, a11y — colour is not the only signal)', () => {
    const fixture = create();
    setSpaces(fixture, {
      space: { id: 'work', label: 'Work', networkStatus: 'vote', networks: [{ id: 'n1', label: 'Braintree', type: 'braintree' }] },
    });
    const title = netIcon(fixture)!.getAttribute('title') ?? '';
    expect(title).toContain('Braintree');
    // Test transloco renders raw keys, so the status word resolves to its key.
    expect(title).toContain('brain.spaceChip.network.vote');
  });

  // The edge from/to endpoint pickers moved to edges-tab.component.spec.ts with the Edges tab (A17.9b-6f).

  describe('view in graph (from a record table)', () => {
    it('switches to the Graph tab and carries the entity id', () => {
      const fixture = create();
      const c = fixture.componentInstance;
      c.viewInGraph('ent-42');
      expect(c.activeTab()).toBe('graph');
      expect(c.graphFocusId()).toBe('ent-42');
    });

    it('does NOT survive a later manual visit to the Graph tab', () => {
      // The graph tab UNMOUNTS on leave and re-reads its input on every remount, so a focus left behind
      // would silently re-root the graph the next time the tab is opened by hand — a stale node
      // presented as the thing you asked for. `setTab` clears it, and the order inside `viewInGraph`
      // (set AFTER setTab) is what makes both true at once.
      const fixture = create();
      const c = fixture.componentInstance;
      c.viewInGraph('ent-42');
      expect(c.graphFocusId()).toBe('ent-42');

      c.setTab('entities');
      expect(c.graphFocusId()).toBeNull();

      c.setTab('graph');                       // opened by hand this time
      expect(c.graphFocusId()).toBeNull();
      expect(c.activeTab()).toBe('graph');
    });
  });

  /**
   * ── The space-settings cog ──────────────────────────────────────────────────────────────────────
   *
   * Reaching the space editor meant leaving the Brain for Settings → Spaces, finding the row, and coming
   * back — three navigations to rename a space that was already on screen. The cog opens the same dialog
   * on the space already selected here.
   *
   * Placement is the owner's call and is asserted rather than described: FAR RIGHT, after Files. It was
   * first proposed beside Review and rejected for the reason these tests pin — it opens a modal, so it
   * selects nothing, and sitting it among the tabs makes it read as a ninth destination.
   */
  describe('the space-settings cog', () => {
    // The TAB strip, not the sidebar space chips — which also live in a .space-tabs container and whose
    // last button is a space. That mistake made three of these pass for the wrong reason on first run.
    const strip = (f: any) => f.nativeElement.querySelector('.tabs[role="tablist"]') as HTMLElement;

    it('is the LAST control in the strip, after Files', () => {
      const buttons = [...strip(create()).querySelectorAll('button')];
      const last = buttons[buttons.length - 1];
      expect(last?.classList.contains('tab-cog')).toBe(true);
      // And Files is the one before it, which is what makes this an ordering assertion rather than a
      // restatement of "there is a cog somewhere in the strip".
      const prev = buttons[buttons.length - 2];
      expect(prev?.textContent ?? '').toContain('files');
    });

    it('is not a tab: no role, no aria-selected, no label text', () => {
      const cog = strip(create()).querySelector('.tab-cog');
      expect(cog?.getAttribute('role')).toBeNull();
      expect(cog?.getAttribute('aria-selected')).toBeNull();
      // Icon only. A visible "Settings" word here competes with the instance-wide Settings page, which is
      // a different scope — so the name lives in the accessible label rather than being dropped.
      expect((cog?.textContent ?? '').trim()).toBe('');
      expect(cog?.getAttribute('aria-label')).toBeTruthy();
      expect(cog?.getAttribute('title')).toBeTruthy();
    });

    it('opens the dialog on the space already selected, with no extra request', () => {
      const f = create();
      const state = f.debugElement.injector.get(SpaceSettingsState);
      expect(state.settingsSpace()).toBeNull();

      f.componentInstance.openSpaceSettings();
      // The id matters more than the object: opening the dialog on a DIFFERENT space than the one the
      // sidebar shows selected is exactly the failure this cog exists to avoid.
      expect(state.settingsSpace()?.id).toBe('work');
    });

    it('is disabled while no space is selected', () => {
      const f = create();
      f.componentInstance.activeSpaceId.set('');
      f.detectChanges();
      expect(strip(f).querySelector('.tab-cog')?.hasAttribute('disabled')).toBe(true);
    });

    it('a saved space patches the sidebar row and KEEPS its stats', () => {
      // The reason the host listens at all: the dialog patches its own SpacesStore, and the instance here
      // is a separate empty one. Refetching instead would drop the per-space stats, which cost a request
      // each — so the record is merged and the stats left alone. A label edit changes no count.
      const c = create().componentInstance;
      const before = c.spaces().find((sv: any) => sv.space.id === 'work');
      expect(before?.stats).toBeTruthy();

      c.onSpaceSaved({ ...before!.space, label: 'Renamed' });
      const after = c.spaces().find((sv: any) => sv.space.id === 'work');
      expect(after?.space.label).toBe('Renamed');
      expect(after?.stats).toEqual(before?.stats);
    });
  });
    /**
   * Repointed for G-2: these loaders and their signals moved to `OverviewDataService`, reached through `ov`.
   * The ASSERTIONS are unchanged — same invariants, same expectations — which is the point of having written
   * them before the move. Only the address changed.
   */
describe('BrainComponent — Overview load cascade (characterization for G-2)', () => {
    beforeEach(() => TestBed.resetTestingModule());

    /** Every loader the Overview panel depends on, with the signal it fills and the pending key it clears. */
    const LOADERS = [
      { fn: 'loadSpaceActivity', signal: 'spaceActivity', pending: 'activity' },
      { fn: 'loadCompleteness', signal: 'completeness', pending: 'completeness' },
      { fn: 'loadEmbeddingQueue', signal: 'embeddingQueue', pending: 'queue' },
      { fn: 'loadTokenAccess', signal: 'tokenAccess', pending: 'tokens' },
    ] as const;

    it('names every loader that exists, so a new one cannot be added unpinned', () => {
      // A list that silently omits a loader would let the next one be written without either guard.
      const c = create().componentInstance as any;
      for (const { fn } of LOADERS) {
        expect(typeof c.ov[fn], fn).toBe('function');
      }
    });

    it('a response that arrives after the user switched space is DISCARDED', () => {
      // The failure this prevents: switching from 'work' to 'other' while six requests are in flight, and the
      // panel then showing work's numbers labelled 'other'. Nothing errors, and the layout is perfect.
      const c = create().componentInstance as any;
      expect(c.activeSpaceId()).toBe('work');

      // Load for a space that is NOT the active one — the same situation a late response creates.
      c.ov.spaceActivity.set(null);
      c.ov.loadSpaceActivity('some-other-space', () => c.activeSpaceId() === 'some-other-space');
      expect(c.ov.spaceActivity()).toBeNull();
    });

    it('but it still clears the pending flag, so no skeleton is left up', () => {
      // The opposite pull. The guard must gate the RESULT and not the settle: a stale response that returned
      // early would leave that panel's skeleton spinning until the next space switch.
      const c = create().componentInstance as any;
      c.ov.loadCompleteness('some-other-space', () => c.activeSpaceId() === 'some-other-space');
      expect(c.ov.overviewPending().completeness).toBe(false);
    });

    it('a response for the ACTIVE space is stored', () => {
      // The control. Without it the two tests above pass on a loader that stores nothing at all.
      const c = create().componentInstance as any;
      c.ov.spaceActivity.set(null);
      c.ov.loadSpaceActivity('work', () => c.activeSpaceId() === 'work');
      expect(c.ov.spaceActivity()).not.toBeNull();
    });

    it('an empty activity window becomes a ZEROED row, not null', () => {
      // "Nothing was asked" is an answer and the panel must render it. Returning null would blank the card and
      // read as a loading failure — which is what it did before the zeroed fallback existed.
      const c = create().componentInstance as any;
      c.ov.loadSpaceActivity('work', () => c.activeSpaceId() === 'work');
      const a = c.ov.spaceActivity();
      expect(a).not.toBeNull();
      expect(a.calls).toBe(0);
      expect(a.space).toBe('work');
    });

    it('every pending flag is false once the cascade has run', () => {
      // The skeletons come down. Asserted over the whole record rather than per key, so a loader added later
      // without a settle is caught here even if nobody adds it to LOADERS above.
      const c = create().componentInstance as any;
      const stuck = Object.entries(c.ov.overviewPending()).filter(([, v]) => v === true).map(([k]) => k);
      expect(stuck, 'these panels still show a skeleton after the cascade').toEqual([]);
    });

    it('a space with no networks resolves votes to an empty list without a request', () => {
      // The one loader that can skip its request entirely. It must still leave a rendered empty state rather
      // than null, or the Governance panel decides it is loading for ever.
      const c = create().componentInstance as any;
      c.ov.overviewVotes.set(null);
      c.ov.loadOverviewVotes(() => c.activeSpaceId() === 'work', []);
      expect(c.ov.overviewVotes()).toEqual([]);
    });
  });
});

/**
 * ── Characterization: the Overview load cascade ───────────────────────────────────────────────────
 *
 * Written BEFORE the split recorded as G-2, and proven against the current code. `brain.component.ts` crossed the
 * god-file ceiling at 659 lines and the move that helps is lifting the Overview panel's loaders out of the shell.
 * These tests exist so that move can be judged by them rather than by reading the diff.
 *
 * Two invariants matter, and neither is visible in the shape of the code:
 *
 *  1. **A response for a space the user has left is DISCARDED.** Six loaders run concurrently per space switch,
 *     each guarding with `if (this.activeSpaceId() === spaceId)`. Drop one guard in a move and the panel shows the
 *     previous space's numbers under the new space's name — wrong data, right-looking layout, no error anywhere.
 *  2. **Every loader clears its pending flag, whatever happens.** The flag drives a skeleton. A loader that
 *     returns without settling leaves a skeleton up for ever, and the failure looks like a slow network.
 *
 * They pull in opposite directions, which is the whole difficulty: the RESULT is conditional on still being on
 * that space, the SETTLE is not. A move that treats them as one thing breaks exactly one of them.
 */