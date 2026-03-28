import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService, Space, SpaceStats, Memory, Entity, Edge, ChronoEntry, ChronoKind, ChronoStatus } from '../../core/api.service';

type BrainTab = 'memories' | 'entities' | 'edges' | 'chrono';

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

    .wipe-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
      padding: 10px 14px;
      border: 1px solid var(--error);
      border-radius: var(--radius-md);
      background: color-mix(in srgb, var(--error) 6%, transparent);
    }
    .wipe-bar input {
      padding: 4px 8px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: 13px;
      background: var(--bg-surface);
      color: var(--text-primary);
    }

    .create-form {
      display: flex;
      gap: 10px;
      align-items: flex-end;
      flex-wrap: wrap;
      padding: 12px 14px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
      margin-bottom: 12px;
    }
    .create-form .field { margin-bottom: 0; }
    .create-form label { font-size: 11px; color: var(--text-muted); display: block; margin-bottom: 2px; }
    .create-form input, .create-form textarea {
      padding: 5px 8px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: 13px;
      background: var(--bg-primary);
      color: var(--text-primary);
    }
    .create-form textarea { resize: vertical; }

    .chrono-desc-preview {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 2px;
      white-space: pre-wrap;
      max-width: 280px;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
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

          <!-- Add memory form -->
          @if (showMemoryForm()) {
            <form class="create-form" (ngSubmit)="createMemory()">
              <div class="field" style="flex:2; min-width:200px;">
                <label>Fact</label>
                <textarea [(ngModel)]="memoryForm.fact" name="fact" rows="2" placeholder="Something to remember…" required style="width:100%;"></textarea>
              </div>
              <div class="field" style="flex:1; min-width:140px;">
                <label>Tags (comma-separated)</label>
                <input type="text" [(ngModel)]="memoryForm.tags" name="tags" placeholder="tag1, tag2" />
              </div>
              <div class="field" style="flex:1; min-width:140px;">
                <label>Entity IDs (comma-separated)</label>
                <input type="text" [(ngModel)]="memoryForm.entityIds" name="entityIds" placeholder="entity-id-1" />
              </div>
              <button class="btn-primary btn btn-sm" type="submit" [disabled]="creatingMemory() || !memoryForm.fact.trim()">
                @if (creatingMemory()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
                Save
              </button>
              <button class="btn-secondary btn btn-sm" type="button" (click)="showMemoryForm.set(false)">Cancel</button>
            </form>
          }

          @if (createMemoryError()) {
            <div class="alert alert-error" style="margin-bottom:12px;">{{ createMemoryError() }}</div>
          }

          @if (filterTag() || filterEntity()) {
            <div class="filter-bar">
              <span class="filter-bar-label">Filters</span>
              @if (filterTag(); as tag) {
                <span class="filter-chip">tag: {{ tag }} <button aria-label="Clear tag filter" (click)="clearFilter('tag')">✕</button></span>
              }
              @if (filterEntity(); as ent) {
                <span class="filter-chip">entity: {{ ent }} <button aria-label="Clear entity filter" (click)="clearFilter('entity')">✕</button></span>
              }
              <button class="btn-secondary btn btn-sm" (click)="clearFilter('all')">Clear all</button>
            </div>
          }

          @if (showWipeConfirm()) {
            <div class="wipe-bar">
              <span style="font-size:13px; color:var(--error); font-weight:500;">
                Type <strong>{{ activeSpaceId() }}</strong> to confirm wipe of all {{ activeStats()?.memories ?? '?' }} memories:
              </span>
              <input
                [value]="wipeInput()"
                (input)="wipeInput.set($any($event.target).value)"
                placeholder="space id"
                aria-label="Type space ID to confirm wipe"
              />
              <button
                class="btn btn-danger btn-sm"
                [disabled]="wipeInput() !== activeSpaceId() || wipingInProgress()"
                (click)="executeWipe()"
              >
                {{ wipingInProgress() ? 'Wiping…' : 'Confirm wipe' }}
              </button>
              <button class="btn-secondary btn btn-sm" (click)="showWipeConfirm.set(false); wipeInput.set('')">Cancel</button>
            </div>
          }

          <div class="content-header">
            <span style="font-size:13px; color:var(--text-secondary);">
              Showing {{ memories().length }} memories (skip {{ skip() }})
            </span>
            <span style="flex:1"></span>
            <button class="btn-secondary btn btn-sm" [disabled]="skip() === 0" (click)="prevPage()">← Prev</button>
            <button class="btn-secondary btn btn-sm" [disabled]="memories().length < pageSize" (click)="nextPage()">Next →</button>
            <button
              class="btn-primary btn btn-sm"
              (click)="showMemoryForm.set(true)"
              [disabled]="showMemoryForm()"
            >+ Add memory</button>
            <button
              class="btn btn-danger btn-sm"
              [disabled]="!activeStats()?.memories"
              (click)="showWipeConfirm.set(true)"
              title="Wipe all memories in this space"
            >Wipe all</button>
          </div>

          @for (mem of memories(); track mem._id) {
            <div class="memory-item">
              <div class="memory-content">{{ mem.fact }}</div>
              <div class="memory-meta">
                @for (tag of (mem.tags ?? []); track tag) {
                  <span class="tag tag-clickable" (click)="applyFilter('tag', tag)">{{ tag }}</span>
                }
                @for (eid of (mem.entityIds ?? []); track eid) {
                  <span class="badge badge-purple entity-clickable" (click)="applyFilter('entity', eid)">{{ eid }}</span>
                }
                <span style="flex:1"></span>
                <time>{{ mem.createdAt | date:'MMM d, y HH:mm' }}</time>
                <button class="icon-btn danger" title="Delete memory" aria-label="Delete memory" (click)="deleteMemory(mem._id)">✕</button>
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

          <div style="margin-bottom:12px; display:flex; gap:8px;">
            <button class="btn-primary btn btn-sm" (click)="showEntityForm.set(true)" [disabled]="showEntityForm()">+ Add entity</button>
          </div>

          @if (showEntityForm()) {
            <form class="create-form" (ngSubmit)="createEntity()">
              <div class="field" style="flex:1; min-width:140px;">
                <label>Name</label>
                <input type="text" [(ngModel)]="entityForm.name" name="name" placeholder="Kubernetes" required />
              </div>
              <div class="field" style="width:140px;">
                <label>Type (optional)</label>
                <input type="text" [(ngModel)]="entityForm.type" name="type" placeholder="technology" />
              </div>
              <div class="field" style="flex:1; min-width:140px;">
                <label>Tags (comma-separated)</label>
                <input type="text" [(ngModel)]="entityForm.tags" name="tags" placeholder="infra, devops" />
              </div>
              <div class="field" style="flex:1; min-width:180px;">
                <label>Properties (JSON)</label>
                <input type="text" [(ngModel)]="entityForm.properties" name="properties" placeholder='{"wheels": 4, "color": "red"}' />
              </div>
              <button class="btn-primary btn btn-sm" type="submit" [disabled]="creatingEntity() || !entityForm.name.trim()">
                @if (creatingEntity()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
                Save
              </button>
              <button class="btn-secondary btn btn-sm" type="button" (click)="showEntityForm.set(false)">Cancel</button>
            </form>
          }

          @if (createEntityError()) {
            <div class="alert alert-error" style="margin-bottom:12px;">{{ createEntityError() }}</div>
          }
          <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Name</th><th>Type</th><th>Properties</th><th>Created</th><th></th>
                </tr>
              </thead>
              <tbody>
                @for (ent of entities(); track ent._id) {
                  <tr>
                    <td>{{ ent.name }}</td>
                    <td>
                      @if (ent.type) { <span class="badge badge-purple">{{ ent.type }}</span> }
                    </td>
                    <td style="font-size:12px; color:var(--text-muted); max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" [title]="formatProps(ent.properties)">
                      {{ formatProps(ent.properties) }}
                    </td>
                    <td style="color:var(--text-muted)">{{ ent.createdAt | date:'MMM d, y' }}</td>
                    <td><button class="icon-btn danger" aria-label="Delete entity" (click)="deleteEntity(ent._id)">✕</button></td>
                  </tr>
                } @empty {
                  <tr><td colspan="5">
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

          <div style="margin-bottom:12px; display:flex; gap:8px;">
            <button class="btn-primary btn btn-sm" (click)="showEdgeForm.set(true)" [disabled]="showEdgeForm()">+ Add edge</button>
          </div>

          @if (showEdgeForm()) {
            <form class="create-form" (ngSubmit)="createEdge()">
              <div class="field" style="flex:1; min-width:120px;">
                <label>From</label>
                <input type="text" [(ngModel)]="edgeForm.from" name="from" placeholder="Entity A" required />
              </div>
              <div class="field" style="flex:1; min-width:120px;">
                <label>Label (relation)</label>
                <input type="text" [(ngModel)]="edgeForm.label" name="label" placeholder="depends_on" required />
              </div>
              <div class="field" style="flex:1; min-width:120px;">
                <label>To</label>
                <input type="text" [(ngModel)]="edgeForm.to" name="to" placeholder="Entity B" required />
              </div>
              <div class="field" style="width:100px;">
                <label>Type (optional)</label>
                <input type="text" [(ngModel)]="edgeForm.type" name="type" placeholder="causal" />
              </div>
              <div class="field" style="width:80px;">
                <label>Weight</label>
                <input type="number" [(ngModel)]="edgeForm.weight" name="weight" step="0.1" placeholder="—" />
              </div>
              <button class="btn-primary btn btn-sm" type="submit" [disabled]="creatingEdge() || !edgeForm.from.trim() || !edgeForm.to.trim() || !edgeForm.label.trim()">
                @if (creatingEdge()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
                Save
              </button>
              <button class="btn-secondary btn btn-sm" type="button" (click)="showEdgeForm.set(false)">Cancel</button>
            </form>
          }

          @if (createEdgeError()) {
            <div class="alert alert-error" style="margin-bottom:12px;">{{ createEdgeError() }}</div>
          }
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
                    <td><button class="icon-btn danger" aria-label="Delete edge" (click)="deleteEdge(edge._id)">✕</button></td>
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

        <!-- Chrono -->
        @if (activeTab() === 'chrono') {

          <div style="margin-bottom:12px; display:flex; gap:8px;">
            <button class="btn-primary btn btn-sm" (click)="showChronoForm.set(true)" [disabled]="showChronoForm()">+ Add entry</button>
          </div>

          @if (showChronoForm()) {
            <form class="create-form" (ngSubmit)="createChrono()">
              <div class="field" style="flex:2; min-width:200px;">
                <label>Title</label>
                <input type="text" [(ngModel)]="chronoForm.title" name="title" placeholder="Release v1.0" required />
              </div>
              <div class="field" style="width:160px;">
                <label>Kind</label>
                @if (chronoForm.kind !== '__custom__') {
                  <select [(ngModel)]="chronoForm.kind" name="kind">
                    @for (k of chronoKinds; track k) { <option [value]="k">{{ k }}</option> }
                    <option value="__custom__">Custom…</option>
                  </select>
                } @else {
                  <div style="display:flex; gap:4px;">
                    <input type="text" [(ngModel)]="chronoForm.customKind" name="customKind" placeholder="my-kind" style="flex:1;" />
                    <button type="button" class="btn-secondary btn btn-sm" style="padding:4px 8px;" (click)="chronoForm.kind = 'event'; chronoForm.customKind = ''" title="Back to presets">✕</button>
                  </div>
                }
              </div>
              <div class="field" style="width:200px;">
                <label>Starts at</label>
                <input type="datetime-local" [(ngModel)]="chronoForm.startsAt" name="startsAt" required />
              </div>
              <div class="field" style="width:200px;">
                <label>Ends at (optional)</label>
                <input type="datetime-local" [(ngModel)]="chronoForm.endsAt" name="endsAt" />
              </div>
              <div class="field" style="flex:1; min-width:200px;">
                <label>Description (optional)</label>
                <textarea [(ngModel)]="chronoForm.description" name="description" placeholder="Add context or details…" rows="3" style="resize:vertical;"></textarea>
              </div>
              <div class="field" style="flex:1; min-width:140px;">
                <label>Tags (comma-separated)</label>
                <input type="text" [(ngModel)]="chronoForm.tags" name="tags" placeholder="release, infra" />
              </div>
              <div class="field" style="flex:1; min-width:140px;">
                <label>Entity IDs (comma-separated, optional)</label>
                <input type="text" [(ngModel)]="chronoForm.entityIds" name="entityIds" placeholder="entity-id-1, entity-id-2" />
              </div>
              <button class="btn-primary btn btn-sm" type="submit" [disabled]="creatingChrono() || !chronoForm.title.trim() || !chronoForm.startsAt || (chronoForm.kind === '__custom__' && !chronoForm.customKind.trim())">
                @if (creatingChrono()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
                Save
              </button>
              <button class="btn-secondary btn btn-sm" type="button" (click)="showChronoForm.set(false)">Cancel</button>
            </form>
          }

          @if (createChronoError()) {
            <div class="alert alert-error" style="margin-bottom:12px;">{{ createChronoError() }}</div>
          }
          <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Title</th><th>Kind</th><th>Status</th><th>Starts</th><th>Ends</th><th>Tags</th><th>Entities</th><th></th>
                </tr>
              </thead>
              <tbody>
                @for (entry of chrono(); track entry._id) {
                  <tr>
                    <td>
                      {{ entry.title }}
                      @if (entry.description) {
                        <div class="chrono-desc-preview" [title]="entry.description">{{ entry.description }}</div>
                      }
                    </td>
                    <td><span class="badge badge-blue">{{ entry.kind }}</span></td>
                    <td><span class="badge" [class.badge-purple]="entry.status === 'upcoming'" [class.badge-blue]="entry.status === 'active'" style="font-size:11px">{{ entry.status }}</span></td>
                    <td style="color:var(--text-muted); font-size:12px">{{ entry.startsAt | date:'MMM d, y HH:mm' }}</td>
                    <td style="color:var(--text-muted); font-size:12px">{{ entry.endsAt ? (entry.endsAt | date:'MMM d, y HH:mm') : '—' }}</td>
                    <td>
                      @for (tag of entry.tags; track tag) { <span class="tag">{{ tag }}</span> }
                    </td>
                    <td style="font-size:11px; color:var(--text-muted);">
                      @if (entry.entityIds.length) {
                        {{ entry.entityIds.length }} linked
                      } @else { — }
                    </td>
                    <td><button class="icon-btn danger" aria-label="Delete chrono entry" (click)="deleteChrono(entry._id)">✕</button></td>
                  </tr>
                } @empty {
                  <tr><td colspan="8">
                    <div class="empty-state" style="padding:32px">
                      <div class="empty-state-icon">⏱️</div>
                      <h3>No chrono entries</h3>
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
    { key: 'chrono', label: 'Chrono' },
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
  chrono = signal<ChronoEntry[]>([]);
  skip = signal(0);
  filterTag = signal('');
  filterEntity = signal('');
  showWipeConfirm = signal(false);
  wipeInput = signal('');
  wipingInProgress = signal(false);

  // Create memory form
  showMemoryForm = signal(false);
  creatingMemory = signal(false);
  createMemoryError = signal('');
  memoryForm = { fact: '', tags: '', entityIds: '' };

  // Create entity form
  showEntityForm = signal(false);
  creatingEntity = signal(false);
  createEntityError = signal('');
  entityForm = { name: '', type: '', tags: '', properties: '' };

  // Create edge form
  showEdgeForm = signal(false);
  creatingEdge = signal(false);
  createEdgeError = signal('');
  edgeForm = { from: '', to: '', label: '', type: '', weight: null as number | null };

  // Create chrono form
  showChronoForm = signal(false);
  creatingChrono = signal(false);
  createChronoError = signal('');
  chronoKinds: ChronoKind[] = ['event', 'deadline', 'plan', 'prediction', 'milestone'];
  chronoForm = { title: '', kind: 'event' as ChronoKind | '__custom__', customKind: '', startsAt: '', endsAt: '', description: '', tags: '', entityIds: '' };

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
      error: () => {},
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
      case 'chrono':
        this.api.listChrono(spaceId).subscribe({
          next: ({ chrono }) => { this.chrono.set(chrono); this.loading.set(false); },
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

  executeWipe(): void {
    const spaceId = this.activeSpaceId();
    if (this.wipeInput() !== spaceId) return;
    this.wipingInProgress.set(true);
    this.api.wipeMemories(spaceId).subscribe({
      next: () => {
        this.wipingInProgress.set(false);
        this.showWipeConfirm.set(false);
        this.wipeInput.set('');
        this.memories.set([]);
        this.loadStats(spaceId);
        this.loadCurrentTab(spaceId);
      },
      error: () => this.wipingInProgress.set(false),
    });
  }

  deleteMemory(id: string): void {
    if (!confirm('Delete this memory?')) return;
    this.api.deleteMemory(this.activeSpaceId(), id).subscribe({
      next: () => {
        this.memories.update(list => list.filter(m => m._id !== id));
        this.loadStats(this.activeSpaceId());
      },
      error: () => alert('Failed to delete memory.'),
    });
  }

  createMemory(): void {
    if (!this.memoryForm.fact.trim()) return;
    this.creatingMemory.set(true);
    this.createMemoryError.set('');
    const tags = this.memoryForm.tags.split(',').map(s => s.trim()).filter(Boolean);
    const entityIds = this.memoryForm.entityIds.split(',').map(s => s.trim()).filter(Boolean);
    const body: { fact: string; tags?: string[]; entityIds?: string[] } = { fact: this.memoryForm.fact.trim() };
    if (tags.length) body.tags = tags;
    if (entityIds.length) body.entityIds = entityIds;
    this.api.createMemory(this.activeSpaceId(), body).subscribe({
      next: () => {
        this.creatingMemory.set(false);
        this.showMemoryForm.set(false);
        this.memoryForm = { fact: '', tags: '', entityIds: '' };
        this.loadStats(this.activeSpaceId());
        this.loadCurrentTab(this.activeSpaceId());
      },
      error: (err) => {
        this.creatingMemory.set(false);
        this.createMemoryError.set(err.error?.error ?? 'Failed to create memory');
      },
    });
  }

  createEntity(): void {
    if (!this.entityForm.name.trim()) return;
    this.creatingEntity.set(true);
    this.createEntityError.set('');
    const tags = this.entityForm.tags.split(',').map(s => s.trim()).filter(Boolean);
    const body: { name: string; type?: string; tags?: string[]; properties?: Record<string, string | number | boolean> } = { name: this.entityForm.name.trim() };
    if (this.entityForm.type.trim()) body.type = this.entityForm.type.trim();
    if (tags.length) body.tags = tags;
    if (this.entityForm.properties.trim()) {
      try {
        body.properties = JSON.parse(this.entityForm.properties.trim());
      } catch {
        this.creatingEntity.set(false);
        this.createEntityError.set('Properties must be valid JSON');
        return;
      }
    }
    this.api.createEntity(this.activeSpaceId(), body).subscribe({
      next: () => {
        this.creatingEntity.set(false);
        this.showEntityForm.set(false);
        this.entityForm = { name: '', type: '', tags: '', properties: '' };
        this.loadStats(this.activeSpaceId());
        this.loadCurrentTab(this.activeSpaceId());
      },
      error: (err) => {
        this.creatingEntity.set(false);
        this.createEntityError.set(err.error?.error ?? 'Failed to create entity');
      },
    });
  }

  createEdge(): void {
    if (!this.edgeForm.from.trim() || !this.edgeForm.to.trim() || !this.edgeForm.label.trim()) return;
    this.creatingEdge.set(true);
    this.createEdgeError.set('');
    const body: { from: string; to: string; label: string; type?: string; weight?: number } = {
      from: this.edgeForm.from.trim(),
      to: this.edgeForm.to.trim(),
      label: this.edgeForm.label.trim(),
    };
    if (this.edgeForm.type.trim()) body.type = this.edgeForm.type.trim();
    if (this.edgeForm.weight != null) body.weight = this.edgeForm.weight;
    this.api.createEdge(this.activeSpaceId(), body).subscribe({
      next: () => {
        this.creatingEdge.set(false);
        this.showEdgeForm.set(false);
        this.edgeForm = { from: '', to: '', label: '', type: '', weight: null };
        this.loadStats(this.activeSpaceId());
        this.loadCurrentTab(this.activeSpaceId());
      },
      error: (err) => {
        this.creatingEdge.set(false);
        this.createEdgeError.set(err.error?.error ?? 'Failed to create edge');
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
      error: () => alert('Failed to delete entity.'),
    });
  }

  deleteEdge(id: string): void {
    if (!confirm('Delete this edge?')) return;
    this.api.deleteEdge(this.activeSpaceId(), id).subscribe({
      next: () => this.edges.update(list => list.filter(e => e._id !== id)),
      error: () => alert('Failed to delete edge.'),
    });
  }

  createChrono(): void {
    if (!this.chronoForm.title.trim() || !this.chronoForm.startsAt) return;
    const resolvedKind = this.chronoForm.kind === '__custom__'
      // Custom kind: the server accepts free-text values beyond the predefined enum,
      // which is the intentional behaviour requested in the feature spec.
      ? (this.chronoForm.customKind.trim() as ChronoKind)
      : this.chronoForm.kind as ChronoKind;
    if (!resolvedKind) return;
    this.creatingChrono.set(true);
    this.createChronoError.set('');
    const tags = this.chronoForm.tags.split(',').map(s => s.trim()).filter(Boolean);
    const entityIds = this.chronoForm.entityIds.split(',').map(s => s.trim()).filter(Boolean);
    const body: { title: string; kind: ChronoKind; startsAt: string; endsAt?: string; description?: string; tags?: string[]; entityIds?: string[] } = {
      title: this.chronoForm.title.trim(),
      kind: resolvedKind,
      startsAt: new Date(this.chronoForm.startsAt).toISOString(),
    };
    if (this.chronoForm.endsAt) body.endsAt = new Date(this.chronoForm.endsAt).toISOString();
    if (this.chronoForm.description.trim()) body.description = this.chronoForm.description.trim();
    if (tags.length) body.tags = tags;
    if (entityIds.length) body.entityIds = entityIds;
    this.api.createChrono(this.activeSpaceId(), body).subscribe({
      next: () => {
        this.creatingChrono.set(false);
        this.showChronoForm.set(false);
        this.chronoForm = { title: '', kind: 'event', customKind: '', startsAt: '', endsAt: '', description: '', tags: '', entityIds: '' };
        this.loadCurrentTab(this.activeSpaceId());
      },
      error: (err) => {
        this.creatingChrono.set(false);
        this.createChronoError.set(err.error?.error ?? 'Failed to create chrono entry');
      },
    });
  }

  deleteChrono(id: string): void {
    if (!confirm('Delete this chrono entry?')) return;
    this.api.deleteChrono(this.activeSpaceId(), id).subscribe({
      next: () => this.chrono.update(list => list.filter(c => c._id !== id)),
      error: () => alert('Failed to delete chrono entry.'),
    });
  }

  formatProps(props?: Record<string, string | number | boolean>): string {
    if (!props || Object.keys(props).length === 0) return '—';
    return Object.entries(props).map(([k, v]) => `${k}: ${v}`).join(', ');
  }
}
