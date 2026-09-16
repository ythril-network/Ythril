import { ChangeDetectionStrategy, Component, inject, signal, computed, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ProxySpaceBadgeComponent } from '../../shared/proxy-space-badge.component';
import { BrainStore } from './brain-store.service';
import { EntityRefPicker } from './entity-ref-picker.service';
import { RecordDrawerState } from './record-drawer-state.service';
import { RecordDrawerComponent } from './record-drawer.component';
import { QueryTabComponent } from './query-tab.component';
import { RecordListState } from './record-list-state.service';
import { FactsTabComponent } from './facts-tab.component';
import { EntitiesTabComponent } from './entities-tab.component';
import { EdgesTabComponent } from './edges-tab.component';
import { ChronoTabComponent } from './chrono-tab.component';
import { OverviewTabComponent } from './overview-tab.component';
import { ReviewTabComponent } from './review-tab.component';
import { FormsModule } from '@angular/forms';
import { Space, SpaceStats, AboutInfo, EmbeddingQueue, VoteRound, TokenAccessEntry, CompletenessReport, SpaceActivity } from '../../core/api.types';
import { SpacesApi } from '../../core/spaces-api.service';
import { OverviewDataService } from './overview-data.service';
import { SpaceSettingsPopupComponent } from '../settings/space-settings-popup.component';
import { SpacesStore } from '../settings/spaces-store.service';
import { SpaceSettingsState } from '../settings/space-settings-state.service';
import { BrainApi } from '../../core/brain-api.service';
import { AdminApi } from '../../core/admin-api.service';
import { NetworksApi } from '../../core/networks-api.service';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { GraphComponent } from '../graph/graph.component';
import { FileManagerComponent } from '../files/file-manager.component';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { ErrorStateComponent } from '../../shared/error-state.component';
import { httpErrorReason } from '../../core/http-error';
import { ToastService } from '../../core/toast.service';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';

import { ActivatedRoute, Router } from '@angular/router';
import { BrainTab, CollectionTab, BRAIN_TABS } from './brain-tabs';

interface SpaceView {
  space: Space;
  stats?: SpaceStats;
}

@Component({
  selector: 'app-brain',
  standalone: true,
  // OnPush (P5): the heaviest page in the app — five record tabs and an embedded graph (the detail
  // drawer is now its own OnPush component). Safe because every async path (list/create/save
  // subscribes, the 300 ms search debounces) writes signals, which notify OnPush regardless of zone;
  // nothing mutates a signal's value in place. NOTE the plain (non-signal) form models — `memoryForm`,
  // `editMemory`, … — are rendered via ngModel and are re-checked only because each write is
  // accompanied by a signal write in the same turn (the create callbacks set `creatingX`/`showXForm`)
  // or happens in a template event handler, both of which mark the view dirty. That coupling is
  // load-bearing and pinned by the specs (the drawer's own version lives in the drawer component).
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ProxySpaceBadgeComponent, CommonModule, FormsModule, GraphComponent, FileManagerComponent, PhIconComponent, RecordDrawerComponent, QueryTabComponent, FactsTabComponent, EntitiesTabComponent, EdgesTabComponent, ChronoTabComponent, OverviewTabComponent, ReviewTabComponent, ErrorStateComponent, TranslocoPipe, SpaceSettingsPopupComponent],
  providers: [BrainStore, EntityRefPicker, RecordDrawerState, RecordListState, OverviewDataService, SpacesStore, SpaceSettingsState],
  styles: [`
    .space-tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 24px;
      overflow-x: auto;
      padding-bottom: 4px;
    }

    .space-chip {
      padding: 6px 14px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
      border: 1px solid var(--border);
      background: var(--bg-surface);
      color: var(--text-secondary);
      cursor: pointer;
      transition: all var(--transition);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      min-width: 110px;
      /* A long space name used to render at its full intrinsic width and paint straight over the
         neighbouring chip — measured at 284px of label inside a 144px chip. The strip is a horizontal
         scroller, so the chip must not be allowed to grow without bound, and the label must be told what
         to do when it does not fit. Truncation is the right answer here: the id line underneath and the
         title tooltip both carry the full name. */
      max-width: 200px;
      flex: 0 0 auto;
    }

    /* min-width:0 is load-bearing. A flex item defaults to min-width:auto and refuses to shrink below
       its content, so text-overflow would never engage and the label would overflow exactly as before. */
    .space-chip > * { max-width: 100%; min-width: 0; }

    .space-chip:hover { border-color: var(--accent); color: var(--text-primary); }

    .space-chip.active {
      background: var(--accent-dim);
      border-color: var(--accent);
      color: var(--accent);
    }

    .space-chip-label { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .space-chip-id { font-size: 10px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .space-chip-count {
      font-size: 10px;
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
    }
    .space-chip.active .space-chip-count { color: var(--accent); opacity: 0.8; }

    /* Network-membership indicator (F8): the Networks-menu icon, colour-coded by
       aggregate sync/governance status. No icon at all when the space is in no
       network. */
    .space-chip-net { display: inline-flex; align-items: center; }
    .space-chip-net.net-idle { color: var(--text-muted); }
    .space-chip-net.net-syncing { color: var(--warning); }
    .space-chip-net.net-degraded { color: var(--error); }
    .space-chip-net.net-vote { color: var(--info); }
    @keyframes chip-net-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .space-chip-net.net-syncing, .space-chip-net.net-vote { animation: chip-net-pulse 1.4s ease-in-out infinite; }
    @media (prefers-reduced-motion: reduce) { .space-chip-net { animation: none !important; } }

    .tab-count {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-elevated);
      border-radius: 10px;
      padding: 1px 6px;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      margin-left: 5px;
      min-width: 20px;
      font-variant-numeric: tabular-nums;
    }

    .tab.active .tab-count {
      background: var(--accent-dim);
      color: var(--accent);
    }

    .reindex-banner {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 14px;
      margin-bottom: 12px;
      border: 1px solid var(--warning);
      border-radius: var(--radius-md);
      background: color-mix(in srgb, var(--warning) 6%, transparent);
      font-size: 13px;
      color: var(--text-secondary);
    }

    .tab-spacer { flex: 1; }
    /* The cog. Square rather than label-width, and it never takes the active treatment: it opens a modal,
       so there is no state for "selected" to describe. Without this it inherited .tab's text padding and
       sat as a wide empty button beside Files. */
    .tab-cog {
      padding: 6px 9px;
      flex: 0 0 auto;
      color: var(--text-muted);
    }
    .tab-cog:hover:not(:disabled) { color: var(--text); }
    /* Disabled while no space is selected — the dialog has nothing to edit, and a cog that opens an empty
       modal is worse than one that is visibly unavailable. */
    .tab-cog:disabled { opacity: .4; cursor: not-allowed; }

    /* The active tab's content region. position:relative anchors the floating load spinner so it
       overlays the tab WITHOUT unmounting it (see the storm note in the template). */
    .tab-body { position: relative; min-height: 80px; }
    .loading-overlay--float {
      position: absolute;
      top: 0; left: 0; right: 0;
      z-index: 5;
      background: color-mix(in srgb, var(--bg) 72%, transparent);
      border-radius: 8px;
    }

  `],
  template: `
    @if (loadingSpaces()) {
      <div class="loading-overlay"><span class="spinner"></span> {{ 'brain.loadingSpaces' | transloco }}</div>
    } @else if (spacesError() !== null) {
      <!-- The front door of the product. If this list fails and we fall through to the empty state, a user with a
           full brain is told to create their first space — so the failure gets its own branch, ahead of it. -->
      <app-error-state [message]="'brain.loadSpacesError' | transloco" [reason]="spacesError() ?? ''" (retry)="loadSpaces()" />
    } @else if (spaces().length === 0) {
      <div class="empty-state">
        <div class="empty-state-icon"><ph-icon name="package" [size]="48"/></div>
        <h3>{{ 'brain.emptySpaces.title' | transloco }}</h3>
        <p>{{ 'brain.emptySpaces.body' | transloco }}</p>
      </div>
    } @else {

      <!-- Space selector -->
      <div class="space-tabs">
        @for (sv of spaces(); track sv.space.id) {
          <button
            class="space-chip"
            [class.active]="activeSpaceId() === sv.space.id" [attr.aria-current]="activeSpaceId() === sv.space.id ? 'true' : null"
            [title]="sv.space.label + ' (' + sv.space.id + ')'"
            (click)="selectSpace(sv.space.id)"
          >
            <span class="space-chip-label">{{ sv.space.label }}</span>
            <span class="space-chip-id">{{ sv.space.id }}</span>
            @if (sv.space.proxyFor?.length) {
              <app-proxy-space-badge [proxyFor]="sv.space.proxyFor" [size]="12" />
            }
            @if (sv.space.networkStatus) {
              <span class="space-chip-net" [class]="'net-' + sv.space.networkStatus" [title]="networkChipTitle(sv.space)">
                <ph-icon name="link" [size]="12"/>
              </span>
            }
            @if (sv.stats) {
              <span class="space-chip-count">{{ spaceTotal(sv.stats) }} {{ 'brain.spaceChip.records' | transloco }}</span>
            }
          </button>
        }
      </div>

      <!-- Never offered on a proxy: it has no index of its own and the server refuses it with a 400.
           The outcome is a TOAST, not a line in this banner -- see runReindex(). An inline result had no
           dismiss and was cleared only by switching space, so a message about a finished job sat on screen
           through everything that came after it. -->
      @if (needsReindex() && !activeSpaceIsProxy()) {
        <div class="reindex-banner">
          <span><ph-icon name="warning" [size]="16" style="display:inline-flex;vertical-align:middle;margin-right:4px;"/> {{ 'brain.reindex.stale' | transloco }}</span>
          <button class="btn btn-sm btn-primary" [disabled]="reindexing()" (click)="runReindex()">
            @if (reindexing()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> }
            {{ 'brain.reindex.button' | transloco }}
          </button>
        </div>
      }

      <!-- Sub-tabs: Query on left, collections on right.
           role=tablist / role=tab / aria-selected, matching the pattern review-tab already used. Without
           aria-selected the active tab was conveyed by a CSS class ALONE, so a screen-reader user could not
           tell which of eight views they were on: the state was visible and unannounced. -->
      <div class="tabs" role="tablist" [attr.aria-label]="'brain.tabsAriaLabel' | transloco">
        <button class="tab" type="button" role="tab" [class.active]="activeTab() === 'overview'" [attr.aria-selected]="activeTab() === 'overview'" (click)="setTab('overview')">
          <ph-icon name="chart-bar" [size]="15" style="display:inline-flex;vertical-align:middle;margin-right:4px;"/> {{ 'brain.tab.overview' | transloco }}
        </button>
        <button class="tab" type="button" role="tab" [class.active]="activeTab() === 'query'" [attr.aria-selected]="activeTab() === 'query'" (click)="setTab('query')">
          <ph-icon name="magnifying-glass" [size]="15" style="display:inline-flex;vertical-align:middle;margin-right:4px;"/> {{ 'brain.tab.query' | transloco }}
        </button>
        <button class="tab" type="button" role="tab" [class.active]="activeTab() === 'graph'" [attr.aria-selected]="activeTab() === 'graph'" (click)="setTab('graph')">
          <ph-icon name="graph" [size]="15" style="display:inline-flex;vertical-align:middle;margin-right:4px;"/> {{ 'brain.tab.graph' | transloco }}
        </button>
        <!-- Review (F-REVIEW): duplicate pairs awaiting a decision in this space. Grouped with the
             other whole-space views rather than after Files — it is a workflow, not a record collection. -->
        <button class="tab" type="button" role="tab" [class.active]="activeTab() === 'review'" [attr.aria-selected]="activeTab() === 'review'" (click)="setTab('review')">
          <ph-icon name="copy" [size]="15" style="display:inline-flex;vertical-align:middle;margin-right:4px;"/> {{ 'brain.tab.review' | transloco }}
        </button>
        <span class="tab-spacer"></span>
        @for (tab of collectionTabs; track tab.key) {
          <button class="tab" type="button" role="tab" [class.active]="activeTab() === tab.key" [attr.aria-selected]="activeTab() === tab.key" (click)="setTab(tab.key)">
            <ph-icon [name]="tab.icon" [size]="15" style="display:inline-flex;vertical-align:middle;margin-right:4px;"/> {{ tab.label | transloco }}
            @if (activeStats(); as s) {
              @if (tab.statsKey) {
                <span class="tab-count">{{ s[tab.statsKey] }}</span>
              }
            }
          </button>
        }
        <!-- Files (the former File Meta slot) — the file manager and File Meta merged into one tab: the
             explorer now shows each file's status, tags and folder sizes inline. -->
        <button class="tab" type="button" role="tab" [class.active]="activeTab() === 'files'" [attr.aria-selected]="activeTab() === 'files'" (click)="setTab('files')">
          <ph-icon name="folder" [size]="15" style="display:inline-flex;vertical-align:middle;margin-right:4px;"/> {{ 'brain.tab.files' | transloco }}
          @if (activeStats(); as s) {
            <span class="tab-count">{{ s.files }}</span>
          }
        </button>
        <!-- Space settings, as a cog at the far RIGHT of the strip and deliberately not a tab.
             It opens a modal, so it does not select anything — sitting it between the record tabs would
             make it read as a ninth destination and leave the strip looking wrong when the modal closed
             and nothing was selected. .tab-cog drops the label for the same reason: a "Settings" word
             here competes with the instance-wide Settings page, which is a different scope entirely.
             The label lives in the aria-label and the tooltip, where it names the space scope. -->
        <button class="tab tab-cog" type="button"
          [attr.aria-label]="'brain.tab.spaceSettings' | transloco"
          [attr.title]="'brain.tab.spaceSettingsTitle' | transloco"
          [disabled]="!activeSpace()"
          (click)="openSpaceSettings()">
          <ph-icon name="gear" [size]="15" style="display:inline-flex;vertical-align:middle;"/>
        </button>
      </div>

      <!-- The same dialog the admin spaces table opens, hosted here too. It self-gates on
           settingsSpace(), so this renders nothing until the cog is pressed. (saved) patches the one
           row in THIS page's list: the store the dialog patches is a separate instance here, and the
           sidebar renders from spaces() with per-space stats attached. -->
      @if (spaceSettings.settingsSpace()) {
        @defer (on immediate) {
          <app-space-settings-popup (saved)="onSpaceSaved($event)" />
        } @loading (minimum 200ms) {
          <div class="loading-overlay loading-overlay--float" data-tab-defer="space-settings"><span class="spinner"></span></div>
        }
      }

      <!-- Content. Tabs are gated by activeTab() ONLY — NEVER wrapped in @else of
           @if (recordList.loading()). Each record tab WRITES recordList.loading during its own
           load(); gating the tab's existence on that signal made the tab unmount itself mid-load and
           re-mount on the response, an infinite mount⇄reload storm (one full re-create per response,
           ~5/s, self-sustaining even on 429). The load spinner now floats on top (position:absolute)
           so the active tab instance is never torn down. -->
      <div class="tab-body">
        @if (recordList.loading()) {
          <div class="loading-overlay loading-overlay--float"><span class="spinner"></span></div>
        }

        <!-- Graph + Files carry heavy libraries (cytoscape; the file-manager's markdown/mermaid/xlsx
             renderers). They must MOUNT only while their tab is active — an if-block on activeTab() does
             that (same storm-safe "gate on activeTab() alone" rule as the record tabs), and crucially
             UNMOUNTS them again when you leave, so they can't linger over another tab. A defer block
             alone can't do this: its when-trigger is a one-way load and never removes what it rendered.
             The inner defer (on immediate) still keeps these chunks OUT of the landing bundle — it fires
             the moment the tab first renders, and the browser-cached chunk re-instantiates fast. -->
        @if (activeTab() === 'graph') {
          @defer (on immediate) {
            <app-graph-view [embeddedSpaceId]="activeSpaceId()" [focusEntityId]="graphFocusId() ?? undefined" />
          } @loading (minimum 200ms) {
            <div class="loading-overlay loading-overlay--float" data-tab-defer="graph"><span class="spinner"></span></div>
          }
        }

        <!-- Files tab (merged: file manager + File Meta) -->
        @if (activeTab() === 'files') {
          @defer (on immediate) {
            <app-file-manager [embeddedSpaceId]="activeSpaceId()" (filesChanged)="loadStats(activeSpaceId())" />
          } @loading (minimum 200ms) {
            <div class="loading-overlay loading-overlay--float" data-tab-defer="files"><span class="spinner"></span></div>
          }
        }

        <!-- Memories -->
        @if (activeTab() === 'facts') { <app-facts-tab [spaceId]="activeSpaceId()" (mutated)="loadStats(activeSpaceId())" /> }

        <!-- Entities -->
        @if (activeTab() === 'entities') { <app-entities-tab [spaceId]="activeSpaceId()" (mutated)="loadStats(activeSpaceId())" (viewInGraph)="viewInGraph($event)" /> }

        <!-- Edges -->
        @if (activeTab() === 'edges') { <app-edges-tab [spaceId]="activeSpaceId()" (mutated)="loadStats(activeSpaceId())" (viewInGraph)="viewInGraph($event)" /> }

        <!-- Chrono -->
        @if (activeTab() === 'chrono') { <app-chrono-tab [spaceId]="activeSpaceId()" /> }

        <!-- Query -->
        @if (activeTab() === 'overview') {
          @if (activeSpace(); as sp) {
            <app-overview-tab [space]="sp" [stats]="activeStats()" [needsReindex]="needsReindex()"
              [reindexing]="reindexing()" [about]="aboutInfo()" [embeddingQueue]="ov.embeddingQueue()"
              [openVotes]="ov.overviewVotes()" [tokenAccess]="ov.tokenAccess()" [completeness]="ov.completeness()" [activity]="ov.spaceActivity()"
              [pending]="ov.overviewPending()"
              (reindex)="runReindex()" (retryFailed)="runRetryFailedEmbeddings()"
              (openTab)="setTab($event)"
              [resettingUsage]="resettingUsage()" [usageResetResult]="usageResetResult()"
              (resetUsage)="resetSpaceUsage()" />
          }
        }
        @if (activeTab() === 'query') { <app-query-tab [spaceId]="activeSpaceId()" (viewInGraph)="viewInGraph($event)" /> }

        <!-- Review (F-REVIEW): duplicate pairs for THIS space. Was a global Settings page; a duplicate
             pair only ever means something inside one space, so it belongs beside the space's data. -->
        @if (activeTab() === 'review') { <app-review-tab [spaceId]="activeSpaceId()" (openTab)="setTab($event)" /> }
      </div>

      <!-- Detail Drawer -->
      <app-record-drawer />
    }
  `,
})
export class BrainComponent implements OnInit, OnDestroy {
  readonly store = inject(BrainStore);
  readonly picker = inject(EntityRefPicker);
  readonly drawerState = inject(RecordDrawerState);
  readonly recordList = inject(RecordListState);
  private spacesApi = inject(SpacesApi);
  /** The Overview panel's data, moved out of this shell — see overview-data.service.ts. */
  readonly ov = inject(OverviewDataService);
  /**
   * The dialog's state, provided by this component so it opens and closes with the page.
   *
   * Public because the template reads `settingsSpace()` to decide whether the dialog's code should be
   * fetched at all — see the `@defer` around it. The dialog carries the schema editor, the duplicate rules
   * and the danger zone, and this is already the heaviest page in the app; loading all of that on the
   * chance someone presses the cog took `spaces-component` off the bundle-budget list entirely, because
   * the shared code had moved out of it. It now arrives when the cog is pressed and not before.
   */
  readonly spaceSettings = inject(SpaceSettingsState);
  private brainApi = inject(BrainApi);
  private adminApi = inject(AdminApi);
  private networksApi = inject(NetworksApi);
  private transloco = inject(TranslocoService);
  /** Transient outcomes go through the app's one toast channel — see runReindex() for why not inline. */
  private toast = inject(ToastService);

  // File Meta merged into the Files tab (rendered separately, after these, in the same group).
  /**
   * The record-collection tabs.
   *
   * `label` is an i18n KEY now, not a literal. These four were the only tabs in the strip rendering a
   * hard-coded English string — the translations existed the whole time and were simply never used, so
   * the strip read half-German in a German UI and nothing flagged it.
   *
   * `icon` likewise: Overview, Query, Graph, Review and Files each carried one and these four did not,
   * leaving a strip where some tabs have an icon and some do not. The icons match the Overview tiles
   * that link here, because the tiles and the tabs are the same five things.
   */
  collectionTabs: { key: BrainTab; label: string; icon: string; statsKey?: keyof SpaceStats }[] = [
    { key: 'entities', label: 'brain.tab.entities', icon: 'stack', statsKey: 'entities' },
    // `link` and not `graph`: the Graph tab already owns that glyph, and two different tabs wearing the
    // same icon in one strip is worse than a slightly less literal one.
    { key: 'edges', label: 'brain.tab.edges', icon: 'link', statsKey: 'edges' },
    { key: 'facts', label: 'brain.tab.facts', icon: 'brain', statsKey: 'facts' },
    { key: 'chrono', label: 'brain.tab.chrono', icon: 'timer', statsKey: 'chrono' },
  ];

  readonly pageSize = 20;

  spaces = signal<SpaceView[]>([]);
  activeSpaceId = signal('');
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  activeTab = signal<BrainTab>('overview');

  /**
   * The entity the Graph tab should open rooted at, set by a record table's "view in graph" button and
   * consumed by the graph on mount. Null means "the graph opens as it always did, with no root".
   */
  graphFocusId = signal<string | null>(null);
  loadingSpaces = signal(true);
  /** Null until the space list failed to load — checked before the empty state, so a failure never reads as "no spaces". */
  spacesError = signal<string | null>(null);
  /** Instance identity/health for the Overview's Instance panel — fetched once (instance-wide, not per space). */
  aboutInfo = signal<AboutInfo | null>(null);



  // Reindex
  needsReindex = signal(false);
  reindexing = signal(false);

  // Entity picker

  activeStats = computed(() =>
    this.spaces().find(sv => sv.space.id === this.activeSpaceId())?.stats,
  );

  /** The active space object (for the Overview tab's index-status + quota panels). */
  activeSpace = computed(() =>
    this.spaces().find(sv => sv.space.id === this.activeSpaceId())?.space,
  );

  /**
   * Open the space settings dialog on the space already selected here.
   *
   * No request: this page's list already holds the full `Space` record, which is the whole reason the cog
   * can live here at all. Reaching the same editor previously meant leaving the Brain, finding the row in
   * the admin table, and coming back — three navigations to change the label of a space that was already
   * on screen.
   */
  openSpaceSettings(): void {
    const space = this.activeSpace();
    if (space) this.spaceSettings.openSettings(space);
  }

  /**
   * Patch the one row this page renders from, after a save the dialog APPLIED.
   *
   * The dialog patches `SpacesStore`, but that instance is provided per host — the one here is empty and
   * nothing reads it. Refetching the list instead would also discard the per-space stats hanging off each
   * row, which cost one request each. So the record is merged in place and the stats are left alone: a
   * label or quota edit does not change any count.
   */
  onSpaceSaved(space: Space): void {
    this.spaces.update(list => list.map(sv => sv.space.id === space.id ? { ...sv, space } : sv));
  }

  spaceTotal(stats: SpaceStats): number {
    return stats.facts + stats.entities + stats.edges + stats.chrono + stats.files;
  }

  /** Tooltip for the space-chip network indicator (F8): the network name(s) plus
   *  the human-readable status. Colour alone must not carry the meaning (a11y). */
  networkChipTitle(space: Space): string {
    const status = space.networkStatus ?? 'idle';
    const names = (space.networks ?? []).map(n => n.label).join(', ');
    const statusText = this.transloco.translate(`brain.spaceChip.network.${status}`);
    const prefix = this.transloco.translate('brain.spaceChip.network.prefix');
    return names ? `${prefix}: ${names} — ${statusText}` : statusText;
  }

  ngOnInit(): void {
    this.loadSpaces();
    // Instance identity/health. The Overview no longer shows it (owner, 2026-08-08 — it belongs to About),
    // but the fetch stays: `aboutInfo` still feeds other consumers, and it is one best-effort call.
    this.adminApi.getAbout().subscribe({
      next: a => this.aboutInfo.set(a),
      error: () => { /* best-effort; no panel depends on it here any more */ },
    });
  }

  /** Public so the error state's Retry can re-run it without a page reload. */
  loadSpaces(): void {
    this.loadingSpaces.set(true);
    this.spacesError.set(null);
    this.spacesApi.listSpaces().subscribe({
      next: ({ spaces }) => {
        this.spaces.set(spaces.map(s => ({ space: s })));
        this.loadingSpaces.set(false);
        if (spaces.length > 0) {
          this.applyUrlState(spaces);
          // Pre-load stats for all other spaces so counts show on their chips
          spaces.slice(1).forEach(s => this.loadStats(s.id));
        }
      },
      error: (err) => { this.spacesError.set(httpErrorReason(err)); this.loadingSpaces.set(false); },
    });
  }

  ngOnDestroy(): void {
    this.closeLiveStream();
    clearTimeout(this.liveRefreshTimer);
  }

  // ── Live updates (F12) ──────────────────────────────────────────────────────
  private liveStream?: EventSource;
  private liveRefreshTimer?: ReturnType<typeof setTimeout>;
  private liveReconnectTimer?: ReturnType<typeof setTimeout>;
  private static readonly LIVE_RECONNECT_MS = 3000;
  private static readonly TAB_FOR_COLLECTION: Record<string, CollectionTab> = {
    fact: 'facts', entity: 'entities', edge: 'edges', chrono: 'chrono', file: 'files',
  };

  /** (Re)open the live-change SSE stream for a space. EventSource can't send an Authorization header, and
   *  a raw token in the URL leaks into logs/history/Referer, so we mint a single-use `?ticket=` first. */
  private openLiveStream(spaceId: string): void {
    this.closeLiveStream();
    if (typeof EventSource === 'undefined') return; // non-browser (SSR/test) environment
    if (!spaceId) return;
    this.connectLiveStream(spaceId);
  }

  /** Mint a ticket, then open the stream. Because the ticket is single-use, the browser's native
   *  auto-reconnect (which would replay the now-dead ticket) is useless — so on error we close and
   *  reconnect ourselves with a FRESH ticket after a fixed backoff, and only while this space is still
   *  active. The backoff + active-space guard keep a persistently-failing stream to ~1 attempt / 3s
   *  (never a request storm) and stop it entirely once the user navigates away. */
  private connectLiveStream(spaceId: string): void {
    if (spaceId !== this.activeSpaceId()) return; // space switched (or torn down) before we got here
    this.brainApi.mintEventsTicket(spaceId).subscribe({
      next: ({ ticket }) => {
        if (spaceId !== this.activeSpaceId()) return; // switched while minting — drop this ticket
        const url = `/api/brain/spaces/${encodeURIComponent(spaceId)}/events?ticket=${encodeURIComponent(ticket)}`;
        const es = new EventSource(url);
        es.onmessage = (e) => {
          let payload: { event?: string };
          try { payload = JSON.parse(e.data); } catch { return; }
          this.onLiveEvent(spaceId, payload.event ?? '');
        };
        es.onerror = () => {
          es.close();
          if (this.liveStream === es) this.liveStream = undefined;
          clearTimeout(this.liveReconnectTimer);
          this.liveReconnectTimer = setTimeout(() => this.connectLiveStream(spaceId), BrainComponent.LIVE_RECONNECT_MS);
        };
        this.liveStream = es;
      },
      // Mint failed (auth / rate limit / offline): stay closed — the next space switch retries. Not
      // retried on a timer here to avoid hammering the mint endpoint when auth is genuinely broken.
      error: () => { /* no-op */ },
    });
  }

  private closeLiveStream(): void {
    clearTimeout(this.liveReconnectTimer);
    this.liveStream?.close();
    this.liveStream = undefined;
  }

  /** Debounced refresh: any change updates the count badges; a change to the ACTIVE tab's collection
   *  (or any bulk write) also reloads its current page via the store tick. */
  private onLiveEvent(spaceId: string, event: string): void {
    if (spaceId !== this.activeSpaceId()) return;
    clearTimeout(this.liveRefreshTimer);
    this.liveRefreshTimer = setTimeout(() => {
      this.loadStats(spaceId);
      this.ov.loadEmbeddingQueue(spaceId, () => this.activeSpaceId() === spaceId); // file/embed events change the queue
      const collection = event.split('.')[0] ?? '';
      if (event.startsWith('bulk') || BrainComponent.TAB_FOR_COLLECTION[collection] === this.activeTab()) {
        this.store.liveRefreshTick.update(t => t + 1);
      }
    }, 250);
  }

  selectSpace(id: string): void {
    // Switching space lands on the new space's OVERVIEW — its landing view (F9). The tab used to
    // persist across the switch, so picking another space while on, say, Entities just swapped the
    // rows underneath you: the page looked unchanged until you clicked a tab, and the space you had
    // chosen never introduced itself. Re-clicking the chip of the space you are ALREADY on is not a
    // switch, so that leaves your current tab alone.
    if (this.activeSpaceId() !== id) this.activeTab.set('overview');
    this.activeSpaceId.set(id);
    this.picker.spaceId.set(id);
    this.drawerState.spaceId.set(id);
    this.openLiveStream(id);
    this.store.memorySearch.set('');
    this.store.edgeSearch.set('');
    this.store.chronoSearch.set('');
    this.recordList.confirmDeleteId.set('');
    this.ov.blankForSpaceSwitch();
    this.loadStats(id);
    this.loadSpaceMeta(id);
    this.ov.loadAll(id, () => this.activeSpaceId() === id, this.spaces().find(sv => sv.space.id === id)?.space.networks ?? []);
    /*
     * The selected space is deliberately NOT written to the URL. Owner, 2026-08-30: *"dont use the url please
     * — i use ythril iframed a lot"*, and a page that rewrites its own address inside somebody else's frame
     * is doing something the host did not ask for.
     *
     * That is why the fix for the space-resetting bug lives in `applyQueryParams` instead: an absent
     * `?space=` is read as "no preference" rather than as "go to the first space". Writing the parameter
     * would have fixed the same bug and is the obvious move — do not reintroduce it.
     */
  }






  /**
   * Deep-link state: which space and which tab, read from the URL.
   *
   * The Overview's data-model panel links a type's record count straight to the filtered entities tab, so
   * that link has to be a real URL rather than a signal handed between two components — right-click, open in
   * a new tab, bookmark and back/forward all follow for free, and neither component learns about the other.
   * The Graph page already deep-links the same way with `?space=` and `?entity=`.
   *
   * Read once from the snapshot rather than subscribed: a later in-page navigation is this component
   * WRITING the URL, and re-reading its own write would fight `setTab`.
   */
  private applyUrlState(spaces: { id: string }[]): void {
    this.applyQueryParams(spaces);
    /**
     * ...and keep applying it, because a link INTO this page from a component already on it is a query-param
     * change and nothing else.
     *
     * The data-model panel's record count is such a link. Read-once meant clicking it rewrote the URL —
     * `?tab=entities&type=x` — and changed nothing on screen: reported as *"clicking the number does not jump
     * to the correct tab. it just appends a route to the url"*. Exactly right, and the URL being correct while
     * the page ignored it is the worst version of the bug, because the address bar says it worked.
     *
     * The original comment feared re-reading our own writes fighting `setTab`. That fear is answered by
     * applying only DIFFERENCES rather than by not subscribing: when this component writes `tab=x` it has
     * already set `activeTab` to x, so the incoming value equals current state and the handler does nothing.
     * Idempotence, not abstinence — and it cannot loop, because a no-op writes no URL.
     */
    this.route.queryParamMap.subscribe(() => this.applyQueryParams(spaces));
  }

  /**
   * The last `?space=` this handler acted on, so a value it has already honoured stops being authoritative.
   *
   * `undefined` before the first emission, and it deliberately also records an ABSENT parameter — otherwise
   * a link that removes `?space=` would look unchanged forever after one that set it.
   */
  private lastAppliedSpaceParam: string | undefined = undefined;

  /** Apply `?space=` / `?tab=` if — and only if — they differ from what is on screen. */
  private applyQueryParams(spaces: { id: string }[]): void {
    const qp = this.route.snapshot.queryParamMap;
    const wanted = qp.get('space') ?? undefined;
    /*
     * An ABSENT `?space=` means "no preference", not "go to the first space" — and reading it the second way
     * is what made every tab click on any space but the first snap back to that first space.
     *
     * The sequence, reported 2026-08-30: `setTab` navigates to record the tab, the navigation re-emits
     * `queryParamMap`, this handler reads no `?space=`, falls back to `spaces[0]`, and calls `selectSpace` —
     * which also resets the tab to Overview, because a changed space is a switch. The user's own workaround
     * fits exactly: the second click writes the same `?tab=`, no query-param change is emitted, and this
     * never runs.
     *
     * The fallback is still right for the FIRST pass, when nothing is selected yet. It is only wrong
     * afterwards, so it is now conditioned on that.
     */
    /*
     * A PRESENT `?space=` is honoured only when it CHANGED, and that is the other half of the same bug.
     *
     * The premise this file, its commit and the CHANGELOG all carried — that nothing ever writes `?space=` —
     * was false. `er-model-panel.component.ts` writes it on the knowledge-type count links, which is the very
     * control the report named. So it goes stale the moment the user picks a different space by chip (the
     * screen changes, the URL deliberately does not), and `writeTabToUrl` merges it forward on every
     * subsequent tab click. Read as authoritative each time, it threw the page back exactly as the absent
     * case did.
     *
     * Honouring it only on the FIRST pass would have been the smaller change and would have broken those
     * count links: they navigate to `/brain` from INSIDE `/brain`, so there is no remount and no first pass.
     * "Changed" covers both — a fresh link moves the page, a merge-preserved value does not.
     */
    const current = this.activeSpaceId();
    const fresh = wanted !== this.lastAppliedSpaceParam;
    this.lastAppliedSpaceParam = wanted;
    const known = fresh && wanted && spaces.some(s => s.id === wanted) ? wanted : undefined;
    const initial = known ?? (current || spaces[0]!.id);
    // Only when it CHANGES: selectSpace reloads the space's data, so calling it on every query-param event
    // would refetch on each tab switch this component itself performs.
    if (initial !== current) this.selectSpace(initial);

    // Only a tab that exists. An unknown value in a hand-edited URL must land on the default rather than a
    // blank pane, and `BRAIN_TABS` is the same list the strip renders from.
    const tab = (qp.get('tab') ?? undefined) as BrainTab | undefined;
    if (tab && tab !== this.activeTab() && (BRAIN_TABS as readonly string[]).includes(tab)) this.activeTab.set(tab);
  }

  /**
   * Keep the URL saying which tab is open, so it can be linked to and survives a reload.
   *
   * `replaceUrl` — a tab switch is not a place someone wants to return to with Back; it would take them
   * through every tab they had touched. `queryParamsHandling: 'merge'` preserves `?type=`, which the
   * entities tab reads.
   */
  private writeTabToUrl(tab: BrainTab): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  setTab(tab: BrainTab): void {
    // Clearing the pending graph focus here (rather than only when leaving the Graph tab) is what stops
    // it becoming sticky: the Graph tab UNMOUNTS on leave and re-reads the input on every remount, so a
    // focus left in place would silently re-root the graph the next time the tab is opened by hand.
    // `viewInGraph()` sets it AFTER calling this, which is why the order there matters.
    this.graphFocusId.set(null);
    this.activeTab.set(tab);
    this.store.memorySearch.set('');
    this.store.edgeSearch.set('');
    this.store.chronoSearch.set('');
    this.store.fileMetaSearch.set('');
    this.recordList.confirmDeleteId.set('');
    this.writeTabToUrl(tab);
  }

  /**
   * A record table's "view in graph" action: open the Graph tab rooted at that entity.
   *
   * The id goes into a signal on the SHELL rather than into the graph component, because the graph is
   * behind `@if (activeTab() === 'graph')` and does not exist yet at the moment the button is clicked.
   * Setting it after `setTab` is deliberate — `setTab` clears it (see above).
   */
  viewInGraph(entityId: string): void {
    this.setTab('graph');
    this.graphFocusId.set(entityId);
  }

  loadStats(spaceId: string): void {
    this.spacesApi.getSpaceStats(spaceId).subscribe({
      next: (stats) => {
        this.spaces.update(list =>
          list.map(sv => sv.space.id === spaceId ? { ...sv, stats } : sv),
        );
      },
      // No pending flag to clear since the statistics strip went: stats still load (other views read them),
      // they just no longer drive a skeleton on this tab.
      error: () => { /* stats are best-effort here; no Overview panel blanks on them */ },
    });
    this.spacesApi.getReindexStatus(spaceId).subscribe({
      next: ({ needsReindex }) => this.needsReindex.set(needsReindex),
      error: () => {},
    });
  }

  requestDelete(id: string): void { this.recordList.confirmDeleteId.set(id); }
  cancelDelete(): void { this.recordList.confirmDeleteId.set(''); }


  /** Set while the usage reset is in flight, so the panel can disable its own button. */
  resettingUsage = signal(false);
  /** The cleared-bucket count from the last reset, reported inline the way runReindex reports its result. */
  usageResetResult = signal('');

  /**
   * Clear this space's recorded usage. The PANEL confirmed already — it owns the dialog, the same way it does
   * for reindex and retry-failed — so this performs the request and reloads.
   *
   * Reloaded rather than zeroed locally: a local zero would be a guess about what the server did, and the count
   * in the response exists precisely because a reset and a genuinely idle space look identical afterwards.
   */
  resetSpaceUsage(): void {
    const spaceId = this.activeSpaceId();
    if (!spaceId || this.resettingUsage()) return;
    this.resettingUsage.set(true);
    this.usageResetResult.set('');
    this.spacesApi.resetSpaceActivity(spaceId).subscribe({
      next: ({ cleared }) => {
        this.resettingUsage.set(false);
        this.usageResetResult.set(`Cleared ${cleared} usage buckets.`);
        this.ov.loadSpaceActivity(spaceId, () => this.activeSpaceId() === spaceId);
      },
      error: () => {
        this.resettingUsage.set(false);
        this.usageResetResult.set('Usage reset failed — check server logs.');
      },
    });
  }

  /** A proxy holds no records of its own, so it has no index — and the server refuses to reindex one. */
  activeSpaceIsProxy = (): boolean => (this.activeSpace()?.proxyFor?.length ?? 0) > 0;

  /**
   * Start a reindex and say that it STARTED.
   *
   * ## The report this rewrites
   *
   * Owner, 2026-08-15: *"on clicking reindex on overview it sais reindexed 0 documents in green as if it
   * worked on an unclosable inline message."*
   *
   * The route never awaits the job — `startReindex` schedules the work and both surfaces answer immediately
   * with ZEROED counters, deliberately, so the HTTP call does not hang for the length of a re-embed. This
   * method summed those zeros and printed "Reindexed 0 documents." So the acknowledgement of a job that had
   * just been scheduled was rendered as its result, in green, at the moment it began.
   *
   * There is no count to print here and there never was. Progress lives in `reindex-status` and the log,
   * which is where the panel's own indicator reads it from.
   *
   * A toast rather than an inline banner, for the reason the report gives: the inline one had no dismiss and
   * was cleared only by switching space, so a note about a finished job outlived everything after it.
   */
  runReindex(): void {
    this.reindexing.set(true);
    this.spacesApi.reindex(this.activeSpaceId()).subscribe({
      next: () => {
        this.reindexing.set(false);
        this.toast.info(this.transloco.translate('brain.reindex.started'));
        // The stale-index banner is NOT cleared here. It was, optimistically — and the index really is
        // still stale, because the job has only just been scheduled. `loadStats` re-reads the true state
        // from `reindex-status` a moment later and would put the banner straight back, so the optimism
        // bought a flicker and a false claim. The toast is what says the work has begun.
        this.loadStats(this.activeSpaceId());
      },
      error: (err) => {
        this.reindexing.set(false);
        // The server's own words when it has them: a proxy refusal names the member spaces to reindex
        // instead, and "check server logs" would send the reader to the one place that does not say it.
        this.toast.error(err?.error?.error ?? this.transloco.translate('brain.reindex.failed'));
      },
    });
  }

  /** Re-queue every failed embedding job for the active space, then refresh the queue panel. */
  runRetryFailedEmbeddings(): void {
    const spaceId = this.activeSpaceId();
    this.brainApi.retryFailedEmbeddings(spaceId).subscribe({
      next: () => { if (this.activeSpaceId() === spaceId) this.ov.loadEmbeddingQueue(spaceId, () => this.activeSpaceId() === spaceId); },
      error: () => {},
    });
  }

  // ── Space meta (schema, loaded for property prefill) ────────────────────

  loadSpaceMeta(spaceId: string): void {
    if (!spaceId) return;
    this.spacesApi.getSpaceMeta(spaceId).subscribe({
      next: (meta) => this.store.spaceMeta.set(meta),
      error: () => this.store.spaceMeta.set(null),
    });
  }

  // ── Form openers with schema prefill ────────────────────────────────────

}

