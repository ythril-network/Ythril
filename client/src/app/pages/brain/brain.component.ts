import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService, Space, SpaceStats, Memory, Entity, Edge } from '../../core/api.service';

type BrainTab = 'memories' | 'entities' | 'edges';

interface SpaceView {
  space: Space;
  stats?: SpaceStats;
}

@Component({
  selector: 'app-brain',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  styles: [`
    .space-tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 24px;
      flex-wrap: wrap;
    }

    .space-chip {
      padding: 6px 14px;
      border-radius: 20px;
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
    }

    .space-chip:hover { border-color: var(--accent); color: var(--text-primary); }

    .space-chip.active {
      background: var(--accent-dim);
      border-color: var(--accent);
      color: var(--accent);
    }

    .space-chip-label { font-size: 13px; font-weight: 500; }
    .space-chip-id { font-size: 10px; color: var(--text-muted); }

    .content-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }

    .stat-pills {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 20px;
    }

    .stat-pill {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      border: 1px solid var(--border);
      border-radius: 20px;
      font-size: 12px;
      color: var(--text-secondary);
      background: var(--bg-surface);
    }

    .stat-pill strong { color: var(--text-primary); font-size: 13px; }

    .memory-item {
      padding: 14px 16px;
      border: 1px solid var(--border-muted);
      border-radius: var(--radius-md);
      margin-bottom: 8px;
      background: var(--bg-surface);
      transition: border-color var(--transition);
    }

    .memory-item:hover { border-color: var(--border); }

    .memory-content {
      font-size: 13px;
      color: var(--text-primary);
      line-height: 1.6;
      margin-bottom: 8px;
    }

    .memory-meta {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .memory-meta time { font-size: 11px; color: var(--text-muted); }

    .filter-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 12px;
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
    }
    .filter-bar-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
    .filter-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 10px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 500;
      border: 1px solid var(--accent);
      background: var(--accent-dim);
      color: var(--accent);
    }
    .filter-chip button {
      background: none;
      border: none;
      color: var(--accent);
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 0 2px;
    }
    .tag-clickable, .entity-clickable {
      cursor: pointer;
      transition: opacity var(--transition);
    }
    .tag-clickable:hover, .entity-clickable:hover { opacity: 0.7; }
  `],
  template: `
    <div class="page-header">
      <h1 class="page-title">Brain</h1>
      <p class="page-subtitle">Browse memories, entities, and knowledge graph edges.</p>
    </div>

    @if (loadingSpaces()) {
      <div class="loading-overlay"><span class="spinner"></span> Loading spaces…</div>
    } @else if (spaces().length === 0) {
      <div class="empty-state">
        <div class="empty-state-icon">📦</div>
        <h3>No spaces yet</h3>
        <p>Create a space in <a routerLink="/settings/spaces">Settings → Spaces</a>.</p>
      </div>
    } @else {

      <!-- Space selector -->
      <div class="space-tabs">
        @for (sv of spaces(); track sv.space.id) {
          <button
            class="space-chip"
            [class.active]="activeSpaceId() === sv.space.id"
            (click)="selectSpace(sv.space.id)"
          >
            <span class="space-chip-label">{{ sv.space.label }}</span>
            <span class="space-chip-id">{{ sv.space.id }}</span>
          </button>
        }
      </div>

      @if (activeStats(); as stats) {
        <div class="stat-pills">
          <span class="stat-pill"><strong>{{ stats.memories }}</strong> memories</span>
          <span class="stat-pill"><strong>{{ stats.entities }}</strong> entities</span>
          <span class="stat-pill"><strong>{{ stats.edges }}</strong> edges</span>
        </div>
      }

      <!-- Sub-tabs -->
      <div class="tabs">
        @for (tab of tabs; track tab.key) {
          <button class="tab" [class.active]="activeTab() === tab.key" (click)="setTab(tab.key)">
            {{ tab.label }}
          </button>
        }
      </div>

      <!-- Content -->
      @if (loading()) {
        <div class="loading-overlay"><span class="spinner"></span></div>
      } @else {

        <!-- Memories -->
        @if (activeTab() === 'memories') {

          @if (filterTag() || filterEntity()) {
            <div class="filter-bar">
              <span class="filter-bar-label">Filters</span>
              @if (filterTag(); as tag) {
                <span class="filter-chip">tag: {{ tag }} <button (click)="clearFilter('tag')">✕</button></span>
              }
              @if (filterEntity(); as ent) {
                <span class="filter-chip">entity: {{ ent }} <button (click)="clearFilter('entity')">✕</button></span>
              }
              <button class="btn-secondary btn btn-sm" (click)="clearFilter('all')">Clear all</button>
            </div>
          }

          <div class="content-header">
            <span style="font-size:13px; color:var(--text-secondary);">
              Showing {{ memories().length }} memories (skip {{ skip() }})
            </span>
            <span style="flex:1"></span>
            <button class="btn-secondary btn btn-sm" [disabled]="skip() === 0" (click)="prevPage()">← Prev</button>
            <button class="btn-secondary btn btn-sm" [disabled]="memories().length < pageSize" (click)="nextPage()">Next →</button>
          </div>

          @for (mem of memories(); track mem._id) {
            <div class="memory-item">
              <div class="memory-content">{{ mem.content ?? mem.fact }}</div>
              <div class="memory-meta">
                @for (tag of (mem.tags ?? []); track tag) {
                  <span class="tag tag-clickable" (click)="applyFilter('tag', tag)">{{ tag }}</span>
                }
                @for (eid of (mem.entityIds ?? []); track eid) {
                  <span class="badge badge-purple entity-clickable" (click)="applyFilter('entity', eid)">{{ eid }}</span>
                }
                <span style="flex:1"></span>
                <time>{{ mem.createdAt | date:'MMM d, y HH:mm' }}</time>
                <button class="icon-btn danger" title="Delete memory" (click)="deleteMemory(mem._id)">✕</button>
              </div>
            </div>
          }

          @if (memories().length === 0) {
            <div class="empty-state">
              <div class="empty-state-icon">🧠</div>
              <h3>No memories</h3>
              <p>Memories will appear here once written by an MCP client.</p>
            </div>
          }
        }

        <!-- Entities -->
        @if (activeTab() === 'entities') {
          <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Name</th><th>Type</th><th>Created</th><th></th>
                </tr>
              </thead>
              <tbody>
                @for (ent of entities(); track ent._id) {
                  <tr>
                    <td>{{ ent.name }}</td>
                    <td>
                      @if (ent.type) { <span class="badge badge-purple">{{ ent.type }}</span> }
                    </td>
                    <td style="color:var(--text-muted)">{{ ent.createdAt | date:'MMM d, y' }}</td>
                    <td><button class="icon-btn danger" (click)="deleteEntity(ent._id)">✕</button></td>
                  </tr>
                } @empty {
                  <tr><td colspan="4">
                    <div class="empty-state" style="padding:32px">
                      <div class="empty-state-icon">🏷️</div>
                      <h3>No entities</h3>
                    </div>
                  </td></tr>
                }
              </tbody>
            </table>
          </div>
        }

        <!-- Edges -->
        @if (activeTab() === 'edges') {
          <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>From</th><th>Relation</th><th>Type</th><th>To</th><th>Weight</th><th>Created</th><th></th>
                </tr>
              </thead>
              <tbody>
                @for (edge of edges(); track edge._id) {
                  <tr>
                    <td class="mono" style="font-size:12px">{{ edge.from }}</td>
                    <td><span class="badge badge-blue">{{ edge.label }}</span></td>
                    <td style="color:var(--text-muted); font-size:12px">{{ edge.type ?? '—' }}</td>
                    <td class="mono" style="font-size:12px">{{ edge.to }}</td>
                    <td style="color:var(--text-muted)">{{ edge.weight ?? '—' }}</td>
                    <td style="color:var(--text-muted)">{{ edge.createdAt | date:'MMM d, y' }}</td>
                    <td><button class="icon-btn danger" (click)="deleteEdge(edge._id)">✕</button></td>
                  </tr>
                } @empty {
                  <tr><td colspan="7">
                    <div class="empty-state" style="padding:32px">
                      <div class="empty-state-icon">🕸️</div>
                      <h3>No edges</h3>
                    </div>
                  </td></tr>
                }
              </tbody>
            </table>
          </div>
        }

      }
    }
  `,
})
export class BrainComponent implements OnInit {
  private api = inject(ApiService);

  tabs: { key: BrainTab; label: string }[] = [
    { key: 'memories', label: 'Memories' },
    { key: 'entities', label: 'Entities' },
    { key: 'edges', label: 'Edges' },
  ];

  readonly pageSize = 20;

  spaces = signal<SpaceView[]>([]);
  activeSpaceId = signal('');
  activeTab = signal<BrainTab>('memories');
  loading = signal(false);
  loadingSpaces = signal(true);

  memories = signal<Memory[]>([]);
  entities = signal<Entity[]>([]);
  edges = signal<Edge[]>([]);
  skip = signal(0);
  filterTag = signal('');
  filterEntity = signal('');

  activeStats = computed(() =>
    this.spaces().find(sv => sv.space.id === this.activeSpaceId())?.stats,
  );

  ngOnInit(): void {
    this.api.listSpaces().subscribe({
      next: ({ spaces }) => {
        this.spaces.set(spaces.map(s => ({ space: s })));
        this.loadingSpaces.set(false);
        if (spaces.length > 0) {
          this.selectSpace(spaces[0].id);
        }
      },
      error: () => this.loadingSpaces.set(false),
    });
  }

  selectSpace(id: string): void {
    this.activeSpaceId.set(id);
    this.skip.set(0);
    this.filterTag.set('');
    this.filterEntity.set('');
    this.loadStats(id);
    this.loadCurrentTab(id);
  }

  setTab(tab: BrainTab): void {
    this.activeTab.set(tab);
    this.skip.set(0);
    this.filterTag.set('');
    this.filterEntity.set('');
    this.loadCurrentTab(this.activeSpaceId());
  }

  prevPage(): void {
    this.skip.update(s => Math.max(0, s - this.pageSize));
    this.loadCurrentTab(this.activeSpaceId());
  }

  nextPage(): void {
    this.skip.update(s => s + this.pageSize);
    this.loadCurrentTab(this.activeSpaceId());
  }

  private loadStats(spaceId: string): void {
    this.api.getSpaceStats(spaceId).subscribe({
      next: (stats) => {
        this.spaces.update(list =>
          list.map(sv => sv.space.id === spaceId ? { ...sv, stats } : sv),
        );
      },
    });
  }

  private loadCurrentTab(spaceId: string): void {
    if (!spaceId) return;
    this.loading.set(true);

    switch (this.activeTab()) {
      case 'memories': {
        const filters: { tag?: string; entity?: string } = {};
        if (this.filterTag()) filters.tag = this.filterTag();
        if (this.filterEntity()) filters.entity = this.filterEntity();
        this.api.listMemories(spaceId, this.pageSize, this.skip(), filters).subscribe({
          next: ({ memories }) => { this.memories.set(memories); this.loading.set(false); },
          error: () => this.loading.set(false),
        });
        break;
      }
      case 'entities':
        this.api.listEntities(spaceId).subscribe({
          next: ({ entities }) => { this.entities.set(entities); this.loading.set(false); },
          error: () => this.loading.set(false),
        });
        break;
      case 'edges':
        this.api.listEdges(spaceId).subscribe({
          next: ({ edges }) => { this.edges.set(edges); this.loading.set(false); },
          error: () => this.loading.set(false),
        });
        break;
    }
  }

  applyFilter(type: 'tag' | 'entity', value: string): void {
    if (type === 'tag') this.filterTag.set(value);
    else this.filterEntity.set(value);
    this.skip.set(0);
    this.loadCurrentTab(this.activeSpaceId());
  }

  clearFilter(which: 'tag' | 'entity' | 'all'): void {
    if (which === 'tag' || which === 'all') this.filterTag.set('');
    if (which === 'entity' || which === 'all') this.filterEntity.set('');
    this.skip.set(0);
    this.loadCurrentTab(this.activeSpaceId());
  }

  deleteMemory(id: string): void {
    if (!confirm('Delete this memory?')) return;
    this.api.deleteMemory(this.activeSpaceId(), id).subscribe({
      next: () => {
        this.memories.update(list => list.filter(m => m._id !== id));
        this.loadStats(this.activeSpaceId());
      },
    });
  }

  deleteEntity(id: string): void {
    if (!confirm('Delete this entity?')) return;
    this.api.deleteEntity(this.activeSpaceId(), id).subscribe({
      next: () => {
        this.entities.update(list => list.filter(e => e._id !== id));
        this.loadStats(this.activeSpaceId());
      },
    });
  }

  deleteEdge(id: string): void {
    if (!confirm('Delete this edge?')) return;
    this.api.deleteEdge(this.activeSpaceId(), id).subscribe({
      next: () => this.edges.update(list => list.filter(e => e._id !== id)),
    });
  }
}
