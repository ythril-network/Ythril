import {
  Component,
  OnInit,
  AfterViewInit,
  OnDestroy,
  Input,
  inject,
  signal,
  computed,
  viewChild,
  ElementRef,
} from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Subscription, forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
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
import { EntitySearchComponent } from '../../shared/entity-search.component';

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
  imports: [CommonModule, FormsModule, EntryPopupComponent, EntitySearchComponent],
  host: { '[class.embedded]': 'isEmbedded()' },
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      height: calc(100vh - 56px - 56px);
      min-height: 0;
      gap: 8px;
    }
    :host.embedded {
      height: 70vh;
      min-height: 400px;
    }

    /* ── Space chips (matches brain style) ─────────────────────────────────── */
    .space-tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 8px;
      overflow-x: auto;
      padding-bottom: 2px;
      flex-shrink: 0;
    }
    .space-chip {
      padding: 5px 12px;
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
      gap: 1px;
      min-width: 90px;
      white-space: nowrap;
    }
    .space-chip:hover { border-color: var(--accent); color: var(--text-primary); }
    .space-chip.active {
      background: var(--accent-dim);
      border-color: var(--accent);
      color: var(--accent);
    }
    .space-chip-label { font-size: 12px; font-weight: 500; }
    .space-chip-id { font-size: 10px; color: var(--text-muted); }
    .space-chip.active .space-chip-id { color: var(--accent); opacity: 0.7; }

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
      min-width: 200px;
      max-width: 360px;
    }

    .toolbar-divider {
      width: 1px;
      height: 22px;
      background: var(--border);
      flex-shrink: 0;
    }
    .toolbar-spacer { flex: 1; }
    .toolbar-label {
      font-size: 12px;
      color: var(--text-muted);
      white-space: nowrap;
    }

    .depth-control {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .depth-control input[type="range"] {
      accent-color: var(--accent);
      width: 80px;
      cursor: pointer;
    }
    .depth-value {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-primary);
      min-width: 14px;
      text-align: center;
    }

    .pill-group {
      display: flex;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      overflow: hidden;
      flex-shrink: 0;
    }
    .pill-group button {
      padding: 5px 12px;
      font-size: 12px;
      background: var(--bg-elevated);
      color: var(--text-secondary);
      border: none;
      cursor: pointer;
      transition: background var(--transition), color var(--transition);
      white-space: nowrap;
    }
    .pill-group button + button { border-left: 1px solid var(--border); }
    .pill-group button.active {
      background: var(--accent-dim);
      color: var(--accent);
    }
    .pill-group button:hover:not(.active) {
      background: var(--bg-overlay);
      color: var(--text-primary);
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
      font-size: 14px;
      cursor: pointer;
      line-height: 1;
      transition: border-color var(--transition), color var(--transition), background var(--transition);
    }
    .toolbar-btn:hover {
      border-color: var(--accent);
      color: var(--text-primary);
      background: var(--accent-dim);
    }
    .graph-stats {
      font-size: 12px;
      color: var(--text-muted);
      white-space: nowrap;
      font-family: var(--font-mono);
    }

    /* ── Canvas zone ──────────────────────────────────────────────────────── */

    .canvas-zone {
      position: relative;
      flex: 1;
      min-height: 0;
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
      gap: 8px;
    }
    .empty-icon {
      font-size: 52px;
      line-height: 1;
      opacity: 0.2;
    }
    .canvas-empty h3 {
      color: var(--text-muted);
      font-weight: 500;
      font-size: 15px;
      margin: 0;
    }
    .canvas-empty p {
      color: var(--text-muted);
      font-size: 13px;
      margin: 0;
      opacity: 0.7;
    }

    /* Loading overlay */
    .loading-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0,0,0,0.25);
      z-index: 30;
      backdrop-filter: blur(2px);
    }
    .loading-spinner {
      width: 36px;
      height: 36px;
      border: 3px solid rgba(124, 106, 247, 0.25);
      border-top-color: #7c6af7;
      border-radius: 50%;
      animation: graph-spin 0.75s linear infinite;
    }
    @keyframes graph-spin { to { transform: rotate(360deg); } }

    /* ── Overlay icons ────────────────────────────────────────────────────── */

    /* ── Detail panel (overlaid at canvas bottom) ───────────────────────── */

    .detail-panel {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      max-height: 46%;
      min-height: 140px;
      z-index: 15;
      border-top: 1px solid var(--border);
      border-radius: 0 0 var(--radius-md) var(--radius-md);
      background: var(--bg-surface);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 -4px 24px rgba(0,0,0,0.35);
    }
    .detail-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .detail-title {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .detail-node-badge {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .detail-header h3 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .detail-header-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .detail-filters {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 16px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .detail-filters .pill-group button {
      padding: 4px 10px;
      font-size: 11px;
    }
    .count-chip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 16px;
      height: 16px;
      padding: 0 4px;
      background: var(--bg-overlay);
      border-radius: 8px;
      font-size: 10px;
      color: var(--text-muted);
      margin-left: 4px;
    }
    .pill-group button.active .count-chip {
      background: var(--accent-dim);
      color: var(--accent);
    }
    .detail-filters input[type="search"] {
      margin-left: auto;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 12px;
      padding: 4px 10px;
      outline: none;
      min-width: 150px;
    }
    .detail-filters input[type="search"]:focus { border-color: var(--accent); }

    .table-wrapper { overflow-y: auto; flex: 1; }
    table { width: 100%; border-collapse: collapse; }
    th {
      text-align: left;
      font-size: 11px;
      color: var(--text-muted);
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
      user-select: none;
      position: sticky;
      top: 0;
      background: var(--bg-surface);
      z-index: 1;
    }
    th.sortable { cursor: pointer; }
    th.sortable:hover { color: var(--text-secondary); }
    td {
      font-size: 13px;
      color: var(--text-primary);
      padding: 6px 12px;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: var(--bg-elevated); }
    .desc-cell {
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .date-cell {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-muted);
      white-space: nowrap;
    }
    .tags-cell { white-space: nowrap; }
    .empty-row {
      text-align: center;
      color: var(--text-muted);
      padding: 20px 12px !important;
      font-style: italic;
    }
    .tag {
      display: inline-block;
      padding: 1px 7px;
      border-radius: 10px;
      font-size: 11px;
      background: var(--bg-elevated);
      color: var(--text-secondary);
      border: 1px solid var(--border);
      margin-right: 3px;
    }
    .tag-more {
      color: var(--text-muted);
      background: transparent;
      border-color: transparent;
    }

    /* ── Popup wrapper: only render when we have a record ─────────────────── */
    .popup-wrapper { display: contents; }
  `],
  template: `
    <!-- ═══ Space selector ══════════════════════════════════════════════════ -->
    @if (!isEmbedded() && spaces().length > 0) {
      <div class="space-tabs">
        @for (s of spaces(); track s.id) {
          <button class="space-chip" [class.active]="activeSpaceId() === s.id" (click)="onSpaceChange(s.id)">{{ s.label }}</button>
        }
      </div>
    }

    <!-- ═══ Toolbar ════════════════════════════════════════════════════════ -->
    <div class="graph-toolbar">
      <div class="search-wrapper">
        <app-entity-search
          mode="bar"
          [spaceId]="activeSpaceId()"
          placeholder="🔍  Search entity…"
          defaultMode="semantic"
          (selected)="selectRoot($event)"
          (queryChange)="onSearchQueryChange($event)"
        />
      </div>

      <div class="toolbar-divider"></div>

      <div class="depth-control">
        <span class="toolbar-label">Depth</span>
        <input type="range" min="1" max="10" [ngModel]="depth()" (ngModelChange)="onDepthChange($event)" />
        <span class="depth-value">{{ depth() }}</span>
      </div>

      <div class="pill-group">
        <button [class.active]="direction() === 'outbound'" (click)="setDirection('outbound')">Out</button>
        <button [class.active]="direction() === 'inbound'" (click)="setDirection('inbound')">In</button>
        <button [class.active]="direction() === 'both'"    (click)="setDirection('both')">Both</button>
      </div>

      <div class="pill-group">
        <button [class.active]="!hideLabels()" (click)="onHideLabelsChange(!hideLabels())" title="Toggle edge labels">Labels</button>
      </div>

      <div class="toolbar-spacer"></div>

      @if (rootEntity()) {
        <span class="graph-stats">{{ nodeCount() }} nodes · {{ edgeCount() }} edges</span>
      }
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

      @if (loading()) {
        <div class="loading-overlay"><div class="loading-spinner"></div></div>
      }

      @if (!rootEntity() && !loading()) {
        <div class="canvas-empty">
          <div class="empty-icon">◎</div>
          <h3>Search for an entity to start exploring</h3>
          <p>Tap nodes to inspect · double-tap to re-root</p>
        </div>
      }

      <div #cyContainer class="cy-container" [style.visibility]="rootEntity() ? 'visible' : 'hidden'"></div>


    <!-- ═══ Detail panel ═════════════════════════════════════════════════ -->
      <!-- ── Detail panel (slides over canvas bottom) ──────────────────── -->
      @if (selectedNode()) {
        <div class="detail-panel">
          <div class="detail-header">
            <div class="detail-title">
              <span class="detail-node-badge" [style.background]="nodeColor()"></span>
              <h3>{{ selectedNode()!.name }}</h3>
              <span class="badge">{{ selectedNode()!.type || 'entity' }}</span>
            </div>
            <div class="detail-header-actions">
              <button class="btn btn-sm btn-ghost" (click)="openEntityPopup(selectedNode()!)">👁 View</button>
              <button class="icon-btn" title="Close panel" (click)="selectedNode.set(null)">✕</button>
            </div>
          </div>

          <div class="detail-filters">
            <div class="pill-group">
              <button [class.active]="detailTypeFilter() === 'all'"    (click)="detailTypeFilter.set('all')">All <span class="count-chip">{{ allDetails().length }}</span></button>
              <button [class.active]="detailTypeFilter() === 'memory'" (click)="detailTypeFilter.set('memory')">Memory <span class="count-chip">{{ nodeMemories().length }}</span></button>
              <button [class.active]="detailTypeFilter() === 'chrono'" (click)="detailTypeFilter.set('chrono')">Chrono <span class="count-chip">{{ nodeChrono().length }}</span></button>
            </div>
            <input type="search" placeholder="Filter…"
                   [ngModel]="detailDescFilter()" (ngModelChange)="detailDescFilter.set($event)" />
          </div>

          <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th class="sortable" (click)="toggleSort('description')">Description {{ sortArrow('description') }}</th>
                  <th>Tags</th>
                  <th class="sortable" (click)="toggleSort('createdAt')">Created {{ sortArrow('createdAt') }}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (row of filteredDetails(); track row.id) {
                  <tr>
                    <td><span class="badge" [class.badge-blue]="row.kind === 'memory'" [class.badge-purple]="row.kind === 'chrono'">{{ row.kind }}</span></td>
                    <td class="desc-cell" [title]="row.description">{{ row.description }}</td>
                    <td class="tags-cell">
                      @for (t of row.tags.slice(0, 3); track t) { <span class="tag">{{ t }}</span> }
                      @if (row.tags.length > 3) { <span class="tag tag-more">+{{ row.tags.length - 3 }}</span> }
                    </td>
                    <td class="date-cell">{{ row.createdAt | date:'dd.MM.yyyy' }}</td>
                    <td><button class="icon-btn" (click)="openDetailPopup(row)" title="View record">👁</button></td>
                  </tr>
                } @empty {
                  <tr><td colspan="5" class="empty-row">No records for this node</td></tr>
                }
              </tbody>
            </table>
          </div>
        </div>
      }
    </div>

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

  // ── Embedded input ──────────────────────────────────────────────────────────
  @Input() set embeddedSpaceId(v: string | undefined) {
    if (v !== undefined) {
      this.isEmbedded.set(true);
      const changed = this.activeSpaceId() !== v;
      this.activeSpaceId.set(v);
      if (changed && this.cy) this.resetGraph();
    }
  }

  // ── State signals ───────────────────────────────────────────────────────────
  isEmbedded = signal(false);

  spaces = signal<Space[]>([]);
  activeSpaceId = signal('');
  searchQuery = signal('');

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

  nodeCount = signal(0);
  edgeCount = signal(0);

  popupRecord = signal<Record<string, unknown> | null>(null);
  popupType = signal<'entity' | 'edge' | 'memory' | 'chrono'>('entity');
  canEdit = signal(false);

  loading = signal(false);

  // ── Computed ────────────────────────────────────────────────────────────────
  allDetails = computed<DetailRow[]>(() => {
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

  nodeColor = computed(() => {
    const n = this.selectedNode();
    return n ? typeColor(n.type || 'default') : '#8b949e';
  });

  // ── Private state ───────────────────────────────────────────────────────────
  private cy: any = null;
  private subs = new Subscription();

  // Currently rendered (depth-filtered) view
  private graphNodes: TraverseNode[] = [];
  private graphEdges: TraverseEdge[] = [];

  // Full-depth traversal cache — avoids re-fetching shallower depths
  private cacheStartId: string | null = null;
  private cacheDirection: 'outbound' | 'inbound' | 'both' | null = null;
  private cacheMaxDepth = 0;
  private cacheNodes: TraverseNode[] = [];
  private cacheEdges: TraverseEdge[] = [];
  private cacheTruncated = false;

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  ngOnInit(): void {
    // Load spaces only in standalone mode; in embedded mode the space is injected via @Input
    if (!this.isEmbedded()) {
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
    }

    this.api.getMe().pipe(catchError(() => of(null))).subscribe(me => {
      this.canEdit.set(me ? !me.readOnly : false);
    });
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
            'width': (ele: any) => { const d = +ele.data('depth'); return d === 0 ? 64 : Math.max(34, 48 - d * 3); },
            'height': (ele: any) => { const d = +ele.data('depth'); return d === 0 ? 64 : Math.max(34, 48 - d * 3); },
            'background-color': '#161b22',
            'border-width': (ele: any) => +ele.data('depth') === 0 ? 4 : 3,
            'border-color': (ele: any) => typeColor(ele.data('type') || 'default'),
            'label': 'data(label)',
            'font-size': (ele: any) => +ele.data('depth') === 0 ? 13 : 11,
            'font-weight': (ele: any) => +ele.data('depth') === 0 ? '600' : '400',
            'color': '#c9d1d9',
            'text-outline-color': '#0d1117',
            'text-outline-width': 2,
            'text-valign': 'bottom',
            'text-margin-y': 7,
            'text-max-width': '110px',
            'text-wrap': 'ellipsis',
            'opacity': (ele: any) => { const d = +ele.data('depth'); return d === 0 ? 1 : Math.max(0.55, 1 - d * 0.1); },
          } as any,
        },
        {
          selector: 'node.root',
          style: {
            'border-color': '#7c6af7',
            'border-width': 5,
          } as any,
        },
        {
          selector: 'node.hovered',
          style: {
            'border-color': '#58a6ff',
            'border-width': 4,
            'opacity': 1,
          } as any,
        },
        {
          selector: 'node:selected',
          style: {
            'border-color': '#58a6ff',
            'border-width': 4,
            'opacity': 1,
          } as any,
        },
        {
          selector: 'edge',
          style: {
            'width': 1.5,
            'line-color': '#3d444d',
            'target-arrow-shape': 'triangle',
            'target-arrow-color': '#3d444d',
            'curve-style': 'bezier',
            'label': 'data(label)',
            'font-size': 10,
            'color': '#6e7681',
            'text-rotation': 'autorotate',
            'text-margin-y': -8,
            'text-background-color': '#0d1117',
            'text-background-opacity': 0.7,
            'text-background-padding': '2px',
            'opacity': 0.75,
          } as any,
        },
        {
          selector: 'edge.hovered',
          style: {
            'line-color': '#58a6ff',
            'target-arrow-color': '#58a6ff',
            'opacity': 1,
            'width': 2.5,
          } as any,
        },
        {
          selector: 'edge:selected',
          style: {
            'line-color': '#7c6af7',
            'target-arrow-color': '#7c6af7',
            'opacity': 1,
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
      minZoom: 0.1,
      maxZoom: 5,
      wheelSensitivity: 0.25,
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

    // Hover effects
    this.cy.on('mouseover', 'node', (evt: any) => { evt.target.addClass('hovered'); });
    this.cy.on('mouseout',  'node', (evt: any) => { evt.target.removeClass('hovered'); });
    this.cy.on('mouseover', 'edge', (evt: any) => { evt.target.addClass('hovered'); });
    this.cy.on('mouseout',  'edge', (evt: any) => { evt.target.removeClass('hovered'); });

    // Background tap → deselect node
    this.cy.on('tap', (evt: any) => {
      if (evt.target === this.cy) {
        this.selectedNode.set(null);
      }
    });
  }

  // ── Toolbar handlers ────────────────────────────────────────────────────────

  onSearchQueryChange(q: string): void {
    this.searchQuery.set(q);
  }

  onSpaceChange(spaceId: string): void {
    this.activeSpaceId.set(spaceId);
    this.resetGraph();
  }

  onSearchInput(query: string): void {
    this.searchQuery.set(query);
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
    this.nodeMemories.set([]);
    this.nodeChrono.set([]);
    this.searchQuery.set('');
    this.truncated.set(false);
    this.graphNodes = [];
    this.graphEdges = [];
    this.cacheStartId = null;
    this.cacheDirection = null;
    this.cacheMaxDepth = 0;
    this.cacheNodes = [];
    this.cacheEdges = [];
    this.cacheTruncated = false;
    this.overlays.set([]);
    if (this.cy) {
      this.cy.elements().remove();
    }
  }

  // ── Graph traversal ─────────────────────────────────────────────────────────

  private traverse(startId: string, maxDepth: number, direction: 'outbound' | 'inbound' | 'both'): void {
    const spaceId = this.activeSpaceId();
    if (!spaceId) return;

    this.selectedNode.set(null);

    const sameRoot = this.cacheStartId === startId && this.cacheDirection === direction;

    // Depth decrease (or same depth): serve from cache — no network request needed
    if (sameRoot && maxDepth <= this.cacheMaxDepth) {
      this.applyDepthFilter(startId, maxDepth);
      return;
    }

    // Depth increase into an un-truncated cache: fetch only the new frontier and merge
    const incremental = sameRoot && maxDepth > this.cacheMaxDepth && !this.cacheTruncated;

    this.loading.set(true);
    this.api.traverseGraph(spaceId, { startId, direction, maxDepth, limit: 200 }).pipe(
      catchError(() => of({ nodes: [], edges: [], truncated: false } as TraverseResult)),
    ).subscribe(result => {
      this.loading.set(false);

      if (incremental) {
        // Merge only the new nodes/edges into the existing cache
        const knownNodes = new Set(this.cacheNodes.map(n => n._id));
        const knownEdges = new Set(this.cacheEdges.map(e => e._id));
        for (const n of result.nodes) if (!knownNodes.has(n._id)) this.cacheNodes.push(n);
        for (const e of result.edges) if (!knownEdges.has(e._id)) this.cacheEdges.push(e);
      } else {
        this.cacheNodes = result.nodes;
        this.cacheEdges = result.edges;
      }

      this.cacheStartId = startId;
      this.cacheDirection = direction;
      this.cacheMaxDepth = maxDepth;
      this.cacheTruncated = result.truncated;

      this.truncated.set(result.truncated);
      this.applyDepthFilter(startId, maxDepth);
    });
  }

  // Filter the full cache down to the requested depth and re-render
  private applyDepthFilter(startId: string, maxDepth: number): void {
    this.graphNodes = this.cacheNodes.filter(n => n.depth <= maxDepth);
    const visibleIds = new Set<string>(this.graphNodes.map(n => n._id));
    visibleIds.add(startId);  // root node always included
    this.graphEdges = this.cacheEdges.filter(e => visibleIds.has(e.from) && visibleIds.has(e.to));
    this.renderGraph(startId);
  }

  private renderGraph(rootId: string): void {
    if (!this.cy) return;

    this.cy.resize();  // ensure canvas matches current container dimensions
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
    this.nodeCount.set(elements.filter((e: any) => e.group === 'nodes').length);
    this.edgeCount.set(elements.filter((e: any) => e.group === 'edges').length);

    // Apply hide-labels class to edges
    if (this.hideLabels()) {
      this.cy.edges().addClass('hide-labels');
    } else {
      this.cy.edges().removeClass('hide-labels');
    }

    // Run layout
    const layout = this.cy.layout({
      name: 'cose',
      animate: true,
      animationDuration: 400,
      nodeRepulsion: () => 8000,
      idealEdgeLength: () => 120,
      gravity: 0.3,
      padding: 40,
    } as any);

    layout.on('layoutstop', () => this.fitGraph());
    layout.run();
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

  sortArrow(field: 'description' | 'createdAt'): string {
    return this.sortField() === field ? (this.sortAsc() ? '▲' : '▼') : '';
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
