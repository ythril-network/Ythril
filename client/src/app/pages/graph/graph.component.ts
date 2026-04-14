import {
  Component,
  OnInit,
  AfterViewInit,
  OnDestroy,
  inject,
  signal,
  computed,
  viewChild,
  ElementRef,
} from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Subject, Subscription, forkJoin, of } from 'rxjs';
import { debounceTime, distinctUntilChanged, switchMap, catchError } from 'rxjs/operators';
import cytoscape from 'cytoscape';
import {
  ApiService,
  Space,
  Entity,
  Memory,
  ChronoEntry,
  Edge,
  TraverseNode,
  TraverseEdge,
  TraverseResult,
} from '../../core/api.service';
import { EntryPopupComponent } from '../../shared/entry-popup.component';

// ── Deterministic colour palette for node types ──────────────────────────────

const TYPE_COLORS = [
  '#7c6af7', '#58a6ff', '#3fb950', '#d29922', '#f85149',
  '#e38625', '#9580ff', '#79c0ff', '#56d364', '#e3b341',
];

function typeColor(type: string): string {
  let hash = 0;
  for (let i = 0; i < type.length; i++) hash = (hash * 31 + type.charCodeAt(i)) | 0;
  return TYPE_COLORS[Math.abs(hash) % TYPE_COLORS.length];
}

// ── Helper types ─────────────────────────────────────────────────────────────

interface OverlayIcon {
  id: string;
  kind: 'node' | 'edge';
  x: number;
  y: number;
}

interface DetailRow {
  id: string;
  kind: 'memory' | 'chrono';
  description: string;
  tags: string[];
  properties: Record<string, unknown>;
  createdAt: string;
  raw: Record<string, unknown>;
}

@Component({
  selector: 'app-graph-view',
  standalone: true,
  imports: [CommonModule, FormsModule, EntryPopupComponent],
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      height: calc(100vh - 56px - 56px);
      min-height: 0;
    }

    /* ── Toolbar ───────────────────────────────────────────────────────────── */

    .graph-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      margin-bottom: 8px;
      flex-shrink: 0;
    }

    .graph-toolbar select,
    .graph-toolbar input[type="search"],
    .graph-toolbar input[type="text"] {
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-family: var(--font);
      font-size: 13px;
      padding: 6px 10px;
      outline: none;
      transition: border-color var(--transition);
    }
    .graph-toolbar select:focus,
    .graph-toolbar input:focus {
      border-color: var(--accent);
    }

    .graph-toolbar select { min-width: 140px; }

    .search-wrapper {
      position: relative;
      flex: 1;
      min-width: 180px;
      max-width: 340px;
    }
    .search-wrapper input { width: 100%; }

    .autocomplete-dropdown {
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      margin-top: 4px;
      max-height: 220px;
      overflow-y: auto;
      z-index: 50;
    }
    .autocomplete-dropdown button {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 8px 12px;
      background: transparent;
      border: none;
      color: var(--text-primary);
      font-size: 13px;
      cursor: pointer;
      text-align: left;
    }
    .autocomplete-dropdown button:hover { background: var(--bg-overlay); }
    .autocomplete-dropdown .ac-type {
      font-size: 11px;
      color: var(--text-muted);
      margin-left: auto;
    }

    .depth-control {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--text-secondary);
      font-size: 13px;
      white-space: nowrap;
    }
    .depth-control input[type="range"] {
      accent-color: var(--accent);
      width: 90px;
    }
    .depth-value {
      font-family: var(--font-mono);
      color: var(--text-primary);
      min-width: 16px;
      text-align: center;
    }

    .pill-group {
      display: flex;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      overflow: hidden;
    }
    .pill-group button {
      padding: 5px 12px;
      font-size: 12px;
      background: var(--bg-elevated);
      color: var(--text-secondary);
      border: none;
      cursor: pointer;
      transition: background var(--transition), color var(--transition);
    }
    .pill-group button + button { border-left: 1px solid var(--border); }
    .pill-group button.active {
      background: var(--accent-dim);
      color: var(--accent);
    }

    .toolbar-toggle {
      display: flex;
      align-items: center;
      gap: 5px;
      color: var(--text-secondary);
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    .toolbar-toggle input[type="checkbox"] { accent-color: var(--accent); }

    .toolbar-btn {
      padding: 5px 10px;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-size: 15px;
      cursor: pointer;
      line-height: 1;
      transition: border-color var(--transition), color var(--transition);
    }
    .toolbar-btn:hover {
      border-color: var(--accent);
      color: var(--text-primary);
    }

    /* ── Canvas zone ──────────────────────────────────────────────────────── */

    .canvas-zone {
      position: relative;
      flex: 1;
      min-height: 300px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--bg-primary);
      overflow: hidden;
    }

    .cy-container {
      width: 100%;
      height: 100%;
      position: absolute;
      inset: 0;
    }

    .truncation-banner {
      position: absolute;
      top: 12px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 20;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 16px;
      background: var(--error-dim);
      border: 1px solid var(--error);
      border-radius: var(--radius-sm);
      color: var(--warning);
      font-size: 13px;
      white-space: nowrap;
    }
    .truncation-banner button {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      font-size: 14px;
      cursor: pointer;
      padding: 0 2px;
    }

    .canvas-empty {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }
    .canvas-empty .empty-state-icon { font-size: 48px; margin-bottom: 12px; }
    .canvas-empty h3 {
      color: var(--text-muted);
      font-weight: 400;
      font-size: 15px;
    }

    /* ── Overlay icons ────────────────────────────────────────────────────── */

    .overlay-icons {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 10;
    }
    .eye-overlay {
      position: absolute;
      pointer-events: auto;
      width: 22px;
      height: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: 50%;
      cursor: pointer;
      padding: 0;
      transform: translate(-50%, -50%);
      transition: background var(--transition);
      line-height: 1;
    }
    .eye-overlay:hover { background: var(--accent-dim); }

    /* ── Detail panel ─────────────────────────────────────────────────────── */

    .detail-panel {
      flex-shrink: 0;
      max-height: 300px;
      overflow-y: auto;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
      margin-top: 8px;
    }

    .detail-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      background: var(--bg-surface);
      z-index: 2;
    }
    .detail-header h3 {
      margin: 0;
      font-size: 15px;
      color: var(--text-primary);
    }
    .detail-stat {
      font-size: 12px;
      color: var(--text-muted);
    }
    .detail-header .spacer { flex: 1; }

    .detail-filters {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
      padding: 8px 16px;
      border-bottom: 1px solid var(--border);
      font-size: 12px;
      color: var(--text-secondary);
    }
    .detail-filters label {
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
    }
    .detail-filters input[type="radio"] { accent-color: var(--accent); }
    .detail-filters input[type="search"] {
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 12px;
      padding: 4px 8px;
      outline: none;
      margin-left: auto;
      min-width: 160px;
    }
    .detail-filters input[type="search"]:focus { border-color: var(--accent); }

    .detail-panel .table-wrapper {
      overflow-x: auto;
    }
    .detail-panel table {
      width: 100%;
      border-collapse: collapse;
    }
    .detail-panel th {
      text-align: left;
      font-size: 11px;
      color: var(--text-muted);
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
      user-select: none;
    }
    .detail-panel th.sortable { cursor: pointer; }
    .detail-panel th.sortable:hover { color: var(--text-secondary); }
    .detail-panel td {
      font-size: 13px;
      color: var(--text-primary);
      padding: 6px 12px;
      border-bottom: 1px solid var(--border);
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .detail-panel tr:last-child td { border-bottom: none; }
    .detail-panel .tag {
      margin-right: 4px;
    }
    .detail-panel .props-cell {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-muted);
    }

    /* ── Popup wrapper: only render when we have a record ─────────────────── */
    .popup-wrapper { display: contents; }
  `],
  template: `
    <!-- ═══ Toolbar ════════════════════════════════════════════════════════ -->
    <div class="graph-toolbar">
      <select [ngModel]="activeSpaceId()" (ngModelChange)="onSpaceChange($event)">
        @for (s of spaces(); track s.id) {
          <option [value]="s.id">{{ s.label }}</option>
        }
      </select>

      <div class="search-wrapper">
        <input
          type="search"
          placeholder="🔍  Search entity…"
          [ngModel]="searchQuery()"
          (ngModelChange)="onSearchInput($event)"
          (focus)="searchFocused.set(true)"
          (blur)="onSearchBlur()"
        />
        @if (searchResults().length > 0 && searchFocused()) {
          <div class="autocomplete-dropdown">
            @for (ent of searchResults(); track ent._id) {
              <button (mousedown)="selectRoot(ent)">
                {{ ent.name }}
                <span class="ac-type">{{ ent.type ?? 'entity' }}</span>
              </button>
            }
          </div>
        }
      </div>

      <div class="depth-control">
        Depth
        <input type="range" min="1" max="10" [ngModel]="depth()" (ngModelChange)="onDepthChange($event)" />
        <span class="depth-value">{{ depth() }}</span>
      </div>

      <div class="pill-group">
        <button [class.active]="direction() === 'outbound'" (click)="setDirection('outbound')">Out</button>
        <button [class.active]="direction() === 'inbound'" (click)="setDirection('inbound')">In</button>
        <button [class.active]="direction() === 'both'"    (click)="setDirection('both')">Both</button>
      </div>

      <label class="toolbar-toggle">
        <input type="checkbox" [ngModel]="hideLabels()" (ngModelChange)="onHideLabelsChange($event)" />
        Hide labels
      </label>

      <button class="toolbar-btn" title="Fit to viewport" (click)="fitGraph()">⛶</button>
      <button class="toolbar-btn" title="Reset graph"     (click)="resetGraph()">↺</button>
    </div>

    <!-- ═══ Canvas zone ═══════════════════════════════════════════════════ -->
    <div class="canvas-zone">
      @if (truncated()) {
        <div class="truncation-banner">
          ⚠ Result truncated — reduce depth or node limit to see full graph
          <button (click)="truncated.set(false)">✕</button>
        </div>
      }

      @if (!rootEntity()) {
        <div class="canvas-empty">
          <div class="empty-state-icon">🔍</div>
          <h3>Search for an entity above to start exploring</h3>
        </div>
      }

      <div #cyContainer class="cy-container" [style.visibility]="rootEntity() ? 'visible' : 'hidden'"></div>

      <div class="overlay-icons">
        @for (ov of overlays(); track ov.id) {
          <button class="eye-overlay" [style.left.px]="ov.x" [style.top.px]="ov.y"
                  (click)="onOverlayClick(ov)">👁</button>
        }
      </div>
    </div>

    <!-- ═══ Detail panel ═════════════════════════════════════════════════ -->
    @if (selectedNode()) {
      <div class="detail-panel">
        <div class="detail-header">
          <h3>{{ selectedNode()!.name }}</h3>
          <span class="badge">{{ selectedNode()!.type || 'entity' }}</span>
          <span class="detail-stat">{{ nodeMemories().length }} memories</span>
          <span class="detail-stat">{{ nodeChrono().length }} chrono</span>
          <span class="spacer"></span>
          <button class="btn btn-sm btn-ghost" (click)="openEntityPopup(selectedNode()!)">👁 View</button>
          <button class="btn btn-sm btn-ghost" (click)="selectedNode.set(null)">▲ Collapse</button>
        </div>

        <div class="detail-filters">
          <label><input type="radio" name="typeFilter" value="all"    [ngModel]="detailTypeFilter()" (ngModelChange)="detailTypeFilter.set($event)" /> All</label>
          <label><input type="radio" name="typeFilter" value="memory" [ngModel]="detailTypeFilter()" (ngModelChange)="detailTypeFilter.set($event)" /> Memory</label>
          <label><input type="radio" name="typeFilter" value="chrono" [ngModel]="detailTypeFilter()" (ngModelChange)="detailTypeFilter.set($event)" /> Chrono</label>
          <input type="search" placeholder="🔍 Filter description…"
                 [ngModel]="detailDescFilter()" (ngModelChange)="detailDescFilter.set($event)" />
        </div>

        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th class="sortable" (click)="toggleSort('description')">Description {{ sortField() === 'description' ? (sortAsc() ? '▲' : '▼') : '' }}</th>
                <th>Tags</th>
                <th>Properties</th>
                <th class="sortable" (click)="toggleSort('createdAt')">Created {{ sortField() === 'createdAt' ? (sortAsc() ? '▲' : '▼') : '' }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (row of filteredDetails(); track row.id) {
                <tr>
                  <td [title]="row.description">{{ row.description }}</td>
                  <td>
                    @for (t of row.tags; track t) {
                      <span class="tag">{{ t }}</span>
                    }
                  </td>
                  <td class="props-cell">{{ row.properties | json }}</td>
                  <td>{{ row.createdAt | date:'short' }}</td>
                  <td><button class="icon-btn" (click)="openDetailPopup(row)">👁</button></td>
                </tr>
              } @empty {
                <tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:16px">No records</td></tr>
              }
            </tbody>
          </table>
        </div>
      </div>
    }

    <!-- ═══ Entry popup ══════════════════════════════════════════════════ -->
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
  `,
})
export class GraphComponent implements OnInit, AfterViewInit, OnDestroy {
  // ── DI ──────────────────────────────────────────────────────────────────────
  private api = inject(ApiService);
  private location = inject(Location);
  private route = inject(ActivatedRoute);

  // ── Element refs ────────────────────────────────────────────────────────────
  cyContainer = viewChild<ElementRef<HTMLDivElement>>('cyContainer');

  // ── State signals ───────────────────────────────────────────────────────────
  spaces = signal<Space[]>([]);
  activeSpaceId = signal('');
  searchQuery = signal('');
  searchResults = signal<Entity[]>([]);
  searchFocused = signal(false);

  rootEntity = signal<Entity | null>(null);
  depth = signal(3);
  direction = signal<'outbound' | 'inbound' | 'both'>('both');
  hideLabels = signal(false);
  truncated = signal(false);

  selectedNode = signal<TraverseNode | null>(null);
  nodeMemories = signal<Memory[]>([]);
  nodeChrono = signal<ChronoEntry[]>([]);

  detailTypeFilter = signal<'all' | 'memory' | 'chrono'>('all');
  detailDescFilter = signal('');
  sortField = signal<'description' | 'createdAt'>('createdAt');
  sortAsc = signal(false);

  overlays = signal<OverlayIcon[]>([]);

  popupRecord = signal<Record<string, unknown> | null>(null);
  popupType = signal<'entity' | 'edge' | 'memory' | 'chrono'>('entity');
  canEdit = signal(false);

  loading = signal(false);

  // ── Computed ────────────────────────────────────────────────────────────────
  private allDetails = computed<DetailRow[]>(() => {
    const mems: DetailRow[] = this.nodeMemories().map(m => ({
      id: m._id,
      kind: 'memory' as const,
      description: m.fact || m.description || '',
      tags: m.tags ?? [],
      properties: (m.properties ?? {}) as Record<string, unknown>,
      createdAt: m.createdAt,
      raw: m as unknown as Record<string, unknown>,
    }));
    const chrs: DetailRow[] = this.nodeChrono().map(c => ({
      id: c._id,
      kind: 'chrono' as const,
      description: c.title || c.description || '',
      tags: c.tags ?? [],
      properties: {} as Record<string, unknown>,
      createdAt: c.createdAt,
      raw: c as unknown as Record<string, unknown>,
    }));
    return [...mems, ...chrs];
  });

  filteredDetails = computed<DetailRow[]>(() => {
    let rows = this.allDetails();
    const tf = this.detailTypeFilter();
    if (tf !== 'all') rows = rows.filter(r => r.kind === tf);
    const df = this.detailDescFilter().toLowerCase();
    if (df) rows = rows.filter(r => r.description.toLowerCase().includes(df));
    const field = this.sortField();
    const asc = this.sortAsc();
    rows = [...rows].sort((a, b) => {
      const va = field === 'description' ? a.description.toLowerCase() : a.createdAt;
      const vb = field === 'description' ? b.description.toLowerCase() : b.createdAt;
      return asc ? (va < vb ? -1 : va > vb ? 1 : 0)
                 : (va > vb ? -1 : va < vb ? 1 : 0);
    });
    return rows;
  });

  // ── Private state ───────────────────────────────────────────────────────────
  private cy: any = null;
  private search$ = new Subject<string>();
  private subs = new Subscription();
  private overlayRAF = 0;
  private graphNodes: TraverseNode[] = [];
  private graphEdges: TraverseEdge[] = [];

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  ngOnInit(): void {
    // Load spaces + current user
    this.api.listSpaces().subscribe(res => {
      this.spaces.set(res.spaces);
      const qp = this.route.snapshot.queryParams;
      const initial = qp['space'] || (res.spaces.length ? res.spaces[0].id : '');
      this.activeSpaceId.set(initial);

      // If entity query-param present, load it as root
      if (qp['entity'] && initial) {
        this.api.getEntity(initial, qp['entity']).pipe(
          catchError(() => of(null)),
        ).subscribe(ent => {
          if (ent) this.selectRoot(ent);
        });
      }
    });

    this.api.getMe().pipe(catchError(() => of(null))).subscribe(me => {
      this.canEdit.set(me ? !me.readOnly : false);
    });

    // Debounced entity search
    this.subs.add(
      this.search$.pipe(
        debounceTime(300),
        distinctUntilChanged(),
        switchMap(q => {
          if (!q.trim() || !this.activeSpaceId()) return of({ entities: [] as Entity[] });
          return this.api.searchEntitiesByName(this.activeSpaceId(), q).pipe(
            catchError(() => of({ entities: [] as Entity[] })),
          );
        }),
      ).subscribe(res => this.searchResults.set(res.entities)),
    );
  }

  ngAfterViewInit(): void {
    this.initCytoscape();

    // Watch direction / depth / hideLabels changes via effect
    // Using effect in AfterViewInit requires the injection context to still be active
    // so we'll use subscriptions on signals via polling or explicit calls.
    // The signals are updated via template bindings and we trigger traverse from those handlers.
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    if (this.overlayRAF) cancelAnimationFrame(this.overlayRAF);
    if (this.cy) {
      this.cy.destroy();
      this.cy = null;
    }
  }

  // ── Cytoscape init ──────────────────────────────────────────────────────────

  private initCytoscape(): void {
    const container = this.cyContainer()?.nativeElement;
    if (!container) return;

    this.cy = cytoscape({
      container,
      elements: [],
      style: [
        {
          selector: 'node',
          style: {
            'width': 40,
            'height': 40,
            'background-color': (ele: any) => typeColor(ele.data('type') || 'default'),
            'label': 'data(label)',
            'font-size': 11,
            'color': '#e6edf3',
            'text-outline-color': '#161b22',
            'text-outline-width': 1,
            'text-valign': 'bottom',
            'text-margin-y': 6,
            'text-max-width': '100px',
            'text-wrap': 'ellipsis',
          } as any,
        },
        {
          selector: 'node.root',
          style: {
            'width': 60,
            'height': 60,
            'border-width': 3,
            'border-color': '#7c6af7',
          } as any,
        },
        {
          selector: 'node:selected',
          style: {
            'border-width': 2,
            'border-color': '#58a6ff',
          } as any,
        },
        {
          selector: 'edge',
          style: {
            'width': 2,
            'line-color': '#30363d',
            'target-arrow-shape': 'triangle',
            'target-arrow-color': '#30363d',
            'curve-style': 'bezier',
            'label': 'data(label)',
            'font-size': 10,
            'color': '#8b949e',
            'text-rotation': 'autorotate',
            'text-margin-y': -10,
          } as any,
        },
        {
          selector: 'edge.hide-labels',
          style: {
            'label': '',
          } as any,
        },
      ],
      layout: { name: 'grid' },
      minZoom: 0.15,
      maxZoom: 4,
      wheelSensitivity: 0.3,
    });

    // Node tap → select + show detail panel
    this.cy.on('tap', 'node', (evt: any) => {
      const node = evt.target;
      const id = node.data('id');
      const tn = this.graphNodes.find(n => n._id === id);
      if (tn) {
        this.selectedNode.set(tn);
        this.loadNodeDetails(id);
      }
    });

    // Edge tap → open edge popup
    this.cy.on('tap', 'edge', (evt: any) => {
      const edgeId = evt.target.data('id');
      this.openEdgePopup(edgeId);
    });

    // Double-tap node → re-root
    this.cy.on('dbltap', 'node', (evt: any) => {
      const id = evt.target.data('id');
      const spaceId = this.activeSpaceId();
      if (!spaceId) return;
      this.api.getEntity(spaceId, id).pipe(
        catchError(() => of(null)),
      ).subscribe(ent => {
        if (ent) this.selectRoot(ent, true);
      });
    });

    // Update overlays on viewport changes
    this.cy.on('render pan zoom resize', () => this.scheduleOverlayUpdate());
  }

  // ── Toolbar handlers ────────────────────────────────────────────────────────

  onSpaceChange(spaceId: string): void {
    this.activeSpaceId.set(spaceId);
    this.resetGraph();
  }

  onSearchInput(query: string): void {
    this.searchQuery.set(query);
    this.search$.next(query);
  }

  onSearchBlur(): void {
    // Delay to allow click on dropdown item
    setTimeout(() => this.searchFocused.set(false), 200);
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
    this.searchResults.set([]);
    this.searchFocused.set(false);
    this.selectedNode.set(null);
    this.nodeMemories.set([]);
    this.nodeChrono.set([]);
    this.updateUrl(entity._id, pushHistory);
    this.traverse(entity._id, this.depth(), this.direction());
  }

  fitGraph(): void {
    if (this.cy) this.cy.fit(undefined, 40);
  }

  resetGraph(): void {
    this.rootEntity.set(null);
    this.selectedNode.set(null);
    this.nodeMemories.set([]);
    this.nodeChrono.set([]);
    this.searchQuery.set('');
    this.searchResults.set([]);
    this.truncated.set(false);
    this.graphNodes = [];
    this.graphEdges = [];
    this.overlays.set([]);
    if (this.cy) {
      this.cy.elements().remove();
    }
  }

  // ── Graph traversal ─────────────────────────────────────────────────────────

  private traverse(startId: string, maxDepth: number, direction: 'outbound' | 'inbound' | 'both'): void {
    const spaceId = this.activeSpaceId();
    if (!spaceId) return;

    this.loading.set(true);
    this.api.traverseGraph(spaceId, { startId, direction, maxDepth, limit: 200 }).pipe(
      catchError(() => of({ nodes: [], edges: [], truncated: false } as TraverseResult)),
    ).subscribe(result => {
      this.loading.set(false);
      this.graphNodes = result.nodes;
      this.graphEdges = result.edges;
      this.truncated.set(result.truncated);
      this.renderGraph(startId);
    });
  }

  private renderGraph(rootId: string): void {
    if (!this.cy) return;

    this.cy.elements().remove();

    const elements: any[] = [];

    // Add the root node (not included in traverse result)
    const root = this.rootEntity();
    if (root) {
      elements.push({
        group: 'nodes',
        data: { id: root._id, label: root.name, type: root.type || 'default', depth: 0 },
        classes: 'root',
      });
    }

    for (const n of this.graphNodes) {
      // Skip if root was already added
      if (n._id === rootId) continue;
      elements.push({
        group: 'nodes',
        data: { id: n._id, label: n.name, type: n.type || 'default', depth: n.depth },
      });
    }

    for (const e of this.graphEdges) {
      elements.push({
        group: 'edges',
        data: { id: e._id, source: e.from, target: e.to, label: e.label },
      });
    }

    this.cy.add(elements);

    // Apply hide-labels class to edges
    if (this.hideLabels()) {
      this.cy.edges().addClass('hide-labels');
    } else {
      this.cy.edges().removeClass('hide-labels');
    }

    // Run layout
    this.cy.layout({
      name: 'cose',
      animate: true,
      animationDuration: 400,
      nodeRepulsion: () => 8000,
      idealEdgeLength: () => 120,
      gravity: 0.3,
      padding: 40,
    } as any).run();

    // Fit after layout finishes
    setTimeout(() => {
      this.fitGraph();
      this.scheduleOverlayUpdate();
    }, 500);
  }

  // ── Overlay icon positioning ────────────────────────────────────────────────

  private scheduleOverlayUpdate(): void {
    if (this.overlayRAF) cancelAnimationFrame(this.overlayRAF);
    this.overlayRAF = requestAnimationFrame(() => this.updateOverlays());
  }

  private updateOverlays(): void {
    if (!this.cy || !this.rootEntity()) {
      this.overlays.set([]);
      return;
    }

    const icons: OverlayIcon[] = [];
    const ext = this.cy.extent();

    // Node overlays
    this.cy.nodes().forEach((node: any) => {
      const pos = node.renderedPosition();
      const w = node.renderedWidth();
      // Only add if visible in viewport
      const modelPos = node.position();
      if (modelPos.x >= ext.x1 && modelPos.x <= ext.x2 &&
          modelPos.y >= ext.y1 && modelPos.y <= ext.y2) {
        icons.push({
          id: 'n_' + node.data('id'),
          kind: 'node',
          x: pos.x + w / 2 + 2,
          y: pos.y - w / 2 - 2,
        });
      }
    });

    // Edge overlays
    this.cy.edges().forEach((edge: any) => {
      const sp = edge.source().renderedPosition();
      const tp = edge.target().renderedPosition();
      icons.push({
        id: 'e_' + edge.data('id'),
        kind: 'edge',
        x: (sp.x + tp.x) / 2,
        y: (sp.y + tp.y) / 2 - 14,
      });
    });

    this.overlays.set(icons);
  }

  onOverlayClick(ov: OverlayIcon): void {
    const spaceId = this.activeSpaceId();
    if (!spaceId) return;
    const realId = ov.id.substring(2); // strip 'n_' or 'e_' prefix

    if (ov.kind === 'node') {
      this.api.getEntity(spaceId, realId).pipe(
        catchError(() => of(null)),
      ).subscribe(ent => {
        if (ent) {
          this.popupRecord.set(ent as unknown as Record<string, unknown>);
          this.popupType.set('entity');
        }
      });
    } else {
      this.openEdgePopup(realId);
    }
  }

  // ── Detail panel helpers ────────────────────────────────────────────────────

  private loadNodeDetails(entityId: string): void {
    const spaceId = this.activeSpaceId();
    if (!spaceId) return;

    forkJoin({
      mems: this.api.listMemories(spaceId, 100, 0, { entity: entityId }).pipe(
        catchError(() => of({ memories: [] as Memory[] })),
      ),
      chrono: this.api.queryBrain(spaceId, {
        collection: 'chrono',
        filter: { entityIds: entityId },
        limit: 100,
      }).pipe(
        catchError(() => of({ results: [] as Record<string, unknown>[], collection: 'chrono' as const, count: 0 })),
      ),
    }).subscribe(({ mems, chrono }) => {
      this.nodeMemories.set(mems.memories);
      this.nodeChrono.set(chrono.results as unknown as ChronoEntry[]);
    });
  }

  toggleSort(field: 'description' | 'createdAt'): void {
    if (this.sortField() === field) {
      this.sortAsc.set(!this.sortAsc());
    } else {
      this.sortField.set(field);
      this.sortAsc.set(true);
    }
  }

  openEntityPopup(node: TraverseNode): void {
    const spaceId = this.activeSpaceId();
    if (!spaceId) return;
    this.api.getEntity(spaceId, node._id).pipe(
      catchError(() => of(null)),
    ).subscribe(ent => {
      if (ent) {
        this.popupRecord.set(ent as unknown as Record<string, unknown>);
        this.popupType.set('entity');
      }
    });
  }

  private openEdgePopup(edgeId: string): void {
    const spaceId = this.activeSpaceId();
    if (!spaceId) return;
    this.api.getEdge(spaceId, edgeId).pipe(
      catchError(() => of(null)),
    ).subscribe(edge => {
      if (edge) {
        this.popupRecord.set(edge as unknown as Record<string, unknown>);
        this.popupType.set('edge');
      }
    });
  }

  openDetailPopup(row: DetailRow): void {
    this.popupRecord.set(row.raw);
    this.popupType.set(row.kind);
  }

  closePopup(): void {
    this.popupRecord.set(null);
  }

  onPopupSaved(_evt: Record<string, unknown>): void {
    this.popupRecord.set(null);
    // Re-traverse to refresh
    const root = this.rootEntity();
    if (root) {
      this.traverse(root._id, this.depth(), this.direction());
      const sel = this.selectedNode();
      if (sel) this.loadNodeDetails(sel._id);
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
