import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  AfterViewInit,
  OnDestroy,
  Input,
  inject,
  signal,
  computed,
  effect,
  viewChild,
  ElementRef,
} from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { ProxySpaceBadgeComponent } from '../../shared/proxy-space-badge.component';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Subscription, forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { ErrorStateComponent } from '../../shared/error-state.component';
import { httpErrorReason } from '../../core/http-error';
import {
  Space,
  Entity,
  Fact,
  ChronoEntry,
  Edge,
  TraverseNode,
  TraverseEdge,
  TraverseResult,
  KnowledgeType,
} from '../../core/api.types';
import { SpacesApi } from '../../core/spaces-api.service';
import { BrainApi } from '../../core/brain-api.service';
import { AuthApi } from '../../core/auth-api.service';
import { EntryPopupComponent } from '../../shared/entry-popup.component';
import { EntitySearchComponent } from '../../shared/entity-search.component';
import { PropertiesViewComponent } from '../../shared/properties-view.component';
import { GraphLinkedRecordsComponent } from './graph-linked-records.component';
import { GraphNodeRecordCardComponent, GraphEdgeRecordCardComponent } from './graph-record-card.component';
import { GraphPanelHeaderComponent } from './graph-panel-header.component';
import { GraphToolbarComponent } from './graph-toolbar.component';
import { TranslocoPipe } from '@jsverse/transloco';
// The record drawer and its state are shared with the Brain page rather than forked here: this page
// used to carry a copy that had drifted behind (no schema-driven properties, no confidence field, no
// tag suggestions, and its own retired entity-picker flyout).
import { RecordDrawerComponent } from '../brain/record-drawer.component';
import { RecordDrawerState } from '../brain/record-drawer-state.service';
import { BrainStore } from '../brain/brain-store.service';
import { EntityRefPicker } from '../brain/entity-ref-picker.service';
import {
  DetailRow, DetailRef, buildDetailRows, filterAndSortDetails,
} from './graph-details';
import {
  TraversalCache, emptyCache, decideFetch, applyResult, filterToDepth,
} from './graph-traversal-cache';
import {
  GraphTheme, DEFAULT_GRAPH_THEME, readGraphTheme, typeColor,
  buildElements, createGraphCytoscape, renderElements, type GraphInstance,
} from './graph-cytoscape';
import { GRAPH_STYLES } from './graph.styles';
import { canWriteAnywhere } from '../../core/token-capability';
import { lookupForNode, lookupForEdge } from './graph-record-lookup';



@Component({
  selector: 'app-graph-view',
  standalone: true,
  // OnPush (P5, final slice): the highest-value target — a cytoscape canvas whose 9 event handlers
  // fire OUTSIDE Angular. Audited safe: the four handlers that touch Angular state
  // (node/edge/background tap, dbltap re-root) write only signals (`selectedNode`/`selectedEdge`/…),
  // and signal writes notify OnPush regardless of zone; the other five only toggle cytoscape CSS
  // classes on the canvas, never Angular state. Nothing mutates a signal's value in place, and the
  // plain `graphNodes`/`graphEdges`/color fields are canvas-only (never in the template). The one
  // pair of template-bound plain fields — `drawerEditMemory`/`drawerEditChrono` — is written in
  // `openBrainDrawer` alongside the `drawerRecord` signal that guards the drawer's `@if`, the same
  // load-bearing coupling pinned by the brain spec.
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ProxySpaceBadgeComponent, CommonModule, FormsModule, EntryPopupComponent, EntitySearchComponent, PropertiesViewComponent, PhIconComponent, ErrorStateComponent, TranslocoPipe, RecordDrawerComponent, GraphLinkedRecordsComponent, GraphNodeRecordCardComponent, GraphEdgeRecordCardComponent, GraphPanelHeaderComponent, GraphToolbarComponent],
  // Its own drawer collaborators, so the standalone `/graph` route works with nothing above it. When
  // this page is embedded as Brain's Graph tab these SHADOW Brain's instances, which is deliberate:
  // the drawer then patches this page's per-node lists, exactly as the forked drawer did. The cost is
  // one extra space-meta fetch while embedded.
  providers: [BrainStore, EntityRefPicker, RecordDrawerState],
  host: { '[class.embedded]': 'isEmbedded()' },
  styles: [GRAPH_STYLES],
  template: `
    <!-- ═══ Space selector ══════════════════════════════════════════════════ -->
    @if (!isEmbedded() && spaces().length > 0) {
      <div class="space-tabs">
        @for (s of spaces(); track s.id) {
          <button class="space-chip" type="button" [class.active]="activeSpaceId() === s.id" [attr.aria-current]="activeSpaceId() === s.id ? 'true' : null" (click)="onSpaceChange(s.id)">{{ s.label }}@if (s.proxyFor?.length) { <app-proxy-space-badge [proxyFor]="s.proxyFor" [size]="12" /> }</button>
        }
      </div>
    }

    <app-graph-toolbar
      [spaceId]="activeSpaceId()"
      [stats]="rootEntity() ? { nodes: nodeCount(), edges: edgeCount() } : null"
      [depth]="depth()"
      [direction]="direction()"
      [hideLabels]="hideLabels()"
      (depthChange)="onDepthChange($event)"
      (directionChange)="setDirection($event)"
      (hideLabelsChange)="onHideLabelsChange($event)"
      (rootSelected)="selectRoot($event)"
      (queryChange)="onSearchQueryChange($event)"
      (fit)="fitGraph()"
      (reset)="resetGraph()" />

    <!-- ═══ Canvas row (canvas + optional side panel) ══════════════════════ -->
    <div class="canvas-row">

      <!-- ── Canvas zone ────────────────────────────────────────────────── -->
      <div class="canvas-zone">
        @if (truncated()) {
          <div class="truncation-banner">
            {{ 'graph.truncated' | transloco }}
            <button (click)="truncated.set(false)"><ph-icon name="x" [size]="14"/></button>
          </div>
        }

        @if (loading()) {
          <div class="loading-overlay"><div class="loading-spinner"></div></div>
        }

        @if (loadError() !== null && !loading()) {
          <div class="canvas-empty">
            <app-error-state [message]="'graph.error.load' | transloco" [reason]="loadError() ?? ''" (retry)="retryTraverse()" />
          </div>
        } @else if (!rootEntity() && !loading()) {
          <div class="canvas-empty">
            <div class="empty-icon"><ph-icon name="circle-dashed" [size]="52"/></div>
            <h3>{{ 'graph.empty.title' | transloco }}</h3>
            <p>{{ 'graph.empty.subtitle' | transloco }}</p>
          </div>
        }

        <div #cyContainer class="cy-container" [style.visibility]="rootEntity() ? 'visible' : 'hidden'"></div>
      </div>

      <!-- ── Side panel (node selected) ────────────────────────────────── -->
      @if (selectedNode()) {
        <div class="side-panel">
          <app-graph-panel-header
            [color]="panelColor()"
            [title]="panelTitle()"
            [badge]="selectedNode()!.type || 'entity'"
            (view)="openEntityPopup(selectedNode()!)"
            (close)="selectedNode.set(null)" />
          <div class="side-panel-body">

            <!-- Record card. Its 57 lines are now app-graph-node-record-card — same DOM, same classes, and
                 the styles moved with them, because a parent's styles do not reach a child's template. -->
            <app-graph-node-record-card
              [record]="selectedEntityRecord()"
              [kind]="selectedNode()!.kind ?? null"
              [unavailable]="recordUnavailable()" />

            <!-- Lists pane: facts + chrono -->
            <app-graph-linked-records
              [facts]="filteredMemories()"
              [chrono]="filteredChrono()"
              [(typeFilter)]="detailTypeFilter"
              [(descFilter)]="detailDescFilter"
              [emptyMemoriesKey]="detailFilterActive() ? 'graph.panel.noMatches' : 'graph.panel.noMemories'"
              [emptyChronoKey]="detailFilterActive() ? 'graph.panel.noMatches' : 'graph.panel.noChronoEntries'"
              (open)="openDetailPopup($event)" />

          </div>
        </div>
      }

      <!-- ── Side panel (edge selected) ────────────────────────────────── -->
      @if (selectedEdge()) {
        <div class="side-panel">
          <app-graph-panel-header
            [color]="panelColor()"
            [title]="panelTitle()"
            [badge]="'graph.drawer.badge.edge' | transloco"
            [canView]="!!selectedEdgeRecord()"
            (view)="popupRecord.set(asRecord(selectedEdgeRecord()!)); popupType.set('edge')"
            (close)="selectedEdge.set(null); selectedEdgeRecord.set(null)" />
          <div class="side-panel-body">

            <!-- Edge record card. A SECOND component rather than a mode of the node one: it has weight,
                 endpoint rows with a fallback, a different first label, and no unavailable branch. -->
            <app-graph-edge-record-card
              [record]="selectedEdgeRecord()"
              [selected]="selectedEdge()"
              [unavailable]="recordUnavailable()" />

            <!-- Lists pane: facts + chrono for both endpoints -->
            <app-graph-linked-records
              [facts]="filteredMemories()"
              [chrono]="filteredChrono()"
              [(typeFilter)]="detailTypeFilter"
              [(descFilter)]="detailDescFilter"
              [emptyMemoriesKey]="detailFilterActive() ? 'graph.panel.noMatches' : 'graph.panel.noLinkedMemories'"
              [emptyChronoKey]="detailFilterActive() ? 'graph.panel.noMatches' : 'graph.panel.noLinkedChrono'"
              (open)="openDetailPopup($event)" />

          </div>
        </div>
      }

    </div><!-- /canvas-row -->

    <!-- ═══ Entry popup (entity / edge) ═══════════════════════════════════ -->
    @if (popupRecord()) {
      <app-entry-popup
        [record]="popupRecord()"
        [recordType]="popupType()"
        [spaceId]="activeSpaceId()"
        [canEdit]="canEdit()"
        (closed)="closePopup()"
        (saved)="onPopupSaved($event)"
      />
    }

    <!-- Record drawer (memory / chrono) - the shared brain drawer, not a copy -->
    <app-record-drawer />
  `,
})
export class GraphComponent implements OnInit, AfterViewInit, OnDestroy {
  // ── DI ──────────────────────────────────────────────────────────────────────
  private spacesApi = inject(SpacesApi);
  private brainApi = inject(BrainApi);
  private authApi = inject(AuthApi);
  private location = inject(Location);
  private route = inject(ActivatedRoute);
  private store = inject(BrainStore);
  private picker = inject(EntityRefPicker);
  protected drawerState = inject(RecordDrawerState);

  constructor() {
    // One propagation point for the three places `activeSpaceId` is written (the embedded @Input
    // setter, the initial route read, and the space picker). An effect rather than three call sites
    // so a fourth writer added later cannot forget to feed the drawer — that failure mode is silent:
    // the drawer opens and saves into the empty space id.
    effect(() => {
      const id = this.activeSpaceId();
      this.drawerState.spaceId.set(id);
      this.picker.spaceId.set(id);
      this.loadSpaceMeta(id);
    });

    // Clear the panel filters whenever the selection changes. Tied to the selection rather than added
    // to the three places that clear the lists, because a fourth path added later would silently skip
    // it — and the symptom is nasty: filter one node, click another, and its panel reads as "no
    // memories" while the filter that hid them sits several rows up, unmentioned.
    effect(() => {
      this.selectedNode();
      this.selectedEdge();
      this.detailTypeFilter.set('all');
      this.detailDescFilter.set('');
    });

    // The drawer patches the `BrainStore` lists, which this page does not render. Its per-node arrays
    // are its own, so without this a save would succeed and leave the stale row on screen underneath.
    effect(() => {
      const saved = this.drawerState.lastSaved();
      if (!saved) return;
      // Read `saved.record` inside each branch, not once above: the discriminant only narrows the
      // record while it is still reached through `saved`.
      if (saved.kind === 'fact') {
        const rec = saved.record;
        this.nodeMemories.update(list => list.map(m => m._id === rec._id ? rec : m));
      } else if (saved.kind === 'chrono') {
        const rec = saved.record;
        this.nodeChrono.update(list => list.map(c => c._id === rec._id ? rec : c));
      }
    });
  }

  // ── Element refs ────────────────────────────────────────────────────────────
  cyContainer = viewChild<ElementRef<HTMLDivElement>>('cyContainer');

  // ── Embedded input ──────────────────────────────────────────────────────────
  @Input() set embeddedSpaceId(v: string | undefined) {
    if (v !== undefined) {
      this.isEmbedded.set(true);
      const changed = this.activeSpaceId() !== v;
      this.activeSpaceId.set(v);
      if (changed && this.cy) this.resetGraph();
    }
  }

  /**
   * An entity to open as the root on mount — the embedded equivalent of the `?entity=` query param,
   * set by the record tables' "view in graph" action.
   *
   * It is REMEMBERED rather than applied here. This setter runs during construction, and `renderGraph`
   * begins `if (!this.cy) return` — cytoscape does not exist until `ngAfterViewInit`. Rooting the graph
   * from the setter therefore fetches, traverses, caches the result and draws nothing, with no error:
   * the empty canvas reads as "this node has no connections". So the id is parked and consumed after
   * `initCytoscape()`.
   */
  @Input() set focusEntityId(v: string | undefined) {
    if (v) this.pendingFocusId = v;
  }
  private pendingFocusId: string | null = null;

  // ── State signals ───────────────────────────────────────────────────────────
  isEmbedded = signal(false);

  spaces = signal<Space[]>([]);
  activeSpaceId = signal('');
  searchQuery = signal('');

  rootEntity = signal<Entity | null>(null);
  depth = signal(2);
  direction = signal<'outbound' | 'inbound' | 'both'>('both');
  hideLabels = signal(false);
  truncated = signal(false);

  selectedNode = signal<TraverseNode | null>(null);
  selectedEntityRecord = signal<Entity | null>(null);
  selectedEdge = signal<TraverseEdge | null>(null);
  selectedEdgeRecord = signal<Edge | null>(null);
  /**
   * Why the detail panel has no record, when that is a fact rather than a failure.
   *
   * A file node is addressed by PATH and a graph node carries an id; a synthetic edge has no stored record at
   * all. Both used to issue a request that 404ed into `catchError`, so the panel opened empty and said
   * nothing — and an empty panel is indistinguishable from a record that failed to load. Only one of those is
   * worth a retry.
   *
   * ONE signal, not one per kind of selection: a node tap clears the edge and an edge tap clears the node, so
   * the panel only ever describes one thing. Two parallel signals could disagree, and the reason they carry
   * is what the message is chosen by anyway.
   */
  recordUnavailable = signal<'file' | 'derived' | null>(null);
  nodeMemories = signal<Fact[]>([]);
  nodeChrono = signal<ChronoEntry[]>([]);

  detailTypeFilter = signal<'all' | 'fact' | 'chrono'>('all');
  detailDescFilter = signal('');
  nodeCount = signal(0);
  edgeCount = signal(0);

  popupRecord = signal<Record<string, unknown> | null>(null);
  popupType = signal<KnowledgeType>('entity');
  canEdit = signal(false);

  // -- Record drawer (memory / chrono) ----------------------------------------
  // Drawer state lives in the shared `RecordDrawerState` provided above. This page only opens it
  // and reacts to `lastSaved`; it holds no edit models of its own.

  loading = signal(false);
  /** Failure reason for the last traversal; null when it succeeded (U3). A
   *  failed traversal must not render as an empty graph (which reads as "no
   *  connections"). */
  loadError = signal<string | null>(null);
  private lastTraverse: { startId: string; maxDepth: number; direction: 'outbound' | 'inbound' | 'both' } | null = null;

  // ── Computed ────────────────────────────────────────────────────────────────
  allDetails = computed<DetailRow[]>(() => buildDetailRows(this.nodeMemories(), this.nodeChrono()));

  /*
   * The sort arguments are FIXED, and saying so is the honest version of what was already happening. Nothing
   * could change them once the detail table moved to `graph-linked-records`, which filters but does not sort —
   * and the order is discarded anyway, because the only reader of this turns it into a Set of ids.
   */
  filteredDetails = computed<DetailRow[]>(() => filterAndSortDetails(this.allDetails(), {
    type: this.detailTypeFilter(),
    text: this.detailDescFilter(),
    field: 'createdAt',
    asc: false,
  }));

  /** True when the panel is showing less than everything — drives the "no matches" empty state. */
  detailFilterActive = computed(() => this.detailTypeFilter() !== 'all' || this.detailDescFilter().trim() !== '');

  /**
   * The surviving row ids, used to narrow the two lists.
   *
   * The lists render `Fact`/`ChronoEntry` records, not `DetailRow`s, and that matters: a chrono row
   * shows `startsAt` (when the thing happens) while a `DetailRow` only carries `createdAt` (when it was
   * written). Feeding rows straight through would silently swap the date on every chrono entry. So the
   * tested pipeline decides WHICH records survive, and the records themselves still supply what is drawn.
   */
  private visibleDetailIds = computed<Set<string>>(() => new Set(this.filteredDetails().map(r => r.id)));

  filteredMemories = computed<Fact[]>(() => {
    if (!this.detailFilterActive()) return this.nodeMemories();
    const ids = this.visibleDetailIds();
    return this.nodeMemories().filter(m => ids.has(m._id));
  });

  filteredChrono = computed<ChronoEntry[]>(() => {
    if (!this.detailFilterActive()) return this.nodeChrono();
    const ids = this.visibleDetailIds();
    return this.nodeChrono().filter(c => ids.has(c._id));
  });

  panelTitle = computed(() => {
    const n = this.selectedNode();
    if (n) return n.name;
    const e = this.selectedEdge();
    if (e) return e.label || 'edge';
    return '';
  });

  panelColor = computed(() => {
    const n = this.selectedNode();
    if (n) return this.typeColor(n.type || 'default');
    const e = this.selectedEdgeRecord();
    if (e) return this.typeColor(e.label || 'edge');
    return this.theme.fallback;
  });

  // ── Private state ───────────────────────────────────────────────────────────
  private cy: GraphInstance | null = null;
  private subs = new Subscription();

  /** Palette read from CSS vars once the view exists; the default until then. */
  private theme: GraphTheme = DEFAULT_GRAPH_THEME;

  private typeColor(type: string): string {
    return typeColor(this.theme, type);
  }

  // Currently rendered (depth-filtered) view
  private graphNodes: TraverseNode[] = [];
  private graphEdges: TraverseEdge[] = [];

  /** Full-depth traversal cache — what makes a shallower depth free. See `graph-traversal-cache.ts`. */
  private cache: TraversalCache = emptyCache();

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  ngOnInit(): void {
    // Load spaces only in standalone mode; in embedded mode the space is injected via @Input
    if (!this.isEmbedded()) {
      this.spacesApi.listSpaces().subscribe(res => {
        this.spaces.set(res.spaces);
        const qp = this.route.snapshot.queryParams;
        const initial = qp['space'] || (res.spaces.length ? res.spaces[0].id : '');
        this.activeSpaceId.set(initial);

        // If entity query-param present, load it as root
        if (qp['entity'] && initial) {
          this.brainApi.getEntity(initial, qp['entity']).pipe(
            catchError(() => of(null)),
          ).subscribe(ent => {
            if (ent) this.selectRoot(ent);
          });
        }
      });
    }

    this.authApi.getMe().pipe(catchError(() => of(null))).subscribe(me => {
      // From the matrix, not the removed `readOnly` flag. `canEdit` only greys the editor out; every
      // action it enables is re-checked by the server per space and per area.
      this.canEdit.set(canWriteAnywhere(me?.rights ?? null));
    });
  }

  ngAfterViewInit(): void {
    this.theme = readGraphTheme();   // CSS vars resolve only once the view exists
    this.initCytoscape();
    this.applyPendingFocus();

    // Watch direction / depth / hideLabels changes via effect
    // Using effect in AfterViewInit requires the injection context to still be active
    // so we'll use subscriptions on signals via polling or explicit calls.
    // The signals are updated via template bindings and we trigger traverse from those handlers.
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    if (this.cy) {
      this.cy.destroy();
      this.cy = null;
    }
  }

  /**
   * Root the graph at the entity a record table sent us, with the whole neighbourhood in view:
   * **both directions, depth 2**. Called once, after cytoscape exists.
   *
   * The two settings are written explicitly rather than left to the signal initialisers they happen to
   * match. "Arriving from a table shows n=2 bidirectional" is the requested behaviour, and a behaviour
   * that holds only because two unrelated defaults agree is one a later change to either default breaks
   * silently.
   *
   * A failed lookup sets `loadError` rather than leaving an empty canvas: a deleted or cross-space id
   * must not render as a node with no connections.
   */
  private applyPendingFocus(): void {
    const id = this.pendingFocusId;
    const spaceId = this.activeSpaceId();
    if (!id || !spaceId) return;
    this.pendingFocusId = null;
    this.direction.set('both');
    this.depth.set(2);
    this.brainApi.getEntity(spaceId, id).pipe(catchError(() => of(null))).subscribe(ent => {
      if (ent) this.selectRoot(ent);
      else this.loadError.set(`Entity '${id}' could not be loaded in this space.`);
    });
  }

  // ── Cytoscape init ──────────────────────────────────────────────────────────

  private initCytoscape(): void {
    const container = this.cyContainer()?.nativeElement;
    if (!container) return;
    this.cy = createGraphCytoscape(container, this.theme, {
      onNodeTap: (id) => this.onNodeTap(id),
      onEdgeTap: (id) => this.onEdgeTap(id),
      onNodeDoubleTap: (id) => this.onNodeDoubleTap(id),
      onBackgroundTap: () => this.onBackgroundTap(),
    });
  }

  // ── Canvas interactions ───────────────────────────────────────────────────────
  //
  // These run OUTSIDE the Angular zone (cytoscape's own event system). Safe under OnPush only because
  // each writes a SIGNAL — a plain field would update nothing on screen.

  private onNodeTap(id: string): void {
    // graphNodes does NOT include the root (it is added to the canvas separately), so a tap on the
    // root — the most-clicked node in any graph — has to be reconstructed from rootEntity.
    let tn = this.graphNodes.find(n => n._id === id);
    if (!tn) {
      const root = this.rootEntity();
      if (root && root._id === id) {
        tn = { _id: root._id, name: root.name, type: root.type || 'default', depth: 0, description: root.description, tags: root.tags };
      }
    }
    if (!tn) return;
    this.selectedEdge.set(null);
    this.selectedEdgeRecord.set(null);
    this.selectedEntityRecord.set(null);
    this.selectedNode.set(tn);
    // `tn.kind` decides which collection the record comes from. Passing the id alone is what made every
    // chrono/memory/file node open an empty panel — the branch existed and nothing fed it.
    this.loadNodeDetails(id, tn.kind);
  }

  private onEdgeTap(id: string): void {
    const te = this.graphEdges.find(e => e._id === id);
    if (!te) return;
    this.selectedNode.set(null);
    this.selectedEdge.set(te);
    this.loadEdgeDetails(te);
  }

  private onNodeDoubleTap(id: string): void {
    const spaceId = this.activeSpaceId();
    if (!spaceId) return;
    this.brainApi.getEntity(spaceId, id).pipe(
      catchError(() => of(null)),
    ).subscribe(ent => { if (ent) this.selectRoot(ent, true); });
  }

  private onBackgroundTap(): void {
    this.selectedNode.set(null);
    this.selectedEdge.set(null);
    this.selectedEdgeRecord.set(null);
  }

  // ── Toolbar handlers ────────────────────────────────────────────────────────

  onSearchQueryChange(q: string): void {
    this.searchQuery.set(q);
  }

  onSpaceChange(spaceId: string): void {
    this.activeSpaceId.set(spaceId);
    this.resetGraph();
  }

  onDepthChange(val: number | string): void {
    this.depth.set(+val);
    if (this.rootEntity()) {
      this.traverse(this.rootEntity()!._id, +val, this.direction());
    }
  }

  setDirection(dir: 'outbound' | 'inbound' | 'both'): void {
    this.direction.set(dir);
    if (this.rootEntity()) {
      this.traverse(this.rootEntity()!._id, this.depth(), dir);
    }
  }

  onHideLabelsChange(hide: boolean): void {
    this.hideLabels.set(hide);
    if (this.cy) {
      if (hide) {
        this.cy.edges().addClass('hide-labels');
      } else {
        this.cy.edges().removeClass('hide-labels');
      }
    }
  }

  selectRoot(entity: Entity, pushHistory = false): void {
    this.rootEntity.set(entity);
    this.searchQuery.set(entity.name);
    this.selectedNode.set(null);
    this.selectedEntityRecord.set(null);
    this.selectedEdge.set(null);
    this.selectedEdgeRecord.set(null);
    this.nodeMemories.set([]);
    this.nodeChrono.set([]);
    if (!this.isEmbedded()) this.updateUrl(entity._id, pushHistory);
    this.traverse(entity._id, this.depth(), this.direction());
  }

  fitGraph(): void {
    if (this.cy) this.cy.fit(undefined, 40);
  }

  resetGraph(): void {
    this.rootEntity.set(null);
    this.selectedNode.set(null);
    this.selectedEntityRecord.set(null);
    this.selectedEdge.set(null);
    this.selectedEdgeRecord.set(null);
    this.nodeMemories.set([]);
    this.nodeChrono.set([]);
    this.searchQuery.set('');
    this.truncated.set(false);
    this.graphNodes = [];
    this.graphEdges = [];
    this.cache = emptyCache();
    if (this.cy) {
      this.cy.elements().remove();
    }
  }

  // ── Graph traversal ─────────────────────────────────────────────────────────

  private traverse(startId: string, maxDepth: number, direction: 'outbound' | 'inbound' | 'both'): void {
    const spaceId = this.activeSpaceId();
    if (!spaceId) return;

    this.selectedNode.set(null);
    this.selectedEntityRecord.set(null);
    this.selectedEdge.set(null);
    this.selectedEdgeRecord.set(null);

    const req = { startId, maxDepth, direction };
    const plan = decideFetch(this.cache, req);

    // A shallower view is always a subset of what was already fetched — no request needed.
    if (plan === 'from-cache') {
      this.applyDepthFilter(startId, maxDepth);
      return;
    }

    this.loading.set(true);
    this.loadError.set(null);
    this.lastTraverse = req;
    this.brainApi.traverseGraph(spaceId, { startId, direction, maxDepth, limit: 200 }).subscribe({
      error: (e) => { this.loading.set(false); this.loadError.set(httpErrorReason(e)); },
      next: (result) => {
        this.loading.set(false);
        this.cache = applyResult(this.cache, plan, req, result);
        this.truncated.set(result.truncated);
        this.applyDepthFilter(startId, maxDepth);
      },
    });
  }

  /** Re-run the last traversal — bound to the error state's Retry button. */
  retryTraverse(): void {
    if (this.lastTraverse) {
      const { startId, maxDepth, direction } = this.lastTraverse;
      this.traverse(startId, maxDepth, direction);
    }
  }

  // Filter the full cache down to the requested depth and re-render
  private applyDepthFilter(startId: string, maxDepth: number): void {
    const view = filterToDepth(this.cache, startId, maxDepth);
    this.graphNodes = view.nodes;
    this.graphEdges = view.edges;
    this.renderGraph(startId);
  }

  private renderGraph(rootId: string): void {
    if (!this.cy) return;

    const elements = buildElements(this.rootEntity(), this.graphNodes, this.graphEdges, rootId);

    // Count what was actually handed over, not what is cached — the badges must track the canvas, or
    // they keep reporting depth-5 nodes after the slider went back to 2.
    this.nodeCount.set(elements.filter(e => e.group === 'nodes').length);
    this.edgeCount.set(elements.filter(e => e.group === 'edges').length);

    renderElements(this.cy, elements, rootId, this.hideLabels(), () => this.onLayoutSettled());
  }

  /** Fit the finished layout, and open the root's panel if the user has not chosen something else. */
  private onLayoutSettled(): void {
    if (!this.cy) return;
    // Resize first: Angular may have opened or closed the side panel since renderGraph() ran, which
    // changes the canvas width without cytoscape knowing.
    this.cy.resize();
    this.cy.fit(undefined, 40);

    const root = this.rootEntity();
    if (!root || this.selectedNode() || this.selectedEdge()) return;

    this.selectedNode.set({ _id: root._id, name: root.name, type: root.type || 'default', depth: 0, description: root.description, tags: root.tags });
    this.loadNodeDetails(root._id);
    // Opening the panel narrows the canvas — refit once the DOM has caught up.
    setTimeout(() => {
      if (this.cy) {
        this.cy.resize();
        this.cy.fit(undefined, 40);
      }
    }, 50);
  }

  // ── Detail panel helpers ────────────────────────────────────────────────────

  /** `lookupForNode` decides which collection, or that there is none. `BrainApi.getRecord` owns the dispatch. */
  private loadNodeDetails(entityId: string, kind?: 'chrono' | 'fact' | 'file'): void {
    const spaceId = this.activeSpaceId();
    if (!spaceId) return;
    this.recordUnavailable.set(null);

    const want = lookupForNode(kind);
    if ('unavailable' in want) { this.recordUnavailable.set(want.unavailable); return; }
    this.brainApi.getRecord(spaceId, want.fetch, entityId).pipe(
      catchError(() => of(null)),
    ).subscribe(rec => { if (rec) this.selectedEntityRecord.set(rec as Entity); });

    forkJoin({
      mems: this.brainApi.listFacts(spaceId, 100, 0, { entity: entityId }).pipe(
        catchError(() => of({ facts: [] as Fact[] })),
      ),
      chrono: this.brainApi.chronoLinkedTo(spaceId, entityId).pipe(
        catchError(() => of([] as ChronoEntry[])),
      ),
    }).subscribe(({ mems, chrono }) => {
      this.nodeMemories.set(mems.facts);
      this.nodeChrono.set(chrono);
    });
  }

  openEntityPopup(node: TraverseNode): void {
    const spaceId = this.activeSpaceId();
    if (!spaceId) return;
    this.brainApi.getEntity(spaceId, node._id).pipe(
      catchError(() => of(null)),
    ).subscribe(ent => {
      if (ent) {
        this.popupRecord.set(ent as unknown as Record<string, unknown>);
        this.popupType.set('entity');
      }
    });
  }

  private loadEdgeDetails(te: TraverseEdge): void {
    const spaceId = this.activeSpaceId();
    if (!spaceId) return;
    this.nodeMemories.set([]);
    this.nodeChrono.set([]);
    this.recordUnavailable.set(null);

    // A synthetic edge is derived at render time and stored nowhere — see `lookupForEdge`.
    const want = lookupForEdge(te._id);
    if ('unavailable' in want) {
      this.recordUnavailable.set(want.unavailable);
    } else {
      this.brainApi.getEdge(spaceId, te._id).pipe(
        catchError(() => of(null)),
      ).subscribe(edge => { if (edge) this.selectedEdgeRecord.set(edge); });
    }

    // Load memories/chronos linked to BOTH endpoints
    forkJoin({
      mems: this.brainApi.listFacts(spaceId, 100, 0, { entity: te.from }).pipe(
        catchError(() => of({ facts: [] as Fact[] })),
      ),
      chrono: this.brainApi.chronoLinkedTo(spaceId, te.from).pipe(
        catchError(() => of([] as ChronoEntry[])),
      ),
    }).subscribe(({ mems, chrono }) => {
      // filter to those also referencing te.to
      const filteredMems = mems.facts.filter(m =>
        Array.isArray(m.linkEntities) && m.linkEntities.includes(te.to)
      );
      const filteredChrono = chrono.filter(c =>
        Array.isArray(c.linkEntities) && c.linkEntities.includes(te.from) && c.linkEntities.includes(te.to)
      );
      this.nodeMemories.set(filteredMems);
      this.nodeChrono.set(filteredChrono);
    });
  }

  // Takes only what it reads. The template used to build seven-field DetailRow literals at four call
  // sites for these two fields; the table's own rows still satisfy this shape.
  openDetailPopup(row: DetailRef): void {
    const spaceId = this.activeSpaceId();
    if (!spaceId) return;
    if (row.kind === 'fact') {
      this.brainApi.getMemory(spaceId, row.id).pipe(catchError(() => of(null))).subscribe(m => {
        if (m) this.openBrainDrawer('fact', m);
      });
    } else {
      this.brainApi.getChrono(spaceId, row.id).pipe(catchError(() => of(null))).subscribe(c => {
        if (c) this.openBrainDrawer('chrono', c);
      });
    }
  }

  /**
   * Open the shared record drawer on a graph node's memory or chrono record.
   *
   * Kept as a method rather than calling `drawerState.open()` from each of the three call sites,
   * so this page keeps one seam for the open path.
   *
   * Overloaded for the same reason `RecordDrawerState.open` is: this page only ever opens the two
   * kinds a graph node carries, and a single `(kind, record: any)` signature would let either one
   * through as the other.
   */
  openBrainDrawer(kind: 'fact', record: Fact): void;
  openBrainDrawer(kind: 'chrono', record: ChronoEntry): void;
  openBrainDrawer(kind: 'fact' | 'chrono', record: Fact | ChronoEntry): void {
    if (kind === 'fact') this.drawerState.open(kind, record as Fact);
    else this.drawerState.open(kind, record as ChronoEntry);
  }

  /**
   * Feed the schema the drawer's property editors and tag suggestions read.
   *
   * A space with no typeSchemas is not an error: `buildPropertiesObject` returns the record's own
   * properties untouched, which is exactly what the forked drawer used to do for every space.
   */
  private loadSpaceMeta(spaceId: string): void {
    if (!spaceId) { this.store.spaceMeta.set(null); return; }
    this.spacesApi.getSpaceMeta(spaceId).subscribe({
      next: (meta) => this.store.spaceMeta.set(meta),
      error: () => this.store.spaceMeta.set(null),
    });
  }

  asRecord(obj: unknown): Record<string, unknown> {
    return obj as Record<string, unknown>;
  }

  closePopup(): void {
    this.popupRecord.set(null);
  }

  onPopupSaved(_evt: Record<string, unknown>): void {
    this.popupRecord.set(null);
    const root = this.rootEntity();
    if (root) {
      this.traverse(root._id, this.depth(), this.direction());
      const sel = this.selectedNode();
      if (sel) this.loadNodeDetails(sel._id, sel.kind);
      const edge = this.selectedEdge();
      if (edge) this.loadEdgeDetails(edge);
    }
  }

  // ── URL management ──────────────────────────────────────────────────────────
  private updateUrl(entityId: string, push = false): void {
    const spaceId = this.activeSpaceId();
    const path = this.location.path().split('?')[0];
    const qs = `space=${spaceId}&entity=${entityId}`;
    if (push) {
      this.location.go(path, qs);
    } else {
      this.location.replaceState(path, qs);
    }
  }
}

